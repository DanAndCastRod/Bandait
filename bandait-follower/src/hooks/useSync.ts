import { useCallback, useEffect, useState, useRef } from 'react'
import { syncService } from '../services/syncService'
import { SessionState, SetlistJumpAlert, CommandType } from '../types/protocol'

export function useSync() {
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<SessionState | null>(null)
  const [offsetMs, setOffsetMs] = useState(0)
  const [jumpAlert, setJumpAlert] = useState<SetlistJumpAlert | null>(null)
  const sessionIdRef = useRef('default')

  const joinSession = useCallback((sessionId: string) => {
    sessionIdRef.current = sessionId
    const ip = localStorage.getItem('bandait_last_ip') || window.location.hostname
    const port = localStorage.getItem('bandait_last_port') || '4040'
    const url = `http://${ip}:${port}`

    syncService.setConnectHandler(() => setConnected(true))
    syncService.setDisconnectHandler(() => setConnected(false))
    syncService.setStateUpdateHandler((s) => {
      setState(s)
      if (s.jump_alert) {
        setJumpAlert(s.jump_alert)
      }
    })
    syncService.setSetlistJumpHandler((alert) => setJumpAlert(alert))

    syncService.connect(url, sessionId)
  }, [])

  const sendCommand = useCallback((type: CommandType, payload?: Record<string, unknown>) => {
    syncService.sendCommand(type, payload, sessionIdRef.current)
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

  return { connected, state, offsetMs, jumpAlert, setJumpAlert, sendCommand, joinSession }
}
