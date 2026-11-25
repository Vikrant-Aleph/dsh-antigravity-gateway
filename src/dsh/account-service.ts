/**
 * Account service: one implementation, two callers (settings UI + /agw
 * commands). RPC routes live under `/api/antigravity-gateway-account/*`.
 */
import type { AuthManager, AuthStatus } from '../core/auth.js'
import type { ModelCatalog } from '../core/catalog.js'
import type { GatewayLogger } from '../core/logger.js'
import { noopLogger } from '../core/logger.js'
import type { CatalogAvailabilityReport } from '../protocol/catalog-parser.js'
import {
  ACCOUNT_ENDPOINTS,
  ACCOUNT_RPC_NAMESPACE,
  type AccountEndpoint,
  type AccountModelView,
} from '../shared/rpc-contracts.js'
import {
  LOOPBACK_REQUIRED_MESSAGE,
  accountModeFor,
  registerRpcNamespace,
} from './rpc.js'
import type { AccountAccessContext } from './types.js'

export { ACCOUNT_RPC_NAMESPACE, LOOPBACK_REQUIRED_MESSAGE, accountModeFor }
export type { AccountAccessContext, AccountModelView }

export type AccountModelsResponse =
  | (CatalogAvailabilityReport & { models: AccountModelView[] })
  | { models: AccountModelView[] }

export class AccountService {
  private readonly auth: AuthManager
  private readonly catalog: ModelCatalog
  private readonly oauthPort: number
  private readonly loginTimeoutMs: number

  constructor(options: {
    auth: AuthManager
    catalog: ModelCatalog
    oauthPort: number
    loginTimeoutMs: number
    logger?: GatewayLogger
  }) {
    this.auth = options.auth
    this.catalog = options.catalog
    this.oauthPort = options.oauthPort
    this.loginTimeoutMs = options.loginTimeoutMs
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

/**
 * Register the account RPC routes behind the loopback guard. A blocked
 * composition registers inert routes that never reach the service.
 */
export function registerAccountAccess(
  ctx: AccountAccessContext,
  service: AccountService,
  logger: GatewayLogger = noopLogger,
): () => void {
  return registerRpcNamespace(ctx, {
    namespace: ACCOUNT_RPC_NAMESPACE,
    endpoints: ACCOUNT_ENDPOINTS,
    requireLoopback: true,
    blockedLogScope: 'account',
    blockedLogMessage: 'account RPC blocked: WebServer is not loopback-bound',
    logger,
    handle: (endpoint, payload) => service.dispatch(endpoint, payload),
  })
}
