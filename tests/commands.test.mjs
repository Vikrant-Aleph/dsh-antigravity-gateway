import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCommands } from '../lib/commands.js'

function createCommandHarness({ accountOverrides = {}, accountMode = 'enabled' } = {}) {
  const registered = new Map()
  const disposed = []
  const ctx = {
    get(name) {
      if (name !== 'commands') return undefined
      return {
        register(def) {
          registered.set(def.name, def)
          return () => {
            disposed.push(def.name)
            registered.delete(def.name)
          }
        },
      }
    },
  }
  const account = {
    async status() {
      return {
        loggedIn: true,
        backend: 'credentials-service',
        email: 'user@example.com',
        projectId: 'proj-1',
        expiresAt: Date.UTC(2026, 10, 26, 12, 0, 0),
        loginPending: false,
        tier: { current: { id: 'free-tier', name: 'Antigravity' } },
      }
    },
    async login() {
      return { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }
    },
    cancel() {
      return { cancelled: true }
    },
    async logout() {
      return { loggedOut: true }
    },
    async import() {
      return { email: 'imported@example.com' }
    },
    async models({ force } = {}) {
      return {
        source: force ? 'live' : 'cached',
        checkedAt: '2026-11-26T00:00:00Z',
        tier: { current: { id: 'free-tier', name: 'Antigravity' } },
        quotaGroups: [
          { displayName: 'Claude', buckets: [{ bucketId: 'b1', displayName: 'Five Hour', window: '5h', remainingFraction: 0.75 }] },
        ],
        available: [
          { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'], contextWindow: 1_000_000, maxOutputTokens: 128_000, status: 'available', remainingFraction: 0.75 },
        ],
        unavailable: [
          { id: 'gemini-4-neon', name: 'Gemini 4 Neon', status: 'disabled', reasonTitle: 'Paid Pro', reasonDetail: 'Upgrade required' },
        ],
        models: [],
      }
    },
    ...accountOverrides,
  }
  const dispose = registerCommands(ctx, { account, accountMode, loginTimeoutMs: 300_000 })
  return { registered, disposed, dispose }
}

test('registerCommands registers /antigravity-gateway and /agw and disposes both', () => {
  const { registered, disposed, dispose } = createCommandHarness()
  assert.ok(registered.has('antigravity-gateway'))
  assert.ok(registered.has('agw'))
  dispose()
  assert.deepEqual(disposed.sort(), ['agw', 'antigravity-gateway'])
  assert.equal(registered.size, 0)
})

test('registerCommands is a safe no-op when commands service is absent', () => {
  const dispose = registerCommands({ get: () => undefined }, { account: {}, accountMode: 'enabled', loginTimeoutMs: 1000 })
  assert.doesNotThrow(() => dispose())
})

test('/agw commands handle status, login, cancel, logout, import, models, refresh, and unknown action', async () => {
  const { registered } = createCommandHarness()
  const handler = registered.get('agw').handler

  const statusRes = await handler({ rawInput: '' })
  assert.equal(statusRes.kind, 'success')
  assert.match(statusRes.text, /signed in/)
  assert.match(statusRes.text, /user@example\.com/)
  assert.match(statusRes.text, /free-tier/)

  const loginRes = await handler({ rawInput: 'login' })
  assert.equal(loginRes.kind, 'success')
  assert.match(loginRes.text, /https:\/\/accounts\.google\.com/)
  assert.match(loginRes.text, /300s/)

  const cancelRes = await handler({ rawInput: 'cancel' })
  assert.equal(cancelRes.kind, 'success')
  assert.match(cancelRes.text, /cancelled/i)

  const logoutRes = await handler({ rawInput: 'logout' })
  assert.equal(logoutRes.kind, 'success')
  assert.match(logoutRes.text, /Signed out/)

  const importRes = await handler({ rawInput: 'import' })
  assert.equal(importRes.kind, 'success')
  assert.match(importRes.text, /imported@example\.com/)

  const modelsRes = await handler({ rawInput: 'models' })
  assert.equal(modelsRes.kind, 'success')
  assert.match(modelsRes.text, /Catalog source: cached/)
  assert.match(modelsRes.text, /claude-sonnet-5-5/)
  assert.match(modelsRes.text, /gemini-4-neon/)

  const refreshRes = await handler({ rawInput: 'refresh' })
  assert.equal(refreshRes.kind, 'success')
  assert.match(refreshRes.text, /Catalog source: live/)

  const unknownRes = await handler({ rawInput: 'bogus' })
  assert.equal(unknownRes.kind, 'error')
  assert.match(unknownRes.text, /Usage: \/agw <action>/)
})

test('/agw commands fail closed when accountMode is blocked and surface service errors cleanly', async () => {
  const blocked = createCommandHarness({ accountMode: 'blocked' })
  const blockedRes = await blocked.registered.get('agw').handler({ rawInput: 'status' })
  assert.equal(blockedRes.kind, 'error')
  assert.match(blockedRes.text, /127\.0\.0\.1/)

  const failing = createCommandHarness({
    accountOverrides: {
      async status() {
        throw new Error('boom')
      },
    },
  })
  const errRes = await failing.registered.get('agw').handler({ rawInput: 'status' })
  assert.equal(errRes.kind, 'error')
  assert.match(errRes.text, /boom/)
})
