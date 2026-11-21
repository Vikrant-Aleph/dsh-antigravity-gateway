/**
 * Pinned model catalog and wire-route resolution.
 *
 * Design decision: this plugin does NOT retire models on the client side.
 * The server returns a per-account catalog (`fetchAvailableModels`); the
 * bridge advertises the intersection of that live catalog with the pinned
 * definitions below, and falls back to the full pinned snapshot when the
 * live read fails. Requests for any pinned model are always attempted —
 * DSH treats catalog membership as advisory, and availability is whatever
 * the account's own backend answers.
 *
 * Wire enums and limits are dated observations of agy CLI captures; sources
 * are listed in TECHNICAL.md §3.
 */
import { BridgeError } from './errors.js'

export type ModelFamily = 'claude' | 'gemini' | 'gpt'

/** One effort tier's wire configuration. */
export type ThinkingSpec =
  | { kind: 'claude-budget'; budget: number }
  | { kind: 'claude-adaptive'; level: 'LOW' | 'MEDIUM' | 'HIGH' }
  | { kind: 'gemini-level'; level: 'LOW' | 'MEDIUM' | 'HIGH' | 100 }
  | { kind: 'gemini-budget'; budget: number }
  | { kind: 'none' }

export interface WireRoute {
  /** Top-level `model` value sent to the endpoint. */
  wire: string
  /** `labels.model_enum` value sent alongside the request. */
  modelEnum: string
  /** Output cap applied when the caller omits maxTokens. */
  maxOutputTokens: number
  thinking: ThinkingSpec
}

export interface EffortInfo {
  id: string
  name: string
}

export interface ModelDefinition {
  /** Public model id shown in the DSH selector. */
  id: string
  name: string
  family: ModelFamily
  contextWindow: number
  /** Effort id → wire route. The empty-string key is the no-effort default. */
  routes: Record<string, WireRoute>
  efforts: readonly EffortInfo[]
  defaultEffort?: string
  description?: string
}

const CLAUDE_46_LIMITS = { contextWindow: 200_000, maxOutput: 64_000 }
const CLAUDE_55_LIMITS = { contextWindow: 1_000_000, maxOutput: 128_000 }

/** Claude thinking budgets per tier (agy CLI family mapping). */
export const CLAUDE_TIER_BUDGETS = { low: 8192, medium: 16_384, high: 32_768 } as const

/**
 * Claude thinking models need maxOutputTokens above the thinking budget.
 * Scales with the budget, floored at 32K and capped at 64K (CLI behavior).
 */
export function claudeMaxOutputForBudget(budget: number | undefined): number {
  if (typeof budget !== 'number' || budget <= 0) return CLAUDE_46_LIMITS.maxOutput
  return Math.min(Math.max(budget * 2, 32_000), CLAUDE_46_LIMITS.maxOutput)
}

function claude46Routes(wire: string, modelEnum: string): Record<string, WireRoute> {
  return {
    '': { wire, modelEnum, maxOutputTokens: CLAUDE_46_LIMITS.maxOutput, thinking: { kind: 'claude-budget', budget: 0 } },
    low: { wire, modelEnum, maxOutputTokens: claudeMaxOutputForBudget(CLAUDE_TIER_BUDGETS.low), thinking: { kind: 'claude-budget', budget: CLAUDE_TIER_BUDGETS.low } },
    medium: { wire, modelEnum, maxOutputTokens: claudeMaxOutputForBudget(CLAUDE_TIER_BUDGETS.medium), thinking: { kind: 'claude-budget', budget: CLAUDE_TIER_BUDGETS.medium } },
    high: { wire, modelEnum, maxOutputTokens: claudeMaxOutputForBudget(CLAUDE_TIER_BUDGETS.high), thinking: { kind: 'claude-budget', budget: CLAUDE_TIER_BUDGETS.high } },
  }
}

function claude55Routes(base: string, enums: [string, string, string]): Record<string, WireRoute> {
  const tiers = ['low', 'medium', 'high'] as const
  const levels = ['LOW', 'MEDIUM', 'HIGH'] as const
  const routes: Record<string, WireRoute> = {
    '': { wire: `${base}-medium`, modelEnum: enums[1], maxOutputTokens: CLAUDE_55_LIMITS.maxOutput, thinking: { kind: 'claude-adaptive', level: 'MEDIUM' } },
  }
  tiers.forEach((tier, index) => {
    routes[tier] = {
      wire: `${base}-${tier}`,
      modelEnum: enums[index]!,
      maxOutputTokens: CLAUDE_55_LIMITS.maxOutput,
      thinking: { kind: 'claude-adaptive', level: levels[index]! },
    }
  })
  return routes
}

const CLAUDE_EFFORTS: readonly EffortInfo[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

function gemini4Routes(
  base: string,
  enums: Record<string, string>,
  tiers: readonly string[],
  maxOutputTokens: number,
): Record<string, WireRoute> {
  const routes: Record<string, WireRoute> = {}
  for (const tier of tiers) {
    routes[tier] = {
      wire: `${base}-${tier}`,
      modelEnum: enums[tier]!,
      maxOutputTokens,
      thinking: { kind: 'gemini-level', level: tier === 'xhigh' ? 100 : (tier.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH') },
    }
  }
  const defaultTier = tiers.includes('high') ? 'high' : 'medium'
  routes[''] = routes[defaultTier]!
  return routes
}

/**
 * The pinned catalog. Ids match the wire names the CLI uses, so `agy models`
 * output can be pasted straight into a DSH model selection.
 */
export const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    id: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6 (Thinking)',
    family: 'claude',
    contextWindow: CLAUDE_46_LIMITS.contextWindow,
    routes: claude46Routes('claude-opus-4-6-thinking', 'MODEL_PLACEHOLDER_M26'),
    efforts: CLAUDE_EFFORTS,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    family: 'claude',
    contextWindow: CLAUDE_46_LIMITS.contextWindow,
    routes: claude46Routes('claude-sonnet-4-6', 'MODEL_PLACEHOLDER_M35'),
    efforts: CLAUDE_EFFORTS,
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5 (Thinking)',
    family: 'claude',
    contextWindow: CLAUDE_55_LIMITS.contextWindow,
    routes: claude55Routes('claude-opus-5-5', ['MODEL_PLACEHOLDER_M400', 'MODEL_PLACEHOLDER_M401', 'MODEL_PLACEHOLDER_M402']),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5 (Thinking)',
    family: 'claude',
    contextWindow: CLAUDE_55_LIMITS.contextWindow,
    routes: claude55Routes('claude-sonnet-5-5', ['MODEL_PLACEHOLDER_M403', 'MODEL_PLACEHOLDER_M404', 'MODEL_PLACEHOLDER_M405']),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    family: 'gemini',
    contextWindow: 1_048_576,
    routes: {
      '': { wire: 'gemini-3.8-flash-medium', modelEnum: 'MODEL_PLACEHOLDER_M319', maxOutputTokens: 65_536, thinking: { kind: 'gemini-budget', budget: 4000 } },
      low: { wire: 'gemini-3.8-flash-low', modelEnum: 'MODEL_PLACEHOLDER_M320', maxOutputTokens: 65_536, thinking: { kind: 'gemini-budget', budget: 1000 } },
      medium: { wire: 'gemini-3.8-flash-medium', modelEnum: 'MODEL_PLACEHOLDER_M319', maxOutputTokens: 65_536, thinking: { kind: 'gemini-budget', budget: 4000 } },
      high: { wire: 'gemini-3.8-flash-high', modelEnum: 'MODEL_PLACEHOLDER_M318', maxOutputTokens: 65_536, thinking: { kind: 'gemini-budget', budget: -1 } },
    },
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-4-neon',
    name: 'Gemini 4 Neon',
    family: 'gemini',
    contextWindow: 1_048_576,
    routes: gemini4Routes('gemini-4-neon', { low: 'MODEL_PLACEHOLDER_M534', medium: 'MODEL_PLACEHOLDER_M533', high: 'MODEL_PLACEHOLDER_M532', xhigh: 'MODEL_PLACEHOLDER_M535' }, ['low', 'medium', 'high', 'xhigh'], 262_144),
    efforts: [...CLAUDE_EFFORTS, { id: 'xhigh', name: 'XHigh' }],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    family: 'gemini',
    contextWindow: 1_048_576,
    routes: gemini4Routes('gemini-4-hydrogen', { low: 'MODEL_PLACEHOLDER_M527', medium: 'MODEL_PLACEHOLDER_M526', high: 'MODEL_PLACEHOLDER_M525', xhigh: 'MODEL_PLACEHOLDER_M528' }, ['low', 'medium', 'high', 'xhigh'], 262_144),
    efforts: [...CLAUDE_EFFORTS, { id: 'xhigh', name: 'XHigh' }],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    family: 'gemini',
    contextWindow: 1_048_576,
    routes: gemini4Routes('gemini-4-carbon', { low: 'MODEL_PLACEHOLDER_M438', medium: 'MODEL_PLACEHOLDER_M437', high: 'MODEL_PLACEHOLDER_M427' }, ['low', 'medium', 'high'], 262_144),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    family: 'gemini',
    contextWindow: 1_048_576,
    routes: gemini4Routes('gemini-4-argon', { low: 'MODEL_PLACEHOLDER_M419', medium: 'MODEL_PLACEHOLDER_M418', high: 'MODEL_PLACEHOLDER_M417' }, ['low', 'medium', 'high'], 65_536),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B (Medium)',
    family: 'gpt',
    contextWindow: 131_072,
    routes: {
      '': { wire: 'gpt-oss-120b-medium', modelEnum: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', maxOutputTokens: 32_768, thinking: { kind: 'gemini-budget', budget: 8192 } },
    },
    efforts: [],
  },
]

const DEFINITION_BY_ID = new Map(MODEL_DEFINITIONS.map((definition) => [definition.id, definition]))

/**
 * Historical and prefixed aliases accepted on input. These normalize to a
 * pinned id; none of them authorizes a route the catalog does not define.
 */
const ID_ALIASES: Record<string, string> = {
  'claude-opus-4-6': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking-low': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking-medium': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking-high': 'claude-opus-4-6-thinking',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-low': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-medium': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-high': 'claude-sonnet-4-6',
  'claude-opus-4-6-low': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-medium': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-high': 'claude-opus-4-6-thinking',
  'claude-sonnet-4-6-low': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-medium': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-high': 'claude-sonnet-4-6',
  'gpt-oss-120b': 'gpt-oss-120b-medium',
}

/** Tier suffixes that select an effort instead of naming a different model. */
export const KNOWN_TIER_SUFFIXES = ['low', 'medium', 'high', 'xhigh'] as const
const TIER_SUFFIX = /-(low|medium|high|xhigh)$/

export interface ResolvedRoute {
  definition: ModelDefinition
  route: WireRoute
  /** Normalized public model id (alias resolved). */
  modelId: string
  /** Effort actually applied, when the caller or the default selected one. */
  effort?: string
}

/** Strip quota prefixes and historical wire prefixes from a requested id. */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase()
  id = id.replace(/^antigravity-/, '')
  id = id.replace(/^gemini-(?=claude-)/, '')
  id = id.replace(/^(?:publishers\/[^/]+\/)?models\//, '')
  return id
}

/**
 * Resolve one requested model id plus optional reasoning effort to a wire
 * route. Throws `BridgeError` for unknown models or unsupported efforts.
 */
export function resolveRoute(model: string, reasoningEffort?: string): ResolvedRoute {
  if (typeof model !== 'string' || model.trim().length === 0 || model.length > 256) {
    throw new BridgeError('The Antigravity model id is invalid', 'INVALID_MODEL')
  }
  let id = normalizeModelId(model)
  let suffixEffort: string | undefined
  const tierMatch = TIER_SUFFIX.exec(id)
  // Tier suffixes are effort selectors only for families that publish tiers;
  // gpt-oss-120b-medium keeps its suffix as part of the name.
  if (tierMatch && !id.startsWith('gpt-')) {
    const base = id.slice(0, tierMatch.index)
    const baseKnown = DEFINITION_BY_ID.has(base) || DEFINITION_BY_ID.has(ID_ALIASES[base] ?? base)
    if (baseKnown) {
      suffixEffort = tierMatch[1]
      id = base
    }
  }
  id = ID_ALIASES[id] ?? id
  const definition = DEFINITION_BY_ID.get(id)
  if (definition === undefined) {
    throw new BridgeError(`Unknown Antigravity model "${model}"`, 'UNKNOWN_MODEL')
  }
  const requested = reasoningEffort?.trim().toLowerCase() || suffixEffort
  if (requested !== undefined && requested !== '') {
    const route = definition.routes[requested]
    if (route === undefined) {
      throw new BridgeError(
        `Model "${definition.id}" does not support reasoning effort "${requested}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return { definition, route, modelId: id, effort: requested }
  }
  const defaultEffort = definition.defaultEffort
  if (defaultEffort !== undefined) {
    return { definition, route: definition.routes[defaultEffort]!, modelId: id, effort: defaultEffort }
  }
  return { definition, route: definition.routes['']!, modelId: id }
}

/** Whether the resolved route belongs to a Claude thinking model. */
export function isClaudeThinkingRoute(resolved: ResolvedRoute): boolean {
  return resolved.definition.family === 'claude'
}

export function getDefinition(id: string): ModelDefinition | undefined {
  return DEFINITION_BY_ID.get(normalizeModelId(id))
}

/**
 * Canonical pinned id for any live-catalog or user-supplied name, when one
 * exists: normalize prefixes, strip a known tier suffix, apply aliases.
 */
export function canonicalModelId(id: string): string | undefined {
  let normalized = normalizeModelId(id)
  const tierMatch = TIER_SUFFIX.exec(normalized)
  if (tierMatch && !normalized.startsWith('gpt-')) {
    const base = normalized.slice(0, tierMatch.index)
    const canonicalBase = ID_ALIASES[base] ?? base
    if (DEFINITION_BY_ID.has(canonicalBase)) return canonicalBase
  }
  normalized = ID_ALIASES[normalized] ?? normalized
  return DEFINITION_BY_ID.has(normalized) ? normalized : undefined
}

/** Map a `*-disabled` upstream id back to the pinned model it represents. */
export function canonicalDisabledModelId(id: string): string | undefined {
  const normalized = normalizeModelId(id)
  if (!normalized.endsWith('-disabled')) return canonicalModelId(normalized)
  return canonicalModelId(normalized.slice(0, -'-disabled'.length))
}

/** Every wire name a definition can send (used for live-catalog matching). */
export function definitionWireNames(definition: ModelDefinition): Set<string> {
  const names = new Set<string>()
  for (const route of Object.values(definition.routes)) names.add(route.wire)
  names.add(definition.id)
  return names
}
