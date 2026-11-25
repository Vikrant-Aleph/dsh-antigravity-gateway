/**
 * Proxy resolution: environment variables, NO_PROXY matching, and cached
 * Windows per-user proxy registry lookup.
 */
import { execFileSync } from 'node:child_process'

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
