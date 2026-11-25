/**
 * Authentication manager: login, single-flight token refresh, project
 * discovery, and an explicit import from a sibling dsh-antigravity-auth
 * installation.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  GOOGLE_USERINFO_ENDPOINT,
  PATH_LOAD_CODE_ASSIST,
  buildLoadCodeAssistMetadata,
} from '../protocol/constants.js'
import { extractProjectId, parseAccountTier, type AccountTierInfo, type TierSummary } from '../protocol/catalog-parser.js'
import { GatewayError } from '../shared/errors.js'
import { isRecord, raceWithAbort } from '../shared/guards.js'
import type { GatewayLogger } from './logger.js'
import { noopLogger } from './logger.js'
import { CredentialStore, type GatewayCredential } from './credentials.js'
import {
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  startCallbackServer,
  type CallbackServer,
} from './oauth.js'
import { AgyTransport, cancelResponse, readBoundedText, type FetchLike } from './transport/index.js'

export { parseAccountTier, type AccountTierInfo, type TierSummary }

/** Refresh this many milliseconds before the actual expiry. */
const EXPIRY_LEAD_MS = 60_000

export interface AuthStatus {
  loggedIn: boolean
  email?: string
  projectId?: string
  expiresAt?: number
  backend: 'credentials-service' | 'file'
  loginPending: boolean
  /** Authorization URL of the pending login, for manual opening. */
  loginUrl?: string
  /** Message of the last failed login attempt. */
  loginError?: string
  /** Account plan tiers reported by loadCodeAssist, when known. */
  tier?: AccountTierInfo
}

export interface LoginHandle {
  /** Authorization URL the user can open manually. */
  url: string
  /** Resolves when the whole flow settles. */
  done: Promise<{ email?: string; projectId?: string }>
  cancel(): void
}

export class AuthManager {
  private readonly store: CredentialStore
  private readonly transport: AgyTransport
  private readonly plainFetch: FetchLike
  private readonly logger: GatewayLogger
  private readonly endpoints: readonly string[]
  private refreshInFlight: Promise<GatewayCredential> | undefined
  private pendingLogin: { server: CallbackServer; controller: AbortController; done: Promise<{ email?: string; projectId?: string }> } | undefined
  private pendingUrl: string | undefined
  private lastLoginError: string | undefined
  private cachedTier: AccountTierInfo | undefined
  private readonly openUrl: (url: string) => boolean

  constructor(options: {
    store: CredentialStore
    transport: AgyTransport
    plainFetch?: FetchLike
    logger?: GatewayLogger
    endpoints?: readonly string[]
    /** Test seam: replace the system-browser opener. */
    openUrl?: (url: string) => boolean
  }) {
    this.store = options.store
    this.transport = options.transport
    this.plainFetch =
      options.plainFetch ??
      (typeof options.transport.fetch === 'function'
        ? (url, init) => options.transport.fetch(url, init)
        : (url, init) => fetch(url, init))
    this.logger = options.logger ?? noopLogger
    this.endpoints = options.endpoints ?? ANTIGRAVITY_ENDPOINT_FALLBACKS
    this.openUrl = options.openUrl ?? openBrowser
  }

  /**
   * A usable credential, refreshing when the access token is missing or
   * near expiry. Concurrent callers share one refresh; cancelling one caller
   * never aborts the shared refresh for others.
   */
  async getCredential(signal?: AbortSignal, forceRefresh = false): Promise<GatewayCredential | undefined> {
    if (signal?.aborted) {
      throw new GatewayError('The Antigravity request was cancelled', 'ABORTED')
    }
    const stored = await this.store.read()
    if (!stored) return undefined
    const now = Date.now()
    if (
      !forceRefresh &&
      typeof stored.accessToken === 'string' &&
      stored.accessToken.length > 0 &&
      typeof stored.expiresAt === 'number' &&
      stored.expiresAt - EXPIRY_LEAD_MS > now
    ) {
      return stored
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(stored).finally(() => {
        this.refreshInFlight = undefined
      })
    }
    return raceWithAbort(this.refreshInFlight, signal)
  }

  private async refresh(stored: GatewayCredential): Promise<GatewayCredential> {
    this.logger.debug('auth', 'refreshing access token')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('token refresh timeout')), 30_000)
    try {
      const tokens = await refreshAccessToken(this.plainFetch, stored.refreshToken, controller.signal)
      const next: GatewayCredential = {
        ...stored,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
      }
      await this.store.write(next)
      this.logger.info('auth', 'access token refreshed', { expiresInMs: tokens.expiresAt - Date.now() })
      return next
    } finally {
      clearTimeout(timer)
    }
  }

  /** Start the interactive OAuth flow; opens the system browser best-effort. */
  async login(options: { port: number; timeoutMs: number }): Promise<LoginHandle> {
    if (this.pendingLogin) {
      throw new GatewayError('A sign-in is already in progress; cancel it first', 'INVALID_REQUEST')
    }
    const start = buildAuthorizationUrl(options.port)
    const controller = new AbortController()
    const server = await startCallbackServer(
      { state: start.state, verifier: start.verifier },
      { port: options.port, timeoutMs: options.timeoutMs, signal: controller.signal },
    )
    // The redirect URI must carry the actually-bound port (oauthPort 0 asks
    // the OS for a free port). Rewrite it into the authorization URL so the
    // browser, Google, and the token exchange all agree on one redirect.
    const redirectUri = `http://localhost:${server.port}/oauth-callback`
    const authorizationUrl = new URL(start.url)
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    const finalUrl = authorizationUrl.toString()
    this.pendingUrl = finalUrl
    this.lastLoginError = undefined
    const done = (async () => {
      try {
        const callback = await server.completed
        const tokens = await exchangeCode(this.plainFetch, {
          code: callback.code,
          verifier: callback.verifier,
          redirectUri,
          signal: controller.signal,
        })
        if (!tokens.refreshToken) {
          throw new GatewayError('Google did not return a refresh token; sign in again with consent', 'AUTH')
        }
        const projectId = await this.discoverProject(tokens.accessToken, controller.signal)
        const email = await this.fetchEmail(tokens.accessToken, controller.signal)
        const credential: GatewayCredential = {
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          ...(projectId ? { projectId } : {}),
          ...(email ? { email } : {}),
        }
        await this.store.write(credential)
        this.logger.info('auth', 'sign-in complete', { projectId: projectId || '(none)', email: email ? 'present' : 'unknown' })
        return { ...(email ? { email } : {}), ...(projectId ? { projectId } : {}) }
      } catch (error) {
        this.lastLoginError = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        server.close()
        this.pendingLogin = undefined
        this.pendingUrl = undefined
      }
    })()
    done.catch(() => {})
    this.pendingLogin = { server, controller, done }
    this.openUrl(finalUrl)
    this.logger.info('auth', 'sign-in started', { port: server.port })
    return {
      url: finalUrl,
      done,
      cancel: () => {
        controller.abort()
        server.close()
      },
    }
  }

  cancelLogin(): boolean {
    if (!this.pendingLogin) return false
    this.pendingLogin.controller.abort()
    this.pendingLogin.server.close()
    this.pendingLogin = undefined
    this.pendingUrl = undefined
    this.logger.info('auth', 'sign-in cancelled')
    return true
  }

  async logout(): Promise<void> {
    this.cancelLogin()
    this.cachedTier = undefined
    await this.store.delete()
    this.logger.info('auth', 'signed out; local credential removed')
  }

  async status(): Promise<AuthStatus> {
    const stored = await this.store.read()
    return {
      loggedIn: stored !== undefined,
      ...(stored?.email ? { email: stored.email } : {}),
      ...(stored?.projectId ? { projectId: stored.projectId } : {}),
      ...(stored?.expiresAt !== undefined ? { expiresAt: stored.expiresAt } : {}),
      backend: this.store.backend,
      loginPending: this.pendingLogin !== undefined,
      ...(this.pendingUrl !== undefined ? { loginUrl: this.pendingUrl } : {}),
      ...(this.lastLoginError !== undefined ? { loginError: this.lastLoginError } : {}),
      ...(stored !== undefined && this.cachedTier !== undefined ? { tier: this.cachedTier } : {}),
    }
  }

  /**
   * Explicitly import the active account cached by dsh-antigravity-auth.
   * Reads only refreshToken + projectId from that plugin's auth.json, then
   * refreshes through Google. The sibling store is never modified.
   */
  async importFromAntigravityAuth(signal?: AbortSignal): Promise<{ email?: string; projectId?: string }> {
    const file = antigravityAuthStorePath()
    if (!fs.existsSync(file)) {
      throw new GatewayError(`No dsh-antigravity-auth credential found at ${file}`, 'MISSING_CREDENTIAL')
    }
    let record: { refreshToken?: unknown; projectId?: unknown }
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof record
    } catch {
      throw new GatewayError('The dsh-antigravity-auth credential file is not readable JSON', 'INVALID_CREDENTIAL')
    }
    if (typeof record.refreshToken !== 'string' || record.refreshToken.length === 0) {
      throw new GatewayError('The dsh-antigravity-auth credential carries no refresh token', 'INVALID_CREDENTIAL')
    }
    const projectId = typeof record.projectId === 'string' ? record.projectId : undefined
    const tokens = await refreshAccessToken(this.plainFetch, record.refreshToken, signal)
    const email = await this.fetchEmail(tokens.accessToken, signal)
    const credential: GatewayCredential = {
      refreshToken: tokens.refreshToken ?? record.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(projectId ? { projectId } : {}),
      ...(email ? { email } : {}),
    }
    await this.store.write(credential)
    this.cachedTier = undefined
    this.logger.info('auth', 'imported account from dsh-antigravity-auth', { projectId: projectId || '(none)' })
    return { ...(email ? { email } : {}), ...(projectId ? { projectId } : {}) }
  }

  /** Read account tier metadata on demand via loadCodeAssist; returns undefined when offline. */
  async getAccountTier(signal?: AbortSignal, force = false): Promise<AccountTierInfo | undefined> {
    if (!force && this.cachedTier !== undefined) return this.cachedTier
    const credential = await this.getCredential(signal)
    if (!credential?.accessToken) return undefined
    const meta = await this.discoverAccountMetadata(credential.accessToken, signal)
    return meta.tier
  }

  /** loadCodeAssist project + tier discovery. */
  async discoverAccountMetadata(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<{ projectId: string; tier?: AccountTierInfo }> {
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.transport.request({
          url: `${endpoint}${PATH_LOAD_CODE_ASSIST}`,
          accessToken,
          body: JSON.stringify({ metadata: buildLoadCodeAssistMetadata() }),
          ...(signal ? { signal } : {}),
        })
        if (!response.ok) {
          await cancelResponse(response)
          continue
        }
        const text = await readBoundedText(response, 256 * 1024, signal)
        const value: unknown = JSON.parse(text)
        const record = isRecord(value) ? value : {}
        const tier = parseAccountTier(record)
        if (tier !== undefined) this.cachedTier = tier
        const projectId = extractProjectId(record)
        if (projectId || tier !== undefined) {
          return { projectId, ...(tier !== undefined ? { tier } : {}) }
        }
      } catch (error) {
        this.logger.debug('auth', 'project discovery attempt failed', {
          endpoint,
          error: String(error).slice(0, 200),
        })
      }
    }
    this.logger.warn('auth', 'project discovery unavailable; requests will omit the project field')
    return { projectId: '' }
  }

  /** loadCodeAssist project discovery; empty string when unavailable. */
  async discoverProject(accessToken: string, signal?: AbortSignal): Promise<string> {
    const meta = await this.discoverAccountMetadata(accessToken, signal)
    return meta.projectId
  }

  private async fetchEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.plainFetch(GOOGLE_USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
        ...(signal ? { signal } : {}),
      })
      if (!response.ok) return undefined
      const value = (await response.json()) as Record<string, unknown>
      return typeof value.email === 'string' ? value.email : undefined
    } catch {
      return undefined
    }
  }
}

/** dsh-antigravity-auth default store location (per its published source). */
export function antigravityAuthStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA || env.USERPROFILE || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-antigravity-auth', 'auth.json')
  }
  const base = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share')
  return path.join(base, 'dsh-antigravity-auth', 'auth.json')
}

/** Open a URL in the system browser; never throws. */
export function openBrowser(url: string): boolean {
  try {
    const command =
      process.platform === 'win32'
        ? { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
        : process.platform === 'darwin'
          ? { cmd: 'open', args: [url] }
          : { cmd: 'xdg-open', args: [url] }
    const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}
