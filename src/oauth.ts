/**
 * Google OAuth for the Antigravity public desktop client.
 *
 * PKCE S256 with a loopback callback. The verifier stays in Host memory,
 * keyed by an opaque random state, so the authorization URL itself carries
 * no secret and can be shown to the user for manual opening.
 */
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { AddressInfo } from 'node:net'
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_SCOPES,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  OAUTH_CALLBACK_PATH,
} from './constants.js'
import { BridgeError } from './errors.js'
import type { FetchLike } from './transport.js'

export interface AuthorizationStart {
  url: string
  state: string
  verifier: string
  redirectUri: string
}

/** Build the authorization URL; the caller keeps `verifier` server-side. */
export function buildAuthorizationUrl(port: number): AuthorizationStart {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  const redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return { url: url.toString(), state, verifier, redirectUri }
}

export interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

function parseTokenBody(value: unknown, startedAt: number): TokenResponse {
  if (typeof value !== 'object' || value === null) {
    throw new BridgeError('Google token response was not an object', 'INVALID_RESPONSE')
  }
  const record = value as Record<string, unknown>
  if (typeof record.access_token !== 'string' || record.access_token.length === 0) {
    throw new BridgeError('Google token response carried no access token', 'INVALID_RESPONSE')
  }
  const expiresIn = typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) ? record.expires_in : 3600
  return {
    accessToken: record.access_token,
    ...(typeof record.refresh_token === 'string' && record.refresh_token.length > 0 ? { refreshToken: record.refresh_token } : {}),
    expiresAt: startedAt + expiresIn * 1000,
  }
}

async function postTokenForm(fetchImpl: FetchLike, form: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    throw new BridgeError('Google token endpoint unreachable', 'TRANSPORT', { cause: error })
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    let code = 'AUTH'
    try {
      const parsed: unknown = JSON.parse(text)
      const errorValue = (parsed as Record<string, unknown>)?.error
      if (errorValue === 'invalid_grant') code = 'INVALID_CREDENTIAL'
    } catch {
      // Non-JSON error body.
    }
    throw new BridgeError(`Google token request failed (${response.status})`, code as BridgeError['code'], {
      status: response.status,
      detail: text.slice(0, 300),
    })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new BridgeError('Google token response was not JSON', 'INVALID_RESPONSE')
  }
  return parseTokenBody(value, startedAt)
}

/** Exchange an authorization code (with PKCE verifier) for tokens. */
export async function exchangeCode(
  fetchImpl: FetchLike,
  input: { code: string; verifier: string; redirectUri: string; signal?: AbortSignal },
): Promise<TokenResponse> {
  return postTokenForm(
    fetchImpl,
    {
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code: input.code,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    },
    input.signal,
  )
}

/** Refresh an access token; Google may rotate the refresh token. */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  return postTokenForm(
    fetchImpl,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
    },
    signal,
  )
}

export interface CallbackResult {
  code: string
  verifier: string
}

export interface CallbackServer {
  /** Resolves when Google redirects back with a valid code. */
  completed: Promise<CallbackResult>
  /** Actual bound port (differs from the request when port 0 was asked). */
  port: number
  close(): void
}

/**
 * Run a loopback-only callback server for one pending authorization.
 * Only `127.0.0.1` is bound; the state must match the pending verifier.
 */
export function startCallbackServer(
  expected: { state: string; verifier: string },
  options: { port: number; timeoutMs: number; signal?: AbortSignal },
): Promise<CallbackServer> {
  return new Promise<CallbackServer>((resolveServer, rejectServer) => {
    let settle: ((result: CallbackResult) => void) | undefined
    let fail: ((error: Error) => void) | undefined
    const completed = new Promise<CallbackResult>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    // Avoid unhandled rejection when nobody awaits `completed` after a close.
    completed.catch(() => {})

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('not found')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (error) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<html><body><h3>Antigravity sign-in was cancelled.</h3>You can close this tab and return to DSH.</body></html>')
        fail?.(new BridgeError(`Google authorization failed: ${error}`, 'AUTH'))
        return
      }
      if (!code || state !== expected.state) {
        // A stray or stale callback (old tab, prefetch) must not kill the
        // pending login; reject this request and keep waiting.
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<html><body><h3>Invalid sign-in callback.</h3>Start a new login from DSH.</body></html>')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<html><body><h3>Antigravity sign-in complete.</h3>You can close this tab and return to DSH.</body></html>')
      settle?.({ code, verifier: expected.verifier })
    })

    const timeout = setTimeout(() => {
      fail?.(new BridgeError('Antigravity sign-in timed out waiting for the browser callback', 'TIMEOUT'))
      close()
    }, options.timeoutMs)

    const onAbort = () => {
      fail?.(new BridgeError('Antigravity sign-in was cancelled', 'ABORTED'))
      close()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    function close(): void {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      try {
        server.close()
      } catch {
        // Already closed.
      }
    }

    server.once('error', (error) => {
      clearTimeout(timeout)
      rejectServer(new BridgeError(`Cannot bind the OAuth callback port: ${String(error)}`, 'TRANSPORT', { cause: error }))
    })
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null
      resolveServer({
        completed,
        port: address?.port ?? options.port,
        close,
      })
    })
  })
}
