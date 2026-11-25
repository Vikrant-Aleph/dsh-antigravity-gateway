/**
 * Account service: one implementation, two callers (settings UI + /agw
 * commands). RPC routes live under `/api/antigravity-gateway-account/*`.
 */
import type { AuthManager, AuthStatus } from '../core/auth.js'
import { accountCacheKey, type ModelCatalog } from '../core/catalog.js'
import type { GatewayLogger } from '../core/logger.js'
import { noopLogger } from '../core/logger.js'
import type { CatalogAvailabilityReport } from '../protocol/catalog-parser.js'
import {
  ACCOUNT_ENDPOINTS,
  ACCOUNT_RPC_NAMESPACE,
  type AccountEndpoint,
  type AccountModelView,
  type AccountSummary,
  type ActiveAccountMeta,
} from '../shared/rpc-contracts.js'
import {
  LOOPBACK_REQUIRED_MESSAGE,
  RpcBadRequestError,
  accountModeFor,
  registerRpcNamespace,
} from './rpc.js'
import type { AccountAccessContext } from './types.js'

export { ACCOUNT_RPC_NAMESPACE, LOOPBACK_REQUIRED_MESSAGE, accountModeFor }
export type { AccountAccessContext, AccountModelView }

export type AccountStatusResponse = AuthStatus & {
  providers: string[]
  autoSwitchAccount: boolean
}

export type AccountModelsResponse =
  | (CatalogAvailabilityReport & {
      models: AccountModelView[]
      providers: string[]
      autoSwitchAccount: boolean
      accountCount: number
      activeAccount?: ActiveAccountMeta
    })
  | {
      models: AccountModelView[]
      providers: string[]
      autoSwitchAccount: boolean
      accountCount: number
      activeAccount?: ActiveAccountMeta
    }

export class AccountService {
  private readonly auth: AuthManager
  private readonly catalog: ModelCatalog
  private readonly oauthPort: number
  private readonly loginTimeoutMs: number
  private readonly providers: readonly string[]
  private readonly autoSwitchAccount: boolean

  constructor(options: {
    auth: AuthManager
    catalog: ModelCatalog
    oauthPort: number
    loginTimeoutMs: number
    providers?: readonly string[]
    autoSwitchAccount?: boolean
    logger?: GatewayLogger
  }) {
    this.auth = options.auth
    this.catalog = options.catalog
    this.oauthPort = options.oauthPort
    this.loginTimeoutMs = options.loginTimeoutMs
    this.providers = options.providers?.length ? [...options.providers] : ['antigravity-gateway']
    this.autoSwitchAccount = options.autoSwitchAccount ?? true
  }

  async status(): Promise<AccountStatusResponse> {
    const base = await this.auth.status()
    return {
      ...base,
      providers: [...this.providers],
      autoSwitchAccount: this.autoSwitchAccount,
    }
  }

  /** Start sign-in; returns the authorization URL for manual opening. */
  async login(): Promise<{ url: string }> {
    const handle = await this.auth.login({ port: this.oauthPort, timeoutMs: this.loginTimeoutMs })
    handle.done.then(
      async (res) => {
        const key = accountCacheKey({
          ...(res?.accountId ? { id: res.accountId } : {}),
          ...(res?.projectId ? { projectId: res.projectId } : {}),
          ...(res?.email ? { email: res.email } : {}),
        })
        this.catalog.invalidate(key === 'default' ? undefined : key)
        this.catalog.onActiveAccountChanged?.()
        void this.catalog.list().catch(() => {})
      },
      () => {},
    )
    return { url: handle.url }
  }

  cancel(): { cancelled: boolean } {
    return { cancelled: this.auth.cancelLogin() }
  }

  async logout(options: { accountId?: string; all?: boolean } = {}): Promise<{ loggedOut: boolean; activeAccountId?: string }> {
    let removedKey: string | undefined
    if (!options.all) {
      const before = await this.auth.status()
      const target = options.accountId
        ? before.accounts?.find((a) => a.id === options.accountId)
        : before.accounts?.find((a) => a.id === before.activeAccountId)
      if (target) {
        removedKey = accountCacheKey(target)
      }
    }
    await this.auth.logout(options.accountId, options.all === true)
    this.catalog.invalidate(options.all ? undefined : removedKey)
    this.catalog.onActiveAccountChanged?.()
    const after = await this.auth.status()
    return {
      loggedOut: true,
      ...(after.activeAccountId ? { activeAccountId: after.activeAccountId } : {}),
    }
  }

  async import(): Promise<{ email?: string; projectId?: string }> {
    const result = await this.auth.importFromAntigravityAuth()
    const key = accountCacheKey(result)
    this.catalog.invalidate(key === 'default' ? undefined : key)
    this.catalog.onActiveAccountChanged?.()
    void this.catalog.list().catch(() => {})
    return result
  }

  async switch(accountId: string): Promise<{ active: AccountSummary }> {
    if (typeof accountId !== 'string' || accountId.trim().length === 0) {
      throw new RpcBadRequestError('accountId is required')
    }
    const active = await this.auth.switchAccount(accountId.trim())
    this.catalog.onActiveAccountChanged?.()
    void this.catalog.list().catch(() => {})
    return { active }
  }

  async models(options: { force?: boolean } = {}): Promise<AccountModelsResponse> {
    const status = await this.auth.status()
    const accountCount = status.accounts?.length ?? (status.loggedIn ? 1 : 0)
    const activeAccount: ActiveAccountMeta | undefined = status.loggedIn
      ? {
          id: status.activeAccountId ?? 'default',
          ...(status.email ? { email: status.email } : {}),
          ...(status.projectId ? { projectId: status.projectId } : {}),
        }
      : undefined
    const common = {
      providers: [...this.providers],
      autoSwitchAccount: this.autoSwitchAccount,
      accountCount,
      ...(activeAccount ? { activeAccount } : {}),
    }

    if (typeof this.catalog.getAvailabilityReport === 'function') {
      const report = await this.catalog.getAvailabilityReport({ force: options.force === true })
      return { ...report, models: report.available, ...common }
    }
    const definitions = await this.catalog.list()
    return {
      models: definitions.map((definition) => ({
        id: definition.id,
        name: definition.name,
        efforts: definition.efforts.map((effort) => effort.id),
        ...(definition.description !== undefined ? { description: definition.description } : {}),
      })),
      ...common,
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
        return this.logout({
          ...(typeof payload?.accountId === 'string' ? { accountId: payload.accountId } : {}),
          ...(payload?.all === true ? { all: true } : {}),
        })
      case 'import':
        return this.import()
      case 'models':
        return this.models({ force: payload?.force === true })
      case 'switch':
        return this.switch(typeof payload?.accountId === 'string' ? payload.accountId : '')
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
