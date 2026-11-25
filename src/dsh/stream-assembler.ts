/**
 * SSE stream → DSH StreamChunk state machine and error taxonomy mapping.
 */
import { randomUUID } from 'node:crypto'
import {
  LlmError,
  type BuiltinLlmFailureCode,
  type ReplayEnvelope,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GatewayLogger } from '../core/logger.js'
import { iterateSse } from '../core/transport/index.js'
import type { ResolvedRoute } from '../protocol/models.js'
import { mapFinishReason, parseProviderEvent, type ProviderUsage } from '../protocol/response.js'
import { isGatewayError } from '../shared/errors.js'

interface BlockState {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  providerId?: string
  name?: string
  signature?: string
}

/** Convert a GatewayError into the DSH failure taxonomy. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (isGatewayError(error)) {
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

export function abortedChunk(): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message: 'The Antigravity request was cancelled', code: 'ABORTED' } } }
}

export async function* assembleStreamChunks(options: {
  response: Response
  signal?: AbortSignal
  idleTimeoutMs: number
  resolved: ResolvedRoute
  hasEmitted: { value: boolean }
  startedAt: number
  logger: GatewayLogger
}): AsyncIterable<StreamChunk> {
  const { response, signal, idleTimeoutMs, resolved, hasEmitted, startedAt, logger } = options
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
    ...(signal !== undefined ? { signal } : {}),
    idleTimeoutMs,
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
  if (signal?.aborted) {
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
  logger.info('request', 'completed', {
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
