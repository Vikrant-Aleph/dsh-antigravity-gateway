/**
 * DSH LLM adapter for the Antigravity Cloud Code wire protocol.
 *
 * One adapter instance owns the configured provider routes. It resolves the
 * account credential, builds the CLI-shaped envelope, streams SSE events into
 * DSH chunks, and classifies failures into the provider-neutral taxonomy.
 */
import { randomUUID } from 'node:crypto'
import {
  LlmAdapter,
  LlmError,
  type BuiltinLlmFailureCode,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type ToolCallId,
  type ReasoningEffortId,
  type ReplayEnvelope,
} from '@deepseek-ai/dsh-llm'
import { PATH_STREAM } from './constants.js'
import {
  BridgeError,
  isBridgeError,
  parseRetryAfterMs,
  reportsContextOverflow,
  reportsModelCapacity,
  sanitizeProviderText,
  statusToError,
} from './errors.js'
import type { BridgeLogger } from './logger.js'
import { noopLogger } from './logger.js'
import { resolveRoute, type ResolvedRoute } from './models.js'
import { buildEnvelope, requestSessionKey, RequestSessionStore, type PayloadRequest } from './payload.js'
import { mapFinishReason, parseProviderEvent, type ProviderUsage } from './response.js'
import { AgyTransport, cancelResponse, iterateSse, readBoundedText } from './transport.js'
import type { AuthManager } from './auth.js'
import type { ModelCatalog } from './catalog.js'

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
  logger?: BridgeLogger
  /** Resolves the DSH attachments service lazily (image input). */
  getAttachments?: () => AttachmentsServiceLike | undefined
  imageInput?: boolean
  maxImageBytes?: number
  /** Diagnostic: append every outgoing envelope to this file. Never default. */
  dumpRequestsTo?: string
}

export interface AttachmentsServiceLike {
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; ref: { mediaType: string } }>
}

interface BlockState {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  providerId?: string
  name?: string
  signature?: string
}

/** Convert a BridgeError into the DSH failure taxonomy. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (isBridgeError(error)) {
    const code = mapCode(error.code)
    return new LlmError(error.message, code, {
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.providerRetryAfterMs !== undefined && error.providerRetryAfterMs > 0
        ? { providerRetryAfterMs: error.providerRetryAfterMs }
        : {}),
      cause: error,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new LlmError(message || 'Unknown Antigravity failure', 'UNKNOWN', { cause: error })
}

function mapCode(code: string): BuiltinLlmFailureCode {
  switch (code) {
    case 'INVALID_MODEL':
      return 'UNKNOWN_MODEL'
    case 'PROTOCOL_DRIFT':
      return 'MALFORMED_RESPONSE'
    case 'CANCELLED':
      return 'ABORTED'
    default:
      return code as BuiltinLlmFailureCode
  }
}

function abortedChunk(): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message: 'The Antigravity request was cancelled', code: 'ABORTED' } } }
}

function errorChunk(error: unknown): StreamChunk {
  const llmError = toLlmError(error)
  return { type: 'finish', reason: { kind: 'error', failure: llmError.failure } }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new BridgeError('The Antigravity request was cancelled', 'ABORTED'))
      },
      { once: true },
    )
  })
}

export class AntigravityBridgeAdapter extends LlmAdapter {
  private readonly options: AdapterOptions
  private readonly logger: BridgeLogger
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
    if (!this.owns(provider)) throw new LlmError('Unknown Antigravity bridge provider route', 'NO_ADAPTER')
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
      if (isBridgeError(error) && error.code === 'AUTH') {
        const { MODEL_DEFINITIONS } = await import('./models.js')
        definitions = MODEL_DEFINITIONS
      } else {
        throw error
      }
    }
    return definitions.map((definition) => {
      const detail = this.options.catalog.getModelDetail?.(definition.id)
      const exhausted = detail !== undefined && 'status' in detail && detail.status === 'quota-exhausted'
      return {
        provider,
        id: definition.id,
        name: definition.name,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        inputModalities: ['text', 'image'] as const,
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
    return {
      provider,
      id: definition.id,
      name: definition.name,
      ...(definition.description !== undefined ? { description: definition.description } : {}),
      inputModalities: ['text', 'image'] as const,
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
      throw new LlmError('The Antigravity bridge received an unknown provider route', 'NO_ADAPTER')
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
          const { appendFileSync } = await import('node:fs')
          appendFileSync(this.options.dumpRequestsTo, `${JSON.stringify(envelope)}\n`, 'utf8')
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
          if (isBridgeError(error) && error.code === 'ABORTED') throw toLlmError(error)
          this.logger.warn('request', 'endpoint transport failure; trying fallback', {
            endpoint,
            error: String(error).slice(0, 200),
          })
        }
      }
      if (response === undefined) {
        throw toLlmError(lastTransportError ?? new BridgeError('All Antigravity endpoints failed', 'TRANSPORT'))
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
          const failure = new BridgeError('The request exceeded the model context window', 'CONTEXT_WINDOW_EXCEEDED', { status })
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
        yield* this.streamResponse(response, options, resolved, hasEmitted, startedAt)
        return
      } catch (error) {
        if (isBridgeError(error) && error.code === 'AUTH' && !authReplayed && !hasEmitted.value && !signal?.aborted) {
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

  private async *streamResponse(
    response: Response,
    options: GenerateOptions,
    resolved: ResolvedRoute,
    hasEmitted: { value: boolean },
    startedAt: number,
  ): AsyncIterable<StreamChunk> {
    const states: BlockState[] = []
    let current: BlockState | undefined
    let usage: ProviderUsage | undefined
    let finish: string | undefined
    let eventError: { message: string; code?: string | number; status?: number; contextWindowExceeded?: boolean } | undefined
    let pendingSignature: string | undefined
    let sawToolCall = false
    let nextIndex = 0

    const endBlock = (state: BlockState): StreamChunk => {
      if (state.kind === 'tool-call') {
        return {
          type: 'block-end',
          index: state.index,
          block: {
            type: 'tool-call',
            id: (state.id ?? `call_${state.index}`) as ToolCallId,
            name: state.name ?? '',
            arguments: state.text,
          },
        }
      }
      return {
        type: 'block-end',
        index: state.index,
        block: state.kind === 'reasoning' ? { type: 'reasoning', text: state.text } : { type: 'text', text: state.text },
      }
    }

    for await (const sse of iterateSse(response, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      idleTimeoutMs: this.options.transport.idleTimeoutMs,
    })) {
      if (sse.data.trim() === '[DONE]') continue
      const event = parseProviderEvent(sse.data)
      if (event.error !== undefined) {
        eventError = event.error
        break
      }
      if (event.usage !== undefined) usage = event.usage
      if (event.finish !== undefined) finish = event.finish
      for (const part of event.parts) {
        if (part.kind !== 'tool-call' && part.text.length === 0) {
          if (part.signature !== undefined) pendingSignature = part.signature
          continue
        }
        if (current === undefined || shouldStartNewBlock(current, part)) {
          if (current !== undefined) yield endBlock(current)
          current = {
            index: nextIndex++,
            kind: part.kind,
            text: '',
            ...(part.kind === 'tool-call'
              ? {
                  id: part.id ?? `call_${randomUUID().slice(0, 12)}`,
                  ...(part.id !== undefined ? { providerId: part.id } : {}),
                  name: part.name,
                }
              : {}),
          }
          if (current.signature === undefined && pendingSignature !== undefined) current.signature = pendingSignature
          pendingSignature = undefined
          states.push(current)
          yield { type: 'block-start', index: current.index, blockType: current.kind }
        }
        if (part.kind === 'tool-call') {
          sawToolCall = true
          if (part.name !== undefined && current.name === undefined) current.name = part.name
          current.text += part.arguments ?? ''
          if (part.signature !== undefined) current.signature = part.signature
          hasEmitted.value = true
          yield {
            type: 'tool-call-delta',
            index: current.index,
            id: (current.id ?? `call_${current.index}`) as ToolCallId,
            ...(part.name !== undefined ? { name: part.name } : {}),
            argumentsDelta: part.arguments ?? '',
          }
        } else if (part.kind === 'reasoning') {
          current.text += part.text
          if (part.signature !== undefined) current.signature = part.signature
          if (part.text.length > 0) {
            hasEmitted.value = true
            yield { type: 'reasoning-delta', index: current.index, text: part.text }
          }
        } else {
          current.text += part.text
          if (part.text.length > 0) {
            hasEmitted.value = true
            yield { type: 'text-delta', index: current.index, text: part.text }
          }
        }
      }
    }

    if (current !== undefined) yield endBlock(current)
    if (usage !== undefined) yield { type: 'usage', usage }

    if (eventError !== undefined) {
      const code = eventError.contextWindowExceeded === true
        ? 'CONTEXT_WINDOW_EXCEEDED'
        : typeof eventError.status === 'number' && eventError.status >= 400
          ? `HTTP_${eventError.status}`
          : 'UNKNOWN'
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: eventError.message,
            code,
            ...(eventError.status !== undefined ? { status: eventError.status } : {}),
          },
        },
      }
      return
    }
    if (options.signal?.aborted) {
      yield abortedChunk()
      return
    }
    if (states.length === 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Antigravity returned no content', code: 'EMPTY_RESPONSE' } } }
      return
    }

    // Carry the last reasoning signature onto tool calls that lack one.
    let lastReasoningSignature = pendingSignature
    for (const state of states) {
      if (state.kind === 'reasoning' && state.signature !== undefined) lastReasoningSignature = state.signature
      else if (state.kind === 'tool-call' && state.signature === undefined && lastReasoningSignature !== undefined) {
        state.signature = lastReasoningSignature
      }
    }
    const replayState: ReplayEnvelope = {
      response: { wireModel: resolved.route.wire, finishReason: finish ?? 'STOP' },
      blocks: states.map((state) => ({
        kind: state.kind,
        ...(state.signature !== undefined ? { signature: state.signature } : {}),
      })),
    }
    const kind = mapFinishReason(finish, sawToolCall)
    this.logger.info('request', 'completed', {
      model: resolved.modelId,
      wire: resolved.route.wire,
      durationMs: Date.now() - startedAt,
      blocks: states.length,
      finish: finish ?? 'STOP',
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
    })
    if (kind === 'error') {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `Antigravity stopped: ${finish}`, code: 'CONTENT_REFUSED' } },
        replayState,
      }
      return
    }
    yield { type: 'finish', reason: { kind }, replayState }
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
    const code = isBridgeError(error) ? error.code : error instanceof LlmError ? error.code : 'UNKNOWN'
    const status = isBridgeError(error) ? error.status : error instanceof LlmError ? error.failure.status : undefined
    this.logger.warn('request', 'failed', {
      model: resolved.modelId,
      wire: resolved.route.wire,
      durationMs: Date.now() - startedAt,
      code,
      ...(status !== undefined ? { status } : {}),
    })
  }
}

function shouldStartNewBlock(
  current: BlockState,
  part: { kind: string; id?: string; name?: string },
): boolean {
  if (current.kind !== part.kind) return true
  if (part.kind !== 'tool-call') return false
  // Every complete Antigravity functionCall carries its full args object; once a
  // tool-call block already holds JSON text, any subsequent call (even to the
  // same tool name) must open a new block rather than concatenating JSON.
  if (current.text.length > 0) return true
  if (part.id !== undefined && current.providerId !== undefined && part.id !== current.providerId) return true
  if (part.name !== undefined && current.name !== undefined && part.name !== current.name) return true
  return false
}
