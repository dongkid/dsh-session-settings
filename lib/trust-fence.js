/**
 * Browser-trust fence for the /session-settings/api route.
 *
 * Equivalent to the /api gateway's fence (@deepseek-ai/dsh-client-connection
 * src/api-request-trust.ts + src/loopback-hostname.ts, which the package does
 * not export) plus the desktop shell's application origin. Behaviour is kept
 * line-for-line with the proven copy in DSH-better-sidebar/src/trust-fence.ts.
 *
 * This is a DNS-rebinding / cross-site defense, not authentication: Host-header
 * loopback or a configured trusted authority passes, cross-site browser markers
 * refuse.
 * @module dsh-session-settings/trust-fence
 */

/** Origin of the Electron desktop shell's application page (dsh-app: scheme). */
export const SHELL_APP_ORIGIN = 'dsh-app://app'

/** One header value, or undefined when absent / repeated. */
function header(headers, name) {
  if (headers === null || headers === undefined) return undefined
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch (error) {
    return undefined
  }
}

/**
 * Whether a hostname names the local loopback authority.
 * @param hostname - normalized hostname.
 * @returns true for localhost, [::1] and 127.0.0.0/8 literals.
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some(entry => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach the plugin route.
 * @param request - node HTTP request facts (headers, plus the method/url the
 *   narrow bfcache exception is scoped to).
 * @param trustedHosts - non-loopback authorities this deployment serves. Read
 *   fresh per request from ctx.webStartup.trustedHosts (0.2.1+); the removed
 *   ctx.webRuntime carried the same list on 0.2.0 and remains a fallback.
 * @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const headers = request?.headers
  const host = header(headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const hosts = Array.isArray(trustedHosts) ? trustedHosts : []
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, hosts)) return false
  const fetchSite = header(headers, 'sec-fetch-site')
  if (fetchSite === 'cross-site') {
    // Chromium can restore a same-origin subresource from bfcache with a stale
    // cross-site marker. The exception is deliberately narrow: the media route
    // only, browser image subresources only (no-cors + image), and the
    // unforgeable Referer must name this exact authority. The bridge is
    // POST-only, so this branch is unreachable today; it is kept so the fence
    // stays an equivalent copy of the official rule for future GET routes.
    const referer = header(headers, 'referer')
    const mediaRequest = request?.method === 'GET' && (request?.url ?? '').startsWith('/sidebar/file')
    const restoredImage = mediaRequest
      && header(headers, 'sec-fetch-mode') === 'no-cors'
      && header(headers, 'sec-fetch-dest') === 'image'
      && referer !== undefined
      && (() => {
        try {
          return new URL(referer).host === hostUrl.host
        } catch (error) {
          return false
        }
      })()
    if (!restoredImage) return false
  }
  // Origin fence: when a browser attaches an Origin it must name this hostname
  // (the Host fence above already bound the authority, so the port must not
  // re-decide trust). Absent Origin is fine. The literal "null" is an opaque
  // origin and is refused, as is any other foreign origin.
  const origin = header(headers, 'origin')
  if (origin === undefined) return true
  if (origin === SHELL_APP_ORIGIN) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch (error) {
    return false
  }
}
