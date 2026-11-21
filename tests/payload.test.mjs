import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEnvelope,
  buildRequestMetadata,
  fnv1a64Signed,
  groupClaudeFunctionResponses,
  RequestSessionStore,
  requestSessionKey,
  sanitizeToolName,
} from '../lib/payload.js'
import { resolveRoute } from '../lib/models.js'
import { SKIP_THOUGHT_SIGNATURE } from '../lib/constants.js'

const session = () => ({
  conversationId: 'conv-1',
  trajectoryId: 'traj-1',
  numericSessionId: fnv1a64Signed(''),
})

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }], id: 'u1', source: { kind: 'user' } })

test('fnv1a64Signed of empty string is the offset basis as signed int64', () => {
  assert.equal(fnv1a64Signed(''), '-3750763034362895579')
  assert.equal(fnv1a64Signed('abc'), fnv1a64Signed('abc'))
  assert.notEqual(fnv1a64Signed('abc'), fnv1a64Signed('abd'))
})

test('envelope carries the CLI shape for opus 4.6', async () => {
  const resolved = resolveRoute('claude-opus-4-6-thinking', 'medium')
  const envelope = await buildEnvelope({
    request: {
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      reasoningEffort: 'medium',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system prompt' }], id: 's1', source: { kind: 'system-prompt' } },
        userMessage('hello'),
      ],
      sessionId: 'session-a',
    },
    resolved,
    projectId: 'test-project',
    session: session(),
    timestamp: 1000,
    mintId: () => 'fixed-id',
  })
  assert.equal(envelope.model, 'claude-opus-4-6-thinking')
  assert.equal(envelope.userAgent, 'antigravity')
  assert.equal(envelope.requestType, 'agent')
  assert.equal(envelope.project, 'test-project')
  assert.match(envelope.requestId, /^agent\/conv-1\/\d+\/traj-1\/1$/)
  const request = envelope.request
  assert.deepEqual(Object.keys(request), ['contents', 'systemInstruction', 'labels', 'generationConfig', 'sessionId'])
  assert.equal(request.labels.model_enum, 'MODEL_PLACEHOLDER_M26')
  assert.equal(request.labels.used_claude, 'true')
  assert.equal(request.labels.used_non_gemini_model, 'true')
  assert.equal(request.labels.cascade_id, 'conv-1')
  assert.equal(request.labels.trajectory_id, 'traj-1')
  assert.equal(request.sessionId, fnv1a64Signed(''))
  assert.deepEqual(request.systemInstruction.parts, [{ text: 'system prompt' }])
  assert.deepEqual(request.contents, [{ role: 'user', parts: [{ text: 'hello' }] }])
  assert.deepEqual(request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 16_384 })
  assert.equal(request.generationConfig.maxOutputTokens, 32_768)
})

test('placeholder project ids are omitted', async () => {
  const resolved = resolveRoute('gemini-3.8-flash')
  const envelope = await buildEnvelope({
    request: { provider: 'antigravity-gateway', model: 'gemini-3.8-flash', messages: [userMessage('hi')] },
    resolved,
    projectId: 'inductive-dreamer-qrkws',
    session: session(),
  })
  assert.equal('project' in envelope, false)
})

test('claude tools use VALIDATED mode, per-tool entries, and placeholders', async () => {
  const resolved = resolveRoute('claude-opus-4-6-thinking')
  const envelope = await buildEnvelope({
    request: {
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      messages: [userMessage('use the tool')],
      tools: [
        { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'no.args tool', description: 'Empty schema', parameters: { type: 'object', properties: {} } },
      ],
    },
    resolved,
    session: session(),
  })
  const request = envelope.request
  assert.equal(request.toolConfig.functionCallingConfig.mode, 'VALIDATED')
  assert.equal(request.tools.length, 2)
  assert.equal(request.tools[0].functionDeclarations.length, 1)
  assert.equal(request.tools[0].functionDeclarations[0].name, 'read_file')
  assert.match(request.tools[0].functionDeclarations[0].description, /STRICT PARAMETERS: path: string/)
  assert.equal(request.tools[1].functionDeclarations[0].name, 'no_args_tool')
  assert.ok(request.tools[1].functionDeclarations[0].parameters.properties._placeholder)
  const systemTexts = request.systemInstruction.parts.map((part) => part.text)
  assert.ok(systemTexts.some((text) => text.includes('CRITICAL TOOL USAGE INSTRUCTIONS')))
  assert.ok(systemTexts.some((text) => text.includes('Interleaved thinking is enabled')))
})

test('gemini tools use one shared functionDeclarations entry', async () => {
  const resolved = resolveRoute('gemini-3.8-flash')
  const envelope = await buildEnvelope({
    request: {
      provider: 'antigravity-gateway',
      model: 'gemini-3.8-flash',
      messages: [userMessage('hi')],
      tools: [{ name: 'tool_a', description: 'a', parameters: { type: 'object', properties: { x: { type: 'number' } } } }],
    },
    resolved,
    session: session(),
  })
  assert.equal(envelope.request.tools.length, 1)
  assert.equal(envelope.request.tools[0].functionDeclarations.length, 1)
  assert.equal(envelope.request.toolConfig, undefined)
})

test('tool results map to functionResponse and group for Claude', async () => {
  const resolved = resolveRoute('claude-opus-4-6-thinking')
  const envelope = await buildEnvelope({
    request: {
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      messages: [
        userMessage('go'),
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
            { type: 'tool-call', id: 'call_2', name: 'read_file', arguments: '{"path":"b"}' },
          ],
          id: 'a1',
          source: { kind: 'model', provider: 'antigravity-gateway', model: 'claude-opus-4-6-thinking' },
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'content a' }], id: 't1', source: { kind: 'tool', callId: 'call_1' } },
        { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'content b' }], id: 't2', source: { kind: 'tool', callId: 'call_2' } },
      ],
    },
    resolved,
    session: session(),
  })
  const contents = envelope.request.contents
  assert.equal(contents.length, 3)
  assert.equal(contents[1].role, 'model')
  assert.equal(contents[1].parts[0].functionCall.name, 'read_file')
  assert.deepEqual(contents[1].parts[0].functionCall.args, { path: 'a' })
  assert.equal(contents[2].role, 'user')
  assert.equal(contents[2].parts.length, 2)
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'read_file', response: { result: 'content a' } })
})

test('assistant reasoning replays signatures from replayState with sentinel fallback', async () => {
  const resolved = resolveRoute('claude-opus-4-6-thinking')
  const envelope = await buildEnvelope({
    request: {
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      messages: [
        userMessage('go'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking hard' },
            { type: 'text', text: 'answer' },
          ],
          id: 'a1',
          source: {
            kind: 'model',
            provider: 'antigravity-gateway',
            model: 'claude-opus-4-6-thinking',
            replayState: { response: {}, blocks: [{ kind: 'reasoning', signature: 'sig-123' }, { kind: 'text' }] },
          },
        },
        userMessage('next'),
      ],
    },
    resolved,
    session: session(),
  })
  const modelParts = envelope.request.contents[1].parts
  assert.equal(modelParts[0].thought, true)
  assert.equal(modelParts[0].thoughtSignature, 'sig-123')
  assert.equal(modelParts[1].text, 'answer')

  const withoutReplay = await buildEnvelope({
    request: {
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      messages: [
        userMessage('go'),
        { role: 'assistant', content: [{ type: 'reasoning', text: 'old thinking' }], id: 'a2', source: { kind: 'model', provider: 'other-provider', model: 'x' } },
      ],
    },
    resolved,
    session: session(),
  })
  assert.equal(withoutReplay.request.contents[1].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE)
})

test('metadata advances request counters and rotates execution ids across turns', () => {
  const store = new RequestSessionStore()
  const key = requestSessionKey('session-x')
  const first = store.beginRequest(key, () => 'id-1')
  const contents1 = [{ role: 'user', parts: [{ text: 'one' }] }]
  const meta1 = buildRequestMetadata(first.session, contents1, 'claude-opus-4-6-thinking', first.timestamp, () => 'exec-1')
  assert.equal(meta1.labels.request_id, 'traj-1-0'.replace('traj-1', first.session.trajectoryId))
  assert.equal(first.session.requestCount, 1)
  assert.equal(meta1.labels.last_execution_id, undefined)

  const second = store.beginRequest(key, () => 'id-2')
  const contents2 = [...contents1, { role: 'model', parts: [{ text: 'reply' }] }, { role: 'user', parts: [{ text: 'two' }] }]
  const meta2 = buildRequestMetadata(second.session, contents2, 'claude-opus-4-6-thinking', second.timestamp, () => 'exec-2')
  assert.equal(second.session.requestCount, 2)
  assert.equal(meta2.labels.last_execution_id, 'exec-2')
  assert.equal(meta2.labels.last_step_index, '2')
})

test('groupClaudeFunctionResponses merges only consecutive response-only user contents', () => {
  const merged = groupClaudeFunctionResponses([
    { role: 'user', parts: [{ functionResponse: { name: 'a', response: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'b', response: {} } }] },
    { role: 'user', parts: [{ text: 'real prompt' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'c', response: {} } }] },
  ])
  assert.equal(merged.length, 3)
  assert.equal(merged[0].parts.length, 2)
})

test('sanitizeToolName keeps the wire name shape', () => {
  assert.equal(sanitizeToolName('read.file'), 'read_file')
  assert.equal(sanitizeToolName(''), 'tool')
  assert.equal(sanitizeToolName('a'.repeat(100)).length, 64)
})
