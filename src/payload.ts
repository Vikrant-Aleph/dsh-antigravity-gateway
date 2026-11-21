/**
 * DSH request → Antigravity Cloud Code wire payload.
 *
 * Pure module (no DSH imports): the adapter passes structural message values
 * and an image resolver. The envelope, field order, labels, and Claude
 * transforms reproduce the agy CLI client shape documented in TECHNICAL.md §4.
 */
import {
  CLAUDE_INTERLEAVED_THINKING_HINT,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  SKIP_THOUGHT_SIGNATURE,
} from './constants.js'
import { BridgeError } from './errors.js'
import { claudeMaxOutputForBudget, isClaudeThinkingRoute, resolveRoute, type ResolvedRoute } from './models.js'

// -- structural input types (match @deepseek-ai/dsh-llm shapes) --------------

export interface PayloadBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  attachment?: unknown
  offloaded?: boolean
  [key: string]: unknown
}

export interface PayloadMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  content: readonly PayloadBlock[]
  toolCallId?: string
  isError?: boolean
  source?: { kind?: string; provider?: string; model?: string; replayState?: unknown }
}

export interface PayloadTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface PayloadRequest {
  provider: string
  model: string
  reasoningEffort?: string
  messages: readonly PayloadMessage[]
  system?: string
  tools?: readonly PayloadTool[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  sessionId?: string
}

/** Resolves one durable image attachment to base64 bytes, or undefined. */
export type ImageResolver = (attachment: unknown) => Promise<{ data: string; mimeType: string } | undefined>

export interface ReplayBlockState {
  kind: 'text' | 'reasoning' | 'tool-call'
  signature?: string
}

// -- session metadata (FNV-1a + trajectory labels) ---------------------------

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV1A_64_PRIME = 0x100000001b3n

/** Signed 64-bit FNV-1a of the UTF-8 input, as a decimal string. */
export function fnv1a64Signed(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME)
  }
  return BigInt.asIntN(64, hash).toString()
}

export interface RequestSession {
  conversationId: string
  trajectoryId: string
  numericSessionId: string
  requestCount?: number
  lastMetadataTimestamp?: number
  lastExecutionId?: string
  usedClaude?: boolean
  usedNonGeminiModel?: boolean
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const MAX_SESSIONS = 256

/** Per-DSH-session wire identity, mirroring the CLI's cascade/trajectory ids. */
export class RequestSessionStore {
  private entries = new Map<string, { session: RequestSession; lastAccessedAt: number; lastRequestTimestamp: number }>()

  getOrCreate(key: string, mintId: () => string = randomId): RequestSession {
    const now = Date.now()
    this.prune(now, key)
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastAccessedAt = now
      return existing.session
    }
    const session: RequestSession = {
      conversationId: mintId(),
      trajectoryId: mintId(),
      // Print-mode agy uses the empty-string offset basis in every workspace.
      numericSessionId: fnv1a64Signed(''),
    }
    this.entries.set(key, { session, lastAccessedAt: now, lastRequestTimestamp: 0 })
    return session
  }

  beginRequest(key: string, mintId: () => string = randomId): { session: RequestSession; timestamp: number } {
    const session = this.getOrCreate(key, mintId)
    const stored = this.entries.get(key)!
    const timestamp = Math.max(stored.lastAccessedAt, stored.lastRequestTimestamp + 1)
    stored.lastRequestTimestamp = timestamp
    return { session, timestamp }
  }

  get size(): number {
    return this.entries.size
  }

  private prune(now: number, preservedKey: string): void {
    const expiry = now - SESSION_TTL_MS
    for (const [key, value] of this.entries) {
      if (key !== preservedKey && value.lastAccessedAt < expiry) this.entries.delete(key)
    }
    while (this.entries.size >= MAX_SESSIONS && !this.entries.has(preservedKey)) {
      let oldestKey: string | undefined
      let oldestAccess = Number.POSITIVE_INFINITY
      for (const [key, value] of this.entries) {
        if (key !== preservedKey && value.lastAccessedAt < oldestAccess) {
          oldestAccess = value.lastAccessedAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }
}

function randomId(): string {
  return crypto.randomUUID()
}

/** Stable per-session key from the DSH session id. */
export function requestSessionKey(sessionId: string | undefined): string {
  return sessionId === undefined ? 'default' : `session:${fnv1a64Signed(String(sessionId))}`
}

const AGY_REQUEST_FIELD_ORDER = ['contents', 'systemInstruction', 'tools', 'labels', 'generationConfig', 'sessionId'] as const

function orderRequestPayloadInPlace(payload: Record<string, unknown>): void {
  const ordered: Record<string, unknown> = {}
  const remaining = new Set(Object.keys(payload))
  for (const key of AGY_REQUEST_FIELD_ORDER) {
    if (key in payload) {
      ordered[key] = payload[key]
      remaining.delete(key)
    }
  }
  for (const key of remaining) ordered[key] = payload[key]
  for (const key of Object.keys(payload)) delete payload[key]
  Object.assign(payload, ordered)
}

function countSteps(contents: readonly unknown[]): number {
  return contents.length
}

/** Claude tool responses are user-role contents but do not start a new turn. */
function hasSecondUserTurn(contents: readonly GeminiContent[]): boolean {
  let sawUser = false
  let sawModelAfterUser = false
  for (const content of contents) {
    if (content.role === 'model' && sawUser) sawModelAfterUser = true
    if (content.role !== 'user' || !Array.isArray(content.parts)) continue
    const isPrompt = content.parts.some(
      (part) =>
        part !== null &&
        typeof part === 'object' &&
        !('functionResponse' in part) &&
        (!('text' in part) || (part as { text?: string }).text !== '[Continue]'),
    )
    if (!isPrompt) continue
    if (sawModelAfterUser) return true
    sawUser = true
  }
  return false
}

export interface RequestMetadata {
  requestId: string
  sessionId: string
  labels: Record<string, string>
}

/** Build the CLI's agent request metadata (labels + requestId). */
export function buildRequestMetadata(
  session: RequestSession,
  contents: readonly GeminiContent[],
  wireModel: string,
  timestamp?: number,
  mintId: () => string = randomId,
): RequestMetadata {
  const requestTimestamp = timestamp ?? Math.max(Date.now(), (session.lastMetadataTimestamp ?? 0) + 1)
  const stepCount = countSteps(contents)
  if (session.lastMetadataTimestamp !== requestTimestamp) {
    session.requestCount = (session.requestCount ?? 0) + 1
    session.lastMetadataTimestamp = requestTimestamp
    if (session.lastExecutionId || hasSecondUserTurn(contents)) {
      session.lastExecutionId = mintId()
    }
  }
  const lower = wireModel.toLowerCase()
  const isClaude = lower.startsWith('claude-')
  const isNonGemini = isClaude || lower.startsWith('gpt-')
  session.usedClaude = session.usedClaude === true || isClaude
  session.usedNonGeminiModel = session.usedNonGeminiModel === true || isNonGemini
  const resolved = safeResolve(wireModel)
  const labels: Record<string, string> = {
    cascade_id: session.conversationId,
    ...(session.lastExecutionId ? { last_execution_id: session.lastExecutionId } : {}),
    last_step_index: String(stepCount - 1),
    ...(resolved ? { model_enum: resolved.route.modelEnum } : {}),
    request_id: `${session.trajectoryId}-${(session.requestCount ?? 1) - 1}`,
    root_cascade_id: session.conversationId,
    trajectory_id: session.trajectoryId,
    used_claude: session.usedClaude ? 'true' : 'false',
    used_claude_conservative: session.usedClaude ? 'true' : 'false',
    used_non_gemini_model: session.usedNonGeminiModel ? 'true' : 'false',
  }
  return {
    requestId: `agent/${session.conversationId}/${requestTimestamp}/${session.trajectoryId}/${stepCount}`,
    sessionId: session.numericSessionId,
    labels,
  }
}

function safeResolve(wireModel: string): ResolvedRoute | undefined {
  try {
    return resolveRoute(wireModel)
  } catch {
    return undefined
  }
}

// -- Gemini content shapes ----------------------------------------------------

export type GeminiPart = Record<string, unknown>

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: GeminiPart[] }
  tools?: GeminiPart[]
  toolConfig?: { functionCallingConfig: { mode: string } }
  labels?: Record<string, string>
  generationConfig?: Record<string, unknown>
  sessionId?: string
}

export interface AntigravityEnvelope {
  project?: string
  requestId: string
  request: GeminiRequest
  model: string
  userAgent: 'antigravity'
  requestType: 'agent'
}

// -- message mapping ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function replayBlocksOf(message: PayloadMessage, provider: string): readonly ReplayBlockState[] {
  const source = message.source
  if (!source || source.provider !== provider || !isRecord(source.replayState)) return []
  const blocks = source.replayState.blocks
  if (!Array.isArray(blocks)) return []
  return blocks.filter(isRecord).map((block) => ({
    kind: block.kind === 'reasoning' || block.kind === 'tool-call' ? block.kind : 'text',
    ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
  }))
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/** Map one assistant message back to model-role parts, replaying signatures. */
function mapAssistantMessage(message: PayloadMessage, provider: string, isClaude: boolean): GeminiPart[] {
  const replay = replayBlocksOf(message, provider)
  const messageReasoningSignature = replay.find((block) => block.kind === 'reasoning' && block.signature !== undefined)?.signature
  const parts: GeminiPart[] = []
  let replayIndex = 0
  let sawClaudeFunctionCall = false
  for (const block of message.content) {
    if (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'tool-call') continue
    const replayBlock = replay[replayIndex]
    const blockSignature = replayBlock !== undefined && replayBlock.kind === block.type ? replayBlock.signature : undefined
    replayIndex += 1
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : ''
      if (text.length === 0 && blockSignature === undefined) continue
      parts.push({ text, ...(blockSignature !== undefined ? { thoughtSignature: blockSignature } : {}) })
    } else if (block.type === 'reasoning') {
      const text = typeof block.text === 'string' ? block.text : ''
      const signature = blockSignature ?? SKIP_THOUGHT_SIGNATURE
      if (text.length === 0 && blockSignature === undefined) continue
      parts.push({ thought: true, ...(text.length > 0 ? { text } : {}), thoughtSignature: signature })
    } else {
      const name = typeof block.name === 'string' ? block.name : ''
      if (name.length === 0) continue
      const signature = isClaude
        ? sawClaudeFunctionCall
          ? undefined
          : blockSignature ?? SKIP_THOUGHT_SIGNATURE
        : blockSignature ?? messageReasoningSignature ?? SKIP_THOUGHT_SIGNATURE
      if (isClaude) sawClaudeFunctionCall = true
      parts.push({
        functionCall: { name, args: parseToolArguments(block.arguments) },
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      })
    }
  }
  return parts
}

/** Map one user message to user-role parts (text + inline images). */
async function mapUserMessage(message: PayloadMessage, resolveImage: ImageResolver | undefined): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : ''
      if (text.length > 0) parts.push({ text })
    } else if (block.type === 'image') {
      if (block.offloaded === true) {
        parts.push({ text: '[image offloaded from context]' })
        continue
      }
      const resolved = resolveImage ? await resolveImage(block.attachment).catch(() => undefined) : undefined
      if (resolved) {
        parts.push({ inlineData: { mimeType: resolved.mimeType, data: resolved.data } })
      } else {
        parts.push({ text: '[image unavailable to this route]' })
      }
    }
    // File blocks are projected to handle text by DSH before dispatch.
  }
  return parts
}

/** Map one tool-result message to a functionResponse part. */
function mapToolMessage(message: PayloadMessage, toolNames: Map<string, string>): GeminiPart {
  const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
  const name = toolNames.get(callId) ?? sanitizeToolName(callId || 'tool')
  const text = message.content
    .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
  const response = message.isError === true ? { error: text || 'tool failed' } : { result: text }
  return { functionResponse: { name, response } }
}

/** Merge consecutive all-functionResponse user contents (Claude requirement). */
export function groupClaudeFunctionResponses(contents: readonly GeminiContent[]): GeminiContent[] {
  const grouped: GeminiContent[] = []
  let pending: GeminiPart[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    grouped.push({ role: 'user', parts: pending })
    pending = []
  }
  for (const content of contents) {
    const parts = content.parts
    const allResponses = parts.length > 0 && parts.every((part) => isRecord(part) && isRecord(part.functionResponse))
    if (content.role === 'user' && allResponses) {
      pending.push(...parts)
      continue
    }
    flush()
    grouped.push(content)
  }
  flush()
  return grouped
}

// -- tools ---------------------------------------------------------------------

export function sanitizeToolName(name: string): string {
  const cleaned = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned.length > 0 ? cleaned : 'tool'
}

function parameterSignature(parameters: Record<string, unknown>): string {
  const properties = isRecord(parameters.properties) ? parameters.properties : {}
  const entries = Object.entries(properties).map(([name, schema]) => {
    const type = isRecord(schema) && typeof schema.type === 'string' ? schema.type : 'any'
    return `${name}: ${type}`
  })
  return entries.join(', ')
}

/**
 * Schema keywords the endpoint's Schema proto accepts. Anything else is
 * dropped: the proto JSON parser rejects unknown fields with
 * `Invalid JSON payload received. Unknown name …` (HTTP 400), so JSON Schema
 * vocabulary beyond this subset must never reach the wire.
 */
const SCHEMA_KEEP = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'oneOf', 'anyOf', 'minItems', 'maxItems', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'additionalProperties', 'propertyOrdering',
])

/**
 * Recursively project one JSON Schema onto the endpoint's subset.
 * `const` becomes a single-value `enum` (same semantics, accepted keyword);
 * metadata and unsupported structural keywords are dropped.
 */
export function sanitizeToolSchema(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (key === 'const') {
      out.enum = [val]
      continue
    }
    if (!SCHEMA_KEEP.has(key)) continue
    if (key === 'properties' && isRecord(val)) {
      const properties: Record<string, unknown> = {}
      for (const [name, schema] of Object.entries(val)) {
        const cleaned = sanitizeToolSchema(schema)
        if (cleaned !== undefined) properties[name] = cleaned
      }
      out.properties = properties
    } else if (key === 'items') {
      // The proto carries a single items schema; tuple forms keep the first.
      const cleaned = Array.isArray(val) ? sanitizeToolSchema(val[0]) : sanitizeToolSchema(val)
      if (cleaned !== undefined) out.items = cleaned
    } else if ((key === 'oneOf' || key === 'anyOf') && Array.isArray(val)) {
      out[key] = val.map((branch) => sanitizeToolSchema(branch)).filter((branch) => branch !== undefined)
    } else if (key === 'additionalProperties' && isRecord(val)) {
      const cleaned = sanitizeToolSchema(val)
      if (cleaned !== undefined) out.additionalProperties = cleaned
    } else if (key === 'enum' && Array.isArray(val)) {
      out.enum = val
    } else if (key === 'required' && Array.isArray(val)) {
      out.required = val.filter((item) => typeof item === 'string')
    } else {
      out[key] = val
    }
  }
  return out
}

function normalizeToolParameters(schema: unknown): Record<string, unknown> {
  const cleaned: Record<string, unknown> = sanitizeToolSchema(schema) ?? {}
  cleaned.type = 'object'
  const properties = isRecord(cleaned.properties) ? cleaned.properties : undefined
  if (!properties || Object.keys(properties).length === 0) {
    cleaned.properties = {
      [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
        type: 'boolean',
        description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
      },
    }
    cleaned.required = Array.isArray(cleaned.required)
      ? Array.from(new Set([...(cleaned.required as unknown[]).filter((item) => typeof item === 'string'), EMPTY_SCHEMA_PLACEHOLDER_NAME]))
      : [EMPTY_SCHEMA_PLACEHOLDER_NAME]
  }
  return cleaned
}

function buildFunctionDeclarations(tools: readonly PayloadTool[], isClaude: boolean): GeminiPart[] {
  const declarations = tools.map((tool) => {
    const name = sanitizeToolName(tool.name)
    let description = String(tool.description ?? '')
    const parameters = normalizeToolParameters(tool.parameters)
    if (isClaude) {
      const signature = parameterSignature(parameters)
      if (signature.length > 0) description += `\n\n⚠️ STRICT PARAMETERS: ${signature}.`
    }
    return { name, description, parameters }
  })
  if (isClaude) {
    // Claude VALIDATED mode: one functionDeclarations entry per tool.
    return declarations.map((declaration) => ({ functionDeclarations: [declaration] }))
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : []
}

// -- generation config ----------------------------------------------------------

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value)) throw new BridgeError(`${field} must be a finite number`, 'INVALID_REQUEST')
  return Math.min(Math.max(Math.round(value), min), max)
}

export function buildGenerationConfig(request: PayloadRequest, resolved: ResolvedRoute): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const route = resolved.route
  let maxOutput = request.maxTokens !== undefined ? boundedInteger(request.maxTokens, 1, 1_000_000, 'maxTokens') : route.maxOutputTokens
  const thinking = route.thinking
  if (thinking.kind === 'claude-budget') {
    if (thinking.budget > 0) {
      config.thinkingConfig = { includeThoughts: true, thinkingBudget: thinking.budget }
      if (maxOutput <= thinking.budget) maxOutput = claudeMaxOutputForBudget(thinking.budget)
    } else {
      config.thinkingConfig = { includeThoughts: true }
    }
  } else if (thinking.kind === 'claude-adaptive') {
    config.thinkingConfig = { includeThoughts: true, thinkingBudget: 0, thinkingLevel: thinking.level }
  } else if (thinking.kind === 'gemini-level') {
    config.thinkingConfig = { includeThoughts: true, thinkingLevel: thinking.level }
  } else if (thinking.kind === 'gemini-budget') {
    config.thinkingConfig = { includeThoughts: true, thinkingBudget: thinking.budget }
  }
  config.maxOutputTokens = maxOutput
  if (request.temperature !== undefined) {
    if (!Number.isFinite(request.temperature)) throw new BridgeError('temperature must be a finite number', 'INVALID_REQUEST')
    config.temperature = request.temperature
  }
  if (request.stop !== undefined && request.stop.length > 0) {
    config.stopSequences = request.stop.slice(0, 16).map((item) => String(item).slice(0, 256))
  }
  return config
}

// -- envelope --------------------------------------------------------------------

export interface BuildPayloadOptions {
  request: PayloadRequest
  resolved: ResolvedRoute
  projectId?: string
  session: RequestSession
  timestamp?: number
  resolveImage?: ImageResolver
  mintId?: () => string
}

/** Placeholder project ids the endpoint assigns to accounts without one. */
const PLACEHOLDER_PROJECT_IDS = new Set(['inductive-dreamer-qrkws'])

/** Build the complete streamGenerateContent envelope. */
export async function buildEnvelope(options: BuildPayloadOptions): Promise<AntigravityEnvelope> {
  const { request, resolved, session } = options
  const isClaude = isClaudeThinkingRoute(resolved)
  const toolNames = new Map<string, string>()
  for (const message of request.messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolNames.set(block.id, block.name)
      }
    }
  }

  const contents: GeminiContent[] = []
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user') {
      const parts = await mapUserMessage(message, options.resolveImage)
      if (parts.length > 0) contents.push({ role: 'user', parts })
    } else if (message.role === 'assistant') {
      const parts = mapAssistantMessage(message, request.provider, isClaude)
      if (parts.length > 0) contents.push({ role: 'model', parts })
    } else if (message.role === 'tool') {
      contents.push({ role: 'user', parts: [mapToolMessage(message, toolNames)] })
    }
  }

  const geminiRequest: GeminiRequest = {
    contents: isClaude ? groupClaudeFunctionResponses(contents) : contents,
  }

  const systemParts: GeminiPart[] = []
  if (typeof request.system === 'string' && request.system.trim().length > 0) {
    systemParts.push({ text: request.system })
  }
  for (const message of request.messages) {
    if (message.role !== 'system') continue
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        systemParts.push({ text: block.text })
      }
    }
  }
  if (systemParts.length > 0) geminiRequest.systemInstruction = { parts: systemParts }

  const tools = request.tools ?? []
  if (tools.length > 0) {
    const wireTools = buildFunctionDeclarations(tools, isClaude)
    if (wireTools.length > 0) geminiRequest.tools = wireTools
    if (isClaude) {
      geminiRequest.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } }
      // Tool-hardening instruction, then the interleaved-thinking hint.
      const instruction = geminiRequest.systemInstruction ?? { parts: [] }
      instruction.parts = [...instruction.parts, { text: CLAUDE_TOOL_SYSTEM_INSTRUCTION }, { text: CLAUDE_INTERLEAVED_THINKING_HINT }]
      geminiRequest.systemInstruction = instruction
    }
  }

  geminiRequest.generationConfig = buildGenerationConfig(request, resolved)

  const metadata = buildRequestMetadata(session, geminiRequest.contents, resolved.route.wire, options.timestamp, options.mintId)
  geminiRequest.labels = metadata.labels
  geminiRequest.sessionId = metadata.sessionId
  orderRequestPayloadInPlace(geminiRequest as unknown as Record<string, unknown>)

  const project =
    options.projectId && !PLACEHOLDER_PROJECT_IDS.has(options.projectId) ? options.projectId : undefined

  return {
    ...(project !== undefined ? { project } : {}),
    requestId: metadata.requestId,
    request: geminiRequest,
    model: resolved.route.wire,
    userAgent: 'antigravity',
    requestType: 'agent',
  }
}
