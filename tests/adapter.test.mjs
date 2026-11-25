/**
 * End-to-end offline adapter tests against a local HTTP server that mimics
 * the Antigravity private endpoints. Proves the Opus 4.6 wire shape, chunk
 * protocol, credential refresh replay, and failure classification without
 * touching Google.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AntigravityGatewayAdapter } from '../lib/dsh/adapter.js'
import { AuthManager } from '../lib/core/auth.js'
import { accountCacheKey, ModelCatalog } from '../lib/core/catalog.js'
import { CredentialStore } from '../lib/core/credentials.js'
import { AgyTransport } from '../lib/core/transport/index.js'
import { noopLogger } from '../lib/core/logger.js'

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

function sseBody(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const TEXT_EVENTS = [
  { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] } },
  { response: { candidates: [{ content: { role: 'model', parts: [{ text: ' from Opus 4.6' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 } } },
]

const TOOL_EVENTS = [
  { response: { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'thinking', thoughtSignature: 'sig-r' }] } }] } },
  { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 9 } } },
]

/** Spin up a fake endpoint; returns { url, requests, close, setState }. */
async function startServer(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const record = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined }
      requests.push(record)
      handler(record, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections?.()
      }),
  }
}

function defaultHandler(record, res) {
  if (record.url.startsWith('/v1internal:fetchAvailableModels')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: { 'claude-opus-4-6-thinking': {}, 'claude-sonnet-4-6': {}, 'gemini-3.8-flash-medium': {} } }))
    return
  }
  if (record.url.startsWith('/v1internal:loadCodeAssist')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ cloudaicompanionProject: 'test-project' }))
    return
  }
  if (record.url.startsWith('/v1internal:streamGenerateContent')) {
    res.writeHead(200, SSE_HEADERS)
    res.end(sseBody(TEXT_EVENTS))
    return
  }
  res.writeHead(404)
  res.end()
}

async function setup(handler = defaultHandler, { credential } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-adapter-'))
  const file = path.join(dir, 'credential.json')
  const initial = credential ?? {
    refreshToken: '1//test-refresh',
    accessToken: 'ya29.initial',
    expiresAt: Date.now() + 3_600_000,
    projectId: 'test-project',
    email: 'user@example.com',
  }
  fs.writeFileSync(file, JSON.stringify(initial))
  const store = new CredentialStore({ file })
  const transport = new AgyTransport({ requestTimeoutMs: 15_000, responseHeaderTimeoutMs: 5000, idleTimeoutMs: 5000 })
  const server = await startServer(handler)
  const plainFetch = async (url, init) => {
    // Google token endpoint stub: never hit the network.
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.refreshed', expires_in: 3600 }), { status: 200 })
    }
    if (String(url).startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
    }
    throw new Error(`unexpected plain fetch: ${url}`)
  }
  const auth = new AuthManager({ store, transport, plainFetch, logger: noopLogger, endpoints: [server.url] })
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 0, endpoints: [server.url], logger: noopLogger })
  const adapter = new AntigravityGatewayAdapter({
    providers: ['antigravity-gateway'],
    auth,
    catalog,
    transport,
    endpoints: [server.url],
    logger: noopLogger,
  })
  const cleanup = async () => {
    await server.close()
    await transport.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { adapter, auth, catalog, server, store, cleanup }
}

const userRequest = (model, extra = {}) => ({
  provider: 'antigravity-gateway',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], id: 'u1', source: { kind: 'user' } }],
  sessionId: 'session-test',
  ...extra,
})

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('opus 4.6 streams text with the exact CLI envelope', async () => {
  const { adapter, server, cleanup } = await setup()
  try {
    const chunks = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    const streamRequests = server.requests.filter((r) => r.url.startsWith('/v1internal:streamGenerateContent'))
    assert.equal(streamRequests.length, 1)
    const envelope = streamRequests[0].body
    assert.equal(envelope.model, 'claude-opus-4-6-thinking')
    assert.equal(envelope.requestType, 'agent')
    assert.equal(envelope.userAgent, 'antigravity')
    assert.equal(envelope.project, 'test-project')
    assert.equal(envelope.request.labels.model_enum, 'MODEL_PLACEHOLDER_M26')
    assert.equal(envelope.request.labels.used_claude, 'true')
    assert.match(envelope.requestId, /^agent\//)
    assert.equal(streamRequests[0].headers.authorization, 'Bearer ya29.initial')
    assert.match(streamRequests[0].headers['user-agent'], /^antigravity\/cli\//)

    assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
    assert.equal(chunks[1].text, 'Hello')
    assert.equal(chunks[2].text, ' from Opus 4.6')
    assert.equal(chunks[3].block.text, 'Hello from Opus 4.6')
    assert.equal(chunks[4].usage.inputTokens, 12)
    assert.equal(chunks[4].usage.outputTokens, 6)
    assert.equal(chunks[5].reason.kind, 'stop')
    assert.ok(chunks[5].replayState)
  } finally {
    await cleanup()
  }
})

test('opus 4.6 effort selection changes the thinking budget on the wire', async () => {
  const { adapter, server, cleanup } = await setup()
  try {
    await collect(adapter.stream(userRequest('claude-opus-4-6-thinking', { reasoningEffort: 'high' })))
    const envelope = server.requests.find((r) => r.url.startsWith('/v1internal:streamGenerateContent')).body
    assert.deepEqual(envelope.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 32_768 })
    assert.equal(envelope.request.generationConfig.maxOutputTokens, 64_000)
    assert.equal(envelope.request.labels.model_enum, 'MODEL_PLACEHOLDER_M26')
  } finally {
    await cleanup()
  }
})

test('reasoning and tool calls stream with signatures and replay state', async () => {
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(200, SSE_HEADERS)
      res.end(sseBody(TOOL_EVENTS))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, cleanup } = await setup(handler)
  try {
    const chunks = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    const types = chunks.map((c) => c.type)
    assert.ok(types.includes('reasoning-delta'))
    assert.ok(types.includes('tool-call-delta'))
    const toolDelta = chunks.find((c) => c.type === 'tool-call-delta')
    assert.equal(toolDelta.name, 'read_file')
    assert.equal(toolDelta.argumentsDelta, '{"path":"a.txt"}')
    const toolEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.equal(toolEnd.block.name, 'read_file')
    assert.equal(toolEnd.block.arguments, '{"path":"a.txt"}')
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'tool-calls')
    assert.deepEqual(finish.replayState.blocks, [
      { kind: 'reasoning', signature: 'sig-r' },
      { kind: 'tool-call', signature: 'sig-r' },
    ])
  } finally {
    await cleanup()
  }
})

test('401 triggers one credential refresh and replay', async () => {
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      if (record.headers.authorization === 'Bearer ya29.initial') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'expired', status: 401 } }))
        return
      }
      res.writeHead(200, SSE_HEADERS)
      res.end(sseBody(TEXT_EVENTS))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, server, store, cleanup } = await setup(handler)
  try {
    const chunks = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const streamRequests = server.requests.filter((r) => r.url.startsWith('/v1internal:streamGenerateContent'))
    assert.equal(streamRequests.length, 2)
    assert.equal(streamRequests[1].headers.authorization, 'Bearer ya29.refreshed')
    const stored = await store.read()
    assert.equal(stored.accessToken, 'ya29.refreshed')
  } finally {
    await cleanup()
  }
})

test('429 becomes RATE_LIMIT with provider retry-after', async () => {
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
      res.end(JSON.stringify({ error: { message: 'Resource exhausted', status: 429 } }))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, cleanup } = await setup(handler)
  try {
    await assert.rejects(collect(adapter.stream(userRequest('claude-opus-4-6-thinking'))), (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.failure.providerRetryAfterMs, 3000)
      return true
    })
  } finally {
    await cleanup()
  }
})

test('400 context overflow becomes CONTEXT_WINDOW_EXCEEDED', async () => {
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Request context length exceeded the limit' } }))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, cleanup } = await setup(handler)
  try {
    await assert.rejects(collect(adapter.stream(userRequest('claude-opus-4-6-thinking'))), (error) => error.code === 'CONTEXT_WINDOW_EXCEEDED')
  } finally {
    await cleanup()
  }
})

test('unknown model fails before any network call', async () => {
  const { adapter, server, cleanup } = await setup()
  try {
    await assert.rejects(collect(adapter.stream(userRequest('claude-opus-9-9'))), (error) => error.code === 'UNKNOWN_MODEL')
    assert.equal(server.requests.length, 0)
  } finally {
    await cleanup()
  }
})

test('missing credential fails with AUTH and a login hint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-nocred-'))
  const store = new CredentialStore({ file: path.join(dir, 'absent.json') })
  const transport = new AgyTransport({})
  const auth = new AuthManager({ store, transport, logger: noopLogger })
  const catalog = new ModelCatalog(auth, transport, { logger: noopLogger })
  const adapter = new AntigravityGatewayAdapter({ providers: ['antigravity-gateway'], auth, catalog, transport, endpoints: ['http://127.0.0.1:1'], logger: noopLogger })
  try {
    await assert.rejects(collect(adapter.stream(userRequest('claude-opus-4-6-thinking'))), (error) => {
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, /\/agw login/)
      return true
    })
  } finally {
    await transport.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('listModels advertises the live catalog', async () => {
  const { adapter, cleanup } = await setup()
  try {
    const models = await adapter.listModels('antigravity-gateway')
    const opus = models.find((model) => model.id === 'claude-opus-4-6-thinking')
    assert.ok(opus)
    assert.equal(opus.name, 'Claude Opus 4.6 (Thinking)')
    assert.ok(!models.some((model) => model.id === 'claude-opus-5-5'))
  } finally {
    await cleanup()
  }
})

test('resolveModel exposes context, output cap, and efforts for opus 4.6', async () => {
  const { adapter, cleanup } = await setup()
  try {
    const info = await adapter.resolveModel('antigravity-gateway', 'claude-opus-4-6-thinking')
    assert.equal(info.context.contextWindow, 200_000)
    assert.equal(info.defaultMaxTokens, 64_000)
    assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
  } finally {
    await cleanup()
  }
})

test('abort before start yields an aborted finish', async () => {
  const { adapter, cleanup } = await setup()
  try {
    const controller = new AbortController()
    controller.abort()
    const chunks = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking', { signal: controller.signal })))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].reason.kind, 'aborted')
  } finally {
    await cleanup()
  }
})

test('history replay sends thought signatures back on the next turn', async () => {
  const { adapter, server, cleanup } = await setup()
  try {
    const first = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    const replayState = first.at(-1).replayState
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], id: 'u1', source: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Opus 4.6' }],
        id: 'a1',
        source: { kind: 'model', provider: 'antigravity-gateway', model: 'claude-opus-4-6-thinking', replayState },
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }], id: 'u2', source: { kind: 'user' } },
    ]
    await collect(adapter.stream({ provider: 'antigravity-gateway', model: 'claude-opus-4-6-thinking', messages: history, sessionId: 'session-test' }))
    const envelopes = server.requests.filter((r) => r.url.startsWith('/v1internal:streamGenerateContent')).map((r) => r.body)
    const second = envelopes.at(-1)
    assert.equal(second.request.contents.length, 3)
    assert.equal(second.request.contents[1].role, 'model')
    assert.equal(second.request.contents[1].parts[0].text, 'Hello from Opus 4.6')
    // Same session keeps the cascade identity across turns.
    assert.equal(second.request.labels.cascade_id, envelopes[0].request.labels.cascade_id)
  } finally {
    await cleanup()
  }
})

test('listModels excludes disabled models and marks quota-exhausted models', async () => {
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:fetchAvailableModels')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        models: {
          'gemini-4-hydrogen-high': { quotaInfo: { remainingFraction: 0.9 } },
          'claude-opus-4-6-thinking': { quotaInfo: { remainingFraction: 0 } },
          'gemini-4-neon-disabled': { disabled: true, tagTitle: 'Paid Pro', tagDescription: 'Not included.' },
          'gemini-4-carbon-disabled': { disabled: true, tagTitle: 'Paid Pro' },
          'gemini-4-argon-disabled': { disabled: true, tagTitle: 'Paid Pro' },
        },
      }))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, cleanup } = await setup(handler)
  try {
    const models = await adapter.listModels('antigravity-gateway')
    const ids = models.map((m) => m.id)
    assert.ok(ids.includes('gemini-4-hydrogen'))
    assert.ok(ids.includes('claude-opus-4-6-thinking'))
    assert.ok(!ids.includes('gemini-4-neon'))
    assert.ok(!ids.includes('gemini-4-carbon'))
    assert.ok(!ids.includes('gemini-4-argon'))
    const opus = models.find((m) => m.id === 'claude-opus-4-6-thinking')
    assert.equal(opus.badge?.tone, 'warning')
    assert.equal(opus.badge?.text?.en, 'Quota 0%')
  } finally {
    await cleanup()
  }
})

test('parallel same-name tool calls stay separate blocks with valid JSON arguments', async () => {
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(200, SSE_HEADERS)
      res.end(sseBody([
        { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', id: 'call_a', args: { file_path: 'a.txt' } } }] } }] } },
        { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', id: 'call_b', args: { file_path: 'b.txt' } } }] }, finishReason: 'STOP' }] } },
      ]))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, cleanup } = await setup(handler)
  try {
    const chunks = await collect(adapter.stream(userRequest('gemini-4-hydrogen')))
    const ends = chunks.filter((c) => c.type === 'block-end')
    assert.equal(ends.length, 2)
    assert.equal(ends[0].block.id, 'call_a')
    assert.equal(ends[0].block.name, 'read_file')
    assert.deepEqual(JSON.parse(ends[0].block.arguments), { file_path: 'a.txt' })
    assert.equal(ends[1].block.id, 'call_b')
    assert.equal(ends[1].block.name, 'read_file')
    assert.deepEqual(JSON.parse(ends[1].block.arguments), { file_path: 'b.txt' })
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  } finally {
    await cleanup()
  }
})

test('HTTP 404 on a plan-disabled model surfaces MODEL_UNSUPPORTED with upstream reason', async () => {
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:fetchAvailableModels')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        models: {
          'gemini-4-hydrogen-high': {},
          'gemini-4-neon-disabled': { disabled: true, tagTitle: 'Paid Pro', tagDescription: 'Not included with your current plan.' },
        },
      }))
      return
    }
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.' } }))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, cleanup } = await setup(handler)
  try {
    await assert.rejects(collect(adapter.stream(userRequest('gemini-4-neon'))), (error) => {
      assert.equal(error.code, 'MODEL_UNSUPPORTED')
      assert.match(error.message, /Paid Pro/)
      assert.match(error.message, /Not included with your current plan/)
      return true
    })
  } finally {
    await cleanup()
  }
})

test('imageInput=false excludes image modality and skips attachment reads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-noimg-'))
  const file = path.join(dir, 'credential.json')
  fs.writeFileSync(file, JSON.stringify({ refreshToken: '1//r', accessToken: 'ya29.i', expiresAt: Date.now() + 3_600_000 }))
  let readCalls = 0
  const server = await startServer(defaultHandler)
  const store = new CredentialStore({ file })
  const transport = new AgyTransport({ requestTimeoutMs: 5000 })
  const auth = new AuthManager({ store, transport, logger: noopLogger, endpoints: [server.url] })
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 0, endpoints: [server.url], logger: noopLogger })
  const adapter = new AntigravityGatewayAdapter({
    providers: ['antigravity-gateway'],
    auth,
    catalog,
    transport,
    endpoints: [server.url],
    logger: noopLogger,
    imageInput: false,
    getAttachments: () => ({
      async readImage() {
        readCalls += 1
        return { data: new Uint8Array([1, 2]), ref: { mediaType: 'image/png' } }
      },
    }),
  })
  try {
    const listed = await adapter.listModels('antigravity-gateway')
    assert.deepEqual(listed[0].inputModalities, ['text'])
    const resolved = await adapter.resolveModel('antigravity-gateway', 'claude-opus-4-6-thinking')
    assert.deepEqual(resolved.inputModalities, ['text'])
    await collect(adapter.stream({
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { id: 'img1' } }], id: 'u1', source: { kind: 'user' } }],
    }))
    assert.equal(readCalls, 0)
    const sent = server.requests.find((r) => r.url.startsWith('/v1internal:streamGenerateContent')).body
    assert.deepEqual(sent.request.contents[0].parts, [{ text: '[image unavailable to this route]' }])
  } finally {
    await server.close()
    await transport.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('503 model-at-capacity retries up to 2 times and recovers without emitting duplicates', async () => {
  let attempts = 0
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      attempts += 1
      if (attempts <= 2) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Model is currently at capacity. Try again later.' } }))
        return
      }
      res.writeHead(200, SSE_HEADERS)
      res.end(sseBody(TEXT_EVENTS))
      return
    }
    defaultHandler(record, res)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-503-'))
  const file = path.join(dir, 'credential.json')
  fs.writeFileSync(file, JSON.stringify({ refreshToken: '1//r', accessToken: 'ya29.i', expiresAt: Date.now() + 3_600_000 }))
  const store = new CredentialStore({ file })
  const transport = new AgyTransport({ requestTimeoutMs: 5000 })
  const server = await startServer(handler)
  const auth = new AuthManager({ store, transport, logger: noopLogger, endpoints: [server.url] })
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 0, endpoints: [server.url], logger: noopLogger })
  const adapter = new AntigravityGatewayAdapter({
    providers: ['antigravity-gateway'],
    auth,
    catalog,
    transport,
    endpoints: [server.url],
    logger: noopLogger,
    capacityRetryBaseDelayMs: 5,
  })
  try {
    const chunks = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    assert.equal(attempts, 3)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await server.close()
    await transport.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('in-stream error event and empty response yield terminal error finishes', async () => {
  let mode = 'stream-error'
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(200, SSE_HEADERS)
      if (mode === 'stream-error') {
        res.end(sseBody([{ error: { message: 'Request context length exceeded the limit', status: 400 } }]))
      } else {
        res.end('data: [DONE]\n\n')
      }
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, cleanup } = await setup(handler)
  try {
    const errChunks = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    assert.equal(errChunks.at(-1).type, 'finish')
    assert.equal(errChunks.at(-1).reason.kind, 'error')
    assert.equal(errChunks.at(-1).reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')

    mode = 'empty'
    const emptyChunks = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    assert.equal(emptyChunks.at(-1).type, 'finish')
    assert.equal(emptyChunks.at(-1).reason.kind, 'error')
    assert.equal(emptyChunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
  } finally {
    await cleanup()
  }
})

test('multi-turn tool call + tool result + replayState preserves signatures and groups Claude responses', async () => {
  let turn = 0
  const handler = (record, res) => {
    if (record.url.startsWith('/v1internal:streamGenerateContent')) {
      turn += 1
      res.writeHead(200, SSE_HEADERS)
      res.end(sseBody(turn === 1 ? TOOL_EVENTS : TEXT_EVENTS))
      return
    }
    defaultHandler(record, res)
  }
  const { adapter, server, cleanup } = await setup(handler)
  try {
    const first = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
    const toolEnd = first.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    const replayState = first.at(-1).replayState
    const second = await collect(adapter.stream({
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      sessionId: 'session-test',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read a.txt' }], id: 'u1', source: { kind: 'user' } },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'tool-call', id: toolEnd.block.id, name: toolEnd.block.name, arguments: toolEnd.block.arguments },
          ],
          id: 'a1',
          source: { kind: 'model', provider: 'antigravity-gateway', model: 'claude-opus-4-6-thinking', replayState },
        },
        { role: 'tool', toolCallId: toolEnd.block.id, content: [{ type: 'text', text: 'file body' }], id: 't1', source: { kind: 'tool', callId: toolEnd.block.id } },
      ],
    }))
    assert.equal(second.at(-1).reason.kind, 'stop')
    const secondEnv = server.requests.filter((r) => r.url.startsWith('/v1internal:streamGenerateContent'))[1].body
    assert.equal(secondEnv.request.contents[1].parts[0].thoughtSignature, 'sig-r')
    assert.equal(secondEnv.request.contents[1].parts[1].thoughtSignature, 'sig-r')
    assert.deepEqual(secondEnv.request.contents[2].parts[0].functionResponse, { name: 'read_file', response: { result: 'file body' } })
  } finally {
    await cleanup()
  }
})

test('mid-stream abort exits immediately, post-emit stream error does not retry, and dumpRequestsTo writes JSONL', async () => {
  // 1. Mid-stream abort exits immediately without hanging idleTimeoutMs.
  {
    const controller = new AbortController()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-midabort-'))
    const file = path.join(dir, 'credential.json')
    const dumpFile = path.join(dir, 'dump.jsonl')
    fs.writeFileSync(file, JSON.stringify({ refreshToken: '1//r', accessToken: 'ya29.i', expiresAt: Date.now() + 3_600_000 }))
    const server = await startServer((record, res) => {
      if (record.url.startsWith('/v1internal:streamGenerateContent')) {
        res.writeHead(200, SSE_HEADERS)
        res.write(`data: ${JSON.stringify(TEXT_EVENTS[0])}\n\n`)
        setTimeout(() => controller.abort(), 20)
        return
      }
      defaultHandler(record, res)
    })
    const store = new CredentialStore({ file })
    const transport = new AgyTransport({ requestTimeoutMs: 10_000, idleTimeoutMs: 5000 })
    const auth = new AuthManager({ store, transport, logger: noopLogger, endpoints: [server.url] })
    const catalog = new ModelCatalog(auth, transport, { ttlMs: 0, endpoints: [server.url], logger: noopLogger })
    const adapter = new AntigravityGatewayAdapter({
      providers: ['antigravity-gateway'],
      auth,
      catalog,
      transport,
      endpoints: [server.url],
      logger: noopLogger,
      dumpRequestsTo: dumpFile,
    })
    const started = Date.now()
    try {
      await assert.rejects(
        collect(adapter.stream(userRequest('claude-opus-4-6-thinking', { signal: controller.signal }))),
        (err) => err.code === 'ABORTED',
      )
      assert.ok(Date.now() - started < 1000, 'mid-stream abort must not wait idleTimeoutMs')
      const dumped = fs.readFileSync(dumpFile, 'utf8').trim().split('\n')
      assert.equal(dumped.length, 1)
      assert.equal(JSON.parse(dumped[0]).model, 'claude-opus-4-6-thinking')
    } finally {
      server.closeAllConnections?.()
      await server.close()
      await transport.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // 2. Error thrown AFTER partial block emission must NOT retry even on AUTH error.
  {
    let streamRequests = 0
    const handler = (record, res) => {
      if (record.url.startsWith('/v1internal:streamGenerateContent')) {
        streamRequests += 1
        res.writeHead(200, SSE_HEADERS)
        res.write(`data: ${JSON.stringify(TEXT_EVENTS[0])}\n\n`)
        res.end('data: {not-valid-json}\n\n')
        return
      }
      defaultHandler(record, res)
    }
    const { adapter, cleanup } = await setup(handler)
    try {
      await assert.rejects(collect(adapter.stream(userRequest('claude-opus-4-6-thinking'))), (err) => err.code === 'MALFORMED_RESPONSE')
      assert.equal(streamRequests, 1)
    } finally {
      await cleanup()
    }
  }
})

test('auto-failover switches account on 429 / pre-flight exhaustion / in-stream quota error while keeping the selected model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-failover-'))
  const file = path.join(dir, 'credential.json')
  try {
    const store = new CredentialStore({ file })
    const accA = await store.addAccount({ refreshToken: '1//a', accessToken: 'ya29.acc-a', expiresAt: Date.now() + 3_600_000, projectId: 'proj-a', email: 'a@example.com' })
    const accB = await store.addAccount({ refreshToken: '1//b', accessToken: 'ya29.acc-b', expiresAt: Date.now() + 3_600_000, projectId: 'proj-b', email: 'b@example.com' })
    const accC = await store.addAccount({ refreshToken: '1//c', accessToken: 'ya29.acc-c', expiresAt: Date.now() + 3_600_000, projectId: 'proj-c', email: 'c@example.com' })
    await store.setActiveAccount(accA.id)

    let mode = '429-on-a'
    let updatedNotifications = 0
    const server = await startServer((record, res) => {
      const authHeader = record.headers.authorization
      if (record.url.startsWith('/v1internal:streamGenerateContent')) {
        if (mode === '429-on-a' && authHeader === 'Bearer ya29.acc-a') {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' })
          res.end(JSON.stringify({ error: { code: 429, message: 'Quota exceeded for account A' } }))
          return
        }
        if (mode === 'stream-429-on-b' && authHeader === 'Bearer ya29.acc-b') {
          res.writeHead(200, SSE_HEADERS)
          res.end(sseBody([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: '5h quota exhausted' } }]))
          return
        }
        if (mode === 'all-429') {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
          res.end(JSON.stringify({ error: { code: 429, message: 'All exhausted' } }))
          return
        }
        res.writeHead(200, SSE_HEADERS)
        res.end(sseBody(TEXT_EVENTS))
        return
      }
      defaultHandler(record, res)
    })

    const transport = new AgyTransport({ requestTimeoutMs: 5000 })
    const auth = new AuthManager({ store, transport, logger: noopLogger, endpoints: [server.url] })
    const catalog = new ModelCatalog(auth, transport, {
      ttlMs: 60_000,
      endpoints: [server.url],
      logger: noopLogger,
      onUpdated: () => { updatedNotifications += 1 },
    })
    const adapter = new AntigravityGatewayAdapter({
      providers: ['antigravity-gateway'],
      auth,
      catalog,
      transport,
      endpoints: [server.url],
      logger: noopLogger,
      autoSwitchAccount: true,
    })

    try {
      // 1. Reactive 429 on accA switches to accB keeping exact model + reasoningEffort.
      const res1 = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking', { reasoningEffort: 'high' })))
      assert.equal(res1.at(-1).reason.kind, 'stop')
      assert.equal((await auth.status()).activeAccountId, accB.id)
      const streamReqs1 = server.requests.filter((r) => r.url.startsWith('/v1internal:streamGenerateContent'))
      assert.equal(streamReqs1.length, 2)
      assert.equal(streamReqs1[0].headers.authorization, 'Bearer ya29.acc-a')
      assert.equal(streamReqs1[1].headers.authorization, 'Bearer ya29.acc-b')
      assert.equal(streamReqs1[1].body.model, 'claude-opus-4-6-thinking')
      assert.equal(streamReqs1[1].body.request.generationConfig.thinkingConfig.thinkingBudget, 32_768)
      assert.ok(updatedNotifications >= 1)

      // 2. Concurrent requests on accB hitting in-stream 429 failover with CAS to accC (never double-skipping C).
      mode = 'stream-429-on-b'
      const [c1, c2] = await Promise.all([
        collect(adapter.stream(userRequest('claude-opus-4-6-thinking'))),
        collect(adapter.stream(userRequest('claude-opus-4-6-thinking'))),
      ])
      assert.equal(c1.at(-1).reason.kind, 'stop')
      assert.equal(c2.at(-1).reason.kind, 'stop')
      assert.equal((await auth.status()).activeAccountId, accC.id)

      // 3. Proactive pre-flight failover: mark accC exhausted -> switches immediately without hitting server for accC.
      catalog.clearAccountQuotaExhausted(accountCacheKey(accB), 'claude-opus-4-6-thinking')
      catalog.markAccountQuotaExhausted(accountCacheKey(accC), 'claude-opus-4-6-thinking', Date.now() + 60_000)
      mode = 'ok'
      const beforeCount = server.requests.length
      const res3 = await collect(adapter.stream(userRequest('claude-opus-4-6-thinking')))
      assert.equal(res3.at(-1).reason.kind, 'stop')
      assert.equal((await auth.status()).activeAccountId, accB.id)
      const newStreamReqs = server.requests.slice(beforeCount).filter((r) => r.url.startsWith('/v1internal:streamGenerateContent'))
      assert.equal(newStreamReqs.length, 1)
      assert.equal(newStreamReqs[0].headers.authorization, 'Bearer ya29.acc-b')

      // 4. All accounts exhausted -> surfaces RATE_LIMIT without infinite loops.
      catalog.clearAccountQuotaExhausted(accountCacheKey(accA), 'claude-opus-4-6-thinking')
      catalog.clearAccountQuotaExhausted(accountCacheKey(accB), 'claude-opus-4-6-thinking')
      catalog.clearAccountQuotaExhausted(accountCacheKey(accC), 'claude-opus-4-6-thinking')
      mode = 'all-429'
      const beforeAll = server.requests.length
      await assert.rejects(
        collect(adapter.stream(userRequest('claude-opus-4-6-thinking'))),
        (err) => err.code === 'RATE_LIMIT' && err.failure.providerRetryAfterMs === 30_000,
      )
      const allReqs = server.requests.slice(beforeAll).filter((r) => r.url.startsWith('/v1internal:streamGenerateContent'))
      assert.equal(allReqs.length, 3)
    } finally {
      await server.close()
      await transport.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
