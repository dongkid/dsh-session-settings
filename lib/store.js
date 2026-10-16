/**
 * dsh-session-settings — the per-session override store.
 *
 * Records live in the official storage domain (protocol 5): one document per
 * session, sessionId as the key, overrides only. Writes go through
 * table.update() so read-modify-write cannot interleave on the domain's write
 * chain. When ctx.storageDomain is missing or the domain cannot be opened, the
 * store degrades to an in-memory map and says so through status() — it never
 * pretends to be durable.
 * @module dsh-session-settings/store
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

import { SessionSettingsError, jsonEqual } from './resolve.js'

/** Domain name (protocol 5). */
export const DOMAIN_NAME = 'session_settings'
/** Table name (protocol 5). */
export const TABLE_NAME = 'sessions'
/** Domain version (protocol 5). */
export const DOMAIN_VERSION = 1

/**
 * The per-record backend writes one file per key, so a key must be path safe
 * (dsh-storage-json: /^[a-zA-Z0-9_-]+$/). DSH session ids are UUIDs and match;
 * anything else is refused loudly instead of being silently mangled into a file
 * name. Guarded here and again at the service boundary.
 */
export const PER_RECORD_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * How often a value that failed to replay is retried while the plugin is
 * loaded. Only runs while something is pending; the timer is owned by the
 * plugin fiber (ctx.effect), so unloading stops it.
 */
export const RETRY_INTERVAL_MS = 30 * 1000

/** Minimum gap between two replay-failure log lines for the same session. */
export const RETRY_LOG_INTERVAL_MS = 30 * 1000

/**
 * Refuse a key the per-record layout cannot store.
 * @param sessionId - session key about to address a document.
 */
export function assertStorageKey(sessionId) {
  if (!PER_RECORD_KEY_RE.test(sessionId)) {
    throw new SessionSettingsError('bad-request', 'sessionId "' + sessionId + '" cannot address a per-record storage document (must match ' + PER_RECORD_KEY_RE.source + ')')
  }
  return sessionId
}

/**
 * One stored record (protocol 5). The schema is the durable boundary: a
 * document that does not match is moved aside by the backend
 * (invalidRecords: backup-and-skip) and the session simply has no overrides.
 */
export const sessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  profile: z.string().optional(),
  updatedAt: z.number(),
  values: z.record(z.string(), z.record(z.string(), z.unknown())),
})

/**
 * The domain declaration. Declared with the official helpers so the literature
 * checks (name regex, integer version, layout, table names) run at module load.
 */
export const domainSpec = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { [TABLE_NAME]: domainTable(sessionRecordSchema) },
})

/** Compact one-line description of an unknown thrown value. */
function describeError(error) {
  if (error === null || error === undefined) return String(error)
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

/** True for the domain write fence that tells us the record does not exist yet. */
function isMissingKey(error) {
  return error !== null && typeof error === 'object' && error.code === 'missing-key'
}

/** Deep copy of a JSON value, so callers can never mutate stored state. */
function clone(value) {
  if (value === undefined) return undefined
  return structuredClone(value)
}

/** A brand-new record for one session. */
function emptyRecord(sessionId, profile, updatedAt) {
  const record = { sessionId, updatedAt, values: {} }
  if (typeof profile === 'string' && profile !== '') record.profile = profile
  return record
}

/** Whether a record carries no override at all (the delete condition of protocol 5). */
function isEmptyRecord(record) {
  if (record === null || typeof record !== 'object') return true
  const values = record.values
  return values === null || typeof values !== 'object' || Object.keys(values).length === 0
}

/**
 * Open (or degrade) the override store.
 * @param options - ctx for services and logging, plus test seams for clock.
 * @returns the store handle used by the host service.
 */
export function createStore(options = {}) {
  const ctx = options.ctx
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const logger = options.logger ?? ctx?.logger ?? console
  const retryIntervalMs = typeof options.retryIntervalMs === 'number' && options.retryIntervalMs > 0
    ? options.retryIntervalMs
    : RETRY_INTERVAL_MS

  /** sessionId -> record, used only while the domain is not open. */
  const memory = new Map()
  /** sessionId -> settled tail of that session's in-process write queue. */
  const writeChains = new Map()
  /** sessionId -> { count, lastLogAt }, the throttle state of failure logging. */
  const replayFailures = new Map()
  let domain = null
  let table = null
  let attaching = null
  let reason = 'storageDomain service is not available'
  let retryTimer = null
  let retryLifecycleReady = false
  let retryUnavailableLogged = false

  function profileOf() {
    try {
      const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
      const name = profileContext?.name
      return typeof name === 'string' && name !== '' ? name : undefined
    } catch (error) {
      return undefined
    }
  }

  function isDurable() {
    return table !== null
  }

  /** Current storage capability, as surfaced to the page through the bridge. */
  function status() {
    return {
      durable: isDurable(),
      backend: isDurable() ? 'storageDomain' : 'memory',
      reason: isDurable() ? null : reason,
      // Values accepted while storage was unavailable that have not reached the
      // domain yet. They stay readable (readValues overlays them) and are
      // retried by the timer while this plugin is loaded.
      pendingReplay: memory.size,
      retryScheduled: retryTimer !== null,
    }
  }

  /**
   * Keys the durable side loses to the incoming side: present in both maps with
   * different values. Shared by the replay merge and the pending-retire path so
   * both report the same thing in the same words.
   * @param durableValues - the durable values map.
   * @param incomingValues - the map that wins.
   * @returns "pluginId/itemKey" for every superseded key.
   */
  function supersededKeys(durableValues, incomingValues) {
    const keys = []
    for (const pluginId of Object.keys(incomingValues ?? {})) {
      const group = incomingValues[pluginId]
      const durableGroup = durableValues === null || durableValues === undefined ? undefined : durableValues[pluginId]
      if (group === null || typeof group !== 'object' || Array.isArray(group)) continue
      if (durableGroup === null || durableGroup === undefined || typeof durableGroup !== 'object' || Array.isArray(durableGroup)) continue
      for (const itemKey of Object.keys(group)) {
        if (Object.hasOwn(durableGroup, itemKey) && !jsonEqual(durableGroup[itemKey], group[itemKey])) {
          keys.push(pluginId + '/' + itemKey)
        }
      }
    }
    return keys
  }

  /**
   * Whether the durable record is newer than a pending entry, i.e. whether that
   * pending snapshot is stale. The replay merge and the write-retire path must
   * agree on this rule, so it lives in exactly one place.
   * @param durableRecord - the durable record, or undefined.
   * @param pendingRecord - the pending entry, or undefined.
   * @returns true when the durable record's updatedAt is the later one.
   */
  function durableIsNewerThan(durableRecord, pendingRecord) {
    return durableRecord !== undefined
      && pendingRecord !== undefined
      && typeof durableRecord.updatedAt === 'number'
      && typeof pendingRecord.updatedAt === 'number'
      && durableRecord.updatedAt > pendingRecord.updatedAt
  }

  /**
   * Report that an older pending snapshot wins over values the durable record
   * changed later. Used after the write succeeded (a failed write overwrote
   * nothing, so warning then would be a false alarm).
   * @param sessionId - session key.
   * @param durable - the durable record that was current.
   * @param pending - the pending entry that won.
   * @param keys - superseded keys from supersededKeys().
   * @param how - "replaying the overrides of" or "retiring the pending overrides of".
   */
  function warnSuperseded(sessionId, durable, pending, keys, how) {
    logger?.warn?.('[dsh-session-settings] ' + how + ' session "' + sessionId
      + '" overwrites overrides that the durable record changed later (durable updatedAt ' + String(durable.updatedAt)
      + ' > pending ' + String(pending.updatedAt) + '), keys: ' + keys.join(', ')
      // No causal claim here: the pending set is merged as a whole and then
      // retired, and the keys named above are simply the ones the durable side
      // lost. Saying "the pending copy wins because it is newer" would be false
      // when the write that triggered this was itself an explicit overwrite.
      + '; the pending set was merged into the durable record and then retired'
      + ' (the keys named above are the ones the durable side lost)')
  }

  /**
   * Merge a record written while degraded into the durable record it belongs to.
   * The in-memory copy is the newer state (it was written while the domain was
   * closed), so its keys win; every other durable key is preserved.
   *
   * Known limit, deliberate: a *deletion* performed while degraded is not
   * representable here. Degraded reads cannot see the durable record, so a
   * reset-to-default during that window either rewrites a key (which the merge
   * then overrides) or empties the in-memory record entirely (which leaves
   * nothing to replay), and either way a durable override for that key can
   * resurface. Preserving accepted writes matters more than guessing which
   * durable keys the degraded caller meant to remove; fixing it properly needs
   * a tombstone in the record, which is a v2 storage-shape change.
   *
   * Priority premise: memory wins because it was written while the domain was
   * closed, i.e. it is newer. That premise does NOT hold for an entry whose
   * replay failed and stayed pending while the durable record kept taking
   * writes; in that case memory still wins (an accepted write must not be
   * dropped) but the superseded keys are reported so the overwrite is not
   * silent.
   * @param existing - the durable record.
   * @param incoming - the in-memory record.
   * @param updatedAt - timestamp for the merged record.
   * @returns the merged record plus the keys the durable side loses.
   */
  function mergeRecords(existing, incoming, updatedAt) {
    const existingValues = existing.values ?? {}
    if (existingValues === null || typeof existingValues !== 'object' || Array.isArray(existingValues)) {
      throw new Error('the durable record of session "' + String(existing.sessionId) + '" has no usable values map')
    }
    const incomingValues = incoming.values ?? {}
    if (incomingValues === null || typeof incomingValues !== 'object' || Array.isArray(incomingValues)) {
      throw new Error('the in-memory record of session "' + String(incoming.sessionId) + '" has no usable values map')
    }
    const durableIsNewer = durableIsNewerThan(existing, incoming)
    const values = { ...existingValues }
    for (const pluginId of Object.keys(incomingValues)) {
      const group = incomingValues[pluginId]
      if (group === null || typeof group !== 'object' || Array.isArray(group)) {
        throw new Error('cannot merge plugin overrides of "' + pluginId + '": not an object')
      }
      const durableGroup = values[pluginId]
      if (durableGroup !== undefined && (durableGroup === null || typeof durableGroup !== 'object' || Array.isArray(durableGroup))) {
        throw new Error('cannot merge plugin overrides of "' + pluginId + '": the durable group is not an object')
      }
      values[pluginId] = { ...(durableGroup ?? {}), ...group }
    }
    const merged = { ...existing, sessionId: existing.sessionId, updatedAt, values }
    if (existing.profile === undefined && incoming.profile !== undefined) merged.profile = incoming.profile
    return { merged, overwritten: durableIsNewer ? supersededKeys(existingValues, incomingValues) : [], durableIsNewer }
  }

  /** Stop the retry timer (idempotent). */
  function stopRetryTimer() {
    if (retryTimer === null) return
    clearInterval(retryTimer)
    retryTimer = null
  }

  /**
   * Arm the pending-replay timer while something is pending, and stop it once
   * nothing is. The interval belongs to the plugin fiber through ctx.effect, so
   * unloading (or reloading) the plugin cancels it. Without a usable context the
   * values stay visible but are not retried in this process.
   */
  function armRetryTimer() {
    if (memory.size === 0) {
      stopRetryTimer()
      return
    }
    if (retryTimer !== null) return
    if (!retryLifecycleReady) {
      if (typeof ctx?.effect !== 'function') {
        if (!retryUnavailableLogged) {
          retryUnavailableLogged = true
          logger?.warn?.('[dsh-session-settings] this context has no ctx.effect, so the pending-replay retry cannot be '
            + 'scheduled; pending values stay readable but are only replayed when something else triggers a replay')
        }
        return
      }
      try {
        ctx.effect(() => () => { stopRetryTimer() }, 'dsh-session-settings: pending override replay retry')
        retryLifecycleReady = true
      } catch (error) {
        logger?.warn?.('[dsh-session-settings] cannot schedule the pending-replay retry on this context: ' + describeError(error))
        return
      }
    }
    retryTimer = setInterval(() => { void retryPending() }, retryIntervalMs)
    retryTimer.unref?.()
  }

  /**
   * Record one failed replay. The first failure logs immediately; afterwards one
   * line per session per RETRY_LOG_INTERVAL_MS (and every tenth attempt) keeps a
   * stubborn entry from flooding the log while the timer keeps retrying.
   * @param sessionId - session whose replay failed.
   * @param error - the cause.
   */
  function noteReplayFailure(sessionId, error) {
    const state = replayFailures.get(sessionId) ?? { count: 0, lastLogAt: 0 }
    state.count += 1
    const nowMs = Date.now()
    if (state.count === 1 || state.count % 10 === 0 || nowMs - state.lastLogAt >= RETRY_LOG_INTERVAL_MS) {
      state.lastLogAt = nowMs
      const every = retryIntervalMs >= 1000 ? String(Math.round(retryIntervalMs / 1000)) + 's' : String(retryIntervalMs) + 'ms'
      logger?.error?.('[dsh-session-settings] could not move the overrides written for session "' + sessionId
        + '" while storage was unavailable into the domain (attempt ' + String(state.count) + '); they stay in memory, '
        + 'stay readable by consumers, and are retried every ' + every + ' while this plugin is loaded: '
        + describeError(error))
    }
    replayFailures.set(sessionId, state)
  }

  /**
   * Move everything written while degraded into the domain.
   *
   * Three rules make this safe, and the first two were bugs before:
   *  - every entry is replayed on that session's write queue, and all of the
   *    queues are claimed in one synchronous pass, so no host write can slip in
   *    front of the replay of its session;
   *  - the durable record is re-read *inside* the queue slot and a record that
   *    already exists (a previous run left overrides behind, the ordinary case)
   *    is MERGED, never skipped: the in-memory copy is the only copy of those
   *    writes and it is dropped right after. A merge that cannot happen keeps
   *    the entry in memory and is logged (throttled) as an error;
   *  - a failed entry stays visible through readValues() and is retried by the
   *    timer, so it is never a silently invisible write.
   * @returns how many entries were replayed and how many failed.
   */
  async function replayMemory() {
    if (memory.size === 0) {
      stopRetryTimer()
      return { replayed: 0, failed: 0 }
    }
    const entries = [...memory]
    const tasks = entries.map(([sessionId, record]) => enqueueWrite(sessionId, async () => {
      // An earlier pass (attach or a previous tick) may already have landed it.
      if (memory.get(sessionId) !== record) return
      const existing = table.get(sessionId)
      if (existing === undefined) {
        const next = { ...record, sessionId, updatedAt: now() }
        if (!isEmptyRecord(next)) await table.put(sessionId, next)
        return
      }
      const { merged, overwritten } = mergeRecords(existing, record, now())
      const next = await table.update(sessionId, () => merged)
      // Only warn once the overwrite is durable: a failed update overwrote nothing.
      if (overwritten.length > 0) warnSuperseded(sessionId, existing, record, overwritten, 'replaying the overrides of')
      if (isEmptyRecord(next)) {
        const latest = table.get(sessionId)
        if (latest === undefined || isEmptyRecord(latest)) await table.delete(sessionId)
      }
    }))
    const outcomes = await Promise.allSettled(tasks)
    let replayed = 0
    let failed = 0
    outcomes.forEach((outcome, index) => {
      const sessionId = entries[index][0]
      if (outcome.status === 'fulfilled') {
        if (memory.get(sessionId) === entries[index][1]) {
          memory.delete(sessionId)
          replayFailures.delete(sessionId)
          replayed += 1
        }
        return
      }
      failed += 1
      noteReplayFailure(sessionId, outcome.reason)
    })
    if (replayed > 0) {
      logger?.info?.('[dsh-session-settings] moved ' + String(replayed) + ' session override set(s) written while storage was unavailable into domain ' + DOMAIN_NAME)
    }
    armRetryTimer()
    return { replayed, failed }
  }

  /**
   * One retry pass over the pending values: the timer's body, and the seam tests
   * use. A no-op when nothing is pending or storage is not durable yet.
   * @returns how many entries were replayed and how many failed.
   */
  async function retryPending() {
    if (memory.size === 0) {
      stopRetryTimer()
      return { replayed: 0, failed: 0 }
    }
    if (!isDurable()) return { replayed: 0, failed: 0 }
    return replayMemory()
  }

  /**
   * Open the domain over the mounted facility. Failure is not fatal: the store
   * keeps serving from memory and status() keeps reporting why.
   * @param facility - ctx.storageDomain (DomainFacility).
   * @returns the storage status after the attempt.
   */
  async function attach(facility) {
    if (isDurable()) return status()
    if (attaching !== null) return attaching
    attaching = (async () => {
      try {
        if (facility === null || facility === undefined || typeof facility.open !== 'function') {
          reason = 'ctx.storageDomain is not a domain facility'
          logger?.error?.('[dsh-session-settings] ' + reason + '; per-session overrides stay in memory and are lost on restart')
          return status()
        }
        const opened = await facility.open(domainSpec)
        table = opened.table(TABLE_NAME)
        domain = opened
        reason = null
        await replayMemory()
        logger?.info?.('[dsh-session-settings] per-session overrides stored in domain ' + DOMAIN_NAME + '/' + TABLE_NAME)
        return status()
      } catch (error) {
        table = null
        domain = null
        reason = 'storageDomain.open failed: ' + describeError(error)
        logger?.error?.('[dsh-session-settings] ' + reason + '; per-session overrides stay in memory and are lost on restart')
        return status()
      } finally {
        attaching = null
      }
    })()
    return attaching
  }

  /** Overlay one values map on another (overlay wins per plugin group, per key). */
  function overlayValues(base, overlay) {
    const values = {}
    for (const pluginId of Object.keys(base ?? {})) {
      const group = base[pluginId]
      if (group !== null && typeof group === 'object' && !Array.isArray(group)) values[pluginId] = { ...group }
    }
    for (const pluginId of Object.keys(overlay ?? {})) {
      const group = overlay[pluginId]
      if (group === null || typeof group !== 'object' || Array.isArray(group)) continue
      const previous = values[pluginId]
      values[pluginId] = { ...(previous ?? {}), ...group }
    }
    return values
  }

  /**
   * The session's stored overrides, synchronously, with anything still pending
   * replay overlaid on top. Pending values are writes that were already
   * accepted, so a consumer must be able to read them back even while the
   * durable copy cannot be written; they win for the same reason the eventual
   * merge lets them win.
   *
   * The value is a deep copy: the domain hands out its own record objects, and
   * a consumer mutating one would corrupt durable state in place.
   * @param sessionId - session key.
   * @returns the stored values map (empty object when absent).
   */
  function readValues(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return {}
    const durableRecord = isDurable() ? table.get(sessionId) : undefined
    const pendingRecord = memory.get(sessionId)
    const durableValues = durableRecord !== null && typeof durableRecord === 'object' && durableRecord.values !== null
      && typeof durableRecord.values === 'object' ? durableRecord.values : {}
    if (pendingRecord === undefined) return clone(durableValues)
    return clone(overlayValues(durableValues, pendingRecord.values))
  }

  /**
   * Every session id currently holding a record, pending ones included (a
   * session whose replay failed still owns its values and must stay visible to
   * reconciliation).
   */
  function listSessionIds() {
    const ids = new Set()
    if (isDurable()) for (const key of table.keys()) ids.add(key)
    for (const key of memory.keys()) ids.add(key)
    return [...ids]
  }

  /**
   * Run one write task after every earlier write task of the same session has
   * settled. The domain serializes its own durable calls but has no upsert
   * primitive, so without this queue two writers racing a session's FIRST write
   * could both observe "no record" and both put, silently losing one of them.
   * A failed write never poisons the queue: the next task still runs.
   * @param sessionId - session key.
   * @param task - the write to run.
   * @returns the task's own result.
   */
  function enqueueWrite(sessionId, task) {
    const previous = writeChains.get(sessionId) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(() => {}, () => {})
    writeChains.set(sessionId, tail)
    void tail.then(() => {
      if (writeChains.get(sessionId) === tail) writeChains.delete(sessionId)
    })
    return result
  }

  /**
   * Atomic read-modify-write of one session record, serialized in process
   * against every other write to the same session. The transform receives the
   * current record (or undefined) and returns the complete next record; an
   * empty next record deletes the document instead of storing an empty shell.
   * @param sessionId - session key.
   * @param transform - synchronous pure record transform.
   * @returns the stored values after the write.
   */
  async function mutate(sessionId, transform) {
    if (isDurable()) assertStorageKey(sessionId)
    return enqueueWrite(sessionId, () => mutateNow(sessionId, transform))
  }

  /**
   * The record a write (or a sparse rule) must operate on: the durable record
   * with the session's pending entry overlaid, pending winning per key. A write
   * that only looked at the durable record would contradict what readValues()
   * reports, so "write the default" / "reset" would silently do nothing while the
   * pending value kept being served.
   * @param durableRecord - the stored record, or undefined.
   * @param pendingRecord - the session's pending entry, or undefined.
   * @returns the effective record, or undefined when neither exists.
   */
  function effectiveRecord(durableRecord, pendingRecord) {
    if (pendingRecord === undefined) return durableRecord
    const base = durableRecord ?? { values: {} }
    return {
      ...base,
      ...(base.sessionId === undefined ? { sessionId: pendingRecord.sessionId } : {}),
      values: overlayValues(base.values ?? {}, pendingRecord.values),
    }
  }

  /** The queued body of mutate(); never called directly. */
  async function mutateNow(sessionId, transform) {
    const build = current => {
      const base = current ?? emptyRecord(sessionId, profileOf(), now())
      return { ...base, sessionId, updatedAt: now() }
    }
    if (!isDurable()) {
      const next = transform(build(memory.get(sessionId)))
      if (isEmptyRecord(next)) memory.delete(sessionId)
      else memory.set(sessionId, next)
      return readValues(sessionId)
    }
    // The domain serializes updates on its own write chain; the retry below only
    // covers the window where a concurrent reset deleted the record between our
    // read and our update slot.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Everything below runs in this session's queue slot, so the pending
        // entry cannot change under us.
        const pendingBefore = memory.get(sessionId)
        const durableBefore = table.get(sessionId)
        // The retire below writes the effective state, so a stale pending entry
        // overwrites newer durable values exactly like a replay merge would. Use
        // the same detection so both paths report it identically.
        const stalePending = durableIsNewerThan(durableBefore, pendingBefore)
        const superseded = stalePending ? supersededKeys(durableBefore.values, pendingBefore.values) : []
        if (durableBefore === undefined) {
          const base = pendingBefore === undefined
            ? build(undefined)
            : { ...build(pendingBefore), values: { ...(pendingBefore.values ?? {}) } }
          const next = transform(base)
          if (!isEmptyRecord(next)) await table.put(sessionId, next)
        } else {
          const next = await table.update(sessionId, current => {
            const base = effectiveRecord(current, pendingBefore)
            return transform({ ...base, sessionId, updatedAt: now() })
          })
          if (isEmptyRecord(next)) {
            const latest = table.get(sessionId)
            if (latest === undefined || isEmptyRecord(latest)) await table.delete(sessionId)
          }
        }
        // The effective state (durable + pending) is durable now, so the pending
        // copy has served its purpose: keeping it would let an older snapshot
        // overwrite this write on the next replay tick.
        if (pendingBefore !== undefined && memory.get(sessionId) === pendingBefore) {
          memory.delete(sessionId)
          armRetryTimer()
          if (superseded.length > 0) {
            warnSuperseded(sessionId, durableBefore, pendingBefore, superseded, 'retiring the pending overrides of')
          }
        }
        return readValues(sessionId)
      } catch (error) {
        if (isMissingKey(error) && attempt < 2) continue
        throw error
      }
    }
    return readValues(sessionId)
  }

  /**
   * Delete one session record outright (resetSession, reconciliation). Queued
   * behind that session's pending writes so a reset cannot interleave with them.
   * @param sessionId - session key.
   * @returns whether the session had anything to drop: a durable record, a
   *   pending entry, or both.
   */
  async function drop(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (isDurable()) assertStorageKey(sessionId)
    return enqueueWrite(sessionId, () => dropNow(sessionId))
  }

  /**
   * The queued body of drop(); never called directly. A pending entry for the
   * session is part of what "the session's overrides" means, so it is cleared
   * too — otherwise the value would stay readable and the next replay tick would
   * write the record back (a deleted session's settings resurrecting).
   * @param sessionId - session key.
   * @returns whether a durable record, a pending entry, or both were dropped.
   */
  async function dropNow(sessionId) {
    if (!isDurable()) return memory.delete(sessionId)
    const removedDurable = await table.delete(sessionId)
    const hadPending = memory.delete(sessionId)
    if (hadPending) {
      armRetryTimer()
      // Say only what happened: the durable record may never have existed.
      const suffix = removedDurable ? ' together with its durable record' : ' (no durable record existed)'
      logger?.info?.('[dsh-session-settings] dropped 1 pending override set of session "' + sessionId + '"' + suffix)
    }
    return removedDurable || hadPending
  }

  /** Release the domain handle (the domain is owned by this store, not the facility). */
  async function close() {
    stopRetryTimer()
    const opened = domain
    domain = null
    table = null
    if (opened !== null && typeof opened.close === 'function') await opened.close()
    reason = 'store closed'
  }

  return { domainSpec, status, isDurable, attach, readValues, listSessionIds, mutate, drop, retryPending, close }
}
