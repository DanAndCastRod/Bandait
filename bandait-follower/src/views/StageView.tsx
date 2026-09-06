import { useEffect, useState, useRef, useCallback } from 'react'
import { useSync } from '../hooks/useSync'
import { syncService } from '../services/syncService'
import { flywheelClock } from '../services/flywheelClock'
import SetlistJumpBanner from '../components/SetlistJumpBanner'
import SongRibbon, { RibbonSong } from '../components/SongRibbon'
import VFDDisplay from '../components/VFDDisplay'
import HardwareKnob from '../components/HardwareKnob'
import DirectorRemoteToolbar from '../components/DirectorRemoteToolbar'
import { CommandType } from '../types/protocol'
import { getAllSetlists } from '../db/indexedDb'

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
  const { connected, state, offsetMs, jumpAlert, setJumpAlert, sendCommand, joinSession } = useSync()
  const [health, setHealth] = useState<NetworkHealth>('good')
  const [isFlywheelAutonomous, setIsFlywheelAutonomous] = useState(false)
  const [slideProgress, setSlideProgress] = useState(0)
  const [isSliding, setIsSliding] = useState(false)
  const slideTimer = useRef<number | null>(null)
  const [visualBeat, setVisualBeat] = useState(0)
  const [currentLyricIndex, setCurrentLyricIndex] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const [songData, setSongData] = useState<SongData | null>(null)

  // Sprint 3 State
  const [ribbonSongs, setRibbonSongs] = useState<RibbonSong[]>([
    { id: 'song_01', title: 'Medianoche en Pereira', bpm: 124, key: 'Am' },
    { id: 'song_02', title: 'Ritmo de Calle', bpm: 128, key: 'Em' },
    { id: 'song_03', title: 'Desde Lejos (Balada)', bpm: 88, key: 'G' },
    { id: 'song_04', title: 'Fuego en Tarima', bpm: 140, key: 'Dm' },
  ])
  const [inEarVolume, setInEarVolume] = useState(0.8)
  const [showDirectorControls, setShowDirectorControls] = useState(true)

  useEffect(() => {
    joinSession(sessionId)
  }, [sessionId, joinSession])

  // Load setlist songs from offline IndexedDB if available
  useEffect(() => {
    getAllSetlists()
      .then((setlists) => {
        if (setlists.length > 0 && setlists[0].songs.length > 0) {
          const loaded: RibbonSong[] = setlists[0].songs.map((s) => ({
            id: s.id,
            title: s.title,
            bpm: s.bpm,
            key: s.key,
          }))
          setRibbonSongs(loaded)
        }
      })
      .catch(() => {})
  }, [])

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
      const demoSongs: Record<string, SongData> = {
        'song_01': {
          title: 'Medianoche en Pereira',
          artist: 'Los Inquietos',
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
          artist: 'Banda Local',
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
        'song_03': {
          title: 'Desde Lejos (Balada)',
          artist: 'Solistas',
          bpm: 88,
          lyrics: [
            { time: 0, text: '...' },
            { time: 10.0, text: 'Desde lejos te observo' },
            { time: 20.0, text: 'Y no puedo hablar' },
          ],
          segments: [
            { label: 'Intro', bars: 4 },
            { label: 'Verso', bars: 8 },
          ],
        },
      }
      setSongData(demoSongs[state.currentSongId] || {
        title: `Canción ${state.currentSongId}`,
        artist: 'Bandait Live',
        bpm: state.bpm,
        lyrics: [],
        segments: [],
      })
    } else {
      setSongData(null)
    }
  }, [state?.currentSongId, state?.bpm])

  const handleEmergencyStop = useCallback(() => {
    sendCommand('PANIC')
    syncService.disconnect()
    setIsSliding(false)
    setSlideProgress(0)
  }, [sendCommand])

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

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  const handleDirectorCommand = (type: CommandType, payload?: Record<string, unknown>) => {
    sendCommand(type, payload)
  }

  const handleSelectSongFromRibbon = (song: RibbonSong, index: number) => {
    sendCommand('JUMP_SONG', { song_id: song.id, order_index: index })
  }

  const isBeatOne = visualBeat === 1
  const beatFlashClass = visualBeat > 0 ? `beat-${visualBeat}` : ''
  const lyrics = songData?.lyrics || []
  const currentLyric = lyrics[currentLyricIndex]
  const nextLyric = lyrics[currentLyricIndex + 1]

  return (
    <div className={`stage-view ${beatFlashClass}`}>
      {/* HIGH VISIBILITY SETLIST JUMP ALERT BANNER */}
      <SetlistJumpBanner
        alert={jumpAlert}
        onDismiss={() => setJumpAlert(null)}
      />

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

      {/* Top Bar: Navigation & Hardware Knob */}
      <div className="stage-topbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
              [FLYWHEEL ACTIVO]
            </span>
          )}
          <button className="btn-icon" onClick={onLibrary} title="Biblioteca">[LIB]</button>
          <button className="btn-icon" onClick={onSettings} title="Ajustes y Estilos">[CFG]</button>
          <button className="btn-icon" onClick={toggleFullscreen} title="Pantalla completa">[FS]</button>
          <button
            className="btn-icon"
            onClick={() => setShowDirectorControls(!showDirectorControls)}
            title="Alternar Mando Director"
          >
            {showDirectorControls ? '[OCULTAR MANDO]' : '[VER MANDO]'}
          </button>
          <button className="btn-icon" onClick={onDisconnect} title="Desconectar">[SALIR]</button>
        </div>

        {/* IN-EAR VOLUME HARDWARE KNOB */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <HardwareKnob
            label="IN-EAR GAIN"
            value={inEarVolume}
            onChange={(val) => setInEarVolume(val)}
          />
        </div>
      </div>

      {/* HARDWARE SONG RIBBON */}
      <SongRibbon
        songs={ribbonSongs}
        currentSongId={state?.currentSongId ?? null}
        onSelectSong={handleSelectSongFromRibbon}
      />

      {/* VFD DIGITAL STAGE DISPLAY */}
      <VFDDisplay
        bpm={state?.bpm ?? 120}
        bar={state?.bar ?? 1}
        beat={visualBeat || (state?.beat ?? 1)}
        status={state?.status ?? 'IDLE'}
        isFlywheel={isFlywheelAutonomous}
      />

      {/* DIRECTOR CONCURRENT CONTROL TOOLBAR */}
      {showDirectorControls && (
        <DirectorRemoteToolbar
          isPlaying={state?.status === 'PLAYING'}
          currentBpm={state?.bpm ?? 120}
          onCommand={handleDirectorCommand}
        />
      )}

      {/* Main Stage Content */}
      <div className="stage-content">
        {songData && (
          <div className="song-header">
            <h1 className="song-title">{songData.title}</h1>
            <p className="song-artist">{songData.artist}</p>
          </div>
        )}

        {/* Lyrics Area */}
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
              {songData ? '...' : 'Esperando orden del director...'}
            </div>
          )}
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
