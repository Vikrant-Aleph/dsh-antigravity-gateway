/**
 * Tool-schema sanitization: the endpoint's Schema proto rejects unknown
 * JSON Schema keywords with HTTP 400 INVALID_ARGUMENT ("Unknown name …").
 * These tests reproduce the observed failure shape (oneOf branches with
 * `const`, as in image-reference tool parameters) and the whitelist rules.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeToolSchema, buildEnvelope } from '../lib/protocol/payload.js'
import { resolveRoute } from '../lib/protocol/models.js'

test('const becomes a single-value enum at any depth', () => {
  const schema = {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      referenceImages: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'object', properties: { kind: { const: 'session' }, handle: { type: 'string' } }, required: ['kind', 'handle'] },
            { type: 'object', properties: { kind: { const: 'workspace' }, path: { type: 'string' } }, required: ['kind', 'path'] },
          ],
        },
      },
    },
  }
  const cleaned = sanitizeToolSchema(schema)
  const branches = cleaned.properties.referenceImages.items.oneOf
  assert.deepEqual(branches[0].properties.kind, { enum: ['session'] })
  assert.deepEqual(branches[1].properties.kind, { enum: ['workspace'] })
  assert.ok(!JSON.stringify(cleaned).includes('"const"'))
  assert.deepEqual(branches[0].required, ['kind', 'handle'])
})

test('metadata and unsupported structural keywords are dropped', () => {
  const cleaned = sanitizeToolSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'x',
    $comment: 'x',
    title: 'X',
    default: 1,
    examples: [1],
    example: 1,
    deprecated: true,
    readOnly: true,
    writeOnly: true,
    definitions: { a: { type: 'string' } },
    $defs: { a: { type: 'string' } },
    $ref: '#/$defs/a',
    allOf: [{ type: 'object' }],
    not: { type: 'string' },
    if: { type: 'object' }, then: { type: 'object' }, else: { type: 'string' },
    dependentSchemas: {},
    patternProperties: { '^x': { type: 'string' } },
    unevaluatedProperties: false,
    uniqueItems: true,
    multipleOf: 2,
    exclusiveMinimum: 0,
    type: 'object',
    properties: { a: { type: 'string', minLength: 1 } },
    required: ['a'],
    additionalProperties: false,
  })
  assert.deepEqual(Object.keys(cleaned).sort(), ['additionalProperties', 'properties', 'required', 'type'])
  assert.deepEqual(cleaned.properties.a, { type: 'string', minLength: 1 })
  assert.equal(cleaned.additionalProperties, false)
})

test('supported subset survives recursion', () => {
  const cleaned = sanitizeToolSchema({
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 10, description: 'count' },
      s: { type: 'string', enum: ['a', 'b'], nullable: true, pattern: '^[ab]$' },
      list: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      map: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['n'],
    propertyOrdering: ['n', 's'],
  })
  assert.deepEqual(cleaned.properties.n, { type: 'integer', minimum: 1, maximum: 10, description: 'count' })
  assert.deepEqual(cleaned.properties.s, { type: 'string', enum: ['a', 'b'], nullable: true, pattern: '^[ab]$' })
  assert.deepEqual(cleaned.properties.list, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 })
  assert.deepEqual(cleaned.properties.either.anyOf, [{ type: 'string' }, { type: 'number' }])
  assert.deepEqual(cleaned.properties.map.additionalProperties, { type: 'string' })
  assert.deepEqual(cleaned.required, ['n'])
  assert.deepEqual(cleaned.propertyOrdering, ['n', 's'])
})

test('tuple items keep the first element schema', () => {
  const cleaned = sanitizeToolSchema({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] })
  assert.deepEqual(cleaned.items, { type: 'string' })
})

test('non-object schemas sanitize to undefined', () => {
  assert.equal(sanitizeToolSchema(null), undefined)
  assert.equal(sanitizeToolSchema('x'), undefined)
  assert.equal(sanitizeToolSchema(true), undefined)
})

test('end-to-end envelope carries no const for a Claude route with oneOf tools', async () => {
  const resolved = resolveRoute('claude-opus-4-6-thinking')
  const envelope = await buildEnvelope({
    request: {
      provider: 'antigravity-gateway',
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], id: 'u1', source: { kind: 'user' } }],
      tools: [{
        name: 'image_tool',
        description: 'refs',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            refs: {
              type: 'array',
              items: {
                oneOf: [
                  { type: 'object', properties: { kind: { const: 'session' } } },
                  { type: 'object', properties: { kind: { const: 'workspace' } } },
                ],
              },
            },
          },
          additionalProperties: false,
        },
      }],
    },
    resolved,
    session: { conversationId: 'c', trajectoryId: 't', numericSessionId: '0' },
  })
  const wire = JSON.stringify(envelope.request.tools)
  assert.ok(!wire.includes('"const"'))
  assert.ok(wire.includes('"enum":["session"]'))
  assert.ok(wire.includes('"enum":["workspace"]'))
})
