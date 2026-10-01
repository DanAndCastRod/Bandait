/**
 * Where the follower is allowed to open its socket, and what the page can do
 * in its security context (contract section 8). Pure functions: the page
 * context is injected, so every branch is unit-tested.
 *
 * - An HTTPS page cannot open ws:// to a LAN IP (mixed content: Chrome, Safari
 *   and Firefox block it). From HTTPS the follower never tries the socket to a
 *   non-loopback host; it offers a top-level navigation to the follower served
 *   by the leader itself over http://<ip>:<port>/ with the same parameters.
 * - Plain HTTP from the leader is an insecure context: no service worker,
 *   no Wake Lock API, no in-app camera. The follower switches to alternatives.
 */

export interface PageContext {
  /** e.g. 'https:' or 'http:' (window.location.protocol) */
  protocol: string
  hostname: string
  isSecureContext: boolean
  /** navigator.mediaDevices.getUserMedia exists */
  hasCameraApi: boolean
  /** 'serviceWorker' in navigator */
  hasServiceWorker: boolean
}

export interface LeaderTarget {
  ip: string
  port: string | number
  sessionId: string
}

export interface LeaderLinkExtras {
  /** Musical profile role id (drums, director, ...). */
  role?: string
  alias?: string
  /** The user's current URL params; unknown keys are carried over. */
  keep?: URLSearchParams
}

export type ConnectDecision = { kind: 'connect' } | { kind: 'open_from_leader'; url: string }

export type QrEntryMode = 'in_app' | 'native_camera'

export function currentPageContext(): PageContext {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    return {
      protocol: typeof window !== 'undefined' ? window.location.protocol : 'http:',
      hostname: typeof window !== 'undefined' ? window.location.hostname : 'localhost',
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext === true : false,
      hasCameraApi: !!nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function',
      hasServiceWorker: !!nav && 'serviceWorker' in nav,
    }
  } catch {
    return { protocol: 'http:', hostname: '', isSecureContext: false, hasCameraApi: false, hasServiceWorker: false }
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/** http://<ip>:<port>/?ip=..&port=..&session=..&role=..&alias=..&auto=1 (+ the user's other params). */
export function buildLeaderUrl(target: LeaderTarget, extras: LeaderLinkExtras = {}): string {
  const params = new URLSearchParams()
  params.set('ip', target.ip)
  params.set('port', String(target.port))
  params.set('session', target.sessionId)
  if (extras.role) params.set('role', extras.role)
  if (extras.alias) params.set('alias', extras.alias)
  params.set('auto', '1')
  const core = new Set(['ip', 'port', 'session', 's', 'role', 'alias', 'auto', 'autoconnect'])
  extras.keep?.forEach((value, key) => {
    if (!core.has(key)) params.append(key, value)
  })
  return `http://${target.ip}:${target.port}/?${params.toString()}`
}

/**
 * The single decision point before any socket is opened (form, QR, auto=1).
 * From HTTPS only loopback targets may be dialed directly.
 */
export function decideConnection(page: PageContext, target: LeaderTarget, extras: LeaderLinkExtras = {}): ConnectDecision {
  if (page.protocol === 'https:' && !isLoopbackHost(target.ip)) {
    return { kind: 'open_from_leader', url: buildLeaderUrl(target, extras) }
  }
  return { kind: 'connect' }
}

/** Plain HTTP from the leader has no camera API: use the phone's native camera app. */
export function qrEntryMode(page: PageContext): QrEntryMode {
  return page.isSecureContext && page.hasCameraApi ? 'in_app' : 'native_camera'
}

/** Service workers only exist in secure contexts; in dev there is no sw.js. */
export function shouldRegisterServiceWorker(page: PageContext, isProd: boolean): boolean {
  return isProd && page.isSecureContext && page.hasServiceWorker
}
