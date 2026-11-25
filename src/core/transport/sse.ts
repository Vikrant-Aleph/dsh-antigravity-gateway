/**
 * SSE stream iteration, bounded text body reading, and response cancellation.
 */
import { GatewayError } from '../../shared/errors.js'

const DEFAULT_IDLE_TIMEOUT_MS = 180_000

/** Cancel and drain a response body so the socket can be reused or closed. */
export async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Already closed or cancelled.
  }
}

/** Read a bounded JSON/text body from a non-streaming response. */
export async function readBoundedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new GatewayError('The Antigravity response read was cancelled', 'ABORTED')
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          throw new GatewayError('The Antigravity response exceeded the size limit', 'INVALID_RESPONSE')
        }
        chunks.push(value)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Ignore.
    }
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return buffer.toString('utf8')
}

export interface SseEvent {
  data: string
}

/**
 * Iterate SSE `data:` payloads from a streaming response. Handles multi-line
 * data fields, comment lines, the `)]}'` JSON guard prefix (stripped by the
 * caller), and `[DONE]`. Enforces an idle timeout between bytes and a total
 * byte cap.
 */
export async function* iterateSse(
  response: Response,
  options: { signal?: AbortSignal; idleTimeoutMs?: number; maxBytes?: number },
): AsyncGenerator<SseEvent> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder('utf8')
  let buffer = ''
  let totalBytes = 0
  let dataLines: string[] = []

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) return undefined
    const data = dataLines.join('\n')
    dataLines = []
    return { data }
  }

  try {
    for (;;) {
      if (options.signal?.aborted) {
        throw new GatewayError('The Antigravity stream was cancelled', 'ABORTED')
      }
      let result: { done: boolean; value?: Uint8Array }
      try {
        result = await withIdleTimeout(reader.read(), idleTimeoutMs)
      } catch (error) {
        if (options.signal?.aborted) {
          throw new GatewayError('The Antigravity stream was cancelled', 'ABORTED', { cause: error })
        }
        throw new GatewayError('The Antigravity stream stalled past the idle timeout', 'TIMEOUT', { cause: error })
      }
      if (result.done) break
      const value = result.value
      if (!value) continue
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new GatewayError('The Antigravity stream exceeded the size limit', 'INVALID_RESPONSE')
      }
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line.length === 0) {
          const event = flush()
          if (event) yield event
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    const last = flush()
    if (last) yield last
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed.
    }
    try {
      reader.releaseLock()
    } catch {
      // Ignore.
    }
  }
}

function withIdleTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`idle timeout after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
