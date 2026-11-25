/**
 * Unified `/api` JSON-RPC registration helper for DSH host services.
 *
 * Centralizes envelope parsing, method verification, error shaping, optional
 * loopback access policy, and complete Cordis fiber + route disposal.
 */
import type { GatewayLogger } from '../core/logger.js'
import { noopLogger } from '../core/logger.js'
import { isRecord } from '../shared/guards.js'
import { RPC_CHANNEL } from '../shared/rpc-contracts.js'
import type { RpcConnectionContext, WebServerLike } from './types.js'

export const LOOPBACK_REQUIRED_MESSAGE =
  'Antigravity account controls require a local DSH Host (no WebServer or 127.0.0.1-bound)'

/** Host activation policy for local-only controls (account & log RPC). */
export function accountModeFor(webServer: WebServerLike | undefined): 'enabled' | 'blocked' {
  if (webServer === undefined) return 'enabled'
  return webServer.host === '127.0.0.1' ? 'enabled' : 'blocked'
}

export class RpcBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcBadRequestError'
  }
}

export interface RegisterRpcOptions<E extends string> {
  namespace: string
  endpoints: readonly E[]
  requireLoopback?: boolean
  blockedLogScope?: string
  blockedLogMessage?: string
  logger?: GatewayLogger
  handle: (endpoint: E, payload: Record<string, unknown> | undefined) => Promise<unknown> | unknown
}

export function registerRpcNamespace<E extends string>(
  ctx: RpcConnectionContext,
  options: RegisterRpcOptions<E>,
): () => void {
  const logger = options.logger ?? noopLogger
  let disposeRoutes: (() => void) | undefined

  const fiber = ctx.inject(['connection'], (ctxWithConnection) => {
    const connection = ctxWithConnection.connection
    if (!connection?.fetch?.register) return () => {}
    const initialWebServer = ctxWithConnection.get?.('webServer') as WebServerLike | undefined
    const initialMode = options.requireLoopback ? accountModeFor(initialWebServer) : 'enabled'
    if (initialMode === 'blocked') {
      logger.warn(
        options.blockedLogScope ?? 'rpc',
        options.blockedLogMessage ?? `${options.namespace} RPC blocked: WebServer is not loopback-bound`,
        { host: initialWebServer?.host ?? '(unknown)' },
      )
    }

    const routeDisposers = options.endpoints.map((endpoint) =>
      connection.fetch!.register({
        path: `${RPC_CHANNEL}/${options.namespace}/${endpoint}`,
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

          if (method !== `${options.namespace}/${endpoint}`) {
            return failure('bad-request', `${options.namespace} request method does not match its endpoint`)
          }
          const mode = options.requireLoopback
            ? accountModeFor(ctxWithConnection.get?.('webServer') as WebServerLike | undefined)
            : 'enabled'
          if (mode === 'blocked') {
            return failure('loopback-required', LOOPBACK_REQUIRED_MESSAGE)
          }
          try {
            const payload = isRecord(record.payload) ? record.payload : undefined
            const value = await options.handle(endpoint, payload)
            return reply({ ok: true, value })
          } catch (error) {
            if (error instanceof RpcBadRequestError) {
              return failure('bad-request', error.message)
            }
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(options.blockedLogScope ?? 'rpc', `RPC ${endpoint} failed`, { error: message.slice(0, 200) })
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

  return () => {
    disposeRoutes?.()
    disposeRoutes = undefined
    void fiber?.dispose?.()
  }
}
