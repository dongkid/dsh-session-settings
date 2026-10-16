/**
 * Client-half tests (lib/client.js).
 *
 * The bundle is a browser script: it registers a lazy factory on
 * window.__ModuleLoader__ and its page is a React tree. The test stubs the
 * loader, react, the Cordis context it is handed, and fetch, then renders the
 * page through a minimal hook runtime (path-keyed state, error boundaries) so
 * the assertions run against the element tree the real GUI would receive.
 *
 * No jsdom, no build step: the bundle itself must stay dependency-free, and so
 * does its test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/* ------------------------------------------------------------ mini react */

/** Hook state by component path, so a re-render keeps useState values. */
const hookState = new Map()
const frames = []

function withFrame(key, render) {
  frames.push({ key, index: 0 })
  try {
    return render()
  } finally {
    frames.pop()
  }
}

function slot(init) {
  const frame = frames[frames.length - 1]
  const key = frame.key + '#' + frame.index
  frame.index += 1
  if (!hookState.has(key)) hookState.set(key, typeof init === 'function' ? init() : init)
  return key
}

const ReactStub = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props)
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(init) {
    const key = slot(init)
    return [hookState.get(key), (next) => {
      hookState.set(key, typeof next === 'function' ? next(hookState.get(key)) : next)
    }]
  },
  useEffect(fn) {
    slot(undefined)
  },
  useCallback(fn) {
    slot(undefined)
    return fn
  },
  useRef(init) {
    const key = slot(null)
    if (hookState.get(key) === null) hookState.set(key, { current: init })
    return hookState.get(key)
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    slot(undefined)
    return getSnapshot()
  },
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = undefined
    }
    setState(next) {
      this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
    }
  },
}

function renderNode(node, path) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (Array.isArray(node)) {
    return { tag: '#array', props: {}, children: node.map((kid, i) => renderNode(kid, path + '.' + i)).filter(Boolean) }
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return { tag: '#text', props: {}, text: String(node) }
  }
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'string') {
    const kids = props.children
    const list = Array.isArray(kids) ? kids : [kids]
    return { tag: type, props, children: list.map((kid, i) => renderNode(kid, path + '.' + i)).filter(Boolean) }
  }
  if (typeof type === 'function') {
    const isClass = type.prototype && typeof type.prototype.render === 'function'
    if (isClass) {
      // Class components get path-keyed state plus React's boundary protocol,
      // so a crashing descendant is contained exactly as the real page's
      // PageBoundary contains it.
      const key = path + '!'
      const instance = new type(props)
      if (hookState.has(key)) instance.state = hookState.get(key)
      instance.setState = (next) => {
        const merged = Object.assign({}, instance.state || {}, typeof next === 'function' ? next(instance.state) : next)
        hookState.set(key, merged)
        instance.state = merged
      }
      try {
        return renderNode(instance.render(), key)
      } catch (error) {
        if (typeof type.getDerivedStateFromError !== 'function') throw error
        if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error, { componentStack: '' })
        instance.setState(type.getDerivedStateFromError(error))
        return renderNode(instance.render(), key)
      }
    }
    return withFrame(path, () => renderNode(type(props), path + '>'))
  }
  throw new Error('unsupported element type: ' + String(type))
}

function walk(node, out) {
  if (node === null || node === undefined) return out
  if (node.tag === '#text') {
    out.texts.push(node.text)
    return out
  }
  out.nodes.push(node)
  for (const kid of node.children || []) walk(kid, out)
  return out
}

/** Render one element and expose the flat node list plus text helpers. */
function mount(element) {
  const tree = renderNode(element, 'root')
  const out = { nodes: [], texts: [] }
  walk(tree, out)
  out.tree = tree
  out.find = (tag, pred) => out.nodes.filter((node) => node.tag === tag && (pred === undefined || pred(node.props)))
  out.text = out.texts.join(' | ')
  out.textOf = (node) => walk(node, { nodes: [], texts: [] }).texts.join('')
  out.buttonWithText = (needle) => out.find('button').find((button) => out.textOf(button).includes(needle))
  out.buttonExact = (needle) => out.find('button').find((button) => out.textOf(button).trim() === needle)
  return out
}

/* --------------------------------------------------------- module load */

let captured
globalThis.window = {
  __ModuleLoader__: { load(definition) { captured = definition } },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  baseURI: 'https://host/dataops/proxy/3080/',
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
} catch (error) { /* the runtime's own navigator stays; copy falls back to it */ }

await import(new URL('../lib/client.js', import.meta.url))

/* ------------------------------------------------------------ fixtures */

const SESSION = 's1'

function registrationsFixture() {
  return {
    registrations: [{
      pluginId: 'demo.plugin',
      title: 'Demo plugin',
      order: 10,
      locale: { zh: { 'Demo plugin': '演示插件' }, en: {} },
      items: [
        { key: 'flag', type: 'switch', title: 'Flag', default: false },
        { key: 'label', type: 'text', title: 'Label', default: 'x' },
        { key: 'count', type: 'number', title: 'Count', default: 3, min: 0, max: 10, step: 1, unit: 's' },
        { key: 'mode', type: 'select', title: 'Mode', default: 'a', options: [{ value: 'a', title: 'A' }, { value: 'b', title: 'B' }] },
        { key: 'list', type: 'stringList', title: 'List', default: [] },
      ],
    }],
  }
}

function backendFixture() {
  return {
    registrations: registrationsFixture(),
    values: {
      sessionId: SESSION,
      overrides: { 'demo.plugin': { count: 7 } },
      resolved: { 'demo.plugin': { flag: false, label: 'x', count: 7, mode: 'a', list: ['one', 'two'] } },
    },
    failSet: false,
    failGet: false,
  }
}

/** One plausible host: the four protocol methods, in-memory state. */
function backendHandler(backend) {
  return (url, body) => {
    if (url.includes('registrations.list')) return { status: 200, body: { ok: true, value: backend.registrations } }
    if (url.includes('values.get')) {
      if (backend.failGet) {
        return { status: 503, body: { ok: false, error: { code: 'storage-unavailable', message: 'no storage' } } }
      }
      return { status: 200, body: { ok: true, value: backend.values } }
    }
    if (url.includes('values.set')) {
      if (backend.failSet) {
        backend.failSet = false
        return { status: 500, body: { ok: false, error: { code: 'internal', message: 'boom' } } }
      }
      backend.values = {
        sessionId: SESSION,
        overrides: { 'demo.plugin': Object.assign({}, backend.values.overrides['demo.plugin'], { [body.itemKey]: body.value }) },
        resolved: { 'demo.plugin': Object.assign({}, backend.values.resolved['demo.plugin'], { [body.itemKey]: body.value }) },
      }
      return { status: 200, body: { ok: true, value: backend.values } }
    }
    if (url.includes('values.reset')) return { status: 200, body: { ok: true, value: backend.values } }
    return { status: 404, body: { ok: false, error: { code: 'unknown-method', message: 'no route' } } }
  }
}

/** A fresh plugin activation over a fresh fetch stub. */
function createHarness(backend = backendFixture(), options = {}) {
  hookState.clear()
  frames.length = 0
  // The seat's own hook context: one tab occurrence per harness, so tests can
  // model two panes as two independent instances. tabId === null models a
  // composition that does not deliver the hook at all.
  const tabProps = options.tabId === null
    ? {}
    : { useTabInfo: () => ({ tab: { id: options.tabId === undefined ? 'pane1' : options.tabId } }) }
  const calls = []
  const load = { maxInFlight: 0 }
  let inFlight = 0
  let handler = backendHandler(backend)
  globalThis.fetch = async (url, init) => {
    const body = init.body === undefined ? {} : JSON.parse(init.body)
    inFlight += 1
    load.maxInFlight = Math.max(load.maxInFlight, inFlight)
    calls.push({ url, body, method: init.method, contentType: init.headers['content-type'] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const answer = handler(url, body)
    inFlight -= 1
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body }
  }

  const provided = {}
  const tabDefinitions = []
  const seats = []
  const sidebarCtx = {
    sidebarRightTabs: { register(definition) { tabDefinitions.push(definition); return () => {} } },
    slots: {
      inject(_name, factory) { return factory() },
      register(options, Component) { seats.push({ options, Component }); return () => {} },
    },
  }
  const ctx = {
    provide(name, value) { provided[name] = value },
    effect(fn) { const dispose = fn(); return { dispose } },
    get() { return undefined },
    inject(_deps, callback) { return callback(sidebarCtx) },
  }
  const mod = captured.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error('unexpected require: ' + id)
  })
  mod.apply(ctx)

  const bodySeat = seats.find((seat) => seat.options.name === 'sidebar.right.pane.tab')
  const titleSeat = seats.find((seat) => seat.options.name === 'sidebar.right.pane.tab.title')
  return {
    backend,
    calls,
    load,
    provided,
    tabDefinitions,
    seats,
    mod,
    handler(next) { handler = next },
    service: provided.sessionSettings,
    render: (sessionId = SESSION, standardProps = {}) => mount(ReactStub.createElement(bodySeat.Component, Object.assign({ sessionId }, tabProps, standardProps))),
    renderTitle: (sessionId = SESSION, standardProps = {}) => mount(ReactStub.createElement(titleSeat.Component, Object.assign({ sessionId }, tabProps, standardProps))),
  }
}

const urls = (harness, method) => harness.calls.filter((call) => call.url.includes('/' + method)).map((call) => call.url)

/* ---------------------------------------------------------------- tests */

test('the module registers the package factory and materializes with react only', async () => {
  assert.equal(captured.id, 'dsh-session-settings')
  const mod = captured.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error('unexpected require: ' + id)
  })
  assert.equal(mod.name, 'dsh-session-settings')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
})

test('the tab type and both keyed seats keep the T1 identity', () => {
  const harness = createHarness()
  assert.equal(harness.tabDefinitions.length, 1)
  assert.equal(harness.tabDefinitions[0].id, 'session-settings')
  assert.equal(harness.tabDefinitions[0].kind, 'session-settings')
  assert.equal(typeof harness.tabDefinitions[0].title, 'function')
  assert.equal(typeof harness.tabDefinitions[0].title('dsh-resource://session/s1'), 'string')
  assert.equal(harness.tabDefinitions[0].guide[0].order, 25)
  const keys = harness.seats.map((seat) => seat.options.name + ':' + seat.options.key)
  assert.deepEqual(keys.sort(), ['sidebar.right.pane.tab.title:session-settings', 'sidebar.right.pane.tab:session-settings'])
})

test('the service offers the three contract members plus the page reads', () => {
  const harness = createHarness()
  assert.equal(typeof harness.service.registerRenderer, 'function')
  assert.equal(typeof harness.service.getResolved, 'function')
  assert.equal(typeof harness.service.subscribe, 'function')
  assert.equal(typeof harness.service.setValue, 'function')
  assert.equal(typeof harness.service.reset, 'function')
  assert.equal(typeof harness.service.refresh, 'function')
})

test('every bridge call is a prefixed JSON POST to one of the four protocol methods', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  assert.ok(harness.calls.length >= 2)
  for (const call of harness.calls) {
    assert.equal(call.method, 'POST')
    assert.equal(call.contentType, 'application/json')
    assert.ok(call.url.startsWith('https://host/dataops/proxy/3080/session-settings/api/'), call.url)
    assert.ok(!call.url.includes('//session-settings'), call.url)
  }
  const methods = new Set(harness.calls.map((call) => call.url.split('/api/')[1]))
  for (const method of methods) {
    assert.ok(['registrations.list', 'values.get', 'values.set', 'values.reset'].includes(method), method)
  }
})

test('reads are cached and only a forced refresh refetches them', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  assert.equal(urls(harness, 'registrations.list').length, 1)
  assert.equal(urls(harness, 'values.get').length, 1)
  const before = harness.calls.length
  const resolved = await harness.service.getResolved('demo.plugin', SESSION)
  assert.equal(harness.calls.length, before, 'getResolved must read through the cache')
  assert.deepEqual(resolved, { flag: false, label: 'x', count: 7, mode: 'a', list: ['one', 'two'] })
  await harness.service.refresh(SESSION)
  assert.equal(urls(harness, 'values.get').length, 2, 'refresh refetches')
})

test('writes never overlap and keep submission order', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  harness.load.maxInFlight = 0
  await Promise.all([
    harness.service.setValue('demo.plugin', 'label', SESSION, 'one'),
    harness.service.setValue('demo.plugin', 'label', SESSION, 'two'),
    harness.service.setValue('demo.plugin', 'label', SESSION, 'three'),
  ])
  assert.equal(harness.load.maxInFlight, 1, 'one promise queue, never two writes in flight')
  const sent = harness.calls.filter((call) => call.url.includes('values.set')).map((call) => call.body.value)
  assert.deepEqual(sent, ['one', 'two', 'three'])
  assert.deepEqual(harness.calls.filter((call) => call.url.includes('values.set')).map((call) => call.body.pluginId), ['demo.plugin', 'demo.plugin', 'demo.plugin'])
})

test('a failed write carries the wire code and does not poison the queue', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  harness.backend.failSet = true
  let rejected = null
  await Promise.all([
    harness.service.setValue('demo.plugin', 'count', SESSION, 9).catch((error) => { rejected = error }),
    harness.service.setValue('demo.plugin', 'label', SESSION, 'after-failure'),
  ])
  assert.ok(rejected !== null, 'the failed write rejects')
  assert.equal(rejected.code, 'internal')
  const resolved = await harness.service.getResolved('demo.plugin', SESSION)
  assert.equal(resolved.label, 'after-failure', 'the next write still runs')
})

test('a write lands by replacing local state with the host response (no optimistic flip)', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  // The host answers with a value the client never sent: the client must show
  // the host's truth, never its own guess.
  harness.handler(() => ({
    status: 200,
    body: {
      ok: true,
      value: { sessionId: SESSION, overrides: { 'demo.plugin': { count: 42 } }, resolved: { 'demo.plugin': { flag: true, label: 'host-said-so', count: 42, mode: 'b', list: [] } } },
    },
  }))
  await harness.service.setValue('demo.plugin', 'count', SESSION, 999)
  const resolved = await harness.service.getResolved('demo.plugin', SESSION)
  assert.deepEqual(resolved, { flag: true, label: 'host-said-so', count: 42, mode: 'b', list: [] })
})

test('the page renders every control type, the registrant dictionary and the override badge', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  const page = harness.render()
  assert.ok(page.text.includes('演示插件'), 'registrant locale dictionary wins: ' + page.text.slice(0, 160))
  assert.ok(/会话设置|Session settings/.test(page.text))
  assert.ok(/本会话已改 1 项|1 changed in this session/.test(page.text))
  assert.ok(/已覆盖|overridden/.test(page.text))
  assert.equal(page.find('input', (props) => props.type === 'checkbox').length, 1)
  assert.equal(page.find('input', (props) => props.type === 'number').length, 1)
  assert.equal(page.find('input', (props) => props.type === 'text').length, 1)
  assert.equal(page.find('select').length, 1)
  assert.equal(page.find('textarea').length, 1)
  assert.equal(page.find('option').length, 2)
  assert.ok(page.text.includes('s'), 'the number unit renders')
  assert.ok(page.buttonExact('全部恢复默认') !== undefined || page.buttonExact('Reset all') !== undefined)
  assert.ok(page.buttonExact('整组恢复') !== undefined || page.buttonExact('Reset group') !== undefined)
  assert.ok(page.buttonExact('恢复默认') !== undefined || page.buttonExact('Reset') !== undefined, 'the single-item reset renders on an overridden row')
})

test('a value the built-in control cannot represent is shown read-only, never overwritten', async () => {
  const backend = backendFixture()
  backend.values = {
    sessionId: SESSION,
    overrides: {},
    resolved: { 'demo.plugin': { flag: false, label: 'x', count: 7, mode: 'a', list: [{ path: 'D:/work', alias: 'work', note: '' }] } },
  }
  const harness = createHarness(backend)
  await harness.service.refresh(SESSION)
  const page = harness.render()
  const textareas = page.find('textarea')
  assert.equal(textareas.length, 1)
  assert.equal(textareas[0].props.disabled, true, 'an object list must not be editable by the string control')
  assert.ok(/不能修改/.test(page.text), page.text.slice(0, 300))
})

test('an unrepresentable value cannot be destroyed by the reset actions either', async () => {
  const backend = backendFixture()
  const objects = [{ path: 'D:/work', alias: 'work', note: '' }]
  backend.values = {
    sessionId: SESSION,
    overrides: { 'demo.plugin': { list: objects } },
    resolved: { 'demo.plugin': { flag: false, label: 'x', count: 7, mode: 'a', list: objects } },
  }
  const harness = createHarness(backend)
  await harness.service.refresh(SESSION)
  const page = harness.render()
  assert.equal(page.find('textarea')[0].props.disabled, true)
  const resetItem = page.buttonExact('恢复默认') || page.buttonExact('Reset')
  const resetGroup = page.buttonExact('整组恢复') || page.buttonExact('Reset group')
  assert.equal(resetItem.props.disabled, true, 'the item reset must not clear a value the page cannot show')
  assert.equal(resetGroup.props.disabled, true, 'the group reset must not clear it either')
})

test('a value the built-in control does represent stays editable', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  const page = harness.render()
  const textarea = page.find('textarea')[0]
  assert.notEqual(textarea.props.disabled, true, 'a plain string list keeps its control')
})

test('the override state reaches the controls and the checkbox reflects the resolved value', async () => {
  const harness = createHarness()
  harness.backend.values = {
    sessionId: SESSION,
    overrides: { 'demo.plugin': { flag: true } },
    resolved: { 'demo.plugin': { flag: true, label: 'x', count: 3, mode: 'a', list: [] } },
  }
  await harness.service.refresh(SESSION)
  const page = harness.render()
  const checkbox = page.find('input', (props) => props.type === 'checkbox')[0]
  assert.equal(checkbox.props.checked, true)
  assert.ok(/本会话已改 1 项|1 changed in this session/.test(page.text))
})

test('the empty state explains that no plugin registers settings', async () => {
  const harness = createHarness()
  harness.backend.registrations = { registrations: [] }
  harness.backend.values = { sessionId: SESSION, overrides: {}, resolved: {} }
  await harness.service.refresh(SESSION)
  const page = harness.render()
  assert.ok(/当前没有插件注册会话设置|No plugin registers session settings yet/.test(page.text), page.text.slice(0, 200))
})

test('a storage failure maps to plain words, goes read-only and renders no control', async () => {
  const harness = createHarness()
  harness.backend.failGet = true
  await harness.service.refresh(SESSION)
  const page = harness.render()
  assert.ok(/宿主存储不可用|Host storage is unavailable/.test(page.text), page.text.slice(0, 240))
  assert.ok(/只读|Read-only/.test(page.text))
  assert.ok(page.text.includes('storage-unavailable'))
  assert.equal(page.find('input').length, 0, 'no writable control while the read is failing')
  assert.equal(page.find('select').length, 0)
  assert.equal(page.find('textarea').length, 0)
})

test('an unknown method on the host shows the raw code instead of pretending', async () => {
  const harness = createHarness()
  harness.handler(() => ({ status: 404, body: { ok: false, error: { code: 'unknown-method', message: 'nope' } } }))
  await harness.service.refresh(SESSION)
  const page = harness.render()
  assert.ok(/版本不匹配|version mismatch/.test(page.text), page.text.slice(0, 200))
  assert.ok(/只读|Read-only/.test(page.text))
})

test('the three reset grains send the exact protocol payloads', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  harness.calls.length = 0
  await harness.service.reset('demo.plugin', SESSION, 'flag')
  assert.deepEqual(harness.calls[0].body, { sessionId: SESSION, pluginId: 'demo.plugin', itemKey: 'flag' })
  harness.calls.length = 0
  await harness.service.reset('demo.plugin', SESSION)
  assert.deepEqual(harness.calls[0].body, { sessionId: SESSION, pluginId: 'demo.plugin' })
  harness.calls.length = 0
  await harness.service.reset(undefined, SESSION)
  assert.deepEqual(harness.calls[0].body, { sessionId: SESSION })
  assert.ok(harness.calls[0].url.endsWith('/session-settings/api/values.reset'))
})

test('a registered renderer replaces the default control and its disposer restores it', async () => {
  const harness = createHarness()
  harness.backend.registrations = {
    registrations: [{
      pluginId: 'demo.plugin',
      title: 'Demo plugin',
      order: 10,
      locale: { zh: { 'Demo plugin': '演示插件' }, en: {} },
      items: [{ key: 'flag', type: 'switch', title: 'Flag', default: false }],
    }],
  }
  harness.backend.values = { sessionId: SESSION, overrides: {}, resolved: { 'demo.plugin': { flag: false } } }
  await harness.service.refresh(SESSION)

  const events = []
  const offEvents = harness.service.subscribe((event) => events.push(event))
  let received = null
  function CustomControl(props) {
    received = props
    return ReactStub.createElement('div', { 'data-custom': '1' })
  }
  const dispose = harness.service.registerRenderer('demo.plugin', 'flag', CustomControl)
  assert.ok(events.some((event) => event.kind === 'renderers'), 'registration notifies subscribers')

  const custom = harness.render()
  assert.equal(custom.find('div', (props) => props['data-custom'] === '1').length, 1)
  assert.equal(custom.find('input', (props) => props.type === 'checkbox').length, 0)
  assert.equal(received.value, false)
  assert.equal(received.defaultValue, false)
  assert.equal(received.overridden, false)
  assert.equal(received.pluginId, 'demo.plugin')
  assert.equal(received.sessionId, SESSION)
  assert.equal(typeof received.setValue, 'function')
  assert.equal(typeof received.reset, 'function')

  dispose()
  const reverted = harness.render()
  assert.equal(reverted.find('input', (props) => props.type === 'checkbox').length, 1)
  offEvents()
})

test('bulk resets need a second click; a single item reset does not', async () => {
  const harness = createHarness()
  await harness.service.refresh(SESSION)
  harness.calls.length = 0

  // Session-wide reset: first click arms, second click executes.
  const first = harness.render()
  const resetAll = first.buttonExact('全部恢复默认') || first.buttonExact('Reset all')
  assert.ok(resetAll !== undefined, 'the reset-all button renders')
  resetAll.props.onClick()
  assert.equal(harness.calls.filter((call) => call.url.includes('values.reset')).length, 0, 'arming sends nothing')
  const armed = harness.render()
  const confirmAll = armed.buttonExact('确认全部恢复？') || armed.buttonExact('Confirm reset all?')
  assert.ok(confirmAll !== undefined, 'the button asks for confirmation: ' + armed.text.slice(0, 200))
  confirmAll.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const allCalls = harness.calls.filter((call) => call.url.includes('values.reset'))
  assert.equal(allCalls.length, 1)
  assert.deepEqual(allCalls[0].body, { sessionId: SESSION })
  const disarmed = harness.render()
  assert.ok(disarmed.buttonExact('全部恢复默认') !== undefined || disarmed.buttonExact('Reset all') !== undefined, 'the button disarms after the reset')

  // Group reset: same two-step gate.
  harness.calls.length = 0
  const group = harness.render()
  const resetGroup = group.buttonExact('整组恢复') || group.buttonExact('Reset group')
  resetGroup.props.onClick()
  assert.equal(harness.calls.filter((call) => call.url.includes('values.reset')).length, 0, 'arming sends nothing')
  const groupArmed = harness.render()
  const confirmGroup = groupArmed.buttonExact('确认整组恢复？') || groupArmed.buttonExact('Confirm group reset?')
  assert.ok(confirmGroup !== undefined, 'the group button asks for confirmation')
  confirmGroup.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const groupCalls = harness.calls.filter((call) => call.url.includes('values.reset'))
  assert.equal(groupCalls.length, 1)
  assert.deepEqual(groupCalls[0].body, { sessionId: SESSION, pluginId: 'demo.plugin' })

  // Item reset stays one click.
  harness.calls.length = 0
  const item = harness.render()
  const resetItem = item.buttonExact('恢复默认') || item.buttonExact('Reset')
  resetItem.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const itemCalls = harness.calls.filter((call) => call.url.includes('values.reset'))
  assert.equal(itemCalls.length, 1)
  assert.deepEqual(itemCalls[0].body, { sessionId: SESSION, pluginId: 'demo.plugin', itemKey: 'count' })
})

test('a crashing page is contained instead of blanking the tab', async () => {
  const harness = createHarness()
  harness.backend.registrations = {
    registrations: [{
      pluginId: 'demo.plugin',
      title: 'Demo plugin',
      order: 10,
      locale: { zh: { 'Demo plugin': '演示插件' }, en: {} },
      items: [{ key: 'flag', type: 'switch', title: 'Flag', default: false }],
    }],
  }
  harness.backend.values = { sessionId: SESSION, overrides: {}, resolved: { 'demo.plugin': { flag: false } } }
  await harness.service.refresh(SESSION)
  function ExplodingControl() {
    throw new Error('control exploded')
  }
  harness.service.registerRenderer('demo.plugin', 'flag', ExplodingControl)
  // The boundary reports the crash on the console; the test's audience is the
  // assertion below, so keep the run output clean.
  const realError = console.error
  console.error = () => {}
  let page
  try {
    page = harness.render()
  } finally {
    console.error = realError
  }
  assert.ok(page.text.includes('control exploded'), 'the reason is shown: ' + page.text.slice(0, 200))
  assert.ok(page.buttonExact('重试') !== undefined || page.buttonExact('Retry') !== undefined)
})

test('the tab title follows the copied dictionary', () => {
  const harness = createHarness()
  const title = harness.renderTitle()
  assert.ok(/会话设置|Session settings/.test(title.text), title.text)
})
test('the header shows the session title when the standard kit carries one', async () => {
  const harness = createHarness()
  const sessionId = 'session-abcdef123456'
  await harness.service.refresh(sessionId)
  const page = harness.render(sessionId, {
    useSessions: (selector) => selector({ byId: { [sessionId]: { id: sessionId, title: '我的会话', cwd: '/home/me/project' } } }),
  })
  assert.ok(page.text.includes('我的会话'), 'title wins over cwd: ' + page.text.slice(0, 200))
  assert.ok(!page.text.includes('/home/me/project'), 'the cwd is not shown when a title exists')
  assert.ok(!page.text.includes('session-…456'), 'the truncated id is not the label')
  const line = page.find('div').find((node) => node.props.title === sessionId)
  assert.ok(line !== undefined, 'the whole session id stays in the title attribute')
})

test('the header falls back to the working directory when the title is absent', async () => {
  const harness = createHarness()
  const sessionId = 'session-abcdef123456'
  await harness.service.refresh(sessionId)
  const page = harness.render(sessionId, {
    useSessions: (selector) => selector({ byId: { [sessionId]: { id: sessionId, cwd: '/home/me/project' } } }),
  })
  assert.ok(page.text.includes('/home/me/project'), 'cwd is the label: ' + page.text.slice(0, 200))
  assert.ok(!page.text.includes('我的会话'))
  assert.ok(!page.text.includes('session-…456'), 'the truncated id is not the label')
  assert.ok(page.find('div').some((node) => node.props.title === sessionId))
})

test('the header falls back to the truncated id without a summary or without the kit', async () => {
  const harness = createHarness()
  const sessionId = 'session-abcdef123456'
  await harness.service.refresh(sessionId)
  // (a) the kit is there but has no row for this session
  const unknown = harness.render(sessionId, { useSessions: (selector) => selector({ byId: {} }) })
  assert.ok(unknown.text.includes('session-…456'), 'truncated id: ' + unknown.text.slice(0, 200))
  assert.ok(!unknown.text.includes(sessionId), 'the whole id is not printed in the header line')
  assert.ok(unknown.find('div').some((node) => node.props.title === sessionId), 'the whole id stays in the title attribute')
  // (b) a composition that omits the standard kit entirely must not crash
  const bare = harness.render(sessionId)
  assert.ok(bare.text.includes('session-…456'), 'absent useSessions still renders the fallback: ' + bare.text.slice(0, 200))
})
test('every control carries a stable id/name and the row label points at it', async () => {
  const harness = createHarness()
  // A key no HTML id may contain verbatim proves the escaping is real.
  harness.backend.registrations.registrations[0].items.push({ key: 'weird key/@#', type: 'text', title: 'Weird', default: '' })
  await harness.service.refresh(SESSION)
  const page = harness.render()
  const fields = [...page.find('input'), ...page.find('select'), ...page.find('textarea')]
  assert.equal(fields.length, 6, 'one field per declarative item')
  const ids = fields.map((field) => field.props.id)
  for (const field of fields) {
    assert.ok(typeof field.props.id === 'string' && field.props.id !== '', 'id present: ' + JSON.stringify(field.props))
    assert.ok(field.props.id.startsWith('session-settings-'), field.props.id)
    assert.equal(field.props.name, field.props.id, 'name mirrors the id')
    assert.ok(/^[A-Za-z0-9_-]+$/.test(field.props.id), 'DOM/CSS safe id: ' + field.props.id)
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique: ' + JSON.stringify(ids))
  // Golden ids: the plugin id and every item key are escaped, deterministically.
  assert.deepEqual(ids.slice().sort(), [
    'session-settings-pane1-demo-2eplugin-count',
    'session-settings-pane1-demo-2eplugin-flag',
    'session-settings-pane1-demo-2eplugin-label',
    'session-settings-pane1-demo-2eplugin-list',
    'session-settings-pane1-demo-2eplugin-mode',
    'session-settings-pane1-demo-2eplugin-weird-20key-2f-40-23',
  ])
  const weird = fields.find((field) => field.props.id.includes('weird'))
  assert.ok(weird !== undefined, 'the escaped id is present: ' + JSON.stringify(ids))
  assert.ok(!/[\s/@#]/.test(weird.props.id), 'the raw key never reaches the id: ' + weird.props.id)
  assert.ok(weird.props.id.endsWith('-weird-20key-2f-40-23'), 'escape is deterministic: ' + weird.props.id)
  const labels = page.find('label')
  assert.equal(labels.length, 6, 'every default control has its own label')
  for (const label of labels) {
    assert.ok(ids.includes(label.props.htmlFor), 'label points at a rendered control: ' + String(label.props.htmlFor))
  }
  // A custom renderer replaces the control, so the label must NOT point at an
  // element that no longer exists.
  harness.service.registerRenderer('demo.plugin', 'label', function Custom() { return ReactStub.createElement('input', { id: 'custom' }) })
  const custom = harness.render()
  assert.ok(!custom.find('label').some((label) => label.props.htmlFor === 'session-settings-pane1-demo-2eplugin-label'), 'no dangling label')
})
test('control ids are scoped to the tab occurrence: two panes differ, one pane is stable', async () => {
  const idOf = (page) => page.find('input', (props) => props.type === 'checkbox')[0].props.id

  const left = createHarness(backendFixture(), { tabId: 'pane1' })
  await left.service.refresh(SESSION)
  const first = idOf(left.render())
  const again = idOf(left.render())
  assert.equal(first, 'session-settings-pane1-demo-2eplugin-flag')
  assert.equal(again, first, 'one tab keeps its ids across renders')

  const right = createHarness(backendFixture(), { tabId: 'pane2' })
  await right.service.refresh(SESSION)
  const other = idOf(right.render())
  assert.equal(other, 'session-settings-pane2-demo-2eplugin-flag')
  assert.notEqual(first, other, 'two panes never share a control id')
  assert.ok(!right.render().text.includes('session-settings-pane1'), 'no id leaks across occurrences')

  // A tab id that is not DOM-safe is escaped, not dropped or mangled.
  const odd = createHarness(backendFixture(), { tabId: 'tab/1' })
  await odd.service.refresh(SESSION)
  assert.equal(idOf(odd.render()), 'session-settings-tab-2f1-demo-2eplugin-flag')

  // A seat that never receives the hook context still renders valid ids.
  const bare = createHarness(backendFixture(), { tabId: null })
  await bare.service.refresh(SESSION)
  assert.equal(idOf(bare.render()), 'session-settings-pane-demo-2eplugin-flag')

  // The label follows the same occurrence-scoped id.
  const labelled = left.render()
  const checkboxId = idOf(labelled)
  assert.ok(labelled.find('label').some((label) => label.props.htmlFor === checkboxId), 'label htmlFor matches the scoped id')
  assert.ok(labelled.find('input', (props) => props.type === 'checkbox')[0].props.name === checkboxId)
})
