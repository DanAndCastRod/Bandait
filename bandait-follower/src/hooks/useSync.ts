import { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'

interface SessionState {
  session_id: string
  leader_ip: string
  status: string
  current_song_id: string | null
  next_event_timestamp: number
  bpm: number
  beat: number
}

export function useSync() {
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<SessionState | null>(null)
  const [offsetMs, setOffsetMs] = useState(0)
  const socketRef = useRef<Socket | null>(null)
  const offsetRef = useRef(0)

  const calculateOffset = useCallback((socket: Socket) => {
    const samples: number[] = []
    let count = 0
    const maxSamples = 10

    const sendSync = () => {
      if (count >= maxSamples) {
        samples.sort((a, b) => a - b)
        const median = samples[Math.floor(samples.length / 2)]
        offsetRef.current = median
        setOffsetMs(Math.round(median / 1_000_000))
        return
      }

      const t0 = performance.now()
      socket.emit('sync_request', { t0: t0 * 1_000_000 }, () => {
        const t2 = performance.now()
        // Note: server response should include t1; simplified here
        const rtt = (t2 - t0) * 1_000_000
        const offset = rtt / 2
        samples.push(offset)
        count++
        setTimeout(sendSync, 100)
      })
    }

    sendSync()
  }, [])

  const connect = useCallback((ip: string, port: string) => {
    const url = `ws://${ip}:${port}`
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      calculateOffset(socket)
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('state_update', (data: SessionState) => {
      // Adjust timestamp to local time
      const adjusted = {
        ...data,
        next_event_timestamp: data.next_event_timestamp - offsetRef.current,
      }
      setState(adjusted)
    })

    socket.on('full_state', (data: SessionState) => {
      setState(data)
    })
  }, [calculateOffset])

  const joinSession = useCallback((sessionId: string) => {
    const ip = localStorage.getItem('bandait_last_ip') || 'localhost'
    const port = localStorage.getItem('bandait_last_port') || '4040'

    if (!socketRef.current || !socketRef.current.connected) {
      connect(ip, port)
    }

    // Wait for connection then join
    const tryJoin = () => {
      if (socketRef.current?.connected) {
        socketRef.current.emit('join_session', { sessionId })
      } else {
        setTimeout(tryJoin, 500)
      }
    }
    tryJoin()
  }, [connect])

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect()
    }
  }, [])

  return { connected, state, offsetMs, joinSession }
}
