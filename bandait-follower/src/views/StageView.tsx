import { useEffect, useState, useRef, useCallback } from 'react'
import { useSync } from '../hooks/useSync'
import { syncService } from '../services/syncService'
import { flywheelClock } from '../services/flywheelClock'
import SetlistJumpBanner from '../components/SetlistJumpBanner'
import SongRibbon, { RibbonSong } from '../components/SongRibbon'
import VFDDisplay from '../components/VFDDisplay'
import HardwareKnob from '../components/HardwareKnob'
import DirectorRemoteToolbar from '../components/DirectorRemoteToolbar'
import MultiTrackMixer from '../components/MultiTrackMixer'
import { CommandType } from '../types/protocol'
import { getAllSetlists } from '../db/indexedDb'
import {
  LibraryIcon,
  SettingsIcon,
  MixerIcon,
  FullscreenIcon,
  DisconnectIcon,
  RemoteIcon,
  FlywheelIcon,
} from '../components/Icons'

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
  key?: string
  lyrics: Array<{ time: number; text: string; chord?: string }>
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

  // Stage state
  const [ribbonSongs, setRibbonSongs] = useState<RibbonSong[]>([
    { id: 'song_01', title: 'Medianoche en Pereira', bpm: 124, key: 'Am' },
    { id: 'song_02', title: 'Ritmo de Calle', bpm: 128, key: 'Em' },
    { id: 'song_03', title: 'Desde Lejos (Balada)', bpm: 88, key: 'G' },
    { id: 'song_04', title: 'Fuego en Tarima', bpm: 140, key: 'Dm' },
  ])
  const [inEarVolume, setInEarVolume] = useState(0.8)
  const [showDirectorControls, setShowDirectorControls] = useState(false)
  const [showMixer, setShowMixer] = useState(false)

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
      const timer = setTimeout(() => setVisualBeat(0), 140)
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
          key: 'Am',
          lyrics: [
            { time: 0, text: '...', chord: 'Am' },
            { time: 12.5, text: 'Las luces de la ciudad se apagan', chord: 'Dm7' },
            { time: 18.2, text: 'Y solo queda el eco de tu voz', chord: 'G7' },
            { time: 24.0, text: 'Medianoche en Pereira', chord: 'Cmaj7' },
            { time: 30.5, text: 'Donde el viento nos encontró', chord: 'F' },
            { time: 42.0, text: 'Verso 2: Caminamos sin dirección', chord: 'E7' },
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
          key: 'Em',
          lyrics: [
            { time: 0, text: '...', chord: 'Em' },
            { time: 8.0, text: 'El ritmo de la calle nos llama', chord: 'C' },
            { time: 14.5, text: 'Y la noche apenas comienza', chord: 'D' },
            { time: 21.0, text: 'Bailamos sin preocupación', chord: 'B7' },
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
          key: 'G',
          lyrics: [
            { time: 0, text: '...', chord: 'G' },
            { time: 10.0, text: 'Desde lejos te observo', chord: 'Em' },
            { time: 20.0, text: 'Y no puedo hablar', chord: 'C' },
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
      progress += 2.5
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
  const lyrics = songData?.lyrics || []
  const currentLyric = lyrics[currentLyricIndex]
  const nextLyric = lyrics[currentLyricIndex + 1]

  return (
    <div className="stage-view">
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

      {/* TOP RACK BAR */}
      <div className="stage-rack-bar">
        {/* LEFT STATUS */}
        <div className="rack-group-left">
          {isFlywheelAutonomous ? (
            <span className="badge-hardware badge-flywheel">
              <FlywheelIcon size={13} />
              <span>FLYWHEEL ACTIVO</span>
            </span>
          ) : (
            <span className="badge-hardware badge-ntp">
              <span>NTP SYNC</span>
            </span>
          )}

          {/* Network Beacon */}
          <div className={`network-beacon ${health}`}>
            <span className="beacon-shape" />
            <span>
              {health === 'good' && 'SYNC OK'}
              {health === 'warning' && 'JITTER'}
              {health === 'critical' && 'LOST'}
            </span>
            <span style={{ opacity: 0.75, fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
              {offsetMs ? `${Math.abs(offsetMs).toFixed(1)}ms` : '--'}
            </span>
          </div>
        </div>

        {/* RIGHT ACTIONS */}
        <div className="rack-group-right">
          <button
            type="button"
            className="btn-stage-icon"
            onClick={onLibrary}
            title="Biblioteca de Setlists"
            aria-label="Biblioteca"
          >
            <LibraryIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-stage-icon"
            onClick={() => setShowMixer(true)}
            title="Mezclador In-Ear Multipista"
            aria-label="Mezclador"
          >
            <MixerIcon size={16} />
          </button>

          <button
            type="button"
            className={`btn-stage-icon ${showDirectorControls ? 'active' : ''}`}
            onClick={() => setShowDirectorControls(!showDirectorControls)}
            title="Alternar Mando del Director"
            aria-label="Mando Director"
          >
            <RemoteIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-stage-icon"
            onClick={onSettings}
            title="Ajustes de Temas y Audio"
            aria-label="Configuración"
          >
            <SettingsIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-stage-icon"
            onClick={toggleFullscreen}
            title="Pantalla Completa"
            aria-label="Pantalla Completa"
          >
            <FullscreenIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-stage-icon"
            onClick={onDisconnect}
            title="Desconectar y Salir"
            aria-label="Desconectar"
            style={{ color: 'var(--accent-danger)' }}
          >
            <DisconnectIcon size={16} />
          </button>

          {/* Compact In-Ear Gain Knob */}
          <div style={{ marginLeft: '4px' }}>
            <HardwareKnob
              label="IN-EAR"
              value={inEarVolume}
              onChange={(val) => setInEarVolume(val)}
            />
          </div>
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

      {/* MAIN STAGE PROMPTER CENTER */}
      <div className={`stage-prompter-center ${visualBeat > 0 ? 'beat-flash' : ''}`}>
        {/* Prompter Meta Strip */}
        <div className="prompter-meta-strip">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="prompter-song-name">
              {songData ? songData.title : 'ESPERANDO SEÑAL DEL DIRECTOR'}
            </span>
            {songData?.artist && (
              <span style={{ opacity: 0.6 }}>• {songData.artist}</span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {currentLyric?.chord && (
              <span className="prompter-chord-badge">
                ACORDE: {currentLyric.chord}
              </span>
            )}
            {songData?.key && !currentLyric?.chord && (
              <span className="prompter-chord-badge">
                TONO: {songData.key}
              </span>
            )}
          </div>
        </div>

        {/* Big High-Contrast Lyrics Readout */}
        <div className="prompter-lyrics-box">
          {currentLyric ? (
            <>
              <div className="prompter-lyric-current">{currentLyric.text}</div>
              {nextLyric && (
                <div className="prompter-lyric-next">{nextLyric.text}</div>
              )}
            </>
          ) : (
            <div className="prompter-waiting">
              {songData ? '[EN ESPERA DE INICIO]' : '[SISTEMA LISTO // SELECCIONA CANCIÓN]'}
            </div>
          )}
        </div>

        {/* 4-Beat Pill Rhythm Strip */}
        <div className="beat-indicator-strip">
          {[1, 2, 3, 4].map((beatNum) => {
            const isCurrentBeat = visualBeat === beatNum || (visualBeat === 0 && (state?.beat ?? 0) === beatNum)
            const isDown = beatNum === 1
            return (
              <div
                key={beatNum}
                className={`beat-pill ${isDown ? 'downbeat' : ''} ${isCurrentBeat ? 'active' : ''}`}
              />
            )
          })}
        </div>

        {/* Structural Segments Bar */}
        {songData && songData.segments.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '4px' }}>
            {songData.segments.map((seg, i) => (
              <span
                key={i}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--theme-border)',
                  color: 'var(--text-secondary)',
                  padding: '2px 8px',
                  borderRadius: 'var(--theme-radius)',
                  letterSpacing: '0.5px',
                }}
              >
                {seg.label} ({seg.bars}c)
              </span>
            ))}
          </div>
        )}
      </div>

      {/* INDUSTRIAL EMERGENCY SLIDE-TO-STOP */}
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
          <div className="emergency-label">
            &gt;&gt;&gt; DESLIZAR PARA PARADA DE EMERGENCIA &gt;&gt;&gt;
          </div>
          {isSliding && (
            <div
              className="emergency-fill"
              style={{ width: `${slideProgress}%` }}
            />
          )}
        </div>
      </div>

      {/* STAGE FOOTER DIAGNOSTICS */}
      <div className="stage-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: connected ? 'var(--accent-success)' : 'var(--accent-danger)',
              display: 'inline-block',
            }}
          />
          <span>{connected ? `ENLACE ACTIVO // SESIÓN: ${sessionId}` : 'OFFLINE // MODO AUTÓNOMO'}</span>
        </div>
        <span>BANDAIT 3.0 // MOTOR ACÚSTICO PRO</span>
      </div>

      {/* IN-EAR MULTI-TRACK STEM MIXER */}
      <MultiTrackMixer
        songId={state?.currentSongId || 'song_01'}
        isOpen={showMixer}
        onClose={() => setShowMixer(false)}
        initialMasterVolume={inEarVolume}
        onMasterVolumeChange={(vol) => setInEarVolume(vol)}
      />
    </div>
  )
}
