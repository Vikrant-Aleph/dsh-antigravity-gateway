/**
 * Cross-platform atomic file writes using unique temporary files and cleanup.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AtomicWriteOptions {
  mode?: number
}

/**
 * Write UTF-8 content to a unique temporary sibling file and atomically rename
 * it into place. Orphaned temp files are cleaned up on failure.
 */
export function writeFileAtomicSync(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, content, {
      encoding: 'utf8',
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    })
    fs.renameSync(tmp, filePath)
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      // Best-effort cleanup of the temp file.
    }
    throw error
  }
  if (options.mode !== undefined) {
    try {
      fs.chmodSync(filePath, options.mode)
    } catch {
      // Windows ACLs differ; owner-only mode bits apply on POSIX.
    }
  }
}
