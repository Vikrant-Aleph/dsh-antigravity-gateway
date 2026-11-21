/**
 * dsh-antigravity-gateway: Google Antigravity models for DeepSeek Harness.
 *
 * Registers an LLM adapter that speaks the Antigravity (Cloud Code Assist)
 * client wire protocol, with self-contained Google OAuth, a settings page,
 * and a per-account live model catalog with no client-side retirement gate.
 */
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_PROD, DEFAULT_OAUTH_PORT } from './constants.js'
import { PluginLogger, defaultLogDir, type LogLevel } from './logger.js'
import { LogService, registerLogAccess } from './log-service.js'
import { CredentialStore, defaultCredentialFile, type CredentialsServiceLike } from './credentials.js'
import { AgyTransport } from './transport.js'
import { AuthManager } from './auth.js'
import { ModelCatalog } from './catalog.js'
import { AntigravityBridgeAdapter, type AttachmentsServiceLike } from './adapter.js'
import { AccountService, registerAccountAccess, accountModeFor } from './account-service.js'
import { mountPromptCompatibility } from './prompt-compat.js'
import { registerCommands } from './commands.js'

export { AntigravityBridgeAdapter } from './adapter.js'
export { ModelCatalog, parseLiveCatalog, parseLiveModelIds, parseQuotaSummary, definitionAvailable } from './catalog.js'
export { AuthManager } from './auth.js'
export { CredentialStore } from './credentials.js'
export { PluginLogger, defaultLogDir, noopLogger } from './logger.js'
export { LogService, registerLogAccess } from './log-service.js'
export { AgyTransport, iterateSse, readBoundedText, proxyFromEnv, noProxyMatches } from './transport.js'
export * from './models.js'
export * from './payload.js'
export * from './response.js'
export * from './errors.js'
export { buildAuthorizationUrl, exchangeCode, refreshAccessToken, startCallbackServer } from './oauth.js'
export { compatiblePromptAssembly, replaceContextProse } from './prompt-compat.js'
export { AccountService, registerAccountAccess, accountModeFor, ACCOUNT_RPC_NAMESPACE } from './account-service.js'

export const Config = Schema.object({
  /** Provider routes this adapter owns. Keep distinct from other Antigravity plugins. */
  providers: Schema.array(Schema.string()).default(['antigravity-gateway']),
  /** Primary content endpoint. */
  endpoint: Schema.string().default(ANTIGRAVITY_ENDPOINT_DAILY),
  /** Fallback endpoints tried in order on transport failure. */
  fallbackEndpoints: Schema.array(Schema.string()).default([ANTIGRAVITY_ENDPOINT_PROD]),
  /** Loopback OAuth callback port (the redirect registered for the CLI client). */
  oauthPort: Schema.number().min(0).max(65535).step(1).default(DEFAULT_OAUTH_PORT),
  /** How long an interactive sign-in may wait for the browser callback. */
  loginTimeoutMs: Schema.number().min(10_000).max(1_800_000).step(1).default(300_000),
  /** Total per-request timeout (headers + streaming body). */
  requestTimeoutMs: Schema.number().min(1000).max(3_600_000).step(1).default(600_000),
  /** Max wait for response headers. */
  responseHeaderTimeoutMs: Schema.number().min(1000).max(1_800_000).step(1).default(180_000),
  /** Max stall between stream bytes. */
  idleTimeoutMs: Schema.number().min(1000).max(1_800_000).step(1).default(180_000),
  /** Live model catalog cache TTL. */
  catalogTtlMs: Schema.number().min(0).max(3_600_000).step(1).default(30_000),
  /** Pinned model ids always advertised, even when the live catalog omits them. */
  extraModels: Schema.array(Schema.string()).default([]),
  /** Rewrite the harness identity sentences that trigger endpoint 429 refusals. */
  promptCompatibility: Schema.boolean().default(true),
  /** Send durable image attachments as inlineData on image-capable routes. */
  imageInput: Schema.boolean().default(true),
  /** Per-image byte cap for inline input. */
  maxImageBytes: Schema.number().min(1).max(32 * 1024 * 1024).step(1).default(10 * 1024 * 1024),
  /** Explicit HTTP(S) proxy for private requests; empty reads HTTPS_PROXY etc. */
  proxyUrl: Schema.string().default(''),
  /** Fall back to the Windows per-user proxy settings when config/env name none. */
  useSystemProxy: Schema.boolean().default(true),
  logLevel: Schema.string().default('info'),
  logDir: Schema.string().default(''),
  logMaxBytes: Schema.number().min(256).default(512 * 1024),
  logMaxFiles: Schema.number().min(1).max(50).step(1).default(5),
  /** Fallback credential file when the host has no credentials service. */
  credentialFile: Schema.string().default(''),
  /** Diagnostic: append every outgoing request envelope to this file. Never enable by default. */
  dumpRequestsTo: Schema.string(),
})

export const name = 'dsh-antigravity-gateway'
export const inject = ['llm']

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'off']
function normalizeLevel(value: unknown): LogLevel {
  return LEVELS.includes(value as LogLevel) ? (value as LogLevel) : 'info'
}

/** Structural view of the Cordis context this plugin uses. */
interface HostContext {
  llm: {
    registerAdapter(providers: string[], adapter: unknown): (() => void) & { replace?: (providers: string[]) => void }
    registerConfigurableProviders?(entries: unknown[]): unknown
    registerModelDiscovery?(ns: string, discover: (request: unknown, signal?: AbortSignal) => Promise<unknown[]>): unknown
  }
  get?(name: string): unknown
  emit?(event: string, ...args: unknown[]): void
  inject(names: string[], callback: (ctx: HostContext) => (() => void) | void): { dispose?: () => void } | undefined
  effect(fn: () => (() => void) | void): unknown
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

export function apply(ctx: HostContext, config: Record<string, unknown>): void {
  const cfg = config as {
    providers: string[]
    endpoint: string
    fallbackEndpoints: string[]
    oauthPort: number
    loginTimeoutMs: number
    requestTimeoutMs: number
    responseHeaderTimeoutMs: number
    idleTimeoutMs: number
    catalogTtlMs: number
    extraModels: string[]
    promptCompatibility: boolean
    imageInput: boolean
    maxImageBytes: number
    proxyUrl: string
    useSystemProxy: boolean
    logLevel: string
    logDir: string
    logMaxBytes: number
    logMaxFiles: number
    credentialFile: string
    dumpRequestsTo?: string
  }

  const logger = new PluginLogger({
    level: normalizeLevel(cfg.logLevel),
    dir: cfg.logDir || defaultLogDir(),
    maxBytes: cfg.logMaxBytes,
    maxFiles: cfg.logMaxFiles,
    mirror: (line) => console.log(`[dsh-antigravity-gateway] ${line}`),
  })
  logger.info('plugin', 'starting', {
    providers: cfg.providers.join(','),
    endpoint: cfg.endpoint,
    logLevel: logger.getLevel(),
  })

  const logService = new LogService(logger)
  ctx.effect(() => registerLogAccess(ctx as never, logService))

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
  const auth = new AuthManager({ store, transport, logger, endpoints })

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
    logger,
  })
  const accountMode = accountModeFor(ctx.get?.('webServer') as { host?: string } | undefined)
  if (accountMode === 'blocked') {
    logger.warn('plugin', 'account controls blocked: WebServer is not loopback-bound')
  }

  const adapter = new AntigravityBridgeAdapter({
    providers,
    auth,
    catalog,
    transport,
    endpoints,
    logger,
    getAttachments: () => ctx.get?.('attachments') as AttachmentsServiceLike | undefined,
    imageInput: cfg.imageInput,
    maxImageBytes: cfg.maxImageBytes,
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
      ctx.llm.registerModelDiscovery('dsh-antigravity-gateway', async (_request, signal) => {
        const definitions = await catalog.list(signal)
        return definitions.map((definition) => ({
          id: definition.id,
          name: definition.name,
          contextWindow: definition.contextWindow,
          maxTokens: definition.routes['']?.maxOutputTokens ?? definition.routes[Object.keys(definition.routes)[0]!]!.maxOutputTokens,
          inputModalities: ['text', 'image'],
        }))
      })
    } catch (error) {
      logger.warn('plugin', 'registerModelDiscovery note', { error: String(error).slice(0, 200) })
    }
  }

  ctx.effect(() =>
    registerCommands(ctx as never, {
      account,
      accountMode,
      loginTimeoutMs: cfg.loginTimeoutMs,
      logger,
    }),
  )

  ctx.effect(() => registerAccountAccess(ctx as never, account, logger))

  if (cfg.promptCompatibility) {
    ctx.effect(() => mountPromptCompatibility(ctx as never, (provider) => providers.includes(provider), logger))
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
