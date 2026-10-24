/**
 * Host assembly tests: apply() wired to a stand-in Cordis context, driving the
 * real service, the real store and the real bridge over a fake storage domain.
 * Covers the acceptance path end to end without a running Harness.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { apply, RECONCILE_INTERVAL_MS } from '../lib/index.js'
import { API_PREFIX, createBridge } from '../lib/bridge.js'
import { SessionSettingsError } from '../lib/resolve.js'

const silentLogger = { info() {}, warn() {}, error() {} }

/** In-memory KvTable stand-in. */
function createFakeTable(initial = {}) {
  const records = new Map(Object.entries(initial))
  let chain = Promise.resolve()
  const enqueue = fn => {
    const next = chain.then(fn, fn)
    chain = next.then(() => {}, () => {})
    return next
  }
  return {
    records,
    get: key => records.get(key),
    keys: () => records.keys(),
    get size() { return records.size },
    put: (key, value) => enqueue(() => { records.set(key, value) }),
    delete: key => enqueue(() => records.delete(key)),
    update: (key, fn) => enqueue(() => {
      if (!records.has(key)) {
        const error = new Error('missing record')
        error.code = 'missing-key'
        throw error
      }
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    }),
  }
}

/** DomainFacility stand-in returning one table. */
function createFakeFacility(table) {
  return {
    async open(spec) {
      return { name: spec.name, table: () => table, async close() {} }
    },
  }
}

/** Route captured by the webserver stand-in. */
function createHost(services = {}) {
  const all = {
    logger: silentLogger,
    // DSH 0.2.1 composes webStartup; webRuntime is the 0.2.0 fallback that the
    // fallback test installs explicitly.
    webStartup: { trustedHosts: [] },
    profileContext: { name: 'web' },
    ...services,
  }
  const routes = []
  if (all.webServer === undefined) {
    all.webServer = {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    }
  }
  const provided = new Map()
  const disposers = []
  const pending = []
  const child = {
    logger: all.logger,
    loader: all.loader,
    get: name => all[name],
    webServer: all.webServer,
    effect(fn, label) {
      const disposer = fn()
      disposers.push({ label, disposer })
      return () => {}
    },
    inject(deps, cb) { pending.push({ deps, cb, target: child }) },
  }
  const ctx = {
    logger: all.logger,
    loader: all.loader,
    get: name => all[name],
    provide(name, value) { provided.set(name, value); return () => provided.delete(name) },
    effect(fn, label) {
      const disposer = fn()
      disposers.push({ label, disposer })
      return () => {}
    },
    inject(deps, cb) { pending.push({ deps, cb, target: child }) },
  }
  function flush() {
    for (;;) {
      const ready = pending.filter(entry => entry.deps.every(dep => all[dep] !== undefined))
      if (ready.length === 0) return
      for (const entry of ready) pending.splice(pending.indexOf(entry), 1)
      for (const entry of ready) entry.cb(entry.target)
    }
  }
  return { ctx, services: all, provided, routes, disposers, flush, pending }
}

/** Wait for an asynchronous wiring step to settle. */
async function waitFor(predicate, message, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** HTTP call against the captured route. */
async function callRoute(host, options = {}) {
  const route = host.routes[0]
  assert.ok(route !== undefined, 'the bridge route must be registered')
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const request = Readable.from(text === '' ? [] : [Buffer.from(text)])
  request.method = options.method ?? 'POST'
  request.url = options.url ?? API_PREFIX + '/values.get'
  request.headers = options.headers ?? { host: '127.0.0.1:3080' }
  const response = {
    statusCode: 0,
    headersSent: false,
    body: '',
    writeHead(status) { this.statusCode = status; this.headersSent = true },
    end(value) { this.body = value },
  }
  await route.handler(request, response)
  return { status: response.statusCode, json: response.body === '' ? null : JSON.parse(response.body) }
}

/** The registration every host test mounts. */
function sampleRegistration() {
  return {
    pluginId: 'example.plugin',
    title: 'Example',
    items: [
      { key: 'enabled', type: 'switch', title: 'Enabled', default: false },
      { key: 'mode', type: 'select', title: 'Mode', default: 'auto' },
    ],
  }
}

/** Boot a host with a durable fake domain and one registered plugin. */
async function bootHost(options = {}) {
  const table = createFakeTable(options.initialRecords)
  const host = createHost({
    storageDomain: createFakeFacility(table),
    sessionPersistence: { list: options.list ?? (async () => []) },
    ...options.services,
  })
  apply(host.ctx)
  host.flush()
  const service = host.provided.get('sessionSettings')
  assert.ok(service !== undefined, 'apply must provide ctx.sessionSettings')
  if (options.durable !== false) await waitFor(() => service.storageStatus().durable, 'the domain to open')
  return { host, table, service }
}

test('apply provides the protocol service surface', async () => {
  const { service, host } = await bootHost()
  for (const method of ['register', 'listRegistrations', 'get', 'getItem', 'set', 'reset', 'resetSession', 'subscribe']) {
    assert.equal(typeof service[method], 'function', method + ' must exist')
  }
  assert.equal(host.routes.length, 1)
  assert.equal(host.routes[0].kind, 'prefix')
  assert.equal(host.routes[0].path, API_PREFIX)
})

test('the fence reads trusted hosts from webStartup (0.2.1)', async () => {
  const { host } = await bootHost({
    services: {
      webStartup: { trustedHosts: ['dsh.example.test'] },
      // Present but ignored: webStartup is authoritative when provided.
      webRuntime: { trustedHosts: ['legacy.example.test'] },
    },
  })
  const listed = await callRoute(host, {
    url: API_PREFIX + '/registrations.list',
    body: {},
    headers: { host: 'dsh.example.test', origin: 'https://dsh.example.test' },
  })
  assert.equal(listed.status, 200, JSON.stringify(listed.json))
  const ignoredFallback = await callRoute(host, {
    url: API_PREFIX + '/registrations.list',
    body: {},
    headers: { host: 'legacy.example.test' },
  })
  assert.equal(ignoredFallback.status, 403, 'webRuntime must not override webStartup')
  assert.equal(ignoredFallback.json.error.code, 'forbidden')
})

test('the fence falls back to webRuntime when webStartup is absent (0.2.0)', async () => {
  const { host } = await bootHost({
    services: { webStartup: undefined, webRuntime: { trustedHosts: ['legacy.example.test'] } },
  })
  const listed = await callRoute(host, {
    url: API_PREFIX + '/registrations.list',
    body: {},
    headers: { host: 'legacy.example.test' },
  })
  assert.equal(listed.status, 200, JSON.stringify(listed.json))
  const other = await callRoute(host, {
    url: API_PREFIX + '/registrations.list',
    body: {},
    headers: { host: 'dsh.example.test' },
  })
  assert.equal(other.status, 403)
})

test('a value written for session A is invisible to session B', async () => {
  const { service } = await bootHost()
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 'session-a', true)
  assert.deepEqual(service.get('example.plugin', 'session-a'), { enabled: true, mode: 'auto' })
  assert.deepEqual(service.get('example.plugin', 'session-b'), { enabled: false, mode: 'auto' })
  assert.equal(service.getItem('example.plugin', 'enabled', 'session-a'), true)
  assert.equal(service.getItem('example.plugin', 'enabled', 'session-b'), false)
  assert.equal(service.get('unregistered', 'session-a'), undefined)
})

test('setting the default removes the override and the record', async () => {
  const { service, table } = await bootHost()
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 's1', true)
  assert.deepEqual(table.records.get('s1').values, { 'example.plugin': { enabled: true } })
  await service.set('example.plugin', 'enabled', 's1', false)
  assert.equal(table.records.has('s1'), false)
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: false, mode: 'auto' })
})

test('reset restores one item, one plugin, or the whole session', async () => {
  const { service, table } = await bootHost()
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 's1', true)
  await service.set('example.plugin', 'mode', 's1', 'manual')
  await service.reset('example.plugin', 's1', 'enabled')
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: false, mode: 'manual' })
  await service.reset('example.plugin', 's1')
  assert.equal(table.records.has('s1'), false)
  await service.set('example.plugin', 'enabled', 's1', true)
  await service.resetSession('s1')
  assert.equal(table.records.has('s1'), false)
})

test('unknown plugin and item are refused with protocol codes', async () => {
  const { service } = await bootHost()
  service.register(sampleRegistration())
  await assert.rejects(service.set('nope', 'enabled', 's1', true), error => {
    assert.ok(error instanceof SessionSettingsError)
    assert.equal(error.code, 'unknown-plugin')
    return true
  })
  await assert.rejects(service.set('example.plugin', 'nope', 's1', true), error => error.code === 'unknown-item')
  await assert.rejects(service.set('example.plugin', 'enabled', 's1', undefined), error => error.code === 'bad-request')
  await assert.rejects(service.reset('nope', 's1'), error => error.code === 'unknown-plugin')
  assert.throws(() => service.register({ pluginId: 'x', title: 'X', items: [{ key: 'k', type: 'nope', title: 'K', default: 1 }] }), error => error.code === 'bad-request')
})

test('R1-02: mutating a get() result never leaks into later reads or the default', async () => {
  const { service } = await bootHost()
  service.register({
    pluginId: 'r102.consumer',
    title: 'R102',
    items: [
      { key: 'obj', type: 'text', title: 'Obj', default: { nested: { n: 1 } } },
      { key: 'list', type: 'stringList', title: 'List', default: ['a'] },
    ],
  })
  const first = service.get('r102.consumer', 's1')
  first.obj.nested = 999
  first.list.push('b')
  assert.deepEqual(service.get('r102.consumer', 's1'), { obj: { nested: { n: 1 } }, list: ['a'] })
  assert.deepEqual(service.getItem('r102.consumer', 'obj', 's1'), { nested: { n: 1 } })
  assert.deepEqual(service.snapshot('s1').resolved['r102.consumer'], { obj: { nested: { n: 1 } }, list: ['a'] })
  assert.deepEqual(service.listRegistrations()[0].items[0].default, { nested: { n: 1 } }, 'the registration default is untouched')
  // The other session must never see session s1 mutations either.
  assert.deepEqual(service.get('r102.consumer', 's2'), { obj: { nested: { n: 1 } }, list: ['a'] })
})

test('B (host level): a value accepted before storageDomain arrives is not lost', async () => {
  const table = createFakeTable({
    s1: { sessionId: 's1', updatedAt: 1, values: { 'example.plugin': { mode: 'manual' } } },
  })
  // s1 exists as a session: reconciliation must not mistake it for a leak.
  const host = createHost({ sessionPersistence: { list: async () => [{ header: { id: 's1' } }] } })
  apply(host.ctx)
  host.flush()
  const service = host.provided.get('sessionSettings')
  assert.equal(service.storageStatus().durable, false)
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 's1', true)
  // Degraded reads cannot see the durable override yet; the write was accepted.
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: true, mode: 'auto' })
  assert.equal(service.storageStatus().pendingReplay, 1)
  // storageDomain mounts late.
  host.services.storageDomain = createFakeFacility(table)
  host.flush()
  await waitFor(() => service.storageStatus().durable, 'the late domain to open')
  assert.equal(service.storageStatus().pendingReplay, 0)
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: true, mode: 'manual' })
  assert.deepEqual(table.records.get('s1').values, { 'example.plugin': { mode: 'manual', enabled: true } })
})

test('an unusable session id is refused the same way in every storage mode', async () => {
  const { service } = await bootHost()
  service.register(sampleRegistration())
  await assert.rejects(service.set('example.plugin', 'enabled', 'not/a/session', true), error => error.code === 'bad-request')
  assert.throws(() => service.get('example.plugin', 'not/a/session'), error => error.code === 'bad-request')
  await assert.rejects(service.resetSession('bad id'), error => error.code === 'bad-request')
  await assert.rejects(service.set('example.plugin', 'enabled', '', true), error => error.code === 'bad-request')
})

test('a duplicate pluginId names the occupant, and the disposer withdraws it', async () => {
  const { service } = await bootHost()
  const events = []
  const unsubscribe = service.subscribe(change => events.push(change))
  const dispose = service.register(sampleRegistration())
  assert.throws(() => service.register(sampleRegistration()), error => {
    assert.ok(error instanceof SessionSettingsError)
    assert.match(error.message, /Example/)
    return true
  })
  dispose()
  assert.equal(service.listRegistrations().length, 0)
  // The same plugin may register again after its disposer ran.
  service.register(sampleRegistration())
  assert.equal(service.listRegistrations().length, 1)
  unsubscribe()
  assert.deepEqual(events.map(change => change.kind), ['registered', 'unregistered', 'registered'])
})

test('change events carry the value coordinates', async () => {
  const { service } = await bootHost()
  const events = []
  service.subscribe(change => events.push(change))
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 's1', true)
  await service.reset('example.plugin', 's1', 'enabled')
  assert.deepEqual(events, [
    { kind: 'registered', pluginId: 'example.plugin' },
    { kind: 'values', pluginId: 'example.plugin', sessionId: 's1', itemKey: 'enabled' },
    { kind: 'values', pluginId: 'example.plugin', sessionId: 's1', itemKey: 'enabled' },
  ])
  // A throwing subscriber never breaks the writer.
  service.subscribe(() => { throw new Error('bad listener') })
  await service.set('example.plugin', 'mode', 's1', 'manual')
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: false, mode: 'manual' })
})

test('the bridge writes and reads through the same service the host uses', async () => {
  const { host, service, table } = await bootHost()
  service.register(sampleRegistration())
  const listed = await callRoute(host, { url: API_PREFIX + '/registrations.list', body: {} })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.value.registrations[0].items[0].key, 'enabled')

  const written = await callRoute(host, { url: API_PREFIX + '/values.set', body: { sessionId: 's1', pluginId: 'example.plugin', itemKey: 'enabled', value: true } })
  assert.equal(written.status, 200)
  assert.deepEqual(written.json.value.overrides, { 'example.plugin': { enabled: true } })
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: true, mode: 'auto' })
  assert.deepEqual(table.records.get('s1').values, { 'example.plugin': { enabled: true } })

  const read = await callRoute(host, { url: API_PREFIX + '/values.get', body: { sessionId: 's1' } })
  assert.deepEqual(read.json.value.resolved, { 'example.plugin': { enabled: true, mode: 'auto' } })

  const reset = await callRoute(host, { url: API_PREFIX + '/values.reset', body: { sessionId: 's1', pluginId: 'example.plugin' } })
  assert.deepEqual(reset.json.value.overrides, {})
  assert.equal(table.records.has('s1'), false)
})

test('the bridge reports 503 while the store is degraded, and the host keeps working', async () => {
  const host = createHost({ sessionPersistence: { list: async () => [] } })
  apply(host.ctx)
  host.flush()
  const service = host.provided.get('sessionSettings')
  const status = service.storageStatus()
  assert.equal(status.durable, false)
  assert.equal(status.backend, 'memory')
  const listed = await callRoute(host, { url: API_PREFIX + '/registrations.list', body: {} })
  assert.equal(listed.status, 200)
  const read = await callRoute(host, { url: API_PREFIX + '/values.get', body: { sessionId: 's1' } })
  assert.equal(read.status, 503)
  assert.equal(read.json.error.code, 'storage-unavailable')
  // In-process consumers still work: the degradation is announced, not hidden.
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 's1', true)
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: true, mode: 'auto' })
})

test('two concurrent sets on a brand-new session both land', async () => {
  const { service, table } = await bootHost()
  service.register(sampleRegistration())
  await Promise.all([
    service.set('example.plugin', 'enabled', 'fresh', true),
    service.set('example.plugin', 'mode', 'fresh', 'manual'),
  ])
  assert.deepEqual(service.get('example.plugin', 'fresh'), { enabled: true, mode: 'manual' })
  assert.deepEqual(table.records.get('fresh').values, { 'example.plugin': { enabled: true, mode: 'manual' } })
  // The record was created once: the second writer saw the first writer's record.
  assert.equal(table.records.size, 1)
})

test('a missing sessionPersistence leaves a trace instead of silence', async () => {
  const warnings = []
  const logger = { info() {}, warn: message => warnings.push(message), error() {} }
  const host = createHost({ logger, loader: { await: async () => {} }, storageDomain: createFakeFacility(createFakeTable()) })
  apply(host.ctx)
  host.flush()
  await waitFor(() => warnings.some(message => message.includes('reconciliation')), 'the mount-time trace')
  assert.ok(
    warnings.some(message => message.includes('reconciliation') && message.includes('not assembled')),
    'mount must say that reconciliation was never assembled: ' + JSON.stringify(warnings),
  )
  assert.ok(
    warnings.every(message => message.includes('dsh-session-settings')),
    'every trace is attributed to this plugin',
  )
})

test('an assembled reconciliation says so, and a skip is explained once', async () => {
  const infos = []
  const warnings = []
  const logger = { info: message => infos.push(message), warn: message => warnings.push(message), error() {} }
  const host = createHost({
    logger,
    loader: { await: async () => {} },
    storageDomain: createFakeFacility(createFakeTable()),
    sessionPersistence: { list: async () => [] },
  })
  apply(host.ctx)
  host.flush()
  const service = host.provided.get('sessionSettings')
  await waitFor(() => service.storageStatus().durable, 'the domain to open')
  await waitFor(() => infos.some(message => message.includes('reconciliation assembled')), 'the assembly line')
  assert.deepEqual(warnings, [], 'a healthy deployment must not warn')

  // The memory-degraded skip is also explainable.
  const degradedWarnings = []
  const degraded = createHost({
    logger: { info() {}, warn: message => degradedWarnings.push(message), error() {} },
    sessionPersistence: { list: async () => [] },
  })
  apply(degraded.ctx)
  degraded.flush()
  const degradedService = degraded.provided.get('sessionSettings')
  assert.equal(degradedService.storageStatus().durable, false)
  await callRoute(degraded, { url: API_PREFIX + '/registrations.list', body: {} })
  await waitFor(() => degradedWarnings.some(message => message.includes('in memory')), 'the degraded skip trace')
})

/** Wrap a table so its update() fails once, making the first replay attempt fail. */
function createFlakyOnceTable(table) {
  let failNext = true
  return {
    records: table.records,
    calls: table.calls,
    get: key => table.get(key),
    keys: () => table.keys(),
    get size() { return table.size },
    put: (key, value) => table.put(key, value),
    delete: key => table.delete(key),
    update(key, fn) {
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('backend hiccup'))
      }
      return table.update(key, fn)
    },
  }
}

/** Boot a host that starts degraded, writes while degraded, then gets a flaky domain. */
async function bootPendingHost(options = {}) {
  const base = createFakeTable(options.initial ?? {
    s1: { sessionId: 's1', updatedAt: 1, values: { 'example.plugin': { mode: 'manual' } } },
  })
  const flaky = createFlakyOnceTable(base)
  const infos = []
  const logger = { info: message => infos.push(message), warn() {}, error() {} }
  const host = createHost({ logger, sessionPersistence: { list: options.list ?? (async () => [{ header: { id: 's1' } }]) } })
  apply(host.ctx)
  host.flush()
  const service = host.provided.get('sessionSettings')
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 's1', true)
  assert.equal(service.storageStatus().durable, false)
  host.services.storageDomain = createFakeFacility(flaky)
  host.flush()
  const settle = () => service.storageStatus().durable
    && (options.waitForPending === false || service.storageStatus().pendingReplay === 1)
  await waitFor(settle, options.waitForPending === false ? 'the domain to open' : 'the failed replay to leave a pending value')
  return { host, service, base, flaky, infos }
}

test('V3-01: restore-to-default and reset(item) work while a key is pending', async () => {
  const { host, service } = await bootPendingHost()
  assert.equal(service.getItem('example.plugin', 'enabled', 's1'), true, 'the pending value is readable')

  // (1) writing the item's default must delete the override, pending copy included.
  await service.set('example.plugin', 'enabled', 's1', false)
  assert.equal(service.getItem('example.plugin', 'enabled', 's1'), false, 'the override must be gone, not shadowed by pending')
  assert.equal(service.storageStatus().pendingReplay, 0, 'the effective state is durable now')
  assert.deepEqual(service.snapshot('s1').overrides, { 'example.plugin': { mode: 'manual' } })

  // (2) the same through the bridge, then reset(item) on the fresh override.
  const written = await callRoute(host, { url: API_PREFIX + '/values.set', body: { sessionId: 's1', pluginId: 'example.plugin', itemKey: 'enabled', value: true } })
  assert.equal(written.json.value.resolved['example.plugin'].enabled, true)
  const reset = await callRoute(host, { url: API_PREFIX + '/values.reset', body: { sessionId: 's1', pluginId: 'example.plugin', itemKey: 'enabled' } })
  assert.equal(reset.json.value.resolved['example.plugin'].enabled, false)
  assert.deepEqual(reset.json.value.overrides, { 'example.plugin': { mode: 'manual' } })
  assert.equal(service.getItem('example.plugin', 'enabled', 's1'), false)
})

test('V3-01: resetSession while a value is pending is not undone by the replay', async () => {
  const { service, base } = await bootPendingHost()
  assert.equal(service.getItem('example.plugin', 'enabled', 's1'), true)
  await service.resetSession('s1')
  assert.equal(service.getItem('example.plugin', 'enabled', 's1'), false, 'resetSession must clear the pending copy too')
  assert.equal(service.storageStatus().pendingReplay, 0, 'nothing is left for the timer to replay')
  assert.equal(base.records.has('s1'), false)
  // The tick-level proof that no replay can bring it back lives in the store
  // suite (short retry interval); here a wait shows nothing recreates the record.
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(base.records.has('s1'), false, 'the deleted record must not be resurrected')
})

test('V3-02: reconciliation clears the pending copy of a deleted session for good', async () => {
  // sessionPersistence no longer knows s1, so reconciliation must reclaim it.
  const { service, base, infos } = await bootPendingHost({ list: async () => [], waitForPending: false })
  await waitFor(() => service.storageStatus().pendingReplay === 0, 'reconciliation to reclaim the pending copy')
  await waitFor(() => base.records.has('s1') === false, 'reconciliation to remove the record')
  assert.equal(service.getItem('example.plugin', 'enabled', 's1'), false, 'the reclaimed value must not stay readable')
  assert.equal(service.storageStatus().pendingReplay, 0, 'the pending copy is part of the reclaim')
  assert.equal(base.records.has('s1'), false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(base.records.has('s1'), false, 'the reclaimed record must not be resurrected')
  assert.ok(infos.some(message => message.includes('reconciliation removed')), 'the reconcile line reports the removal')
  assert.ok(
    infos.some(message => message.includes('dropped 1 pending override set') && message.includes('together with its durable record')),
    'the pending clearance is visible and names the durable record it went with',
  )
})

test('R2-01: a value whose replay failed stays readable through the service and the bridge', async () => {
  const base = createFakeTable({ s1: { sessionId: 's1', updatedAt: 1, values: { 'example.plugin': { mode: 'manual' } } } })
  let failNext = true
  const flaky = {
    get: key => base.get(key),
    keys: () => base.keys(),
    get size() { return base.size },
    put: (key, value) => base.put(key, value),
    delete: key => base.delete(key),
    update(key, fn) {
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('backend hiccup'))
      }
      return base.update(key, fn)
    },
  }
  const host = createHost({ sessionPersistence: { list: async () => [{ header: { id: 's1' } }] } })
  apply(host.ctx)
  host.flush()
  const service = host.provided.get('sessionSettings')
  service.register(sampleRegistration())
  await service.set('example.plugin', 'enabled', 's1', true)
  assert.equal(service.storageStatus().durable, false)
  host.services.storageDomain = createFakeFacility(flaky)
  host.flush()
  await waitFor(() => service.storageStatus().durable, 'the late domain to open')
  assert.equal(service.storageStatus().pendingReplay, 1, 'the replay failed and the value is held')
  assert.equal(service.storageStatus().retryScheduled, true)
  // The accepted write is readable through every consumer reader...
  assert.deepEqual(service.get('example.plugin', 's1'), { enabled: true, mode: 'manual' })
  assert.equal(service.getItem('example.plugin', 'enabled', 's1'), true)
  // The durable 'mode' override and the still-pending 'enabled' one are both real
  // overrides; the snapshot sees the overlay, not just the durable record.
  assert.deepEqual(service.snapshot('s1').overrides, { 'example.plugin': { enabled: true, mode: 'manual' } })
  assert.deepEqual(service.snapshot('s1').resolved['example.plugin'], { enabled: true, mode: 'manual' })
  // ...and through the bridge.
  const read = await callRoute(host, { url: API_PREFIX + '/values.get', body: { sessionId: 's1' } })
  assert.equal(read.status, 200)
  assert.equal(read.json.value.resolved['example.plugin'].enabled, true)
  // The failed attempt did not clobber the durable record.
  assert.deepEqual(base.records.get('s1').values, { 'example.plugin': { mode: 'manual' } })
})

test('R2-04: the registration listing hands out copies of item defaults', async () => {
  const { service } = await bootHost()
  const registration = {
    pluginId: 'r204.consumer',
    title: 'R204',
    items: [{ key: 'obj', type: 'text', title: 'Obj', default: { nested: { n: 1 } } }],
  }
  service.register(registration)
  const bridge = createBridge({ service })
  const listed = await bridge.dispatch('registrations.list', {})
  listed.registrations[0].items[0].default.nested.n = 999
  assert.deepEqual(registration.items[0].default, { nested: { n: 1 } }, 'the listing must not alias the registration')
  assert.deepEqual(service.get('r204.consumer', 's1'), { obj: { nested: { n: 1 } } })
})

test('R2-05: set() copies its input, so the caller keeps ownership of its object', async () => {
  const { service, table } = await bootHost()
  service.register({
    pluginId: 'r205.consumer',
    title: 'R205',
    items: [{ key: 'obj', type: 'text', title: 'Obj', default: { nested: { n: 1 } } }],
  })
  const mine = { nested: { n: 2 } }
  await service.set('r205.consumer', 'obj', 's1', mine)
  mine.nested.n = 999
  assert.deepEqual(service.get('r205.consumer', 's1'), { obj: { nested: { n: 2 } } })
  assert.deepEqual(table.records.get('s1').values, { 'r205.consumer': { obj: { nested: { n: 2 } } } })
})

test('startup reconciliation drops records of deleted sessions and keeps archived ones', async () => {
  const { service, table } = await bootHost({
    initialRecords: {
      kept: { sessionId: 'kept', updatedAt: 1, values: { p: { k: 1 } } },
      stale: { sessionId: 'stale', updatedAt: 1, values: { p: { k: 2 } } },
    },
    list: async () => [{ header: { id: 'kept' } }],
  })
  await waitFor(() => table.records.has('stale') === false, 'reconciliation to remove the stale record')
  assert.equal(table.records.has('kept'), true)
  assert.deepEqual(service.get('example.plugin', 'kept'), undefined, 'no plugin is registered in this host')
})

test('reconciliation is never driven by session/disposed and stays low frequency', async () => {
  let listCalls = 0
  const { host, table } = await bootHost({
    initialRecords: { gone: { sessionId: 'gone', updatedAt: 1, values: { p: { k: 1 } } } },
    list: async () => { listCalls += 1; return [{ header: { id: 'gone-kept' } }] },
  })
  await waitFor(() => table.records.size === 0, 'the startup pass to run')
  const afterStartup = listCalls
  // Every bridge request may only trigger a pass once the interval elapsed.
  for (let index = 0; index < 5; index += 1) await callRoute(host, { url: API_PREFIX + '/values.get', body: { sessionId: 's1' } })
  assert.equal(listCalls, afterStartup, 'a burst of requests must not re-reconcile')
  assert.ok(RECONCILE_INTERVAL_MS >= 60 * 1000, 'reconciliation is a low-frequency pass')
})
