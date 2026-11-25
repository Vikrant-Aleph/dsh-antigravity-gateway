/**
 * Lightweight structural views of DSH / Cordis host services used by the
 * adaptation layer (`src/dsh/`). Keeps compilation decoupled from private
 * host internals where structural contracts suffice.
 */
import type { CredentialsServiceLike } from '../core/credentials.js'

export type { CredentialsServiceLike }

export interface WebServerLike {
  host?: string
}

export interface AttachmentsServiceLike {
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; ref: { mediaType: string } }>
}

export interface RpcRouteDefinition {
  path: string
  methods: string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

export interface ConnectionServiceLike {
  fetch?: {
    register(route: RpcRouteDefinition): () => void
  }
}

export interface RpcConnectionContext {
  get?(name: string): unknown
  inject(names: string[], callback: (ctx: RpcConnectionContext) => (() => void) | void): { dispose?: () => void } | undefined
  connection?: ConnectionServiceLike
}

export type AccountAccessContext = RpcConnectionContext
export type LogAccessContext = RpcConnectionContext

export interface CommandDefinitionLike {
  name: string
  description: string
  input?: { hint: string }
  handler: (invocation: { rawInput: string }) => Promise<{ kind: 'success' | 'error'; text: string }>
}

export interface CommandContext {
  get?(name: string): unknown
}

export interface PromptCompatContext {
  inject(names: string[], callback: (ctx: PromptCompatContext) => (() => void) | void): { dispose?: () => void } | undefined
  on?(event: string, listener: (...args: never[]) => unknown): () => void
}

export interface HostContext {
  llm: {
    registerAdapter(providers: string[], adapter: unknown): (() => void) & { replace?: (providers: string[]) => void }
    registerConfigurableProviders?(entries: unknown[]): unknown
    registerModelDiscovery?(ns: string, discover: (request: unknown, signal?: AbortSignal) => Promise<unknown[]>): unknown
  }
  get?(name: string): unknown
  emit?(event: string, ...args: unknown[]): void
  on?(event: string, listener: (...args: never[]) => unknown): () => void
  inject(names: string[], callback: (ctx: HostContext) => (() => void) | void): { dispose?: () => void } | undefined
  effect(fn: () => (() => void) | void): unknown
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}
