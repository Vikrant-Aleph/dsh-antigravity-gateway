import test from 'node:test'
import assert from 'node:assert/strict'
import {
  iterateSse, readBoundedText, proxyFromEnv, noProxyMatches,
  parseWindowsProxyServer, systemProxy, resetSystemProxyCache,
  AgyTransport,
} from '../lib/core/transport/index.js'
import { parseRetryAfterMs, statusToError, reportsContextOverflow, reportsModelCapacity } from '../lib/shared/errors.js'

function sseResponse(text) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

test('iterateSse yields data payloads and handles multi-line data', async () => {
  const response = sseResponse('data: {"a":1}\n\ndata: line1\ndata: line2\n\n: comment\nevent: message\ndata: {"b":2}\n\n')
  const events = []
  for await (const event of iterateSse(response, {})) events.push(event.data)
  assert.deepEqual(events, ['{"a":1}', 'line1\nline2', '{"b":2}'])
})

test('iterateSse flushes a trailing event without a final blank line', async () => {
  const response = sseResponse('data: last')
  const events = []
  for await (const event of iterateSse(response, {})) events.push(event.data)
  assert.deepEqual(events, ['last'])
})

test('iterateSse enforces the byte cap', async () => {
  const response = sseResponse(`data: ${'x'.repeat(5000)}\n\n`)
  await assert.rejects(
    (async () => {
      for await (const _ of iterateSse(response, { maxBytes: 100 })) {
        // consume
      }
    })(),
    (error) => error.code === 'INVALID_RESPONSE',
  )
})

test('iterateSse stops on abort', async () => {
  const controller = new AbortController()
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: one\n\n'))
      // never closes
    },
  })
  const response = new Response(stream)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(
    (async () => {
      for await (const _ of iterateSse(response, { signal: controller.signal, idleTimeoutMs: 5000 })) {
        // consume
      }
    })(),
    (error) => error.code === 'ABORTED',
  )
})

test('readBoundedText reads and caps bodies', async () => {
  assert.equal(await readBoundedText(sseResponse('hello'), 100), 'hello')
  await assert.rejects(readBoundedText(sseResponse('hello world'), 5), (error) => error.code === 'INVALID_RESPONSE')
})

test('proxyFromEnv follows the lookup order and rejects non-http schemes', () => {
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'http://127.0.0.1:7890')
  assert.equal(proxyFromEnv({ https_proxy: 'http://127.0.0.1:7891', ALL_PROXY: 'http://127.0.0.1:7892' }), 'http://127.0.0.1:7891')
  assert.equal(proxyFromEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' }), undefined)
  assert.equal(proxyFromEnv({}), undefined)
})

test('noProxyMatches handles exact, suffix, and wildcard entries', () => {
  const env = { NO_PROXY: 'localhost,127.0.0.1,.internal.corp' }
  assert.equal(noProxyMatches('localhost', env), true)
  assert.equal(noProxyMatches('api.internal.corp', env), true)
  assert.equal(noProxyMatches('googleapis.com', env), false)
  assert.equal(noProxyMatches('anything', { NO_PROXY: '*' }), true)
  assert.equal(noProxyMatches('anything', {}), false)
})

test('parseRetryAfterMs handles seconds and HTTP dates with bounds', () => {
  assert.equal(parseRetryAfterMs('2'), 2000)
  assert.equal(parseRetryAfterMs('0'), 0)
  const now = Date.parse('2026-11-22T00:00:00Z')
  assert.equal(parseRetryAfterMs('Sat, 22 Nov 2026 00:00:10 GMT', now), 10_000)
  assert.equal(parseRetryAfterMs('not a date'), undefined)
  assert.equal(parseRetryAfterMs(null), undefined)
  assert.equal(parseRetryAfterMs('99999999'), 3_600_000)
})

test('statusToError maps the failure taxonomy', () => {
  assert.equal(statusToError(401, 'x').code, 'AUTH')
  assert.equal(statusToError(403, 'x').code, 'AUTH')
  assert.equal(statusToError(429, 'x', 1500).code, 'RATE_LIMIT')
  assert.equal(statusToError(429, 'x', 1500).providerRetryAfterMs, 1500)
  assert.equal(statusToError(503, 'x').code, 'SERVER')
  assert.equal(statusToError(400, 'x').code, 'HTTP_400')
})

test('parseWindowsProxyServer accepts host:port, URL, and per-scheme forms', () => {
  assert.equal(parseWindowsProxyServer('127.0.0.1:10808'), 'http://127.0.0.1:10808')
  assert.equal(parseWindowsProxyServer('http://127.0.0.1:10808'), 'http://127.0.0.1:10808')
  assert.equal(parseWindowsProxyServer('https=127.0.0.1:10809;http=127.0.0.1:10808'), 'http://127.0.0.1:10809')
  assert.equal(parseWindowsProxyServer('http=127.0.0.1:10808'), 'http://127.0.0.1:10808')
  assert.equal(parseWindowsProxyServer('socks=127.0.0.1:7891'), 'http://127.0.0.1:7891')
  assert.equal(parseWindowsProxyServer(''), undefined)
  assert.equal(parseWindowsProxyServer('  '), undefined)
})

test('systemProxy caches readings and honors enabled=false', () => {
  resetSystemProxyCache()
  let reads = 0
  const reader = () => {
    reads += 1
    return { enabled: true, server: '127.0.0.1:10808' }
  }
  let tick = 1000
  const now = () => tick
  assert.equal(systemProxy(reader, now), 'http://127.0.0.1:10808')
  assert.equal(systemProxy(reader, now), 'http://127.0.0.1:10808')
  assert.equal(reads, 1)
  tick += 6 * 60_000 // past the TTL
  assert.equal(systemProxy(reader, now), 'http://127.0.0.1:10808')
  assert.equal(reads, 2)

  resetSystemProxyCache()
  const disabled = systemProxy(() => ({ enabled: false }), now)
  assert.equal(disabled, undefined)

  resetSystemProxyCache()
  const missing = systemProxy(() => ({ enabled: true }), now)
  assert.equal(missing, undefined)
})

test('transport falls back to the Windows system proxy when env and config name none', async () => {
  resetSystemProxyCache()
  const seenDispatchers = []
  const fetchImpl = async (_url, init) => {
    seenDispatchers.push(init?.dispatcher)
    return new Response('ok', { status: 200 })
  }
  const transport = new AgyTransport({
    fetchImpl,
    systemProxyReader: () => ({ enabled: true, server: '127.0.0.1:10808' }),
  })
  try {
    await transport.request({ url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', accessToken: 't', body: '{}' })
    await transport.request({ url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', accessToken: 't', body: '{}' })
    assert.equal(seenDispatchers.length, 2)
    // Same cached proxy config reuses one dispatcher instance.
    assert.equal(seenDispatchers[0], seenDispatchers[1])
    assert.ok(seenDispatchers[0]?.constructor?.name?.includes('ProxyAgent'))
  } finally {
    await transport.close()
    resetSystemProxyCache()
  }
})

test('transport.useSystemProxy=false ignores the Windows system proxy', async () => {
  resetSystemProxyCache()
  let sawProxy = false
  const fetchImpl = async (_url, init) => {
    sawProxy = String(init?.dispatcher?.constructor?.name ?? '').includes('ProxyAgent') || sawProxy
    return new Response('ok', { status: 200 })
  }
  const transport = new AgyTransport({
    fetchImpl,
    useSystemProxy: false,
    systemProxyReader: () => ({ enabled: true, server: '127.0.0.1:10808' }),
  })
  try {
    await transport.request({ url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', accessToken: 't', body: '{}' })
    assert.equal(sawProxy, false)
  } finally {
    await transport.close()
    resetSystemProxyCache()
  }
})

test('overflow and capacity wording detectors', () => {
  assert.equal(reportsContextOverflow('Request context length exceeded the limit'), true)
  assert.equal(reportsContextOverflow('the input is too large for this model'), true)
  assert.equal(reportsContextOverflow('all good'), false)
  assert.equal(reportsModelCapacity('The model is currently at capacity. Try again later.'), true)
  assert.equal(reportsModelCapacity('quota exhausted for project'), false)
})
