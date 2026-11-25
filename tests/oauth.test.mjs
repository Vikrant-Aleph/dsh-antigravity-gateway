import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { buildAuthorizationUrl, exchangeCode, refreshAccessToken, startCallbackServer } from '../lib/core/oauth.js'
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_SCOPES } from '../lib/protocol/constants.js'

test('authorization URL carries PKCE S256, offline access, and the CLI scopes', () => {
  const start = buildAuthorizationUrl(51121)
  const url = new URL(start.url)
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), ANTIGRAVITY_CLIENT_ID)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:51121/oauth-callback')
  assert.equal(url.searchParams.get('scope'), ANTIGRAVITY_SCOPES.join(' '))
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('state'), start.state)
  // The verifier never travels in the URL.
  assert.ok(!start.url.includes(start.verifier))
  assert.ok(start.verifier.length >= 43)
})

test('token exchange posts the PKCE form and parses expiry', async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, body: init.body }
    return new Response(JSON.stringify({ access_token: 'ya29.test', refresh_token: '1//test', expires_in: 3599 }), { status: 200 })
  }
  const tokens = await exchangeCode(fetchImpl, { code: 'auth-code', verifier: 'verifier', redirectUri: 'http://localhost:51121/oauth-callback' })
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token')
  const form = new URLSearchParams(captured.body)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code'), 'auth-code')
  assert.equal(form.get('code_verifier'), 'verifier')
  assert.equal(tokens.accessToken, 'ya29.test')
  assert.equal(tokens.refreshToken, '1//test')
  assert.ok(tokens.expiresAt > Date.now())
})

test('refresh posts grant_type=refresh_token and keeps a rotated token', async () => {
  let captured
  const fetchImpl = async (_url, init) => {
    captured = new URLSearchParams(init.body)
    return new Response(JSON.stringify({ access_token: 'ya29.new', expires_in: 3600 }), { status: 200 })
  }
  const tokens = await refreshAccessToken(fetchImpl, '1//old')
  assert.equal(captured.get('grant_type'), 'refresh_token')
  assert.equal(captured.get('refresh_token'), '1//old')
  assert.equal(tokens.accessToken, 'ya29.new')
  assert.equal(tokens.refreshToken, undefined)
})

test('invalid_grant maps to INVALID_CREDENTIAL', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
  await assert.rejects(refreshAccessToken(fetchImpl, '1//revoked'), (error) => error.code === 'INVALID_CREDENTIAL')
})

test('callback server accepts the matching state and rejects mismatches', async () => {
  const expected = { state: 'state-abc', verifier: 'verifier-abc' }
  const server = await startCallbackServer(expected, { port: 0, timeoutMs: 10_000 })
  try {
    const base = `http://127.0.0.1:${server.port}/oauth-callback`
    const bad = await fetch(`${base}?code=x&state=wrong`)
    assert.equal(bad.status, 400)
    const good = await fetch(`${base}?code=the-code&state=state-abc`)
    assert.equal(good.status, 200)
    const result = await server.completed
    assert.equal(result.code, 'the-code')
    assert.equal(result.verifier, 'verifier-abc')
  } finally {
    server.close()
  }
})

test('callback server reports Google-side cancellation', async () => {
  const server = await startCallbackServer({ state: 's', verifier: 'v' }, { port: 0, timeoutMs: 10_000 })
  try {
    await fetch(`http://127.0.0.1:${server.port}/oauth-callback?error=access_denied`)
    await assert.rejects(server.completed, (error) => error.code === 'AUTH')
  } finally {
    server.close()
  }
})

test('callback server close() drops keep-alive connections and releases port immediately', async () => {
  const server = await startCallbackServer({ state: 's2', verifier: 'v2' }, { port: 0, timeoutMs: 10_000 })
  const agent = new http.Agent({ keepAlive: true })
  const port = server.port
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/favicon.ico`, { agent }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', reject)
    })
    server.close()
    await new Promise((r) => setTimeout(r, 25))
    const probe = net.createServer()
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', resolve)
    })
    await new Promise((resolve) => probe.close(resolve))
  } finally {
    agent.destroy()
    server.close()
  }
})
