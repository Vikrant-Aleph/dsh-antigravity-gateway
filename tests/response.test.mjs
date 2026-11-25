import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProviderEvent, mapFinishReason, signatureOf } from '../lib/protocol/response.js'

test('parses text parts and usage from a candidates envelope', () => {
  const event = parseProviderEvent(
    JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }, { text: ' world' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120, cachedContentTokenCount: 30, thoughtsTokenCount: 5 },
      },
    }),
  )
  assert.deepEqual(event.parts, [
    { kind: 'text', text: 'Hello' },
    { kind: 'text', text: ' world' },
  ])
  assert.equal(event.finish, 'STOP')
  assert.deepEqual(event.usage, { inputTokens: 70, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, reasoningTokens: 5 })
})

test('strips the JSON guard prefix', () => {
  const event = parseProviderEvent(`)]}'\n${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })}`)
  assert.equal(event.parts[0].text, 'ok')
})

test('thought parts become reasoning with signatures', () => {
  const event = parseProviderEvent(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: 'let me think', thoughtSignature: 'sig-1' },
              { text: 'answer' },
            ],
          },
        },
      ],
    }),
  )
  assert.equal(event.parts[0].kind, 'reasoning')
  assert.equal(event.parts[0].signature, 'sig-1')
  assert.equal(event.parts[1].kind, 'text')
})

test('functionCall parts become tool-call parts with JSON arguments and optional id', () => {
  const event = parseProviderEvent(
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', id: 'call_xyz', args: { path: 'a.txt' } }, thoughtSignature: 'sig-2' }] } }],
    }),
  )
  assert.equal(event.parts[0].kind, 'tool-call')
  assert.equal(event.parts[0].id, 'call_xyz')
  assert.equal(event.parts[0].name, 'read_file')
  assert.equal(event.parts[0].arguments, '{"path":"a.txt"}')
  assert.equal(event.parts[0].signature, 'sig-2')
})

test('response-level signature attaches to signature-less tool calls', () => {
  const event = parseProviderEvent(
    JSON.stringify({
      response: { candidates: [{ content: { parts: [{ functionCall: { name: 't', args: {} } }] }, metadata: { google: { thoughtSignature: 'resp-sig' } } }] },
    }),
  )
  assert.equal(event.parts[0].signature, 'resp-sig')
})

test('error events are classified', () => {
  const event = parseProviderEvent(JSON.stringify({ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }))
  assert.equal(event.error.message, 'Resource exhausted')
  const overflow = parseProviderEvent(JSON.stringify({ error: { message: 'Request context length exceeded the limit' } }))
  assert.equal(overflow.error.contextWindowExceeded, true)
})

test('invalid JSON and non-object events fail with stable codes', () => {
  assert.throws(() => parseProviderEvent('not json'), (error) => error.code === 'MALFORMED_RESPONSE')
  assert.throws(() => parseProviderEvent('[]'), (error) => error.code === 'PROTOCOL_DRIFT')
})

test('finish reason mapping', () => {
  assert.equal(mapFinishReason('STOP', false), 'stop')
  assert.equal(mapFinishReason('STOP', true), 'tool-calls')
  assert.equal(mapFinishReason('MAX_TOKENS', false), 'max-tokens')
  assert.equal(mapFinishReason('SAFETY', false), 'error')
  assert.equal(mapFinishReason(undefined, false), 'stop')
})

test('signatureOf reads direct and google-metadata fields', () => {
  assert.equal(signatureOf({ thoughtSignature: 'a' }), 'a')
  assert.equal(signatureOf({ thought_signature: 'b' }), 'b')
  assert.equal(signatureOf({ metadata: { google: { signature: 'c' } } }), 'c')
  assert.equal(signatureOf({}), undefined)
  assert.equal(signatureOf(null), undefined)
})
