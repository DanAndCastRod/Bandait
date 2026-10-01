/**
 * Beat math (contract section 6), in leader milliseconds.
 *
 * beat_ms = 60000 / bpm, k = floor((t - anchor) / beat_ms), k >= 0
 * beat = (k mod beats_per_bar) + 1
 * bar  = bar_offset + floor(k / beats_per_bar)
 * click k at anchor + k * beat_ms, accent when beat == 1
 */

export interface Segment {
  anchorLeaderMs: number
  beatMs: number
  bpm: number
  beatsPerBar: number
  barOffset: number
  stateVersion: number
}

export interface BeatPosition {
  k: number
  bar: number
  beat: number
}

/** Tolerance for float rounding when comparing beat instants (ms). */
export const TIME_EPS_MS = 1e-6

export function makeSegment(input: {
  anchorLeaderMs: number
  bpm: number
  beatsPerBar: number
  barOffset: number
  stateVersion: number
}): Segment | null {
  const { anchorLeaderMs, bpm, beatsPerBar, barOffset, stateVersion } = input
  if (!Number.isFinite(anchorLeaderMs) || !Number.isFinite(bpm) || bpm <= 0) return null
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) return null
  return {
    anchorLeaderMs,
    beatMs: 60000 / bpm,
    bpm,
    beatsPerBar,
    barOffset: Number.isInteger(barOffset) ? barOffset : 1,
    stateVersion,
  }
}

export function beatLeaderMs(seg: Segment, k: number): number {
  return seg.anchorLeaderMs + k * seg.beatMs
}

export function positionOfBeat(seg: Segment, k: number): BeatPosition {
  return {
    k,
    beat: (k % seg.beatsPerBar) + 1,
    bar: seg.barOffset + Math.floor(k / seg.beatsPerBar),
  }
}

/** Position at leader time t per the contract formula; null before the anchor. */
export function positionAt(seg: Segment, leaderMs: number): BeatPosition | null {
  const raw = (leaderMs - seg.anchorLeaderMs) / seg.beatMs
  if (raw < -TIME_EPS_MS) return null
  return positionOfBeat(seg, Math.max(0, Math.floor(raw + TIME_EPS_MS)))
}

/** Smallest k >= 0 whose click is at or after leader time t. */
export function beatIndexAtOrAfter(seg: Segment, leaderMs: number): number {
  const raw = (leaderMs - seg.anchorLeaderMs) / seg.beatMs
  return Math.max(0, Math.ceil(raw - TIME_EPS_MS))
}

export function sameSchedule(a: Segment, b: Segment): boolean {
  return (
    Math.abs(a.anchorLeaderMs - b.anchorLeaderMs) < 0.001 &&
    Math.abs(a.beatMs - b.beatMs) < 1e-9 &&
    a.beatsPerBar === b.beatsPerBar &&
    a.barOffset === b.barOffset
  )
}
