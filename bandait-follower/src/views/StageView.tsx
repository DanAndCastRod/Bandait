import { useEffect, useState, useRef } from 'react'
import { useSync } from '../hooks/useSync'

interface Props {
  sessionId: string
}

type NetworkHealth = 'good' | 'warning' | 'critical'

export default function StageView({ sessionId }: Props) {
  const { connected, state, offsetMs, joinSession } = useSync()
  const [health, setHealth] = useState<NetworkHealth>('good')
  const [slideProgress, setSlideProgress] = useState(0)
  const [isSliding, setIsSliding] = useState(false)
  const slideTimer = useRef<number | null>(null)

  useEffect(() => {
    joinSession(sessionId)
  }, [sessionId, joinSession])

  useEffect(() => {
    if (!offsetMs) return
    if (offsetMs < 20) setHealth('good')
    else if (offsetMs < 100) setHealth('warning')
    else setHealth('critical')
  }, [offsetMs])

  const handleSlideStart = () => {
    setIsSliding(true)
    setSlideProgress(0)
    let progress = 0
    const interval = window.setInterval(() => {
      progress += 2
      setSlideProgress(progress)
      if (progress >= 100) {
        window.clearInterval(interval)
        handleEmergencyStop()
      }
    }, 20)
    slideTimer.current = interval
  }

  const handleSlideEnd = () => {
    setIsSliding(false)
    setSlideProgress(0)
    if (slideTimer.current) {
      window.clearInterval(slideTimer.current)
    }
  }

  const handleEmergencyStop = () => {
    // TODO: emit PANIC to server
    alert('EMERGENCY STOP ACTIVATED')
    setIsSliding(false)
    setSlideProgress(0)
  }

  const beat = state?.beat ?? 0
  const isBeatOne = beat === 1

  return (
    <div className={`stage-view ${isBeatOne ? 'beat-flash' : ''}`}>
      {/* Network Beacon */}
      <div className={`network-beacon ${health}`}>
        <span className="beacon-shape" />
        <span className="beacon-text">
          {health === 'good' && 'SYNC OK'}
          {health === 'warning' && 'JITTER'}
          {health === 'critical' && 'LOST'}
        </span>
      </div>

      {/* Main Content */}
      <div className="stage-content">
        <div className="bpm-section">
          <div className="bpm-value">{state?.bpm ?? '—'}</div>
          <div className="bpm-label">BPM</div>
        </div>

        <div className="lyrics-section">
          <div className="lyrics-current">
            {state?.current_song_id ? `Song: ${state.current_song_id}` : 'Waiting for leader...'}
          </div>
          <div className="lyrics-next">
            Next section...
          </div>
        </div>

        <div className="beat-indicator">
          {[1, 2, 3, 4].map((b) => (
            <div
              key={b}
              className={`beat-dot ${b === beat ? 'active' : ''} ${b === 1 && b === beat ? 'accent' : ''}`}
            />
          ))}
        </div>
      </div>

      {/* Emergency Slide-to-Stop */}
      <div className="emergency-container">
        <div
          className="emergency-track"
          onMouseDown={handleSlideStart}
          onMouseUp={handleSlideEnd}
          onMouseLeave={handleSlideEnd}
          onTouchStart={handleSlideStart}
          onTouchEnd={handleSlideEnd}
        >
          <div
            className="emergency-handle"
            style={{ transform: `translateX(${slideProgress}%)` }}
          >
            ■
          </div>
          <div className="emergency-label">SLIDE TO STOP</div>
          {isSliding && (
            <div
              className="emergency-fill"
              style={{ width: `${slideProgress}%` }}
            />
          )}
        </div>
      </div>

      {/* Connection status */}
      <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
        {connected ? '● CONNECTED' : '○ OFFLINE'}
      </div>
    </div>
  )
}
