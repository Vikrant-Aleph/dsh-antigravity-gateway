/**
 * HTTP transport for the Antigravity private endpoints.
 *
 * Uses undici so an explicit HTTPS proxy works without OS proxy settings,
 * with bounded header/body timeouts.
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { buildCliUserAgent } from '../../protocol/constants.js'
import { GatewayError } from '../../shared/errors.js'
import { defaultWindowsProxyReader, noProxyMatches, proxyFromEnv, systemProxy } from './proxy.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface TransportOptions {
  /** Total request timeout in milliseconds (headers + body). */
  requestTimeoutMs?: number
  /** Max time to wait for response headers. */
  responseHeaderTimeoutMs?: number
  /** Max stall between body bytes while streaming. */
  idleTimeoutMs?: number
  /** Explicit proxy URL; when absent, read HTTPS_PROXY/https_proxy/ALL_PROXY. */
  proxyUrl?: string
  /** Read the Windows per-user proxy settings when env/config name none. @default true */
  useSystemProxy?: boolean
  /** Test seam: replace the underlying fetch implementation. */
  fetchImpl?: FetchLike
  /** Test seam: replace the Windows registry reader. */
  systemProxyReader?: () => { enabled: boolean; server?: string } | undefined
}

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000
const DEFAULT_HEADER_TIMEOUT_MS = 180_000
const DEFAULT_IDLE_TIMEOUT_MS = 180_000
const MAX_DISPATCHERS = 4

export class AgyTransport {
  private readonly options: Required<Pick<TransportOptions, 'requestTimeoutMs' | 'responseHeaderTimeoutMs' | 'idleTimeoutMs' | 'useSystemProxy'>>
  private readonly fetchImpl: FetchLike
  private readonly systemProxyReader: () => { enabled: boolean; server?: string } | undefined
  private readonly dispatchers = new Map<string, Dispatcher>()
  private readonly explicitProxy?: string

  constructor(options: TransportOptions = {}) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      responseHeaderTimeoutMs: options.responseHeaderTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      useSystemProxy: options.useSystemProxy ?? true,
    }
    this.fetchImpl = options.fetchImpl ?? ((url, init) => undiciFetch(url, init as never) as unknown as Promise<Response>)
    this.explicitProxy = options.proxyUrl
    this.systemProxyReader = options.systemProxyReader ?? defaultWindowsProxyReader
  }

  /** Resolve (and cache in a bounded pool) the dispatcher for one target URL. */
  private dispatcherFor(url: URL): Dispatcher {
    const configured =
      this.explicitProxy ??
      proxyFromEnv() ??
      (this.options.useSystemProxy ? systemProxy(this.systemProxyReader) : undefined)
    const useProxy = configured !== undefined && !noProxyMatches(url.hostname)
    const key = useProxy ? `proxy:${configured}` : 'direct'
    const existing = this.dispatchers.get(key)
    if (existing) {
      // Refresh LRU insertion order.
      this.dispatchers.delete(key)
      this.dispatchers.set(key, existing)
      return existing
    }
    if (this.dispatchers.size >= MAX_DISPATCHERS) {
      const oldest = this.dispatchers.entries().next().value
      if (oldest) {
        this.dispatchers.delete(oldest[0])
        void oldest[1].close().catch(() => {})
      }
    }
    const created: Dispatcher = useProxy
      ? new ProxyAgent({
          uri: configured!,
          headersTimeout: this.options.responseHeaderTimeoutMs,
          bodyTimeout: this.options.idleTimeoutMs,
        })
      : new Agent({
          headersTimeout: this.options.responseHeaderTimeoutMs,
          bodyTimeout: this.options.idleTimeoutMs,
        })
    this.dispatchers.set(key, created)
    return created
  }

  /** Close all pooled connections (plugin unload). */
  async close(): Promise<void> {
    const all = Array.from(this.dispatchers.values())
    this.dispatchers.clear()
    await Promise.allSettled(all.map((dispatcher) => dispatcher.close()))
  }

  /**
   * General HTTP fetch sharing this transport's proxy configuration
   * (used for Google OAuth token/userinfo calls without forcing CLI headers).
   */
  async fetch(inputUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(inputUrl)
    const timeoutMs = Math.min(this.options.requestTimeoutMs, 30_000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
    const outer = init.signal ?? undefined
    const onAbort = () => controller.abort(outer?.reason)
    outer?.addEventListener('abort', onAbort, { once: true })
    if (outer?.aborted) controller.abort(outer.reason)
    try {
      return await this.fetchImpl(inputUrl, {
        ...init,
        signal: controller.signal,
        // @ts-expect-error undici accepts a dispatcher on RequestInit
        dispatcher: this.dispatcherFor(url),
      })
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * One POST to a private endpoint with the CLI header shape. Returns the
   * raw Response; the caller owns cancellation and body consumption.
   */
  async request(input: {
    url: string
    accessToken: string
    body: string
    signal?: AbortSignal
  }): Promise<Response> {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      throw new GatewayError('The Antigravity endpoint URL is invalid', 'INVALID_REQUEST')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new GatewayError('The Antigravity endpoint must be HTTP(S)', 'INVALID_REQUEST')
    }
    const headers: Record<string, string> = {
      'User-Agent': buildCliUserAgent(),
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('request timeout')), this.options.requestTimeoutMs)
    const onOuterAbort = () => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', onOuterAbort, { once: true })
    if (input.signal?.aborted) controller.abort(input.signal.reason)
    try {
      const response = await this.fetchImpl(input.url, {
        method: 'POST',
        headers,
        body: input.body,
        signal: controller.signal,
        // @ts-expect-error undici accepts a dispatcher on RequestInit
        dispatcher: this.dispatcherFor(url),
      })
      return response
    } catch (error) {
      if (input.signal?.aborted) {
        throw new GatewayError('The Antigravity request was cancelled', 'ABORTED', { cause: error })
      }
      const detail = describeTransportFailure(error)
      if (/timeout|timed out|aborted/i.test(detail)) {
        throw new GatewayError(`Antigravity request timed out: ${detail}`, 'TIMEOUT', { cause: error })
      }
      throw new GatewayError(`Antigravity transport failure: ${detail}`, 'TRANSPORT', { cause: error })
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  get idleTimeoutMs(): number {
    return this.options.idleTimeoutMs
  }
}

/** Surface the undici cause chain (codes like UND_ERR_CONNECT_TIMEOUT) in messages. */
function describeTransportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  let cause: unknown = error instanceof Error ? error.cause : undefined
  let depth = 0
  while (cause !== undefined && depth < 3) {
    const code = typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : undefined
    const causeMessage = cause instanceof Error ? cause.message : String(cause)
    if (code !== undefined && !message.includes(code)) return `${message} [${code}]`
    if (causeMessage && causeMessage !== message && !message.includes(causeMessage)) return `${message} [${causeMessage}]`
    cause = cause instanceof Error ? cause.cause : undefined
    depth += 1
  }
  return message
}
