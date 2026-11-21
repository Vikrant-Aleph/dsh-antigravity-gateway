/**
 * Per-account live model catalog, availability detection, and quota summary.
 *
 * `v1internal:fetchAvailableModels` returns per-account model availability,
 * including plan-gated entries marked `disabled: true` (with `tagTitle` /
 * `tagDescription`), per-model `quotaInfo` (`remainingFraction`, `resetTime`),
 * and upstream notice tags. `v1internal:retrieveUserQuotaSummary` and
 * `v1internal:loadCodeAssist` supply quota buckets and account tier metadata.
 *
 * The DSH model selector (`list()`) advertises ONLY enabled models (never
 * `disabled: true` entries), falling back to the account's last verified live
 * cache when offline, and to the full pinned snapshot only when no live check
 * has ever succeeded for that account.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PATH_AVAILABLE_MODELS, PATH_QUOTA } from './constants.js'
import { BridgeError, isBridgeError } from './errors.js'
import type { BridgeLogger } from './logger.js'
import { noopLogger } from './logger.js'
import {
  KNOWN_TIER_SUFFIXES,
  MODEL_DEFINITIONS,
  canonicalDisabledModelId,
  canonicalModelId,
  definitionWireNames,
  normalizeModelId,
  type ModelDefinition,
} from './models.js'
import type { AccountTierInfo, AuthManager } from './auth.js'
import { AgyTransport, cancelResponse, readBoundedText } from './transport.js'

const MAX_CATALOG_BYTES = 512 * 1024
const MAX_CATALOG_ENTRIES = 512
const ERROR_RETRY_COOLDOWN_MS = 10_000

export interface CatalogOptions {
  ttlMs?: number
  extraModels?: readonly string[]
  logger?: BridgeLogger
  endpoints?: readonly string[]
  /** Optional non-secret disk cache file; omitted in tests unless requested. */
  cacheFile?: string
  onUpdated?: () => void
}

export interface LiveModelEntry {
  id: string
  rawId: string
  disabled: boolean
  displayName?: string
  wireModel?: string
  tagTitle?: string
  tagDescription?: string
  remainingFraction?: number
  resetTime?: string
  maxTokens?: number
  maxOutputTokens?: number
}

export interface ParsedLiveCatalog {
  enabledIds: Set<string>
  entries: LiveModelEntry[]
  /** Ordered model ids from `agentModelSorts`, when supplied by upstream. */
  agentOrder: string[]
}

export interface QuotaBucketSummary {
  bucketId: string
  displayName: string
  window?: string
  remainingFraction: number
  resetTime?: string
  description?: string
}

export interface QuotaGroupSummary {
  displayName: string
  description?: string
  buckets: QuotaBucketSummary[]
}

export interface AvailableModelDetail {
  id: string
  name: string
  efforts: string[]
  contextWindow: number
  maxOutputTokens: number
  status: 'available' | 'quota-exhausted'
  remainingFraction?: number
  resetTime?: string
  tagTitle?: string
  tagDescription?: string
}

export interface UnavailableModelDetail {
  id: string
  name: string
  status: 'disabled' | 'not-offered'
  reasonTitle?: string
  reasonDetail?: string
}

export interface CatalogAvailabilityReport {
  source: 'live' | 'cached' | 'fallback-snapshot'
  checkedAt: string
  error?: string
  tier?: AccountTierInfo
  quotaGroups: QuotaGroupSummary[]
  available: AvailableModelDetail[]
  unavailable: UnavailableModelDetail[]
}

interface DiskCatalogCache {
  accountKey: string
  checkedAt: string
  availableIds: string[]
  report: CatalogAvailabilityReport
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function cleanLiveId(value: string): string {
  return normalizeModelId(value)
}

function parseFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(value, 0), 1)
}

function parsePositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

/**
 * Parse `fetchAvailableModels` into enabled wire ids, disabled entries,
 * quota info, and upstream tags. Throws `PROTOCOL_DRIFT` on invalid shapes.
 */
export function parseLiveCatalog(value: unknown): ParsedLiveCatalog {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value
  if (!isRecord(root)) {
    throw new BridgeError('The Antigravity live model catalog was not an object', 'PROTOCOL_DRIFT')
  }
  const models = root.models
  if (!isRecord(models)) {
    throw new BridgeError('The Antigravity live model catalog had no models map', 'PROTOCOL_DRIFT')
  }
  const rawEntries = Object.entries(models)
  if (rawEntries.length > MAX_CATALOG_ENTRIES) {
    throw new BridgeError('The Antigravity live model catalog exceeded the model limit', 'PROTOCOL_DRIFT')
  }

  const enabledIds = new Set<string>()
  const entries: LiveModelEntry[] = []

  for (const [rawId, rawEntry] of rawEntries) {
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 256) {
      throw new BridgeError('The Antigravity live model catalog carried an invalid id', 'PROTOCOL_DRIFT')
    }
    const id = cleanLiveId(rawId)
    const entryObj = isRecord(rawEntry) ? rawEntry : {}
    const disabled = entryObj.disabled === true || id.endsWith('-disabled')
    const modelName = boundedString(entryObj.modelName, 256)
    const quota = isRecord(entryObj.quotaInfo) ? entryObj.quotaInfo : undefined
    const parsed: LiveModelEntry = {
      id,
      rawId,
      disabled,
      ...(boundedString(entryObj.displayName, 256) !== undefined ? { displayName: boundedString(entryObj.displayName, 256) } : {}),
      ...(boundedString(entryObj.model, 256) !== undefined ? { wireModel: boundedString(entryObj.model, 256) } : {}),
      ...(boundedString(entryObj.tagTitle, 128) !== undefined ? { tagTitle: boundedString(entryObj.tagTitle, 128) } : {}),
      ...(boundedString(entryObj.tagDescription, 512) !== undefined ? { tagDescription: boundedString(entryObj.tagDescription, 512) } : {}),
      ...(quota && parseFraction(quota.remainingFraction) !== undefined ? { remainingFraction: parseFraction(quota.remainingFraction) } : {}),
      ...(quota && boundedString(quota.resetTime, 64) !== undefined ? { resetTime: boundedString(quota.resetTime, 64) } : {}),
      ...(parsePositiveInt(entryObj.maxTokens) !== undefined ? { maxTokens: parsePositiveInt(entryObj.maxTokens) } : {}),
      ...(parsePositiveInt(entryObj.maxOutputTokens) !== undefined ? { maxOutputTokens: parsePositiveInt(entryObj.maxOutputTokens) } : {}),
    }
    entries.push(parsed)
    if (!disabled) {
      enabledIds.add(id)
      if (modelName !== undefined) enabledIds.add(cleanLiveId(modelName))
    }
  }

  const agentOrder: string[] = []
  if (Array.isArray(root.agentModelSorts)) {
    for (const sort of root.agentModelSorts) {
      if (!isRecord(sort) || !Array.isArray(sort.groups)) continue
      for (const group of sort.groups) {
        if (!isRecord(group) || !Array.isArray(group.modelIds)) continue
        for (const modelId of group.modelIds) {
          if (typeof modelId === 'string' && modelId.length > 0) agentOrder.push(cleanLiveId(modelId))
        }
      }
    }
  }

  return { enabledIds, entries, agentOrder }
}

/**
 * Parse `fetchAvailableModels` into enabled wire ids (excluding `disabled`
 * entries). Keeps compatibility with earlier callers.
 */
export function parseLiveModelIds(value: unknown): Set<string> {
  return parseLiveCatalog(value).enabledIds
}

/** Parse `retrieveUserQuotaSummary` response into compact quota groups. */
export function parseQuotaSummary(value: unknown): QuotaGroupSummary[] {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value
  if (!isRecord(root) || !Array.isArray(root.groups)) return []
  const groups: QuotaGroupSummary[] = []
  for (const rawGroup of root.groups) {
    if (!isRecord(rawGroup)) continue
    const displayName = boundedString(rawGroup.displayName, 128)
    if (!displayName) continue
    const description = boundedString(rawGroup.description, 512)
    const rawBuckets = Array.isArray(rawGroup.buckets) ? rawGroup.buckets : []
    const buckets: QuotaBucketSummary[] = []
    for (const rawBucket of rawBuckets) {
      if (!isRecord(rawBucket)) continue
      const bucketId = boundedString(rawBucket.bucketId, 128) ?? ''
      const bName = boundedString(rawBucket.displayName, 128)
      const remaining = parseFraction(rawBucket.remainingFraction)
      if (!bName || remaining === undefined) continue
      const windowVal = boundedString(rawBucket.window, 32)
      const resetTime = boundedString(rawBucket.resetTime, 64)
      const bDesc = boundedString(rawBucket.description, 512)
      buckets.push({
        bucketId,
        displayName: bName,
        ...(windowVal !== undefined ? { window: windowVal } : {}),
        remainingFraction: remaining,
        ...(resetTime !== undefined ? { resetTime } : {}),
        ...(bDesc !== undefined ? { description: bDesc } : {}),
      })
    }
    groups.push({ displayName, ...(description !== undefined ? { description } : {}), buckets })
  }
  return groups
}

/** Whether one pinned definition matches an enabled live wire id set. */
export function definitionAvailable(definition: ModelDefinition, live: ReadonlySet<string>): boolean {
  const wireNames = definitionWireNames(definition)
  for (const liveId of live) {
    if (liveId.endsWith('-disabled')) continue
    if (wireNames.has(liveId)) return true
    if (canonicalModelId(liveId) === definition.id) return true
    for (const name of wireNames) {
      if (KNOWN_TIER_SUFFIXES.some((tier) => liveId === `${name}-${tier}`)) return true
    }
  }
  return false
}

function entryMatchesDefinition(entry: LiveModelEntry, definition: ModelDefinition): boolean {
  const wireNames = definitionWireNames(definition)
  const baseId = entry.disabled && entry.id.endsWith('-disabled') ? entry.id.slice(0, -'-disabled'.length) : entry.id
  if (wireNames.has(baseId)) return true
  if ((entry.disabled ? canonicalDisabledModelId(entry.id) : canonicalModelId(entry.id)) === definition.id) return true
  for (const name of wireNames) {
    if (KNOWN_TIER_SUFFIXES.some((tier) => baseId === `${name}-${tier}`)) return true
  }
  return false
}

function accountCacheKey(info: { projectId?: string; email?: string } | undefined): string {
  if (info?.projectId) return `proj:${info.projectId}`
  if (info?.email) return `email:${createHash('sha256').update(info.email).digest('hex').slice(0, 16)}`
  return 'default'
}

function defaultMaxOutput(definition: ModelDefinition): number {
  return definition.routes['']?.maxOutputTokens ?? definition.routes[Object.keys(definition.routes)[0]!]!.maxOutputTokens
}

function buildReportFromParsed(
  parsed: ParsedLiveCatalog,
  checkedAt: string,
  tier: AccountTierInfo | undefined,
  quotaGroups: QuotaGroupSummary[],
): { definitions: ModelDefinition[]; report: CatalogAvailabilityReport } {
  const available: AvailableModelDetail[] = []
  const unavailable: UnavailableModelDetail[] = []
  const enabledDefinitions: ModelDefinition[] = []

  // Sort pinned definitions by upstream agentOrder when available so the
  // picker and settings list reflect upstream recommendations first.
  const orderIndex = new Map<string, number>()
  parsed.agentOrder.forEach((id, idx) => {
    const canonical = canonicalDisabledModelId(id) ?? canonicalModelId(id)
    if (canonical && !orderIndex.has(canonical)) orderIndex.set(canonical, idx)
  })
  const ordered = [...MODEL_DEFINITIONS].sort((a, b) => {
    const ia = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const ib = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return ia - ib
  })

  for (const definition of ordered) {
    const matched = parsed.entries.filter((entry) => entryMatchesDefinition(entry, definition))
    const enabledEntries = matched.filter((entry) => !entry.disabled)
    if (enabledEntries.length > 0) {
      enabledDefinitions.push(definition)
      const fractions = enabledEntries
        .map((entry) => entry.remainingFraction)
        .filter((value): value is number => value !== undefined)
      const remainingFraction = fractions.length > 0 ? Math.min(...fractions) : undefined
      const first = enabledEntries[0]!
      const resetTime = enabledEntries.map((e) => e.resetTime).find((v) => v !== undefined)
      const tagTitle = enabledEntries.map((e) => e.tagTitle).find((v) => v !== undefined)
      const tagDescription = enabledEntries.map((e) => e.tagDescription).find((v) => v !== undefined)
      available.push({
        id: definition.id,
        name: definition.name,
        efforts: definition.efforts.map((effort) => effort.id),
        contextWindow: first.maxTokens ?? definition.contextWindow,
        maxOutputTokens: first.maxOutputTokens ?? defaultMaxOutput(definition),
        status: remainingFraction === 0 ? 'quota-exhausted' : 'available',
        ...(remainingFraction !== undefined ? { remainingFraction } : {}),
        ...(resetTime !== undefined ? { resetTime } : {}),
        ...(tagTitle !== undefined ? { tagTitle } : {}),
        ...(tagDescription !== undefined ? { tagDescription } : {}),
      })
    } else {
      const disabledEntry = matched.find((entry) => entry.disabled)
      if (disabledEntry) {
        unavailable.push({
          id: definition.id,
          name: definition.name,
          status: 'disabled',
          ...(disabledEntry.tagTitle !== undefined ? { reasonTitle: disabledEntry.tagTitle } : {}),
          ...(disabledEntry.tagDescription !== undefined ? { reasonDetail: disabledEntry.tagDescription } : {}),
        })
      } else {
        unavailable.push({
          id: definition.id,
          name: definition.name,
          status: 'not-offered',
          reasonTitle: 'Not offered',
          reasonDetail: 'Not included in this account\'s live catalog.',
        })
      }
    }
  }

  return {
    definitions: enabledDefinitions,
    report: {
      source: 'live',
      checkedAt,
      ...(tier !== undefined ? { tier } : {}),
      quotaGroups,
      available,
      unavailable,
    },
  }
}

export class ModelCatalog {
  private readonly auth: AuthManager
  private readonly transport: AgyTransport
  private readonly ttlMs: number
  private readonly extraModels: readonly string[]
  private readonly logger: BridgeLogger
  private readonly endpoints: readonly string[]
  private readonly cacheFile?: string
  private readonly onUpdated?: () => void
  private cachedParsed: ParsedLiveCatalog | undefined
  private cachedReport: CatalogAvailabilityReport | undefined
  private cachedQuotaGroups: QuotaGroupSummary[] = []
  private cachedAccountKey: string | undefined
  private cachedFullReport = false
  private expiresAt = 0
  private lastErrorAt = 0
  private lastAdvertised: string | undefined

  constructor(auth: AuthManager, transport: AgyTransport, options: CatalogOptions = {}) {
    this.auth = auth
    this.transport = transport
    this.ttlMs = options.ttlMs ?? 30_000
    this.extraModels = options.extraModels ?? []
    this.logger = options.logger ?? noopLogger
    this.endpoints = options.endpoints ?? ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']
    this.cacheFile = options.cacheFile
    this.onUpdated = options.onUpdated
  }

  /** Forget account-bound availability (logout / account switch). */
  invalidate(): void {
    this.cachedParsed = undefined
    this.cachedReport = undefined
    this.cachedQuotaGroups = []
    this.cachedAccountKey = undefined
    this.cachedFullReport = false
    this.expiresAt = 0
    this.lastErrorAt = 0
    if (this.cacheFile) {
      try {
        if (fs.existsSync(this.cacheFile)) fs.unlinkSync(this.cacheFile)
      } catch {
        // Best effort.
      }
    }
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

    if (!force && this.cachedReport && this.cachedFullReport && this.cachedAccountKey === key && Date.now() < this.expiresAt) {
      return this.cachedReport
    }

    try {
      const { report, definitions } = await this.fetchLiveState(signal, force, true)
      this.notifyIfChanged(this.withExtraModels(definitions))
      return report
    } catch (error) {
      if (isBridgeError(error) && error.code === 'AUTH') throw error
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
      if (isBridgeError(error) && error.code === 'AUTH') throw error
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
  getModelDetail(modelId: string): AvailableModelDetail | UnavailableModelDetail | undefined {
    const report = this.cachedReport ?? this.readDiskCache(this.cachedAccountKey)?.report
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
        return accountCacheKey(status)
      } catch {
        // Fall through.
      }
    }
    return this.cachedAccountKey ?? 'default'
  }

  private async fetchLiveState(
    signal: AbortSignal | undefined,
    force: boolean,
    includeTierAndQuota: boolean,
  ): Promise<{ parsed: ParsedLiveCatalog; definitions: ModelDefinition[]; report: CatalogAvailabilityReport }> {
    const preKey = await this.currentAccountKey()
    if (!force && this.lastErrorAt > 0 && Date.now() - this.lastErrorAt < ERROR_RETRY_COOLDOWN_MS && this.cachedAccountKey === preKey && preKey !== 'unauthenticated') {
      // Avoid hammering an unreachable token/catalog endpoint multiple times in a burst.
      throw new BridgeError('Live model catalog recently failed; using cached snapshot briefly', 'TRANSPORT')
    }

    let credential
    try {
      credential = await this.auth.getCredential(signal)
    } catch (error) {
      if (isBridgeError(error) && (error.code === 'TRANSPORT' || error.code === 'TIMEOUT')) {
        this.lastErrorAt = Date.now()
        this.cachedAccountKey = preKey
      }
      throw error
    }
    if (!credential) throw new BridgeError('Antigravity login is required before model discovery', 'AUTH')
    if (!credential.accessToken) throw new BridgeError('The stored credential has no usable access token', 'INVALID_CREDENTIAL')

    const key = accountCacheKey(credential)
    if (!force && this.cachedParsed && this.cachedReport && this.cachedAccountKey === key && Date.now() < this.expiresAt) {
      if (!includeTierAndQuota || this.cachedFullReport) {
        return {
          parsed: this.cachedParsed,
          definitions: this.definitionsForReport(this.cachedReport),
          report: this.cachedReport,
        }
      }
    }

    let parsed: ParsedLiveCatalog
    try {
      parsed = await this.probeAvailableModels(credential.accessToken, credential.projectId, signal)
      this.lastErrorAt = 0
    } catch (error) {
      this.lastErrorAt = Date.now()
      this.cachedAccountKey = key
      throw error
    }

    let tier: AccountTierInfo | undefined = force ? undefined : this.cachedReport?.tier
    let quotaGroups: QuotaGroupSummary[] = force ? [] : this.cachedQuotaGroups
    if (includeTierAndQuota) {
      const [fetchedTier, fetchedQuota] = await Promise.all([
        typeof this.auth.getAccountTier === 'function'
          ? this.auth.getAccountTier(signal, force).catch(() => undefined)
          : Promise.resolve(undefined),
        this.probeQuotaSummary(credential.accessToken, credential.projectId, signal).catch(() => []),
      ])
      if (fetchedTier !== undefined) tier = fetchedTier
      if (fetchedQuota.length > 0) quotaGroups = fetchedQuota
      this.cachedQuotaGroups = quotaGroups
      this.cachedFullReport = true
    } else if (force) {
      this.cachedFullReport = false
    }

    const checkedAt = new Date().toISOString()
    const { definitions, report } = buildReportFromParsed(parsed, checkedAt, tier, quotaGroups)
    this.cachedParsed = parsed
    this.cachedReport = report
    this.cachedAccountKey = key
    this.expiresAt = Date.now() + this.ttlMs
    this.writeDiskCache(key, definitions, report)
    this.logger.debug('catalog', 'live catalog refreshed', {
      enabled: report.available.length,
      unavailable: report.unavailable.length,
    })
    return { parsed, definitions, report }
  }

  private definitionsForReport(report: CatalogAvailabilityReport): ModelDefinition[] {
    const enabled = new Set(report.available.map((item) => item.id))
    return MODEL_DEFINITIONS.filter((definition) => enabled.has(definition.id))
  }

  private offlineReport(accountKey: string, errorMessage: string): { definitions: ModelDefinition[]; report: CatalogAvailabilityReport } {
    if (this.cachedReport && this.cachedAccountKey === accountKey) {
      return {
        definitions: this.definitionsForReport(this.cachedReport),
        report: { ...this.cachedReport, source: 'cached', error: errorMessage },
      }
    }
    const fromDisk = this.readDiskCache(accountKey)
    if (fromDisk) {
      this.cachedReport = fromDisk.report
      this.cachedAccountKey = accountKey
      const idSet = new Set(fromDisk.availableIds)
      return {
        definitions: MODEL_DEFINITIONS.filter((definition) => idSet.has(definition.id)),
        report: { ...fromDisk.report, source: 'cached', error: errorMessage },
      }
    }
    // No verified snapshot has ever been saved for this account yet.
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
        if (isBridgeError(error) && (error.code === 'ABORTED' || error.code === 'AUTH')) throw error
        this.logger.debug('catalog', 'live catalog endpoint failed', { endpoint, error: String(error).slice(0, 200) })
      }
    }
    throw lastError instanceof Error ? lastError : new BridgeError('Live model catalog unavailable', 'TRANSPORT')
  }

  private async probeQuotaSummary(accessToken: string, projectId: string | undefined, signal?: AbortSignal): Promise<QuotaGroupSummary[]> {
    for (const endpoint of this.endpoints) {
      try {
        const value = await this.postJson(endpoint, PATH_QUOTA, accessToken, projectId ? { project: projectId } : {}, false, signal)
        return parseQuotaSummary(value)
      } catch (error) {
        if (isBridgeError(error) && error.code === 'ABORTED') throw error
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
        throw new BridgeError('Antigravity rejected the credential during model discovery', 'AUTH', { status: response.status })
      }
      throw new BridgeError(`Catalog endpoint failed (${response.status}): ${text.slice(0, 200)}`, 'TRANSPORT', { status: response.status })
    }
    const text = await readBoundedText(response, MAX_CATALOG_BYTES, signal)
    try {
      return JSON.parse(text)
    } catch {
      throw new BridgeError('The Antigravity live model catalog was not JSON', 'PROTOCOL_DRIFT')
    }
  }

  private readDiskCache(accountKey: string | undefined): DiskCatalogCache | undefined {
    if (!this.cacheFile || !accountKey) return undefined
    try {
      if (!fs.existsSync(this.cacheFile)) return undefined
      const value = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as unknown
      if (!isRecord(value) || value.accountKey !== accountKey || !Array.isArray(value.availableIds) || !isRecord(value.report)) {
        return undefined
      }
      return value as unknown as DiskCatalogCache
    } catch {
      return undefined
    }
  }

  private writeDiskCache(accountKey: string, definitions: readonly ModelDefinition[], report: CatalogAvailabilityReport): void {
    if (!this.cacheFile) return
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      const payload: DiskCatalogCache = {
        accountKey,
        checkedAt: report.checkedAt,
        availableIds: definitions.map((definition) => definition.id),
        report,
      }
      const tmp = `${this.cacheFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      fs.renameSync(tmp, this.cacheFile)
    } catch {
      // Cache persistence is best-effort.
    }
  }
}
