/**
 * Leveled file logger for dsh-antigravity-gateway.
 *
 * Design constraints (TECHNICAL.md §7/§9):
 * - No sensitive information ever reaches the log (configured secrets, Bearer
 *   tokens, Google OAuth token shapes, and long strings are scrubbed/capped).
 * - Bounded disk usage (active file + rotated siblings; oldest deleted first).
 * - Never throws; disk failures fall back to an in-memory ring.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { LogLevel } from '../shared/rpc-contracts.js'

export type { LogLevel }

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 100 }

export interface LogData {
  [key: string]: string | number | boolean | null | undefined | unknown
}

export interface GatewayLogger {
  debug(scope: string, msg: string, data?: LogData): void
  info(scope: string, msg: string, data?: LogData): void
  warn(scope: string, msg: string, data?: LogData): void
  error(scope: string, msg: string, data?: LogData): void
  getLevel(): LogLevel
}

/** @deprecated Use {@link GatewayLogger}. Kept during 0.x for compatibility. */
export type BridgeLogger = GatewayLogger

/** A logger that discards everything; the default for standalone use. */
export const noopLogger: GatewayLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => 'off',
}

const MAX_STRING = 2000
const MEMORY_FALLBACK_LIMIT = 200

/** Default log directory: profile logs dir when known, else `~/.dsh/logs`. */
export function defaultLogDir(): string {
  const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh')
  return path.join(base, 'logs', 'dsh-antigravity-gateway')
}

export interface PluginLoggerOptions {
  level: LogLevel
  dir: string
  maxBytes: number
  maxFiles: number
  secrets?: readonly string[]
  mirror?: (line: string) => void
}

export class PluginLogger implements GatewayLogger {
  private level: LogLevel
  private readonly dir: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly secrets: readonly string[]
  private readonly base: string
  private readonly mirror?: (line: string) => void
  private memory: string[] = []

  constructor(options: PluginLoggerOptions) {
    this.level = options.level
    this.dir = options.dir
    this.maxBytes = Math.max(256, options.maxBytes)
    this.maxFiles = Math.max(1, Math.min(50, options.maxFiles))
    this.base = path.join(this.dir, 'dsh-antigravity-gateway.log')
    this.secrets = (options.secrets ?? []).filter((s) => typeof s === 'string' && s.length >= 4)
    this.mirror = options.mirror
    this.pruneExcess()
  }

  /** Runtime level change (tool-driven); persisted only through config. */
  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }

  debug(scope: string, msg: string, data?: LogData): void {
    this.emit('debug', scope, msg, data)
  }
  info(scope: string, msg: string, data?: LogData): void {
    this.emit('info', scope, msg, data)
  }
  warn(scope: string, msg: string, data?: LogData): void {
    this.emit('warn', scope, msg, data)
  }
  error(scope: string, msg: string, data?: LogData): void {
    this.emit('error', scope, msg, data)
  }

  /** Formatted single line, used for both the file and the memory fallback. */
  private format(record: { ts: string; level: LogLevel; scope: string; msg: string; data?: LogData }): string {
    const data = record.data && Object.keys(record.data).length ? ` ${this.redact(JSON.stringify(record.data))}` : ''
    return `${record.ts} [${record.level.toUpperCase().padEnd(5)}] [${record.scope}] ${this.redact(record.msg)}${data}`
  }

  /**
   * Scrub sensitive material from any string: configured secrets, bearer
   * tokens, Google OAuth token shapes (`ya29.`), refresh-token shapes
   * (`1//`), then cap the length.
   */
  redact(input: string): string {
    let out = input
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]')
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    out = out.replace(/\bya29\.[A-Za-z0-9._-]{8,}/g, '[redacted-access-token]')
    out = out.replace(/\b1\/\/[A-Za-z0-9._-]{8,}/g, '[redacted-refresh-token]')
    out = out.replace(/\b(sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out
  }

  /** Newest-last records, filtered by minimum level, capped to `limit`. */
  read(options: { level?: LogLevel; limit?: number } = {}): { lines: string[]; truncated: boolean } {
    const min = RANK[options.level ?? 'debug']
    const limit = Math.max(1, Math.min(5000, options.limit ?? 500))
    const lines: string[] = []
    // Chronological order: oldest rotated file first, active file last.
    for (let i = this.maxFiles - 1; i >= 0; i--) {
      const file = i === 0 ? this.base : `${this.base}.${i}`
      for (const raw of this.readLines(file)) {
        if (this.rankOf(raw) >= min) lines.push(raw)
      }
    }
    if (!lines.length && this.memory.length) {
      for (const raw of this.memory) if (this.rankOf(raw) >= min) lines.push(raw)
    }
    const truncated = lines.length > limit
    return { lines: truncated ? lines.slice(-limit) : lines, truncated }
  }

  /** Files on disk with sizes, plus current level and record count. */
  stat(): {
    dir: string
    file: string
    level: LogLevel
    maxBytes: number
    maxFiles: number
    files: { name: string; bytes: number }[]
    totalBytes: number
    recordCount: number
  } {
    const files: { name: string; bytes: number }[] = []
    for (let i = 0; i < this.maxFiles; i++) {
      const name = i === 0 ? path.basename(this.base) : `${path.basename(this.base)}.${i}`
      const full = i === 0 ? this.base : `${this.base}.${i}`
      const bytes = this.sizeOf(full)
      if (bytes > 0) files.push({ name, bytes })
    }
    return {
      dir: this.dir,
      file: this.base,
      level: this.level,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      files,
      totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      recordCount: this.read({ limit: 5000 }).lines.length,
    }
  }

  /** Delete every log file; returns how many were removed. */
  clear(): number {
    let removed = 0
    for (let i = 0; i < this.maxFiles; i++) {
      const full = i === 0 ? this.base : `${this.base}.${i}`
      try {
        if (fs.existsSync(full)) {
          fs.unlinkSync(full)
          removed++
        }
      } catch {
        // Best effort; the next append recreates what it needs.
      }
    }
    this.memory = []
    return removed
  }

  // -- internals ------------------------------------------------------------

  private emit(level: LogLevel, scope: string, msg: string, data?: LogData): void {
    if (RANK[level] < RANK[this.level]) return
    const record = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(data && Object.keys(data).length ? { data: this.scrubData(data) } : {}),
    }
    const line = this.format(record)
    this.memory.push(line)
    if (this.memory.length > MEMORY_FALLBACK_LIMIT) this.memory.shift()
    try {
      this.mirror?.(line)
    } catch {
      // Mirroring must never break logging.
    }
    this.appendLine(line)
  }

  /** Redact every string inside a data record; complex values serialize first. */
  private scrubData(data: LogData): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue
      if (typeof value === 'string') out[key] = this.redact(value)
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
      else out[key] = this.redact(JSON.stringify(value))
    }
    return out
  }

  private appendLine(line: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const bytes = Buffer.byteLength(line) + 1
      if (this.sizeOf(this.base) + bytes > this.maxBytes) this.rotate()
      fs.appendFileSync(this.base, `${line}\n`, 'utf8')
    } catch {
      // Disk output is best-effort; the memory ring still holds recent lines.
    }
  }

  /** Shift the active file into `.1`, moving older siblings up, deleting the oldest. */
  private rotate(): void {
    try {
      const oldest = `${this.base}.${this.maxFiles - 1}`
      if (this.maxFiles > 1 && fs.existsSync(oldest)) fs.unlinkSync(oldest)
      for (let i = this.maxFiles - 2; i >= 1; i--) {
        const from = `${this.base}.${i}`
        if (fs.existsSync(from)) fs.renameSync(from, `${this.base}.${i + 1}`)
      }
      if (fs.existsSync(this.base)) fs.renameSync(this.base, `${this.base}.1`)
    } catch {
      // If rotation fails, appendLine's caller keeps running on the old file.
    }
  }

  /** Delete rotated siblings beyond the configured retention on startup. */
  private pruneExcess(): void {
    try {
      for (let i = this.maxFiles; i <= 50; i++) {
        const full = `${this.base}.${i}`
        if (fs.existsSync(full)) fs.unlinkSync(full)
      }
    } catch {
      // Ignore; stale extra files are harmless.
    }
  }

  private readLines(file: string): string[] {
    try {
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
    } catch {
      return []
    }
  }

  private sizeOf(file: string): number {
    try {
      return fs.existsSync(file) ? fs.statSync(file).size : 0
    } catch {
      return 0
    }
  }

  /** Extract the level from a formatted line so filtering works on disk lines. */
  private rankOf(line: string): number {
    const match = /\[(DEBUG|INFO |WARN |ERROR)\]/.exec(line)
    if (!match) return RANK.debug
    const key = match[1]!.trim().toLowerCase() as LogLevel
    return RANK[key] ?? RANK.debug
  }
}
