import { describe, it, expect } from 'vitest'
import fixtures from '../../../../bandait-protocol/fixtures/v3_messages.json'
import { SyncSample, computeSyncSample, estimateClock, mad, median, minimumDelaySamples } from '../clockSync'
import { computeLinkState } from '../linkState'
import { beatIndexAtOrAfter, beatLeaderMs, makeSegment, positionAt } from '../transportMath'
import { isUuid, protocolRoleFor, sanitizeAlias, uuidv4 } from '../identity'

describe('clockSync (contract section 2)', () => {
  it('uses the contract formulas on the fixture exchange', () => {
    // client_send_ms 18234.125, leader_time_ns 241953601000000, reply 6 ms later
    const t3 = fixtures.sync_request.client_send_ms + 6
    const s = computeSyncSample(fixtures.sync_request.client_send_ms, fixtures.sync_request_ack.leader_time_ns, t3)
    expect(s).not.toBeNull()
    expect(s?.rttMs).toBeCloseTo(6, 9)
    expect(s?.offsetMs).toBeCloseTo(241953601000000 / 1e6 - (18234.125 + t3) / 2, 6)
  })

  it('discards impossible samples', () => {
    expect(computeSyncSample(100, 1e12, 90)).toBeNull() // negative RTT
    expect(computeSyncSample(100, 1e12, 100 + 5000)).toBeNull() // RTT too large to be useful
  })

  it('median / MAD', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(mad([1, 1, 1, 1])).toBe(0)
    expect(mad([10, 11, 9, 10, 50])).toBe(1)
  })

  it('minimum-delay filter: lowest-RTT third, at least 3, ties to the newest', () => {
    const mk = (rttMs: number, i: number): SyncSample => ({ rttMs, offsetMs: i, atLocalMs: i })
    expect(minimumDelaySamples([mk(9, 1), mk(2, 2)]).map((s) => s.rttMs)).toEqual([2, 9]) // fewer than 3: all
    const twelve = Array.from({ length: 12 }, (_, i) => mk(20 - i, i))
    expect(minimumDelaySamples(twelve)).toHaveLength(4) // ceil(12 / 3)
    expect(minimumDelaySamples(Array.from({ length: 6 }, (_, i) => mk(5, i))).map((s) => s.atLocalMs)).toEqual([5, 4, 3])
  })

  it('offset and jitter come only from the lowest-RTT samples', () => {
    const samples = [
      { rttMs: 4, offsetMs: 1000.2, atLocalMs: 1 },
      { rttMs: 5, offsetMs: 999.8, atLocalMs: 2 },
      { rttMs: 4, offsetMs: 1000.0, atLocalMs: 3 },
      { rttMs: 80, offsetMs: 1035, atLocalMs: 4 }, // queued on Wi-Fi: asymmetric
      { rttMs: 90, offsetMs: 960, atLocalMs: 5 },
    ]
    const est = estimateClock(samples)
    expect(est?.sampleCount).toBe(5)
    expect(est?.filteredCount).toBe(3)
    expect(est?.rttMs).toBe(5) // median RTT of the whole window
    expect(est?.offsetMs).toBeCloseTo(1000.0, 6)
    expect(est?.jitterMs).toBeCloseTo(0.2, 6)
  })

  it('RTT spikes do not move the offset or inflate the jitter', () => {
    const TRUE_OFFSET = 249_904_118.5
    const window: SyncSample[] = []
    for (let i = 0; i < 15; i++) {
      const spike = i % 3 !== 0 // two thirds of the window are queued
      window.push({
        rttMs: spike ? 40 + 17 * (i % 5) : 2 + 0.1 * (i % 2),
        // Queued samples are biased by half the extra one-way delay, both ways.
        offsetMs: TRUE_OFFSET + (spike ? (i % 2 === 0 ? 1 : -1) * (12 + i) : 0.2 * (i % 2)),
        atLocalMs: i * 1000,
      })
    }
    const est = estimateClock(window)
    expect(est).not.toBeNull()
    expect(Math.abs((est?.offsetMs ?? 0) - TRUE_OFFSET)).toBeLessThan(0.25)
    expect(est?.jitterMs).toBeLessThan(0.25)
    // The old all-samples MAD would have called this link unusable.
    expect(mad(window.map((s) => s.offsetMs))).toBeGreaterThan(10)
  })
})

describe('linkState', () => {
  const base = { connected: true, sampleCount: 5, jitterMs: 0.5, rttMs: 4, schedulerRunning: false }
  it('LOCKED needs >= 5 samples, filtered jitter < 3 ms and median RTT < 30 ms', () => {
    expect(computeLinkState(base)).toBe('LOCKED')
    expect(computeLinkState({ ...base, jitterMs: 2.9 })).toBe('LOCKED')
    expect(computeLinkState({ ...base, sampleCount: 4 })).toBe('DEGRADED')
    expect(computeLinkState({ ...base, jitterMs: 3 })).toBe('DEGRADED')
    expect(computeLinkState({ ...base, rttMs: 30 })).toBe('DEGRADED')
    expect(computeLinkState({ ...base, rttMs: null })).toBe('DEGRADED')
  })
  it('DEGRADED below 15 ms filtered jitter, UNSTABLE above (still connected)', () => {
    expect(computeLinkState({ ...base, jitterMs: 14.9 })).toBe('DEGRADED')
    expect(computeLinkState({ ...base, jitterMs: 15 })).toBe('UNSTABLE')
    expect(computeLinkState({ ...base, jitterMs: null })).toBe('UNSTABLE')
    expect(computeLinkState({ ...base, sampleCount: 0, jitterMs: null, rttMs: null })).toBe('DEGRADED') // syncing
  })
  it('FLYWHEEL when disconnected and playing, LOST when disconnected and stopped', () => {
    expect(computeLinkState({ ...base, connected: false, schedulerRunning: true })).toBe('FLYWHEEL')
    expect(computeLinkState({ ...base, connected: false, schedulerRunning: false })).toBe('LOST')
  })
  it('a large constant offset is never jitter', () => {
    expect(computeLinkState({ ...base, jitterMs: 0 })).toBe('LOCKED')
  })
})

describe('transportMath (contract section 6)', () => {
  const st = fixtures.state_playing
  const seg = makeSegment({
    anchorLeaderMs: st.anchor_ns / 1e6,
    bpm: st.bpm,
    beatsPerBar: st.beats_per_bar,
    barOffset: st.bar_offset,
    stateVersion: st.state_version,
  })

  it('bar/beat from k per the contract formula', () => {
    expect(seg).not.toBeNull()
    if (!seg) return
    const anchor = st.anchor_ns / 1e6
    expect(positionAt(seg, anchor - 1)).toBeNull()
    expect(positionAt(seg, anchor)).toEqual({ k: 0, bar: 1, beat: 1 })
    expect(positionAt(seg, anchor + 2500)).toEqual({ k: 5, bar: 2, beat: 2 })
    expect(positionAt(seg, anchor + 3999.999)).toEqual({ k: 7, bar: 2, beat: 4 })
    expect(beatLeaderMs(seg, 8)).toBeCloseTo(anchor + 4000, 9)
    expect(beatIndexAtOrAfter(seg, anchor + 501)).toBe(2)
    expect(beatIndexAtOrAfter(seg, anchor - 10_000)).toBe(0)
  })

  it('rejects segments that would break the scheduler', () => {
    expect(makeSegment({ anchorLeaderMs: 0, bpm: 0, beatsPerBar: 4, barOffset: 1, stateVersion: 1 })).toBeNull()
    expect(makeSegment({ anchorLeaderMs: Number.NaN, bpm: 120, beatsPerBar: 4, barOffset: 1, stateVersion: 1 })).toBeNull()
    expect(makeSegment({ anchorLeaderMs: 0, bpm: 120, beatsPerBar: 0, barOffset: 1, stateVersion: 1 })).toBeNull()
  })
})

describe('identity', () => {
  it('generates v4 UUIDs (also without crypto.randomUUID)', () => {
    for (let i = 0; i < 20; i++) expect(isUuid(uuidv4())).toBe(true)
    expect(uuidv4()).not.toBe(uuidv4())
  })
  it('maps profile roles to protocol roles', () => {
    expect(protocolRoleFor('director')).toBe('director')
    expect(protocolRoleFor('drums')).toBe('musician')
    expect(protocolRoleFor(null)).toBe('musician')
  })
  it('sanitizes the alias', () => {
    expect(sanitizeAlias('   ')).toBe('Musico')
    expect(sanitizeAlias(' Bajo ')).toBe('Bajo')
    expect(sanitizeAlias('x'.repeat(80))).toHaveLength(40)
  })
})
