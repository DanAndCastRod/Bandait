import { useCallback, useEffect, useState } from 'react'
import { syncService } from '../services/syncService'
import { SessionState } from '../types/protocol'

export function useSync() {
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<SessionState | null>(null)
  const [offsetMs, setOffsetMs] = useState(0)

  const joinSession = useCallback((sessionId: string) => {
    const ip = localStorage.getItem('bandait_last_ip') || window.location.hostname
    const port = localStorage.getItem('bandait_last_port') || '4040'
    const url = `ws://${ip}:${port}`

    syncService.setConnectHandler(() => setConnected(true))
    syncService.setDisconnectHandler(() => setConnected(false))
    syncService.setStateUpdateHandler((s) => setState(s))

    syncService.connect(url, sessionId)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      const offset = syncService.getStableOffsetMs()
      if (offset !== null) {
        setOffsetMs(offset)
      }
    }, 1000)
    return () => {
      clearInterval(interval)
      syncService.disconnect()
    }
  }, [])

  return { connected, state, offsetMs, joinSession }
}
