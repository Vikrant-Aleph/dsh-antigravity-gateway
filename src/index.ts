/**
 * dsh-antigravity-gateway: Google Antigravity models for DeepSeek Harness.
 *
 * Thin plugin entrypoint: dependency wiring, Cordis lifecycle bindings, and
 * controlled public exports. Protocol, runtime core, and DSH adaptation live
 * in `src/protocol/`, `src/core/`, and `src/dsh/` respectively.
 */
import path from 'node:path'
import { AuthManager } from './core/auth.js'
import { ModelCatalog } from './core/catalog.js'
import { CredentialStore, defaultCredentialFile, type GatewayCredential, type BridgeCredential } from './core/credentials.js'
import { PluginLogger, defaultLogDir, noopLogger, type GatewayLogger, type BridgeLogger } from './core/logger.js'
import { resolveOAuthClient } from './core/oauth.js'
import { AgyTransport } from './core/transport/index.js'
import { AccountService, accountModeFor, registerAccountAccess } from './dsh/account-service.js'
import { AntigravityGatewayAdapter, AntigravityBridgeAdapter } from './dsh/adapter.js'
import { registerCommands } from './dsh/commands.js'
import { Config, normalizeLogLevel, resolveGatewayConfig, type GatewayConfig } from './dsh/config.js'
import { LogService, registerLogAccess } from './dsh/log-service.js'
import { mountPromptCompatibility } from './dsh/prompt-compat.js'
import type { AttachmentsServiceLike, CredentialsServiceLike, HostContext, WebServerLike } from './dsh/types.js'
import {
  BridgeError,
  GatewayError,
  isBridgeError,
  isGatewayError,
  type BridgeErrorCode,
  type GatewayErrorCode,
} from './shared/errors.js'

export {
  Config,
  type GatewayConfig,
  AntigravityGatewayAdapter,
  AntigravityBridgeAdapter,
  GatewayError,
  BridgeError,
  isGatewayError,
  isBridgeError,
  type GatewayErrorCode,
  type BridgeErrorCode,
  type GatewayCredential,
  type BridgeCredential,
  type GatewayLogger,
  type BridgeLogger,
  ModelCatalog,
  AuthManager,
  CredentialStore,
  PluginLogger,
  noopLogger,
  LogService,
  AccountService,
  AgyTransport,
  accountModeFor,
}

export const name = 'dsh-antigravity-gateway'
export const inject = ['llm']

export function apply(
  ctx: HostContext,
  config: Record<string, unknown>,
  hooks?: { openUrl?: (url: string) => boolean },
): void {
  const cfg = resolveGatewayConfig(config)

  const logger = new PluginLogger({
    level: normalizeLogLevel(cfg.logLevel),
    dir: cfg.logDir || defaultLogDir(),
    maxBytes: cfg.logMaxBytes,
    maxFiles: cfg.logMaxFiles,
    secrets: [resolveOAuthClient().clientSecret],
    mirror: (line) => console.log(`[dsh-antigravity-gateway] ${line}`),
  })
  logger.info('plugin', 'starting', {
    providers: cfg.providers.join(','),
    endpoint: cfg.endpoint,
    logLevel: logger.getLevel(),
  })

  const logService = new LogService(logger)
  ctx.effect(() => registerLogAccess(ctx, logService))

  const store = new CredentialStore({
    getService: () => ctx.get?.('credentials') as CredentialsServiceLike | undefined,
    ...(cfg.credentialFile ? { file: cfg.credentialFile } : {}),
    logger,
  })

  const transport = new AgyTransport({
    requestTimeoutMs: cfg.requestTimeoutMs,
    responseHeaderTimeoutMs: cfg.responseHeaderTimeoutMs,
    idleTimeoutMs: cfg.idleTimeoutMs,
    ...(cfg.proxyUrl ? { proxyUrl: cfg.proxyUrl } : {}),
    useSystemProxy: cfg.useSystemProxy,
  })
  ctx.effect(() => () => {
    void transport.close()
  })

  const endpoints = [cfg.endpoint, ...cfg.fallbackEndpoints.filter((endpoint) => endpoint !== cfg.endpoint)]
  const auth = new AuthManager({
    store,
    transport,
    logger,
    endpoints,
    ...(hooks?.openUrl ? { openUrl: hooks.openUrl } : {}),
  })
  ctx.effect(() => () => {
    auth.cancelLogin()
  })

  const providers = cfg.providers.length > 0 ? [...cfg.providers] : ['antigravity-gateway']
  let registration: ((() => void) & { replace?: (providers: string[]) => void }) | undefined

  const cacheFile = path.join(path.dirname(cfg.credentialFile || defaultCredentialFile()), 'catalog-cache.json')
  const catalog = new ModelCatalog(auth, transport, {
    ttlMs: cfg.catalogTtlMs,
    extraModels: cfg.extraModels,
    logger,
    endpoints,
    cacheFile,
    onUpdated: () => {
      if (typeof registration?.replace === 'function') {
        // Atomic route replacement re-announces the catalog to DSH's model
        // directory without disposing prepared calls or session selections.
        registration.replace(providers)
      }
      if (typeof ctx.emit === 'function') {
        for (const provider of providers) {
          try {
            ctx.emit('llm/models-updated', provider)
          } catch {
            // Listener failures are contained by the runtime.
          }
        }
      }
    },
  })

  const account = new AccountService({
    auth,
    catalog,
    oauthPort: cfg.oauthPort,
    loginTimeoutMs: cfg.loginTimeoutMs,
    providers,
    autoSwitchAccount: cfg.autoSwitchAccount,
    logger,
  })
  const accountMode = accountModeFor(ctx.get?.('webServer') as WebServerLike | undefined)
  if (accountMode === 'blocked') {
    logger.warn('plugin', 'account controls blocked: WebServer is not loopback-bound')
  }

  const adapter = new AntigravityGatewayAdapter({
    providers,
    auth,
    catalog,
    transport,
    endpoints,
    logger,
    getAttachments: () => ctx.get?.('attachments') as AttachmentsServiceLike | undefined,
    imageInput: cfg.imageInput,
    maxImageBytes: cfg.maxImageBytes,
    autoSwitchAccount: cfg.autoSwitchAccount,
    ...(cfg.dumpRequestsTo ? { dumpRequestsTo: cfg.dumpRequestsTo } : {}),
  })

  try {
    registration = ctx.llm.registerAdapter(providers, adapter)
    logger.info('plugin', 'LLM adapter registered', { providers: providers.join(',') })
  } catch (error) {
    logger.error('plugin', 'failed to register LLM adapter', { error: String(error).slice(0, 300) })
    return
  }
  ctx.effect(() => () => registration?.())

  if (typeof ctx.llm.registerConfigurableProviders === 'function') {
    try {
      ctx.llm.registerConfigurableProviders(
        providers.map((provider) => ({
          provider,
          displayName: 'Antigravity Gateway',
          settingsNs: 'dsh-antigravity-gateway',
          settingsPath: [],
          nativeAuth: { env: [], oauth: true },
        })),
      )
    } catch (error) {
      logger.warn('plugin', 'registerConfigurableProviders note', { error: String(error).slice(0, 200) })
    }
  }

  if (typeof ctx.llm.registerModelDiscovery === 'function') {
    try {
      const inputModalities = cfg.imageInput ? ['text', 'image'] : ['text']
      ctx.llm.registerModelDiscovery('dsh-antigravity-gateway', async (_request, signal) => {
        const definitions = await catalog.list(signal)
        return definitions.map((definition) => ({
          id: definition.id,
          name: definition.name,
          contextWindow: definition.contextWindow,
          maxTokens: definition.routes['']?.maxOutputTokens ?? definition.routes[Object.keys(definition.routes)[0]!]!.maxOutputTokens,
          inputModalities,
        }))
      })
    } catch (error) {
      logger.warn('plugin', 'registerModelDiscovery note', { error: String(error).slice(0, 200) })
    }
  }

  ctx.effect(() =>
    registerCommands(ctx, {
      account,
      accountMode,
      loginTimeoutMs: cfg.loginTimeoutMs,
      logger,
    }),
  )

  ctx.effect(() => registerAccountAccess(ctx, account, logger))

  if (cfg.promptCompatibility) {
    ctx.effect(() => mountPromptCompatibility(ctx, (provider) => providers.includes(provider), logger))
  }

  // Warm the catalog once signed in; failures stay advisory.
  void auth.status().then(async (status) => {
    if (!status.loggedIn) {
      logger.info('plugin', 'no stored credential; run /agw login or /agw import')
      return
    }
    try {
      const definitions = await catalog.list()
      logger.info('plugin', 'catalog ready', { models: definitions.length })
    } catch (error) {
      logger.warn('plugin', 'initial catalog refresh failed', { error: String(error).slice(0, 200) })
    }
  })
}
