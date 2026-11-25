/**
 * Antigravity session metadata: FNV-1a 64-bit ids, trajectory/cascade store,
 * and request label generation. Pure module (zero I/O or host imports).
 */
import { randomUUID } from 'node:crypto'
import { resolveRoute, type ResolvedRoute } from './models.js'

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

  getOrCreate(key: string, mintId: () => string = randomUUID): RequestSession {
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

  beginRequest(key: string, mintId: () => string = randomUUID): { session: RequestSession; timestamp: number } {
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

/** Stable per-session key from the DSH session id. */
export function requestSessionKey(sessionId: string | undefined): string {
  return sessionId === undefined ? 'default' : `session:${fnv1a64Signed(String(sessionId))}`
}

/** Claude tool responses are user-role contents but do not start a new turn. */
function hasSecondUserTurn(contents: readonly { role: 'user' | 'model'; parts: Record<string, unknown>[] }[]): boolean {
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

function safeResolve(wireModel: string): ResolvedRoute | undefined {
  try {
    return resolveRoute(wireModel)
  } catch {
    return undefined
  }
}

/** Build the CLI's agent request metadata (labels + requestId). */
export function buildRequestMetadata(
  session: RequestSession,
  contents: readonly { role: 'user' | 'model'; parts: Record<string, unknown>[] }[],
  wireModel: string,
  timestamp?: number,
  mintId: () => string = randomUUID,
  resolvedRoute?: ResolvedRoute,
): RequestMetadata {
  const requestTimestamp = timestamp ?? Math.max(Date.now(), (session.lastMetadataTimestamp ?? 0) + 1)
  const stepCount = contents.length
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
  const resolved = resolvedRoute ?? safeResolve(wireModel)
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
