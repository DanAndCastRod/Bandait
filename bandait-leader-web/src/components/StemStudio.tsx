import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ChevronDown, Minus, Pause, Play, Plus, Repeat, RotateCcw, Sliders, Square, Trash2 } from 'lucide-react'
import type { Song } from '../types/hub'
import { useGlobalAudioEngine } from '../context/globalAudioContextCore'
import { KNOWN_STEM_ROLES, STEM_ROLE_CODES, stemRoleLabel, type StemRole } from '../services/stemNames'
import { defaultLabels, formatBytes } from '../services/stemImport'
import type { StemPlayer } from '../services/stemPlayer'
import type { StemMix, StemTrackStatus } from '../services/stemSession'
import {
  PITCH_MAX,
  PITCH_MIN,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  clampPitch,
  formatPitch,
  formatRampStep,
  formatSpeed,
  normalizeRamp,
  parseRampStep,
  parseSpeed,
  rampLabel,
  stepSpeed,
  type SpeedRamp,
} from '../services/stemPractice'
import { clampOffset, deleteStemTrack, StemStoreError, updateStemMeta, type StemSongRecord } from '../services/stemStore'
import { formatClock, sectionSpans, type LoopRegion } from '../services/stemTiming'
import { CommitInput } from './CommitInput'
import { StudioApiContext, type StudioApi } from './studioApi'
import { colors, labelStyle, mono, smallInputStyle } from './hubStyles'
import '../styles/audio.css'

interface Props {
  song: Song
  record: StemSongRecord
  /** Metadatos cambiados (offset, rol) o null si se borro la ultima pista. */
  onRecordChange: (record: StemSongRecord | null) => void
  /**
   * Recibe el reproductor al montarse y null al desmontarse (el reproductor sigue vivo en el
   * audio global). Lo usa ENSAYO para seguir la posicion con rAF.
   */
  onPlayer?: (player: StemPlayer | null) => void
  /**
   * 'studio' (PISTAS, por defecto): todo en una columna, con rol y quitar pista.
   * 'rehearsal' (ENSAYO): transporte y `stage` (el prompter) en la columna principal; repetir y
   * una mezcla compacta (M, S, volumen) en un panel lateral que en el telefono se pliega.
   */
  layout?: 'studio' | 'rehearsal'
  /** Contenido principal de 'rehearsal'; lee el transporte con useStudioApi(). */
  stage?: React.ReactNode
  /** 'rehearsal': enlace a PISTAS para cambiar roles o quitar pistas. */
  onManageTracks?: () => void
  /**
   * Tono del audio en semitonos (+-6), controlado por el padre: ENSAYO lo vincula a la
   * transposicion de acordes. Sin el, StemStudio lo guarda por su cuenta.
   */
  pitch?: number
  onPitchChange?: (semitones: number) => void
  /** Vinculo tono del audio / acordes (solo si el padre lo maneja). */
  pitchLinked?: boolean
  onPitchLinkedChange?: (linked: boolean) => void
  /** Aviso del padre bajo el tono (acordes fuera de +-6: el audio suena en otra octava). */
  pitchNote?: string | null
}

const DB_MIN = -30
const DB_MAX = 6

function formatDb(db: number): string {
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
}

/** Ancho desde el que la mezcla de ENSAYO arranca abierta (panel lateral). */
const WIDE_QUERY = '(min-width: 1100px)'

/**
 * Estudio de una cancion: reproduce sus stems guardados, alineados. El reproductor NO es de este
 * componente: lo da el audio global (context/GlobalAudioContext.tsx), asi que cambiar de vista no
 * corta el audio y volver a la misma cancion recupera posicion, velocidad, tono, repeticion y
 * mezcla. Se monta con key = cancion + ids de pistas: otra cancion u otras pistas piden otro
 * reproductor y el audio global libera el anterior.
 */
export const StemStudio: React.FC<Props> = ({
  song,
  record,
  onRecordChange,
  onPlayer,
  layout = 'studio',
  stage,
  onManageTracks,
  pitch: pitchProp,
  onPitchChange,
  pitchLinked,
  onPitchLinkedChange,
  pitchNote,
}) => {
  const rehearsal = layout === 'rehearsal'
  const audio = useGlobalAudioEngine()
  // Pedir (o reusar) el reproductor una sola vez por montaje: la key del padre cambia con la cancion.
  const [session] = useState(() => audio.acquireStem({ song, record, view: rehearsal ? 'rehearsal' : 'tracks' }))
  const player = session.player
  const [initialUi] = useState(() => session.ui)

  const subscribeLoad = useCallback((listener: () => void) => session.onLoad(listener), [session])
  const getLoad = useCallback(() => session.getLoad(), [session])
  const load = useSyncExternalStore(subscribeLoad, getLoad, getLoad)
  const { status, loadError, duration, shifter } = load

  const subscribeState = useCallback((listener: () => void) => player.onStateChange(listener), [player])
  const getState = useCallback(() => player.getState(), [player])
  const playState = useSyncExternalStore(subscribeState, getState, getState)

  const [mixerOpen, setMixerOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia || window.matchMedia(WIDE_QUERY).matches)
  const [mix, setMix] = useState<Record<string, StemMix>>(initialUi.mix)
  const [masterDb, setMasterDb] = useState(initialUi.masterDb)
  const [loopMode, setLoopMode] = useState<string>(initialUi.loopMode)
  const [ab, setAb] = useState<{ a: number; b: number }>(initialUi.ab)
  const [offsetMs, setOffsetMs] = useState(record.offsetMs)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Practica: velocidad, tono (propio o del padre) y Speed Ramp.
  const [speed, setSpeed] = useState(initialUi.speed)
  const [localPitch, setLocalPitch] = useState(initialUi.localPitch)
  const pitch = pitchProp ?? localPitch
  const setPitch = onPitchChange ?? setLocalPitch
  const [ramp, setRamp] = useState<SpeedRamp>(initialUi.ramp)

  const posTextRef = useRef<HTMLSpanElement>(null)
  const posRangeRef = useRef<HTMLInputElement>(null)
  const rateTextRef = useRef<HTMLSpanElement>(null)
  const lastRateText = useRef('')
  const draggingRef = useRef(false)

  // Lo que se ve al volver a esta cancion: se guarda en la sesion global en cada cambio.
  useEffect(() => {
    session.saveUi({ mix, masterDb, loopMode, ab, speed, localPitch, ramp })
  }, [session, mix, masterDb, loopMode, ab, speed, localPitch, ramp])

  // Titulo y vista vigentes para el mini reproductor.
  useEffect(() => {
    session.touch(rehearsal ? 'rehearsal' : 'tracks', song)
  }, [session, rehearsal, song])

  // Ultimo onPlayer sin volver a avisar si el padre pasa otra funcion en cada render.
  const onPlayerRef = useRef(onPlayer)
  useEffect(() => {
    onPlayerRef.current = onPlayer
  }, [onPlayer])
  useEffect(() => {
    onPlayerRef.current?.(player)
    return () => onPlayerRef.current?.(null)
  }, [player])

  // Pinta la posicion escribiendo al DOM: nada de estado React por frame.
  const paint = useCallback(() => {
    const pos = player.position()
    const dur = player.duration
    if (posTextRef.current) posTextRef.current.textContent = `${formatClock(pos)} / ${formatClock(dur)}`
    if (posRangeRef.current && !draggingRef.current) posRangeRef.current.value = String(pos)
    // Velocidad que se oye y vuelta del Speed Ramp: solo se escribe al cambiar (cada vuelta).
    let rateText = ''
    const st = player.practiceStatus()
    if (st.lap !== null) rateText = `RAMPA ${rampLabel(player.getSpeedRamp(), st.lap)}`
    else if (Math.abs(st.rate - 1) > 1e-6) rateText = formatSpeed(st.rate)
    if (rateText !== lastRateText.current && rateTextRef.current) {
      lastRateText.current = rateText
      rateTextRef.current.textContent = rateText
    }
  }, [player])

  useEffect(() => {
    paint()
    if (playState !== 'playing') return
    let raf = 0
    const frame = () => {
      paint()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [playState, duration, paint])

  // Mezcla -> reproductor (sistema externo). Repetir los mismos valores al volver es inocuo.
  useEffect(() => {
    if (duration <= 0) return
    for (const [id, m] of Object.entries(mix)) {
      player.setTrackVolume(id, m.db)
      player.setTrackMute(id, m.muted)
      player.setTrackSolo(id, m.solo)
    }
  }, [player, mix, duration])

  useEffect(() => {
    player.setMasterVolume(masterDb)
  }, [player, masterDb, duration])

  // Velocidad, tono y Speed Ramp -> reproductor (idempotentes). Se repinta aunque este en pausa.
  useEffect(() => {
    if (duration <= 0) return
    player.setSpeed(speed)
    player.setPitch(pitch)
    player.setSpeedRamp(ramp)
    paint()
  }, [player, speed, pitch, ramp, duration, paint])

  const spans = useMemo(() => sectionSpans(song, offsetMs), [song, offsetMs])

  const region: LoopRegion | null = useMemo(() => {
    if (loopMode === 'ab') return ab.b > ab.a ? { start: ab.a, end: ab.b } : null
    if (loopMode.startsWith('sec:')) {
      const span = spans.find((s) => `sec:${s.id}` === loopMode)
      return span ? { start: span.startSec, end: span.endSec } : null
    }
    return null
  }, [loopMode, ab, spans])

  const regionStart = region?.start ?? null
  const regionEnd = region?.end ?? null
  useEffect(() => {
    if (duration <= 0) return
    // setLoop no hace nada si la region es la misma (volver a la vista no reinicia la rampa).
    player.setLoop(regionStart !== null && regionEnd !== null ? { start: regionStart, end: regionEnd } : null)
    paint()
  }, [player, regionStart, regionEnd, duration, paint])

  const appliedLoop = duration > 0 && regionStart !== null && regionEnd !== null && regionStart < duration
  const anyReady = Object.values(status).some((s) => s.kind === 'ok')
  const loading = Object.values(status).some((s) => s.kind === 'loading')

  const togglePlay = useCallback(() => {
    if (player.getState() === 'playing') player.pause()
    else void player.play()
  }, [player])

  const stop = () => {
    player.stop()
    paint()
  }

  const commitOffset = (text: string): boolean => {
    const value = Number(text.trim())
    if (!Number.isFinite(value)) return false
    const ms = clampOffset(value)
    setOffsetMs(ms)
    void updateStemMeta(song.id, { offsetMs: ms })
      .then((next) => {
        if (next) onRecordChange(next)
      })
      .catch((err) => setMetaError(err instanceof StemStoreError ? err.message : 'No se pudo guardar el offset.'))
    return true
  }

  const commitAb = (key: 'a' | 'b', text: string): boolean => {
    const value = Number(text.trim().replace(',', '.'))
    if (!Number.isFinite(value) || value < 0) return false
    setAb((prev) => ({ ...prev, [key]: Math.round(value * 10) / 10 }))
    return true
  }

  const markAb = (key: 'a' | 'b') => {
    const pos = player.position()
    setAb((prev) => ({ ...prev, [key]: Math.round(pos * 10) / 10 }))
  }

  const changeRole = (trackId: string, role: StemRole) => {
    const others = record.tracks.filter((t) => t.id !== trackId).map((t) => t.label)
    const [label] = defaultLabels([role], others)
    void updateStemMeta(song.id, { tracks: [{ id: trackId, role, label }] })
      .then((next) => {
        if (next) onRecordChange(next)
      })
      .catch((err) => setMetaError(err instanceof StemStoreError ? err.message : 'No se pudo cambiar el rol.'))
  }

  const removeTrack = (trackId: string) => {
    setConfirmDelete(null)
    void deleteStemTrack(song.id, trackId)
      .then((next) => {
        // Sin pistas no queda nada que reproducir: se libera el reproductor global.
        if (!next) audio.releaseStem(song.id)
        onRecordChange(next)
      })
      .catch((err) => setMetaError(err instanceof StemStoreError ? err.message : 'No se pudo quitar la pista.'))
  }

  const updateMix = (id: string, patch: Partial<StemMix>) =>
    setMix((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { db: 0, muted: false, solo: false }), ...patch } }))

  const sectionsUnavailable = spans.length === 0

  const seekTo = useCallback(
    (sec: number) => {
      player.seek(sec)
      paint()
    },
    [player, paint]
  )
  const toggleSectionLoop = useCallback((id: string) => setLoopMode((prev) => (prev === `sec:${id}` ? 'none' : `sec:${id}`)), [])
  const loopSectionId = loopMode.startsWith('sec:') ? loopMode.slice(4) : null
  const positionApi = useCallback(() => player.position(), [player])
  const toggleMixer = useCallback(() => setMixerOpen((open) => !open), [])
  const playing = playState === 'playing'
  const api = useMemo<StudioApi>(
    () => ({
      ready: anyReady,
      playing,
      togglePlay,
      position: positionApi,
      seek: seekTo,
      loopSectionId,
      toggleSectionLoop,
      mixerOpen,
      toggleMixer,
    }),
    [anyReady, playing, togglePlay, positionApi, seekTo, loopSectionId, toggleSectionLoop, mixerOpen, toggleMixer]
  )

  const loadAlert = loadError && (
    <div role="alert" className="ga-alert">
      {loadError}
    </div>
  )

  const masterVolume = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <label htmlFor="stem-master" style={{ ...labelStyle, flexShrink: 0 }}>
        {rehearsal ? 'GENERAL' : 'VOLUMEN GENERAL'}
      </label>
      <input
        id="stem-master"
        type="range"
        className="stx-range"
        min={DB_MIN}
        max={DB_MAX}
        step={0.5}
        value={masterDb}
        onChange={(e) => setMasterDb(Number(e.target.value))}
        style={{ flex: '1 1 120px', width: 'auto' }}
      />
      <span style={{ fontFamily: mono, fontSize: '11px', color: colors.text, minWidth: '60px', textAlign: 'right' }}>{formatDb(masterDb)}</span>
    </div>
  )

  // ---- practica: velocidad y tono ----
  const rampApplies = ramp.enabled && loopMode !== 'none'
  const pitchOff = shifter === 'unavailable'
  const commitSpeed = (text: string): boolean => {
    const v = parseSpeed(text)
    if (v === null) return false
    setSpeed(v)
    return true
  }
  const changePitch = (st: number) => setPitch(clampPitch(st))
  const resetPractice = () => {
    setSpeed(1)
    setPitch(0)
  }
  const practice = (
    <div className="sp-practice" data-testid="stem-practice" data-shifter={shifter} role="group" aria-label="Velocidad y tono">
      <div className="sp-row">
        <label htmlFor="stem-speed" className="sp-label" style={labelStyle}>
          VELOCIDAD
        </label>
        <button
          type="button"
          className="ga-round"
          aria-label="Bajar la velocidad 0,05"
          disabled={rampApplies || speed <= SPEED_MIN}
          onClick={() => setSpeed((s) => stepSpeed(s, -1))}
          style={{ width: '30px', height: '30px' }}
        >
          <Minus size={12} />
        </button>
        <input
          id="stem-speed"
          type="range"
          className="stx-range sp-range"
          data-testid="stem-speed"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={speed}
          aria-valuetext={formatSpeed(speed)}
          disabled={rampApplies}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
        <button
          type="button"
          className="ga-round"
          aria-label="Subir la velocidad 0,05"
          disabled={rampApplies || speed >= SPEED_MAX}
          onClick={() => setSpeed((s) => stepSpeed(s, 1))}
          style={{ width: '30px', height: '30px' }}
        >
          <Plus size={12} />
        </button>
        <CommitInput
          value={formatSpeed(speed)}
          onCommit={commitSpeed}
          ariaLabel="Velocidad exacta (0,50 a 1,25)"
          title="Velocidad exacta: 0,50 a 1,25 (también 75%)"
          testId="stem-speed-exact"
          inputMode="decimal"
          width="68px"
        />
      </div>
      <div className="sp-row">
        <label htmlFor="stem-pitch" className="sp-label" style={labelStyle}>
          TONO
        </label>
        <button
          type="button"
          className="ga-round"
          aria-label="Bajar el tono del audio medio tono"
          disabled={pitchOff || pitch <= PITCH_MIN}
          onClick={() => changePitch(pitch - 1)}
          style={{ width: '30px', height: '30px' }}
        >
          <Minus size={12} />
        </button>
        <input
          id="stem-pitch"
          type="range"
          className="stx-range sp-range"
          data-testid="stem-pitch"
          min={PITCH_MIN}
          max={PITCH_MAX}
          step={1}
          value={pitch}
          aria-valuetext={formatPitch(pitch)}
          disabled={pitchOff}
          onChange={(e) => changePitch(Number(e.target.value))}
        />
        <button
          type="button"
          className="ga-round"
          aria-label="Subir el tono del audio medio tono"
          disabled={pitchOff || pitch >= PITCH_MAX}
          onClick={() => changePitch(pitch + 1)}
          style={{ width: '30px', height: '30px' }}
        >
          <Plus size={12} />
        </button>
        <span data-testid="stem-pitch-value" className="sp-value" style={{ fontFamily: mono }}>
          {formatPitch(pitch)}
        </span>
      </div>
      <div className="sp-row sp-row-end">
        {onPitchLinkedChange && (
          <label className="sp-check">
            <input type="checkbox" data-testid="stem-pitch-link" checked={!!pitchLinked} onChange={(e) => onPitchLinkedChange(e.target.checked)} />
            <span>ACORDES SIGUEN EL TONO</span>
          </label>
        )}
        <button
          type="button"
          className="ga-pill"
          data-size="sm"
          data-tone="ghost"
          data-testid="stem-practice-reset"
          disabled={speed === 1 && pitch === 0}
          onClick={resetPractice}
          title="Velocidad 1,00x y tono original"
          style={{ marginLeft: 'auto' }}
        >
          <RotateCcw size={12} /> RESTABLECER
        </button>
      </div>
      {rampApplies && (
        <div className="sp-note" data-testid="stem-speed-ramp-note">
          El Speed Ramp maneja la velocidad mientras haya repetición.
        </div>
      )}
      {pitchOff && (
        <div className="sp-note sp-warn" role="status" data-testid="stem-pitch-unavailable">
          Este navegador no carga el procesador de audio: la velocidad cambia también el tono y el tono queda fijo.
        </div>
      )}
      {pitchNote && (
        <div className="sp-note" role="status" data-testid="stem-pitch-note">
          {pitchNote}
        </div>
      )}
    </div>
  )

  // ---- Speed Ramp ----
  const updateRamp = (patch: Partial<SpeedRamp>) => setRamp((prev) => normalizeRamp({ ...prev, ...patch }))
  const commitRampSpeed = (key: 'start' | 'top', text: string): boolean => {
    const v = parseSpeed(text)
    if (v === null) return false
    updateRamp({ [key]: v })
    return true
  }
  const commitRampStep = (text: string): boolean => {
    const v = parseRampStep(text)
    if (v === null) return false
    updateRamp({ step: v })
    return true
  }
  const rampPanel = (
    <div className="sp-ramp" data-testid="stem-ramp">
      <label className="sp-check">
        <input type="checkbox" data-testid="stem-ramp-toggle" checked={ramp.enabled} onChange={(e) => updateRamp({ enabled: e.target.checked })} />
        <span>SPEED RAMP: subir la velocidad en cada vuelta</span>
      </label>
      {ramp.enabled && (
        <>
          <div className="sp-row">
            <span style={labelStyle}>INICIO</span>
            <CommitInput value={formatSpeed(ramp.start)} onCommit={(t) => commitRampSpeed('start', t)} ariaLabel="Velocidad inicial de la rampa" testId="stem-ramp-start" inputMode="decimal" width="64px" />
            <span style={labelStyle}>PASO</span>
            <CommitInput value={formatRampStep(ramp.step)} onCommit={commitRampStep} ariaLabel="Aumento de velocidad por vuelta" testId="stem-ramp-step" inputMode="decimal" width="64px" />
            <span style={labelStyle}>TOPE</span>
            <CommitInput value={formatSpeed(ramp.top)} onCommit={(t) => commitRampSpeed('top', t)} ariaLabel="Velocidad tope de la rampa" testId="stem-ramp-top" inputMode="decimal" width="64px" />
          </div>
          <div className="sp-note">
            {loopMode === 'none'
              ? 'Elige una repetición (una sección o el tramo A-B) para que la rampa actúe.'
              : `Cada vuelta sube ${formatRampStep(ramp.step)} desde ${formatSpeed(ramp.start)} hasta ${formatSpeed(ramp.top)}. Cambiarla vuelve a la primera vuelta.`}
          </div>
        </>
      )}
    </div>
  )

  const transport = (
    <div data-testid="stem-transport" className="ga-panel" data-tight={rehearsal ? 'true' : undefined}>
      <div className="ga-transport-bar">
        <button type="button" className="ga-play" data-testid="stem-play" onClick={togglePlay} disabled={!anyReady} aria-label={playing ? 'Pausa' : 'Reproducir'}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button type="button" className="ga-round" data-testid="stem-stop" onClick={stop} disabled={!anyReady} aria-label="Detener">
          <Square size={13} />
        </button>
        <span ref={posTextRef} data-testid="stem-position" className="ga-clock" style={rehearsal ? { fontSize: '17px' } : undefined}>
          0:00.0 / 0:00.0
        </span>
        {loading && <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>DECODIFICANDO PISTAS...</span>}
        {appliedLoop && (
          <span data-testid="stem-loop-badge" className="ga-chip stx-fade-in" data-tone="success" style={{ marginLeft: 'auto' }}>
            <Repeat size={11} /> REPITIENDO {formatClock(Math.max(0, regionStart ?? 0))}-{formatClock(Math.min(duration, regionEnd ?? 0))}
          </span>
        )}
        {/* Velocidad que se oye / vuelta del Speed Ramp: la escribe paint() (rAF), no React. */}
        <span ref={rateTextRef} data-testid="stem-rate" className="sp-rate ga-chip" aria-live="polite" />
      </div>
      <input
        ref={posRangeRef}
        type="range"
        className="stx-range"
        aria-label="Posición"
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.01}
        defaultValue={0}
        disabled={!anyReady}
        onPointerDown={() => {
          draggingRef.current = true
        }}
        onPointerUp={(e) => {
          draggingRef.current = false
          player.seek(Number((e.target as HTMLInputElement).value))
          paint()
        }}
        onChange={(e) => {
          if (draggingRef.current) {
            if (posTextRef.current) posTextRef.current.textContent = `${formatClock(Number(e.target.value))} / ${formatClock(duration)}`
            return
          }
          player.seek(Number(e.target.value))
          paint()
        }}
      />
      {practice}
      {!rehearsal && masterVolume}
    </div>
  )

  const loopPanel = (
    <div className="ga-panel">
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <label htmlFor="stem-loop" style={labelStyle}>
            REPETIR
          </label>
          <select
            id="stem-loop"
            data-testid="stem-loop-select"
            className="stx-field"
            value={loopMode}
            onChange={(e) => setLoopMode(e.target.value)}
            style={{ ...smallInputStyle, width: '100%', marginTop: '4px', padding: '7px 10px' }}
          >
            <option value="none">Sin repetición</option>
            {spans.map((s) => (
              <option key={s.id} value={`sec:${s.id}`}>
                {s.label} · c. {s.startBar}-{s.startBar + s.bars - 1} · {formatClock(Math.max(0, s.startSec))}
              </option>
            ))}
            <option value="ab">Tramo A-B manual</option>
          </select>
        </div>
        <div style={{ flex: '0 0 auto' }}>
          <span style={labelStyle}>COMPÁS 1 EN EL AUDIO (ms)</span>
          <div style={{ marginTop: '4px' }}>
            <CommitInput
              value={String(offsetMs)}
              onCommit={commitOffset}
              ariaLabel="Offset de alineación en milisegundos"
              testId="stem-offset"
              inputMode="numeric"
              width="96px"
              title="Milisegundos desde el inicio del audio hasta el compás 1 (silencio inicial o conteo)"
            />
          </div>
        </div>
      </div>
      {sectionsUnavailable && (
        <div style={{ fontSize: '12px', color: colors.muted }}>
          {song.sections.length === 0
            ? 'Esta canción no tiene secciones con compases: usa el tramo A-B manual, o agrega secciones en CANCIONES.'
            : 'El tempo o los compases de la canción no son válidos: usa el tramo A-B manual.'}
        </div>
      )}
      {!sectionsUnavailable && (
        <div style={{ fontSize: '11px', color: colors.muted, fontFamily: mono }}>
          Secciones a {song.bpm} BPM, {song.beatsPerBar}/{song.beatUnit}. Si la repetición no cae en el compás, ajusta el offset.
        </div>
      )}
      {loopMode !== 'none' && duration > 0 && !appliedLoop && (loopMode !== 'ab' || ab.b > ab.a) && (
        <div data-testid="stem-loop-outside" style={{ fontSize: '12px', color: colors.warning }}>
          Ese tramo empieza después del final del audio ({formatClock(duration)}): revisa el offset o elige otra sección.
        </div>
      )}
      {loopMode === 'ab' && (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          {(['a', 'b'] as const).map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>{k.toUpperCase()} (s)</span>
              <CommitInput value={ab[k].toFixed(1)} onCommit={(t) => commitAb(k, t)} ariaLabel={`Punto ${k.toUpperCase()} en segundos`} width="72px" inputMode="decimal" />
              <button type="button" className="ga-pill" data-size="sm" onClick={() => markAb(k)} disabled={!anyReady}>
                MARCAR {k.toUpperCase()}
              </button>
            </div>
          ))}
          {ab.b <= ab.a && <span style={{ fontSize: '11px', color: colors.warning }}>B debe ser mayor que A.</span>}
        </div>
      )}
      {rampPanel}
    </div>
  )

  const metaAlert = metaError && (
    <div role="alert" className="ga-alert">
      {metaError}
    </div>
  )

  const trackRows = record.tracks.map((t) => {
    const st: StemTrackStatus = status[t.id] ?? { kind: 'error', message: 'Pista nueva: vuelve a abrir la canción.' }
    const m = mix[t.id] ?? { db: 0, muted: false, solo: false }
    const ok = st.kind === 'ok'
    const codeBadge = <span className="ga-code">{STEM_ROLE_CODES[t.role]}</span>
    const toggles = (
      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
        <button
          type="button"
          className="ga-toggle"
          data-kind="mute"
          aria-pressed={m.muted}
          aria-label={`Silenciar ${t.label}`}
          disabled={!ok}
          onClick={() => updateMix(t.id, { muted: !m.muted })}
        >
          M
        </button>
        <button
          type="button"
          className="ga-toggle"
          data-kind="solo"
          aria-pressed={m.solo}
          aria-label={`Solo ${t.label}`}
          disabled={!ok}
          onClick={() => updateMix(t.id, { solo: !m.solo })}
        >
          S
        </button>
      </div>
    )
    const fader = (
      <input
        type="range"
        className="stx-range"
        aria-label={`Volumen ${t.label}`}
        min={DB_MIN}
        max={DB_MAX}
        step={0.5}
        value={m.db}
        disabled={!ok}
        onChange={(e) => updateMix(t.id, { db: Number(e.target.value) })}
      />
    )
    const statusLine = (
      <>
        {st.kind === 'loading' && <div style={{ fontSize: '10px', color: colors.muted, fontFamily: mono }}>DECODIFICANDO...</div>}
        {st.kind === 'error' && (
          <div data-testid="stem-track-error" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: colors.danger }}>
            <AlertTriangle size={11} /> {st.message}
          </div>
        )}
      </>
    )

    // ENSAYO: fila compacta de consola (nombre, M, S y volumen). Roles y quitar viven en PISTAS.
    if (rehearsal) {
      return (
        <div key={t.id} data-testid="stem-track" data-role={t.role} data-status={st.kind} className="rh-track ga-track" style={{ opacity: m.muted ? 0.6 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {codeBadge}
            <span style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 600, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.label}>
              {t.label}
            </span>
            {toggles}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {fader}
            <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted, minWidth: '56px', textAlign: 'right' }}>{formatDb(m.db)}</span>
          </div>
          {statusLine}
        </div>
      )
    }

    return (
      <div key={t.id} data-testid="stem-track" data-role={t.role} data-status={st.kind} className="ga-track">
        {codeBadge}
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: colors.text, overflowWrap: 'anywhere' }}>{t.label}</div>
          <div style={{ fontSize: '10px', color: colors.muted, fontFamily: mono, overflowWrap: 'anywhere' }}>
            {t.fileName} · {formatBytes(t.size)}
          </div>
          {statusLine}
        </div>
        {toggles}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 180px', minWidth: 0 }}>
          {fader}
          <span style={{ fontFamily: mono, fontSize: '11px', color: colors.text, minWidth: '60px', textAlign: 'right' }}>{formatDb(m.db)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <select className="stx-field" value={t.role} aria-label={`Rol de ${t.label}`} onChange={(e) => changeRole(t.id, e.target.value as StemRole)} style={smallInputStyle}>
            {t.role === 'unknown' && <option value="unknown">Sin asignar</option>}
            {KNOWN_STEM_ROLES.map((role) => (
              <option key={role} value={role}>
                {stemRoleLabel(role)}
              </option>
            ))}
          </select>
          {confirmDelete === t.id ? (
            <>
              <button type="button" className="ga-pill" data-size="sm" data-tone="danger" onClick={() => removeTrack(t.id)}>
                QUITAR
              </button>
              <button type="button" className="ga-pill" data-size="sm" data-tone="ghost" onClick={() => setConfirmDelete(null)}>
                NO
              </button>
            </>
          ) : (
            <button type="button" className="ga-round" aria-label={`Quitar ${t.label}`} onClick={() => setConfirmDelete(t.id)} style={{ width: '30px', height: '30px', color: colors.danger, background: 'transparent' }}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    )
  })

  if (rehearsal) {
    const readyCount = Object.values(status).filter((s) => s.kind === 'ok').length
    return (
      <div data-testid="stem-studio" data-state={playState} data-layout="rehearsal" className="rh-grid">
        <div className="rh-main">
          {loadAlert}
          {transport}
          <StudioApiContext.Provider value={api}>{stage}</StudioApiContext.Provider>
        </div>
        <aside className="rh-side" aria-label="Repetir y mezcla">
          {loopPanel}
          {metaAlert}
          <details
            className="rh-mixer"
            data-testid="rehearsal-mixer"
            open={mixerOpen}
            onToggle={(e) => setMixerOpen((e.currentTarget as HTMLDetailsElement).open)}
            style={{ background: colors.cardAlt, borderRadius: 'var(--b-radius-card)', minWidth: 0 }}
          >
            <summary className="rh-mixer-summary">
              <span style={{ ...labelStyle, color: colors.text, fontWeight: 700 }}>MEZCLA</span>
              <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
                {readyCount}/{record.tracks.length} pistas
              </span>
              <ChevronDown size={14} className="rh-chevron" aria-hidden="true" />
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '0 12px 12px' }}>
              {masterVolume}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>{trackRows}</div>
              {onManageTracks && (
                <button type="button" className="ga-pill" data-size="sm" onClick={onManageTracks} style={{ alignSelf: 'flex-start' }}>
                  <Sliders size={12} /> ROLES Y PISTAS EN PISTAS
                </button>
              )}
            </div>
          </details>
        </aside>
      </div>
    )
  }

  return (
    <div data-testid="stem-studio" data-state={playState} style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      {loadAlert}
      {/* TRANSPORTE */}
      {transport}
      {/* REPETIR SECCION */}
      {loopPanel}
      {metaAlert}
      {/* PISTAS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>{trackRows}</div>
    </div>
  )
}
