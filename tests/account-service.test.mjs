/**
 * Offline account-service tests: loopback policy, RPC dispatch, and the
 * full login flow against a local callback + stubbed Google endpoints.
 * No real Google calls; the browser opener is replaced with a no-op.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountService, accountModeFor, registerAccountAccess, ACCOUNT_RPC_NAMESPACE } from '../lib/dsh/account-service.js'
import { AuthManager } from '../lib/core/auth.js'
import { CredentialStore } from '../lib/core/credentials.js'
import { ModelCatalog } from '../lib/core/catalog.js'
import { noopLogger } from '../lib/core/logger.js'

test('accountModeFor: no WebServer or loopback bind enables; anything else blocks', () => {
  assert.equal(accountModeFor(undefined), 'enabled')
  assert.equal(accountModeFor({ host: '127.0.0.1' }), 'enabled')
  assert.equal(accountModeFor({ host: '0.0.0.0' }), 'blocked')
  assert.equal(accountModeFor({ host: '192.168.1.10' }), 'blocked')
  assert.equal(accountModeFor({}), 'blocked')
})

function stubAccount() {
  const calls = []
  const auth = {
    async status() { return { loggedIn: false, backend: 'file', loginPending: false } },
    async login() { return { url: 'https://accounts.google.com/test', done: Promise.resolve({}), cancel() {} } },
    cancelLogin() { calls.push('cancel'); return true },
    async logout() { calls.push('logout') },
    async importFromAntigravityAuth() { calls.push('import'); return { email: 'u@example.com' } },
  }
  const catalog = {
    invalidate() { calls.push('invalidate') },
    async list() {
      return [{ id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }]
    },
  }
  const service = new AccountService({ auth, catalog, oauthPort: 0, loginTimeoutMs: 10_000, logger: noopLogger })
  return { service, calls }
}

test('dispatch maps endpoints and invalidates the catalog on account changes', async () => {
  const { service, calls } = stubAccount()
  const status = await service.dispatch('status')
  assert.equal(status.loggedIn, false)
  const login = await service.dispatch('login')
  assert.match(login.url, /^https:\/\/accounts\.google\.com/)
  assert.deepEqual(await service.dispatch('cancel'), { cancelled: true })
  assert.deepEqual(await service.dispatch('logout'), { loggedOut: true })
  assert.deepEqual(await service.dispatch('import'), { email: 'u@example.com' })
  const { models } = await service.dispatch('models')
  assert.equal(models[0].id, 'claude-opus-4-6-thinking')
  assert.deepEqual(models[0].efforts, ['low', 'medium', 'high'])
  assert.ok(calls.includes('logout'))
  assert.ok(calls.includes('import'))
  assert.ok(calls.filter((c) => c === 'invalidate').length >= 2)
})

/** Fake connection capturing registered routes. */
function fakeContext(webServer) {
  const routes = new Map()
  const ctx = {
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(_names, callback) {
      const child = {
        get: (name) => (name === 'webServer' ? webServer : undefined),
        connection: {
          fetch: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        },
      }
      callback(child)
      return undefined
    },
  }
  return { ctx, routes }
}

async function callRoute(routes, endpoint, payload = {}) {
  const route = routes.get(`/api/${ACCOUNT_RPC_NAMESPACE}/${endpoint}`)
  assert.ok(route, `route ${endpoint} registered`)
  const response = await route.fetch(new Request('http://localhost/api', {
    method: 'POST',
    body: JSON.stringify({ rpcId: 'r1', method: `${ACCOUNT_RPC_NAMESPACE}/${endpoint}`, payload }),
  }))
  const envelope = await response.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, 'r1')
  return envelope.result
}

test('account RPC serves status/models on a loopback-bound host', async () => {
  const { service } = stubAccount()
  const { ctx, routes } = fakeContext({ host: '127.0.0.1' })
  registerAccountAccess(ctx, service, noopLogger)
  assert.equal(routes.size, 6)
  const status = await callRoute(routes, 'status')
  assert.equal(status.ok, true)
  assert.equal(status.value.loggedIn, false)
  const models = await callRoute(routes, 'models')
  assert.equal(models.value.models[0].id, 'claude-opus-4-6-thinking')
})

test('account RPC fails closed on a non-loopback host without touching the service', async () => {
  const { service, calls } = stubAccount()
  const { ctx, routes } = fakeContext({ host: '0.0.0.0' })
  registerAccountAccess(ctx, service, noopLogger)
  for (const endpoint of ['status', 'login', 'cancel', 'logout', 'import', 'models']) {
    const result = await callRoute(routes, endpoint)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'loopback-required')
  }
  assert.equal(calls.length, 0)
})

test('account RPC rejects mismatched method names', async () => {
  const { service } = stubAccount()
  const { ctx, routes } = fakeContext(undefined)
  registerAccountAccess(ctx, service, noopLogger)
  const route = routes.get(`/api/${ACCOUNT_RPC_NAMESPACE}/status`)
  const response = await route.fetch(new Request('http://localhost/api', {
    method: 'POST',
    body: JSON.stringify({ rpcId: 'r2', method: 'wrong/method', payload: {} }),
  }))
  const envelope = await response.json()
  assert.equal(envelope.result.ok, false)
  assert.equal(envelope.result.error.code, 'bad-request')
})

test('full login flow: callback → exchange → project → email → stored credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-login-'))
  try {
    const store = new CredentialStore({ file: path.join(dir, 'credential.json') })
    const transport = {
      async request({ url }) {
        if (String(url).includes('loadCodeAssist')) {
          return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-123' }), { status: 200 })
        }
        throw new Error(`unexpected transport call: ${url}`)
      },
      idleTimeoutMs: 5000,
      async close() {},
    }
    const plainFetch = async (url) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'ya29.test', refresh_token: '1//test', expires_in: 3600 }), { status: 200 })
      }
      if (String(url).startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
      }
      throw new Error(`unexpected plain fetch: ${url}`)
    }
    const opened = []
    const auth = new AuthManager({
      store, transport, plainFetch, logger: noopLogger,
      endpoints: ['http://127.0.0.1:1'],
      openUrl: (url) => { opened.push(url); return true },
    })
    const handle = await auth.login({ port: 0, timeoutMs: 15_000 })
    assert.equal(opened.length, 1)
    assert.equal(opened[0], handle.url)

    const pending = await auth.status()
    assert.equal(pending.loginPending, true)
    assert.equal(pending.loginUrl, handle.url)

    // Simulate the browser redirect with the state from the authorization URL.
    const state = new URL(handle.url).searchParams.get('state')
    const port = new URL(handle.url).searchParams.get('redirect_uri').match(/:(\d+)\//)[1]
    const callback = await fetch(`http://127.0.0.1:${port}/oauth-callback?code=auth-code&state=${state}`)
    assert.equal(callback.status, 200)

    const result = await handle.done
    assert.equal(result.email, 'user@example.com')
    assert.equal(result.projectId, 'proj-123')

    const after = await auth.status()
    assert.equal(after.loggedIn, true)
    assert.equal(after.loginPending, false)
    assert.equal(after.email, 'user@example.com')
    const stored = await store.read()
    assert.equal(stored.refreshToken, '1//test')
    assert.equal(stored.projectId, 'proj-123')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('login cancel clears pending state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-cancel-'))
  try {
    const store = new CredentialStore({ file: path.join(dir, 'credential.json') })
    const transport = { async request() { throw new Error('offline') }, idleTimeoutMs: 5000, async close() {} }
    const auth = new AuthManager({ store, transport, logger: noopLogger, openUrl: () => true })
    await auth.login({ port: 0, timeoutMs: 15_000 })
    assert.equal((await auth.status()).loginPending, true)
    assert.equal(auth.cancelLogin(), true)
    const after = await auth.status()
    assert.equal(after.loginPending, false)
    assert.equal(after.loginUrl, undefined)
    assert.equal(auth.cancelLogin(), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('account RPC models forwards force:true to getAvailabilityReport', async () => {
  const seen = []
  const auth = { async status() { return { loggedIn: true, backend: 'file', loginPending: false } } }
  const catalog = {
    invalidate() {},
    async getAvailabilityReport(opts) {
      seen.push(opts)
      return {
        source: 'live',
        checkedAt: '2026-11-25T00:00:00Z',
        tier: { current: { id: 'free-tier', name: 'Antigravity' } },
        quotaGroups: [],
        available: [{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'high'], contextWindow: 1_048_576, maxOutputTokens: 262_144, status: 'available' }],
        unavailable: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', status: 'disabled', reasonTitle: 'Paid Pro', reasonDetail: 'Not included.' }],
      }
    },
  }
  const service = new AccountService({ auth, catalog, oauthPort: 0, loginTimeoutMs: 10_000, logger: noopLogger })
  const { ctx, routes } = fakeContext({ host: '127.0.0.1' })
  registerAccountAccess(ctx, service, noopLogger)
  const result = await callRoute(routes, 'models', { force: true })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [{ force: true }])
  assert.equal(result.value.available.length, 1)
  assert.equal(result.value.unavailable[0].reasonTitle, 'Paid Pro')
  assert.equal(result.value.models.length, 1)
})
