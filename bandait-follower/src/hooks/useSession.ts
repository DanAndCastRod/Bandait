import { useSyncExternalStore } from 'react'
import { SessionSnapshot, session } from '../services/sessionController'

/** Subscribes a component to the App-level session (never to beats). */
export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}
