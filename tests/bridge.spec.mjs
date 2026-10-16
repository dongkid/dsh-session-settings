/**
 * Bridge tests: the fence, the four method names, the status/error codes of
 * protocol 1 and 6, and the anti-drift check that the dispatch table still
 * matches the frozen protocol document.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

import { API_PREFIX, METHOD_NAMES, createBridge } from '../lib/bridge.js'
import { SessionSettingsError } from '../lib/resolve.js'
import { isLoopbackHostname } from '../lib/trust-fence.js'

/** The registration the stub service reports. */
const STUB_REGISTRATION = {
  pluginId: 'example.plugin',
  title: 'Example',
  order: 1,
  items: [{ key: 'enabled', type: 'switch', title: 'Enabled', default: false }],
}

/** Host service stand-in: records write calls, returns a fixed snapshot. */
function createStubService() {
  const calls = []
  return {
    calls,
    listRegistrations() { return [STUB_REGISTRATION] },
    snapshot(sessionId) { return { sessionId, overrides: {}, resolved: { 'example.plugin': { enabled: false } } } },
    async set(...args) { calls.push(['set', ...args]) },
    async reset(...args) { calls.push(['reset', ...args]) },
  }
}

/** One node-request stand-in carrying a JSON body. */
function makeRequest(options = {}) {
  const method = options.method ?? 'POST'
  const url = options.url ?? API_PREFIX + '/values.get'
  const headers = options.headers ?? { host: '127.0.0.1:3080' }
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const request = Readable.from(text === '' ? [] : [Buffer.from(text)])
  request.method = method
  request.url = url
  request.headers = headers
  return request
}

/** One node-response stand-in capturing status, headers and body. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    headersSent: false,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    end(text) {
      this.body = text
    },
  }
}

/** Drive the registered handler once. */
async function call(handler, options) {
  const response = makeResponse()
  await handler(makeRequest(options), response)
  return { status: response.statusCode, headers: response.headers, json: response.body === '' ? null : JSON.parse(response.body) }
}

/** A bridge over a stub service with a healthy, loopback-only deployment. */
function makeBridge(options = {}) {
  return createBridge({
    service: options.service ?? createStubService(),
    storageStatus: options.storageStatus ?? (() => ({ durable: true, backend: 'storageDomain', reason: null })),
    trustedHosts: options.trustedHosts ?? (() => []),
    onActivity: options.onActivity,
  })
}

test('the dispatch table is exactly the protocol method table', () => {
  const document = readFileSync(new URL('../docs/protocol-v1.md', import.meta.url), 'utf8')
  const declared = [...document.matchAll(/^### 2\.\d+ (\S+)$/gm)].map(match => match[1])
  assert.equal(declared.length, 4, 'protocol-v1.md must declare exactly four methods')
  assert.deepEqual(declared, [...METHOD_NAMES])
  const bridge = makeBridge()
  assert.deepEqual(Object.keys(bridge.methods), [...METHOD_NAMES])
  assert.equal(API_PREFIX, '/session-settings/api')
  // The client half is built against the same document; keep the two in sync.
  const design = readFileSync(new URL('../docs/design-v1.md', import.meta.url), 'utf8')
  for (const name of declared) assert.ok(design.includes(name), name + ' must also be described in design-v1.md')
})

test('loopback detection follows the official rule', () => {
  assert.ok(isLoopbackHostname('localhost'))
  assert.ok(isLoopbackHostname('127.0.0.1'))
  assert.ok(isLoopbackHostname('127.8.9.10'))
  assert.ok(isLoopbackHostname('[::1]'))
  assert.ok(!isLoopbackHostname('127.0.0.256'))
  assert.ok(!isLoopbackHostname('127.0.0'))
  assert.ok(!isLoopbackHostname('evil.com'))
})

test('the fence rejects requests that are not ours', async () => {
  const bridge = makeBridge({ trustedHosts: () => ['harness.internal'] })
  const cases = [
    { name: 'no host header', headers: {}, status: 403 },
    { name: 'foreign host', headers: { host: 'evil.com' }, status: 403 },
    { name: 'unparsable host', headers: { host: 'http://evil.com/x' }, status: 403 },
    { name: 'cross-site marker', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, status: 403 },
    { name: 'foreign origin', headers: { host: '127.0.0.1:3080', origin: 'https://evil.com' }, status: 403 },
    { name: 'opaque origin', headers: { host: '127.0.0.1:3080', origin: 'null' }, status: 403 },
    { name: 'loopback', headers: { host: '127.0.0.1:3080' }, status: 200 },
    { name: 'localhost', headers: { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }, status: 200 },
    { name: 'trusted host', headers: { host: 'harness.internal' }, status: 200 },
    // A port-less trustedHosts entry authorizes every port (official rule).
    { name: 'trusted port-less entry, any port', headers: { host: 'harness.internal:9999' }, status: 200 },
    { name: 'same-hostname origin', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9' }, status: 200 },
    { name: 'desktop shell origin', headers: { host: '127.0.0.1:3080', origin: 'dsh-app://app' }, status: 200 },
  ]
  for (const entry of cases) {
    // registrations.list needs no fields, so a 200 here proves the fence let the
    // request through and a non-200 proves it did not.
    const result = await call(bridge.handle, { headers: entry.headers, url: API_PREFIX + '/registrations.list', body: {} })
    assert.equal(result.status, entry.status, entry.name + ' -> ' + JSON.stringify(result.json))
    if (entry.status === 403) assert.equal(result.json.error.code, 'forbidden')
  }
})

test('non-POST is 405 and the body is never dispatched', async () => {
  const service = createStubService()
  const bridge = makeBridge({ service })
  const result = await call(bridge.handle, { method: 'GET', body: undefined })
  assert.equal(result.status, 405)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'method-not-allowed')
  assert.deepEqual(service.calls, [])
})

test('unknown methods are 404, including prototype members', async () => {
  const bridge = makeBridge()
  for (const method of ['nope', 'constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const result = await call(bridge.handle, { url: API_PREFIX + '/' + method, body: {} })
    assert.equal(result.status, 404, method)
    assert.equal(result.json.error.code, 'unknown-method')
  }
  for (const url of [API_PREFIX, API_PREFIX + '/', API_PREFIX + '/values.get/extra', '/session-settings']) {
    const result = await call(bridge.handle, { url, body: {} })
    assert.equal(result.status, 404, url)
  }
})

test('a malformed body is 400 and the method is not called', async () => {
  const service = createStubService()
  const bridge = makeBridge({ service })
  const bad = Readable.from([Buffer.from('{not json')])
  bad.method = 'POST'
  bad.url = API_PREFIX + '/values.get'
  bad.headers = { host: '127.0.0.1:3080' }
  const response = makeResponse()
  await bridge.handle(bad, response)
  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error.code, 'bad-request')

  const oversized = await call(bridge.handle, { body: { sessionId: 'x'.repeat(1024 * 1024 + 10) } })
  assert.equal(oversized.status, 400)
  assert.deepEqual(service.calls, [])
})

test('missing and malformed fields are 400 with the protocol code', async () => {
  const bridge = makeBridge()
  const cases = [
    { url: API_PREFIX + '/values.get', body: {} },
    { url: API_PREFIX + '/values.get', body: { sessionId: 42 } },
    { url: API_PREFIX + '/values.set', body: { sessionId: 's', pluginId: 'p' } },
    { url: API_PREFIX + '/values.set', body: { sessionId: 's', pluginId: 'p', itemKey: 'k' } },
    { url: API_PREFIX + '/values.reset', body: { itemKey: 'k' } },
    { url: API_PREFIX + '/values.reset', body: { sessionId: 's', itemKey: 'k' } },
    { url: API_PREFIX + '/values.reset', body: { sessionId: 's', pluginId: '' } },
  ]
  for (const entry of cases) {
    const result = await call(bridge.handle, entry)
    assert.equal(result.status, 400, JSON.stringify(entry))
    assert.equal(result.json.error.code, 'bad-request', JSON.stringify(result.json))
  }
})

test('values.* report storage-unavailable when the host degraded to memory', async () => {
  const bridge = makeBridge({
    storageStatus: () => ({ durable: false, backend: 'memory', reason: 'storageDomain service is not available' }),
  })
  for (const [name, body] of [
    ['values.get', { sessionId: 's' }],
    ['values.set', { sessionId: 's', pluginId: 'p', itemKey: 'k', value: 1 }],
    ['values.reset', { sessionId: 's' }],
  ]) {
    const result = await call(bridge.handle, { url: API_PREFIX + '/' + name, body })
    assert.equal(result.status, 503, name)
    assert.equal(result.json.error.code, 'storage-unavailable')
    assert.match(result.json.error.message, /restart/)
  }
  // The registration list needs no storage: the page can still render its shell.
  const listed = await call(bridge.handle, { url: API_PREFIX + '/registrations.list', body: {} })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.ok, true)
  assert.equal(listed.json.value.registrations[0].pluginId, 'example.plugin')
})

test('success responses use the protocol envelope and content type', async () => {
  const service = createStubService()
  const bridge = makeBridge({ service })
  const result = await call(bridge.handle, { url: API_PREFIX + '/values.set', body: { sessionId: 's1', pluginId: 'example.plugin', itemKey: 'enabled', value: true } })
  assert.equal(result.status, 200)
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.value, { sessionId: 's1', overrides: {}, resolved: { 'example.plugin': { enabled: false } } })
  assert.deepEqual(service.calls, [['set', 'example.plugin', 'enabled', 's1', true]])
})

test('service failures map to their own codes, anything else to 500', async () => {
  const service = createStubService()
  service.set = async () => { throw new SessionSettingsError('unknown-plugin', 'no such plugin') }
  const bridge = makeBridge({ service })
  const mapped = await call(bridge.handle, { url: API_PREFIX + '/values.set', body: { sessionId: 's', pluginId: 'p', itemKey: 'k', value: 1 } })
  assert.equal(mapped.status, 400)
  assert.equal(mapped.json.error.code, 'unknown-plugin')

  const exploding = createStubService()
  exploding.snapshot = () => { throw new Error('disk on fire') }
  const second = makeBridge({ service: exploding })
  const internal = await call(second.handle, { url: API_PREFIX + '/values.get', body: { sessionId: 's' } })
  assert.equal(internal.status, 500)
  assert.equal(internal.json.error.code, 'internal')
})

test('dispatch() is the same table the route uses', async () => {
  const bridge = makeBridge()
  const value = await bridge.dispatch('registrations.list', {})
  assert.equal(value.registrations.length, 1)
  assert.throws(() => bridge.dispatch('nope', {}), error => {
    assert.ok(error instanceof SessionSettingsError)
    assert.equal(error.code, 'unknown-method')
    return true
  })
  assert.throws(() => bridge.dispatch('constructor', {}), error => error.code === 'unknown-method')
})

test('the activity hook runs after the fence and before dispatch', async () => {
  const order = []
  const service = createStubService()
  service.listRegistrations = () => { order.push('dispatch'); return [STUB_REGISTRATION] }
  const bridge = makeBridge({ service, onActivity: () => order.push('activity') })
  await call(bridge.handle, { url: API_PREFIX + '/registrations.list', body: {} })
  await call(bridge.handle, { method: 'GET', body: undefined })
  await call(bridge.handle, { headers: { host: 'evil.com' } })
  assert.deepEqual(order, ['activity', 'dispatch'])
})
