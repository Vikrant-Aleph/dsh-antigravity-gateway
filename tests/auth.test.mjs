import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AuthManager, antigravityAuthStorePath } from '../lib/core/auth.js'
import { CredentialStore } from '../lib/core/credentials.js'
import { AgyTransport } from '../lib/core/transport/index.js'
import { noopLogger } from '../lib/core/logger.js'

test('importFromAntigravityAuth reads sibling auth.json read-only and stores refreshed grant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-auth-import-'))
  const envKey = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_DATA_HOME'
  const prevEnv = process.env[envKey]
  process.env[envKey] = dir
  try {
    const store = new CredentialStore({ file: path.join(dir, 'gateway-cred.json'), logger: noopLogger })
    const transport = new AgyTransport({})
    const plainFetch = async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'ya29.imported', refresh_token: '1//rotated', expires_in: 3600 }),
          { status: 200 },
        )
      }
      if (String(url).includes('userinfo')) {
        return new Response(JSON.stringify({ email: 'imported@example.com' }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const auth = new AuthManager({ store, transport, plainFetch, logger: noopLogger })

    await assert.rejects(auth.importFromAntigravityAuth(), (err) => err.code === 'MISSING_CREDENTIAL')

    const siblingFile = antigravityAuthStorePath()
    fs.mkdirSync(path.dirname(siblingFile), { recursive: true })
    fs.writeFileSync(siblingFile, '{not-json', 'utf8')
    await assert.rejects(auth.importFromAntigravityAuth(), (err) => err.code === 'INVALID_CREDENTIAL')

    fs.writeFileSync(siblingFile, JSON.stringify({ projectId: 'p1' }), 'utf8')
    await assert.rejects(auth.importFromAntigravityAuth(), (err) => err.code === 'INVALID_CREDENTIAL')

    const originalContent = JSON.stringify({ refreshToken: '1//sibling', projectId: 'proj-sibling' })
    fs.writeFileSync(siblingFile, originalContent, 'utf8')
    const result = await auth.importFromAntigravityAuth()
    assert.deepEqual(result, { email: 'imported@example.com', projectId: 'proj-sibling' })

    // Sibling file was never mutated.
    assert.equal(fs.readFileSync(siblingFile, 'utf8'), originalContent)
    const saved = await store.read()
    assert.equal(saved.refreshToken, '1//rotated')
    assert.equal(saved.accessToken, 'ya29.imported')
    assert.equal(saved.projectId, 'proj-sibling')

    await transport.close()
  } finally {
    if (prevEnv === undefined) delete process.env[envKey]
    else process.env[envKey] = prevEnv
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('discoverAccountMetadata extracts projectId and tier across endpoint fallbacks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-auth-meta-'))
  try {
    const store = new CredentialStore({ file: path.join(dir, 'cred.json'), logger: noopLogger })
    const seen = []
    const transport = {
      async request({ url }) {
        seen.push(url)
        if (String(url).startsWith('https://first.invalid')) {
          return new Response('unavailable', { status: 503 })
        }
        return new Response(
          JSON.stringify({
            cloudaicompanionProject: { id: 'proj-obj' },
            currentTier: { id: 'free-tier', name: 'Antigravity' },
            paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
          }),
          { status: 200 },
        )
      },
      idleTimeoutMs: 5000,
      async close() {},
    }
    const auth = new AuthManager({
      store,
      transport,
      endpoints: ['https://first.invalid', 'https://second.invalid'],
      logger: noopLogger,
    })

    const meta = await auth.discoverAccountMetadata('ya29.token')
    assert.equal(seen.length, 2)
    assert.equal(meta.projectId, 'proj-obj')
    assert.deepEqual(meta.tier, {
      current: { id: 'free-tier', name: 'Antigravity' },
      paid: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    })

    const status = await auth.status()
    assert.equal(status.tier, undefined) // not logged in yet
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getCredential decouples caller abort signals from shared single-flight token refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-auth-abort-'))
  try {
    const file = path.join(dir, 'cred.json')
    fs.writeFileSync(file, JSON.stringify({ refreshToken: '1//r', accessToken: 'ya29.expired', expiresAt: 1 }))
    const store = new CredentialStore({ file, logger: noopLogger })
    const transport = new AgyTransport({})

    let refreshCalls = 0
    let releaseRefresh
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve
    })

    const plainFetch = async (_url, init) => {
      refreshCalls += 1
      await refreshGate
      assert.equal(init?.signal?.aborted, false)
      return new Response(JSON.stringify({ access_token: 'ya29.fresh', expires_in: 3600 }), { status: 200 })
    }

    const auth = new AuthManager({ store, transport, plainFetch, logger: noopLogger })
    const controllerA = new AbortController()
    const controllerB = new AbortController()

    const reqA = auth.getCredential(controllerA.signal)
    const reqB = auth.getCredential(controllerB.signal)

    // Allow store.read() to enter refreshInFlight, then abort caller A only.
    await new Promise((r) => setTimeout(r, 15))
    controllerA.abort()

    await assert.rejects(reqA, (err) => err.code === 'ABORTED')
    releaseRefresh()

    const credB = await reqB
    assert.equal(credB.accessToken, 'ya29.fresh')
    assert.equal(refreshCalls, 1)

    await transport.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
