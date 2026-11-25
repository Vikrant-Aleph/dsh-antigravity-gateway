/**
 * Log service: one implementation, two callers (`antigravity_gateway_log`
 * tool + `/api/antigravity-gateway-logs/*` JSON-RPC routes).
 */
import type { GatewayLogger, LogLevel, PluginLogger } from '../core/logger.js'
import { isRecord } from '../shared/guards.js'
import {
  LOG_ENDPOINTS,
  LOG_RPC_NAMESPACE,
  REQUEST_DIAGNOSTICS_VERSION,
  RPC_CHANNEL,
  isValidLogLevel,
  type LogReadResult,
  type LogStatResult,
} from '../shared/rpc-contracts.js'
import { RpcBadRequestError, registerRpcNamespace } from './rpc.js'
import type { LogAccessContext } from './types.js'

export { LOG_RPC_NAMESPACE, LOG_RPC_NAMESPACE as RPC_NAMESPACE, REQUEST_DIAGNOSTICS_VERSION, RPC_CHANNEL }
export type { GatewayLogger, LogAccessContext }

export class LogService {
  private readonly logger: PluginLogger

  constructor(logger: PluginLogger) {
    this.logger = logger
  }

  read(level?: LogLevel, limit?: number): LogReadResult {
    const stat = this.logger.stat()
    const { lines, truncated } = this.logger.read({ ...(level ? { level } : {}), ...(limit ? { limit } : {}) })
    return { lines, truncated, level: stat.level, dir: stat.dir, totalBytes: stat.totalBytes, files: stat.files }
  }

  stat(): LogStatResult {
    const stat = this.logger.stat()
    return {
      level: stat.level,
      dir: stat.dir,
      totalBytes: stat.totalBytes,
      files: stat.files,
      lines: stat.recordCount,
    }
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
export function registerLogAccess(
  ctx: LogAccessContext,
  service: LogService,
  options: { requireLoopback?: boolean } = {},
): () => void {
  const disposers: (() => void)[] = []

  disposers.push(
    registerRpcNamespace(ctx, {
      namespace: LOG_RPC_NAMESPACE,
      endpoints: LOG_ENDPOINTS,
      requireLoopback: options.requireLoopback ?? false,
      blockedLogScope: 'log-service',
      blockedLogMessage: 'log RPC blocked: WebServer is not loopback-bound',
      handle: (endpoint, payload) => {
        const input = payload ?? {}
        const level = input.level
        if (level !== undefined && !isValidLogLevel(level)) {
          throw new RpcBadRequestError('level must be debug|info|warn|error|off')
        }
        const limit = input.limit
        if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
          throw new RpcBadRequestError('limit must be a positive number')
        }
        if (endpoint === 'read') {
          return service.read(isValidLogLevel(level) ? level : undefined, typeof limit === 'number' ? Math.floor(limit) : undefined)
        }
        if (endpoint === 'stat') {
          return service.stat()
        }
        if (endpoint === 'clear') {
          return service.clear()
        }
        return service.setLevel(isValidLogLevel(level) ? level : 'info')
      },
    }),
  )

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
            const level = isValidLogLevel(input.level) ? input.level : undefined
            const limit = typeof input.limit === 'number' ? input.limit : undefined
            if (action === 'read') {
              const read = service.read(level, limit)
              const header = `# ${read.lines.length} line(s), level>=${level ?? 'debug'}, ${read.totalBytes} bytes in ${read.dir}`
              return { text: [header, ...(read.truncated ? ['# (truncated to the newest lines)'] : []), ...read.lines].join('\n') }
            }
            if (action === 'stat') {
              const stat = service.stat()
              const files = stat.files.map((f) => `  ${f.name}: ${f.bytes} bytes`).join('\n')
              return {
                text: [
                  `dir: ${stat.dir}`,
                  `level: ${stat.level}`,
                  `total: ${stat.totalBytes} bytes`,
                  `records: ${stat.lines}`,
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
