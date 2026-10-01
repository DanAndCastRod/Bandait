/**
 * Served-by-leader detection (contract section 8).
 *
 * On stage the phone loads the follower from the leader itself
 * (http://<lan-ip>:4040/). The leader answers GET /leader-info.json with
 * {protocol_version, leader_instance_id, session_id, ip, port, follower_url,
 * director_url}. When that answers with valid v3 JSON the follower uses it as
 * its leader without asking for an IP.
 *
 * Anywhere else (Cloudflare, dev server) the request fails or, because of the
 * SPA rewrite, returns index.html: both are treated as "not served". Never
 * throws; bounded by a short timeout so startup is never blocked.
 */

import { decodeLeaderInfo } from '../protocol/wire'
import { LeaderInfo, PROTOCOL_VERSION } from '../types/protocol'

export const LEADER_INFO_URL = './leader-info.json'
export const LEADER_INFO_TIMEOUT_MS = 1500

export type LeaderInfoAbsentReason =
  | 'unsupported' // no fetch in this environment
  | 'timeout'
  | 'network'
  | 'http' // non-2xx
  | 'html' // SPA rewrite answered index.html
  | 'invalid' // not JSON, or JSON that breaks the contract
  | 'version' // a leader on another protocol version

export type LeaderInfoOutcome =
  | { kind: 'served'; info: LeaderInfo }
  | { kind: 'absent'; reason: LeaderInfoAbsentReason; detail?: string }

/** The subset of fetch/Response this module needs (a fake implements it in tests). */
export interface FetchResponseLike {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: { cache: 'no-store'; signal?: AbortSignal; headers: Record<string, string> },
) => Promise<FetchResponseLike>

export interface DetectOptions {
  fetchFn?: FetchLike | null
  url?: string
  timeoutMs?: number
}

function absent(reason: LeaderInfoAbsentReason, detail?: string): LeaderInfoOutcome {
  return detail === undefined ? { kind: 'absent', reason } : { kind: 'absent', reason, detail }
}

function defaultFetch(): FetchLike | null {
  if (typeof fetch !== 'function') return null
  return (url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>
}

export async function detectLeaderInfo(options: DetectOptions = {}): Promise<LeaderInfoOutcome> {
  const fetchFn = options.fetchFn === undefined ? defaultFetch() : options.fetchFn
  if (!fetchFn) return absent('unsupported')
  const url = options.url ?? LEADER_INFO_URL
  const timeoutMs = options.timeoutMs ?? LEADER_INFO_TIMEOUT_MS

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null }
  const timeout = new Promise<LeaderInfoOutcome>((resolve) => {
    timer.id = setTimeout(() => {
      try {
        controller?.abort()
      } catch {
        // Ignore.
      }
      resolve(absent('timeout'))
    }, timeoutMs)
  })

  const attempt = (async (): Promise<LeaderInfoOutcome> => {
    let res: FetchResponseLike
    try {
      res = await fetchFn(url, {
        cache: 'no-store',
        signal: controller?.signal,
        headers: { Accept: 'application/json' },
      })
    } catch (err) {
      return absent('network', err instanceof Error ? err.message : String(err))
    }
    if (!res.ok) return absent('http', String(res.status))
    const type = res.headers.get('content-type') ?? ''
    if (/text\/html/i.test(type)) return absent('html')
    let text: string
    try {
      text = await res.text()
    } catch (err) {
      return absent('network', err instanceof Error ? err.message : String(err))
    }
    if (/^\s*</.test(text)) return absent('html')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return absent('invalid', 'la respuesta no es JSON')
    }
    if (raw && typeof raw === 'object' && 'protocol_version' in raw) {
      const version = (raw as { protocol_version: unknown }).protocol_version
      if (version !== PROTOCOL_VERSION) return absent('version', `protocol_version ${String(version)}`)
    }
    const decoded = decodeLeaderInfo(raw)
    return decoded.ok ? { kind: 'served', info: decoded.value } : absent('invalid', decoded.error)
  })()

  try {
    return await Promise.race([attempt, timeout])
  } catch (err) {
    return absent('network', err instanceof Error ? err.message : String(err))
  } finally {
    if (timer.id !== null) clearTimeout(timer.id)
  }
}
