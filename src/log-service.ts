/**
 * Log service: one implementation, two callers.
 *
 * The read/stat/clear/level operations live here once and are reachable from
 * both the agent (`antigravity_gateway_log` tool) and package-private JSON RPC
 * routes under `/api/antigravity-gateway-logs/*` for a future settings UI.
 * Every byte served is already redacted by PluginLogger.
 */
import type { BridgeLogger, LogLevel } from './logger.js'
import { PluginLogger } from './logger.js'

export const REQUEST_DIAGNOSTICS_VERSION = 1

const RPC_NAMESPACE = 'antigravity-gateway-logs'
const RPC_CHANNEL = '/api'
const RPC_ENDPOINTS = ['read', 'stat', 'clear', 'level'] as const

export class LogService {
  private readonly logger: PluginLogger

  constructor(logger: PluginLogger) {
    this.logger = logger
  }

  read(level?: LogLevel, limit?: number): {
    lines: string[]
    truncated: boolean
    level: LogLevel
    dir: string
    totalBytes: number
    files: { name: string; bytes: number }[]
  } {
    const stat = this.logger.stat()
    const { lines, truncated } = this.logger.read({ ...(level ? { level } : {}), ...(limit ? { limit } : {}) })
    return { lines, truncated, level: stat.level, dir: stat.dir, totalBytes: stat.totalBytes, files: stat.files }
  }

  clear(): { removed: number } {
    const removed = this.logger.clear()
    this.logger.info('log-service', 'logs cleared on request', { removed })
    return { removed }
  }

  setLevel(level: LogLevel): { level: LogLevel } {
    this.logger.setLevel(level)
    this.logger.info('log-service', 'runtime log level changed', { level })
    return { level: this.logger.getLevel() }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'off'
}

/** Minimal structural views of the host services used here. */
export interface LogAccessContext {
  get?(name: string): unknown
  inject(names: string[], callback: (ctx: LogAccessContext) => (() => void) | void): unknown
  connection?: {
    fetch?: {
      register(route: {
        path: string
        methods: string[]
        requestBody: string
        fetch: (request: Request) => Promise<Response>
      }): () => void
    }
  }
}

interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => { type: string; text: string }[] }
  execute: (args: unknown) => Promise<{ text: string }>
}

/**
 * Register the RPC routes and the `antigravity_gateway_log` tool.
 * Returns one disposer for everything registered here.
 */
export function registerLogAccess(ctx: LogAccessContext, service: LogService): () => void {
  const disposers: (() => void)[] = []

  ctx.inject(['connection'], (ctxWithConnection) => {
    const connection = ctxWithConnection.connection
    if (!connection?.fetch?.register) return () => {}
    const routeDisposers = RPC_ENDPOINTS.map((endpoint) =>
      connection.fetch!.register({
        path: `${RPC_CHANNEL}/${RPC_NAMESPACE}/${endpoint}`,
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
          if (method !== `${RPC_NAMESPACE}/${endpoint}`) {
            return failure('bad-request', 'log request method does not match its endpoint')
          }
          const payload = isRecord(record.payload) ? record.payload : {}
          const level = payload.level
          if (level !== undefined && !isValidLevel(level)) return failure('bad-request', 'level must be debug|info|warn|error|off')
          const limit = payload.limit
          if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
            return failure('bad-request', 'limit must be a positive number')
          }
          try {
            let value: unknown
            if (endpoint === 'read') {
              value = service.read(isValidLevel(level) ? level : undefined, typeof limit === 'number' ? Math.floor(limit) : undefined)
            } else if (endpoint === 'stat') {
              const read = service.read()
              value = { level: read.level, dir: read.dir, totalBytes: read.totalBytes, files: read.files, lines: read.lines.length }
            } else if (endpoint === 'clear') {
              value = service.clear()
            } else {
              value = service.setLevel(isValidLevel(level) ? level : 'info')
            }
            return reply({ ok: true, value })
          } catch (error) {
            return failure('internal', error instanceof Error ? error.message : String(error))
          }
        },
      }),
    )
    return () => {
      for (const dispose of routeDisposers) void dispose()
    }
  })

  // Agent tool: same operations, so the model can pull its own diagnostics.
  const tools = ctx.get?.('tools') as { register(definition: ToolDefinitionLike): () => void } | undefined
  if (tools?.register) {
    try {
      disposers.push(
        tools.register({
          name: 'antigravity_gateway_log',
          description:
            'Read or manage the dsh-antigravity-gateway plugin diagnostic log (the log of the Antigravity model adapter). ' +
            'Use action "read" to fetch recent log lines, "stat" for file sizes and the current level, ' +
            '"level" to change the runtime verbosity (debug|info|warn|error|off), and "clear" to delete all log files. ' +
            'Log lines are already scrubbed of credentials and message content.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['read', 'stat', 'clear', 'level'], description: 'Which operation to run.' },
              level: { type: 'string', enum: ['debug', 'info', 'warn', 'error', 'off'], description: 'Minimum level for read, or the new level for the level action.' },
              limit: { type: 'integer', description: 'Maximum log lines to return for read (default 500).' },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: { text: { type: 'string', description: 'Human-readable operation result.' } },
              required: ['text'],
              additionalProperties: false,
            },
            render: (_args, value) => {
              const text = isRecord(value) && typeof value.text === 'string' ? value.text : JSON.stringify(value)
              return [{ type: 'text', text }]
            },
          },
          execute: async (args) => {
            const input = isRecord(args) ? args : {}
            const action = typeof input.action === 'string' ? input.action : ''
            const level = isValidLevel(input.level) ? input.level : undefined
            const limit = typeof input.limit === 'number' ? input.limit : undefined
            if (action === 'read') {
              const read = service.read(level, limit)
              const header = `# ${read.lines.length} line(s), level>=${level ?? 'debug'}, ${read.totalBytes} bytes in ${read.dir}`
              return { text: [header, ...(read.truncated ? ['# (truncated to the newest lines)'] : []), ...read.lines].join('\n') }
            }
            if (action === 'stat') {
              const read = service.read()
              const files = read.files.map((f) => `  ${f.name}: ${f.bytes} bytes`).join('\n')
              return {
                text: [
                  `dir: ${read.dir}`,
                  `level: ${read.level}`,
                  `total: ${read.totalBytes} bytes`,
                  `records: ${read.lines.length}`,
                  `request diagnostics: v${REQUEST_DIAGNOSTICS_VERSION} (failures at warn; successes at info; per-request detail at debug)`,
                  `files:`,
                  files || '  (none)',
                ].join('\n'),
              }
            }
            if (action === 'level') {
              const next = service.setLevel(level ?? 'info')
              return { text: `runtime log level is now ${next.level}` }
            }
            if (action === 'clear') {
              const result = service.clear()
              return { text: `removed ${result.removed} log file(s)` }
            }
            return { text: `unknown action "${action}" — expected read|stat|clear|level` }
          },
        }),
      )
    } catch {
      // Tools service unavailable; the RPC path still works.
    }
  }

  return () => {
    for (const dispose of disposers) void dispose()
  }
}

export { RPC_NAMESPACE, RPC_CHANNEL }
export type { BridgeLogger }
