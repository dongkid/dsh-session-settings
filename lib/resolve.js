/**
 * dsh-session-settings — pure session-settings logic.
 *
 * Everything here is a plain function over plain data: no DSH imports, no I/O,
 * no clock. That is deliberate — the storage/HTTP glue cannot be exercised
 * without a running Harness, while these rules (two-layer resolution, sparse
 * overrides, reconciliation set arithmetic) are exactly the parts a bug would
 * hide in, so they stay directly testable with node:test.
 * @module dsh-session-settings/resolve
 */

/** The control types the host half accepts, in stable order. */
export const ITEM_TYPES = Object.freeze(['switch', 'text', 'number', 'select', 'stringList'])

/** protocol-v1.md section 6: error code -> HTTP status. */
export const ERROR_STATUS = Object.freeze({
  forbidden: 403,
  'method-not-allowed': 405,
  'unknown-method': 404,
  'bad-request': 400,
  'unknown-plugin': 400,
  'unknown-item': 400,
  conflict: 409,
  'storage-unavailable': 503,
  internal: 500,
})

/**
 * Failure carrying one of the frozen protocol error codes. The host service
 * throws it, the bridge maps its code to a status through errorStatus();
 * nothing else is allowed to invent codes.
 */
export class SessionSettingsError extends Error {
  /**
   * @param code - protocol-v1.md section 6 code.
   * @param message - diagnostic prose (safe to show, never holds secrets).
   * @param options - standard Error options (for example a cause).
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'SessionSettingsError'
    this.code = code
  }
}

/**
 * HTTP status of one error code; unknown codes fall back to 500 (protocol 6).
 * @param code - candidate code.
 * @returns the mapped status.
 */
export function errorStatus(code) {
  return Object.hasOwn(ERROR_STATUS, code) ? ERROR_STATUS[code] : 500
}

/**
 * Whether a value is a JSON value: null, string, boolean, finite number, or an
 * array/plain object of JSON values. Rejects undefined, functions, symbols,
 * NaN/Infinity and cycles — storage is JSON, so anything else cannot round-trip.
 * @param value - candidate.
 * @returns true when the value survives a JSON round-trip structurally.
 */
export function isJsonValue(value, seen = new Set()) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (type !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const ok = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.values(value).every(item => isJsonValue(item, seen))
  seen.delete(value)
  return ok
}

/**
 * Structural deep equality over JSON values. Used for the sparse rule: a write
 * whose value equals the item default deletes the override instead of storing
 * a copy of the default.
 * @param a - left value.
 * @param b - right value.
 * @returns true when both sides are the same JSON structure.
 */
export function jsonEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonEqual(item, b[index]))
  }
  if (typeof a === 'object') {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  }
  return false
}

/**
 * Deep copy of a JSON value, so a value handed to a consumer can never alias the
 * registration object or the stored record it came from.
 * @param value - any JSON value.
 * @returns an independent copy (primitives are returned as-is).
 */
export function cloneJson(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

/** Text accepted by the protocol for titles/descriptions: a string or a thunk. */
function assertText(value, where) {
  if (typeof value === 'string' || typeof value === 'function') return
  throw new SessionSettingsError('bad-request', where + ' must be a string or a function returning a string')
}

/**
 * Validate and normalize one consumer registration. Everything the bridge and
 * the page later read is fixed here, so a malformed registration fails at the
 * registration call (loud) instead of at render time (silent).
 * @param raw - the consumer-supplied registration.
 * @returns the normalized registration (same shapes, validated).
 */
export function normalizeRegistration(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SessionSettingsError('bad-request', 'registration must be an object')
  }
  const pluginId = raw.pluginId
  if (typeof pluginId !== 'string' || pluginId === '') {
    throw new SessionSettingsError('bad-request', 'sessionSettings.register: pluginId is required')
  }
  assertText(raw.title, 'registration.title')
  if (raw.order !== undefined && typeof raw.order !== 'number') {
    throw new SessionSettingsError('bad-request', 'registration.order must be a number')
  }
  if (raw.locale !== undefined && (raw.locale === null || typeof raw.locale !== 'object')) {
    throw new SessionSettingsError('bad-request', 'registration.locale must be an object')
  }
  if (!Array.isArray(raw.items)) {
    throw new SessionSettingsError('bad-request', 'registration.items must be an array')
  }
  const keys = new Set()
  const items = raw.items.map((item, index) => {
    const where = 'registration.items[' + String(index) + ']'
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SessionSettingsError('bad-request', where + ' must be an object')
    }
    if (typeof item.key !== 'string' || item.key === '') {
      throw new SessionSettingsError('bad-request', where + '.key is required')
    }
    if (keys.has(item.key)) {
      throw new SessionSettingsError('bad-request', where + '.key "' + item.key + '" is duplicated in this registration')
    }
    keys.add(item.key)
    if (!ITEM_TYPES.includes(item.type)) {
      throw new SessionSettingsError('bad-request', where + '.type must be one of ' + ITEM_TYPES.join('/'))
    }
    assertText(item.title, where + '.title')
    if (item.description !== undefined) assertText(item.description, where + '.description')
    if (!Object.hasOwn(item, 'default')) {
      throw new SessionSettingsError('bad-request', where + '.default is required (layer 1 of the two-layer resolution)')
    }
    if (!isJsonValue(item.default)) {
      throw new SessionSettingsError('bad-request', where + '.default must be a JSON value')
    }
    if (item.options !== undefined && !Array.isArray(item.options)) {
      throw new SessionSettingsError('bad-request', where + '.options must be an array')
    }
    return item
  })
  return { pluginId, title: raw.title, order: raw.order, locale: raw.locale, items }
}

/** Evaluate a registration-time text node once, host side (protocol 2.1). */
function evaluateText(value) {
  if (typeof value === 'function') {
    try {
      const produced = value()
      return typeof produced === 'string' ? produced : String(produced ?? '')
    } catch (error) {
      return ''
    }
  }
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * Project one registration onto the wire shape of protocol 2.1. Titles and
 * descriptions become the strings their thunks produced now; the locale
 * dictionary travels untouched so the client can localize what it renders.
 * @param registration - a normalized registration.
 * @returns the serialized registration.
 */
export function serializeRegistration(registration) {
  const serialized = {
    pluginId: registration.pluginId,
    title: evaluateText(registration.title),
    items: registration.items.map(item => {
      const row = {
        key: item.key,
        type: item.type,
        title: evaluateText(item.title),
        // Copied, not aliased: the wire path stringifies immediately, but an
        // in-process consumer of this listing would otherwise be able to edit
        // the registration's default in place.
        default: cloneJson(item.default),
      }
      if (item.description !== undefined) row.description = evaluateText(item.description)
      for (const field of ['min', 'max', 'step', 'unit', 'placeholder']) {
        if (item[field] !== undefined) row[field] = item[field]
      }
      if (item.options !== undefined) {
        row.options = item.options.map(option => {
          const entry = { value: option.value, title: evaluateText(option.title) }
          if (option.description !== undefined) entry.description = evaluateText(option.description)
          return entry
        })
      }
      return row
    }),
  }
  if (registration.order !== undefined) serialized.order = registration.order
  if (registration.locale !== undefined) serialized.locale = registration.locale
  return serialized
}

/**
 * Drop structurally unusable override data (hand-edited files, older shapes).
 * Only the shape is checked here; "is this plugin/item known" is a registry
 * question answered by resolveValues().
 * @param raw - stored values map, or anything.
 * @returns a clean pluginId -> itemKey -> value copy.
 */
export function sanitizeOverrides(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const clean = {}
  for (const pluginId of Object.keys(raw)) {
    const group = raw[pluginId]
    if (group === null || typeof group !== 'object' || Array.isArray(group)) continue
    const entries = {}
    for (const itemKey of Object.keys(group)) {
      const value = group[itemKey]
      if (value === undefined) continue
      if (!isJsonValue(value)) continue
      entries[itemKey] = value
    }
    if (Object.keys(entries).length > 0) clean[pluginId] = entries
  }
  return clean
}

/**
 * Layer 2 over layer 1: registered defaults, then this session's overrides.
 * Only registered items exist in the result — a stored key for an unregistered
 * item is preserved on disk but never invented into a value.
 * @param registration - a normalized registration.
 * @param overrides - stored overrides for this plugin (may be undefined).
 * @returns itemKey -> value, with every registered item present.
 */
export function resolveValues(registration, overrides) {
  const resolved = {}
  for (const item of registration.items) {
    const applied = overrides !== undefined
      && overrides !== null
      && Object.hasOwn(overrides, item.key)
      && overrides[item.key] !== undefined
    // Both layers are copied: a host consumer mutating a returned object would
    // otherwise edit the registration's default (or the store's record) in place
    // and change every later read of every session.
    resolved[item.key] = cloneJson(applied ? overrides[item.key] : item.default)
  }
  return resolved
}

/**
 * The sparse subset of stored overrides that actually differs from a default —
 * what protocol 2.2 puts in overrides (never a copy of a default).
 * @param registration - a normalized registration.
 * @param overrides - stored overrides for this plugin.
 * @returns itemKey -> value (empty when nothing is overridden).
 */
export function resolveOverrides(registration, overrides) {
  const kept = {}
  if (overrides === null || overrides === undefined) return kept
  for (const item of registration.items) {
    if (!Object.hasOwn(overrides, item.key) || overrides[item.key] === undefined) continue
    if (jsonEqual(overrides[item.key], item.default)) continue
    kept[item.key] = cloneJson(overrides[item.key])
  }
  return kept
}

/**
 * Full bridge snapshot for one session: the override subset plus the resolved
 * values, per registered plugin (protocol 2.2/2.3/2.4 response body).
 * @param registrations - normalized registrations, in the order to report.
 * @param storedValues - the session's stored values map.
 * @returns overrides and resolved, both keyed by pluginId.
 */
export function buildSnapshot(registrations, storedValues) {
  const stored = sanitizeOverrides(storedValues)
  const overrides = {}
  const resolved = {}
  for (const registration of registrations) {
    const pluginId = registration.pluginId
    const group = stored[pluginId]
    resolved[pluginId] = resolveValues(registration, group)
    const kept = resolveOverrides(registration, group)
    if (Object.keys(kept).length > 0) overrides[pluginId] = kept
  }
  return { overrides, resolved }
}

/**
 * Apply one write with the sparse rule: a value equal to the item default
 * deletes the override; an emptied plugin map deletes the plugin key. An empty
 * result means the caller deletes the whole record (protocol 5).
 * @param values - current values map (not mutated).
 * @param pluginId - owning plugin.
 * @param itemKey - item key.
 * @param value - the value being written.
 * @param defaultValue - the item registered default.
 * @returns the next values map.
 */
export function setValue(values, pluginId, itemKey, value, defaultValue) {
  const next = sanitizeOverrides(values)
  const group = { ...(next[pluginId] ?? {}) }
  if (jsonEqual(value, defaultValue)) delete group[itemKey]
  // Stored as a copy: the caller keeps ownership of the object it passed in, and
  // later editing it must not rewrite the durable record behind its back.
  else group[itemKey] = cloneJson(value)
  if (Object.keys(group).length === 0) delete next[pluginId]
  else next[pluginId] = group
  return next
}

/**
 * Apply a reset at one of the three grains of protocol 2.4.
 * @param values - current values map (not mutated).
 * @param target - empty target = whole session, pluginId only = one plugin, both = one item.
 * @returns the next values map.
 */
export function resetValues(values, target) {
  const next = sanitizeOverrides(values)
  if (target === null || typeof target !== 'object' || target.pluginId === undefined) return {}
  if (target.itemKey === undefined) {
    delete next[target.pluginId]
    return next
  }
  const group = { ...(next[target.pluginId] ?? {}) }
  delete group[target.itemKey]
  if (Object.keys(group).length === 0) delete next[target.pluginId]
  else next[target.pluginId] = group
  return next
}

/**
 * Reconciliation arithmetic: stored session ids that no longer exist. An
 * archived session still appears in sessionPersistence.list(), so archiving
 * never makes a record stale — only a deleted session does.
 * @param existingIds - ids reported by ctx.sessionPersistence.list().
 * @param storedIds - ids currently in the settings domain.
 * @returns keep and stale, both sorted and de-duplicated.
 */
export function reconcileSessionIds(existingIds, storedIds) {
  const existing = new Set()
  for (const id of existingIds ?? []) if (typeof id === 'string' && id !== '') existing.add(id)
  const stored = new Set()
  for (const id of storedIds ?? []) if (typeof id === 'string' && id !== '') stored.add(id)
  const keep = []
  const stale = []
  for (const id of stored) (existing.has(id) ? keep : stale).push(id)
  return { keep: keep.sort(), stale: stale.sort() }
}
