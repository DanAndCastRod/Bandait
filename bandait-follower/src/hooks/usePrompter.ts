import { useEffect, useState, useSyncExternalStore } from 'react'
import { FlywheelClock } from '../services/flywheelClock'
import { SongContentStore, sectionIndexAt } from '../services/songContent'
import { SongContent, SongSection } from '../types/protocol'

/** Content of a song from the store; re-renders only when a download lands. */
export function useSongContent(store: SongContentStore, songId: string | null): SongContent | null {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return store.get(songId)
}

/**
 * Current section from the scheduler's bar, read with requestAnimationFrame.
 * React state changes only when the section changes (every few bars), never per beat.
 * `pausedBar` is used while the transport is stopped.
 */
export function useSectionIndex(clock: FlywheelClock, sections: readonly SongSection[], pausedBar: number | null): number {
  const [index, setIndex] = useState(() => sectionIndexAt(sections, pausedBar))

  useEffect(() => {
    const resolve = () => {
      const visual = clock.getVisualBeat(performance.now())
      return sectionIndexAt(sections, visual ? visual.bar : pausedBar)
    }
    setIndex(resolve())
    if (typeof requestAnimationFrame !== 'function') return
    let raf = 0
    let last = -2
    const frame = () => {
      const next = resolve()
      if (next !== last) {
        last = next
        setIndex(next)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [clock, sections, pausedBar])

  return index
}
