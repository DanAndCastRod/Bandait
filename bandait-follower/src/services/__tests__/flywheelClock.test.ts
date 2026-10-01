import { describe, it, expect, beforeEach } from 'vitest'
import { FlywheelClock, MAX_SLEW_STEP_MS, SCHEDULE_AHEAD_MS, TransportInput } from '../flywheelClock'
import { FakeAudioContext, FakeOscillator, manualTimers } from './fakes'

const OFFSET = 5_000_000 // leader_ms = local_ms + OFFSET
const START = 1000

let now = START
let ctx: FakeAudioContext | null = null
let created = 0
let clock: FlywheelClock

function makeClock(options: ConstructorParameters<typeof FakeAudioContext>[1] = {}) {
  now = START
  ctx = null
  created = 0
  clock = new FlywheelClock({
    now: () => now,
    timers: manualTimers,
    createAudioContext: () => {
      created += 1
      ctx = new FakeAudioContext(() => now, options)
      return ctx
    },
  })
}

/** Advance the local clock in 25 ms scheduler steps up to `to`. */
function advance(to: number) {
  while (now < to) {
    now = Math.min(to, now + 25)
    clock.tick()
  }
}

function playing(anchorLocalMs: number, bpm = 120, extra: Partial<TransportInput> = {}): TransportInput {
  return {
    status: 'PLAYING',
    anchorLeaderMs: anchorLocalMs + OFFSET,
    bpm,
    beatsPerBar: 4,
    barOffset: 1,
    stateVersion: 1,
    ...extra,
  }
}

function clicks(): number[] {
  return (ctx as FakeAudioContext).liveClickTimes()
}

function intervals(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i])
}

/** Distance from x to the nearest multiple of period (handles float noise both ways). */
function modDist(x: number, period: number): number {
  const r = ((x % period) + period) % period
  return Math.min(r, period - r)
}

function expectTimes(actual: number[], expected: number[]) {
  expect(actual.length).toBe(expected.length)
  actual.forEach((t, i) => expect(t).toBeCloseTo(expected[i], 6))
}

async function armedClock(options: ConstructorParameters<typeof FakeAudioContext>[1] = {}) {
  makeClock(options)
  await clock.armAudio()
  expect(clock.setOffset(OFFSET)).toBe('initial')
}

describe('FlywheelClock: AudioContext only from a user gesture', () => {
  it('does not create an AudioContext until armAudio(), and only once', async () => {
    makeClock()
    clock.setOffset(OFFSET)
    clock.applyTransport(playing(START + 250))
    advance(START + 2000)
    expect(created).toBe(0)
    // Without audio the beats are still generated for the visual metronome.
    const beats = clock.getRecentBeats()
    expect(beats.length).toBeGreaterThan(0)
    expect(beats.every((b) => !b.hasAudio)).toBe(true)

    expect(await clock.armAudio()).toBe(true)
    expect(clock.getAudioState()).toBe('armed')
    await clock.armAudio()
    expect(created).toBe(1)
  })

  it('reports suspended when the system pauses the context', async () => {
    await armedClock()
    ;(ctx as FakeAudioContext).suspend()
    expect(clock.getAudioState()).toBe('suspended')
  })
})

describe('FlywheelClock: beat math from the anchor', () => {
  beforeEach(async () => {
    await armedClock()
  })

  it('schedules clicks at anchor + k * beat with lookahead, accent on beat 1', () => {
    clock.applyTransport(playing(START + 250))
    advance(START + 2000)
    // Horizon at the last tick is 3000 + 120 ms: beats 1250..2750 scheduled.
    expectTimes(clicks(), [1250, 1750, 2250, 2750])
    const osc = (ctx as FakeAudioContext).oscillators
    expect(osc[0].frequency.value).toBe(1600)
    expect(osc[1].frequency.value).toBe(800)
    expect(clock.getRecentBeats().map((b) => `${b.bar}:${b.beat}`)).toEqual(['1:1', '1:2', '1:3', '1:4'])
    expect(clock.getVisualBeat(1800)).toMatchObject({ bar: 1, beat: 2, accent: false })
    expect(clock.getVisualBeat(1249)).toBeNull()
  })

  it('never schedules further ahead than the lookahead window', () => {
    clock.applyTransport(playing(START + 250))
    advance(START + 300)
    const furthest = Math.max(...clicks())
    expect(furthest).toBeLessThanOrEqual(now + SCHEDULE_AHEAD_MS)
  })

  it('honors bar_offset (RESUME starts at paused_bar + 1, beat 1)', () => {
    clock.applyTransport(playing(START + 250, 120, { barOffset: 10 }))
    advance(START + 2000)
    expect(clock.getRecentBeats()[0]).toMatchObject({ bar: 10, beat: 1, accent: true })
    expect(clock.getRecentBeats()[3]).toMatchObject({ bar: 10, beat: 4 })
  })

  it('joins mid-song on the right phase without replaying the past', () => {
    now = 10_000
    clock.applyTransport(playing(1250))
    advance(11_000)
    const t = clicks()
    expect(t[0]).toBeGreaterThanOrEqual(10_000)
    t.forEach((x) => expect(modDist(x - 1250, 500)).toBeCloseTo(0, 6))
  })
})

describe('FlywheelClock: anchor switch is never retroactive (rule 2)', () => {
  beforeEach(async () => {
    await armedClock()
    clock.applyTransport(playing(START + 250))
  })

  it('keeps the old grid until the new anchor, then the new bpm', () => {
    advance(1900)
    clock.applyTransport(playing(2400, 60, { stateVersion: 2 }))
    advance(5000)
    expectTimes(clicks(), [1250, 1750, 2250, 2400, 3400, 4400])
    const osc = (ctx as FakeAudioContext).oscillators.filter((o) => !o.cancelled)
    expect(osc[3].frequency.value).toBe(1600) // new downbeat
  })

  it('cancels an already scheduled old click that falls after the new anchor', () => {
    advance(2150) // 2250 is already scheduled (horizon 2270)
    const before = (ctx as FakeAudioContext).oscillators.length
    expect(clicks()).toContain(2250)
    clock.applyTransport(playing(2200, 60, { stateVersion: 2 }))
    advance(4000)
    const cancelled = (ctx as FakeAudioContext).oscillators.slice(0, before).filter((o) => o.cancelled)
    expect(cancelled).toHaveLength(1)
    expect((ctx as FakeAudioContext).ctxToLocal(cancelled[0].startTime as number)).toBeCloseTo(2250, 6)
    expectTimes(clicks(), [1250, 1750, 2200, 3200])
  })

  it('a late anchor (already in the past) is joined in phase from now', () => {
    advance(1900)
    clock.applyTransport(playing(1500, 60, { stateVersion: 2 }))
    advance(4000)
    // 1250 and 1750 already sounded; next beats of the new grid are 2500, 3500.
    expectTimes(clicks(), [1250, 1750, 2500, 3500])
  })

  it('re-applying the same schedule (full_state, beacon) changes nothing', () => {
    advance(2000)
    clock.applyTransport(playing(START + 250, 120, { stateVersion: 5 }))
    clock.applyTransport(playing(START + 250, 120, { stateVersion: 5 }))
    advance(4000)
    expectTimes(clicks(), [1250, 1750, 2250, 2750, 3250, 3750])
    expect((ctx as FakeAudioContext).oscillators.every((o) => !o.cancelled)).toBe(true)
  })

  it('a pending tempo change is superseded by a newer one at the same boundary', () => {
    advance(1300)
    clock.applyTransport(playing(3250, 100, { stateVersion: 2 }))
    clock.applyTransport(playing(3250, 140, { stateVersion: 3 }))
    advance(5000)
    const t = clicks()
    expectTimes(t.slice(0, 5), [1250, 1750, 2250, 2750, 3250])
    expect(t[5] - t[4]).toBeCloseTo(60000 / 140, 6)
  })
})

describe('FlywheelClock: flywheel and soft phase correction (section 7)', () => {
  beforeEach(async () => {
    await armedClock()
    clock.applyTransport(playing(START + 250))
    advance(3000)
  })

  it('keeps an exact grid with no network input at all (flywheel)', () => {
    advance(13_000)
    const iv = intervals(clicks())
    expect(iv.length).toBeGreaterThan(20)
    iv.forEach((d) => expect(d).toBeCloseTo(500, 6))
  })

  it('ignores errors under 2 ms', () => {
    expect(clock.setOffset(OFFSET + 1.5)).toBe('ignored')
    advance(8000)
    intervals(clicks()).forEach((d) => expect(d).toBeCloseTo(500, 6))
  })

  it('slews errors under 50 ms over at least one bar, bounded, then stops', () => {
    const before = clicks().length
    expect(clock.setOffset(OFFSET + 10)).toBe('slew')
    advance(10_000)
    const t = clicks()
    const iv = intervals(t.slice(before - 1))
    const deviations = iv.map((d) => d - 500)
    // Bounded per beat and spread over >= beats_per_bar beats.
    deviations.forEach((d) => expect(Math.abs(d)).toBeLessThanOrEqual(10 / 4 + 1e-6))
    expect(deviations.filter((d) => Math.abs(d) > 1e-6).length).toBeGreaterThanOrEqual(4)
    // Total correction equals the error exactly: never accumulates.
    expect(deviations.reduce((a, b) => a + b, 0)).toBeCloseTo(-10, 6)
    // Converged: last beats on the corrected grid, exact 500 ms again.
    deviations.slice(-5).forEach((d) => expect(d).toBeCloseTo(0, 6))
    const last = t[t.length - 1]
    expect(modDist(last - 1250 + 10, 500)).toBeCloseTo(0, 6)
  })

  it('does not accumulate when the same estimate is fed repeatedly', () => {
    expect(clock.setOffset(OFFSET + 10)).toBe('slew')
    advance(6000)
    for (let i = 0; i < 10; i++) {
      expect(clock.setOffset(OFFSET + 10)).toBe('ignored')
      advance(now + 500)
    }
    const t = clicks()
    expect(modDist(t[t.length - 1] - 1250 + 10, 500)).toBeCloseTo(0, 6)
    intervals(t.slice(-8)).forEach((d) => expect(d).toBeCloseTo(500, 6))
  })

  it('retargets mid-slew to the newest estimate (absolute target, no sum)', () => {
    clock.setOffset(OFFSET + 10)
    advance(3600) // part of the slew applied
    clock.setOffset(OFFSET + 20)
    advance(14_000)
    const t = clicks()
    expect(modDist(t[t.length - 1] - 1250 + 20, 500)).toBeCloseTo(0, 6)
    intervals(t).forEach((d) => expect(Math.abs(d - 500)).toBeLessThanOrEqual(MAX_SLEW_STEP_MS + 1e-6))
  })

  it('re-anchors errors >= 50 ms on the next beat boundary without double clicks', () => {
    for (const delta of [200, -300, 420]) {
      const base = clicks().length
      const target = (ctx as FakeAudioContext).oscillators.length
      expect(clock.setOffset((clock.getAppliedOffsetMs() as number) + delta)).toBe('reanchor')
      advance(now + 4000)
      const t = clicks()
      intervals(t).forEach((d) => expect(d).toBeGreaterThanOrEqual(250 - 1e-6)) // >= half a beat
      const applied = clock.getAppliedOffsetMs() as number
      const tail = t.slice(Math.max(base, t.length - 4))
      tail.forEach((x) => {
        const leader = x + applied
        expect(modDist(leader - (START + 250 + OFFSET), 500)).toBeCloseTo(0, 4)
      })
      expect((ctx as FakeAudioContext).oscillators.length).toBeGreaterThan(target)
    }
  })
})

describe('FlywheelClock: STOP / PAUSE / PANIC', () => {
  beforeEach(async () => {
    await armedClock()
    clock.applyTransport(playing(START + 250))
    advance(2200) // 2250 is scheduled but has not sounded
  })

  const futureOsc = (): FakeOscillator => {
    const c = ctx as FakeAudioContext
    const o = c.oscillators.find((x) => Math.abs(c.ctxToLocal(x.startTime as number) - 2250) < 1e-6)
    if (!o) throw new Error('no click at 2250')
    return o
  }

  it('STOP cancels already scheduled nodes immediately', () => {
    const pending = futureOsc()
    clock.applyTransport({ ...playing(0), status: 'IDLE', anchorLeaderMs: null })
    expect(pending.cancelled).toBe(true)
    expect(pending.stopTimes).toContain(0)
    expect(pending.clickGain?.disconnected).toBe(true)
    const count = (ctx as FakeAudioContext).oscillators.length
    advance(5000)
    expect((ctx as FakeAudioContext).oscillators.length).toBe(count)
    expect(clock.isRunning()).toBe(false)
    expect(clock.getVisualBeat(5000)).toBeNull()
  })

  it('PAUSE cancels too', () => {
    const pending = futureOsc()
    clock.applyTransport({ ...playing(0), status: 'PAUSED', anchorLeaderMs: null })
    expect(pending.cancelled).toBe(true)
  })

  it('remote PANIC silences everything now and is released by the next PLAY', () => {
    const pending = futureOsc()
    clock.panic('remote')
    expect(pending.cancelled).toBe(true)
    expect(clock.isRemoteMuted()).toBe(true)
    clock.applyTransport(playing(3000, 120, { stateVersion: 9 }))
    expect(clock.isRemoteMuted()).toBe(false)
    advance(3600)
    expect(clicks().filter((t) => t >= 3000).length).toBeGreaterThan(0)
  })

  it('local PANIC stays muted until the user re-arms audio', async () => {
    clock.panic('local')
    clock.applyTransport(playing(3000, 120, { stateVersion: 9 }))
    advance(4000)
    const after = clock.getRecentBeats().filter((b) => b.localMs >= 3000)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((b) => !b.hasAudio)).toBe(true) // visual only, no audio nodes
    await clock.armAudio()
    expect(clock.isLocallyMuted()).toBe(false)
    advance(5000)
    expect(clock.getRecentBeats().some((b) => b.localMs > 4000 && b.hasAudio)).toBe(true)
  })
})

describe('FlywheelClock: audio clock mapping', () => {
  it('uses getOutputTimestamp to compensate output latency', async () => {
    await armedClock({ outputTimestampLatencySec: 0.02 })
    clock.applyTransport(playing(START + 250))
    advance(1300)
    const c = ctx as FakeAudioContext
    expect(c.oscillators[0].startTime).toBeCloseTo(c.localToCtx(1250) - 0.02, 6)
  })

  it('falls back to currentTime minus outputLatency', async () => {
    await armedClock({ outputLatency: 0.03 })
    clock.applyTransport(playing(START + 250))
    advance(1300)
    const c = ctx as FakeAudioContext
    expect(c.oscillators[0].startTime).toBeCloseTo(c.localToCtx(1250) - 0.03, 6)
  })

  it('IN-EAR volume drives the master gain', async () => {
    await armedClock()
    clock.setVolume(0.3)
    expect(clock.getVolume()).toBeCloseTo(0.3)
    // buildGraph creates the master gain first.
    expect((ctx as FakeAudioContext).gains[0].gain.value).toBeCloseTo(0.3)
    clock.setVolume(4)
    expect(clock.getVolume()).toBe(1)
    clock.setVolume(Number.NaN)
    expect(clock.getVolume()).toBe(0)
  })
})
