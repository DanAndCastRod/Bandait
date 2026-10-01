/**
 * NTP-style clock math (contract section 2). Pure functions, no I/O.
 *
 * local time  = performance.now() of this device (ms)
 * leader time = leader monotonic clock (ms = *_ns / 1e6)
 * leader_ms = local_ms + offset_ms
 *
 * The offset is large and constant (different clock origins); that is correct.
 * Jitter is the dispersion of offset samples (MAD), never the offset itself.
 */

export interface SyncSample {
  rttMs: number
  offsetMs: number
  /** Local time at which the reply was received (t3). */
  atLocalMs: number
}

export interface ClockEstimate {
  /** leader_ms - local_ms, from the minimum-delay (lowest-RTT) samples. */
  offsetMs: number
  /** Median RTT of the whole window. */
  rttMs: number
  /** MAD of the offsets of the filtered (lowest-RTT) samples. */
  jitterMs: number
  /** Samples in the window (all from the current connection). */
  sampleCount: number
  /** How many lowest-RTT samples the offset and jitter come from. */
  filteredCount: number
}

/** Minimum-delay filter keeps the lowest-RTT third of the window... */
export const FILTER_FRACTION = 1 / 3
/** ...but never fewer than this many samples (or all, if the window is smaller). */
export const FILTER_MIN_SAMPLES = 3

/** Samples with an RTT above this are useless for millisecond phase work. */
export const MAX_USEFUL_RTT_MS = 1000

export function computeSyncSample(clientSendMs: number, leaderTimeNs: number, receivedAtMs: number): SyncSample | null {
  const rttMs = receivedAtMs - clientSendMs
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_USEFUL_RTT_MS) return null
  const offsetMs = leaderTimeNs / 1e6 - (clientSendMs + receivedAtMs) / 2
  if (!Number.isFinite(offsetMs)) return null
  return { rttMs, offsetMs, atLocalMs: receivedAtMs }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Median absolute deviation. */
export function mad(values: readonly number[]): number {
  if (values.length === 0) return NaN
  const m = median(values)
  return median(values.map((v) => Math.abs(v - m)))
}

/** The lowest-RTT third of the window (at least FILTER_MIN_SAMPLES); ties go to the newest. */
export function minimumDelaySamples(samples: readonly SyncSample[]): SyncSample[] {
  const sorted = [...samples].sort((a, b) => a.rttMs - b.rttMs || b.atLocalMs - a.atLocalMs)
  const keep = Math.min(sorted.length, Math.max(FILTER_MIN_SAMPLES, Math.ceil(sorted.length * FILTER_FRACTION)))
  return sorted.slice(0, keep)
}

/**
 * NTP-style minimum-delay filter. Queueing on Wi-Fi (and on a busy leader)
 * inflates the RTT and makes the delay asymmetric, which biases the offset of
 * those samples. Only the lowest-RTT third is trusted: the offset is the
 * median of their offsets and the jitter is the MAD of those same offsets.
 * The RTT reported is the median of the whole window (link quality).
 */
export function estimateClock(samples: readonly SyncSample[]): ClockEstimate | null {
  if (samples.length === 0) return null
  const filtered = minimumDelaySamples(samples)
  const offsets = filtered.map((s) => s.offsetMs)
  return {
    offsetMs: median(offsets),
    rttMs: median(samples.map((s) => s.rttMs)),
    jitterMs: mad(offsets),
    sampleCount: samples.length,
    filteredCount: filtered.length,
  }
}
