/**
 * DSH request → Antigravity Cloud Code wire payload.
 *
 * Pure module (no DSH or I/O imports): the adapter passes structural message
 * values and an image resolver. The envelope, field order, labels, and Claude
 * transforms reproduce the agy CLI client shape documented in TECHNICAL.md §4.
 */
import { GatewayError } from '../shared/errors.js'
import { boundedInteger, isRecord } from '../shared/guards.js'
import {
  CLAUDE_INTERLEAVED_THINKING_HINT,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  SKIP_THOUGHT_SIGNATURE,
} from './constants.js'
import { claudeMaxOutputForBudget, isClaudeThinkingRoute, type ResolvedRoute } from './models.js'
import { normalizeToolParameters, parameterSignature, sanitizeToolName } from './schema-sanitizer.js'
import { buildRequestMetadata, type RequestSession } from './session-metadata.js'

export {
  buildRequestMetadata,
  fnv1a64Signed,
  RequestSessionStore,
  requestSessionKey,
  type RequestMetadata,
  type RequestSession,
} from './session-metadata.js'
export { sanitizeToolName, sanitizeToolSchema } from './schema-sanitizer.js'

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

// -- message mapping ----------------------------------------------------------

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
    if (!Number.isFinite(request.temperature)) throw new GatewayError('temperature must be a finite number', 'INVALID_REQUEST')
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

  const metadata = buildRequestMetadata(
    session,
    geminiRequest.contents,
    resolved.route.wire,
    options.timestamp,
    options.mintId,
    resolved,
  )
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
