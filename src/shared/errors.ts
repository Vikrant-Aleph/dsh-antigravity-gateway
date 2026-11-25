/**
 * Provider-neutral failure classification for the Antigravity gateway.
 *
 * Pure module: zero DSH or Node I/O imports. The DSH adapter maps
 * `GatewayError` into `LlmError` at the host boundary.
 */

/** Failure codes this plugin raises; a subset of the DSH LLM failure taxonomy. */
export type GatewayErrorCode =
  | 'AUTH'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_CREDENTIAL'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'EMPTY_RESPONSE'
  | 'INVALID_MODEL'
  | 'UNKNOWN_MODEL'
  | 'UNSUPPORTED_REASONING_EFFORT'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'MALFORMED_RESPONSE'
  | 'PROTOCOL_DRIFT'
  | 'TRANSPORT'
  | 'TIMEOUT'
  | 'SERVER'
  | 'ABORTED'
  | 'CANCELLED'
  | 'UNKNOWN'
  | `HTTP_${number}`

export class GatewayError extends Error {
  readonly code: GatewayErrorCode
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly detail?: string

  constructor(
    message: string,
    code: GatewayErrorCode,
    options: { status?: number; providerRetryAfterMs?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'GatewayError'
    this.code = code
    this.status = options.status
    this.providerRetryAfterMs = options.providerRetryAfterMs
    this.detail = options.detail
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError
}

/** @deprecated Use {@link GatewayErrorCode}. Kept during 0.x for external compatibility. */
export type BridgeErrorCode = GatewayErrorCode
/** @deprecated Use {@link GatewayError}. Kept during 0.x for external compatibility. */
export const BridgeError = GatewayError
/** @deprecated Use {@link GatewayError}. Kept during 0.x for external compatibility. */
export type BridgeError = GatewayError
/** @deprecated Use {@link isGatewayError}. Kept during 0.x for external compatibility. */
export const isBridgeError = isGatewayError

/** Classify an HTTP status from the private endpoint. */
export function statusToError(status: number, message: string, retryAfterMs?: number): GatewayError {
  if (status === 401 || status === 403) {
    return new GatewayError(message || 'Antigravity rejected the credential', 'AUTH', { status })
  }
  if (status === 429) {
    return new GatewayError(message || 'Antigravity rate limit reached', 'RATE_LIMIT', {
      status,
      ...(retryAfterMs !== undefined ? { providerRetryAfterMs: retryAfterMs } : {}),
    })
  }
  if (status >= 500) {
    return new GatewayError(message || `Antigravity server error (${status})`, 'SERVER', { status })
  }
  return new GatewayError(message || `Antigravity request failed (${status})`, `HTTP_${status}`, { status })
}

const MAX_RETRY_AFTER_SECONDS = 3600

/** Parse `Retry-After` (delta-seconds or HTTP-date) into bounded milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const trimmed = value.trim()
  if (/^\d{1,8}$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : MAX_RETRY_AFTER_SECONDS * 1000
  }
  const date = Date.parse(trimmed)
  if (!Number.isFinite(date)) return undefined
  const seconds = Math.ceil((date - now) / 1000)
  if (seconds < 0) return 0
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : MAX_RETRY_AFTER_SECONDS * 1000
}

/** Structured wording that names a context bound being exceeded. */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[\s_-](?:length|window)[\s_-]*(?:exceed(?:ed|s)?|overflow(?:ed)?|limit)/i,
  /(?:request|prompt|input)\s+(?:is\s+|are\s+)?too\s+(?:large|long)/i,
  /exceeds?\s+(?:the\s+)?(?:maximum\s+)?(?:context|token)/i,
  /input\s+token\s+count\s+exceeds/i,
  /RESOURCE_EXHAUSTED.*(?:context|token)/i,
]

export function reportsContextOverflow(text: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}

/** 503 wording the endpoint uses when a model is temporarily at capacity. */
export function reportsModelCapacity(text: string): boolean {
  return /model\s+(?:is\s+)?(?:currently\s+)?(?:at\s+capacity|overloaded|unavailable)|capacity\s+(?:exhausted|exceeded)|try\s+again\s+later/i.test(text)
}

/** Bounded error-body text for diagnostics; never contains request content. */
export function sanitizeProviderText(text: string, maxChars = 600): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed
}
