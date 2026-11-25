/**
 * DSH LLM adapter for the Antigravity Cloud Code wire protocol.
 *
 * One adapter instance owns the configured provider routes. It resolves the
 * account credential, builds the CLI-shaped envelope, streams SSE events into
 * DSH chunks, and classifies failures into the provider-neutral taxonomy.
 */
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AuthManager } from '../core/auth.js'
import type { ModelCatalog } from '../core/catalog.js'
import type { GatewayLogger } from '../core/logger.js'
import { noopLogger } from '../core/logger.js'
import { AgyTransport, cancelResponse, readBoundedText } from '../core/transport/index.js'
import { PATH_STREAM } from '../protocol/constants.js'
import { MODEL_DEFINITIONS, resolveRoute, type ResolvedRoute } from '../protocol/models.js'
import { buildEnvelope, requestSessionKey, RequestSessionStore, type PayloadRequest } from '../protocol/payload.js'
import {
  GatewayError,
  isGatewayError,
  parseRetryAfterMs,
  reportsContextOverflow,
  reportsModelCapacity,
  sanitizeProviderText,
  statusToError,
} from '../shared/errors.js'
import { abortedChunk, assembleStreamChunks, toLlmError } from './stream-assembler.js'
import type { AttachmentsServiceLike } from './types.js'

export { toLlmError }
export type { AttachmentsServiceLike }

const MAX_CAPACITY_RETRIES = 2
const CAPACITY_RETRY_BASE_DELAY_MS = 1500
const CAPACITY_RETRY_MAX_DELAY_MS = 8000
const MAX_ERROR_BODY_BYTES = 64 * 1024

export interface AdapterOptions {
  providers: readonly string[]
  auth: AuthManager
  catalog: ModelCatalog
  transport: AgyTransport
  endpoints: readonly string[]
  logger?: GatewayLogger
  /** Resolves the DSH attachments service lazily (image input). */
  getAttachments?: () => AttachmentsServiceLike | undefined
  imageInput?: boolean
  maxImageBytes?: number
  /** Diagnostic: append every outgoing envelope to this file. Never default. */
  dumpRequestsTo?: string
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new GatewayError('The Antigravity request was cancelled', 'ABORTED'))
      },
      { once: true },
    )
  })
}

export class AntigravityGatewayAdapter extends LlmAdapter {
  private readonly options: AdapterOptions
  private readonly logger: GatewayLogger
  private readonly sessions = new RequestSessionStore()

  constructor(options: AdapterOptions) {
    super()
    this.options = options
    this.logger = options.logger ?? noopLogger
  }

  private owns(provider: string): boolean {
    return this.options.providers.includes(provider)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (!this.owns(provider)) throw new LlmError('Unknown Antigravity gateway provider route', 'NO_ADAPTER')
    return { id: provider, name: 'Antigravity Gateway' }
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    let definitions
    try {
      definitions = await this.options.catalog.list(signal)
    } catch (error) {
      // Before sign-in (or when discovery is unavailable) the selector still
      // shows the advisory pinned snapshot; requests carry the login hint.
      if (isGatewayError(error) && error.code === 'AUTH') {
        definitions = MODEL_DEFINITIONS
      } else {
        throw error
      }
    }
    const inputModalities = this.options.imageInput === false ? (['text'] as const) : (['text', 'image'] as const)
    return definitions.map((definition) => {
      const detail = this.options.catalog.getModelDetail?.(definition.id)
      const exhausted = detail !== undefined && 'status' in detail && detail.status === 'quota-exhausted'
      return {
        provider,
        id: definition.id,
        name: definition.name,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        inputModalities,
        ...(exhausted
          ? { badge: { text: { en: 'Quota 0%', zh: '配额已用尽' }, tone: 'warning' as const } }
          : {}),
      }
    })
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider)
    let resolved: ResolvedRoute
    try {
      resolved = resolveRoute(model)
    } catch (error) {
      throw toLlmError(error)
    }
    const definition = resolved.definition
    const inputModalities = this.options.imageInput === false ? (['text'] as const) : (['text', 'image'] as const)
    return {
      provider,
      id: definition.id,
      name: definition.name,
      ...(definition.description !== undefined ? { description: definition.description } : {}),
      inputModalities,
      context: { contextWindow: definition.contextWindow },
      defaultMaxTokens: resolved.route.maxOutputTokens,
      ...(definition.efforts.length > 0
        ? {
            reasoning: {
              efforts: definition.efforts.map((effort) => ({ id: effort.id as ReasoningEffortId, name: effort.name })),
              ...(definition.defaultEffort !== undefined ? { defaultEffort: definition.defaultEffort as ReasoningEffortId } : {}),
            },
          }
        : {}),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.owns(options.provider)) {
      throw new LlmError('The Antigravity gateway received an unknown provider route', 'NO_ADAPTER')
    }
    const signal = options.signal
    if (signal?.aborted) {
      yield abortedChunk()
      return
    }
    let resolved: ResolvedRoute
    try {
      resolved = resolveRoute(options.model, options.reasoningEffort)
    } catch (error) {
      throw toLlmError(error)
    }

    const hasEmitted = { value: false }
    let authReplayed = false
    let capacityAttempt = 0
    const startedAt = Date.now()

    for (;;) {
      let credential
      try {
        credential = await this.options.auth.getCredential(signal, authReplayed)
      } catch (error) {
        throw toLlmError(error)
      }
      if (!credential) {
        throw new LlmError('Antigravity login is required; run /agw login (or /agw import)', 'AUTH')
      }

      const sessionKey = requestSessionKey(options.sessionId)
      const scope = this.sessions.beginRequest(sessionKey)
      const payloadRequest: PayloadRequest = {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        messages: options.messages as unknown as PayloadRequest['messages'],
        ...(options.system !== undefined ? { system: options.system } : {}),
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.stop !== undefined ? { stop: options.stop } : {}),
        ...(options.sessionId !== undefined ? { sessionId: String(options.sessionId) } : {}),
      }

      let envelope
      try {
        envelope = await buildEnvelope({
          request: payloadRequest,
          resolved,
          ...(credential.projectId !== undefined ? { projectId: credential.projectId } : {}),
          session: scope.session,
          timestamp: scope.timestamp,
          resolveImage: this.imageResolver(signal),
        })
      } catch (error) {
        throw toLlmError(error)
      }

      if (this.options.dumpRequestsTo) {
        try {
          const { appendFile } = await import('node:fs/promises')
          await appendFile(this.options.dumpRequestsTo, `${JSON.stringify(envelope)}\n`, 'utf8')
        } catch {
          // Diagnostic dump is best-effort.
        }
      }

      const body = JSON.stringify(envelope)
      let response: Response | undefined
      let lastTransportError: unknown
      for (const endpoint of this.options.endpoints) {
        try {
          response = await this.options.transport.request({
            url: `${endpoint}${PATH_STREAM}?alt=sse`,
            accessToken: credential.accessToken!,
            body,
            ...(signal !== undefined ? { signal } : {}),
          })
          lastTransportError = undefined
          break
        } catch (error) {
          lastTransportError = error
          if (isGatewayError(error) && error.code === 'ABORTED') throw toLlmError(error)
          this.logger.warn('request', 'endpoint transport failure; trying fallback', {
            endpoint,
            error: String(error).slice(0, 200),
          })
        }
      }
      if (response === undefined) {
        throw toLlmError(lastTransportError ?? new GatewayError('All Antigravity endpoints failed', 'TRANSPORT'))
      }

      if (!response.ok) {
        const status = response.status
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'))
        const errorText = sanitizeProviderText(await readBoundedText(response, MAX_ERROR_BODY_BYTES, signal).catch(() => ''))
        await cancelResponse(response)

        if ((status === 401 || status === 403) && !authReplayed && !hasEmitted.value && !signal?.aborted) {
          authReplayed = true
          this.logger.info('request', 'credential rejected; refreshing once', { status })
          continue
        }
        if (status === 429) {
          const failure = statusToError(status, errorText || 'Antigravity rate limit reached', retryAfter)
          this.logFailure(resolved, startedAt, failure)
          throw toLlmError(failure)
        }
        if (status === 400 && reportsContextOverflow(errorText)) {
          const failure = new GatewayError('The request exceeded the model context window', 'CONTEXT_WINDOW_EXCEEDED', { status })
          this.logFailure(resolved, startedAt, failure)
          throw toLlmError(failure)
        }
        if (
          status === 503 &&
          capacityAttempt < MAX_CAPACITY_RETRIES &&
          !hasEmitted.value &&
          !signal?.aborted &&
          reportsModelCapacity(errorText)
        ) {
          capacityAttempt += 1
          const delay = Math.min(CAPACITY_RETRY_BASE_DELAY_MS * 2 ** (capacityAttempt - 1), CAPACITY_RETRY_MAX_DELAY_MS)
          this.logger.info('request', 'model at capacity; backing off', { attempt: capacityAttempt, delayMs: delay })
          await sleep(delay, signal)
          continue
        }
        if (status === 404) {
          const unsupported = await this.diagnoseUnavailableModel(resolved.modelId, signal)
          if (unsupported !== undefined) {
            this.logFailure(resolved, startedAt, unsupported)
            throw unsupported
          }
        }
        const failure = statusToError(status, errorText)
        this.logFailure(resolved, startedAt, failure)
        throw toLlmError(failure)
      }

      try {
        yield* assembleStreamChunks({
          response,
          ...(signal !== undefined ? { signal } : {}),
          idleTimeoutMs: this.options.transport.idleTimeoutMs,
          resolved,
          hasEmitted,
          startedAt,
          logger: this.logger,
        })
        return
      } catch (error) {
        if (isGatewayError(error) && error.code === 'AUTH' && !authReplayed && !hasEmitted.value && !signal?.aborted) {
          authReplayed = true
          continue
        }
        this.logFailure(resolved, startedAt, error)
        throw toLlmError(error)
      }
    }
  }

  private imageResolver(signal?: AbortSignal) {
    if (this.options.imageInput === false) return undefined
    const maxBytes = this.options.maxImageBytes ?? 10 * 1024 * 1024
    return async (attachment: unknown) => {
      const attachments = this.options.getAttachments?.()
      if (!attachments || attachment === undefined || attachment === null) return undefined
      try {
        const stored = await attachments.readImage(attachment, signal)
        if (!stored?.data || stored.data.byteLength === 0 || stored.data.byteLength > maxBytes) return undefined
        return { data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType }
      } catch {
        return undefined
      }
    }
  }

  private async diagnoseUnavailableModel(modelId: string, signal?: AbortSignal): Promise<LlmError | undefined> {
    try {
      let detail = this.options.catalog.getModelDetail?.(modelId)
      if (detail === undefined && typeof this.options.catalog.getAvailabilityReport === 'function') {
        const report = await this.options.catalog.getAvailabilityReport({ force: true, ...(signal ? { signal } : {}) })
        detail = report.unavailable.find((item) => item.id === modelId)
      }
      if (detail && ('status' in detail) && (detail.status === 'disabled' || detail.status === 'not-offered')) {
        const parts = [detail.reasonTitle, detail.reasonDetail].filter((item): item is string => typeof item === 'string' && item.length > 0)
        const suffix = parts.length > 0 ? `: ${parts.join(' — ')}` : ''
        return new LlmError(`Model "${modelId}" is not available on this account${suffix}`, 'MODEL_UNSUPPORTED', { status: 404 })
      }
    } catch {
      // Fall back to standard HTTP_404 if availability lookup itself fails.
    }
    return undefined
  }

  private logFailure(resolved: ResolvedRoute, startedAt: number, error: unknown): void {
    const code = isGatewayError(error) ? error.code : error instanceof LlmError ? error.code : 'UNKNOWN'
    const status = isGatewayError(error) ? error.status : error instanceof LlmError ? error.failure.status : undefined
    this.logger.warn('request', 'failed', {
      model: resolved.modelId,
      wire: resolved.route.wire,
      durationMs: Date.now() - startedAt,
      code,
      ...(status !== undefined ? { status } : {}),
    })
  }
}

/** @deprecated Use {@link AntigravityGatewayAdapter}. Kept during 0.x for compatibility. */
export const AntigravityBridgeAdapter = AntigravityGatewayAdapter
/** @deprecated Use {@link AntigravityGatewayAdapter}. Kept during 0.x for compatibility. */
export type AntigravityBridgeAdapter = AntigravityGatewayAdapter
