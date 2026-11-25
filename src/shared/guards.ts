/**
 * Shared runtime type guards, numeric bounds, and caller-abort helpers.
 * Zero DSH or I/O dependencies.
 */
import { GatewayError } from './errors.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(value, 0), 1)
}

export function parsePositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

export function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value)) throw new GatewayError(`${field} must be a finite number`, 'INVALID_REQUEST')
  return Math.min(Math.max(Math.round(value), min), max)
}

/**
 * Race a shared promise against one caller's AbortSignal without aborting the
 * underlying work for other concurrent waiters.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  message = 'The Antigravity request was cancelled',
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new GatewayError(message, 'ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new GatewayError(message, 'ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
