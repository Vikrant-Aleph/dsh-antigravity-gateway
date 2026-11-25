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

function flattenText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join(' ')
  if (typeof node === 'object') {
    if (node.type === '__PORTAL__') return flattenText(node.node)
    return flattenText(node.children)
  }
  return ''
}

function findComponentNode(node, fnName) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findComponentNode(child, fnName)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof node.type === 'function' && node.type.name === fnName) return node
  if (node.children) return findComponentNode(node.children, fnName)
  return undefined
}

function findElements(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, out)
    return out
  }
  if (node.type === '__PORTAL__') {
    findElements(node.node, predicate, out)
    return out
  }
  if (typeof node.type === 'function') {
    findElements(node.type(node.props), predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (node.children) findElements(node.children, predicate, out)
  return out
}

function loadClientModule({ fakeDocument, withStatefulHooks = false } = {}) {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loaded
  const headChildren = []

  const doc = fakeDocument ?? {
    body: { tagName: 'BODY' },
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
      return { tagName: tag.toUpperCase(), id: '', textContent: '', parentNode: null }
    },
  }

  const cleanups = []
  const hookStoreByKey = new Map()
  let activeKey = 'default'
  let hookCursor = 0
  const pendingEffects = []
  const portals = []

  const getStates = () => {
    let arr = hookStoreByKey.get(activeKey)
    if (!arr) {
      arr = []
      hookStoreByKey.set(activeKey, arr)
    }
    return arr
  }

  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(init) {
      if (!withStatefulHooks) {
        return [typeof init === 'function' ? init() : init, () => {}]
      }
      const states = getStates()
      const idx = hookCursor++
      if (!(idx in states)) {
        states[idx] = typeof init === 'function' ? init() : init
      }
      const setState = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next
      }
      return [states[idx], setState]
    },
    useEffect(fn, deps) {
      if (!withStatefulHooks) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return
      }
      const states = getStates()
      const idx = hookCursor++
      const prev = states[idx]
      const changed = !prev || !deps || deps.length !== prev.deps?.length || deps.some((d, i) => d !== prev.deps[i])
      if (changed) {
        pendingEffects.push(() => {
          prev?.cleanup?.()
          const cleanup = fn()
          states[idx] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        })
      }
    },
    useCallback(fn) {
      return fn
    },
    useRef(init) {
      if (!withStatefulHooks) return { current: init }
      const states = getStates()
      const idx = hookCursor++
      if (!(idx in states)) states[idx] = { current: init }
      return states[idx]
    },
  }

  const fakeReactDom = {
    createPortal(node, container) {
      const portal = { type: '__PORTAL__', node, container }
      portals.push(portal)
      return portal
    },
  }

  const renderComponent = (Component, props, key = Component.name || 'default') => {
    activeKey = key
    hookCursor = 0
    portals.length = 0
    const tree = Component(props)
    while (pendingEffects.length > 0) {
      const eff = pendingEffects.shift()
      eff()
    }
    return tree
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          loaded = mod
        },
      },
      confirm: () => true,
      innerWidth: 1280,
      innerHeight: 800,
    },
    document: doc,
    console: { error: () => {}, warn: () => {}, log: () => {} },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    URL,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
  const plugin = loaded.factory((id) => {
    if (id === 'react') return fakeReact
    if (id === 'react-dom') return fakeReactDom
    throw new Error(`unexpected module: ${id}`)
  })
  return { loaded, plugin, doc, headChildren, cleanups, renderComponent, portals }
}

test('client.js registers package id and apply() never throws even with missing or failing host services', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))
  const { loaded, plugin } = loadClientModule()
  assert.equal(loaded.id, pkg.name)
  assert.deepEqual(Array.from(plugin.inject), ['slots'])
  assert.equal(typeof plugin.apply, 'function')

  assert.doesNotThrow(() => plugin.apply({}))

  const hostileCtx = {
    locale: {
      register() { throw new Error('locale register boom') },
      bind() { throw new Error('locale bind boom') },
    },
    get() { throw new Error('get boom') },
    inject() { throw new Error('inject boom') },
    slots: {
      inject() { throw new Error('slots inject boom') },
      register() { throw new Error('slots register boom') },
    },
  }
  assert.doesNotThrow(() => plugin.apply(hostileCtx))

  let deferred
  const deferredCtx = {
    slots: {
      inject(_slotName, fn) { deferred = fn },
      register() { throw new Error('deferred register boom') },
    },
  }
  assert.doesNotThrow(() => plugin.apply(deferredCtx))
  assert.doesNotThrow(() => deferred())
})

test('client.js registers settings.section slot, deduplicates #agw-styles, and cleans up on unmount', () => {
  const { plugin, headChildren, cleanups } = loadClientModule()
  let registeredDef
  let PanelComponent
  const ctx = {
    locale: {
      register() { return () => {} },
      bind() { return (key) => key },
    },
    get(name) {
      return name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : undefined
    },
    effect() {},
    slots: {
      inject(slotName, fn) {
        assert.equal(slotName, 'settings.section')
        fn()
      },
      register(def, component) {
        assert.equal(this, ctx.slots, 'slots.register must preserve slots as its `this` receiver')
        registeredDef = def
        PanelComponent = component
        return () => {}
      },
    },
  }

  plugin.apply(ctx)
  assert.equal(registeredDef.name, 'settings.section')
  assert.equal(registeredDef.id, 'antigravity-gateway')

  const injectedProps = registeredDef.inject()
  PanelComponent(injectedProps)
  PanelComponent(injectedProps)
  assert.equal(headChildren.filter((el) => el.id === 'agw-styles').length, 1)

  while (cleanups.length > 0) cleanups.shift()()
  assert.equal(headChildren.filter((el) => el.id === 'agw-styles').length, 0)
})

test('client.js renders quota progress bars in Models tab, multi-account controls in Account tab, and composer 5h | 87% chip with hover portal', async () => {
  const { plugin, renderComponent, doc } = loadClientModule({ withStatefulHooks: true })
  const registeredSlots = new Map()
  let currentSelection = { provider: 'antigravity-gateway', model: 'claude-sonnet-5-5' }
  const storeListeners = new Set()

  const futureIso = new Date(Date.now() + 2 * 3_600_000 + 15 * 60_000).toISOString()
  const rpcCalls = []
  const fakeRpc = {
    async call(channel, method, payload) {
      rpcCalls.push([channel, method, payload])
      if (method === `${ACCOUNT_RPC_NAMESPACE}/models`) {
        return {
          ok: true,
          value: {
            source: 'live',
            checkedAt: '2026-11-26T00:00:00Z',
            providers: ['antigravity-gateway'],
            accountCount: 2,
            activeAccount: { id: 'a1', email: 'a1@example.com', projectId: 'proj-1' },
            quotaGroups: [
              {
                displayName: 'Claude',
                buckets: [
                  { bucketId: 'claude-5h', displayName: 'Five Hour', window: '5h', remainingFraction: 0.87, resetTime: futureIso },
                  { bucketId: 'claude-weekly', displayName: 'Weekly', window: 'weekly', remainingFraction: 0.62, resetTime: futureIso },
                ],
              },
            ],
            available: [
              { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'], contextWindow: 1_000_000, maxOutputTokens: 128_000, status: 'available', remainingFraction: 0.87, resetTime: futureIso },
            ],
            unavailable: [],
          },
        }
      }
      if (method === `${ACCOUNT_RPC_NAMESPACE}/status`) {
        return {
          ok: true,
          value: {
            loggedIn: true,
            email: 'a1@example.com',
            projectId: 'proj-1',
            backend: 'credentials-service',
            loginPending: false,
            autoSwitchAccount: true,
            activeAccountId: 'a1',
            accounts: [
              { id: 'a1', email: 'a1@example.com', projectId: 'proj-1', active: true },
              { id: 'a2', email: 'a2@example.com', projectId: 'proj-2', active: false },
            ],
          },
        }
      }
      return { ok: true, value: {} }
    },
  }

  const ctx = {
    locale: { register: () => () => {}, bind: () => (k) => k },
    get: (name) => (name === 'connection' ? { rpc: fakeRpc } : undefined),
    effect: () => {},
    slots: {
      inject(_name, fn) { return fn() },
      register(def, comp) {
        assert.equal(this, ctx.slots)
        registeredSlots.set(def.name, { def, comp })
        return () => registeredSlots.delete(def.name)
      },
    },
    inject(_names, cb) {
      return cb({
        slots: ctx.slots,
        modelDirectories: {
          directoryFor() {
            return {
              store: {
                getSnapshot: () => ({ current: currentSelection }),
                subscribe: (fn) => { storeListeners.add(fn); return () => storeListeners.delete(fn) },
              },
            }
          },
        },
      })
    },
  }

  plugin.apply(ctx)
  // Let initial warm fetchModelsReport settle.
  await new Promise((r) => setTimeout(r, 15))

  // 1. Composer slot registered on `conversation.input.right`.
  const composerEntry = registeredSlots.get('conversation.input.right')
  assert.ok(composerEntry, 'conversation.input.right must be registered')
  const composerProps = composerEntry.def.inject('sess-1')

  // Owned model shows `5h | 87%`.
  const treeOwned = renderComponent(composerEntry.comp, composerProps)
  assert.match(flattenText(treeOwned), /5h \| 87%/)

  // Hover opens body-portaled popover with full quota details & progress bars.
  treeOwned.props.onMouseEnter()
  const treeHovered = renderComponent(composerEntry.comp, composerProps)
  const popovers = findElements(treeHovered, (n) => String(n.props?.className || '').includes('agw-quota-popover'))
  assert.equal(popovers.length, 1)
  const portalWrapper = findElements([treeHovered], () => false) // check portal target below
  void portalWrapper
  assert.equal(treeHovered.children.find((c) => c && c.type === '__PORTAL__').container, doc.body)
  const popoverText = flattenText(popovers[0])
  assert.match(popoverText, /a1@example\.com/)
  assert.match(popoverText, /87%/)
  assert.match(popoverText, /62%/)
  const bars = findElements(popovers[0], (n) => n.props?.role === 'progressbar')
  assert.ok(bars.length >= 2)

  // Non-owned provider model renders nothing (null).
  currentSelection = { provider: 'deepseek-account', model: 'deepseek-chat' }
  for (const fn of storeListeners) fn()
  const treeOther = renderComponent(composerEntry.comp, composerProps)
  assert.equal(treeOther, null)

  // 2. Settings Panel renders Models progress bars & Account multi-account switcher.
  const settingsEntry = registeredSlots.get('settings.section')
  const settingsProps = settingsEntry.def.inject()
  const settingsAcc = renderComponent(settingsEntry.comp, settingsProps, 'GatewayPanel')
  const accountTabPanel = findComponentNode(settingsAcc, 'AccountPanel')
  renderComponent(accountTabPanel.type, accountTabPanel.props, 'AccountPanel')
  await new Promise((r) => setTimeout(r, 15))
  const accTreeLoaded = renderComponent(accountTabPanel.type, accountTabPanel.props, 'AccountPanel')
  const accText = flattenText(accTreeLoaded)
  assert.match(accText, /a1@example\.com/)
  assert.match(accText, /a2@example\.com/)
  assert.match(accText, /switchAccount/)

  // 3. Switch GatewayPanel to Models tab and verify progress bars & reset labels render.
  const modelsTabBtn = findElements(settingsAcc, (n) => n.props?.id === 'agw-tab-models')[0]
  modelsTabBtn.props.onClick()
  const settingsModels = renderComponent(settingsEntry.comp, settingsProps, 'GatewayPanel')
  const modelsTabPanel = findComponentNode(settingsModels, 'ModelsPanel')
  renderComponent(modelsTabPanel.type, modelsTabPanel.props, 'ModelsPanel')
  await new Promise((r) => setTimeout(r, 15))
  const modelsTreeLoaded = renderComponent(modelsTabPanel.type, modelsTabPanel.props, 'ModelsPanel')
  const modelsBars = findElements(modelsTreeLoaded, (n) => n.props?.role === 'progressbar')
  assert.ok(modelsBars.length >= 3, 'ModelsPanel must render progress bars for quota groups and models')
  assert.equal(modelsBars[0].props['aria-valuenow'], 87)
  assert.match(flattenText(modelsTreeLoaded), /quotaResets/)
  assert.equal(findElements(modelsTreeLoaded, (n) => n.props?.className === 'agw-panel-header').length, 1)
  assert.ok(findElements(modelsTreeLoaded, (n) => String(n.props?.className || '').includes('agw-model-pct')).length >= 1)

  // 4. Composer quota chip CSS stays borderless and aligns font/size/height with ModelSelect .trigger.
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  const chipCss = /\.agw-composer-chip\s*\{([^}]+)\}/.exec(code)?.[1] ?? ''
  assert.match(chipCss, /border:\s*none/)
  assert.match(chipCss, /background:\s*transparent/)
  assert.match(chipCss, /font-family:\s*inherit/)
  assert.match(chipCss, /font-size:\s*13px/)
  assert.match(chipCss, /line-height:\s*20px/)
  assert.match(chipCss, /font-weight:\s*600/)
  assert.match(chipCss, /height:\s*28px/)
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
  const loopbackMatches = code.match(/code === 'loopback-required'/g) ?? []
  assert.ok(loopbackMatches.length >= 4, 'AccountPanel, ModelsPanel, and LogPanel must all handle loopback-required')
})
