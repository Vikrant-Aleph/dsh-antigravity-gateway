import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginLogger } from '../lib/core/logger.js'
import { LogService, registerLogAccess, RPC_NAMESPACE } from '../lib/dsh/log-service.js'

function setupLogEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-logsvc-'))
  const logger = new PluginLogger({ level: 'info', dir, maxBytes: 64 * 1024, maxFiles: 2 })
  logger.debug('scope', 'debug hidden')
  logger.info('scope', 'info visible')
  logger.warn('scope', 'warn visible')
  const service = new LogService(logger)
  return { dir, logger, service }
}

function fakeLogContext(webServer = { host: '127.0.0.1' }) {
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'tools') {
        return {
          register(def) {
            tools.set(def.name, def)
            return () => tools.delete(def.name)
          },
        }
      }
      return undefined
    },
    inject(_names, cb) {
      const child = {
        get: ctx.get,
        inject: ctx.inject,
        connection: {
          fetch: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        },
      }
      cb(child)
      return undefined
    },
  }
  return { ctx, routes, tools }
}

async function callLogRpc(routes, endpoint, payload = {}, method = `${RPC_NAMESPACE}/${endpoint}`) {
  const route = routes.get(`/api/${RPC_NAMESPACE}/${endpoint}`)
  assert.ok(route, `route ${endpoint} registered`)
  const res = await route.fetch(
    new Request('http://localhost/api', {
      method: 'POST',
      body: JSON.stringify({ rpcId: 'log-1', method, payload }),
    }),
  )
  if (!res.ok) return { status: res.status }
  const envelope = await res.json()
  return { status: res.status, result: envelope.result }
}

test('LogService read, setLevel, and clear operate on PluginLogger', () => {
  const { dir, service } = setupLogEnv()
  try {
    const initial = service.read('info', 10)
    assert.equal(initial.lines.length, 2)
    assert.equal(initial.level, 'info')
    assert.equal(initial.dir, dir)

    const nextLevel = service.setLevel('debug')
    assert.equal(nextLevel.level, 'debug')

    const cleared = service.clear()
    assert.equal(cleared.removed, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('registerLogAccess exposes RPC routes and antigravity_gateway_log tool', async () => {
  const { dir, service } = setupLogEnv()
  try {
    const { ctx, routes, tools } = fakeLogContext({ host: '127.0.0.1' })
    const dispose = registerLogAccess(ctx, service)
    assert.equal(routes.size, 4)
    assert.ok(tools.has('antigravity_gateway_log'))

    const readRes = await callLogRpc(routes, 'read', { level: 'warn', limit: 5 })
    assert.equal(readRes.result.ok, true)
    assert.equal(readRes.result.value.lines.length, 1)

    const statRes = await callLogRpc(routes, 'stat')
    assert.equal(statRes.result.ok, true)
    assert.equal(statRes.result.value.level, 'info')
    assert.equal(statRes.result.value.lines, 2)

    const badLevel = await callLogRpc(routes, 'level', { level: 'invalid' })
    assert.equal(badLevel.result.ok, false)
    assert.equal(badLevel.result.error.code, 'bad-request')

    const badMethod = await callLogRpc(routes, 'read', {}, 'wrong/method')
    assert.equal(badMethod.result.ok, false)
    assert.equal(badMethod.result.error.code, 'bad-request')

    const tool = tools.get('antigravity_gateway_log')
    const statOut = await tool.execute({ action: 'stat' })
    assert.match(statOut.text, /level: info/)
    const levelOut = await tool.execute({ action: 'level', level: 'debug' })
    assert.match(levelOut.text, /now debug/)
    const clearOut = await tool.execute({ action: 'clear' })
    assert.match(clearOut.text, /removed 1 log file/)
    const unknownOut = await tool.execute({ action: 'nope' })
    assert.match(unknownOut.text, /unknown action/)
    assert.deepEqual(tool.output.render({}, { text: 'ok' }), [{ type: 'text', text: 'ok' }])

    dispose()
    assert.equal(tools.size, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
