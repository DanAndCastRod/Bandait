import { RefObject, useEffect, useRef } from 'react'
import { FlywheelClock } from '../services/flywheelClock'

/** How long the visual pulse stays lit after each beat (ms). */
export const PULSE_MS = 120

const BORDERS = ['top', 'right', 'bottom', 'left'] as const

export interface BeatVisualRefs {
  /** Element that receives data-beat / data-border / data-downbeat and the .pulse class. */
  root: RefObject<HTMLElement>
  bar: RefObject<HTMLElement>
  beat: RefObject<HTMLElement>
  /** Container of elements marked with data-beat-pill="n". */
  pills?: RefObject<HTMLElement>
}

export interface BeatFallback {
  bar: string
  beat: string
}

function borderFor(beat: number): (typeof BORDERS)[number] {
  if (beat === 1) return 'top'
  return BORDERS[1 + ((beat - 2) % 3)]
}

/**
 * Drives the bar:beat readout and beat pulses from the scheduler with
 * requestAnimationFrame, writing to the DOM directly. React does not
 * re-render on beats. `fallback` is shown when nothing is playing.
 */
export function useBeatVisuals(clock: FlywheelClock, refs: BeatVisualRefs, fallback: BeatFallback): void {
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback
  const { root, bar, beat, pills } = refs

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return
    let raf = 0
    let lastText = ''
    let lastBeatKey = ''
    let lastPulse = false
    let lastRootEl: HTMLElement | null = null

    const frame = () => {
      const now = performance.now()
      const visual = clock.getVisualBeat(now)
      const rootEl = root.current
      lastRootEl = rootEl

      const barText = visual ? String(visual.bar).padStart(3, '0') : fallbackRef.current.bar
      const beatText = visual ? String(visual.beat).padStart(2, '0') : fallbackRef.current.beat
      const text = `${barText}:${beatText}`
      if (text !== lastText) {
        if (bar.current) bar.current.textContent = barText
        if (beat.current) beat.current.textContent = beatText
        lastText = text
      }

      const beatKey = visual ? `${visual.bar}:${visual.beat}` : 'none'
      if (beatKey !== lastBeatKey) {
        lastBeatKey = beatKey
        if (rootEl) {
          rootEl.dataset.beat = visual ? String(visual.beat) : '0'
          rootEl.dataset.border = visual ? borderFor(visual.beat) : 'none'
          rootEl.dataset.downbeat = visual?.accent ? '1' : '0'
        }
        const pillsEl = pills?.current
        if (pillsEl) {
          pillsEl.querySelectorAll<HTMLElement>('[data-beat-pill]').forEach((el) => {
            el.classList.toggle('active', visual !== null && el.dataset.beatPill === String(visual.beat))
          })
        }
      }

      const pulse = visual !== null && visual.sinceMs < PULSE_MS
      if (pulse !== lastPulse) {
        lastPulse = pulse
        rootEl?.classList.toggle('pulse', pulse)
      }

      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      lastRootEl?.classList.remove('pulse')
    }
  }, [clock, root, bar, beat, pills])
}
