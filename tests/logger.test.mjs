import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginLogger } from '../lib/core/logger.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agb-logger-'))
}

test('level filtering and read order', () => {
  const dir = tempDir()
  const logger = new PluginLogger({ level: 'info', dir, maxBytes: 64 * 1024, maxFiles: 2 })
  logger.debug('scope', 'hidden')
  logger.info('scope', 'shown')
  logger.warn('scope', 'warning')
  const { lines } = logger.read()
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('shown'))
  assert.ok(lines[1].includes('warning'))
  const warnOnly = logger.read({ level: 'warn' })
  assert.equal(warnOnly.lines.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('secrets, bearer tokens, and Google token shapes are redacted', () => {
  const dir = tempDir()
  const logger = new PluginLogger({ level: 'debug', dir, maxBytes: 64 * 1024, maxFiles: 1, secrets: ['super-secret-value'] })
  logger.info('auth', 'token super-secret-value and Bearer abcdef123456789 and ya29.a0AfB_byCveryLongToken and 1//0gRefreshTokenShape')
  const { lines } = logger.read()
  assert.ok(!lines[0].includes('super-secret-value'))
  assert.ok(!lines[0].includes('abcdef123456789'))
  assert.ok(!lines[0].includes('ya29.a0AfB_byCveryLongToken'))
  assert.ok(!lines[0].includes('1//0gRefreshTokenShape'))
  assert.ok(lines[0].includes('[redacted'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('rotation bounds disk usage and keeps chronological read order', () => {
  const dir = tempDir()
  const logger = new PluginLogger({ level: 'debug', dir, maxBytes: 400, maxFiles: 3 })
  for (let i = 0; i < 60; i++) logger.info('scope', `line ${i} ${'x'.repeat(20)}`)
  const stat = logger.stat()
  assert.ok(stat.files.length <= 3)
  assert.ok(stat.totalBytes <= 400 * 3 + 400)
  const { lines } = logger.read({ limit: 5000 })
  // Newest lines survive; oldest were rotated away.
  assert.ok(lines.at(-1).includes('line 59'))
  assert.ok(!lines.some((line) => line.includes('line 0 ')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('clear removes files and stat reports the directory', () => {
  const dir = tempDir()
  const logger = new PluginLogger({ level: 'debug', dir, maxBytes: 64 * 1024, maxFiles: 2 })
  logger.info('scope', 'one')
  const stat = logger.stat()
  assert.equal(stat.dir, dir)
  assert.ok(stat.totalBytes > 0)
  const removed = logger.clear()
  assert.equal(removed, 1)
  assert.equal(logger.stat().totalBytes, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runtime level change takes effect immediately', () => {
  const dir = tempDir()
  const logger = new PluginLogger({ level: 'off', dir, maxBytes: 64 * 1024, maxFiles: 1 })
  logger.info('scope', 'hidden')
  assert.equal(logger.read().lines.length, 0)
  logger.setLevel('debug')
  logger.debug('scope', 'visible')
  assert.equal(logger.read().lines.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('logging never throws on an unwritable directory', () => {
  const logger = new PluginLogger({ level: 'debug', dir: path.join(os.tmpdir(), 'nonexistent-drive-xyz', 'deep'), maxBytes: 1024, maxFiles: 1 })
  // Force failure by pointing at a file path as directory.
  const dir = tempDir()
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x')
  const blocked = new PluginLogger({ level: 'debug', dir: blocker, maxBytes: 1024, maxFiles: 1 })
  assert.doesNotThrow(() => blocked.info('scope', 'still works'))
  assert.ok(blocked.read().lines.length >= 1) // memory fallback
  fs.rmSync(dir, { recursive: true, force: true })
})
