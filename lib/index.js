/**
 * dsh-session-settings — host half.
 *
 * Owns the per-session configuration truth: the registration registry, the
 * two-layer resolution (registered default -> this session's override), the
 * sparse override store, change notification, reconciliation, and the fenced
 * POST bridge the browser half talks to.
 *
 * Storage, resolution and the fence live in their own modules; this file is the
 * assembly that wires them to Cordis (protocol 3 service surface, protocol 5
 * storage, protocol 1/2 transport).
 */

import {
  SessionSettingsError,
  normalizeRegistration,
  buildSnapshot,
  isJsonValue,
  setValue,
  resetValues,
  reconcileSessionIds,
} from './resolve.js'
import { createStore, assertStorageKey } from './store.js'
import { createBridge } from './bridge.js'

/** Cordis plugin name. */
export const name = 'dsh-session-settings'

/** Service key other plugins inject: ctx.sessionSettings */
const SERVICE_KEY = 'sessionSettings'

/**
 * How often a page-driven reconciliation pass is allowed. Reconciliation is
 * cheap but reads every stored session header, so it runs at mount and then at
 * most this often; the trigger is a bridge request, which means a page being
 * used.
 */
export const RECONCILE_INTERVAL_MS = 30 * 60 * 1000

/** Compact one-line description of an unknown thrown value. */
function describeError(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

export function apply(ctx) {
  const store = createStore({ ctx })
  const logger = ctx.logger

  /** pluginId -> normalized registration, in registration order. */
  const registrations = new Map()
  const listeners = new Set()

  function profileOf() {
    try {
      const profileContext = ctx.get('profileContext')
      const profileName = profileContext?.name
      return typeof profileName === 'string' && profileName !== '' ? profileName : undefined
    } catch (error) {
      return undefined
    }
  }

  /** Change notification (protocol 3): registered / unregistered / values. */
  function notify(change) {
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        logger?.warn?.('[dsh-session-settings] subscriber failed: ' + describeError(error))
      }
    }
  }

  function requireSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new SessionSettingsError('bad-request', 'sessionId must be a non-empty string')
    }
    // Same rule in both storage modes: a degraded (memory) host must not accept
    // an id that a durable host would refuse, or the rejection would depend on
    // whether storage happened to be available.
    return assertStorageKey(sessionId)
  }

  function requireRegistration(pluginId) {
    const registration = registrations.get(pluginId)
    if (registration === undefined) {
      throw new SessionSettingsError('unknown-plugin', 'pluginId "' + String(pluginId) + '" is not registered with sessionSettings')
    }
    return registration
  }

  function requireItem(registration, itemKey) {
    const item = registration.items.find(candidate => candidate.key === itemKey)
    if (item === undefined) {
      throw new SessionSettingsError('unknown-item', 'itemKey "' + String(itemKey) + '" is not registered by pluginId "' + registration.pluginId + '"')
    }
    return item
  }

  /** Registrations in display order: order ascending, registration order for ties. */
  function orderedRegistrations() {
    return [...registrations.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  }

  /** Read one session record and apply the two-layer resolution. */
  function snapshot(sessionId) {
    requireSessionId(sessionId)
    const { overrides, resolved } = buildSnapshot(orderedRegistrations(), store.readValues(sessionId))
    return { sessionId, overrides, resolved }
  }

  /** Read-modify-write one session's values map through the store. */
  async function writeValues(sessionId, transform) {
    await store.mutate(sessionId, current => {
      const base = current ?? {}
      const next = { ...base, values: transform(base.values ?? {}) }
      if (next.profile === undefined) {
        const profile = profileOf()
        if (profile !== undefined) next.profile = profile
      }
      return next
    })
  }

  /** Per-session writes on the store keep going after reset/delete of a record. */
  const service = {
    /**
     * Register one consumer's declarative items. Host half only, by design:
     * the host must resolve defaults even with no page open.
     * @param registration - see docs/design-v1.md section 4.1.
     * @returns a disposer withdrawing this exact registration.
     */
    register(registration) {
      const normalized = normalizeRegistration(registration)
      const occupant = registrations.get(normalized.pluginId)
      if (occupant !== undefined) {
        const title = typeof occupant.title === 'string' ? occupant.title : occupant.pluginId
        throw new SessionSettingsError('bad-request', 'sessionSettings.register: pluginId "' + normalized.pluginId + '" is already registered by "' + title + '"')
      }
      registrations.set(normalized.pluginId, normalized)
      notify({ kind: 'registered', pluginId: normalized.pluginId })
      return () => {
        if (registrations.get(normalized.pluginId) !== normalized) return
        registrations.delete(normalized.pluginId)
        notify({ kind: 'unregistered', pluginId: normalized.pluginId })
      }
    },
    /** Every live registration, in display order. */
    listRegistrations() {
      return orderedRegistrations()
    },
    /**
     * Fully resolved values of one plugin for one session (protocol 3).
     * @param pluginId - registered plugin.
     * @param sessionId - session key.
     * @returns the resolved map, or undefined when the plugin is not registered.
     */
    get(pluginId, sessionId) {
      requireSessionId(sessionId)
      const registration = registrations.get(pluginId)
      if (registration === undefined) return undefined
      const stored = store.readValues(sessionId)
      return buildSnapshot([registration], stored).resolved[registration.pluginId]
    },
    /**
     * One resolved item value.
     * @param pluginId - registered plugin.
     * @param itemKey - item key within that plugin.
     * @param sessionId - session key.
     * @returns the resolved value, or undefined when plugin or item is unknown.
     */
    getItem(pluginId, itemKey, sessionId) {
      const values = service.get(pluginId, sessionId)
      if (values === undefined) return undefined
      return Object.hasOwn(values, itemKey) ? values[itemKey] : undefined
    },
    /**
     * Write one item (protocol 3). Writing the item's default removes the
     * override instead of storing a copy of the default.
     * @param pluginId - registered plugin.
     * @param itemKey - item key within that plugin.
     * @param sessionId - session key.
     * @param value - the new value.
     */
    async set(pluginId, itemKey, sessionId, value) {
      const registration = requireRegistration(pluginId)
      const item = requireItem(registration, itemKey)
      requireSessionId(sessionId)
      if (!isJsonValue(value)) {
        throw new SessionSettingsError('bad-request', 'value must be a JSON value')
      }
      await writeValues(sessionId, values => setValue(values, pluginId, itemKey, value, item.default))
      notify({ kind: 'values', pluginId, sessionId, itemKey })
    },
    /**
     * Restore defaults at one of three grains (protocol 3).
     * @param pluginId - registered plugin, or undefined to clear the whole session.
     * @param sessionId - session key.
     * @param itemKey - optional single item of pluginId.
     */
    async reset(pluginId, sessionId, itemKey) {
      requireSessionId(sessionId)
      let target
      if (pluginId !== undefined && pluginId !== null) {
        const registration = requireRegistration(pluginId)
        if (itemKey !== undefined && itemKey !== null) requireItem(registration, itemKey)
        target = { pluginId: registration.pluginId, itemKey: itemKey ?? undefined }
      } else if (itemKey !== undefined && itemKey !== null) {
        throw new SessionSettingsError('bad-request', 'reset: itemKey requires pluginId')
      } else {
        target = {}
      }
      await writeValues(sessionId, values => resetValues(values, target))
      notify({ kind: 'values', pluginId: target.pluginId, sessionId, itemKey: target.itemKey })
    },
    /**
     * Drop every override of one session.
     * @param sessionId - session key.
     */
    async resetSession(sessionId) {
      requireSessionId(sessionId)
      await store.drop(sessionId)
      notify({ kind: 'values', sessionId })
    },
    /**
     * Subscribe to change notifications.
     * @param listener - called with { kind, pluginId?, sessionId?, itemKey? }.
     * @returns the unsubscribe function.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new SessionSettingsError('bad-request', 'subscribe: listener must be a function')
      }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /**
     * Bridge-shaped snapshot of one session (protocol 2.2-2.4 response body).
     * Not part of the protocol 3 list; it exists so the transport layer never
     * reaches past the service into the store.
     * @param sessionId - session key.
     * @returns { sessionId, overrides, resolved }.
     */
    snapshot(sessionId) {
      return snapshot(sessionId)
    },
    /**
     * Storage capability, so a host-side consumer or test can see that the
     * store is running from memory ("lost on restart") instead of guessing.
     * @returns { durable, backend, reason }.
     */
    storageStatus() {
      return store.status()
    },
  }

  ctx.provide(SERVICE_KEY, service)
  ctx.effect(() => () => store.close(), 'dsh-session-settings: session_settings domain handle')

  // ── Bridge ───────────────────────────────────────────────────────────────
  // read per request from the live service value; a replaced trust list takes
  // effect without a plugin restart.
  const bridge = createBridge({
    service,
    storageStatus: () => store.status(),
    trustedHosts: () => {
      // DSH 0.2.1 removed the webRuntime service; the invocation's
      // --trusted-host authorities now live on webStartup (the connection row
      // reads the same place). Read fresh per request; webRuntime stays as the
      // 0.2.0 fallback so one build serves both hosts.
      const startup = ctx.get('webStartup')
      if (startup !== null && startup !== undefined && Array.isArray(startup.trustedHosts)) {
        return startup.trustedHosts
      }
      const runtime = ctx.get('webRuntime')
      return runtime !== null && runtime !== undefined && Array.isArray(runtime.trustedHosts)
        ? runtime.trustedHosts
        : []
    },
    onActivity: () => { reconcileIfDue() },
    logger,
  })

  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => bridge.register(webCtx), 'dsh-session-settings: ' + bridge.API_PREFIX + ' route')
  })

  // ── Storage attach ───────────────────────────────────────────────────────
  // storageDomain mounts after the storage backends activate, so it may appear
  // after this plugin does. Until then (and forever, if it never arrives) the
  // store serves from memory and storageStatus() reports why.
  ctx.inject(['storageDomain'], storageCtx => {
    void store.attach(storageCtx.get('storageDomain'))
  })

  // ── Reconciliation ───────────────────────────────────────────────────────
  // Never session/disposed: that fires on every session switch, and it must not
  // be allowed to delete data. Reconciliation diffs sessionPersistence.list()
  // against the domain's keys, at mount and then at a low frequency. Archived
  // sessions are still listed, so their settings survive.
  let lastReconcileAt = 0
  let reconcileInFlight = null
  let reconcileAssembled = false
  let lastReconcileWarnAt = 0

  /**
   * A skipped pass must be answerable from the host log: "why was this record
   * never reclaimed?". Throttled to one line per reconcile interval so a busy
   * page cannot flood the log.
   * @param reason - why the pass did not run.
   */
  function warnReconcileDisabled(reason) {
    const nowMs = Date.now()
    if (nowMs - lastReconcileWarnAt < RECONCILE_INTERVAL_MS) return
    lastReconcileWarnAt = nowMs
    logger?.warn?.('[dsh-session-settings] reconciliation skipped: ' + reason + '; records of deleted sessions are not reclaimed until it runs')
  }

  const reconcileNow = () => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === null || persistence === undefined || typeof persistence.list !== 'function') {
      reconcileAssembled = false
      warnReconcileDisabled('sessionPersistence is not available')
      return Promise.resolve({ skipped: 'sessionPersistence is not available' })
    }
    if (!store.isDurable()) {
      warnReconcileDisabled('storage is running in memory (storageDomain is unavailable)')
      return Promise.resolve({ skipped: 'storage is running from memory' })
    }
    if (reconcileInFlight !== null) return reconcileInFlight
    reconcileInFlight = (async () => {
      try {
        const snapshots = await persistence.list()
        const existing = []
        for (const entry of snapshots ?? []) {
          const id = entry?.header?.id
          if (typeof id === 'string' && id !== '') existing.push(id)
        }
        const { stale } = reconcileSessionIds(existing, store.listSessionIds())
        for (const id of stale) await store.drop(id)
        lastReconcileAt = Date.now()
        if (stale.length > 0) {
          logger?.info?.('[dsh-session-settings] reconciliation removed ' + String(stale.length) + ' record(s) of deleted session(s)')
        }
        return { existing: existing.length, removed: stale.length }
      } catch (error) {
        logger?.warn?.('[dsh-session-settings] reconciliation failed: ' + describeError(error))
        return { error: describeError(error) }
      } finally {
        reconcileInFlight = null
      }
    })()
    return reconcileInFlight
  }
  function reconcileIfDue() {
    if (reconcileInFlight !== null) return
    if (Date.now() - lastReconcileAt < RECONCILE_INTERVAL_MS) return
    void reconcileNow()
  }

  ctx.inject(['storageDomain', 'sessionPersistence'], reconcileCtx => {
    reconcileAssembled = true
    logger?.info?.('[dsh-session-settings] reconciliation assembled (sessionPersistence + storageDomain)')
    void store.attach(reconcileCtx.get('storageDomain')).then(() => reconcileNow())
  })

  // The inject above simply never fires when sessionPersistence is absent, which
  // used to leave no trace at all. Once the loader has settled, say so loudly
  // instead: an absent service is a fact about this deployment, not a timing
  // accident, and it is the answer to "why was this record never reclaimed?".
  if (typeof ctx.loader?.await === 'function') {
    const loader = ctx.loader
    void Promise.resolve()
      .then(() => loader.await())
      .then(() => {
        if (reconcileAssembled) return
        warnReconcileDisabled('reconciliation was not assembled at mount because sessionPersistence is not mounted')
      }, error => {
        logger?.warn?.('[dsh-session-settings] could not tell whether reconciliation was assembled: ' + describeError(error))
      })
  }

  logger?.info?.('[dsh-session-settings] host half mounted')
}
