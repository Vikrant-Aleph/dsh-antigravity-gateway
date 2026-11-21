import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_DEFINITIONS,
  resolveRoute,
  canonicalModelId,
  normalizeModelId,
  claudeMaxOutputForBudget,
  CLAUDE_TIER_BUDGETS,
} from '../lib/models.js'

test('opus 4.6 resolves to the M26 wire enum without a retirement gate', () => {
  const resolved = resolveRoute('claude-opus-4-6-thinking')
  assert.equal(resolved.route.wire, 'claude-opus-4-6-thinking')
  assert.equal(resolved.route.modelEnum, 'MODEL_PLACEHOLDER_M26')
  assert.equal(resolved.definition.contextWindow, 200_000)
  assert.equal(resolved.route.thinking.kind, 'claude-budget')
})

test('opus 4.6 tier efforts map to Claude thinking budgets', () => {
  for (const [effort, budget] of Object.entries(CLAUDE_TIER_BUDGETS)) {
    const resolved = resolveRoute('claude-opus-4-6-thinking', effort)
    assert.equal(resolved.route.modelEnum, 'MODEL_PLACEHOLDER_M26')
    assert.equal(resolved.route.thinking.kind, 'claude-budget')
    assert.equal(resolved.route.thinking.budget, budget)
    assert.ok(resolved.route.maxOutputTokens > budget)
  }
})

test('opus 4.6 tier-suffixed ids select the effort', () => {
  const resolved = resolveRoute('claude-opus-4-6-thinking-high')
  assert.equal(resolved.modelId, 'claude-opus-4-6-thinking')
  assert.equal(resolved.effort, 'high')
  assert.equal(resolved.route.thinking.budget, 32_768)
})

test('sonnet 4.6 resolves to M35 and accepts historical aliases', () => {
  for (const alias of ['claude-sonnet-4-6', 'claude-sonnet-4-6-thinking', 'gemini-claude-sonnet-4-6', 'antigravity-claude-sonnet-4-6']) {
    const resolved = resolveRoute(alias)
    assert.equal(resolved.modelId, 'claude-sonnet-4-6')
    assert.equal(resolved.route.modelEnum, 'MODEL_PLACEHOLDER_M35')
  }
})

test('opus 4.6 aliases normalize', () => {
  for (const alias of ['claude-opus-4-6', 'gemini-claude-opus-4-6-thinking', 'antigravity-claude-opus-4-6-thinking', 'publishers/anthropic/models/claude-opus-4-6-thinking']) {
    assert.equal(resolveRoute(alias).modelId, 'claude-opus-4-6-thinking')
  }
})

test('claude 5.5 uses adaptive thinking levels and per-tier enums', () => {
  const low = resolveRoute('claude-opus-5-5', 'low')
  assert.equal(low.route.wire, 'claude-opus-5-5-low')
  assert.equal(low.route.modelEnum, 'MODEL_PLACEHOLDER_M400')
  assert.deepEqual(low.route.thinking, { kind: 'claude-adaptive', level: 'LOW' })
  const high = resolveRoute('claude-sonnet-5-5', 'high')
  assert.equal(high.route.modelEnum, 'MODEL_PLACEHOLDER_M405')
  const bare = resolveRoute('claude-opus-5-5')
  assert.equal(bare.effort, 'medium')
})

test('gemini 4 neon xhigh sends numeric level 100', () => {
  const resolved = resolveRoute('gemini-4-neon', 'xhigh')
  assert.equal(resolved.route.wire, 'gemini-4-neon-xhigh')
  assert.equal(resolved.route.modelEnum, 'MODEL_PLACEHOLDER_M535')
  assert.deepEqual(resolved.route.thinking, { kind: 'gemini-level', level: 100 })
})

test('gemini 3.8 flash tiers use captured budgets', () => {
  assert.equal(resolveRoute('gemini-3.8-flash', 'low').route.thinking.budget, 1000)
  assert.equal(resolveRoute('gemini-3.8-flash', 'medium').route.thinking.budget, 4000)
  assert.equal(resolveRoute('gemini-3.8-flash', 'high').route.thinking.budget, -1)
})

test('gpt-oss keeps its -medium suffix as part of the name', () => {
  const resolved = resolveRoute('gpt-oss-120b-medium')
  assert.equal(resolved.route.modelEnum, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM')
  assert.equal(resolved.effort, undefined)
  assert.equal(resolveRoute('gpt-oss-120b').modelId, 'gpt-oss-120b-medium')
})

test('unknown models and unsupported efforts fail with stable codes', () => {
  assert.throws(() => resolveRoute('claude-opus-9-9'), (error) => error.code === 'UNKNOWN_MODEL')
  assert.throws(() => resolveRoute('claude-opus-4-6-thinking', 'xhigh'), (error) => error.code === 'UNSUPPORTED_REASONING_EFFORT')
  assert.throws(() => resolveRoute(''), (error) => error.code === 'INVALID_MODEL')
})

test('canonicalModelId maps live catalog names to pinned ids', () => {
  assert.equal(canonicalModelId('claude-opus-4-6-thinking'), 'claude-opus-4-6-thinking')
  assert.equal(canonicalModelId('claude-opus-4-6'), 'claude-opus-4-6-thinking')
  assert.equal(canonicalModelId('gemini-claude-opus-4-6-thinking-low'), 'claude-opus-4-6-thinking')
  assert.equal(canonicalModelId('claude-opus-5-5-high'), 'claude-opus-5-5')
  assert.equal(canonicalModelId('totally-unknown'), undefined)
})

test('normalizeModelId strips prefixes', () => {
  assert.equal(normalizeModelId('antigravity-claude-opus-4-6-thinking'), 'claude-opus-4-6-thinking')
  assert.equal(normalizeModelId('publishers/anthropic/models/claude-opus-4-6-thinking'), 'claude-opus-4-6-thinking')
})

test('claudeMaxOutputForBudget scales between 32K and 64K', () => {
  assert.equal(claudeMaxOutputForBudget(undefined), 64_000)
  assert.equal(claudeMaxOutputForBudget(8192), 32_000)
  assert.equal(claudeMaxOutputForBudget(16_384), 32_768)
  assert.equal(claudeMaxOutputForBudget(32_768), 64_000)
})

test('every pinned definition resolves its own id', () => {
  for (const definition of MODEL_DEFINITIONS) {
    const resolved = resolveRoute(definition.id)
    assert.equal(resolved.definition.id, definition.id)
    assert.ok(resolved.route.modelEnum.length > 0)
  }
})
