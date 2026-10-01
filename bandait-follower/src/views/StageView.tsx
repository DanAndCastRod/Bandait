import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../hooks/useSession'
import { useBeatVisuals } from '../hooks/useBeatVisuals'
import { useCommandRunner } from '../hooks/useCommandRunner'
import { session } from '../services/sessionController'
import { flywheelClock } from '../services/flywheelClock'
import { CommandError } from '../services/syncService'
import { LINK_STATE_CLASS, LINK_STATE_LABEL } from '../services/linkState'
import { CommandSender, SetlistEntry } from '../types/protocol'
import { getSetlist, StoredSetlist } from '../db/indexedDb'
import SetlistJumpBanner from '../components/SetlistJumpBanner'
import SongRibbon, { RibbonSong } from '../components/SongRibbon'
import VFDDisplay from '../components/VFDDisplay'
import HardwareKnob from '../components/HardwareKnob'
import DirectorRemoteToolbar from '../components/DirectorRemoteToolbar'
import MultiTrackMixer from '../components/MultiTrackMixer'
import AudioArmButton from '../components/AudioArmButton'
import EmergencySlide from '../components/EmergencySlide'
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
  /** Local (IndexedDB) setlist picked in the Library; shown only without a leader. */
  setlistId: string | null
  onLibrary: () => void
  onSettings: () => void
  /** Explicit SALIR: the parent leaves the session. */
  onExit: () => void
}

const INEAR_KEY = 'bandait_inear_vol'
const PANIC_NOTE_MS = 6000

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function saveNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Storage blocked: the value still applies for this session.
  }
}

export default function StageView({ setlistId, onLibrary, onSettings, onExit }: Props) {
  const snap = useSession()
  const { state, connected, role, linkState, clock } = snap
  const isDirector = role === 'director'

  const [inEarVolume, setInEarVolume] = useState(() => flywheelClock.getVolume())
  const [showDirectorControls, setShowDirectorControls] = useState(true)
  const [showMixer, setShowMixer] = useState(false)
  const [localSetlist, setLocalSetlist] = useState<StoredSetlist | null>(null)
  const [panicNote, setPanicNote] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const beatRef = useRef<HTMLSpanElement>(null)
  const pillsRef = useRef<HTMLDivElement>(null)

  // Director PANIC silences this device at once (released by the next PLAY).
  const send = useCallback<CommandSender>(
    (type, payload) => (type === 'PANIC' ? session.panicRemote() : session.sendCommand(type, payload)),
    [],
  )
  const { feedback, run } = useCommandRunner(send)

  // Selected local setlist (honors the id picked in the Library).
  useEffect(() => {
    if (!setlistId) {
      setLocalSetlist(null)
      return
    }
    let cancelled = false
    getSetlist(setlistId)
      .then((sl) => {
        if (!cancelled) setLocalSetlist(sl)
      })
      .catch(() => {
        if (!cancelled) setLocalSetlist(null)
      })
    return () => {
      cancelled = true
    }
  }, [setlistId])

  useEffect(() => {
    if (!panicNote) return
    const t = setTimeout(() => setPanicNote(null), PANIC_NOTE_MS)
    return () => clearTimeout(t)
  }, [panicNote])

  // Current song strictly from the leader state.
  const orderedSetlist: SetlistEntry[] = useMemo(
    () => (state ? [...state.setlist].sort((a, b) => a.orderIndex - b.orderIndex) : []),
    [state],
  )
  const currentSong: SetlistEntry | null = useMemo(() => {
    if (!state) return null
    const byId = state.currentSongId ? orderedSetlist.find((s) => s.songId === state.currentSongId) : undefined
    if (byId) return byId
    if (state.currentOrderIndex !== null) {
      return orderedSetlist.find((s) => s.orderIndex === state.currentOrderIndex) ?? null
    }
    return null
  }, [state, orderedSetlist])
  const nextSong = currentSong ? orderedSetlist.find((s) => s.orderIndex > currentSong.orderIndex) ?? null : null

  const ribbon = useMemo((): { label: string; songs: RibbonSong[] } | null => {
    if (state && orderedSetlist.length > 0) {
      return {
        label: 'SETLIST LIDER',
        songs: orderedSetlist.map((s) => ({ id: s.songId, title: s.title, bpm: s.bpm })),
      }
    }
    if (!state && localSetlist && localSetlist.songs.length > 0) {
      return {
        label: 'SETLIST LOCAL (SIN LIDER)',
        songs: localSetlist.songs.map((s) => ({ id: s.id, title: s.title, bpm: s.bpm, key: s.key })),
      }
    }
    return null
  }, [state, orderedSetlist, localSetlist])

  // bar:beat and pulses come from the scheduler through rAF, not React state.
  const pausedBar = state?.status === 'PAUSED' ? state.pausedBar : null
  const fallback = useMemo(
    () => (pausedBar !== null ? { bar: pad(pausedBar, 3), beat: '--' } : { bar: '---', beat: '--' }),
    [pausedBar],
  )
  const visualRefs = useMemo(() => ({ root: rootRef, bar: barRef, beat: beatRef, pills: pillsRef }), [])
  useBeatVisuals(flywheelClock, visualRefs, fallback)

  const handleArmAudio = useCallback(() => {
    // Synchronous call inside the click handler: required by iOS.
    void flywheelClock.armAudio()
    // Same gesture: retry the keep-awake video if it was refused without one.
    session.ensureWakeLock()
  }, [])

  const handleVolume = useCallback((value: number) => {
    setInEarVolume(value)
    flywheelClock.setVolume(value)
    saveNumber(INEAR_KEY, value)
  }, [])

  const handlePanicMute = useCallback((muted: boolean) => {
    if (muted) flywheelClock.setLocalMuted(true)
    else void flywheelClock.armAudio()
  }, [])

  // Musician: SILENCIO LOCAL only (nothing sent). Director: PANIC to the band + local silence.
  const handleEmergencyStop = useCallback(() => {
    session.emergencyStop().then(
      (outcome) =>
        setPanicNote(
          outcome.kind === 'local_mute'
            ? 'SILENCIO LOCAL: SOLO ESTE EQUIPO // LA BANDA SIGUE TOCANDO'
            : 'PANIC CONFIRMADO POR EL LIDER // AUDIO LOCAL SILENCIADO',
        ),
      (err: unknown) =>
        setPanicNote(
          err instanceof CommandError && err.reason === 'offline'
            ? 'SIN CONEXION: SOLO SE SILENCIO ESTE EQUIPO'
            : 'AUDIO LOCAL SILENCIADO // EL LIDER NO CONFIRMO EL PANIC',
        ),
    )
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {})
    } else {
      document.exitFullscreen?.().catch(() => {})
    }
  }, [])

  const canCommand = isDirector && connected && state !== null
  const handleSelectSongFromRibbon = (song: RibbonSong) => {
    if (!canCommand) return
    run('JUMP_SONG', { songId: song.id })
  }

  const disabledReason = !snap.active
    ? 'SIN SESION ACTIVA'
    : !connected
      ? 'SIN CONEXION CON EL LIDER'
      : !state
        ? 'ESPERANDO ESTADO DEL LIDER'
        : null

  const beatsPerBar = state?.beatsPerBar ?? 4
  const songTitle = currentSong
    ? currentSong.title
    : state
      ? 'SIN CANCION ACTIVA'
      : snap.active
        ? 'ESPERANDO ESTADO DEL LIDER'
        : 'SIN SESION'

  const clockText =
    connected && clock
      ? `RTT ${clock.rttMs.toFixed(1)} // JIT ${clock.jitterMs.toFixed(1)} ms // ${clock.sampleCount}m`
      : 'RTT -- // JIT --'

  let footerText: string
  if (!snap.active) footerText = 'SIN SESION // USA SALIR PARA CONECTAR A UN LIDER'
  else if (connected) footerText = `ENLACE ACTIVO // SESION: ${snap.sessionId} // ${isDirector ? 'DIRECTOR' : 'MUSICO'}: ${snap.alias}`
  else {
    const attempt = snap.reconnectAttempt > 0 ? ` (INTENTO ${snap.reconnectAttempt})` : ''
    footerText = `RECONECTANDO${attempt} // ${snap.schedulerRunning ? 'FLYWHEEL MANTIENE EL TEMPO' : 'SIN TRANSPORTE'}`
  }

  return (
    <div className="stage-view" ref={rootRef}>
      {/* HIGH VISIBILITY SETLIST JUMP ALERT BANNER */}
      <SetlistJumpBanner alert={snap.jumpAlert} onDismiss={session.dismissJumpAlert} />

      {/* Visual metronome: lit by CSS from data attributes set in rAF */}
      <div className="metronome-border top" />
      <div className="metronome-border right" />
      <div className="metronome-border bottom" />
      <div className="metronome-border left" />

      {/* TOP RACK BAR */}
      <div className="stage-rack-bar">
        <div className="rack-group-left">
          {linkState === 'FLYWHEEL' && (
            <span className="badge-hardware badge-flywheel">
              <FlywheelIcon size={13} />
              <span>FLYWHEEL ACTIVO</span>
            </span>
          )}

          <div className={`network-beacon ${LINK_STATE_CLASS[linkState]}`} title={snap.lastError ?? undefined}>
            <span className="beacon-shape" />
            <span>{LINK_STATE_LABEL[linkState]}</span>
            <span style={{ opacity: 0.75, fontFamily: 'var(--font-mono)', fontSize: '10px' }}>{clockText}</span>
          </div>

          {snap.localMuted && <span className="badge-hardware badge-flywheel">SILENCIO LOCAL</span>}

          {snap.active && snap.wakeMode === 'NO DISPONIBLE' && (
            <span
              className="wakelock-warning"
              title="El navegador no permite mantener la pantalla encendida (requiere HTTPS). Si se apaga, el metronomo se detiene."
            >
              PANTALLA PUEDE APAGARSE
            </span>
          )}
        </div>

        <div className="rack-group-right">
          <button type="button" className="btn-stage-icon" onClick={onLibrary} title="Biblioteca de setlists" aria-label="Biblioteca">
            <LibraryIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-stage-icon"
            onClick={() => setShowMixer(true)}
            title="Mezclador in-ear"
            aria-label="Mezclador"
          >
            <MixerIcon size={16} />
          </button>

          {isDirector && (
            <button
              type="button"
              className={`btn-stage-icon ${showDirectorControls ? 'active' : ''}`}
              onClick={() => setShowDirectorControls((v) => !v)}
              title="Mostrar u ocultar el mando del director"
              aria-label="Mando director"
            >
              <RemoteIcon size={16} />
            </button>
          )}

          <button type="button" className="btn-stage-icon" onClick={onSettings} title="Ajustes de temas y audio" aria-label="Configuracion">
            <SettingsIcon size={16} />
          </button>

          <button type="button" className="btn-stage-icon" onClick={toggleFullscreen} title="Pantalla completa" aria-label="Pantalla completa">
            <FullscreenIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-stage-icon"
            onClick={onExit}
            title="SALIR: cerrar la sesion y detener el metronomo"
            aria-label="Salir de la sesion"
            style={{ color: 'var(--accent-danger)' }}
          >
            <DisconnectIcon size={16} />
          </button>

          <div style={{ marginLeft: '4px' }}>
            <HardwareKnob label="IN-EAR" value={inEarVolume} onChange={handleVolume} />
          </div>
        </div>
      </div>

      <AudioArmButton audio={snap.audio} localMuted={snap.localMuted} onArm={handleArmAudio} />

      {/* SONG RIBBON: leader setlist; local setlist only when there is no leader */}
      {ribbon && (
        <SongRibbon
          label={ribbon.label}
          songs={ribbon.songs}
          currentSongId={state?.currentSongId ?? null}
          onSelectSong={handleSelectSongFromRibbon}
          disabled={!canCommand}
        />
      )}

      <VFDDisplay
        bpm={state?.bpm ?? null}
        status={state?.status ?? null}
        linkState={linkState}
        barRef={barRef}
        beatRef={beatRef}
      />

      {isDirector && showDirectorControls && (
        <DirectorRemoteToolbar
          status={state?.status ?? null}
          currentBpm={state?.bpm ?? null}
          run={run}
          onPanic={() => run('PANIC')}
          disabledReason={disabledReason}
          feedback={feedback}
        />
      )}

      {/* MAIN STAGE PROMPTER CENTER */}
      <div className="stage-prompter-center">
        <div className="prompter-meta-strip">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {currentSong && (
              <span className="prompter-chord-badge">
                TEMA {pad(currentSong.orderIndex + 1, 2)}/{pad(orderedSetlist.length, 2)}
              </span>
            )}
            <span className="prompter-song-name">{songTitle}</span>
          </div>
          {currentSong && (
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {currentSong.bpm} BPM{state && state.bpm !== currentSong.bpm ? ` // AJUSTADO A ${state.bpm}` : ''}
            </span>
          )}
        </div>

        <div className="prompter-lyrics-box">
          <div className="prompter-waiting">SIN LETRA</div>
          <div className="prompter-lyric-next" style={{ fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
            LA DISTRIBUCION DE LETRAS DESDE EL LIDER ESTA PENDIENTE
          </div>
          {nextSong && (
            <div className="prompter-lyric-next">
              SIGUIENTE: {nextSong.title} // {nextSong.bpm} BPM
            </div>
          )}
        </div>

        <div className="beat-indicator-strip" ref={pillsRef}>
          {Array.from({ length: beatsPerBar }, (_, i) => i + 1).map((n) => (
            <div key={n} data-beat-pill={n} className={`beat-pill ${n === 1 ? 'downbeat' : ''}`} />
          ))}
        </div>
      </div>

      <EmergencySlide
        onTrigger={handleEmergencyStop}
        label={
          isDirector
            ? '>>> MANTEN PARA PANIC (DETIENE A TODA LA BANDA) >>>'
            : '>>> MANTEN PARA SILENCIO LOCAL (SOLO ESTE EQUIPO) >>>'
        }
      />
      {panicNote && (
        <div className="stage-footer" role="status" style={{ color: 'var(--accent-danger)', justifyContent: 'center' }}>
          {panicNote}
        </div>
      )}

      <div className="stage-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: connected ? 'var(--accent-success)' : 'var(--accent-danger)',
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span>{footerText}</span>
          {!connected && snap.lastError && <span style={{ opacity: 0.7 }}>// {snap.lastError}</span>}
        </div>
        {snap.protocolError ? (
          <span style={{ color: 'var(--accent-danger)' }}>PROTOCOLO: {snap.protocolError}</span>
        ) : (
          <span>PANTALLA: {snap.wakeMode} // BANDAIT 3.0 // PROTOCOLO V3</span>
        )}
      </div>

      <MultiTrackMixer
        songId={state?.currentSongId ?? 'sin_cancion'}
        isOpen={showMixer}
        onClose={() => setShowMixer(false)}
        initialMasterVolume={inEarVolume}
        onMasterVolumeChange={handleVolume}
        panicMuted={snap.localMuted}
        onPanicMuteChange={handlePanicMute}
      />
    </div>
  )
}
