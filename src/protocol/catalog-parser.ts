/**
 * Pure parsers for Antigravity live model catalog, quota summary, account
 * tier metadata, and availability reports. Zero network/FS/host imports.
 */
import { createHash } from 'node:crypto'
import { GatewayError } from '../shared/errors.js'
import { boundedString, isRecord, parseFraction, parsePositiveInt } from '../shared/guards.js'
import {
  KNOWN_TIER_SUFFIXES,
  MODEL_DEFINITIONS,
  canonicalDisabledModelId,
  canonicalModelId,
  definitionWireNames,
  getDefinition,
  normalizeModelId,
  type ModelDefinition,
  type ModelFamily,
} from './models.js'
import type { ModelQuotaSnapshot } from '../shared/rpc-contracts.js'

const MAX_CATALOG_ENTRIES = 512

export interface TierSummary {
  id: string
  name?: string
}

export interface AccountTierInfo {
  current?: TierSummary
  paid?: TierSummary
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

function cleanLiveId(value: string): string {
  return normalizeModelId(value)
}

/**
 * Parse `fetchAvailableModels` into enabled wire ids, disabled entries,
 * quota info, and upstream tags. Throws `PROTOCOL_DRIFT` on invalid shapes.
 */
export function parseLiveCatalog(value: unknown): ParsedLiveCatalog {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value
  if (!isRecord(root)) {
    throw new GatewayError('The Antigravity live model catalog was not an object', 'PROTOCOL_DRIFT')
  }
  const models = root.models
  if (!isRecord(models)) {
    throw new GatewayError('The Antigravity live model catalog had no models map', 'PROTOCOL_DRIFT')
  }
  const rawEntries = Object.entries(models)
  if (rawEntries.length > MAX_CATALOG_ENTRIES) {
    throw new GatewayError('The Antigravity live model catalog exceeded the model limit', 'PROTOCOL_DRIFT')
  }

  const enabledIds = new Set<string>()
  const entries: LiveModelEntry[] = []

  for (const [rawId, rawEntry] of rawEntries) {
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 256) {
      throw new GatewayError('The Antigravity live model catalog carried an invalid id', 'PROTOCOL_DRIFT')
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

export function entryMatchesDefinition(entry: LiveModelEntry, definition: ModelDefinition): boolean {
  const wireNames = definitionWireNames(definition)
  const baseId = entry.disabled && entry.id.endsWith('-disabled') ? entry.id.slice(0, -'-disabled'.length) : entry.id
  if (wireNames.has(baseId)) return true
  if ((entry.disabled ? canonicalDisabledModelId(entry.id) : canonicalModelId(entry.id)) === definition.id) return true
  for (const name of wireNames) {
    if (KNOWN_TIER_SUFFIXES.some((tier) => baseId === `${name}-${tier}`)) return true
  }
  return false
}

export function accountCacheKey(info: { id?: string; projectId?: string; email?: string } | undefined): string {
  if (info?.email) return `email:${createHash('sha256').update(info.email.trim().toLowerCase()).digest('hex').slice(0, 16)}`
  if (info?.id) return `acct:${info.id}`
  if (info?.projectId) return `proj:${info.projectId}`
  return 'default'
}

function inferModelFamily(modelId: string): ModelFamily | undefined {
  const canonical = canonicalModelId(modelId)
  if (canonical) return getDefinition(canonical)?.family
  const lower = normalizeModelId(modelId)
  if (lower.startsWith('claude-')) return 'claude'
  if (lower.startsWith('gemini-')) return 'gemini'
  if (lower.startsWith('gpt-')) return 'gpt'
  return undefined
}

function isFiveHourBucket(windowVal: string | undefined, displayName: string, bucketId: string): boolean {
  if (windowVal && /^5\s*h$/i.test(windowVal.trim())) return true
  return /\b5\s*h\b|five\s*hour/i.test(`${displayName} ${bucketId}`)
}

function groupMatchesFamily(groupName: string, bucketId: string, family: ModelFamily): boolean {
  const haystack = `${groupName} ${bucketId}`.toLowerCase()
  if (family === 'claude') return haystack.includes('claude')
  if (family === 'gemini') return haystack.includes('gemini')
  return haystack.includes('gpt') || haystack.includes('openai')
}

/**
 * Select the compact 5-hour quota (or per-model quota fallback) for one model
 * from a catalog availability report. Pure helper shared by backend & tests.
 */
export function selectQuotaForModel(
  report: Pick<CatalogAvailabilityReport, 'quotaGroups' | 'available'>,
  modelId: string,
): ModelQuotaSnapshot | undefined {
  const canonical = canonicalModelId(modelId) ?? normalizeModelId(modelId)
  const family = inferModelFamily(modelId)
  const modelDetail = report.available.find((item) => item.id === canonical)

  let matchedBucket: QuotaBucketSummary | undefined
  if (family !== undefined) {
    for (const group of report.quotaGroups) {
      for (const bucket of group.buckets) {
        if (!isFiveHourBucket(bucket.window, bucket.displayName, bucket.bucketId)) continue
        if (groupMatchesFamily(group.displayName, bucket.bucketId, family)) {
          matchedBucket = bucket
          break
        }
      }
      if (matchedBucket) break
    }
  }
  if (!matchedBucket) {
    const fiveHourBuckets = report.quotaGroups.flatMap((group) =>
      group.buckets.filter((b) => isFiveHourBucket(b.window, b.displayName, b.bucketId)),
    )
    if (fiveHourBuckets.length === 1) {
      matchedBucket = fiveHourBuckets[0]
    }
  }

  if (matchedBucket) {
    const remaining =
      modelDetail?.remainingFraction !== undefined
        ? Math.min(matchedBucket.remainingFraction, modelDetail.remainingFraction)
        : matchedBucket.remainingFraction
    const resetTime = matchedBucket.resetTime ?? modelDetail?.resetTime
    return {
      window: '5h',
      remainingFraction: remaining,
      ...(resetTime !== undefined ? { resetTime } : {}),
      label: matchedBucket.displayName,
    }
  }

  if (modelDetail?.remainingFraction !== undefined) {
    return {
      window: 'model',
      remainingFraction: modelDetail.remainingFraction,
      ...(modelDetail.resetTime !== undefined ? { resetTime: modelDetail.resetTime } : {}),
      label: modelDetail.name,
    }
  }
  return undefined
}

export function defaultMaxOutput(definition: ModelDefinition): number {
  return definition.routes['']?.maxOutputTokens ?? definition.routes[Object.keys(definition.routes)[0]!]!.maxOutputTokens
}

export function buildReportFromParsed(
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

function parseTierSummary(value: unknown): TierSummary | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || value.id.length === 0) return undefined
  return {
    id: value.id,
    ...(typeof value.name === 'string' && value.name.length > 0 ? { name: value.name } : {}),
  }
}

export function parseAccountTier(record: Record<string, unknown>): AccountTierInfo | undefined {
  const current = parseTierSummary(record.currentTier)
  const paid = parseTierSummary(record.paidTier)
  if (current === undefined && paid === undefined) return undefined
  return {
    ...(current !== undefined ? { current } : {}),
    ...(paid !== undefined ? { paid } : {}),
  }
}

export function extractProjectId(record: Record<string, unknown>): string {
  const project = record.cloudaicompanionProject
  if (typeof project === 'string' && project.length > 0) return project
  if (isRecord(project) && typeof project.id === 'string' && project.id.length > 0) return project.id
  return ''
}
