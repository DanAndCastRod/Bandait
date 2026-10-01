import { describe, it, expect } from 'vitest'
import { ScreenWakeLock, VisibilityDocument, WakeLockApi, WakeLockSentinelLike, selectWakeStrategy } from '../wakeLock'

class FakeSentinel implements WakeLockSentinelLike {
  released = false
  releaseCalls = 0
  private readonly handlers: Array<() => void> = []

  release(): Promise<void> {
    this.releaseCalls += 1
    this.released = true
    return Promise.resolve()
  }

  addEventListener(_type: 'release', listener: () => void) {
    this.handlers.push(listener)
  }

  /** The browser drops the lock (page hidden, tab switched). */
  systemRelease() {
    this.released = true
    for (const h of this.handlers) h()
  }
}

class FakeWakeLock implements WakeLockApi {
  readonly sentinels: FakeSentinel[] = []
  mode: 'ok' | 'reject' | 'throw' = 'ok'
  private deferred: Array<() => void> = []
  /** When true, request() stays pending until resolvePending(). */
  manual = false

  request(): Promise<FakeSentinel> {
    if (this.mode === 'throw') throw new TypeError('wakeLock.request no disponible')
    if (this.mode === 'reject') return Promise.reject(new Error('NotAllowedError'))
    const s = new FakeSentinel()
    this.sentinels.push(s)
    if (this.manual) return new Promise((resolve) => this.deferred.push(() => resolve(s)))
    return Promise.resolve(s)
  }

  resolvePending() {
    for (const r of this.deferred.splice(0)) r()
  }
}

class FakeDocument implements VisibilityDocument {
  visibilityState = 'visible'
  private listeners: Array<() => void> = []

  addEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners.push(listener)
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners = this.listeners.filter((l) => l !== listener)
  }

  setVisibility(state: 'visible' | 'hidden') {
    this.visibilityState = state
    for (const l of [...this.listeners]) l()
  }

  get listenerCount() {
    return this.listeners.length
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('ScreenWakeLock', () => {
  it('reports unsupported and never throws when the API is missing', () => {
    const lock = new ScreenWakeLock({ getApi: () => null, getDocument: () => new FakeDocument() })
    expect(lock.isSupported()).toBe(false)
    expect(() => {
      lock.enable()
      lock.disable()
    }).not.toThrow()
    expect(lock.getStatus()).toBe('unsupported')
  })

  it('acquires on enable, re-acquires when the page becomes visible again, releases on disable', async () => {
    const api = new FakeWakeLock()
    const doc = new FakeDocument()
    const lock = new ScreenWakeLock({ getApi: () => api, getDocument: () => doc })
    expect(lock.getStatus()).toBe('idle')

    lock.enable()
    await flush()
    expect(api.sentinels).toHaveLength(1)
    expect(lock.getStatus()).toBe('active')

    // Phone screen off / app switch: the browser releases the lock.
    doc.setVisibility('hidden')
    api.sentinels[0].systemRelease()
    expect(lock.getStatus()).toBe('released')
    expect(api.sentinels).toHaveLength(1) // no request while hidden

    doc.setVisibility('visible')
    await flush()
    expect(api.sentinels).toHaveLength(2)
    expect(lock.getStatus()).toBe('active')

    lock.disable() // SALIR
    expect(api.sentinels[1].releaseCalls).toBe(1)
    expect(doc.listenerCount).toBe(0)
    expect(lock.getStatus()).toBe('idle')
    doc.setVisibility('hidden')
    doc.setVisibility('visible')
    await flush()
    expect(api.sentinels).toHaveLength(2) // nothing after SALIR
  })

  it('does not request while hidden and waits for visibility', async () => {
    const api = new FakeWakeLock()
    const doc = new FakeDocument()
    doc.visibilityState = 'hidden'
    const lock = new ScreenWakeLock({ getApi: () => api, getDocument: () => doc })
    lock.enable()
    await flush()
    expect(api.sentinels).toHaveLength(0)
    doc.setVisibility('visible')
    await flush()
    expect(lock.getStatus()).toBe('active')
  })

  it('turns rejections and synchronous throws into status "error"', async () => {
    const api = new FakeWakeLock()
    const lock = new ScreenWakeLock({ getApi: () => api, getDocument: () => new FakeDocument() })
    api.mode = 'reject'
    expect(() => lock.enable()).not.toThrow()
    await flush()
    expect(lock.getStatus()).toBe('error')

    const lock2 = new ScreenWakeLock({ getApi: () => api, getDocument: () => new FakeDocument() })
    api.mode = 'throw'
    expect(() => lock2.enable()).not.toThrow()
    expect(lock2.getStatus()).toBe('error')
  })

  it('releases a lock that arrives after SALIR', async () => {
    const api = new FakeWakeLock()
    api.manual = true
    const lock = new ScreenWakeLock({ getApi: () => api, getDocument: () => new FakeDocument() })
    lock.enable()
    lock.disable() // SALIR while the request is still in flight
    api.resolvePending()
    await flush()
    expect(api.sentinels).toHaveLength(1)
    expect(api.sentinels[0].releaseCalls).toBe(1)
    expect(lock.getStatus()).toBe('idle')
  })

  it('notifies listeners on status changes', async () => {
    const api = new FakeWakeLock()
    const lock = new ScreenWakeLock({ getApi: () => api, getDocument: () => new FakeDocument() })
    const seen: string[] = []
    lock.onChange(() => seen.push(lock.getStatus()))
    lock.enable()
    await flush()
    lock.disable()
    expect(seen).toEqual(['active', 'idle'])
  })
})

class FakeVideo {
  plays = 0
  pauses = 0
  refuse = false
  play(): Promise<void> {
    this.plays += 1
    return this.refuse ? Promise.reject(new Error('NotAllowedError: autoplay')) : Promise.resolve()
  }
  pause() {
    this.pauses += 1
  }
}

describe('ScreenWakeLock: fallback video (insecure context, contract section 8)', () => {
  it('selectWakeStrategy: API first, video when the API is missing or refused, else none', () => {
    expect(selectWakeStrategy({ hasWakeLockApi: true, apiRefused: false, canUseVideo: true })).toBe('api')
    expect(selectWakeStrategy({ hasWakeLockApi: true, apiRefused: true, canUseVideo: true })).toBe('video')
    expect(selectWakeStrategy({ hasWakeLockApi: false, apiRefused: false, canUseVideo: true })).toBe('video')
    expect(selectWakeStrategy({ hasWakeLockApi: false, apiRefused: false, canUseVideo: false })).toBe('none')
  })

  it('API available: mode API and the fallback video is never created', async () => {
    let created = 0
    const lock = new ScreenWakeLock({
      getApi: () => new FakeWakeLock(),
      getDocument: () => new FakeDocument(),
      createVideo: () => {
        created += 1
        return new FakeVideo()
      },
    })
    lock.enable()
    await flush()
    expect(lock.getMode()).toBe('API')
    expect(lock.getStatus()).toBe('active')
    expect(created).toBe(0)
  })

  it('no Wake Lock API (plain HTTP): plays the muted video on enable, mode VIDEO, paused on SALIR', async () => {
    const video = new FakeVideo()
    const lock = new ScreenWakeLock({ getApi: () => null, getDocument: () => new FakeDocument(), createVideo: () => video })
    expect(lock.getMode()).toBe('VIDEO')
    lock.enable()
    await flush()
    expect(video.plays).toBe(1)
    expect(lock.getStatus()).toBe('active')
    expect(lock.getMode()).toBe('VIDEO')
    lock.disable()
    expect(video.pauses).toBe(1)
    expect(lock.getStatus()).toBe('idle')
  })

  it('video refused without a gesture: NO DISPONIBLE, then a later tap (enable) recovers', async () => {
    const video = new FakeVideo()
    video.refuse = true
    const lock = new ScreenWakeLock({ getApi: () => null, getDocument: () => new FakeDocument(), createVideo: () => video })
    lock.enable()
    await flush()
    expect(lock.getMode()).toBe('NO DISPONIBLE')
    expect(lock.getStatus()).toBe('error')
    video.refuse = false
    lock.enable() // ACTIVAR AUDIO tap
    await flush()
    expect(lock.getMode()).toBe('VIDEO')
    expect(lock.getStatus()).toBe('active')
  })

  it('API refuses the lock: falls back to the video', async () => {
    const api = new FakeWakeLock()
    api.mode = 'reject'
    const video = new FakeVideo()
    const lock = new ScreenWakeLock({ getApi: () => api, getDocument: () => new FakeDocument(), createVideo: () => video })
    expect(lock.getMode()).toBe('API')
    lock.enable()
    await flush()
    expect(video.plays).toBe(1)
    expect(lock.getMode()).toBe('VIDEO')
    expect(lock.getStatus()).toBe('active')
  })

  it('resumes the video when the page becomes visible again', async () => {
    const video = new FakeVideo()
    const doc = new FakeDocument()
    const lock = new ScreenWakeLock({ getApi: () => null, getDocument: () => doc, createVideo: () => video })
    lock.enable()
    await flush()
    doc.setVisibility('hidden')
    doc.setVisibility('visible')
    await flush()
    expect(video.plays).toBe(2)
  })

  it('nothing available: NO DISPONIBLE and status unsupported, without throwing', () => {
    const lock = new ScreenWakeLock({ getApi: () => null, getDocument: () => new FakeDocument(), createVideo: () => null })
    expect(() => lock.enable()).not.toThrow()
    expect(lock.getMode()).toBe('NO DISPONIBLE')
    expect(lock.getStatus()).toBe('unsupported')
    expect(lock.isSupported()).toBe(false)
  })
})
