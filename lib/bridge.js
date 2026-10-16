/**
 * dsh-session-settings — the host <-> browser bridge.
 *
 * One prefix route, POST only, four methods (protocol 1 and 2). Every status
 * code and error code comes from protocol 1/6 and nothing else: the fence runs
 * first, then the method check, then an own-property dispatch (so
 * POST .../constructor or .../toString can never resolve to a method).
 * @module dsh-session-settings/bridge
 */

import { SessionSettingsError, errorStatus, serializeRegistration } from './resolve.js'
import { isTrustedApiRequest } from './trust-fence.js'

/** Route path registered on ctx.webServer (protocol 1). */
export const API_PREFIX = '/session-settings/api'

/** The complete method set of v1, in protocol order. */
export const METHOD_NAMES = Object.freeze([
  'registrations.list',
  'values.get',
  'values.set',
  'values.reset',
])

/** Request bodies are tiny JSON objects; anything larger is a bad request. */
const MAX_BODY_BYTES = 1024 * 1024

/** Compact one-line description of an unknown thrown value. */
function describeError(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

/** Required non-empty string field of a request payload. */
function requireField(payload, field) {
  const value = payload === null || typeof payload !== 'object' ? undefined : payload[field]
  if (typeof value !== 'string' || value === '') {
    throw new SessionSettingsError('bad-request', 'field "' + field + '" must be a non-empty string')
  }
  return value
}

/** Optional non-empty string field of a request payload. */
function optionalField(payload, field) {
  const value = payload === null || typeof payload !== 'object' ? undefined : payload[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new SessionSettingsError('bad-request', 'field "' + field + '" must be a non-empty string when present')
  }
  return value
}

/** Read the whole request body and parse it as a JSON object. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new SessionSettingsError('bad-request', 'request body exceeds ' + String(MAX_BODY_BYTES) + ' bytes')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SessionSettingsError('bad-request', 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionSettingsError('bad-request', 'request body must be a JSON object')
  }
  return parsed
}

/** Write one JSON response; the handler owns the whole response lifecycle. */
function send(response, status, body) {
  const text = JSON.stringify(body)
  if (response.headersSent === true) {
    response.end(text)
    return
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/** protocol 1 success envelope. */
function sendOk(response, value) {
  send(response, 200, { ok: true, value })
}

/** protocol 1 failure envelope. */
function sendError(response, status, code, message) {
  send(response, status, { ok: false, error: { code, message } })
}

/**
 * Build the bridge over the host service.
 * @param options - service (host half), storageStatus, trustedHosts, onActivity, logger.
 * @returns the method table, a direct dispatch(), the HTTP handler and register().
 */
export function createBridge(options) {
  const service = options.service
  const storageStatus = typeof options.storageStatus === 'function' ? options.storageStatus : () => ({ durable: true, backend: 'storageDomain', reason: null })
  const trustedHostsOf = typeof options.trustedHosts === 'function' ? options.trustedHosts : () => []
  const onActivity = typeof options.onActivity === 'function' ? options.onActivity : null
  const logger = options.logger

  /**
   * The durability precondition of the values.* methods. The host service keeps
   * working from memory when storage is degraded, but the browser contract
   * promises durable per-session storage, so the page is told the truth (503)
   * and renders its read-only error bar instead of writing into a memory map.
   */
  function requireDurable() {
    const status = storageStatus()
    if (status !== null && status !== undefined && status.durable === true) return
    const reason = status === null || status === undefined ? 'unknown' : status.reason
    throw new SessionSettingsError(
      'storage-unavailable',
      'storageDomain is unavailable, so the host half fell back to in-memory storage and per-session overrides would be lost on restart (' + String(reason ?? 'no reason reported') + ')',
    )
  }

  /** Snapshot response body shared by values.get / values.set / values.reset (protocol 2.2-2.4). */
  function snapshot(sessionId) {
    return service.snapshot(sessionId)
  }

  const methods = {
    'registrations.list': async () => ({
      registrations: service.listRegistrations().map(serializeRegistration),
    }),
    'values.get': async payload => {
      requireDurable()
      return snapshot(requireField(payload, 'sessionId'))
    },
    'values.set': async payload => {
      requireDurable()
      const sessionId = requireField(payload, 'sessionId')
      const pluginId = requireField(payload, 'pluginId')
      const itemKey = requireField(payload, 'itemKey')
      if (!Object.hasOwn(payload, 'value')) {
        throw new SessionSettingsError('bad-request', 'field "value" is required')
      }
      await service.set(pluginId, itemKey, sessionId, payload.value)
      return snapshot(sessionId)
    },
    'values.reset': async payload => {
      requireDurable()
      const sessionId = requireField(payload, 'sessionId')
      const pluginId = optionalField(payload, 'pluginId')
      const itemKey = optionalField(payload, 'itemKey')
      if (itemKey !== undefined && pluginId === undefined) {
        throw new SessionSettingsError('bad-request', 'field "itemKey" requires "pluginId"')
      }
      await service.reset(pluginId, sessionId, itemKey)
      return snapshot(sessionId)
    },
  }

  /**
   * Direct dispatch, own properties only. Exported for tests: the HTTP layer
   * below adds nothing but framing.
   * @param method - method name from the pathname.
   * @param payload - parsed JSON body.
   * @returns the success payload.
   */
  function dispatch(method, payload) {
    if (typeof method !== 'string' || !Object.hasOwn(methods, method)) {
      throw new SessionSettingsError('unknown-method', 'unknown session-settings API method "' + String(method) + '"')
    }
    return methods[method](payload)
  }

  /**
   * The registered route handler. The fence is the first thing it does.
   * @param request - node request.
   * @param response - node response; the handler owns it end to end.
   */
  async function handle(request, response) {
    if (!isTrustedApiRequest(request, trustedHostsOf())) {
      sendError(response, 403, 'forbidden', 'request failed the browser-trust fence')
      return
    }
    if (request.method !== 'POST') {
      sendError(response, 405, 'method-not-allowed', 'only POST is allowed on ' + API_PREFIX)
      return
    }
    if (onActivity !== null) {
      try {
        onActivity()
      } catch (error) {
        logger?.warn?.('[dsh-session-settings] activity hook failed: ' + describeError(error))
      }
    }
    let pathname
    try {
      pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    } catch (error) {
      sendError(response, 400, 'bad-request', 'request URL is not parsable')
      return
    }
    const method = pathname.startsWith(API_PREFIX + '/') ? pathname.slice(API_PREFIX.length + 1) : undefined
    if (method === undefined || method === '' || method.includes('/')) {
      sendError(response, 404, 'unknown-method', 'unknown session-settings API method')
      return
    }
    if (!Object.hasOwn(methods, method)) {
      sendError(response, 404, 'unknown-method', 'unknown session-settings API method "' + method + '"')
      return
    }
    let payload
    try {
      payload = await readJsonBody(request)
    } catch (error) {
      if (error instanceof SessionSettingsError) sendError(response, errorStatus(error.code), error.code, error.message)
      else sendError(response, 400, 'bad-request', describeError(error))
      return
    }
    try {
      sendOk(response, await methods[method](payload))
    } catch (error) {
      if (error instanceof SessionSettingsError) {
        sendError(response, errorStatus(error.code), error.code, error.message)
        return
      }
      logger?.error?.('[dsh-session-settings] bridge method "' + method + '" failed', error)
      sendError(response, 500, 'internal', describeError(error))
    }
  }

  /**
   * Register the prefix route on the webserver. Always used inside ctx.effect so
   * unloading (and HMR) removes the route.
   * @param target - a context carrying webServer.
   * @returns the route disposer.
   */
  function register(target) {
    return target.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle })
  }

  return { methods, dispatch, handle, register, API_PREFIX, METHOD_NAMES }
}
