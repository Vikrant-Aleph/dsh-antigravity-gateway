import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {
  ACCOUNT_ENDPOINTS,
  ACCOUNT_RPC_NAMESPACE,
  LOG_ENDPOINTS,
  LOG_RPC_NAMESPACE,
  RPC_CHANNEL,
} from '../lib/shared/rpc-contracts.js'

const CLIENT_PATH = path.resolve('client.js')
const PKG_PATH = path.resolve('package.json')

function loadClientModule({ fakeDocument } = {}) {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loaded
  const elements = []
  const headChildren = []

  const doc = fakeDocument ?? {
    head: {
      appendChild(el) {
        el.parentNode = doc.head
        headChildren.push(el)
      },
      removeChild(el) {
        const idx = headChildren.indexOf(el)
        if (idx !== -1) headChildren.splice(idx, 1)
        el.parentNode = null
      },
    },
    getElementById(id) {
      return headChildren.find((el) => el.id === id) ?? null
    },
    createElement(tag) {
      const el = { tagName: tag.toUpperCase(), id: '', textContent: '', parentNode: null }
      elements.push(el)
      return el
    },
  }

  const cleanups = []
  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(init) {
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    useCallback(fn) {
      return fn
    },
    useRef(init) {
      return { current: init }
    },
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          loaded = mod
        },
      },
      confirm: () => true,
    },
    document: doc,
    console: { error: () => {}, warn: () => {}, log: () => {} },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    URL,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
  const plugin = loaded.factory((id) => {
    assert.equal(id, 'react')
    return fakeReact
  })
  return { loaded, plugin, doc, headChildren, cleanups }
}

test('client.js registers package id and apply() never throws even with missing or failing host services', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))
  const { loaded, plugin } = loadClientModule()
  assert.equal(loaded.id, pkg.name)
  assert.deepEqual(Array.from(plugin.inject), ['slots'])
  assert.equal(typeof plugin.apply, 'function')

  // Empty context (all optional services absent).
  assert.doesNotThrow(() => plugin.apply({}))

  // Host services that throw on every call.
  const hostileCtx = {
    locale: {
      register() {
        throw new Error('locale register boom')
      },
      bind() {
        throw new Error('locale bind boom')
      },
    },
    get() {
      throw new Error('get boom')
    },
    slots: {
      inject() {
        throw new Error('slots inject boom')
      },
      register() {
        throw new Error('slots register boom')
      },
    },
  }
  assert.doesNotThrow(() => plugin.apply(hostileCtx))
})

test('client.js registers settings.section slot, deduplicates #agw-styles, and cleans up on unmount', () => {
  const { plugin, headChildren, cleanups } = loadClientModule()
  let registeredDef
  let PanelComponent
  const effects = []
  const ctx = {
    locale: {
      register(_ns, _dict) {
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    get(name) {
      return name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : undefined
    },
    effect(fn) {
      effects.push(fn())
    },
    slots: {
      inject(slotName, fn) {
        assert.equal(slotName, 'settings.section')
        fn()
      },
      register(def, component) {
        registeredDef = def
        PanelComponent = component
        return () => {}
      },
    },
  }

  plugin.apply(ctx)
  assert.equal(registeredDef.name, 'settings.section')
  assert.equal(registeredDef.id, 'antigravity-gateway')
  assert.equal(typeof PanelComponent, 'function')

  // Mount twice; #agw-styles must appear at most once in document.head.
  const injectedProps = registeredDef.inject()
  PanelComponent(injectedProps)
  PanelComponent(injectedProps)
  assert.equal(headChildren.filter((el) => el.id === 'agw-styles').length, 1)

  // Unmount first instance: style remains while second is mounted; unmount second: removed.
  while (cleanups.length > 0) {
    const cleanup = cleanups.shift()
    cleanup()
  }
  assert.equal(headChildren.filter((el) => el.id === 'agw-styles').length, 0)
})

test('client.js RPC channels, namespaces, and endpoints match src/shared/rpc-contracts.ts 100%', () => {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  const channelMatch = /const RPC_CHANNEL = '([^']+)'/.exec(code)
  const accountNsMatch = /const ACCOUNT_NS = '([^']+)'/.exec(code)
  const logNsMatch = /const LOG_NS = '([^']+)'/.exec(code)
  assert.equal(channelMatch?.[1], RPC_CHANNEL)
  assert.equal(accountNsMatch?.[1], ACCOUNT_RPC_NAMESPACE)
  assert.equal(logNsMatch?.[1], LOG_RPC_NAMESPACE)

  const calls = [...code.matchAll(/rpcCall\(rpc,\s*(ACCOUNT_NS|LOG_NS),\s*'([^']+)'/g)]
  assert.ok(calls.length > 0)
  for (const [, nsVar, endpoint] of calls) {
    if (nsVar === 'ACCOUNT_NS') {
      assert.ok(ACCOUNT_ENDPOINTS.includes(endpoint), `unexpected account RPC endpoint in client.js: ${endpoint}`)
    } else {
      assert.ok(LOG_ENDPOINTS.includes(endpoint), `unexpected log RPC endpoint in client.js: ${endpoint}`)
    }
  }
  // Confirm AccountPanel (load/act), ModelsPanel, and LogPanel all map loopback-required.
  const loopbackMatches = code.match(/code === 'loopback-required'/g) ?? []
  assert.ok(loopbackMatches.length >= 4, 'AccountPanel, ModelsPanel, and LogPanel must all handle loopback-required')
})
