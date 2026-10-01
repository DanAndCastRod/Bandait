import { describe, it, expect } from 'vitest'
import fixtures from '../../../../bandait-protocol/fixtures/v3_messages.json'
import {
  decodeBeatBeacon,
  decodeCommandAck,
  decodeJoinAck,
  decodePeerEvent,
  decodeSessionState,
  decodeSetlistJump,
  decodeSyncAck,
  encodeControlCommand,
  encodeJoinSession,
  encodeSyncRequest,
} from '../wire'

type Json = Record<string, unknown>

/** Fixture convention: "<<name>>" means "the object `name` from the same file". */
function resolve(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = /^<<(\w+)>>$/.exec(value)
    if (m) return resolve((fixtures as unknown as Json)[m[1]])
    return value
  }
  if (Array.isArray(value)) return value.map(resolve)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, resolve(v)]))
  }
  return value
}

function fixture(name: keyof typeof fixtures): Json {
  return JSON.parse(JSON.stringify(resolve(fixtures[name]))) as Json
}

function expectOk<T>(res: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!res.ok) throw new Error(`se esperaba ok, error: ${res.error}`)
  return res.value
}

function expectRejected(res: { ok: boolean; error?: string }): string {
  expect(res.ok).toBe(false)
  return res.error ?? ''
}

describe('wire decode: canonical fixtures', () => {
  it('decodes state_playing into domain camelCase', () => {
    const s = expectOk(decodeSessionState(fixture('state_playing')))
    expect(s.protocolVersion).toBe(3)
    expect(s.leaderInstanceId).toBe('0b7e3f2a-5c19-4d8e-9a61-7f2c4b8d1e05')
    expect(s.sessionId).toBe('default')
    expect(s.status).toBe('PLAYING')
    expect(s.stateVersion).toBe(42)
    expect(s.currentSongId).toBe('song_01')
    expect(s.currentOrderIndex).toBe(0)
    expect(s.bpm).toBe(120)
    expect(s.beatsPerBar).toBe(4)
    expect(s.anchorNs).toBe(241953859000000)
    expect(s.barOffset).toBe(1)
    expect(s.pausedBar).toBeNull()
    expect(s.leaderTimeNs).toBe(241953609000000)
    expect(s.setlist).toHaveLength(3)
    expect(s.setlist[2]).toEqual({ songId: 'song_07', title: 'Septima', bpm: 140, orderIndex: 2, transitionMode: 'gapless' })
    expect(s.lastCommand).toEqual({
      commandId: '2b9f0c4e-8d1a-4f6b-b3c7-5e2a9d0f1a44',
      type: 'PLAY',
      origin: 'director_mobile',
    })
    // Contract rule 1: the anchor is at least 250 ms after the emission time.
    expect((s.anchorNs as number) - s.leaderTimeNs).toBeGreaterThanOrEqual(250e6)
  })

  it('decodes state_idle and state_paused', () => {
    const idle = expectOk(decodeSessionState(fixture('state_idle')))
    expect(idle.status).toBe('IDLE')
    expect(idle.anchorNs).toBeNull()
    expect(idle.setlist).toEqual([])
    expect(idle.lastCommand).toBeNull()
    expect(idle.currentSongId).toBeNull()

    const paused = expectOk(decodeSessionState(fixture('state_paused')))
    expect(paused.status).toBe('PAUSED')
    expect(paused.pausedBar).toBe(9)
    expect(paused.anchorNs).toBeNull()
    expect(paused.lastCommand?.origin).toBe('laptop_foh')
  })

  it('decodes join, sync, beacon, jump and peer events', () => {
    expect(expectOk(decodeJoinAck(fixture('join_session_ack')))).toEqual({
      sessionId: 'default',
      protocolVersion: 3,
      leaderInstanceId: '0b7e3f2a-5c19-4d8e-9a61-7f2c4b8d1e05',
      leaderTimeNs: 241953600000000,
    })
    // Older acks without the instance id still decode (the field is informative there).
    const legacyAck = fixture('join_session_ack')
    delete legacyAck.leader_instance_id
    expect(expectOk(decodeJoinAck(legacyAck)).leaderInstanceId).toBeNull()
    expect(expectOk(decodeSyncAck(fixture('sync_request_ack')))).toEqual({
      clientSendMs: 18234.125,
      leaderTimeNs: 241953601000000,
    })
    expect(expectOk(decodeBeatBeacon(fixture('beat_beacon')))).toEqual({
      sessionId: 'default',
      stateVersion: 42,
      anchorNs: 241953859000000,
      bpm: 120,
      beatsPerBar: 4,
      barOffset: 1,
      leaderTimeNs: 241955859000000,
    })
    expect(expectOk(decodeSetlistJump(fixture('setlist_jump')))).toEqual({
      sessionId: 'default',
      songId: 'song_07',
      title: 'Septima',
      orderIndex: 2,
      previousSongId: 'song_01',
      triggeredBy: 'director_mobile',
      timestampNs: 241960000000000,
    })
    for (const name of ['follower_joined', 'follower_left'] as const) {
      expect(expectOk(decodePeerEvent(fixture(name)))).toEqual({
        sid: 'Zq3x9Lk2',
        clientId: '6f1c2a9e-3b7d-4c11-9a52-0d8e4f7b1c23',
        alias: 'Bajo',
        role: 'musician',
      })
    }
  })

  it('decodes command acks, resolving the <<state_playing>> placeholder', () => {
    const accepted = expectOk(decodeCommandAck(fixture('command_ack_accepted')))
    expect(accepted.accepted).toBe(true)
    expect(accepted.duplicate).toBe(false)
    expect(accepted.actionTaken).toBe('PLAY')
    expect(accepted.reason).toBeNull()
    expect(accepted.stateVersion).toBe(42)
    expect(accepted.state.status).toBe('PLAYING')

    const rejected = expectOk(decodeCommandAck(fixture('command_ack_rejected')))
    expect(rejected.accepted).toBe(false)
    expect(rejected.reason).toBe('conflict')
    expect(rejected.actionTaken).toBe('none')
    expect(rejected.stateVersion).toBe(rejected.state.stateVersion)
  })

  it('tolerates unknown extra keys (forward compatible)', () => {
    const raw = fixture('state_playing')
    raw.some_future_field = { x: 1 }
    expect(decodeSessionState(raw).ok).toBe(true)
  })
})

describe('wire encode: matches fixtures exactly', () => {
  it('join_session', () => {
    expect(
      encodeJoinSession({
        sessionId: 'default',
        clientId: '6f1c2a9e-3b7d-4c11-9a52-0d8e4f7b1c23',
        role: 'musician',
        alias: 'Bajo',
      }),
    ).toEqual(fixtures.join_session_request)
  })

  it('sync_request', () => {
    expect(encodeSyncRequest(18234.125)).toEqual(fixtures.sync_request)
  })

  it('control_command PLAY / CUE_NEXT / JUMP_SONG / TEMPO_NUDGE', () => {
    const base = { sessionId: 'default', senderId: '6f1c2a9e-3b7d-4c11-9a52-0d8e4f7b1c23' }
    expect(
      expectOk(
        encodeControlCommand({
          ...base,
          commandId: '2b9f0c4e-8d1a-4f6b-b3c7-5e2a9d0f1a44',
          type: 'PLAY',
          origin: 'director_mobile',
        }),
      ),
    ).toEqual(fixtures.control_command_play)
    expect(
      expectOk(
        encodeControlCommand({
          sessionId: 'default',
          commandId: '9a0e7d21-6c3b-4b8e-8f19-2d5c7a1e0b66',
          type: 'CUE_NEXT',
          origin: 'laptop_foh',
          senderId: 'leader-desktop',
          payload: { expectedSongId: 'song_01' },
        }),
      ),
    ).toEqual(fixtures.control_command_cue_next)
    expect(
      expectOk(
        encodeControlCommand({
          ...base,
          commandId: 'c41d8e2a-0f7b-4e3c-a9d6-71b2e5f0c388',
          type: 'JUMP_SONG',
          origin: 'director_mobile',
          payload: { songId: 'song_07' },
        }),
      ),
    ).toEqual(fixtures.control_command_jump_song)
    expect(
      expectOk(
        encodeControlCommand({
          ...base,
          commandId: 'e7a3b9c0-1d2f-4a5e-8b6c-9f0d1e2a3b77',
          type: 'TEMPO_NUDGE',
          origin: 'director_mobile',
          payload: { deltaBpm: 1 },
        }),
      ),
    ).toEqual(fixtures.control_command_tempo_nudge)
  })

  it('never puts a client timestamp in a command', () => {
    const cmd = expectOk(
      encodeControlCommand({
        sessionId: 'default',
        commandId: 'x-1',
        type: 'STOP',
        origin: 'director_mobile',
        senderId: 'me',
      }),
    )
    const keys = JSON.stringify(cmd)
    expect(keys).not.toMatch(/timestamp|_ns|Ns"/i)
    expect(Object.keys(cmd).sort()).toEqual(['command_id', 'origin', 'payload', 'sender_id', 'session_id', 'type'])
  })

  it('rejects invalid outgoing commands', () => {
    const base = { sessionId: 'default', commandId: 'id', origin: 'director_mobile' as const, senderId: 'me' }
    expectRejected(encodeControlCommand({ ...base, type: 'JUMP_SONG' }))
    expectRejected(encodeControlCommand({ ...base, type: 'JUMP_SONG', payload: { orderIndex: -1 } }))
    expectRejected(encodeControlCommand({ ...base, type: 'TEMPO_NUDGE', payload: { deltaBpm: 0.5 } }))
    expectRejected(encodeControlCommand({ ...base, type: 'TEMPO_NUDGE' }))
    expectRejected(encodeControlCommand({ ...base, type: 'LAUNCH' as unknown as 'PLAY' }))
    expectRejected(encodeControlCommand({ ...base, sessionId: '', type: 'PLAY' }))
    // CUE without a known song still encodes (expected_song_id is optional).
    expect(expectOk(encodeControlCommand({ ...base, type: 'CUE_PREV' })).payload).toEqual({})
  })
})

describe('wire decode: malformed payloads are rejected, never thrown', () => {
  const mutate = (name: keyof typeof fixtures, edit: (o: Json) => void): Json => {
    const o = fixture(name)
    edit(o)
    return o
  }

  it('rejects non-objects', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) {
      expectRejected(decodeSessionState(raw))
      expectRejected(decodeCommandAck(raw))
      expectRejected(decodeBeatBeacon(raw))
      expectRejected(decodeSyncAck(raw))
      expectRejected(decodeJoinAck(raw))
      expectRejected(decodeSetlistJump(raw))
      expectRejected(decodePeerEvent(raw))
    }
  })

  it('rejects the legacy v2 camelCase state', () => {
    const legacy = {
      sessionId: 'default',
      leaderIp: '192.168.1.10',
      status: 'PLAYING',
      currentSongId: 'song_01',
      nextEventTimestamp: 1000,
      bpm: 120,
      beat: 1,
    }
    expect(expectRejected(decodeSessionState(legacy))).toMatch(/protocol_version|session_id/)
  })

  it('rejects SessionState field violations', () => {
    const cases: Array<[string, (o: Json) => void]> = [
      ['protocol_version 2', (o) => (o.protocol_version = 2)],
      ['unknown status', (o) => (o.status = 'RUNNING')],
      ['PLAYING without anchor', (o) => (o.anchor_ns = null)],
      ['bpm zero', (o) => (o.bpm = 0)],
      ['bpm as string', (o) => (o.bpm = '120')],
      ['bpm NaN-like', (o) => (o.bpm = null)],
      ['beats_per_bar zero', (o) => (o.beats_per_bar = 0)],
      ['beats_per_bar float', (o) => (o.beats_per_bar = 3.5)],
      ['anchor float ns', (o) => (o.anchor_ns = 1.5)],
      ['anchor negative', (o) => (o.anchor_ns = -10)],
      ['anchor unsafe int', (o) => (o.anchor_ns = 2 ** 60)],
      ['state_version missing', (o) => delete o.state_version],
      ['bar_offset zero', (o) => (o.bar_offset = 0)],
      ['setlist not a list', (o) => (o.setlist = {})],
      ['bad transition_mode', (o) => ((o.setlist as Json[])[0].transition_mode = 'crossfade')],
      ['setlist entry without song_id', (o) => delete (o.setlist as Json[])[1].song_id],
      ['last_command bad type', (o) => ((o.last_command as Json).type = 'REWIND')],
      ['empty session_id', (o) => (o.session_id = '')],
      ['leader_instance_id missing', (o) => delete o.leader_instance_id],
      ['leader_instance_id not a string', (o) => (o.leader_instance_id = 7)],
    ]
    for (const [label, edit] of cases) {
      const res = decodeSessionState(mutate('state_playing', edit))
      expect(res.ok, label).toBe(false)
    }
  })

  it('normalizes a stray anchor in IDLE to null instead of clicking on it', () => {
    const s = expectOk(decodeSessionState(mutate('state_idle', (o) => (o.anchor_ns = 241953859000000))))
    expect(s.anchorNs).toBeNull()
  })

  it('rejects malformed acks, beacons and jumps', () => {
    expectRejected(decodeCommandAck(mutate('command_ack_rejected', (o) => (o.reason = null))))
    expectRejected(decodeCommandAck(mutate('command_ack_rejected', (o) => (o.reason = 'busy'))))
    expectRejected(decodeCommandAck(mutate('command_ack_accepted', (o) => (o.state = '<<state_playing>>'))))
    expectRejected(decodeCommandAck(mutate('command_ack_accepted', (o) => (o.accepted = 'yes'))))
    expectRejected(decodeCommandAck(mutate('command_ack_accepted', (o) => delete o.command_id)))
    expectRejected(decodeSyncAck({ leader_time_ns: 1 }))
    expectRejected(decodeSyncAck({ client_send_ms: 1, leader_time_ns: 1.5 }))
    expectRejected(decodeJoinAck(mutate('join_session_ack', (o) => (o.status = 'error'))))
    expectRejected(decodeJoinAck(mutate('join_session_ack', (o) => (o.protocol_version = 2))))
    expectRejected(decodeJoinAck(mutate('join_session_ack', (o) => (o.leader_instance_id = ''))))
    expectRejected(decodeBeatBeacon(mutate('beat_beacon', (o) => (o.anchor_ns = null))))
    expectRejected(decodeBeatBeacon(mutate('beat_beacon', (o) => (o.bpm = -120))))
    expectRejected(decodeSetlistJump(mutate('setlist_jump', (o) => (o.triggered_by = 'laptop'))))
    expectRejected(decodePeerEvent(mutate('follower_joined', (o) => (o.role = 'drummer'))))
  })

  it('never throws on random garbage', () => {
    const pool: unknown[] = [null, 0, -1, 1.5, '', 'x', [], {}, true, { a: [] }, Number.NaN, Infinity]
    const keys = Object.keys(fixtures.state_playing)
    for (let i = 0; i < 300; i++) {
      const o: Json = fixture('state_playing')
      const k = keys[i % keys.length]
      o[k] = pool[(i * 7) % pool.length]
      expect(() => decodeSessionState(o)).not.toThrow()
      expect(() => decodeCommandAck({ ...fixture('command_ack_accepted'), state: o })).not.toThrow()
    }
  })
})
