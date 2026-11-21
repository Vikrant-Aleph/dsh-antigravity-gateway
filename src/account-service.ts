/**
 * Account service: one implementation, two callers (settings UI + /agw
 * commands). RPC routes live under `/api/antigravity-gateway-account/*`.
 *
 * Security policy (mirrors dsh-antigravity-auth): account controls are
 * enabled only when the Host has no WebServer (local-terminal composition)
 * or its WebServer is explicitly bound to 127.0.0.1. Any other bind exposes
 * the shared RPC/command seams to remote callers, and DSH carries no
 * per-caller authority with which to exempt the local user, so those
 * compositions fail closed.
 */
import type { AuthManager, AuthStatus } from './auth.js'
import type { CatalogAvailabilityReport, ModelCatalog } from './catalog.js'
import type { BridgeLogger } from './logger.js'
import { noopLogger } from './logger.js'

export const ACCOUNT_RPC_NAMESPACE = 'antigravity-gateway-account'
const RPC_CHANNEL = '/api'
const ACCOUNT_ENDPOINTS = ['status', 'login', 'cancel', 'logout', 'import', 'models'] as const
type AccountEndpoint = (typeof ACCOUNT_ENDPOINTS)[number]

export const LOOPBACK_REQUIRED_MESSAGE = 'Antigravity account controls require a local DSH Host (no WebServer or 127.0.0.1-bound)'

/** Host activation policy for account commands and RPC. */
export function accountModeFor(webServer: { host?: string } | undefined): 'enabled' | 'blocked' {
  if (webServer === undefined) return 'enabled'
  return webServer.host === '127.0.0.1' ? 'enabled' : 'blocked'
}

export interface AccountModelView {
  id: string
  name: string
  efforts: string[]
  description?: string
}

export type AccountModelsResponse =
  | (CatalogAvailabilityReport & { models: AccountModelView[] })
  | { models: AccountModelView[] }

export class AccountService {
  private readonly auth: AuthManager
  private readonly catalog: ModelCatalog
  private readonly oauthPort: number
  private readonly loginTimeoutMs: number
  private readonly logger: BridgeLogger

  constructor(options: {
    auth: AuthManager
    catalog: ModelCatalog
    oauthPort: number
    loginTimeoutMs: number
    logger?: BridgeLogger
  }) {
    this.auth = options.auth
    this.catalog = options.catalog
    this.oauthPort = options.oauthPort
    this.loginTimeoutMs = options.loginTimeoutMs
    this.logger = options.logger ?? noopLogger
  }

  async status(): Promise<AuthStatus> {
    return this.auth.status()
  }

  /** Start sign-in; returns the authorization URL for manual opening. */
  async login(): Promise<{ url: string }> {
    const handle = await this.auth.login({ port: this.oauthPort, timeoutMs: this.loginTimeoutMs })
    handle.done.then(
      () => {
        this.catalog.invalidate()
        void this.catalog.list().catch(() => {})
      },
      () => {},
    )
    return { url: handle.url }
  }

  cancel(): { cancelled: boolean } {
    return { cancelled: this.auth.cancelLogin() }
  }

  async logout(): Promise<{ loggedOut: boolean }> {
    await this.auth.logout()
    this.catalog.invalidate()
    return { loggedOut: true }
  }

  async import(): Promise<{ email?: string; projectId?: string }> {
    const result = await this.auth.importFromAntigravityAuth()
    this.catalog.invalidate()
    void this.catalog.list().catch(() => {})
    return result
  }

  async models(options: { force?: boolean } = {}): Promise<AccountModelsResponse> {
    if (typeof this.catalog.getAvailabilityReport === 'function') {
      const report = await this.catalog.getAvailabilityReport({ force: options.force === true })
      return { ...report, models: report.available }
    }
    const definitions = await this.catalog.list()
    return {
      models: definitions.map((definition) => ({
        id: definition.id,
        name: definition.name,
        efforts: definition.efforts.map((effort) => effort.id),
        ...(definition.description !== undefined ? { description: definition.description } : {}),
      })),
    }
  }

  /** Dispatch one validated RPC endpoint call. */
  async dispatch(endpoint: AccountEndpoint, payload?: Record<string, unknown>): Promise<unknown> {
    switch (endpoint) {
      case 'status':
        return this.status()
      case 'login':
        return this.login()
      case 'cancel':
        return this.cancel()
      case 'logout':
        return this.logout()
      case 'import':
        return this.import()
      case 'models':
        return this.models({ force: payload?.force === true })
    }
  }
}

/** Minimal structural view of the host context used here. */
export interface AccountAccessContext {
  get?(name: string): unknown
  inject(names: string[], callback: (ctx: AccountAccessContext) => (() => void) | void): unknown
  connection?: {
    fetch?: {
      register(route: {
        path: string
        methods: string[]
        requestBody: string
        fetch: (request: Request) => Promise<Response>
      }): () => void
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Register the account RPC routes behind the loopback guard. A blocked
 * composition registers inert routes that never reach the service.
 */
export function registerAccountAccess(ctx: AccountAccessContext, service: AccountService, logger: BridgeLogger = noopLogger): () => void {
  let disposeRoutes: (() => void) | undefined
  ctx.inject(['connection'], (ctxWithConnection) => {
    const connection = ctxWithConnection.connection
    if (!connection?.fetch?.register) return () => {}
    const webServer = ctxWithConnection.get?.('webServer') as { host?: string } | undefined
    const mode = accountModeFor(webServer)
    if (mode === 'blocked') {
      logger.warn('account', 'account RPC blocked: WebServer is not loopback-bound', { host: webServer?.host ?? '(unknown)' })
    }
    const routeDisposers = ACCOUNT_ENDPOINTS.map((endpoint) =>
      connection.fetch!.register({
        path: `${RPC_CHANNEL}/${ACCOUNT_RPC_NAMESPACE}/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          let envelope: unknown
          try {
            envelope = await request.json()
          } catch {
            return new Response('invalid JSON', { status: 400 })
          }
          const record = isRecord(envelope) ? envelope : {}
          const rpcId = typeof record.rpcId === 'string' ? record.rpcId : ''
          const method = typeof record.method === 'string' ? record.method : ''
          const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId, result })
          const failure = (code: string, message: string) => reply({ ok: false, error: { code, message, details: {} } })
          if (method !== `${ACCOUNT_RPC_NAMESPACE}/${endpoint}`) {
            return failure('bad-request', 'account request method does not match its endpoint')
          }
          if (mode === 'blocked') {
            return failure('loopback-required', LOOPBACK_REQUIRED_MESSAGE)
          }
          try {
            const payload = isRecord(record.payload) ? record.payload : undefined
            const value = await service.dispatch(endpoint, payload)
            return reply({ ok: true, value })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('account', `RPC ${endpoint} failed`, { error: message.slice(0, 200) })
            return failure('internal', message)
          }
        },
      }),
    )
    disposeRoutes = () => {
      for (const dispose of routeDisposers) void dispose()
    }
    return disposeRoutes
  })
  return () => disposeRoutes?.()
}
