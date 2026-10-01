/**
 * Link state shown on stage. Defined explicitly so the beacon is honest.
 * Jitter here is the MAD of the minimum-delay (lowest-RTT) filtered offsets
 * (see clockSync.estimateClock), not of every sample.
 *
 * - LOCKED:   connected, at least LOCK_MIN_SAMPLES samples on this connection,
 *             filtered jitter < LOCK_MAX_JITTER_MS and median RTT < LOCK_MAX_RTT_MS.
 * - DEGRADED: connected, filtered jitter < DEGRADED_MAX_JITTER_MS (also while
 *             the first samples of a connection are still arriving).
 * - UNSTABLE: connected but worse than DEGRADED. Shown in amber; the
 *             scheduler keeps playing.
 * - FLYWHEEL: disconnected while the local scheduler keeps playing on the
 *             last known anchor/bpm/offset.
 * - LOST:     disconnected and not playing.
 */

export type LinkState = 'LOCKED' | 'DEGRADED' | 'UNSTABLE' | 'FLYWHEEL' | 'LOST'

export const LOCK_MIN_SAMPLES = 5
export const LOCK_MAX_JITTER_MS = 3
export const LOCK_MAX_RTT_MS = 30
export const DEGRADED_MAX_JITTER_MS = 15

export interface LinkInputs {
  connected: boolean
  sampleCount: number
  /** Filtered jitter (ms); null when there is no estimate yet. */
  jitterMs: number | null
  /** Median RTT of the window (ms); null when there is no estimate yet. */
  rttMs: number | null
  schedulerRunning: boolean
}

function finite(v: number | null): v is number {
  return v !== null && Number.isFinite(v)
}

export function computeLinkState(input: LinkInputs): LinkState {
  if (!input.connected) return input.schedulerRunning ? 'FLYWHEEL' : 'LOST'
  // Just connected, no sample yet: still synchronizing, not a bad network.
  if (input.sampleCount === 0) return 'DEGRADED'
  if (
    input.sampleCount >= LOCK_MIN_SAMPLES &&
    finite(input.jitterMs) &&
    input.jitterMs < LOCK_MAX_JITTER_MS &&
    finite(input.rttMs) &&
    input.rttMs < LOCK_MAX_RTT_MS
  ) {
    return 'LOCKED'
  }
  if (finite(input.jitterMs) && input.jitterMs < DEGRADED_MAX_JITTER_MS) return 'DEGRADED'
  return 'UNSTABLE'
}

export const LINK_STATE_LABEL: Record<LinkState, string> = {
  LOCKED: 'SINCRONIZADO',
  DEGRADED: 'DEGRADADO',
  UNSTABLE: 'INESTABLE',
  FLYWHEEL: 'FLYWHEEL (SIN RED)',
  LOST: 'SIN ENLACE',
}

/** Maps to the .network-beacon CSS classes. */
export const LINK_STATE_CLASS: Record<LinkState, 'good' | 'degraded' | 'warning' | 'critical'> = {
  LOCKED: 'good',
  DEGRADED: 'degraded',
  UNSTABLE: 'warning',
  FLYWHEEL: 'warning',
  LOST: 'critical',
}
