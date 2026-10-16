/**
 * Store tests: the domain declaration, the memory fallback, and the atomic
 * write path (including the record-vanished retry).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DOMAIN_NAME,
  TABLE_NAME,
  DOMAIN_VERSION,
  sessionRecordSchema,
  domainSpec,
  createStore,
} from '../lib/store.js'
import { setValue } from '../lib/resolve.js'

/** Silent logger: the store logs on every degrade, tests are not the audience. */
const silentLogger = { info() {}, warn() {}, error() {} }

/**
 * An in-memory stand-in for one opened domain table (KvTable).
 * options.barrier is an optional promise awaited before every mutation, which
 * models the official domain's "await durability FIRST, then mutate memory"
 * ordering: while it is pending, get() still reports the old state.
 */
function createFakeTable(initial = {}, options = {}) {
  const records = new Map(Object.entries(initial))
  const calls = { get: 0, put: 0, update: 0, delete: 0 }
  let chain = Promise.resolve()
  const gate = async () => { if (options.barrier !== undefined) await options.barrier }
  const enqueue = fn => {
    const next = chain.then(fn, fn)
    chain = next.then(() => {}, () => {})
    return next
  }
  return {
    calls,
    records,
    get(key) {
      calls.get += 1
      return records.get(key)
    },
    keys() {
      return records.keys()
    },
    get size() {
      return records.size
    },
    put(key, value) {
      calls.put += 1
      return enqueue(async () => { await gate(); records.set(key, value) })
    },
    delete(key) {
      calls.delete += 1
      return enqueue(async () => { await gate(); return records.delete(key) })
    },
    update(key, fn) {
      calls.update += 1
      return enqueue(async () => {
        await gate()
        if (!records.has(key)) {
          const error = new Error('missing record')
          error.code = 'missing-key'
          throw error
        }
        const next = fn(records.get(key))
        records.set(key, next)
        return next
      })
    },
  }
}

/** Wait for an asynchronous step to become observable. */
async function waitFor(predicate, message, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + message)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** A stand-in for ctx.storageDomain (DomainFacility). */
function createFakeFacility(table, options = {}) {
  const opened = { specs: [], closed: 0 }
  return {
    opened,
    async open(spec) {
      opened.specs.push(spec)
      if (options.failWith !== undefined) throw options.failWith
      return {
        name: spec.name,
        table(name) {
          assert.equal(name, TABLE_NAME)
          return table
        },
        async close() { opened.closed += 1 },
      }
    },
  }
}

/** Minimal context surface the store actually reads. */
function createFakeContext(profile = 'web') {
  return {
    logger: silentLogger,
    effects: [],
    get(name) {
      return name === 'profileContext' ? { name: profile } : undefined
    },
    effect(fn, label) {
      const disposer = fn()
      this.effects.push({ label, disposer })
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }
}

/** Record transform shaped exactly like the host service's write path. */
const writeItem = (pluginId, itemKey, value) => record => {
  const base = record ?? {}
  const group = { ...(base.values?.[pluginId] ?? {}) }
  group[itemKey] = value
  return { ...base, values: { ...(base.values ?? {}), [pluginId]: group } }
}

test('the domain declaration matches protocol section 5', () => {
  assert.equal(DOMAIN_NAME, 'session_settings')
  assert.equal(TABLE_NAME, 'sessions')
  assert.equal(DOMAIN_VERSION, 1)
  assert.equal(domainSpec.name, 'session_settings')
  assert.equal(domainSpec.version, 1)
  assert.equal(domainSpec.layout, 'per-record')
  assert.equal(domainSpec.invalidRecords, 'backup-and-skip')
  assert.deepEqual(Object.keys(domainSpec.tables), ['sessions'])
  assert.equal(typeof domainSpec.tables.sessions.valueSchema.parse, 'function')
})

test('the record schema validates the stored shape and strips foreign keys', () => {
  const parsed = sessionRecordSchema.parse({ sessionId: 's1', profile: 'web', updatedAt: 12, values: { p: { k: [1, 2] } }, junk: true })
  assert.deepEqual(parsed, { sessionId: 's1', profile: 'web', updatedAt: 12, values: { p: { k: [1, 2] } } })
  assert.equal(sessionRecordSchema.safeParse({ sessionId: 's1', updatedAt: 1 }).success, false)
  assert.equal(sessionRecordSchema.safeParse({ sessionId: '', updatedAt: 1, values: {} }).success, false)
  assert.equal(sessionRecordSchema.safeParse({ sessionId: 's1', updatedAt: 'now', values: {} }).success, false)
  assert.equal(sessionRecordSchema.safeParse({ sessionId: 's1', updatedAt: 1, values: [] }).success, false)
})

test('without a facility the store degrades to memory and says so', async () => {
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  const status = store.status()
  assert.equal(status.durable, false)
  assert.equal(status.backend, 'memory')
  assert.match(status.reason, /storageDomain/)
  assert.deepEqual(store.readValues('s1'), {})
  assert.deepEqual(store.listSessionIds(), [])
  await store.mutate('s1', writeItem('p', 'k', 1))
  assert.deepEqual(store.readValues('s1'), { p: { k: 1 } })
  assert.deepEqual(store.listSessionIds(), ['s1'])
  assert.equal(await store.drop('s1'), true)
  assert.deepEqual(store.readValues('s1'), {})
  assert.equal(await store.drop('s1'), false)
})

test('reading values hands out a deep copy', async () => {
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.mutate('s1', writeItem('p', 'k', { list: [1, 2] }))
  const first = store.readValues('s1')
  first.p.k.list.push(3)
  assert.deepEqual(store.readValues('s1'), { p: { k: { list: [1, 2] } } })
})

test('after attach, writes go through the domain (put then update, delete when empty)', async () => {
  const table = createFakeTable()
  const facility = createFakeFacility(table)
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  const status = await store.attach(facility)
  assert.equal(status.durable, true)
  assert.equal(status.backend, 'storageDomain')
  assert.equal(status.reason, null)
  assert.equal(facility.opened.specs.length, 1)
  assert.equal(facility.opened.specs[0].name, DOMAIN_NAME)
  assert.equal(facility.opened.specs[0].tables.sessions.valueSchema, sessionRecordSchema)

  await store.mutate('s1', writeItem('p', 'k', 1))
  assert.equal(table.calls.put, 1)
  assert.equal(table.calls.update, 0)
  assert.deepEqual(table.records.get('s1').values, { p: { k: 1 } })
  assert.equal(table.records.get('s1').profile, 'web')
  assert.equal(typeof table.records.get('s1').updatedAt, 'number')

  await store.mutate('s1', writeItem('p', 'k2', 2))
  assert.equal(table.calls.update, 1)
  assert.deepEqual(table.records.get('s1').values, { p: { k: 1, k2: 2 } })

  await store.mutate('s1', () => ({ sessionId: 's1', updatedAt: 1, values: {} }))
  assert.equal(table.calls.delete, 1)
  assert.equal(table.records.has('s1'), false)
  assert.deepEqual(store.readValues('s1'), {})

  assert.deepEqual(store.listSessionIds(), [])
  await store.mutate('s1', writeItem('p', 'k', 1))
  assert.equal(await store.drop('s1'), true)
  assert.equal(store.readValues('s1').p, undefined)
})

test('concurrent first writes to one session are serialized and both land', async () => {
  const table = createFakeTable()
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(table))
  // Both writers start while the session has no record at all: exactly the
  // window where two put()s would otherwise overwrite each other.
  await Promise.all([
    store.mutate('s1', writeItem('p', 'a', 1)),
    store.mutate('s1', writeItem('p', 'b', 2)),
  ])
  assert.deepEqual(store.readValues('s1'), { p: { a: 1, b: 2 } })
  assert.equal(table.calls.put, 1, 'the record must be created exactly once')
  assert.equal(table.calls.update, 1, 'the second writer must see the first writer record')
  assert.equal(table.records.size, 1)
})

test('a failed write does not poison the session queue', async () => {
  const table = createFakeTable()
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(table))
  await assert.rejects(store.mutate('s1', () => { throw new Error('boom') }), /boom/)
  await store.mutate('s1', writeItem('p', 'k', 1))
  assert.deepEqual(store.readValues('s1'), { p: { k: 1 } })
  // A reset queued behind a write cannot interleave with it either.
  await Promise.all([
    store.mutate('s1', writeItem('p', 'k2', 2)),
    store.drop('s1'),
  ])
  assert.equal(table.records.has('s1'), false)
})

// ── R1-01 / V1 §4.1: the replay path must never drop what it accepted ──────

test('A: a write accepted while degraded survives a durable write racing the replay', async () => {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const table = createFakeTable({}, { barrier })
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  // Degraded at first: kA is accepted into memory.
  await store.attach(createFakeFacility(table, { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', writeItem('p', 'kA', 100))
  assert.equal(store.status().durable, false)
  // The domain arrives; its replay put is now in flight (barrier).
  const attaching = store.attach(createFakeFacility(table))
  await waitFor(() => table.calls.put === 1, 'the replay put to be issued')
  // A durable write lands inside that window. It must queue behind the replay.
  const racing = store.mutate('s1', writeItem('p', 'kB', 200))
  release()
  await Promise.all([attaching, racing])
  assert.deepEqual(store.readValues('s1'), { p: { kA: 100, kB: 200 } })
  assert.equal(table.calls.put, 1, 'the replay created the record once')
  assert.equal(table.calls.update, 1, 'the racing write merged into it')
  assert.equal(store.status().pendingReplay, 0)
})

test('B: with a durable record already present, a degraded write is merged in', async () => {
  // The ordinary case: a previous run left overrides behind for this session.
  const table = createFakeTable({
    s1: { sessionId: 's1', profile: 'web', updatedAt: 1, values: { p: { kA: 11 }, q: { keep: true } } },
  })
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(table, { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', writeItem('p', 'kC', 300))
  assert.deepEqual(store.readValues('s1'), { p: { kC: 300 } }, 'degraded reads cannot see the durable record')
  const status = await store.attach(createFakeFacility(table))
  assert.equal(status.durable, true)
  assert.equal(status.pendingReplay, 0)
  assert.deepEqual(store.readValues('s1'), { p: { kA: 11, kC: 300 }, q: { keep: true } })
  assert.deepEqual(table.records.get('s1').values, { p: { kA: 11, kC: 300 }, q: { keep: true } })
  assert.equal(table.records.get('s1').profile, 'web', 'the durable record keeps its own fields')
})

test('C: an existing durable record is merged, never skipped (regression guard for V1 §4.1)', async () => {
  const table = createFakeTable({ s1: { sessionId: 's1', updatedAt: 1, values: { p: { kA: 11 } } } })
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(table, { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', writeItem('p', 'kC', 300))
  await store.attach(createFakeFacility(table))
  assert.deepEqual(store.readValues('s1'), { p: { kA: 11, kC: 300 } })
  // Skipping the replay would leave kC out and emit no write at all; skipping
  // the merge by overwriting would emit a put instead of an update.
  assert.equal(table.calls.put, 0, 'the durable record must not be overwritten or recreated')
  assert.equal(table.calls.update, 1, 'the replay must merge through update')
})

test('a replay that cannot merge keeps the value in memory and reports it', async () => {
  const broken = {
    get: () => ({ sessionId: 's1', updatedAt: 1, values: 'not-a-map' }),
    keys: () => ['s1'].values(),
    get size() { return 1 },
    put: async () => {},
    delete: async () => false,
    update: async () => ({ sessionId: 's1', updatedAt: 1, values: {} }),
  }
  const errors = []
  const logger = { info() {}, warn() {}, error: message => errors.push(message) }
  const store = createStore({ ctx: createFakeContext(), logger })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('not yet') }))
  await store.mutate('s1', writeItem('p', 'k', 1))
  const status = await store.attach(createFakeFacility(broken))
  assert.equal(status.pendingReplay, 1, 'the unmergeable value must not be dropped')
  assert.ok(errors.some(message => message.includes('could not move the overrides')), JSON.stringify(errors))
})

// ── R2-01 / R2-02: a failed replay must stay readable and must really retry ──

/** A table whose update() fails once, modelling a transient backend failure. */
function createFlakyUpdateTable(initial = {}) {
  const table = createFakeTable(initial)
  let failNext = true
  return {
    table,
    calls: table.calls,
    records: table.records,
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

test('a pending value stays readable on top of the durable record', async () => {
  const flaky = createFlakyUpdateTable({ s1: { sessionId: 's1', updatedAt: 1, values: { p: { kA: 11 } } } })
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', writeItem('p', 'kC', 300))
  await store.attach(createFakeFacility(flaky))
  assert.equal(store.status().pendingReplay, 1, 'the first replay failed and the value is held')
  // The accepted write must be readable even though it is not in the domain yet.
  assert.deepEqual(store.readValues('s1'), { p: { kA: 11, kC: 300 } })
  assert.deepEqual(flaky.records.get('s1').values, { p: { kA: 11 } }, 'the domain was not touched by the failure')
  // A retry lands it and clears the pending state.
  const outcome = await store.retryPending()
  assert.deepEqual(outcome, { replayed: 1, failed: 0 })
  assert.equal(store.status().pendingReplay, 0)
  assert.deepEqual(flaky.records.get('s1').values, { p: { kA: 11, kC: 300 } })
  store.close()
})

test('the retry timer lands a pending value without any external trigger', async () => {
  const ctx = createFakeContext()
  const store = createStore({ ctx, logger: silentLogger, retryIntervalMs: 20 })
  const broken = createFakeTable({ s1: { sessionId: 's1', updatedAt: 1, values: 'not-a-map' } })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', writeItem('p', 'kC', 300))
  await store.attach(createFakeFacility(broken))
  assert.equal(store.status().pendingReplay, 1)
  assert.equal(store.status().retryScheduled, true, 'the timer must be armed while something is pending')
  assert.equal(ctx.effects.length, 1, 'the timer is owned by a plugin effect')
  // The record becomes mergeable again (a real domain would have moved a truly
  // invalid record aside via invalidRecords: backup-and-skip).
  broken.records.set('s1', { sessionId: 's1', updatedAt: 1, values: { p: { kA: 11 } } })
  await waitFor(() => store.status().pendingReplay === 0, 'the timer to land the pending value')
  assert.deepEqual(store.readValues('s1'), { p: { kA: 11, kC: 300 } })
  assert.equal(store.status().retryScheduled, false, 'the timer stops once nothing is pending')
  await store.close()
})

test('repeated replay failures are throttled to one log line', async () => {
  const errors = []
  const logger = { info() {}, warn() {}, error: message => errors.push(message) }
  const store = createStore({ ctx: createFakeContext(), logger, retryIntervalMs: 10 })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', writeItem('p', 'k', 1))
  await store.attach(createFakeFacility(createFakeTable({ s1: { sessionId: 's1', updatedAt: 1, values: 'not-a-map' } })))
  assert.equal(store.status().pendingReplay, 1)
  await new Promise(resolve => setTimeout(resolve, 70))
  // The first attach intentionally failed, so filter to the replay diagnostics.
  const replayErrors = errors.filter(message => message.includes('could not move the overrides'))
  assert.equal(replayErrors.length, 1, 'the first failure logs, the rest are throttled: ' + JSON.stringify(errors))
  assert.match(replayErrors[0], /retried every 10ms/, 'the log must describe the real retry policy')
  assert.match(replayErrors[0], /stay readable by consumers/)
  assert.match(replayErrors[0], /attempt 1/)
  await store.close()
})

test('a retry that overwrites a newer durable record warns and names the keys', async () => {
  const warnings = []
  const logger = { info() {}, warn: message => warnings.push(message), error() {} }
  const flaky = createFlakyUpdateTable({ s1: { sessionId: 's1', updatedAt: 500, values: { p: { k: 'newer-durable', only: 'durable' } } } })
  // now() is pinned to 100, so the pending entry is OLDER than the durable record.
  const store = createStore({ ctx: createFakeContext(), logger, now: () => 100 })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', writeItem('p', 'k', 'from-degraded-window'))
  await store.attach(createFakeFacility(flaky))
  assert.equal(store.status().pendingReplay, 1)
  assert.deepEqual(warnings, [], 'no warning before the merge happens')
  await store.retryPending()
  assert.equal(store.status().pendingReplay, 0)
  // Memory still wins (an accepted write is never dropped)...
  assert.deepEqual(store.readValues('s1'), { p: { k: 'from-degraded-window', only: 'durable' } })
  // ...but the overwrite is named, never silent.
  assert.equal(warnings.length, 1, JSON.stringify(warnings))
  assert.match(warnings[0], /overwrites overrides that the durable record changed later/)
  assert.ok(warnings[0].includes('p/k'), 'the warning must name the superseded item')
  assert.match(warnings[0], /500 > pending 100/)
  // The closing clause must hold whatever the triggering write did: no causal claim.
  assert.match(warnings[0], /the pending set was merged into the durable record and then retired/)
  assert.equal(warnings[0].includes('because it holds writes that were already accepted'), false)
  store.close()
})

// ── V3-01 / V3-02: writes and drops must see the same state reads do ───────

/** Service-shaped write: sparse rule applied to one item. */
const setItem = (pluginId, itemKey, value, defaultValue) => record => {
  const base = record ?? {}
  return { ...base, values: setValue(base.values ?? {}, pluginId, itemKey, value, defaultValue) }
}

/** Degraded store holding one pending value, whose first replay fails. */
async function createPendingStore(options = {}) {
  const store = createStore({ ctx: options.ctx ?? createFakeContext(), logger: options.logger ?? silentLogger, retryIntervalMs: options.retryIntervalMs })
  const durable = options.durable ?? createFlakyUpdateTable({ s1: { sessionId: 's1', updatedAt: 500, values: { p: { kA: 11 } } } })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', setItem('p', 'kC', 300, 0))
  await store.attach(createFakeFacility(durable))
  return { store, durable }
}

test('a write that restores the default clears a pending-only override', async () => {
  const { store, durable } = await createPendingStore()
  assert.equal(store.status().pendingReplay, 1)
  assert.deepEqual(store.readValues('s1'), { p: { kA: 11, kC: 300 } })
  // Service-level "set back to its default": the sparse rule must see kC=300
  // (pending) and delete it, not look at the durable record alone.
  await store.mutate('s1', setItem('p', 'kC', 0, 0))
  assert.deepEqual(store.readValues('s1'), { p: { kA: 11 } })
  assert.equal(store.status().pendingReplay, 0, 'the effective state is durable, so the pending copy retires')
  assert.equal(store.status().retryScheduled, false)
  assert.deepEqual(durable.records.get('s1').values, { p: { kA: 11 } })
  store.close()
})

test('a write on a pending session with no durable record keeps the pending keys', async () => {
  const durable = createFakeTable()
  let putFailures = 1
  const failingPut = {
    get: key => durable.get(key),
    keys: () => durable.keys(),
    get size() { return durable.size },
    put(key, value) {
      if (putFailures > 0) {
        putFailures -= 1
        return Promise.reject(new Error('put rejected'))
      }
      return durable.put(key, value)
    },
    delete: key => durable.delete(key),
    update: (key, fn) => durable.update(key, fn),
  }
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', setItem('p', 'kA', 1, 0))
  await store.attach(createFakeFacility(failingPut))
  assert.equal(store.status().pendingReplay, 1, 'the replay could not create the record')
  // No durable record yet: the write must start from the effective state, so the
  // pending kA survives the write instead of being lost behind an empty base.
  await store.mutate('s1', setItem('p', 'kC', 2, 0))
  assert.deepEqual(store.readValues('s1'), { p: { kA: 1, kC: 2 } })
  assert.equal(store.status().pendingReplay, 0, 'the effective state is durable, so the pending copy retires')
  assert.deepEqual(durable.records.get('s1').values, { p: { kA: 1, kC: 2 } })
  store.close()
})

test('resetSession clears the pending copy and the record never comes back', async () => {
  const durable = createFakeTable({ s1: { sessionId: 's1', updatedAt: 1, values: 'not-a-map' } })
  const ctx = createFakeContext()
  const store = createStore({ ctx, logger: silentLogger, retryIntervalMs: 10 })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', setItem('p', 'kC', 300, 0))
  await store.attach(createFakeFacility(durable))
  assert.equal(store.status().pendingReplay, 1)
  assert.equal(store.status().retryScheduled, true)
  assert.equal(await store.drop('s1'), true)
  assert.deepEqual(store.readValues('s1'), {})
  assert.equal(store.status().pendingReplay, 0, 'the pending copy is part of what was dropped')
  assert.equal(store.status().retryScheduled, false)
  // Several timer ticks would have replayed it before this fix.
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(durable.records.has('s1'), false, 'the deleted record must not be resurrected')
  assert.deepEqual(store.readValues('s1'), {})
  await store.close()
})

test('without ctx.effect the missing retry timer is announced, not silent', async () => {
  const warnings = []
  const logger = { info() {}, warn: message => warnings.push(message), error() {} }
  const bare = { logger, get: () => undefined }
  const store = createStore({ ctx: bare, logger, retryIntervalMs: 10 })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', setItem('p', 'kC', 300, 0))
  await store.attach(createFakeFacility(createFakeTable({ s1: { sessionId: 's1', updatedAt: 1, values: 'not-a-map' } })))
  assert.equal(store.status().pendingReplay, 1)
  assert.equal(store.status().retryScheduled, false)
  assert.ok(warnings.some(message => message.includes('no ctx.effect')), JSON.stringify(warnings))
})

test('the drop log says what was actually dropped', async () => {
  // (a) pending only: the durable record never existed.
  const infosA = []
  const loggerA = { info: message => infosA.push(message), warn() {}, error() {} }
  const durableA = createFakeTable()
  let putFailures = 1
  const failingPut = {
    get: key => durableA.get(key),
    keys: () => durableA.keys(),
    get size() { return durableA.size },
    put(key, value) {
      if (putFailures > 0) {
        putFailures -= 1
        return Promise.reject(new Error('put rejected'))
      }
      return durableA.put(key, value)
    },
    delete: key => durableA.delete(key),
    update: (key, fn) => durableA.update(key, fn),
  }
  const storeA = createStore({ ctx: createFakeContext(), logger: loggerA })
  await storeA.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await storeA.mutate('s1', setItem('p', 'kC', 300, 0))
  await storeA.attach(createFakeFacility(failingPut))
  assert.equal(storeA.status().pendingReplay, 1)
  assert.equal(durableA.records.has('s1'), false, 'no durable record exists in this branch')
  assert.equal(await storeA.drop('s1'), true, 'drop reports true for a pending-only session')
  const lineA = infosA.find(message => message.includes('dropped 1 pending override set'))
  assert.ok(lineA !== undefined, JSON.stringify(infosA))
  assert.ok(lineA.includes('(no durable record existed)'), lineA)
  assert.equal(lineA.includes('together with its durable record'), false, lineA)

  // (b) both: the durable record and the pending entry are dropped together.
  const infosB = []
  const loggerB = { info: message => infosB.push(message), warn() {}, error() {} }
  const storeB = createStore({ ctx: createFakeContext(), logger: loggerB })
  const flakyB = createFlakyUpdateTable({ s1: { sessionId: 's1', updatedAt: 1, values: { p: { kA: 11 } } } })
  await storeB.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await storeB.mutate('s1', setItem('p', 'kC', 300, 0))
  await storeB.attach(createFakeFacility(flakyB))
  assert.equal(storeB.status().pendingReplay, 1)
  assert.equal(await storeB.drop('s1'), true)
  const lineB = infosB.find(message => message.includes('dropped 1 pending override set'))
  assert.ok(lineB !== undefined, JSON.stringify(infosB))
  assert.ok(lineB.includes('together with its durable record'), lineB)
  assert.equal(flakyB.records.has('s1'), false)
  await storeA.close()
  await storeB.close()
})

test('retiring a stale pending copy warns exactly like a replay does', async () => {
  const warnings = []
  const logger = { info() {}, warn: message => warnings.push(message), error() {} }
  const flaky = createFlakyUpdateTable({ s1: { sessionId: 's1', updatedAt: 500, values: { p: { k: 'newer-durable' } } } })
  // now() is pinned to 100, so the pending entry is OLDER than the durable record.
  const store = createStore({ ctx: createFakeContext(), logger, now: () => 100 })
  await store.attach(createFakeFacility(createFakeTable(), { failWith: new Error('storageDomain not up yet') }))
  await store.mutate('s1', setItem('p', 'k', 'from-degraded-window', 'none'))
  await store.attach(createFakeFacility(flaky))
  assert.equal(store.status().pendingReplay, 1)
  assert.deepEqual(warnings, [], 'a failed replay warns nothing')
  // A plain write retires the pending copy. Same overwrite, same warning.
  await store.mutate('s1', setItem('p', 'other', 'x', 'none'))
  assert.equal(store.status().pendingReplay, 0)
  assert.equal(warnings.length, 1, JSON.stringify(warnings))
  assert.match(warnings[0], /retiring the pending overrides of/)
  assert.match(warnings[0], /overwrites overrides that the durable record changed later/)
  assert.ok(warnings[0].includes('p/k'))
  assert.match(warnings[0], /500 > pending 100/)
  // Same closing clause as the replay path: the two warn texts differ only in the
  // action prefix, and neither claims a cause that may not hold.
  assert.match(warnings[0], /the pending set was merged into the durable record and then retired/)
  assert.deepEqual(store.readValues('s1'), { p: { k: 'from-degraded-window', other: 'x' } })
  store.close()
})

test('a record deleted between read and update is recreated instead of failing', async () => {
  const table = createFakeTable({ s1: { sessionId: 's1', updatedAt: 1, values: { p: { k: 0 } } } })
  let sabotaged = false
  const flaky = {
    get: key => table.get(key),
    keys: () => table.keys(),
    get size() { return table.size },
    put: (key, value) => table.put(key, value),
    delete: key => table.delete(key),
    update(key, fn) {
      if (!sabotaged) {
        sabotaged = true
        const error = new Error('gone')
        error.code = 'missing-key'
        return Promise.reject(error)
      }
      return table.update(key, fn)
    },
  }
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(flaky))
  await store.mutate('s1', writeItem('p', 'k2', 2))
  assert.equal(sabotaged, true)
  assert.deepEqual(store.readValues('s1'), { p: { k: 0, k2: 2 } })
})

test('a session id the per-record layout cannot key is refused, never mangled', async () => {
  const table = createFakeTable()
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(table))
  await assert.rejects(store.mutate('bad/id', writeItem('p', 'k', 1)), error => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /per-record/)
    return true
  })
  await assert.rejects(store.drop('bad id'), error => error.code === 'bad-request')
  assert.equal(table.records.size, 0)
  // UUIDs are what the Harness hands us, and they pass.
  await store.mutate('159b040f-af8e-4527-a128-896c8356fb38', writeItem('p', 'k', 1))
  assert.equal(table.records.size, 1)
})

test('a failed open keeps the store in memory and reports why', async () => {
  const failure = new Error('backend json is not routed')
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  const status = await store.attach(createFakeFacility(createFakeTable(), { failWith: failure }))
  assert.equal(status.durable, false)
  assert.match(status.reason, /backend json is not routed/)
  await store.mutate('s1', writeItem('p', 'k', 1))
  assert.deepEqual(store.readValues('s1'), { p: { k: 1 } })
})

test('values written while degraded are replayed once the domain opens', async () => {
  const table = createFakeTable()
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(createFakeFacility(table, { failWith: new Error('not yet') }))
  await store.mutate('s1', writeItem('p', 'k', 1))
  assert.equal(table.records.size, 0)
  const status = await store.attach(createFakeFacility(table))
  assert.equal(status.durable, true)
  assert.deepEqual(table.records.get('s1').values, { p: { k: 1 } })
  assert.deepEqual(store.readValues('s1'), { p: { k: 1 } })
  // The promoted copy is the memory's only copy; the memory map is now empty
  // and every later read comes from the domain.
  await store.mutate('s1', writeItem('p', 'k2', 2))
  assert.deepEqual(table.records.get('s1').values, { p: { k: 1, k2: 2 } })
})

test('close releases the domain handle', async () => {
  const facility = createFakeFacility(createFakeTable())
  const store = createStore({ ctx: createFakeContext(), logger: silentLogger })
  await store.attach(facility)
  await store.close()
  assert.equal(facility.opened.closed, 1)
  assert.equal(store.isDurable(), false)
})
