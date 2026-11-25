/**
 * Shared RPC channel, namespace, endpoint, and DTO contracts between the DSH
 * host services (`src/dsh/*`) and the settings UI (`client.js`).
 */

export const RPC_CHANNEL = '/api' as const

export const ACCOUNT_RPC_NAMESPACE = 'antigravity-gateway-account' as const
export const ACCOUNT_ENDPOINTS = ['status', 'login', 'cancel', 'logout', 'import', 'models'] as const
export type AccountEndpoint = (typeof ACCOUNT_ENDPOINTS)[number]

export const LOG_RPC_NAMESPACE = 'antigravity-gateway-logs' as const
export const LOG_ENDPOINTS = ['read', 'stat', 'clear', 'level'] as const
export type LogEndpoint = (typeof LOG_ENDPOINTS)[number]

export const REQUEST_DIAGNOSTICS_VERSION = 1

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'off'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

export interface RpcErrorPayload {
  code: string
  message: string
  details: Record<string, unknown>
}

export type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: RpcErrorPayload }

export interface RpcResponseEnvelope<T = unknown> {
  type: 'server-response'
  rpcId: string
  result: RpcResult<T>
}

export interface AccountModelView {
  id: string
  name: string
  efforts: string[]
  description?: string
}

export interface LogReadResult {
  lines: string[]
  truncated: boolean
  level: LogLevel
  dir: string
  totalBytes: number
  files: { name: string; bytes: number }[]
}

export interface LogStatResult {
  level: LogLevel
  dir: string
  totalBytes: number
  files: { name: string; bytes: number }[]
  lines: number
}
