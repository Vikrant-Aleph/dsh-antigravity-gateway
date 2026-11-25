/**
 * Authentication manager: multi-account login, per-account single-flight
 * token refresh, project discovery, switching, and explicit import from a
 * sibling dsh-antigravity-auth installation.
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
import type { AccountSummary } from '../shared/rpc-contracts.js'
import type { GatewayLogger } from './logger.js'
import { noopLogger } from './logger.js'
import { CredentialStore, type GatewayAccountRecord, type GatewayCredential } from './credentials.js'
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
  /** Active account id when signed in. */
  activeAccountId?: string
  /** All signed-in accounts (secrets omitted). */
  accounts?: AccountSummary[]
}

export interface LoginHandle {
  /** Authorization URL the user can open manually. */
  url: string
  /** Resolves when the whole flow settles. */
  done: Promise<{ email?: string; projectId?: string; accountId?: string }>
  cancel(): void
}

function toAccountSummary(record: GatewayAccountRecord, activeAccountId: string | undefined): AccountSummary {
  return {
    id: record.id,
    ...(record.email ? { email: record.email } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    active: record.id === activeAccountId,
    ...(record.addedAt !== undefined ? { addedAt: record.addedAt } : {}),
  }
}

export class AuthManager {
  private readonly store: CredentialStore
  private readonly transport: AgyTransport
  private readonly plainFetch: FetchLike
  private readonly logger: GatewayLogger
  private readonly endpoints: readonly string[]
  private readonly refreshInFlightByAccount = new Map<string, Promise<GatewayAccountRecord>>()
  private globalAuthGeneration = 0
  private readonly accountGenerations = new Map<string, number>()
  private pendingLogin: { server: CallbackServer; controller: AbortController; done: Promise<{ email?: string; projectId?: string; accountId?: string }> } | undefined
  private pendingUrl: string | undefined
  private lastLoginError: string | undefined
  private readonly cachedTiers = new Map<string, AccountTierInfo>()
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
   * A usable credential for the active account, refreshing when the access
   * token is missing or near expiry. Concurrent callers share one refresh;
   * cancelling one caller never aborts the shared refresh for others.
   */
  async getCredential(signal?: AbortSignal, forceRefresh = false): Promise<GatewayAccountRecord | undefined> {
    if (signal?.aborted) {
      throw new GatewayError('The Antigravity request was cancelled', 'ABORTED')
    }
    const stored = await this.store.readActiveAccount()
    if (!stored) return undefined
    return this.ensureFreshCredential(stored, signal, forceRefresh)
  }

  /** Get a usable credential for one specific stored account id. */
  async getCredentialForAccount(
    accountId: string,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<GatewayAccountRecord | undefined> {
    if (signal?.aborted) {
      throw new GatewayError('The Antigravity request was cancelled', 'ABORTED')
    }
    const { accounts } = await this.store.listAccounts()
    const target = accounts.find((a) => a.id === accountId)
    if (!target) return undefined
    return this.ensureFreshCredential(target, signal, forceRefresh)
  }

  private generationFor(accountId: string): number {
    return this.accountGenerations.get(accountId) ?? 0
  }

  private invalidateAccountRefresh(accountId?: string): void {
    if (accountId !== undefined) {
      this.accountGenerations.set(accountId, this.generationFor(accountId) + 1)
      this.refreshInFlightByAccount.delete(accountId)
      return
    }
    this.globalAuthGeneration += 1
    this.refreshInFlightByAccount.clear()
  }

  private async ensureFreshCredential(
    stored: GatewayAccountRecord,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<GatewayAccountRecord> {
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
    let flight = this.refreshInFlightByAccount.get(stored.id)
    if (!flight) {
      const gen = { accountGen: this.generationFor(stored.id), globalGen: this.globalAuthGeneration }
      const created = this.refresh(stored, gen).finally(() => {
        if (this.refreshInFlightByAccount.get(stored.id) === created) {
          this.refreshInFlightByAccount.delete(stored.id)
        }
      })
      this.refreshInFlightByAccount.set(stored.id, created)
      flight = created
    }
    return raceWithAbort(flight, signal)
  }

  private async refresh(
    stored: GatewayAccountRecord,
    gen: { accountGen: number; globalGen: number },
  ): Promise<GatewayAccountRecord> {
    this.logger.debug('auth', 'refreshing access token', { accountId: stored.id })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('token refresh timeout')), 30_000)
    try {
      const tokens = await refreshAccessToken(this.plainFetch, stored.refreshToken, controller.signal)
      if (this.generationFor(stored.id) !== gen.accountGen || this.globalAuthGeneration !== gen.globalGen) {
        throw new GatewayError('Authentication state changed during token refresh', 'ABORTED')
      }
      const next: GatewayAccountRecord = {
        ...stored,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
      }
      await this.store.updateAccount(stored.id, next)
      this.logger.info('auth', 'access token refreshed', {
        accountId: stored.id,
        expiresInMs: tokens.expiresAt - Date.now(),
      })
      return next
    } finally {
      clearTimeout(timer)
    }
  }

  /** Start the interactive OAuth flow; adds/updates and activates the signed-in account. */
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
        const meta = await this.discoverAccountMetadata(tokens.accessToken, controller.signal)
        const projectId = meta.projectId
        const email = (await this.fetchEmail(tokens.accessToken, controller.signal)) ?? tokens.email
        const credential: GatewayCredential = {
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          ...(projectId ? { projectId } : {}),
          ...(email ? { email } : {}),
        }
        const saved = await this.store.addAccount(credential, { activate: true })
        this.invalidateAccountRefresh(saved.id)
        if (meta.tier !== undefined) {
          this.cachedTiers.set(saved.id, meta.tier)
        }
        this.logger.info('auth', 'sign-in complete', {
          accountId: saved.id,
          projectId: projectId || '(none)',
          email: email ? 'present' : 'unknown',
        })
        return {
          accountId: saved.id,
          ...(email ? { email } : {}),
          ...(projectId ? { projectId } : {}),
        }
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

  async logout(accountId?: string, all = false): Promise<void> {
    if (!accountId || all) {
      this.cancelLogin()
    }
    if (all) {
      this.invalidateAccountRefresh()
      this.cachedTiers.clear()
      await this.store.delete()
      this.logger.info('auth', 'signed out of all accounts; local credentials removed')
      return
    }
    const targetId = accountId ?? (await this.store.readActiveAccount())?.id
    if (targetId) {
      this.invalidateAccountRefresh(targetId)
    }
    const result = await this.store.removeAccount(accountId)
    if (result.removedId) {
      if (result.removedId !== targetId) {
        this.invalidateAccountRefresh(result.removedId)
      }
      this.cachedTiers.delete(result.removedId)
    }
    if (!result.nextActiveId) {
      this.cachedTiers.clear()
    }
    this.logger.info('auth', 'signed out; local credential removed', {
      ...(result.removedId ? { removedId: result.removedId } : {}),
      ...(result.nextActiveId ? { nextActiveId: result.nextActiveId } : {}),
    })
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const { activeAccountId, accounts } = await this.store.listAccounts()
    return accounts.map((a) => toAccountSummary(a, activeAccountId))
  }

  async switchAccount(accountId: string): Promise<AccountSummary> {
    const target = await this.store.setActiveAccount(accountId)
    this.logger.info('auth', 'switched active account', { accountId: target.id })
    return toAccountSummary(target, target.id)
  }

  async switchAccountIfCurrent(expectedAccountId: string, nextAccountId: string): Promise<boolean> {
    const switched = await this.store.switchAccountIfCurrent(expectedAccountId, nextAccountId)
    if (switched) {
      this.logger.info('auth', 'auto-switched active account', {
        fromAccountId: expectedAccountId,
        toAccountId: nextAccountId,
      })
    }
    return switched
  }

  async status(): Promise<AuthStatus> {
    const { activeAccountId, accounts } = await this.store.listAccounts()
    const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
    const tier = active ? this.cachedTiers.get(active.id) : undefined
    return {
      loggedIn: active !== undefined,
      ...(active?.email ? { email: active.email } : {}),
      ...(active?.projectId ? { projectId: active.projectId } : {}),
      ...(active?.expiresAt !== undefined ? { expiresAt: active.expiresAt } : {}),
      backend: this.store.backend,
      loginPending: this.pendingLogin !== undefined,
      ...(this.pendingUrl !== undefined ? { loginUrl: this.pendingUrl } : {}),
      ...(this.lastLoginError !== undefined ? { loginError: this.lastLoginError } : {}),
      ...(active !== undefined && tier !== undefined ? { tier } : {}),
      ...(active !== undefined ? { activeAccountId: active.id } : {}),
      accounts: accounts.map((a) => toAccountSummary(a, active?.id)),
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
    const email = (await this.fetchEmail(tokens.accessToken, signal)) ?? tokens.email
    const credential: GatewayCredential = {
      refreshToken: tokens.refreshToken ?? record.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(projectId ? { projectId } : {}),
      ...(email ? { email } : {}),
    }
    const saved = await this.store.addAccount(credential, { activate: true })
    this.invalidateAccountRefresh(saved.id)
    this.cachedTiers.delete(saved.id)
    this.logger.info('auth', 'imported account from dsh-antigravity-auth', {
      accountId: saved.id,
      projectId: projectId || '(none)',
    })
    return {
      ...(email ? { email } : {}),
      ...(projectId ? { projectId } : {}),
    }
  }

  /** Read account tier metadata on demand via loadCodeAssist; returns undefined when offline. */
  async getAccountTier(signal?: AbortSignal, force = false): Promise<AccountTierInfo | undefined> {
    const credential = await this.getCredential(signal)
    if (!credential?.accessToken) return undefined
    if (!force) {
      const cached = this.cachedTiers.get(credential.id)
      if (cached !== undefined) return cached
    }
    const meta = await this.discoverAccountMetadata(credential.accessToken, signal, credential.id)
    return meta.tier
  }

  /** loadCodeAssist project + tier discovery. */
  async discoverAccountMetadata(
    accessToken: string,
    signal?: AbortSignal,
    accountId?: string,
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
        if (tier !== undefined && accountId) this.cachedTiers.set(accountId, tier)
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
