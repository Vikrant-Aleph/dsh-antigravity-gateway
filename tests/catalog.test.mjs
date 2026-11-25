import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLiveCatalog, parseLiveModelIds, parseQuotaSummary, definitionAvailable, selectQuotaForModel, ModelCatalog } from '../lib/core/catalog.js'
import { MODEL_DEFINITIONS, getDefinition } from '../lib/protocol/models.js'

test('parseLiveModelIds accepts both envelope shapes and modelName aliases', () => {
  const ids = parseLiveModelIds({
    models: {
      'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6 (Thinking)' },
      'publishers/anthropic/models/claude-sonnet-4-6': { modelName: 'claude-sonnet-4-6' },
      'gemini-3.8-flash-high': {},
    },
  })
  assert.ok(ids.has('claude-opus-4-6-thinking'))
  assert.ok(ids.has('claude-sonnet-4-6'))
  assert.ok(ids.has('gemini-3.8-flash-high'))
  const wrapped = parseLiveModelIds({ response: { models: { 'gpt-oss-120b-medium': {} } } })
  assert.ok(wrapped.has('gpt-oss-120b-medium'))
})

test('parseLiveModelIds rejects malformed catalogs with PROTOCOL_DRIFT', () => {
  assert.throws(() => parseLiveModelIds({}), (error) => error.code === 'PROTOCOL_DRIFT')
  assert.throws(() => parseLiveModelIds({ models: [] }), (error) => error.code === 'PROTOCOL_DRIFT')
  assert.throws(() => parseLiveModelIds(null), (error) => error.code === 'PROTOCOL_DRIFT')
})

test('definitionAvailable matches wire names, aliases, and tier families', () => {
  const opus46 = getDefinition('claude-opus-4-6-thinking')
  assert.equal(definitionAvailable(opus46, new Set(['claude-opus-4-6-thinking'])), true)
  assert.equal(definitionAvailable(opus46, new Set(['claude-opus-4-6'])), true)
  assert.equal(definitionAvailable(opus46, new Set(['claude-opus-5-5-low'])), false)
  const neon = getDefinition('gemini-4-neon')
  assert.equal(definitionAvailable(neon, new Set(['gemini-4-neon-low'])), true)
  const claude55 = getDefinition('claude-opus-5-5')
  assert.equal(definitionAvailable(claude55, new Set(['claude-opus-5-5-high'])), true)
})

/** Stub auth + transport exercising ModelCatalog without network. */
function stubDeps(liveResponse, { fail = false } = {}) {
  const auth = {
    async getCredential() {
      return { refreshToken: '1//x', accessToken: 'ya29.x', expiresAt: Date.now() + 3_600_000, projectId: 'proj' }
    },
  }
  const transport = {
    async request() {
      if (fail) throw Object.assign(new Error('offline'), { code: 'TRANSPORT' })
      return new Response(JSON.stringify(liveResponse), { status: 200 })
    },
  }
  return { auth, transport }
}

test('catalog advertises the live intersection — 4.6 stays when the account lists it', async () => {
  const { auth, transport } = stubDeps({
    models: {
      'claude-opus-4-6-thinking': {},
      'claude-sonnet-4-6': {},
      'gemini-3.8-flash-medium': {},
      'gpt-oss-120b-medium': {},
    },
  })
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 0 })
  const listed = await catalog.list()
  const ids = listed.map((definition) => definition.id)
  assert.ok(ids.includes('claude-opus-4-6-thinking'))
  assert.ok(ids.includes('claude-sonnet-4-6'))
  assert.ok(!ids.includes('claude-opus-5-5'))
  assert.ok(!ids.includes('gemini-4-neon'))
})

test('catalog falls back to the pinned snapshot when live discovery fails', async () => {
  const { auth, transport } = stubDeps({}, { fail: true })
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 0 })
  const listed = await catalog.list()
  assert.equal(listed.length, MODEL_DEFINITIONS.length)
})

test('extraModels are always advertised', async () => {
  const { auth, transport } = stubDeps({ models: { 'gemini-3.8-flash-medium': {} } })
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 0, extraModels: ['claude-opus-4-6-thinking'] })
  const ids = (await catalog.list()).map((definition) => definition.id)
  assert.ok(ids.includes('claude-opus-4-6-thinking'))
  assert.ok(ids.includes('gemini-3.8-flash'))
})

test('catalog caches live ids within the TTL and invalidates on demand', async () => {
  let calls = 0
  const auth = { async getCredential() { return { refreshToken: '1//x', accessToken: 'ya29.x', expiresAt: Date.now() + 3_600_000 } } }
  const transport = {
    async request() {
      calls += 1
      return new Response(JSON.stringify({ models: { 'claude-opus-4-6-thinking': {} } }), { status: 200 })
    },
  }
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 60_000 })
  await catalog.liveIds()
  await catalog.liveIds()
  assert.equal(calls, 1)
  catalog.invalidate()
  await liveIdsAfter()
  async function liveIdsAfter() {
    await catalog.liveIds()
    assert.equal(calls, 2)
  }
})

test('disabled entries (e.g. gemini-4-neon-disabled) are excluded from live ids and definitionAvailable', () => {
  const parsed = parseLiveCatalog({
    models: {
      'gemini-4-hydrogen-high': { quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-25T18:00:00Z' } },
      'gemini-4-neon-disabled': {
        disabled: true,
        tagTitle: 'Paid Pro',
        tagDescription: 'Available on paid Google AI Pro and Ultra plans. Not included with your current plan.',
      },
      'gemini-4-carbon-disabled': { disabled: true, tagTitle: 'Paid Pro' },
      'gemini-4-argon-disabled': { disabled: true, tagTitle: 'Paid Pro' },
    },
  })
  assert.ok(parsed.enabledIds.has('gemini-4-hydrogen-high'))
  assert.ok(!parsed.enabledIds.has('gemini-4-neon-disabled'))
  assert.ok(!parsed.enabledIds.has('gemini-4-carbon-disabled'))
  assert.equal(definitionAvailable(getDefinition('gemini-4-neon'), new Set(['gemini-4-neon-disabled'])), false)
  assert.equal(definitionAvailable(getDefinition('gemini-4-carbon'), new Set(['gemini-4-carbon-disabled'])), false)
  assert.equal(definitionAvailable(getDefinition('gemini-4-argon'), new Set(['gemini-4-argon-disabled'])), false)
})

test('getAvailabilityReport separates available, disabled, and not-offered models with quota and tier', async () => {
  const auth = {
    async status() { return { loggedIn: true, projectId: 'proj-free' } },
    async getCredential() { return { refreshToken: '1//x', accessToken: 'ya29.x', expiresAt: Date.now() + 3_600_000, projectId: 'proj-free' } },
    async getAccountTier() { return { current: { id: 'free-tier', name: 'Antigravity' }, paid: { id: 'g1-pro-tier', name: 'Google AI Pro' } } },
  }
  const transport = {
    async request({ url }) {
      if (String(url).includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({
          agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-4-hydrogen-high', 'claude-opus-4-6-thinking', 'gemini-4-neon-disabled'] }] }],
          models: {
            'gemini-4-hydrogen-high': { quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-25T18:00:00Z' } },
            'claude-opus-4-6-thinking': { quotaInfo: { remainingFraction: 0, resetTime: '2026-11-25T20:00:00Z' }, tagTitle: 'Notice', tagDescription: 'Limit info' },
            'gemini-4-neon-disabled': { disabled: true, tagTitle: 'Paid Pro', tagDescription: 'Not included with your current plan.' },
            'gemini-4-carbon-disabled': { disabled: true, tagTitle: 'Paid Pro', tagDescription: 'Not included with your current plan.' },
            'gemini-4-argon-disabled': { disabled: true, tagTitle: 'Paid Pro', tagDescription: 'Not included with your current plan.' },
          },
        }), { status: 200 })
      }
      if (String(url).includes('retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({
          groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', displayName: 'Five Hour', window: '5h', remainingFraction: 0.85 }] }],
        }), { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    },
  }
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 0 })
  const listed = await catalog.list()
  const listedIds = listed.map((m) => m.id)
  assert.deepEqual(listedIds, ['gemini-4-hydrogen', 'claude-opus-4-6-thinking'])

  const report = await catalog.getAvailabilityReport({ force: true })
  assert.equal(report.source, 'live')
  assert.equal(report.tier.current.id, 'free-tier')
  assert.equal(report.tier.paid.id, 'g1-pro-tier')
  assert.equal(report.quotaGroups.length, 1)
  assert.equal(report.quotaGroups[0].buckets[0].remainingFraction, 0.85)

  assert.equal(report.available.length, 2)
  assert.equal(report.available[0].id, 'gemini-4-hydrogen')
  assert.equal(report.available[0].status, 'available')
  assert.equal(report.available[0].remainingFraction, 0.85)
  assert.equal(report.available[1].id, 'claude-opus-4-6-thinking')
  assert.equal(report.available[1].status, 'quota-exhausted')

  const neon = report.unavailable.find((m) => m.id === 'gemini-4-neon')
  assert.equal(neon.status, 'disabled')
  assert.equal(neon.reasonTitle, 'Paid Pro')
  assert.equal(neon.reasonDetail, 'Not included with your current plan.')

  const opus55 = report.unavailable.find((m) => m.id === 'claude-opus-5-5')
  assert.equal(opus55.status, 'not-offered')
})

test('disk cache prevents offline fallback from exposing disabled models on restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-catcache-'))
  const cacheFile = path.join(dir, 'catalog-cache.json')
  try {
    const auth = {
      async status() { return { loggedIn: true, projectId: 'proj-cache' } },
      async getCredential() { return { refreshToken: '1//x', accessToken: 'ya29.x', expiresAt: Date.now() + 3_600_000, projectId: 'proj-cache' } },
    }
    const onlineTransport = {
      async request() {
        return new Response(JSON.stringify({
          models: {
            'gemini-4-hydrogen-high': {},
            'gemini-4-neon-disabled': { disabled: true, tagTitle: 'Paid Pro' },
          },
        }), { status: 200 })
      },
    }
    const cat1 = new ModelCatalog(auth, onlineTransport, { ttlMs: 0, cacheFile })
    assert.deepEqual((await cat1.list()).map((m) => m.id), ['gemini-4-hydrogen'])
    assert.equal(fs.existsSync(cacheFile), true)

    // Boot 2: network is offline -> must reuse cached live offering, NOT all 10 models.
    const offlineAuth = {
      async status() { return { loggedIn: true, projectId: 'proj-cache' } },
      async getCredential() { throw Object.assign(new Error('Google token endpoint unreachable'), { code: 'TRANSPORT' }) },
    }
    const cat2 = new ModelCatalog(offlineAuth, onlineTransport, { ttlMs: 0, cacheFile })
    const offlineListed = await cat2.list()
    assert.deepEqual(offlineListed.map((m) => m.id), ['gemini-4-hydrogen'])
    const report = await cat2.getAvailabilityReport()
    assert.equal(report.source, 'cached')
    assert.ok(report.error.includes('unreachable'))

    cat2.invalidate()
    assert.equal(fs.existsSync(cacheFile), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parseQuotaSummary ignores malformed shapes gracefully', () => {
  assert.deepEqual(parseQuotaSummary({}), [])
  assert.deepEqual(parseQuotaSummary(null), [])
})

test('concurrent list() shares one probe and preserves agentModelSorts order across TTL & disk fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-cat-order-'))
  const cacheFile = path.join(dir, 'catalog-cache.json')
  try {
    let probes = 0
    let updatedCount = 0
    const auth = {
      async status() { return { loggedIn: true, projectId: 'proj-order' } },
      async getCredential() { return { refreshToken: '1//x', accessToken: 'ya29.x', expiresAt: Date.now() + 3_600_000, projectId: 'proj-order' } },
    }
    const transport = {
      async request() {
        probes += 1
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify({
          agentModelSorts: [{ groups: [{ modelIds: ['gemini-4-hydrogen-high', 'claude-opus-4-6-thinking'] }] }],
          models: {
            'claude-opus-4-6-thinking': {},
            'gemini-4-hydrogen-high': {},
          },
        }), { status: 200 })
      },
    }
    const catalog = new ModelCatalog(auth, transport, {
      ttlMs: 60_000,
      cacheFile,
      onUpdated: () => { updatedCount += 1 },
    })

    // Concurrent callers share one live probe.
    const [first, second] = await Promise.all([catalog.list(), catalog.list()])
    assert.equal(probes, 1)
    assert.deepEqual(first.map((m) => m.id), ['gemini-4-hydrogen', 'claude-opus-4-6-thinking'])
    assert.deepEqual(second.map((m) => m.id), ['gemini-4-hydrogen', 'claude-opus-4-6-thinking'])

    // Subsequent TTL cache hit must preserve agentOrder and NOT fire spurious onUpdated.
    const third = await catalog.list()
    assert.equal(probes, 1)
    assert.deepEqual(third.map((m) => m.id), ['gemini-4-hydrogen', 'claude-opus-4-6-thinking'])
    assert.equal(updatedCount, 1)

    // Cold boot offline disk restore must ALSO preserve agentOrder.
    const offlineAuth = {
      async status() { return { loggedIn: true, projectId: 'proj-order' } },
      async getCredential() { throw Object.assign(new Error('offline'), { code: 'TRANSPORT' }) },
    }
    const cold = new ModelCatalog(offlineAuth, transport, { ttlMs: 60_000, cacheFile })
    const restored = await cold.list()
    assert.deepEqual(restored.map((m) => m.id), ['gemini-4-hydrogen', 'claude-opus-4-6-thinking'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('list() refresh after TTL expiry resets cachedFullReport so getAvailabilityReport refreshes quota', async () => {
  let quotaCalls = 0
  const auth = {
    async status() { return { loggedIn: true, projectId: 'proj-ttl' } },
    async getCredential() { return { refreshToken: '1//x', accessToken: 'ya29.x', expiresAt: Date.now() + 3_600_000, projectId: 'proj-ttl' } },
    async getAccountTier() { return { current: { id: 'free-tier', name: 'Antigravity' } } },
  }
  const transport = {
    async request({ url }) {
      if (String(url).includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: { 'gemini-4-hydrogen-high': {} } }), { status: 200 })
      }
      if (String(url).includes('retrieveUserQuotaSummary')) {
        quotaCalls += 1
        return new Response(JSON.stringify({
          groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'g', displayName: '5h', remainingFraction: quotaCalls === 1 ? 0.8 : 0.4 }] }],
        }), { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    },
  }
  const catalog = new ModelCatalog(auth, transport, { ttlMs: 25 })
  const r1 = await catalog.getAvailabilityReport()
  assert.equal(r1.quotaGroups[0].buckets[0].remainingFraction, 0.8)

  // Wait past the 25ms TTL, then refresh via list() (non-full).
  await new Promise((r) => setTimeout(r, 40))
  await catalog.list()

  // Calling getAvailabilityReport() within the new TTL window must fetch fresh quota instead of serving stale cachedFullReport.
  const r2 = await catalog.getAvailabilityReport()
  assert.equal(quotaCalls, 2)
  assert.equal(r2.quotaGroups[0].buckets[0].remainingFraction, 0.4)
})

test('selectQuotaForModel matches family 5h bucket and respects lower per-model fraction', () => {
  const report = {
    quotaGroups: [
      { displayName: 'Claude', buckets: [{ bucketId: 'claude-5h', displayName: 'Five Hour', window: '5h', remainingFraction: 0.87, resetTime: '2026-11-26T08:00:00Z' }] },
      { displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', displayName: 'Five Hour', window: '5h', remainingFraction: 0.42 }] },
    ],
    available: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: [], contextWindow: 1000, maxOutputTokens: 100, status: 'available', remainingFraction: 0.87 },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6', efforts: [], contextWindow: 1000, maxOutputTokens: 100, status: 'quota-exhausted', remainingFraction: 0 },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS', efforts: [], contextWindow: 1000, maxOutputTokens: 100, status: 'available', remainingFraction: 0.65, resetTime: '2026-11-26T09:00:00Z' },
    ],
  }
  const sonnetQuota = selectQuotaForModel(report, 'claude-sonnet-5-5')
  assert.equal(sonnetQuota.window, '5h')
  assert.equal(sonnetQuota.remainingFraction, 0.87)
  assert.equal(sonnetQuota.resetTime, '2026-11-26T08:00:00Z')

  const opusQuota = selectQuotaForModel(report, 'claude-opus-4-6-thinking')
  assert.equal(opusQuota.remainingFraction, 0)

  const gptQuota = selectQuotaForModel(report, 'gpt-oss-120b-medium')
  assert.equal(gptQuota.window, 'model')
  assert.equal(gptQuota.remainingFraction, 0.65)
})

test('catalog isolates multi-account disk caches and selects highest-quota eligible failover account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-cat-multi-'))
  const cacheFile = path.join(dir, 'catalog-cache.json')
  try {
    let active = { id: 'a1', email: 'a1@example.com', projectId: 'proj-1' }
    const auth = {
      async status() { return { loggedIn: true, activeAccountId: active.id, ...active } },
      async getCredential() { return { ...active, refreshToken: '1//x', accessToken: 'ya29.x', expiresAt: Date.now() + 3_600_000 } },
    }
    const transport = {
      async request() {
        const models =
          active.id === 'a1'
            ? { 'claude-sonnet-5-5-medium': { quotaInfo: { remainingFraction: 0.1 } } }
            : { 'claude-sonnet-5-5-medium': { quotaInfo: { remainingFraction: 0.9 } }, 'gemini-4-neon-high': {} }
        return new Response(JSON.stringify({ models }), { status: 200 })
      },
    }
    const catalog = new ModelCatalog(auth, transport, { ttlMs: 60_000, cacheFile })
    await catalog.getAvailabilityReport()
    active = { id: 'a2', email: 'a2@example.com', projectId: 'proj-2' }
    await catalog.getAvailabilityReport()

    // Disk file preserves both accounts independently.
    const rawDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    assert.equal(rawDisk.version, 2)
    assert.ok(rawDisk.entries['proj:proj-1'])
    assert.ok(rawDisk.entries['proj:proj-2'])

    const accounts = [
      { id: 'a1', email: 'a1@example.com', projectId: 'proj-1', active: true },
      { id: 'a2', email: 'a2@example.com', projectId: 'proj-2', active: false },
      { id: 'a3', email: 'a3@example.com', projectId: 'proj-3', active: false },
    ]
    const best = catalog.selectBestAccountForModel(accounts, 'a1', 'claude-sonnet-5-5', new Set())
    assert.equal(best.id, 'a2')

    // Mark a2 exhausted -> falls back to unprobed a3; mark a3 exhausted -> undefined.
    catalog.markAccountQuotaExhausted('proj:proj-2', 'claude-sonnet-5-5', Date.now() + 60_000)
    const fallback = catalog.selectBestAccountForModel(accounts, 'a1', 'claude-sonnet-5-5', new Set())
    assert.equal(fallback.id, 'a3')

    catalog.markAccountQuotaExhausted('proj:proj-3', 'claude-sonnet-5-5', Date.now() + 60_000)
    assert.equal(catalog.selectBestAccountForModel(accounts, 'a1', 'claude-sonnet-5-5', new Set()), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
