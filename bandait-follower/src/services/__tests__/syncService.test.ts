import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fixtures from '../../../../bandait-protocol/fixtures/v3_messages.json'
import {
  COMMAND_ACK_TIMEOUT_MS,
  CommandError,
  RECONNECT_DELAY_MAX_MS,
  SYNC_STEADY_INTERVAL_MS,
  SessionParams,
  SocketOptions,
  SyncService,
} from '../syncService'
import { ClockEstimate } from '../clockSync'
import { isUuid } from '../identity'
import { AckFn, FakeSocket } from './fakes'

type Json = Record<string, unknown>

const OFFSET_MS = 100_000_000 // leader clock = local clock + 1e8 ms
const CLIENT_ID = '6f1c2a9e-3b7d-4c11-9a52-0d8e4f7b1c23'
const PARAMS: SessionParams = {
  url: 'http://192.168.1.10:4040',
  sessionId: 'default',
  clientId: CLIENT_ID,
  role: 'director',
  alias: 'Bajo',
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function statePlaying(version = 42): Json {
  return { ...clone(fixtures.state_playing), state_version: version }
}

interface LeaderOptions {
  rttMs?: () => number
  /** Extra one-way asymmetry noise added to the leader timestamp (ms). */
  noiseMs?: () => number
  onCommand?: (payload: Json, ack: AckFn | undefined, attempt: number) => void
  fullState?: () => Json
}

/** Minimal fake leader answering join/sync/commands per contract v3. */
function attachLeader(socket: FakeSocket, opts: LeaderOptions = {}) {
  const rtt = opts.rttMs ?? (() => 4)
  const noise = opts.noiseMs ?? (() => 0)
  const attempts = new Map<string, number>()
  socket.responder = (event, payload, ack) => {
    const p = payload as Json
    if (event === 'join_session') {
      ack?.({ status: 'joined', session_id: p.session_id, protocol_version: 3, leader_time_ns: Date.now() * 1e6 })
      socket.fire('full_state', opts.fullState ? opts.fullState() : clone(fixtures.state_idle))
    } else if (event === 'sync_request') {
      const r = rtt()
      const sendMs = p.client_send_ms as number
      const leaderNs = Math.round((sendMs + r / 2 + OFFSET_MS + noise()) * 1e6)
      setTimeout(() => ack?.({ client_send_ms: sendMs, leader_time_ns: leaderNs }), r)
    } else if (event === 'control_command') {
      const id = p.command_id as string
      const n = (attempts.get(id) ?? 0) + 1
      attempts.set(id, n)
      opts.onCommand?.(p, ack, n)
    }
  }
}

function ackFor(payload: Json, overrides: Json = {}): Json {
  return {
    ...clone(fixtures.command_ack_accepted),
    command_id: payload.command_id,
    state: statePlaying(43),
    ...overrides,
  }
}

let sockets: FakeSocket[]
let factoryOptions: SocketOptions[]
let sync: SyncService
let estimates: ClockEstimate[]

function lastSocket(): FakeSocket {
  return sockets[sockets.length - 1]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  sockets = []
  factoryOptions = []
  estimates = []
  sync = new SyncService({
    now: () => Date.now(),
    socketFactory: (_url, options) => {
      factoryOptions.push(options)
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
  })
  sync.setListener({ onClock: (e) => estimates.push(e) })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  sync.disconnect()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SyncService: join and transport options', () => {
  it('sends join_session per contract on every (re)connect', async () => {
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s)
    s.serverConnect()
    s.drop()
    s.serverConnect()
    const joins = s.emitsOf('join_session')
    expect(joins).toHaveLength(2)
    expect(joins[0].payload).toEqual({
      session_id: 'default',
      client_id: CLIENT_ID,
      role: 'director',
      alias: 'Bajo',
      protocol_version: 3,
    })
    expect(sync.getConnectionInfo().joined).toBe(true)
  })

  it('reconnects forever with backoff capped at 5 s', async () => {
    sync.connect(PARAMS)
    expect(factoryOptions[0].reconnection).toBe(true)
    expect(factoryOptions[0].reconnectionAttempts).toBe(Infinity)
    expect(factoryOptions[0].reconnectionDelayMax).toBeLessThanOrEqual(5000)
    expect(factoryOptions[0].transports).toEqual(['websocket'])
  })

  it('reconnects by hand when socket.io gives up (io server disconnect)', async () => {
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s)
    s.serverConnect()
    s.active = false
    s.drop('io server disconnect')
    for (let i = 1; i <= 15; i++) {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MAX_MS)
      expect(s.connectCalls).toBe(i)
      s.fire('connect_error', new Error('ECONNREFUSED'))
    }
    s.serverConnect()
    expect(sync.isConnected()).toBe(true)
  })

  it('does not listen to the legacy "command" event', async () => {
    sync.connect(PARAMS)
    expect(lastSocket().handlers.has('command')).toBe(false)
    expect(lastSocket().handlers.has('state_update')).toBe(true)
    expect(lastSocket().handlers.has('beat_beacon')).toBe(true)
  })
})

describe('SyncService: clock sync', () => {
  it('computes offset and jitter from the minimum-delay samples, RTT from the window', async () => {
    // Every other request is queued (RTT 40 ms) with a +-15 ms asymmetric bias.
    let n = 0
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s, {
      rttMs: () => {
        n += 1
        return n % 2 === 0 ? 40 : 4
      },
      noiseMs: () => (n % 2 === 0 ? (n % 4 === 0 ? 15 : -15) : 0),
    })
    s.serverConnect()
    await vi.advanceTimersByTimeAsync(1500)
    const est = sync.getClockEstimate() as ClockEstimate
    expect(est.sampleCount).toBe(8)
    expect(est.filteredCount).toBe(3)
    expect(est.rttMs).toBeCloseTo(22, 6) // median of 4 x 4 ms and 4 x 40 ms
    expect(Math.abs(est.offsetMs - OFFSET_MS)).toBeLessThan(1e-3) // queued samples ignored
    expect(est.jitterMs).toBeLessThan(1e-3)
    expect(sync.localToLeaderMs(1000)).toBeCloseTo(1000 + est.offsetMs, 6)
    const req = s.emitsOf('sync_request')[0].payload as Json
    expect(Object.keys(req)).toEqual(['client_send_ms'])
  })

  it('treats a large constant offset as zero jitter', async () => {
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s, { rttMs: () => 6 })
    s.serverConnect()
    await vi.advanceTimersByTimeAsync(1500)
    const est = sync.getClockEstimate() as ClockEstimate
    expect(est.offsetMs).toBeCloseTo(OFFSET_MS, 6)
    expect(est.jitterMs).toBeCloseTo(0, 6)
  })

  it('ignores an ack whose client_send_ms is not the echo of the request', async () => {
    sync.connect(PARAMS)
    const s = lastSocket()
    s.responder = (event, payload, ack) => {
      if (event === 'sync_request') {
        const p = payload as Json
        ack?.({ client_send_ms: (p.client_send_ms as number) + 7, leader_time_ns: 1e14 })
      }
    }
    s.serverConnect()
    await vi.advanceTimersByTimeAsync(1500)
    expect(sync.getClockEstimate()).toBeNull()
  })

  it('runs exactly one sync loop after several reconnects, and none while down', async () => {
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s)
    for (let i = 0; i < 6; i++) {
      s.serverConnect()
      await vi.advanceTimersByTimeAsync(300)
      s.drop()
      await vi.advanceTimersByTimeAsync(200)
    }
    const whileDown = s.emitsOf('sync_request').length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.emitsOf('sync_request').length).toBe(whileDown)

    s.serverConnect()
    await vi.advanceTimersByTimeAsync(5000) // burst finished
    const from = Date.now()
    await vi.advanceTimersByTimeAsync(10_000)
    const steady = s.emitsOf('sync_request').filter((e) => e.at > from)
    expect(steady).toHaveLength(10_000 / SYNC_STEADY_INTERVAL_MS)
    // One pending sync timer (plus at most one in-flight ack timeout).
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2)
  })

  it('starts a fresh sample window on reconnect (phase needs NEW samples)', async () => {
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s)
    s.serverConnect()
    await vi.advanceTimersByTimeAsync(1500)
    expect(sync.getClockEstimate()?.sampleCount).toBe(8)
    s.drop()
    expect(sync.getClockEstimate()?.sampleCount).toBe(8) // kept while flywheeling
    s.serverConnect()
    expect(sync.getClockEstimate()).toBeNull()
    await vi.advanceTimersByTimeAsync(400)
    expect(sync.getClockEstimate()?.sampleCount).toBe(3)
  })
})

describe('SyncService: commands', () => {
  function connected(opts: LeaderOptions = {}): FakeSocket {
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s, { fullState: () => statePlaying(42), ...opts })
    s.serverConnect()
    return s
  }

  it('sends a UUID command_id, no client timestamp, and resolves with the ack', async () => {
    const s = connected({ onCommand: (p, ack) => ack?.(ackFor(p)) })
    const ack = await sync.sendCommand('PLAY')
    expect(ack.accepted).toBe(true)
    const sent = s.emitsOf('control_command')[0].payload as Json
    expect(isUuid(sent.command_id as string)).toBe(true)
    expect(sent).toMatchObject({ session_id: 'default', type: 'PLAY', origin: 'director_mobile', sender_id: CLIENT_ID })
    expect(JSON.stringify(sent)).not.toMatch(/timestamp|Ns"|_ns"/i)
    expect(sync.getState()?.stateVersion).toBe(43) // ack state applied through the version gate
  })

  it('adds expected_song_id to CUE_NEXT / CUE_PREV from the current state', async () => {
    const s = connected({ onCommand: (p, ack) => ack?.(ackFor(p)) })
    await sync.sendCommand('CUE_NEXT')
    expect((s.emitsOf('control_command')[0].payload as Json).payload).toEqual({ expected_song_id: 'song_01' })
  })

  it('surfaces a rejected ack with its reason', async () => {
    connected({
      onCommand: (p, ack) => ack?.(ackFor(p, { accepted: false, reason: 'conflict', action_taken: 'none' })),
    })
    const ack = await sync.sendCommand('CUE_PREV')
    expect(ack.accepted).toBe(false)
    expect(ack.reason).toBe('conflict')
  })

  it('retries once after 2 s with the SAME command_id', async () => {
    const s = connected({
      onCommand: (p, ack, attempt) => {
        if (attempt === 2) ack?.(ackFor(p, { duplicate: true }))
      },
    })
    const pending = sync.sendCommand('STOP')
    await vi.advanceTimersByTimeAsync(COMMAND_ACK_TIMEOUT_MS + 10)
    const ack = await pending
    expect(ack.duplicate).toBe(true)
    const sent = s.emitsOf('control_command')
    expect(sent).toHaveLength(2)
    expect((sent[0].payload as Json).command_id).toBe((sent[1].payload as Json).command_id)
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(COMMAND_ACK_TIMEOUT_MS)
  })

  it('rejects with "timeout" after the retry also goes unanswered', async () => {
    const s = connected({ onCommand: () => undefined })
    const pending = sync.sendCommand('PLAY')
    const settled = pending.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2 * COMMAND_ACK_TIMEOUT_MS + 50)
    const err = await settled
    expect(err).toBeInstanceOf(CommandError)
    expect((err as CommandError).reason).toBe('timeout')
    expect(s.emitsOf('control_command')).toHaveLength(2)
  })

  it('rejects immediately when offline and never queues the command', async () => {
    await expect(sync.sendCommand('PLAY')).rejects.toMatchObject({ reason: 'offline' })
    sync.connect(PARAMS)
    const s = lastSocket()
    await expect(sync.sendCommand('PLAY')).rejects.toMatchObject({ reason: 'offline' })
    attachLeader(s)
    s.serverConnect()
    s.drop()
    await expect(sync.sendCommand('PANIC')).rejects.toMatchObject({ reason: 'offline' })
    s.serverConnect()
    expect(s.emitsOf('control_command')).toHaveLength(0)
  })

  it('rejects with "connection_lost" when the link drops before the ack', async () => {
    const s = connected({ onCommand: () => undefined })
    const pending = sync.sendCommand('PLAY').catch((e: unknown) => e)
    s.drop()
    const err = await pending
    expect((err as CommandError).reason).toBe('connection_lost')
  })

  it('rejects an ack that does not match the command', async () => {
    connected({ onCommand: (p, ack) => ack?.({ ...ackFor(p), command_id: 'otro' }) })
    await expect(sync.sendCommand('PLAY')).rejects.toMatchObject({ reason: 'invalid_ack' })
  })
})

describe('SyncService: inbound state', () => {
  it('applies state_update only if newer; full_state always (leader restart)', async () => {
    const versions: number[] = []
    sync.setListener({ onState: (st) => versions.push(st.stateVersion) })
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s, { fullState: () => statePlaying(42) })
    s.serverConnect()
    s.fire('state_update', statePlaying(41))
    s.fire('state_update', statePlaying(42))
    s.fire('state_update', statePlaying(44))
    s.drop()
    attachLeader(s, { fullState: () => statePlaying(2) }) // restarted leader
    s.serverConnect()
    expect(versions).toEqual([42, 44, 2])
  })

  it('restarts version tracking when leader_instance_id changes (leader restarted)', async () => {
    const versions: number[] = []
    sync.setListener({ onState: (st) => versions.push(st.stateVersion) })
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s, { fullState: () => statePlaying(42) })
    s.serverConnect()
    const restarted = { ...statePlaying(3), leader_instance_id: '9d0c1b2a-0000-4000-8000-00000000abcd' }
    s.fire('state_update', restarted) // lower version, new instance: accepted
    s.fire('state_update', { ...restarted, state_version: 2 }) // same new instance, older: ignored
    s.fire('state_update', { ...restarted, state_version: 4 })
    expect(versions).toEqual([42, 3, 4])
    expect(sync.getState()?.leaderInstanceId).toBe('9d0c1b2a-0000-4000-8000-00000000abcd')
  })

  it('ignores malformed payloads without crashing and reports them', async () => {
    const errors: string[] = []
    const states: number[] = []
    sync.setListener({ onProtocolError: (m) => errors.push(m), onState: (st) => states.push(st.stateVersion) })
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s)
    s.serverConnect()
    expect(() => {
      s.fire('state_update', { sessionId: 'default', currentSongId: 'x' })
      s.fire('state_update', null)
      s.fire('beat_beacon', 'garbage')
      s.fire('setlist_jump', { song_id: 1 })
    }).not.toThrow()
    expect(errors.length).toBeGreaterThanOrEqual(4)
    expect(states).toEqual([1]) // only the valid full_state (state_idle)
  })

  it('gates beat_beacon by state_version', async () => {
    const beacons: number[] = []
    sync.setListener({ onBeacon: (b) => beacons.push(b.stateVersion) })
    sync.connect(PARAMS)
    const s = lastSocket()
    attachLeader(s, { fullState: () => statePlaying(42) })
    s.serverConnect()
    s.fire('beat_beacon', { ...clone(fixtures.beat_beacon), state_version: 41 }) // stale
    s.fire('beat_beacon', clone(fixtures.beat_beacon)) // current
    s.fire('state_update', { ...clone(fixtures.state_idle), state_version: 50 })
    s.fire('beat_beacon', { ...clone(fixtures.beat_beacon), state_version: 50 }) // same version but IDLE
    s.fire('beat_beacon', { ...clone(fixtures.beat_beacon), state_version: 51 }) // newer: missed update
    expect(beacons).toEqual([42, 51])
    expect(sync.getState()?.status).toBe('PLAYING')
    expect(sync.getState()?.stateVersion).toBe(51)
  })
})
