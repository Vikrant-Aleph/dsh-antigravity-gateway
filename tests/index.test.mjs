import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  Config,
  apply,
  name,
  inject,
  AntigravityGatewayAdapter,
  AntigravityBridgeAdapter,
  GatewayError,
  BridgeError,
  isGatewayError,
  isBridgeError,
} from '../lib/index.js'

function createMockHostContext(services = {}) {
  const effects = []
  const listeners = new Map()
  const emitted = []
  const registeredAdapters = []
  const registeredProviders = []
  const registeredDiscovery = []
  const registeredRoutes = new Map()
  const registeredCommands = new Map()
  const registeredTools = new Map()
  let adapterDisposed = 0
  let adapterReplaced = []

  const ctx = {
    llm: {
      registerAdapter(providers, adapter) {
        registeredAdapters.push({ providers, adapter })
        const disposer = () => {
          adapterDisposed += 1
        }
        disposer.replace = (nextProviders) => {
          adapterReplaced.push(nextProviders)
        }
        return disposer
      },
      registerConfigurableProviders(entries) {
        registeredProviders.push(...entries)
      },
      registerModelDiscovery(ns, fn) {
        registeredDiscovery.push({ ns, fn })
      },
    },
    get(serviceName) {
      if (serviceName === 'commands') {
        return {
          register(def) {
            registeredCommands.set(def.name, def)
            return () => registeredCommands.delete(def.name)
          },
        }
      }
      if (serviceName === 'tools') {
        return {
          register(def) {
            registeredTools.set(def.name, def)
            return () => registeredTools.delete(def.name)
          },
        }
      }
      return services[serviceName]
    },
    emit(event, ...args) {
      emitted.push([event, ...args])
    },
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    inject(names, cb) {
      const child = {
        ...ctx,
        connection: {
          fetch: {
            register(route) {
              registeredRoutes.set(route.path, route)
              return () => registeredRoutes.delete(route.path)
            },
          },
        },
      }
      const res = cb(child)
      return {
        dispose() {
          if (typeof res === 'function') res()
        },
      }
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
    },
  }

  return {
    ctx,
    registeredAdapters,
    registeredProviders,
    registeredDiscovery,
    registeredRoutes,
    registeredCommands,
    registeredTools,
    emitted,
    disposeAll: async () => {
      for (const d of [...effects].reverse()) await d()
    },
    get adapterDisposed() {
      return adapterDisposed
    },
    adapterReplaced,
  }
}

test('plugin exports expected Cordis metadata, Config defaults, and deprecated Bridge aliases', () => {
  assert.equal(name, 'dsh-antigravity-gateway')
  assert.deepEqual(inject, ['llm'])
  assert.equal(AntigravityBridgeAdapter, AntigravityGatewayAdapter)
  assert.equal(BridgeError, GatewayError)
  assert.equal(isBridgeError, isGatewayError)
  const defaults = Config({})
  assert.deepEqual(defaults.providers, ['antigravity-gateway'])
  assert.equal(defaults.oauthPort, 51121)
  assert.equal(defaults.promptCompatibility, true)
  assert.equal(defaults.imageInput, true)
  assert.equal(defaults.useSystemProxy, true)
  assert.equal(defaults.logLevel, 'info')
})

test('apply wires adapter, providers, discovery, commands, tools, and disposes cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-index-'))
  const credFile = path.join(dir, 'credential.json')
  const logDir = path.join(dir, 'logs')
  try {
    const cfg = Config({
      credentialFile: credFile,
      logDir,
      logLevel: 'off',
      oauthPort: 0,
    })
    const host = createMockHostContext({ webServer: { host: '127.0.0.1' } })
    apply(host.ctx, cfg)

    assert.equal(host.registeredAdapters.length, 1)
    assert.deepEqual(host.registeredAdapters[0].providers, ['antigravity-gateway'])
    assert.equal(host.registeredProviders.length, 1)
    assert.equal(host.registeredProviders[0].settingsNs, 'dsh-antigravity-gateway')
    assert.equal(host.registeredDiscovery.length, 1)
    assert.ok(host.registeredCommands.has('agw'))
    assert.ok(host.registeredCommands.has('antigravity-gateway'))
    assert.ok(host.registeredTools.has('antigravity_gateway_log'))
    assert.ok(host.registeredRoutes.has('/api/antigravity-gateway-account/status'))
    assert.ok(host.registeredRoutes.has('/api/antigravity-gateway-logs/read'))

    // Wait briefly for the non-blocking initial auth.status() check to settle.
    // Wait briefly for the non-blocking initial auth.status() check to settle.
    await new Promise((r) => setTimeout(r, 20))
    await host.disposeAll()

    assert.equal(host.adapterDisposed, 1)
    assert.equal(host.registeredCommands.size, 0)
    assert.equal(host.registeredTools.size, 0)
    assert.equal(host.registeredRoutes.size, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('registerModelDiscovery reflects imageInput=false in inputModalities', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-index-img-'))
  const credFile = path.join(dir, 'credential.json')
  fs.writeFileSync(
    credFile,
    JSON.stringify({ refreshToken: '1//test', accessToken: 'ya29.valid', expiresAt: Date.now() + 3_600_000 }),
  )
  try {
    const cfg = Config({
      credentialFile: credFile,
      endpoint: 'http://127.0.0.1:1',
      fallbackEndpoints: [],
      logDir: path.join(dir, 'logs'),
      logLevel: 'off',
      imageInput: false,
    })
    const host = createMockHostContext({ webServer: { host: '127.0.0.1' } })
    apply(host.ctx, cfg)
    const discovered = await host.registeredDiscovery[0].fn({})
    assert.ok(discovered.length > 0)
    assert.deepEqual(discovered[0].inputModalities, ['text'])
    await host.disposeAll()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('apply cancels pending OAuth login and releases callback port on plugin unload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-index-login-'))
  try {
    const cfg = Config({
      credentialFile: path.join(dir, 'credential.json'),
      logDir: path.join(dir, 'logs'),
      logLevel: 'off',
      oauthPort: 0,
    })
    const host = createMockHostContext({ webServer: { host: '127.0.0.1' } })
    apply(host.ctx, cfg, { openUrl: () => true })

    const loginRoute = host.registeredRoutes.get('/api/antigravity-gateway-account/login')
    const res = await loginRoute.fetch(
      new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify({ rpcId: '1', method: 'antigravity-gateway-account/login', payload: {} }),
      }),
    )
    const envelope = await res.json()
    assert.equal(envelope.result.ok, true)
    const redirectUri = new URL(envelope.result.value.url).searchParams.get('redirect_uri')
    const port = Number(new URL(redirectUri).port)
    assert.ok(port > 0)

    await host.disposeAll()

    // Wait a tick for Node's http.Server.close() to release the socket, then bind the same port.
    await new Promise((resolve) => setTimeout(resolve, 25))
    const probe = net.createServer()
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', resolve)
    })
    await new Promise((resolve) => probe.close(resolve))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
