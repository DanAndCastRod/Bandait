import { useEffect, useState, useRef, useCallback } from 'react'
import { useSync } from '../hooks/useSync'
import { syncService } from '../services/syncService'

interface Props {
  sessionId: string
  onLibrary: () => void
  onDisconnect: () => void
}

type NetworkHealth = 'good' | 'warning' | 'critical'

export default function StageView({ sessionId, onLibrary, onDisconnect }: Props) {
  const { connected, state, offsetMs, joinSession } = useSync()
  const [health, setHealth] = useState<NetworkHealth>('good')
  const [slideProgress, setSlideProgress] = useState(0)
  const [isSliding, setIsSliding] = useState(false)
  const slideTimer = useRef<number | null>(null)
  const [visualBeat, setVisualBeat] = useState(0)

  useEffect(() => {
    joinSession(sessionId)
  }, [sessionId, joinSession])

  useEffect(() => {
    if (!offsetMs) return
    if (Math.abs(offsetMs) < 20) setHealth('good')
    else if (Math.abs(offsetMs) < 100) setHealth('warning')
    else setHealth('critical')
  }, [offsetMs])

  // Visual metronome: flash borders on beat
  const beat = state?.beat ?? 0
  useEffect(() => {
    if (beat > 0) {
      setVisualBeat(beat)
      const timer = setTimeout(() => setVisualBeat(0), 150)
      return () => clearTimeout(timer)
    }
  }, [beat])

  const handleEmergencyStop = useCallback(() => {
    syncService.disconnect()
    alert('EMERGENCY STOP ACTIVATED')
    setIsSliding(false)
    setSlideProgress(0)
  }, [])

  const handleSlideStart = useCallback(() => {
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
  }, [handleEmergencyStop])

  const handleSlideEnd = useCallback(() => {
    setIsSliding(false)
    setSlideProgress(0)
    if (slideTimer.current) {
      window.clearInterval(slideTimer.current)
    }
  }, [])

  const isBeatOne = visualBeat === 1
  const beatFlashClass = visualBeat > 0 ? `beat-${visualBeat}` : ''

  return (
    <div className={`stage-view ${beatFlashClass}`}>
      {/* Visual Metronome — 4-border flash */}
      <div className={`metronome-border top ${isBeatOne ? 'active' : ''}`} />
      <div className={`metronome-border right ${visualBeat === 2 ? 'active' : ''}`} />
      <div className={`metronome-border bottom ${visualBeat === 3 ? 'active' : ''}`} />
      <div className={`metronome-border left ${visualBeat === 4 ? 'active' : ''}`} />

      {/* Network Beacon */}
      <div className={`network-beacon ${health}`}>
        <span className="beacon-shape" />
        <span className="beacon-text">
          {health === 'good' && 'SYNC OK'}
          {health === 'warning' && 'JITTER'}
          {health === 'critical' && 'LOST'}
        </span>
        <span className="beacon-offset">{offsetMs ? `${Math.abs(offsetMs).toFixed(1)}ms` : '--'}</span>
      </div>

      {/* Top Bar: Navigation */}
      <div className="stage-topbar">
        <button className="btn-icon" onClick={onLibrary}>☰</button>
        <button className="btn-icon" onClick={onDisconnect}>✕</button>
      </div>

      {/* Main Content */}
      <div className="stage-content">
        <div className="bpm-section">
          <div className="bpm-value">{state?.bpm ?? '—'}</div>
          <div className="bpm-label">BPM</div>
        </div>

        <div className="lyrics-section">
          <div className="lyrics-current">
            {state?.currentSongId ? `Song: ${state.currentSongId}` : 'Waiting for leader...'}
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
        {connected ? `● CONNECTED | ${sessionId}` : '○ OFFLINE'}
      </div>
    </div>
  )
}
