/**
 * Pure-logic tests: two-layer resolution, sparse merge, reconciliation.
 * No DSH runtime involved — this is exactly the layer that hides the subtle
 * bugs, so it is pinned down directly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ITEM_TYPES,
  ERROR_STATUS,
  SessionSettingsError,
  errorStatus,
  isJsonValue,
  jsonEqual,
  normalizeRegistration,
  serializeRegistration,
  sanitizeOverrides,
  resolveValues,
  resolveOverrides,
  buildSnapshot,
  setValue,
  resetValues,
  reconcileSessionIds,
} from '../lib/resolve.js'

/** One well-formed registration used across the cases below. */
function registration(overrides = {}) {
  return {
    pluginId: 'example.plugin',
    title: 'Example',
    order: 10,
    items: [
      { key: 'enabled', type: 'switch', title: 'Enabled', default: false },
      { key: 'mode', type: 'select', title: 'Mode', default: 'auto', options: [
        { value: 'auto', title: 'Auto' },
        { value: 'manual', title: 'Manual' },
      ] },
      { key: 'tags', type: 'stringList', title: 'Tags', default: ['a'] },
      { key: 'count', type: 'number', title: 'Count', default: 3, min: 1, max: 9, step: 1, unit: 'x' },
    ],
    ...overrides,
  }
}

test('item types are the five frozen by the protocol', () => {
  assert.deepEqual([...ITEM_TYPES], ['switch', 'text', 'number', 'select', 'stringList'])
  assert.ok(Object.isFrozen(ITEM_TYPES))
})

test('error codes map to the protocol status table, unknown to 500', () => {
  assert.equal(errorStatus('forbidden'), 403)
  assert.equal(errorStatus('method-not-allowed'), 405)
  assert.equal(errorStatus('unknown-method'), 404)
  assert.equal(errorStatus('bad-request'), 400)
  assert.equal(errorStatus('unknown-plugin'), 400)
  assert.equal(errorStatus('unknown-item'), 400)
  assert.equal(errorStatus('conflict'), 409)
  assert.equal(errorStatus('storage-unavailable'), 503)
  assert.equal(errorStatus('internal'), 500)
  assert.equal(errorStatus('constructor'), 500)
  assert.equal(errorStatus('toString'), 500)
  assert.equal(Object.keys(ERROR_STATUS).length, 9)
})

test('SessionSettingsError carries its protocol code', () => {
  const error = new SessionSettingsError('unknown-item', 'nope')
  assert.equal(error.code, 'unknown-item')
  assert.equal(error.name, 'SessionSettingsError')
  assert.ok(error instanceof Error)
})

test('isJsonValue accepts JSON and rejects everything else', () => {
  assert.ok(isJsonValue(null))
  assert.ok(isJsonValue('x'))
  assert.ok(isJsonValue(0))
  assert.ok(isJsonValue(false))
  assert.ok(isJsonValue([1, { a: [true, null] }]))
  assert.ok(!isJsonValue(undefined))
  assert.ok(!isJsonValue(() => {}))
  assert.ok(!isJsonValue(Symbol('s')))
  assert.ok(!isJsonValue(Number.NaN))
  assert.ok(!isJsonValue(Number.POSITIVE_INFINITY))
  assert.ok(!isJsonValue({ a: undefined }))
  const cyclic = {}
  cyclic.self = cyclic
  assert.ok(!isJsonValue(cyclic))
})

test('jsonEqual compares JSON structures deeply', () => {
  assert.ok(jsonEqual(1, 1))
  assert.ok(jsonEqual('a', 'a'))
  assert.ok(jsonEqual([1, [2]], [1, [2]]))
  assert.ok(jsonEqual({ a: 1, b: [2] }, { b: [2], a: 1 }))
  assert.ok(!jsonEqual({ a: 1 }, { a: '1' }))
  assert.ok(!jsonEqual([1], [1, 2]))
  assert.ok(!jsonEqual(null, undefined))
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: 2 }))
})

test('normalizeRegistration accepts a good registration verbatim', () => {
  const normalized = normalizeRegistration(registration())
  assert.equal(normalized.pluginId, 'example.plugin')
  assert.equal(normalized.order, 10)
  assert.equal(normalized.items.length, 4)
})

test('normalizeRegistration rejects malformed registrations loudly', () => {
  const bad = [
    null,
    [],
    {},
    registration({ pluginId: '' }),
    registration({ title: 42 }),
    registration({ order: 'high' }),
    registration({ items: undefined }),
    registration({ items: [{ key: 'a', type: 'nope', title: 'A', default: 1 }] }),
    registration({ items: [{ key: 'a', type: 'text', title: 'A' }] }),
    registration({ items: [{ key: 'a', type: 'text', title: 'A', default: undefined }] }),
    registration({ items: [{ key: 'a', type: 'text', title: 'A', default: () => {} }] }),
    registration({ items: [
      { key: 'a', type: 'text', title: 'A', default: 1 },
      { key: 'a', type: 'text', title: 'B', default: 2 },
    ] }),
  ]
  for (const candidate of bad) {
    assert.throws(() => normalizeRegistration(candidate), error => {
      assert.ok(error instanceof SessionSettingsError, 'expected SessionSettingsError for ' + JSON.stringify(candidate))
      assert.equal(error.code, 'bad-request')
      return true
    })
  }
})

test('serializeRegistration evaluates thunks host side and keeps locale', () => {
  const normalized = normalizeRegistration({
    pluginId: 'thunks',
    title: () => 'Title now',
    order: 2,
    locale: { zh: { Title: '标题' }, en: {} },
    items: [
      { key: 'a', type: 'number', title: () => 'A', description: () => 'desc', default: 1, min: 0, max: 5, step: 1, unit: 'px', placeholder: 'p' },
      { key: 'b', type: 'select', title: 'B', default: 'x', options: [{ value: 'x', title: () => 'X' }] },
    ],
  })
  const serialized = serializeRegistration(normalized)
  assert.equal(serialized.title, 'Title now')
  assert.deepEqual(serialized.locale, { zh: { Title: '标题' }, en: {} })
  assert.equal(serialized.items[0].title, 'A')
  assert.equal(serialized.items[0].description, 'desc')
  assert.equal(serialized.items[0].min, 0)
  assert.equal(serialized.items[0].unit, 'px')
  assert.equal(serialized.items[0].placeholder, 'p')
  assert.equal(serialized.items[1].options[0].title, 'X')
  assert.equal(JSON.stringify(serialized).includes('function'), false)
  // A thunk that throws must not take the whole listing down.
  const exploding = normalizeRegistration({ pluginId: 'boom', title: () => { throw new Error('nope') }, items: [] })
  assert.equal(serializeRegistration(exploding).title, '')
})

test('resolveValues is exactly two layers and invents nothing', () => {
  const normalized = normalizeRegistration(registration())
  assert.deepEqual(resolveValues(normalized, undefined), { enabled: false, mode: 'auto', tags: ['a'], count: 3 })
  assert.deepEqual(resolveValues(normalized, { enabled: true, mode: 'manual', tags: ['a'], count: 3 }), {
    enabled: true, mode: 'manual', tags: ['a'], count: 3,
  })
  // A stored key for an item this registration does not have is not invented.
  assert.deepEqual(resolveValues(normalized, { ghost: 1 }), { enabled: false, mode: 'auto', tags: ['a'], count: 3 })
})

test('resolved values are copies: mutating a result never touches the registration', () => {
  const normalized = normalizeRegistration({
    pluginId: 'copies',
    title: 'Copies',
    items: [
      { key: 'obj', type: 'text', title: 'Obj', default: { nested: { n: 1 } } },
      { key: 'list', type: 'stringList', title: 'List', default: ['a'] },
    ],
  })
  const first = resolveValues(normalized, undefined)
  assert.notEqual(first.obj, normalized.items[0].default, 'the default must not be handed out by reference')
  assert.notEqual(first.list, normalized.items[1].default)
  first.obj.nested.n = 999
  first.list.push('b')
  assert.deepEqual(normalized.items[0].default, { nested: { n: 1 } })
  assert.deepEqual(resolveValues(normalized, undefined), { obj: { nested: { n: 1 } }, list: ['a'] })

  // The override layer is copied on the way out too.
  const stored = { obj: { nested: { n: 2 } } }
  const second = resolveValues(normalized, stored)
  second.obj.nested.n = 3
  assert.deepEqual(stored, { obj: { nested: { n: 2 } } })
  const kept = resolveOverrides(normalized, { list: ['b'] })
  kept.list.push('c')
  assert.deepEqual(resolveOverrides(normalized, { list: ['b'] }), { list: ['b'] })
})

test('resolveOverrides keeps only values that differ from the default', () => {
  const normalized = normalizeRegistration(registration())
  assert.deepEqual(resolveOverrides(normalized, { enabled: true, mode: 'auto', tags: ['a'], ghost: 5 }), { enabled: true })
  assert.deepEqual(resolveOverrides(normalized, undefined), {})
  assert.deepEqual(resolveOverrides(normalized, { tags: ['b'] }), { tags: ['b'] })
})

test('buildSnapshot splits overrides from resolved values', () => {
  const first = normalizeRegistration(registration())
  const second = normalizeRegistration({ pluginId: 'other', title: 'Other', items: [{ key: 'n', type: 'number', title: 'N', default: 1 }] })
  const snapshot = buildSnapshot([first, second], { 'example.plugin': { enabled: true }, other: { n: 1 }, orphan: { x: 1 } })
  assert.deepEqual(snapshot.overrides, { 'example.plugin': { enabled: true } })
  assert.deepEqual(snapshot.resolved, {
    'example.plugin': { enabled: true, mode: 'auto', tags: ['a'], count: 3 },
    other: { n: 1 },
  })
  assert.equal(Object.hasOwn(snapshot.overrides, 'orphan'), false)
})

test('setValue deletes equal-to-default writes and empty maps', () => {
  const normalized = normalizeRegistration(registration())
  const item = normalized.items[0]
  assert.deepEqual(setValue({}, 'example.plugin', 'enabled', true, item.default), { 'example.plugin': { enabled: true } })
  assert.deepEqual(setValue({ 'example.plugin': { enabled: true } }, 'example.plugin', 'enabled', false, item.default), {})
  assert.deepEqual(
    setValue({ 'example.plugin': { enabled: true, mode: 'manual' } }, 'example.plugin', 'enabled', false, item.default),
    { 'example.plugin': { mode: 'manual' } },
  )
  // Deep equality, not identity: a fresh array equal to the default is not an override.
  const tags = normalized.items[2]
  assert.deepEqual(setValue({}, 'example.plugin', 'tags', ['a'], tags.default), {})
  assert.deepEqual(setValue({}, 'example.plugin', 'tags', ['b'], tags.default), { 'example.plugin': { tags: ['b'] } })
})

test('resetValues implements the three grains', () => {
  const values = { a: { x: 1, y: 2 }, b: { z: 3 } }
  assert.deepEqual(resetValues(values, {}), {})
  assert.deepEqual(resetValues(values, { pluginId: 'a' }), { b: { z: 3 } })
  assert.deepEqual(resetValues(values, { pluginId: 'a', itemKey: 'x' }), { a: { y: 2 }, b: { z: 3 } })
  assert.deepEqual(resetValues(values, { pluginId: 'a', itemKey: 'nope' }), { a: { x: 1, y: 2 }, b: { z: 3 } })
  assert.deepEqual(values, { a: { x: 1, y: 2 }, b: { z: 3 } }, 'inputs are never mutated')
})

test('sanitizeOverrides drops structural junk without touching good data', () => {
  assert.deepEqual(sanitizeOverrides(null), {})
  assert.deepEqual(sanitizeOverrides([]), {})
  assert.deepEqual(sanitizeOverrides({ a: null, b: 'x', c: { k: 1, bad: undefined } }), { c: { k: 1 } })
})

test('reconcileSessionIds keeps existing sessions and lists the rest', () => {
  assert.deepEqual(reconcileSessionIds(['a', 'b'], ['a', 'b', 'c']), { keep: ['a', 'b'], stale: ['c'] })
  assert.deepEqual(reconcileSessionIds([], ['x']), { keep: [], stale: ['x'] })
  assert.deepEqual(reconcileSessionIds(['a'], []), { keep: [], stale: [] })
  assert.deepEqual(reconcileSessionIds(['a', 'a', null, 7], ['a', 'a']), { keep: ['a'], stale: [] })
  assert.deepEqual(reconcileSessionIds(undefined, undefined), { keep: [], stale: [] })
  // Archived sessions still appear in list(), so they are never stale.
  assert.deepEqual(reconcileSessionIds(['kept', 'archived'], ['kept', 'archived']), { keep: ['archived', 'kept'], stale: [] })
})
