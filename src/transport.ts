/**
 * HTTP transport for the Antigravity private endpoints.
 *
 * Uses undici so an explicit HTTPS proxy works without OS proxy settings,
 * with bounded header/body timeouts. The CLI-shaped header pairs are built
 * here; TLS is Node's own stack (the endpoint does not currently gate on TLS
 * fingerprints — see TECHNICAL.md §2.4).
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { execFileSync } from 'node:child_process'
import { buildCliUserAgent } from './constants.js'
import { BridgeError } from './errors.js'

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

/** Read the proxy environment in the documented lookup order. */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return raw
  } catch {
    return undefined
  }
}

const WINDOWS_PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const SYSTEM_PROXY_TTL_MS = 5 * 60_000
let systemProxyCache: { proxy?: string; at: number } | undefined

/** Test seam: forget the cached Windows system-proxy reading. */
export function resetSystemProxyCache(): void {
  systemProxyCache = undefined
}

/**
 * Normalize a Windows `ProxyServer` value into a proxy URL.
 * Accepts `host:port`, `scheme://host:port`, and the per-scheme form
 * `http=…;https=…;socks=…` (https preferred, then http, then socks).
 */
export function parseWindowsProxyServer(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (trimmed.includes('=')) {
    const map = new Map(
      trimmed
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const eq = part.indexOf('=')
          return eq === -1 ? ['', part] : [part.slice(0, eq).toLowerCase(), part.slice(eq + 1)]
        }),
    )
    const chosen = map.get('https') ?? map.get('http') ?? map.get('socks')
    return chosen ? `http://${chosen}` : undefined
  }
  return `http://${trimmed}`
}

/** Read per-user proxy settings from the Windows registry; win32 only. */
export function defaultWindowsProxyReader(): { enabled: boolean; server?: string } | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const out = execFileSync('reg', ['query', WINDOWS_PROXY_REG_KEY], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out)?.[1]
    return { enabled, ...(server !== undefined ? { server } : {}) }
  } catch {
    return undefined
  }
}

/**
 * Cached Windows system proxy (5-minute TTL). GUI-started Hosts do not
 * inherit shell proxy env vars, but the system proxy is what the user's
 * browser and IDE use — reading it keeps the gateway on the same route.
 */
export function systemProxy(
  reader: () => { enabled: boolean; server?: string } | undefined = defaultWindowsProxyReader,
  now: () => number = Date.now,
): string | undefined {
  if (systemProxyCache && now() - systemProxyCache.at < SYSTEM_PROXY_TTL_MS) return systemProxyCache.proxy
  const read = reader()
  let proxy: string | undefined
  if (read?.enabled === true && read.server !== undefined) proxy = parseWindowsProxyServer(read.server)
  systemProxyCache = { proxy, at: now() }
  return proxy
}

/** NO_PROXY matching: exact host, suffix `.domain`, or `*`. */
export function noProxyMatches(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NO_PROXY || env.no_proxy || ''
  if (!raw) return false
  const host = hostname.toLowerCase()
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => {
      if (!entry) return false
      if (entry === '*') return true
      if (entry.startsWith('.')) return host.endsWith(entry)
      return host === entry || host.endsWith(`.${entry}`)
    })
}

export class AgyTransport {
  private readonly options: Required<Pick<TransportOptions, 'requestTimeoutMs' | 'responseHeaderTimeoutMs' | 'idleTimeoutMs' | 'useSystemProxy'>>
  private readonly fetchImpl: FetchLike
  private readonly systemProxyReader: () => { enabled: boolean; server?: string } | undefined
  private dispatcher: Dispatcher | undefined
  private dispatcherKey: string | undefined
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

  /** Resolve (and cache) the dispatcher for one target URL. */
  private dispatcherFor(url: URL): Dispatcher | undefined {
    const configured =
      this.explicitProxy ??
      proxyFromEnv() ??
      (this.options.useSystemProxy ? systemProxy(this.systemProxyReader) : undefined)
    const useProxy = configured !== undefined && !noProxyMatches(url.hostname)
    const key = useProxy ? `proxy:${configured}` : 'direct'
    if (this.dispatcher && this.dispatcherKey === key) return this.dispatcher
    this.dispatcherKey = key
    this.dispatcher = useProxy
      ? new ProxyAgent({
          uri: configured!,
          headersTimeout: this.options.responseHeaderTimeoutMs,
          bodyTimeout: this.options.idleTimeoutMs,
        })
      : new Agent({
          headersTimeout: this.options.responseHeaderTimeoutMs,
          bodyTimeout: this.options.idleTimeoutMs,
        })
    return this.dispatcher
  }

  /** Close pooled connections (plugin unload). */
  async close(): Promise<void> {
    try {
      await this.dispatcher?.close()
    } catch {
      // Best effort.
    }
    this.dispatcher = undefined
    this.dispatcherKey = undefined
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
      throw new BridgeError('The Antigravity endpoint URL is invalid', 'INVALID_REQUEST')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BridgeError('The Antigravity endpoint must be HTTP(S)', 'INVALID_REQUEST')
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
        throw new BridgeError('The Antigravity request was cancelled', 'ABORTED', { cause: error })
      }
      const detail = describeTransportFailure(error)
      if (/timeout|timed out|aborted/i.test(detail)) {
        throw new BridgeError(`Antigravity request timed out: ${detail}`, 'TIMEOUT', { cause: error })
      }
      throw new BridgeError(`Antigravity transport failure: ${detail}`, 'TRANSPORT', { cause: error })
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
      if (signal?.aborted) throw new BridgeError('The Antigravity response read was cancelled', 'ABORTED')
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          throw new BridgeError('The Antigravity response exceeded the size limit', 'INVALID_RESPONSE')
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
        throw new BridgeError('The Antigravity stream was cancelled', 'ABORTED')
      }
      let result: { done: boolean; value?: Uint8Array }
      try {
        result = await withIdleTimeout(reader.read(), idleTimeoutMs)
      } catch (error) {
        if (options.signal?.aborted) {
          throw new BridgeError('The Antigravity stream was cancelled', 'ABORTED', { cause: error })
        }
        throw new BridgeError('The Antigravity stream stalled past the idle timeout', 'TIMEOUT', { cause: error })
      }
      if (result.done) break
      const value = result.value
      if (!value) continue
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new BridgeError('The Antigravity stream exceeded the size limit', 'INVALID_RESPONSE')
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
        // `event:`, `id:`, `retry:`, and comments carry no payload here.
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
