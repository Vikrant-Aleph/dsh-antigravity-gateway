/**
 * Single source of truth for the DSH plugin configuration schema and derived
 * TypeScript type. Eliminates duplicated manual assertions in `src/index.ts`.
 */
import Schema from '@deepseek-ai/schemastery'
import { ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_PROD, DEFAULT_OAUTH_PORT } from '../protocol/constants.js'
import { LOG_LEVELS, type LogLevel } from '../shared/rpc-contracts.js'

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
  /** Automatically switch to another signed-in account when quota is exhausted. */
  autoSwitchAccount: Schema.boolean().default(true),
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
  dumpRequestsTo: Schema.string().required(false),
})

type SchemaConfig = Schemastery.TypeT<typeof Config>
type KnownSchemaConfig = {
  [K in keyof SchemaConfig as string extends K ? never : K]: SchemaConfig[K]
}

export type GatewayConfig = Omit<KnownSchemaConfig, 'dumpRequestsTo'> & {
  dumpRequestsTo?: string
}

export function normalizeLogLevel(value: unknown): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(String(value)) ? (value as LogLevel) : 'info'
}

export function resolveGatewayConfig(raw: Record<string, unknown> = {}): GatewayConfig {
  return Config(raw) as GatewayConfig
}
