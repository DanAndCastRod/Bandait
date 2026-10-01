import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fixtures from '../../../../bandait-protocol/fixtures/v3_messages.json'
import { SyncService } from '../syncService'
import { FlywheelClock } from '../flywheelClock'
import { SessionController } from '../sessionController'
import { ScreenWakeLock, WakeLockApi, WakeLockSentinelLike } from '../wakeLock'
import { FakeAudioContext, FakeSocket } from './fakes'

type Json = Record<string, unknown>

const OFFSET_MS = 200_000_000

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

let socket: FakeSocket
let sync: SyncService
let clock: FlywheelClock
let controller: SessionController
let ctx: FakeAudioContext | null
let fullState: () => Json
let wakeRequests: number
let wakeReleases: number

/** A PLAYING state whose anchor (leader clock) is 250 ms after the given local time. */
function playingAt(localMs: number, version = 10, overrides: Json = {}): Json {
  return {
    ...clone(fixtures.state_playing),
    state_version: version,
    anchor_ns: Math.round((localMs + 250 + OFFSET_MS) * 1e6),
    leader_time_ns: Math.round((localMs + OFFSET_MS) * 1e6),
    ...overrides,
  }
}

function attachLeader(s: FakeSocket) {
  s.responder = (event, payload, ack) => {
    const p = payload as Json
    if (event === 'join_session') {
      ack?.({ status: 'joined', session_id: p.session_id, protocol_version: 3, leader_time_ns: 1 })
      s.fire('full_state', fullState())
    } else if (event === 'sync_request') {
      const sendMs = p.client_send_ms as number
      setTimeout(() => ack?.({ client_send_ms: sendMs, leader_time_ns: Math.round((sendMs + 2 + OFFSET_MS) * 1e6) }), 4)
    } else if (event === 'control_command') {
      ack?.({
        ...clone(fixtures.command_ack_accepted),
        command_id: p.command_id,
        action_taken: p.type,
        state: {
          ...clone(fixtures.state_idle),
          state_version: 30,
          last_command: { command_id: p.command_id, type: p.type, origin: 'director_mobile' },
        },
      })
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  ctx = null
  sync = new SyncService({
    now: () => Date.now(),
    socketFactory: () => {
      socket = new FakeSocket()
      attachLeader(socket)
      return socket
    },
  })
  clock = new FlywheelClock({
    now: () => Date.now(),
    createAudioContext: () => {
      ctx = new FakeAudioContext(() => Date.now())
      return ctx
    },
  })
  wakeRequests = 0
  wakeReleases = 0
  const wakeApi: WakeLockApi = {
    request: () => {
      wakeRequests += 1
      const sentinel: WakeLockSentinelLike = {
        released: false,
        release: () => {
          wakeReleases += 1
          return Promise.resolve()
        },
      }
      return Promise.resolve(sentinel)
    },
  }
  const wakeLock = new ScreenWakeLock({
    getApi: () => wakeApi,
    getDocument: () => ({ visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
  controller = new SessionController(sync, clock, wakeLock)
  fullState = () => clone(fixtures.state_idle)
})

afterEach(() => {
  controller.leave()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SessionController', () => {
  it('goes DEGRADED -> LOCKED as samples arrive, LOST after SALIR', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'musician', alias: 'Bajo' })
    expect(controller.getSnapshot().linkState).toBe('LOST')
    socket.serverConnect()
    expect(controller.getSnapshot().linkState).toBe('DEGRADED')
    await vi.advanceTimersByTimeAsync(500) // 4 samples
    expect(controller.getSnapshot().linkState).toBe('DEGRADED')
    await vi.advanceTimersByTimeAsync(1000)
    expect(controller.getSnapshot().clock?.sampleCount).toBe(8)
    expect(controller.getSnapshot().linkState).toBe('LOCKED')
    controller.leave()
    expect(controller.getSnapshot().linkState).toBe('LOST')
    expect(controller.getSnapshot().active).toBe(false)
  })

  it('keeps the beat grid through a Wi-Fi drop (FLYWHEEL) and reconnect', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'musician', alias: 'Bajo' })
    await clock.armAudio()
    const t0 = Date.now()
    fullState = () => playingAt(t0 + 600)
    socket.serverConnect()
    await vi.advanceTimersByTimeAsync(2000)
    expect(controller.getSnapshot().schedulerRunning).toBe(true)

    socket.drop()
    expect(controller.getSnapshot().linkState).toBe('FLYWHEEL')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(controller.getSnapshot().linkState).toBe('FLYWHEEL')

    socket.serverConnect() // leader still playing the same anchor
    await vi.advanceTimersByTimeAsync(5_000)
    expect(controller.getSnapshot().connected).toBe(true)

    const c = ctx as FakeAudioContext
    const times = c.liveClickTimes()
    expect(times.length).toBeGreaterThan(30)
    const anchorLocal = t0 + 600 + 250 // the fake leader is symmetric: offset is exactly OFFSET_MS
    times.forEach((t, i) => {
      if (i > 0) expect(t - times[i - 1]).toBeCloseTo(500, 3)
      const r = (((t - anchorLocal) % 500) + 500) % 500
      expect(Math.min(r, 500 - r)).toBeLessThan(0.01)
    })
    expect(c.oscillators.every((o) => !o.cancelled)).toBe(true)
  })

  it('remote PANIC silences local audio; STOP leaves the link up', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'director', alias: 'Dir' })
    await clock.armAudio()
    fullState = () => playingAt(Date.now() + 300)
    socket.serverConnect()
    await vi.advanceTimersByTimeAsync(1500)
    expect(clock.isRunning()).toBe(true)
    socket.fire('state_update', {
      ...clone(fixtures.state_idle),
      state_version: 20,
      last_command: { command_id: 'c0ffee00-0000-4000-8000-000000000001', type: 'PANIC', origin: 'laptop_foh' },
    })
    expect(clock.isRunning()).toBe(false)
    expect(clock.isRemoteMuted()).toBe(true)
    expect(controller.getSnapshot().linkState).not.toBe('LOST')
    // Next PLAY releases the remote mute.
    socket.fire('state_update', playingAt(Date.now(), 21))
    expect(clock.isRemoteMuted()).toBe(false)
  })

  it('a newer beat_beacon starts the schedule even if a state_update was missed', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'musician', alias: 'Bajo' })
    socket.serverConnect()
    await vi.advanceTimersByTimeAsync(1500)
    expect(clock.isRunning()).toBe(false)
    const now = Date.now()
    socket.fire('beat_beacon', {
      ...clone(fixtures.beat_beacon),
      state_version: 5,
      anchor_ns: Math.round((now + 300 + OFFSET_MS) * 1e6),
      leader_time_ns: Math.round((now + OFFSET_MS) * 1e6),
    })
    expect(clock.isRunning()).toBe(true)
    expect(controller.getSnapshot().state?.status).toBe('PLAYING')
    expect(controller.getSnapshot().schedulerRunning).toBe(true)
  })

  it('musician slide = SILENCIO LOCAL: nothing sent, band keeps playing, scheduled clicks cut', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'musician', alias: 'Bajo' })
    await clock.armAudio()
    fullState = () => playingAt(Date.now() + 300)
    socket.serverConnect()
    await vi.advanceTimersByTimeAsync(1500)
    const c = ctx as FakeAudioContext
    const scheduled = c.oscillators.filter((o) => !o.cancelled && (o.startTime ?? 0) > c.currentTime)
    expect(scheduled.length).toBeGreaterThan(0)

    const outcome = await controller.emergencyStop()
    expect(outcome.kind).toBe('local_mute')
    expect(socket.emitsOf('control_command')).toHaveLength(0)
    expect(clock.isLocallyMuted()).toBe(true)
    expect(controller.getSnapshot().localMuted).toBe(true)
    expect(scheduled.every((o) => o.cancelled)).toBe(true)
    expect(clock.isRunning()).toBe(true) // visual metronome keeps time

    const before = c.oscillators.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(c.oscillators.length).toBe(before) // no new audio while muted
    await clock.armAudio() // the deliberate tap
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.oscillators.length).toBeGreaterThan(before)
  })

  it('director slide = PANIC to the band plus local silence', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'director', alias: 'Dir' })
    socket.serverConnect()
    await vi.advanceTimersByTimeAsync(500)
    const outcome = await controller.emergencyStop()
    expect(outcome.kind).toBe('band_panic')
    const sent = socket.emitsOf('control_command')
    expect(sent).toHaveLength(1)
    expect((sent[0].payload as Json).type).toBe('PANIC')
    expect(clock.isLocallyMuted()).toBe(true)
  })

  it('director slide while offline still silences this device', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'director', alias: 'Dir' })
    await expect(controller.emergencyStop()).rejects.toMatchObject({ reason: 'offline' })
    expect(clock.isLocallyMuted()).toBe(true)
    expect(controller.getSnapshot().localMuted).toBe(true)
  })

  it('holds the screen wake lock while a session is active', async () => {
    controller.join({ url: 'http://10.0.0.2:4040', sessionId: 'default', role: 'musician', alias: 'Bajo' })
    await vi.advanceTimersByTimeAsync(0)
    expect(wakeRequests).toBe(1)
    expect(controller.getSnapshot().wakeLock).toBe('active')
    expect(controller.getSnapshot().wakeMode).toBe('API')
    controller.leave()
    expect(wakeReleases).toBe(1)
    expect(controller.getSnapshot().wakeLock).toBe('idle')
  })
})
