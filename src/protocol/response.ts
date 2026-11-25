/**
 * Antigravity SSE response parsing: provider events → neutral parts, usage,
 * and finish reasons. Pure module; the adapter turns these into DSH chunks.
 */
import { GatewayError, reportsContextOverflow } from '../shared/errors.js'
import { isRecord, numberValue, stringValue } from '../shared/guards.js'

export interface ProviderPart {
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  name?: string
  arguments?: string
  id?: string
  signature?: string
}

export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

export interface ProviderError {
  code?: string | number
  message: string
  status?: number
  contextWindowExceeded?: boolean
}

export interface ProviderEvent {
  parts: ProviderPart[]
  usage?: ProviderUsage
  finish?: string
  error?: ProviderError
  /** Response-level thought signature, when the envelope carries one. */
  signature?: string
}

/** Extract a thought signature from a part/candidate/envelope or its google metadata. */
export function signatureOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const direct = stringValue(value.thoughtSignature) ?? stringValue(value.thought_signature) ?? stringValue(value.signature)
  if (direct !== undefined) return direct
  const metadata = value.metadata
  if (isRecord(metadata) && isRecord(metadata.google)) {
    const google = metadata.google
    return stringValue(google.thoughtSignature) ?? stringValue(google.thought_signature) ?? stringValue(google.signature)
  }
  return undefined
}

function findParts(root: Record<string, unknown>): unknown[] {
  const candidates = root.candidates
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue
      const content = candidate.content
      if (isRecord(content) && Array.isArray(content.parts)) return content.parts
    }
  }
  if (Array.isArray(root.parts)) return root.parts
  const content = root.content
  if (isRecord(content) && Array.isArray(content.parts)) return content.parts
  return []
}

function findFinish(root: Record<string, unknown>): string | undefined {
  const candidates = root.candidates
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue
      const finish = stringValue(candidate.finishReason)
      if (finish !== undefined) return finish
    }
  }
  return stringValue(root.finishReason)
}

function parsePart(value: unknown): ProviderPart | undefined {
  if (!isRecord(value)) return undefined
  const signature = signatureOf(value)
  const functionCall = value.functionCall
  if (isRecord(functionCall)) {
    const name = stringValue(functionCall.name)
    if (name === undefined) return undefined
    const id = stringValue(functionCall.id)
    const args = isRecord(functionCall.args) ? functionCall.args : {}
    return {
      kind: 'tool-call',
      text: '',
      name,
      arguments: JSON.stringify(args),
      ...(id !== undefined ? { id } : {}),
      ...(signature !== undefined ? { signature } : {}),
    }
  }
  const text = typeof value.text === 'string' ? value.text : undefined
  if (text !== undefined || signature !== undefined) {
    const isThought = value.thought === true || value.reasoning === true || value.thinking === true
    if (text === undefined || (text.length === 0 && signature === undefined)) {
      return signature !== undefined ? { kind: 'reasoning', text: '', signature } : undefined
    }
    return {
      kind: isThought ? 'reasoning' : 'text',
      text,
      ...(signature !== undefined ? { signature } : {}),
    }
  }
  return undefined
}

function parseUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined
  const prompt = numberValue(value.promptTokenCount)
  const output = numberValue(value.candidatesTokenCount)
  if (prompt === undefined && output === undefined) return undefined
  const cached = numberValue(value.cachedContentTokenCount) ?? 0
  const thoughts = numberValue(value.thoughtsTokenCount) ?? numberValue(value.reasoningTokenCount)
  const total = numberValue(value.totalTokenCount)
  return {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: output ?? 0,
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(thoughts !== undefined && thoughts > 0 ? { reasoningTokens: thoughts } : {}),
  }
}

function parseError(value: unknown): ProviderError {
  if (!isRecord(value)) return { message: 'Unknown Antigravity error' }
  const message = stringValue(value.message) ?? 'Unknown Antigravity error'
  const status = typeof value.status === 'number' ? value.status : typeof value.code === 'number' ? value.code : undefined
  const code = typeof value.code === 'string' || typeof value.code === 'number' ? value.code : undefined
  return {
    message,
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(reportsContextOverflow(message) ? { contextWindowExceeded: true } : {}),
  }
}

/** Parse one SSE data payload (already stripped of the `data:` prefix). */
export function parseProviderEvent(data: string): ProviderEvent {
  const normalized = data.trim().replace(/^\)\]\}'(?:\r?\n)?/, '')
  let value: unknown
  try {
    value = JSON.parse(normalized)
  } catch {
    throw new GatewayError('The Antigravity response event was not valid JSON', 'MALFORMED_RESPONSE')
  }
  if (!isRecord(value)) throw new GatewayError('The Antigravity response event was not an object', 'PROTOCOL_DRIFT')
  if (isRecord(value.error)) return { parts: [], error: parseError(value.error) }
  const root = isRecord(value.response) ? value.response : value
  if (isRecord(root.error)) return { parts: [], error: parseError(root.error) }

  const rawParts = findParts(root)
  const responseSignature =
    signatureOf(root) ??
    signatureOf(value) ??
    (Array.isArray(root.candidates)
      ? root.candidates.map((candidate) => signatureOf(candidate) ?? (isRecord(candidate) ? signatureOf(candidate.content) : undefined)).find((sig) => sig !== undefined)
      : undefined)

  const parts: ProviderPart[] = []
  for (const raw of rawParts) {
    const part = parsePart(raw)
    if (part === undefined) continue
    if (part.kind === 'tool-call' && part.signature === undefined && responseSignature !== undefined) {
      parts.push({ ...part, signature: responseSignature })
    } else {
      parts.push(part)
    }
  }
  const usage = parseUsage(root.usageMetadata ?? value.usageMetadata)
  const finish = findFinish(root)
  return {
    parts,
    ...(usage !== undefined ? { usage } : {}),
    ...(finish !== undefined ? { finish } : {}),
    ...(responseSignature !== undefined ? { signature: responseSignature } : {}),
  }
}

/** Map a provider finishReason to the DSH finish kind. */
export function mapFinishReason(finish: string | undefined, sawToolCall: boolean): 'stop' | 'tool-calls' | 'max-tokens' | 'error' {
  if (finish === 'MAX_TOKENS') return 'max-tokens'
  if (finish === 'SAFETY' || finish === 'RECITATION' || finish === 'IMAGE_SAFETY' || finish === 'BLOCKLIST') return 'error'
  if (sawToolCall) return 'tool-calls'
  return 'stop'
}
