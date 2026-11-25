/**
 * Per-account live model catalog, availability detection, quota summary,
 * and multi-account failover candidate selection.
 */
import fs from 'node:fs'
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  PATH_AVAILABLE_MODELS,
  PATH_QUOTA,
} from '../protocol/constants.js'
import {
  accountCacheKey,
  buildReportFromParsed,
  defaultMaxOutput,
  definitionAvailable,
  parseLiveCatalog,
  parseLiveModelIds,
  parseQuotaSummary,
  selectQuotaForModel,
  type AccountTierInfo,
  type AvailableModelDetail,
  type CatalogAvailabilityReport,
  type LiveModelEntry,
  type ParsedLiveCatalog,
  type QuotaBucketSummary,
  type QuotaGroupSummary,
  type UnavailableModelDetail,
} from '../protocol/catalog-parser.js'
import { MODEL_DEFINITIONS, normalizeModelId, type ModelDefinition } from '../protocol/models.js'
import { GatewayError, isGatewayError } from '../shared/errors.js'
import { writeFileAtomicSync } from '../shared/fs-atomic.js'
import { isRecord, raceWithAbort } from '../shared/guards.js'
import type { AccountSummary } from '../shared/rpc-contracts.js'
import type { AuthManager } from './auth.js'
import type { GatewayLogger } from './logger.js'
import { noopLogger } from './logger.js'
import { AgyTransport, cancelResponse, readBoundedText } from './transport/index.js'

export {
  accountCacheKey,
  definitionAvailable,
  parseLiveCatalog,
  parseLiveModelIds,
  parseQuotaSummary,
  selectQuotaForModel,
  type AvailableModelDetail,
  type CatalogAvailabilityReport,
  type LiveModelEntry,
  type ParsedLiveCatalog,
  type QuotaBucketSummary,
  type QuotaGroupSummary,
  type UnavailableModelDetail,
}

const MAX_CATALOG_BYTES = 512 * 1024
const ERROR_RETRY_COOLDOWN_MS = 10_000
const DEFAULT_QUOTA_COOLDOWN_MS = 60_000

export interface CatalogOptions {
  ttlMs?: number
  extraModels?: readonly string[]
  logger?: GatewayLogger
  endpoints?: readonly string[]
  /** Optional non-secret disk cache file; omitted in tests unless requested. */
  cacheFile?: string
  onUpdated?: () => void
}

interface DiskCatalogCache {
  accountKey: string
  checkedAt: string
  availableIds: string[]
  report: CatalogAvailabilityReport
}

interface AccountCatalogState {
  parsed?: ParsedLiveCatalog
  report?: CatalogAvailabilityReport
  quotaGroups: QuotaGroupSummary[]
  fullReport: boolean
  expiresAt: number
  lastErrorAt: number
}

export class ModelCatalog {
  private readonly auth: AuthManager
  private readonly transport: AgyTransport
  private readonly ttlMs: number
  private readonly extraModels: readonly string[]
  private readonly logger: GatewayLogger
  private readonly endpoints: readonly string[]
  private readonly cacheFile?: string
  private readonly onUpdated?: () => void
  private readonly accountCaches = new Map<string, AccountCatalogState>()
  private readonly quotaCooldowns = new Map<string, number>()
  private lastAccountKey: string | undefined
  private lastAdvertised: string | undefined
  private generation = 0
  private readonly inFlightFetches = new Map<
    string,
    Promise<{ parsed: ParsedLiveCatalog; definitions: ModelDefinition[]; report: CatalogAvailabilityReport }>
  >()

  constructor(auth: AuthManager, transport: AgyTransport, options: CatalogOptions = {}) {
    this.auth = auth
    this.transport = transport
    this.ttlMs = options.ttlMs ?? 30_000
    this.extraModels = options.extraModels ?? []
    this.logger = options.logger ?? noopLogger
    this.endpoints = options.endpoints ?? ANTIGRAVITY_ENDPOINT_FALLBACKS
    this.cacheFile = options.cacheFile
    this.onUpdated = options.onUpdated
  }

  private stateFor(accountKey: string): AccountCatalogState {
    let state = this.accountCaches.get(accountKey)
    if (!state) {
      state = { quotaGroups: [], fullReport: false, expiresAt: 0, lastErrorAt: 0 }
      this.accountCaches.set(accountKey, state)
    }
    return state
  }

  /** Forget account-bound availability (logout / cache reset). */
  invalidate(accountKey?: string): void {
    this.generation += 1
    this.inFlightFetches.clear()
    if (accountKey !== undefined) {
      this.accountCaches.delete(accountKey)
      for (const key of this.quotaCooldowns.keys()) {
        if (key.startsWith(`${accountKey}::`)) this.quotaCooldowns.delete(key)
      }
      if (this.lastAccountKey === accountKey) this.lastAdvertised = undefined
      if (this.cacheFile) {
        try {
          const map = this.readDiskMap()
          if (accountKey in map) {
            delete map[accountKey]
            if (Object.keys(map).length === 0) {
              if (fs.existsSync(this.cacheFile)) fs.unlinkSync(this.cacheFile)
            } else {
              writeFileAtomicSync(this.cacheFile, JSON.stringify({ version: 2, entries: map }))
            }
          }
        } catch {
          // Best effort.
        }
      }
      return
    }
    this.accountCaches.clear()
    this.quotaCooldowns.clear()
    this.lastAccountKey = undefined
    this.lastAdvertised = undefined
    if (this.cacheFile) {
      try {
        if (fs.existsSync(this.cacheFile)) fs.unlinkSync(this.cacheFile)
      } catch {
        // Best effort.
      }
    }
  }

  /** Signal that the active account changed (manual switch or failover). */
  onActiveAccountChanged(): void {
    this.lastAdvertised = undefined
    try {
      this.onUpdated?.()
    } catch {
      // Observer failures cannot break callers.
    }
  }

  /** Record runtime quota exhaustion for `(accountKey, modelId)` until `untilMs`. */
  markAccountQuotaExhausted(accountKey: string, modelId: string, untilMs: number = Date.now() + DEFAULT_QUOTA_COOLDOWN_MS): void {
    this.quotaCooldowns.set(`${accountKey}::${modelId}`, untilMs)
  }

  clearAccountQuotaExhausted(accountKey: string, modelId?: string): void {
    if (modelId !== undefined) {
      this.quotaCooldowns.delete(`${accountKey}::${modelId}`)
      return
    }
    for (const key of this.quotaCooldowns.keys()) {
      if (key.startsWith(`${accountKey}::`)) this.quotaCooldowns.delete(key)
    }
  }

  isAccountQuotaExhausted(accountKey: string, modelId: string, now: number = Date.now()): boolean {
    const cooldownKey = `${accountKey}::${modelId}`
    const until = this.quotaCooldowns.get(cooldownKey)
    if (until !== undefined) {
      if (until > now) return true
      this.quotaCooldowns.delete(cooldownKey)
    }
    const cached = this.accountCaches.get(accountKey)
    if (cached?.report && now < cached.expiresAt) {
      const detail = cached.report.available.find((item) => item.id === modelId)
      if (detail && (detail.status === 'quota-exhausted' || detail.remainingFraction === 0)) {
        if (detail.resetTime) {
          const resetMs = Date.parse(detail.resetTime)
          if (Number.isFinite(resetMs) && resetMs <= now) return false
        }
        return true
      }
    }
    return false
  }

  /** Choose the best eligible failover account for `modelId`. */
  selectBestAccountForModel(
    accounts: readonly AccountSummary[],
    currentAccountId: string,
    modelId: string,
    triedAccountIds: ReadonlySet<string>,
    now: number = Date.now(),
  ): AccountSummary | undefined {
    let bestAccount: AccountSummary | undefined
    let bestScore = -1
    for (const account of accounts) {
      if (account.id === currentAccountId || triedAccountIds.has(account.id)) continue
      const key = accountCacheKey(account)
      if (this.isAccountQuotaExhausted(key, modelId, now)) continue
      const report = this.accountCaches.get(key)?.report ?? this.readDiskCache(key)?.report
      if (report) {
        const disabled = report.unavailable.some((u) => u.id === modelId && u.status === 'disabled')
        if (disabled) continue
        const detail = report.available.find((a) => a.id === modelId)
        if (detail) {
          if (detail.remainingFraction !== undefined) {
            if (detail.remainingFraction <= 0) {
              const resetMs = detail.resetTime ? Date.parse(detail.resetTime) : Number.NaN
              if (!Number.isFinite(resetMs) || resetMs > now) continue
            }
            const score = 2 + detail.remainingFraction
            if (score > bestScore) {
              bestScore = score
              bestAccount = account
            }
            continue
          }
          if (2 > bestScore) {
            bestScore = 2
            bestAccount = account
          }
          continue
        }
      }
      if (1 > bestScore) {
        bestScore = 1
        bestAccount = account
      }
    }
    return bestAccount
  }

  /** Enabled live wire ids for the active account, cached with a TTL. */
  async liveIds(signal?: AbortSignal, force = false): Promise<Set<string>> {
    const { parsed } = await this.fetchLiveState(signal, force, false)
    return parsed.enabledIds
  }

  /**
   * Full availability + quota report for Settings UI and `/agw models`.
   * Pass `force: true` to bypass the TTL cache and probe upstream now.
   */
  async getAvailabilityReport(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<CatalogAvailabilityReport> {
    const force = options.force === true
    const signal = options.signal
    const key = await this.currentAccountKey()
    const cached = this.accountCaches.get(key)

    if (!force && cached?.report && cached.fullReport && Date.now() < cached.expiresAt) {
      return cached.report
    }

    try {
      const { report, definitions } = await this.fetchLiveState(signal, force, true)
      this.notifyIfChanged(this.withExtraModels(definitions))
      return report
    } catch (error) {
      if (isGatewayError(error) && error.code === 'AUTH') throw error
      const message = error instanceof Error ? error.message : String(error)
      const fallback = this.offlineReport(key, message)
      return fallback.report
    }
  }

  /**
   * Definitions to advertise in the DSH model picker: ONLY enabled models
   * from the live catalog (or cached live snapshot if temporarily offline),
   * plus configured `extraModels`.
   */
  async list(signal?: AbortSignal): Promise<readonly ModelDefinition[]> {
    const key = await this.currentAccountKey()
    let definitions: ModelDefinition[]
    try {
      const state = await this.fetchLiveState(signal, false, false)
      definitions = state.definitions
      if (definitions.length === 0) {
        this.logger.warn('catalog', 'live catalog matched no pinned models; offering the pinned snapshot')
        definitions = [...MODEL_DEFINITIONS]
      }
    } catch (error) {
      if (isGatewayError(error) && error.code === 'AUTH') throw error
      this.logger.warn('catalog', 'live catalog unavailable; falling back', {
        error: String(error).slice(0, 200),
      })
      const offline = this.offlineReport(key, error instanceof Error ? error.message : String(error))
      definitions = offline.definitions
    }
    const merged = this.withExtraModels(definitions)
    this.notifyIfChanged(merged)
    return merged
  }

  /**
   * Return the cached per-model availability/quota status for an enabled or
   * disabled model, used for badges in listModels and 404 diagnostics in stream.
   */
  getModelDetail(modelId: string, accountKey?: string): AvailableModelDetail | UnavailableModelDetail | undefined {
    const key = accountKey ?? this.lastAccountKey
    if (!key) return undefined
    const report = this.accountCaches.get(key)?.report ?? this.readDiskCache(key)?.report
    if (!report) return undefined
    return (
      report.available.find((item) => item.id === modelId) ??
      report.unavailable.find((item) => item.id === modelId)
    )
  }

  private withExtraModels(definitions: readonly ModelDefinition[]): ModelDefinition[] {
    const merged = [...definitions]
    for (const id of this.extraModels) {
      const extra = MODEL_DEFINITIONS.find((definition) => definition.id === normalizeModelId(id))
      if (extra && !merged.some((definition) => definition.id === extra.id)) merged.push(extra)
    }
    return merged
  }

  private notifyIfChanged(merged: readonly ModelDefinition[]): void {
    const signature = merged.map((definition) => definition.id).join(',')
    if (signature !== this.lastAdvertised) {
      this.lastAdvertised = signature
      try {
        this.onUpdated?.()
      } catch {
        // Observer failures cannot break the catalog.
      }
    }
  }

  private async currentAccountKey(): Promise<string> {
    if (typeof this.auth.status === 'function') {
      try {
        const status = await this.auth.status()
        if (!status.loggedIn) return 'unauthenticated'
        return accountCacheKey({
          ...(status.activeAccountId ? { id: status.activeAccountId } : {}),
          ...(status.projectId ? { projectId: status.projectId } : {}),
          ...(status.email ? { email: status.email } : {}),
        })
      } catch {
        // Fall through.
      }
    }
    return this.lastAccountKey ?? 'default'
  }

  private async fetchLiveState(
    signal: AbortSignal | undefined,
    force: boolean,
    includeTierAndQuota: boolean,
  ): Promise<{ parsed: ParsedLiveCatalog; definitions: ModelDefinition[]; report: CatalogAvailabilityReport }> {
    if (signal?.aborted) {
      throw new GatewayError('The Antigravity request was cancelled', 'ABORTED')
    }
    const preKey = await this.currentAccountKey()
    const flightKey = `${preKey}:${includeTierAndQuota ? 'full' : 'list'}`
    if (!force) {
      const existing = this.inFlightFetches.get(flightKey)
      if (existing) {
        return raceWithAbort(existing, signal)
      }
    }
    const gen = this.generation
    const flight = this.runFetchLiveState(preKey, gen, force, includeTierAndQuota).finally(() => {
      if (this.inFlightFetches.get(flightKey) === flight) {
        this.inFlightFetches.delete(flightKey)
      }
    })
    this.inFlightFetches.set(flightKey, flight)
    return raceWithAbort(flight, signal)
  }

  private async runFetchLiveState(
    preKey: string,
    gen: number,
    force: boolean,
    includeTierAndQuota: boolean,
  ): Promise<{ parsed: ParsedLiveCatalog; definitions: ModelDefinition[]; report: CatalogAvailabilityReport }> {
    const preState = this.accountCaches.get(preKey)
    if (
      !force &&
      preState &&
      preState.lastErrorAt > 0 &&
      Date.now() - preState.lastErrorAt < ERROR_RETRY_COOLDOWN_MS &&
      preKey !== 'unauthenticated'
    ) {
      throw new GatewayError('Live model catalog recently failed; using cached snapshot briefly', 'TRANSPORT')
    }

    let credential
    try {
      credential = await this.auth.getCredential()
    } catch (error) {
      if (this.generation === gen && isGatewayError(error) && (error.code === 'TRANSPORT' || error.code === 'TIMEOUT')) {
        const state = this.stateFor(preKey)
        state.lastErrorAt = Date.now()
        this.lastAccountKey = preKey
      }
      throw error
    }
    if (!credential) throw new GatewayError('Antigravity login is required before model discovery', 'AUTH')
    if (!credential.accessToken) throw new GatewayError('The stored credential has no usable access token', 'INVALID_CREDENTIAL')

    const key = accountCacheKey(credential)
    const state = this.stateFor(key)
    if (!force && state.parsed && state.report && Date.now() < state.expiresAt) {
      if (!includeTierAndQuota || state.fullReport) {
        this.lastAccountKey = key
        return {
          parsed: state.parsed,
          definitions: this.definitionsForReport(state.report),
          report: state.report,
        }
      }
    }

    let parsed: ParsedLiveCatalog
    try {
      parsed = await this.probeAvailableModels(credential.accessToken, credential.projectId)
      if (this.generation === gen) state.lastErrorAt = 0
    } catch (error) {
      if (this.generation === gen) {
        state.lastErrorAt = Date.now()
        this.lastAccountKey = key
      }
      throw error
    }

    let tier: AccountTierInfo | undefined = force ? undefined : state.report?.tier
    let quotaGroups: QuotaGroupSummary[] = force ? [] : state.quotaGroups
    let fullReport = state.fullReport
    if (includeTierAndQuota) {
      const [fetchedTier, fetchedQuota] = await Promise.all([
        typeof this.auth.getAccountTier === 'function'
          ? this.auth.getAccountTier(undefined, force).catch(() => undefined)
          : Promise.resolve(undefined),
        this.probeQuotaSummary(credential.accessToken, credential.projectId).catch(() => []),
      ])
      if (fetchedTier !== undefined) tier = fetchedTier
      if (fetchedQuota.length > 0) quotaGroups = fetchedQuota
      fullReport = true
    } else {
      fullReport = false
    }

    const checkedAt = new Date().toISOString()
    const { definitions, report } = buildReportFromParsed(parsed, checkedAt, tier, quotaGroups)
    if (this.generation === gen) {
      state.parsed = parsed
      state.report = report
      state.quotaGroups = quotaGroups
      state.fullReport = fullReport
      state.expiresAt = Date.now() + this.ttlMs
      this.lastAccountKey = key
      for (const item of report.available) {
        if (item.remainingFraction !== undefined && item.remainingFraction > 0) {
          this.clearAccountQuotaExhausted(key, item.id)
        }
      }
      this.writeDiskCache(key, definitions, report)
    }
    this.logger.debug('catalog', 'live catalog refreshed', {
      accountKey: key,
      enabled: report.available.length,
      unavailable: report.unavailable.length,
    })
    return { parsed, definitions, report }
  }

  private definitionsForReport(report: CatalogAvailabilityReport): ModelDefinition[] {
    const byId = new Map(MODEL_DEFINITIONS.map((definition) => [definition.id, definition]))
    return report.available
      .map((item) => byId.get(item.id))
      .filter((definition): definition is ModelDefinition => definition !== undefined)
  }

  private offlineReport(accountKey: string, errorMessage: string): { definitions: ModelDefinition[]; report: CatalogAvailabilityReport } {
    this.lastAccountKey = accountKey
    const cached = this.accountCaches.get(accountKey)
    if (cached?.report) {
      return {
        definitions: this.definitionsForReport(cached.report),
        report: { ...cached.report, source: 'cached', error: errorMessage },
      }
    }
    const fromDisk = this.readDiskCache(accountKey)
    if (fromDisk) {
      const state = this.stateFor(accountKey)
      state.report = fromDisk.report
      const byId = new Map(MODEL_DEFINITIONS.map((definition) => [definition.id, definition]))
      const definitions = fromDisk.availableIds
        .map((id) => byId.get(id))
        .filter((definition): definition is ModelDefinition => definition !== undefined)
      return {
        definitions: definitions.length > 0 ? definitions : this.definitionsForReport(fromDisk.report),
        report: { ...fromDisk.report, source: 'cached', error: errorMessage },
      }
    }
    const available: AvailableModelDetail[] = MODEL_DEFINITIONS.map((definition) => ({
      id: definition.id,
      name: definition.name,
      efforts: definition.efforts.map((effort) => effort.id),
      contextWindow: definition.contextWindow,
      maxOutputTokens: defaultMaxOutput(definition),
      status: 'available',
    }))
    return {
      definitions: [...MODEL_DEFINITIONS],
      report: {
        source: 'fallback-snapshot',
        checkedAt: new Date().toISOString(),
        error: errorMessage,
        quotaGroups: [],
        available,
        unavailable: [],
      },
    }
  }

  private async probeAvailableModels(accessToken: string, projectId: string | undefined, signal?: AbortSignal): Promise<ParsedLiveCatalog> {
    let lastError: unknown
    for (const endpoint of this.endpoints) {
      try {
        const value = await this.postJson(endpoint, PATH_AVAILABLE_MODELS, accessToken, projectId ? { project: projectId } : {}, projectId !== undefined, signal)
        return parseLiveCatalog(value)
      } catch (error) {
        lastError = error
        if (isGatewayError(error) && (error.code === 'ABORTED' || error.code === 'AUTH')) throw error
        this.logger.debug('catalog', 'live catalog endpoint failed', { endpoint, error: String(error).slice(0, 200) })
      }
    }
    throw lastError instanceof Error ? lastError : new GatewayError('Live model catalog unavailable', 'TRANSPORT')
  }

  private async probeQuotaSummary(accessToken: string, projectId: string | undefined, signal?: AbortSignal): Promise<QuotaGroupSummary[]> {
    for (const endpoint of this.endpoints) {
      try {
        const value = await this.postJson(endpoint, PATH_QUOTA, accessToken, projectId ? { project: projectId } : {}, false, signal)
        return parseQuotaSummary(value)
      } catch (error) {
        if (isGatewayError(error) && error.code === 'ABORTED') throw error
      }
    }
    return []
  }

  private async postJson(
    endpoint: string,
    apiPath: string,
    accessToken: string,
    body: Record<string, unknown>,
    retryEmptyOn403: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response = await this.transport.request({
      url: `${endpoint}${apiPath}`,
      accessToken,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    if (response.status === 403 && retryEmptyOn403) {
      const retry = await this.transport.request({
        url: `${endpoint}${apiPath}`,
        accessToken,
        body: JSON.stringify({}),
        ...(signal ? { signal } : {}),
      })
      if (retry.ok) {
        await cancelResponse(response)
        response = retry
      } else {
        await cancelResponse(retry)
      }
    }
    if (!response.ok) {
      const text = await readBoundedText(response, 8192, signal).catch(() => '')
      await cancelResponse(response)
      if (response.status === 401 || response.status === 403) {
        throw new GatewayError('Antigravity rejected the credential during model discovery', 'AUTH', { status: response.status })
      }
      throw new GatewayError(`Catalog endpoint failed (${response.status}): ${text.slice(0, 200)}`, 'TRANSPORT', { status: response.status })
    }
    const text = await readBoundedText(response, MAX_CATALOG_BYTES, signal)
    try {
      return JSON.parse(text)
    } catch {
      throw new GatewayError('The Antigravity live model catalog was not JSON', 'PROTOCOL_DRIFT')
    }
  }

  private readDiskMap(): Record<string, DiskCatalogCache> {
    if (!this.cacheFile) return {}
    try {
      if (!fs.existsSync(this.cacheFile)) return {}
      const value = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as unknown
      if (!isRecord(value)) return {}
      if (value.version === 2 && isRecord(value.entries)) {
        const out: Record<string, DiskCatalogCache> = {}
        for (const [k, entry] of Object.entries(value.entries)) {
          if (isRecord(entry) && entry.accountKey === k && Array.isArray(entry.availableIds) && isRecord(entry.report)) {
            out[k] = entry as unknown as DiskCatalogCache
          }
        }
        return out
      }
      if (typeof value.accountKey === 'string' && Array.isArray(value.availableIds) && isRecord(value.report)) {
        return { [value.accountKey]: value as unknown as DiskCatalogCache }
      }
      return {}
    } catch {
      return {}
    }
  }

  private readDiskCache(accountKey: string | undefined): DiskCatalogCache | undefined {
    if (!this.cacheFile || !accountKey) return undefined
    return this.readDiskMap()[accountKey]
  }

  private writeDiskCache(accountKey: string, definitions: readonly ModelDefinition[], report: CatalogAvailabilityReport): void {
    if (!this.cacheFile) return
    try {
      const map = this.readDiskMap()
      map[accountKey] = {
        accountKey,
        checkedAt: report.checkedAt,
        availableIds: definitions.map((definition) => definition.id),
        report,
      }
      writeFileAtomicSync(this.cacheFile, JSON.stringify({ version: 2, entries: map }))
    } catch {
      // Cache persistence is best-effort.
    }
  }
}
