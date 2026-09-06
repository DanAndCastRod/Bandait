import { useEffect, useState, useRef, useCallback } from 'react'
import { useSync } from '../hooks/useSync'
import { syncService } from '../services/syncService'
import { flywheelClock } from '../services/flywheelClock'

interface Props {
  sessionId: string
  onLibrary: () => void
  onSettings: () => void
  onDisconnect: () => void
}

type NetworkHealth = 'good' | 'warning' | 'critical'

interface SongData {
  title: string
  artist: string
  bpm: number
  lyrics: Array<{ time: number; text: string }>
  segments: Array<{ label: string; bars: number }>
}

export default function StageView({ sessionId, onLibrary, onSettings, onDisconnect }: Props) {
  const { connected, state, offsetMs, joinSession } = useSync()
  const [health, setHealth] = useState<NetworkHealth>('good')
  const [isFlywheelAutonomous, setIsFlywheelAutonomous] = useState(false)
  const [slideProgress, setSlideProgress] = useState(0)
  const [isSliding, setIsSliding] = useState(false)
  const slideTimer = useRef<number | null>(null)
  const [visualBeat, setVisualBeat] = useState(0)
  const [currentLyricIndex, setCurrentLyricIndex] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const [songData, setSongData] = useState<SongData | null>(null)


  useEffect(() => {
    joinSession(sessionId)
  }, [sessionId, joinSession])

  // Network health
  useEffect(() => {
    if (!offsetMs) return
    if (Math.abs(offsetMs) < 20) setHealth('good')
    else if (Math.abs(offsetMs) < 100) setHealth('warning')
    else setHealth('critical')
  }, [offsetMs])

  // Visual beat flash
  const beat = state?.beat ?? 0
  useEffect(() => {
    if (beat > 0) {
      setVisualBeat(beat)
      const timer = setTimeout(() => setVisualBeat(0), 150)
      return () => clearTimeout(timer)
    }
  }, [beat])

  // Elapsed time
  useEffect(() => {
    if (state?.status !== 'PLAYING') {
      setElapsedTime(0)
      setCurrentLyricIndex(0)
      return
    }
    const interval = window.setInterval(() => {
      setElapsedTime((prev) => prev + 0.1)
    }, 100)
    return () => clearInterval(interval)
  }, [state?.status])

  // Lyric index
  useEffect(() => {
    if (!songData || state?.status !== 'PLAYING') return
    const lyrics = songData.lyrics
    const idx = lyrics.findIndex((lyric, index) => {
      const nextLyric = lyrics[index + 1]
      return elapsedTime >= lyric.time && (!nextLyric || elapsedTime < nextLyric.time)
    })
    if (idx !== -1 && idx !== currentLyricIndex) {
      setCurrentLyricIndex(idx)
    }
  }, [elapsedTime, songData, currentLyricIndex, state?.status])

  // Synchronize Flywheel with connection state
  useEffect(() => {
    flywheelClock.setConnected(connected)
  }, [connected])

  // Flywheel Web Audio precision metronome & clock
  useEffect(() => {
    flywheelClock.setCallbacks(
      (_bar, beatNum) => {
        setVisualBeat(beatNum)
        setTimeout(() => setVisualBeat(0), 120)
      },
      (autonomous) => {
        setIsFlywheelAutonomous(autonomous)
      }
    )

    if (state?.status === 'PLAYING' && state?.bpm) {
      flywheelClock.start(state.bpm)
    } else {
      flywheelClock.stop()
    }

    return () => {
      flywheelClock.stop()
    }
  }, [state?.status, state?.bpm])

  // Load song data when song changes
  useEffect(() => {
    if (state?.currentSongId) {
      // In real app, fetch from IndexedDB or server
      // For now, use demo data
      const demoSongs: Record<string, SongData> = {
        'song_01': {
          title: 'Medianoche en Pereira',
          artist: 'Bandait',
          bpm: 124,
          lyrics: [
            { time: 0, text: '...' },
            { time: 12.5, text: 'Las luces de la ciudad se apagan' },
            { time: 18.2, text: 'Y solo queda el eco de tu voz' },
            { time: 24.0, text: 'Medianoche en Pereira' },
            { time: 30.5, text: 'Donde el viento nos encontró' },
            { time: 42.0, text: 'Verso 2: Caminamos sin dirección' },
          ],
          segments: [
            { label: 'Intro', bars: 8 },
            { label: 'Verso A', bars: 16 },
            { label: 'Coro', bars: 16 },
            { label: 'Puente', bars: 8 },
          ],
        },
        'song_02': {
          title: 'Ritmo de Calle',
          artist: 'Bandait',
          bpm: 128,
          lyrics: [
            { time: 0, text: '...' },
            { time: 8.0, text: 'El ritmo de la calle nos llama' },
            { time: 14.5, text: 'Y la noche apenas comienza' },
            { time: 21.0, text: 'Bailamos sin preocupación' },
          ],
          segments: [
            { label: 'Intro', bars: 4 },
            { label: 'Verso', bars: 16 },
            { label: 'Coro', bars: 16 },
          ],
        },
      }
      setSongData(demoSongs[state.currentSongId] || null)
    } else {
      setSongData(null)
    }
  }, [state?.currentSongId])

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
  }, [])

  const handleSlideEnd = useCallback(() => {
    setIsSliding(false)
    setSlideProgress(0)
    if (slideTimer.current) {
      window.clearInterval(slideTimer.current)
    }
  }, [])

  const handleEmergencyStop = useCallback(() => {
    syncService.disconnect()
    setIsSliding(false)
    setSlideProgress(0)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  const isBeatOne = visualBeat === 1
  const beatFlashClass = visualBeat > 0 ? `beat-${visualBeat}` : ''
  const lyrics = songData?.lyrics || []
  const currentLyric = lyrics[currentLyricIndex]
  const nextLyric = lyrics[currentLyricIndex + 1]

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
      <div className="stage-topbar" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {isFlywheelAutonomous && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--accent-warning)',
              border: '1px solid var(--accent-warning)',
              padding: '2px 8px',
              borderRadius: '3px',
              letterSpacing: '1px',
            }}
          >
            FLYWHEEL INERTIA
          </span>
        )}
        <button className="btn-icon" onClick={onLibrary} title="Biblioteca">[LIB]</button>
        <button className="btn-icon" onClick={onSettings} title="Ajustes y Estilos">[CFG]</button>
        <button className="btn-icon" onClick={toggleFullscreen} title="Pantalla completa">[FS]</button>
        <button className="btn-icon" onClick={onDisconnect} title="Desconectar">[SALIR]</button>
      </div>

      {/* Main Content */}
      <div className="stage-content">
        {/* Song info */}
        {songData && (
          <div className="song-header">
            <h1 className="song-title">{songData.title}</h1>
            <p className="song-artist">{songData.artist}</p>
          </div>
        )}

        {/* BPM Display */}
        <div className="bpm-section">
          <div className="bpm-value">{state?.bpm ?? '—'}</div>
          <div className="bpm-label">BPM</div>
        </div>

        {/* Lyrics */}
        <div className="lyrics-section">
          {currentLyric ? (
            <>
              <div className="lyrics-current">{currentLyric.text}</div>
              {nextLyric && (
                <div className="lyrics-next">{nextLyric.text}</div>
              )}
            </>
          ) : (
            <div className="lyrics-waiting">
              {songData ? '...' : 'Esperando canción del líder...'}
            </div>
          )}
        </div>

        {/* Beat indicator */}
        <div className="beat-indicator">
          {[1, 2, 3, 4].map((b) => (
            <div
              key={b}
              className={`beat-dot ${b === beat ? 'active' : ''} ${b === 1 && b === beat ? 'accent' : ''}`}
            />
          ))}
        </div>

        {/* Segments */}
        {songData && songData.segments.length > 0 && (
          <div className="segments-bar">
            {songData.segments.map((seg, i) => (
              <span key={i} className="segment-badge">{seg.label} ({seg.bars}b)</span>
            ))}
          </div>
        )}
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
          <div className="emergency-label">DESLIZAR PARA DETENER</div>
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
        {connected ? `● CONECTADO | ${sessionId}` : '○ OFFLINE'}
      </div>
    </div>
  )
}
