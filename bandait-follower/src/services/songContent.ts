/**
 * Song content for the prompter (CONTRACT_V3 9.1).
 *
 * The SessionState carries only `content_etag` per setlist item. When it changes
 * (or on join) this store fetches GET <leader>/songs/<song_id>.json, current song
 * first, and keeps the result in memory: once downloaded, the prompter keeps
 * working in Flywheel with no network. Failed downloads are retried a few times;
 * a leader before v3.2 (no content_etag) is never asked.
 *
 * Nothing here runs in the metronome hot path: fetches happen on state changes.
 */

import { decodeSongContent } from '../protocol/wire'
import { SetlistEntry, SongContent, SongSection } from '../types/protocol'

export const SONG_FETCH_TIMEOUT_MS = 4000
export const SONG_RETRY_MS = 3000
export const SONG_MAX_ATTEMPTS = 4
const CONCURRENCY = 2

export interface SongResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type SongFetch = (url: string, init: { cache: 'no-cache'; signal?: AbortSignal }) => Promise<SongResponseLike>

export interface SongTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

interface Wanted {
  songId: string
  etag: string
  attempts: number
  /** Failed recently: waits for the retry timer instead of refetching at once. */
  backoff: boolean
}

export function songContentUrl(baseUrl: string, songId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/songs/${encodeURIComponent(songId)}.json`
}

function defaultFetch(): SongFetch | null {
  if (typeof fetch !== 'function') return null
  return (url, init) => fetch(url, init) as unknown as Promise<SongResponseLike>
}

const defaultTimers: SongTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class SongContentStore {
  private readonly cache = new Map<string, SongContent>()
  private readonly listeners = new Set<() => void>()
  private queue: Wanted[] = []
  private readonly inflight = new Set<string>()
  /** Songs whose download gave up (404 or SONG_MAX_ATTEMPTS failures) for their current etag. */
  private readonly failed = new Set<string>()
  private retryHandle: unknown = null
  private baseUrl: string | null = null
  private version = 0

  constructor(
    private readonly fetchFn: SongFetch | null = defaultFetch(),
    private readonly timers: SongTimers = defaultTimers,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Changes on every content update (useSyncExternalStore snapshot). */
  getVersion = (): number => this.version

  get(songId: string | null | undefined): SongContent | null {
    return songId ? this.cache.get(songId) ?? null : null
  }

  /** True when the download of this song gave up; a new content_etag tries again. */
  hasFailed(songId: string | null | undefined): boolean {
    return songId ? this.failed.has(songId) : false
  }

  private notify(): void {
    this.version += 1
    this.listeners.forEach((fn) => fn())
  }

  /**
   * Called on every state change. `baseUrl` is the leader's http origin
   * (`http://<ip>:<port>`); null keeps what is cached and fetches nothing.
   */
  sync(baseUrl: string | null, setlist: readonly SetlistEntry[], currentSongId: string | null = null): void {
    if (baseUrl !== this.baseUrl) {
      this.baseUrl = baseUrl
      this.queue = []
    }
    if (!baseUrl || !this.fetchFn) return
    const ordered = [...setlist].sort((a, b) => {
      if (a.songId === currentSongId) return -1
      if (b.songId === currentSongId) return 1
      return a.orderIndex - b.orderIndex
    })
    const queued = new Map(this.queue.map((w) => [w.songId, w]))
    const next: Wanted[] = []
    for (const entry of ordered) {
      const etag = entry.contentEtag
      if (!etag || this.cache.get(entry.songId)?.contentEtag === etag) continue
      const prev = queued.get(entry.songId)
      if (prev && prev.etag === etag) {
        next.push(prev)
        continue
      }
      if (this.failed.delete(entry.songId)) this.notify()
      next.push({ songId: entry.songId, etag, attempts: 0, backoff: false })
    }
    this.queue = next
    this.pump()
  }

  private pump(): void {
    const baseUrl = this.baseUrl
    const fetchFn = this.fetchFn
    if (!baseUrl || !fetchFn) return
    for (const wanted of this.queue) {
      if (this.inflight.size >= CONCURRENCY) return
      if (this.inflight.has(wanted.songId) || wanted.backoff || wanted.attempts >= SONG_MAX_ATTEMPTS) continue
      this.inflight.add(wanted.songId)
      wanted.attempts += 1
      void this.fetchOne(fetchFn, baseUrl, wanted).finally(() => {
        this.inflight.delete(wanted.songId)
        this.pump()
      })
    }
  }

  private async fetchOne(fetchFn: SongFetch, baseUrl: string, wanted: Wanted): Promise<void> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = this.timers.setTimeout(() => controller?.abort(), SONG_FETCH_TIMEOUT_MS)
    let content: SongContent | null = null
    try {
      const res = await fetchFn(songContentUrl(baseUrl, wanted.songId), {
        cache: 'no-cache',
        ...(controller ? { signal: controller.signal } : {}),
      })
      if (res.ok) {
        const decoded = decodeSongContent(await res.json())
        if (decoded.ok && decoded.value.songId === wanted.songId) content = decoded.value
      } else if (res.status === 404) {
        wanted.attempts = SONG_MAX_ATTEMPTS // not in the leader's setlist any more
      }
    } catch {
      // network error or timeout: retried below
    } finally {
      this.timers.clearTimeout(timer)
    }
    if (baseUrl !== this.baseUrl) return
    if (content) {
      this.cache.set(content.songId, content)
      this.failed.delete(content.songId)
      this.queue = this.queue.filter((w) => w !== wanted)
      this.notify()
      return
    }
    if (wanted.attempts >= SONG_MAX_ATTEMPTS) {
      this.failed.add(wanted.songId)
      this.notify()
      return
    }
    wanted.backoff = true
    if (this.retryHandle === null) {
      this.retryHandle = this.timers.setTimeout(() => {
        this.retryHandle = null
        this.queue.forEach((w) => (w.backoff = false))
        this.pump()
      }, SONG_RETRY_MS)
    }
  }
}

/** Index of the section that contains `bar` (1-based song bar). Before bar 1 (count-in, stopped): 0. Past the end: the last one. */
export function sectionIndexAt(sections: readonly SongSection[], bar: number | null): number {
  if (sections.length === 0) return -1
  if (bar === null || bar < sections[0].startBar) return 0
  let index = 0
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].startBar <= bar) index = i
    else break
  }
  return index
}

export const songContentStore = new SongContentStore()
