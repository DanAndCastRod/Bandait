/**
 * Keep the phone screen on while a session is active: a sleeping phone
 * suspends JavaScript and the metronome with it.
 *
 * Strategy (contract section 8):
 *   API   - Screen Wake Lock API (secure contexts: HTTPS or localhost).
 *           The browser drops the lock when the page is hidden, so it is
 *           re-acquired on visibilitychange.
 *   VIDEO - plain HTTP from the leader is an insecure context with no Wake
 *           Lock API: a muted, inline (playsinline), looping, tiny video keeps
 *           the screen awake. It is started inside the join tap. Also used if
 *           the API refuses the lock (battery saver, policy).
 *   NO DISPONIBLE - neither works: the stage shows "PANTALLA PUEDE APAGARSE".
 *
 * Feature-detected and never throws.
 */

import noSleepMedia from 'nosleep.js/src/media.js'

export type WakeLockStatus = 'unsupported' | 'idle' | 'active' | 'released' | 'error'
export type WakeMode = 'API' | 'VIDEO' | 'NO DISPONIBLE'
export type WakeStrategy = 'api' | 'video' | 'none'

export interface WakeLockSentinelLike {
  readonly released: boolean
  release(): Promise<void>
  addEventListener?(type: 'release', listener: () => void): void
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

export interface VisibilityDocument {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** The keep-awake video (a fake implements it in tests). */
export interface KeepAwakeVideo {
  play(): Promise<void>
  pause(): void
}

export interface WakeLockDeps {
  getApi?: () => WakeLockApi | null
  getDocument?: () => VisibilityDocument | null
  /** Returns null when this browser cannot play the fallback video. */
  createVideo?: () => KeepAwakeVideo | null
}

/** Pure strategy choice; the API wins unless it already refused the lock. */
export function selectWakeStrategy(input: { hasWakeLockApi: boolean; apiRefused: boolean; canUseVideo: boolean }): WakeStrategy {
  if (input.hasWakeLockApi && !input.apiRefused) return 'api'
  if (input.canUseVideo) return 'video'
  return 'none'
}

function defaultApi(): WakeLockApi | null {
  try {
    if (typeof navigator === 'undefined') return null
    const api = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock
    return api && typeof api.request === 'function' ? api : null
  } catch {
    return null
  }
}

function defaultDocument(): VisibilityDocument | null {
  return typeof document !== 'undefined' ? (document as unknown as VisibilityDocument) : null
}

/** Hidden 1 px muted inline looping video with the nosleep.js clips (WebM + MP4). */
export function createKeepAwakeVideo(): KeepAwakeVideo | null {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
    const el = document.createElement('video')
    if (typeof el.play !== 'function') return null
    const canWebm = typeof el.canPlayType === 'function' && el.canPlayType('video/webm') !== ''
    const canMp4 = typeof el.canPlayType === 'function' && el.canPlayType('video/mp4') !== ''
    if (!canWebm && !canMp4) return null
    el.muted = true
    el.defaultMuted = true
    el.loop = true
    el.setAttribute('muted', '')
    el.setAttribute('loop', '')
    el.setAttribute('playsinline', '')
    el.setAttribute('webkit-playsinline', '')
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute('tabindex', '-1')
    el.setAttribute('data-bandait-keepawake', '')
    Object.assign(el.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '1px',
      height: '1px',
      opacity: '0.01',
      pointerEvents: 'none',
      zIndex: '-1',
    })
    for (const [type, src] of [
      ['video/webm', noSleepMedia.webm],
      ['video/mp4', noSleepMedia.mp4],
    ] as const) {
      const source = document.createElement('source')
      source.type = type
      source.src = src
      el.appendChild(source)
    }
    return {
      play: () => {
        try {
          if (!el.isConnected) document.body?.appendChild(el)
          return Promise.resolve(el.play())
        } catch (err) {
          return Promise.reject(err)
        }
      },
      pause: () => {
        try {
          el.pause()
        } catch {
          // Ignore.
        }
      },
    }
  } catch {
    return null
  }
}

export class ScreenWakeLock {
  private readonly getApi: () => WakeLockApi | null
  private readonly getDocument: () => VisibilityDocument | null
  private readonly createVideo: () => KeepAwakeVideo | null
  private wanted = false
  private sentinel: WakeLockSentinelLike | null = null
  private pending: Promise<void> | null = null
  private apiRefused = false
  private video: KeepAwakeVideo | null | undefined = undefined // undefined: not created yet
  private videoFailed = false
  private status: WakeLockStatus
  private listening = false
  private readonly listeners = new Set<() => void>()
  private readonly onVisibility = () => {
    if (this.wanted && this.isVisible()) this.engage()
  }

  constructor(deps: WakeLockDeps = {}) {
    this.getApi = deps.getApi ?? defaultApi
    this.getDocument = deps.getDocument ?? defaultDocument
    this.createVideo = deps.createVideo ?? createKeepAwakeVideo
    // Lazy: no video element is created until the first enable() (the join tap).
    this.status = 'idle'
  }

  isSupported(): boolean {
    return this.strategy() !== 'none'
  }

  getStatus(): WakeLockStatus {
    return this.status
  }

  /** What keeps (or would keep) the screen on: API / VIDEO / NO DISPONIBLE. */
  getMode(): WakeMode {
    const strategy = this.strategy()
    if (strategy === 'api') return 'API'
    if (strategy === 'video') return this.videoFailed ? 'NO DISPONIBLE' : 'VIDEO'
    return 'NO DISPONIBLE'
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Session active: keep the screen on, now and after every return to the
   * page. Call it inside a user gesture (the join tap) so the video fallback
   * may start on iOS; calling it again (e.g. on ACTIVAR AUDIO) retries.
   */
  enable(): void {
    this.wanted = true
    if (!this.listening) {
      try {
        this.getDocument()?.addEventListener('visibilitychange', this.onVisibility)
        this.listening = true
      } catch {
        // Without the listener the lock is simply not re-acquired.
      }
    }
    this.engage()
  }

  /** SALIR: let the screen sleep again. */
  disable(): void {
    this.wanted = false
    if (this.listening) {
      try {
        this.getDocument()?.removeEventListener('visibilitychange', this.onVisibility)
      } catch {
        // Ignore.
      }
      this.listening = false
    }
    const sentinel = this.sentinel
    this.sentinel = null
    if (sentinel && !sentinel.released) {
      try {
        sentinel.release().catch(() => undefined)
      } catch {
        // Ignore.
      }
    }
    if (this.video) this.video.pause()
    this.setStatus(this.strategy() === 'none' ? 'unsupported' : 'idle')
  }

  // ---------------------------------------------------------------- internals

  private strategy(): WakeStrategy {
    const hasWakeLockApi = this.safeApi() !== null
    // The API path never creates the fallback video element.
    if (hasWakeLockApi && !this.apiRefused) return 'api'
    return selectWakeStrategy({ hasWakeLockApi, apiRefused: this.apiRefused, canUseVideo: this.getVideo() !== null })
  }

  private getVideo(): KeepAwakeVideo | null {
    if (this.video === undefined) {
      try {
        this.video = this.createVideo()
      } catch {
        this.video = null
      }
    }
    return this.video
  }

  private engage(): void {
    const strategy = this.strategy()
    if (strategy === 'api') this.acquire()
    else if (strategy === 'video') this.startVideo()
    else this.setStatus('unsupported')
  }

  private safeApi(): WakeLockApi | null {
    try {
      return this.getApi()
    } catch {
      return null
    }
  }

  private isVisible(): boolean {
    try {
      const doc = this.getDocument()
      return !doc || doc.visibilityState === 'visible'
    } catch {
      return true
    }
  }

  private acquire(): void {
    const api = this.safeApi()
    if (!this.wanted || !api || this.pending) return
    if (this.sentinel && !this.sentinel.released) return
    // The browser rejects requests from a hidden page; visibilitychange retries.
    if (!this.isVisible()) return
    let request: Promise<WakeLockSentinelLike>
    try {
      request = Promise.resolve(api.request('screen'))
    } catch {
      this.refuseApi()
      return
    }
    this.pending = request
      .then((sentinel) => {
        if (!this.wanted) {
          // SALIR happened while the request was in flight.
          try {
            sentinel.release().catch(() => undefined)
          } catch {
            // Ignore.
          }
          return
        }
        this.sentinel = sentinel
        this.setStatus('active')
        try {
          sentinel.addEventListener?.('release', () => {
            if (this.sentinel === sentinel) {
              this.sentinel = null
              if (this.wanted) this.setStatus('released')
            }
          })
        } catch {
          // Without the event the next visibilitychange still re-acquires.
        }
      })
      .catch(() => {
        // NotAllowedError (battery saver, policy...): fall back to the video.
        if (this.wanted) this.refuseApi()
      })
      .finally(() => {
        this.pending = null
      })
  }

  private refuseApi(): void {
    this.apiRefused = true
    if (this.strategy() === 'video') this.startVideo()
    else this.setStatus('error')
  }

  private startVideo(): void {
    const video = this.getVideo()
    if (!this.wanted || !video) return
    // play() is idempotent; calling it again also resumes a video the browser
    // paused while the page was hidden.
    let playing: Promise<void>
    try {
      playing = video.play()
    } catch {
      playing = Promise.reject(new Error('play() lanzo'))
    }
    playing.then(
      () => {
        if (!this.wanted) {
          video.pause()
          return
        }
        this.videoFailed = false
        this.setStatus('active')
      },
      () => {
        // Autoplay refused without a gesture: retried on the next enable() tap.
        this.videoFailed = true
        this.setStatus('error')
      },
    )
  }

  private setStatus(next: WakeLockStatus): void {
    if (this.status === next) return
    this.status = next
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A UI listener must never break the session.
      }
    }
  }
}

export const screenWakeLock = new ScreenWakeLock()
