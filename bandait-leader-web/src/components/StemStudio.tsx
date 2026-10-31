import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Pause, Play, Repeat, Square, Trash2 } from 'lucide-react'
import type { Song } from '../types/hub'
import { KNOWN_STEM_ROLES, STEM_ROLE_CODES, stemRoleLabel, type StemRole } from '../services/stemNames'
import { defaultLabels, formatBytes } from '../services/stemImport'
import { StemPlayer, type PlayerState } from '../services/stemPlayer'
import { clampOffset, deleteStemTrack, loadStemSong, StemStoreError, updateStemMeta, type StemSongRecord } from '../services/stemStore'
import { formatClock, sectionSpans, type LoopRegion } from '../services/stemTiming'
import { CommitInput } from './CommitInput'
import { cardStyle, colors, ghostButton, labelStyle, mono, primaryButton, smallInputStyle } from './hubStyles'

interface Props {
  song: Song
  record: StemSongRecord
  /** Metadatos cambiados (offset, rol) o null si se borro la ultima pista. */
  onRecordChange: (record: StemSongRecord | null) => void
}

interface Mix {
  db: number
  muted: boolean
  solo: boolean
}

type TrackStatus = { kind: 'loading' } | { kind: 'ok' } | { kind: 'error'; message: string }

const DB_MIN = -30
const DB_MAX = 6

function formatDb(db: number): string {
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
}

function toggleStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    fontFamily: mono,
    fontSize: '11px',
    fontWeight: 700,
    minWidth: '30px',
    padding: '4px 8px',
    borderRadius: '3px',
    border: `1px solid ${active ? accent : colors.border}`,
    background: active ? accent : colors.elevated,
    color: active ? colors.onAccent : colors.muted,
    cursor: 'pointer',
  }
}

/**
 * Estudio de una cancion: decodifica sus stems guardados y los reproduce alineados.
 * Se monta con key = cancion + ids de pistas: cambiar de cancion o de pistas crea un reproductor
 * nuevo y libera el anterior (AudioContext cerrado, nodos desconectados).
 */
export const StemStudio: React.FC<Props> = ({ song, record, onRecordChange }) => {
  const [initialTracks] = useState(() => record.tracks)
  const [status, setStatus] = useState<Record<string, TrackStatus>>(() =>
    Object.fromEntries(record.tracks.map((t) => [t.id, { kind: 'loading' } as TrackStatus]))
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [playState, setPlayState] = useState<PlayerState>('stopped')
  const [mix, setMix] = useState<Record<string, Mix>>(() =>
    Object.fromEntries(record.tracks.map((t) => [t.id, { db: 0, muted: false, solo: false }]))
  )
  const [masterDb, setMasterDb] = useState(0)
  const [loopMode, setLoopMode] = useState<string>('none')
  const [ab, setAb] = useState<{ a: number; b: number }>({ a: 0, b: 0 })
  const [offsetMs, setOffsetMs] = useState(record.offsetMs)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const playerRef = useRef<StemPlayer | null>(null)
  const posTextRef = useRef<HTMLSpanElement>(null)
  const posRangeRef = useRef<HTMLInputElement>(null)
  const draggingRef = useRef(false)

  // Crear el reproductor y decodificar. Solo los callbacks async tocan el estado.
  useEffect(() => {
    const player = new StemPlayer()
    playerRef.current = player
    let cancelled = false
    const off = player.onStateChange((s) => {
      if (!cancelled) setPlayState(s)
    })
    void (async () => {
      try {
        const loaded = await loadStemSong(song.id)
        if (cancelled) return
        await player.load(
          initialTracks.map((t) => ({ id: t.id, blob: loaded?.blobs.get(t.id) ?? null })),
          (r) => {
            if (cancelled) return
            setStatus((prev) => ({ ...prev, [r.id]: r.ok ? { kind: 'ok' } : { kind: 'error', message: r.error } }))
          }
        )
        if (!cancelled) setDuration(player.duration)
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof StemStoreError ? err.message : err instanceof Error ? err.message : 'No se pudo preparar el audio.')
        setStatus((prev) => Object.fromEntries(Object.keys(prev).map((id) => [id, { kind: 'error', message: 'Sin cargar' } as TrackStatus])))
      }
    })()
    return () => {
      cancelled = true
      off()
      player.dispose()
      if (playerRef.current === player) playerRef.current = null
    }
  }, [song.id, initialTracks])

  // Pinta la posicion escribiendo al DOM: nada de estado React por frame.
  const paint = useCallback(() => {
    const player = playerRef.current
    const pos = player ? player.position() : 0
    const dur = player ? player.duration : 0
    if (posTextRef.current) posTextRef.current.textContent = `${formatClock(pos)} / ${formatClock(dur)}`
    if (posRangeRef.current && !draggingRef.current) posRangeRef.current.value = String(pos)
  }, [])

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

  // Mezcla -> reproductor (sistema externo).
  useEffect(() => {
    const player = playerRef.current
    if (!player || duration <= 0) return
    for (const [id, m] of Object.entries(mix)) {
      player.setTrackVolume(id, m.db)
      player.setTrackMute(id, m.muted)
      player.setTrackSolo(id, m.solo)
    }
  }, [mix, duration])

  useEffect(() => {
    playerRef.current?.setMasterVolume(masterDb)
  }, [masterDb, duration])

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
    const player = playerRef.current
    if (!player || duration <= 0) return
    player.setLoop(regionStart !== null && regionEnd !== null ? { start: regionStart, end: regionEnd } : null)
    paint()
  }, [regionStart, regionEnd, duration, paint])

  const appliedLoop = duration > 0 && regionStart !== null && regionEnd !== null && regionStart < duration
  const anyReady = Object.values(status).some((s) => s.kind === 'ok')
  const loading = Object.values(status).some((s) => s.kind === 'loading')

  const togglePlay = () => {
    const player = playerRef.current
    if (!player) return
    if (player.getState() === 'playing') player.pause()
    else void player.play()
  }

  const stop = () => {
    playerRef.current?.stop()
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
    const pos = playerRef.current?.position() ?? 0
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
      .then((next) => onRecordChange(next))
      .catch((err) => setMetaError(err instanceof StemStoreError ? err.message : 'No se pudo quitar la pista.'))
  }

  const updateMix = (id: string, patch: Partial<Mix>) =>
    setMix((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { db: 0, muted: false, solo: false }), ...patch } }))

  const sectionsUnavailable = spans.length === 0

  return (
    <div data-testid="stem-studio" data-state={playState} style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      {loadError && (
        <div role="alert" style={{ ...cardStyle, padding: '10px 12px', color: colors.danger, fontSize: '12px', borderColor: colors.danger }}>
          {loadError}
        </div>
      )}

      {/* TRANSPORTE */}
      <div style={{ ...cardStyle, padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="stx-btn"
            data-testid="stem-play"
            onClick={togglePlay}
            disabled={!anyReady}
            aria-label={playState === 'playing' ? 'Pausa' : 'Reproducir'}
            style={{ ...primaryButton(colors.cobalt), color: colors.onAccent, minWidth: '112px' }}
          >
            {playState === 'playing' ? <Pause size={14} /> : <Play size={14} />}
            {playState === 'playing' ? 'PAUSA' : 'REPRODUCIR'}
          </button>
          <button type="button" className="stx-btn" data-testid="stem-stop" onClick={stop} disabled={!anyReady} aria-label="Detener" style={ghostButton}>
            <Square size={13} /> STOP
          </button>
          <span
            ref={posTextRef}
            data-testid="stem-position"
            style={{ fontFamily: mono, fontSize: '15px', fontWeight: 700, color: colors.text, fontVariantNumeric: 'tabular-nums' }}
          >
            0:00.0 / 0:00.0
          </span>
          {loading && <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>DECODIFICANDO PISTAS...</span>}
          {appliedLoop && (
            <span
              data-testid="stem-loop-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontFamily: mono,
                fontSize: '11px',
                fontWeight: 700,
                color: colors.onAccent,
                background: colors.success,
                padding: '2px 8px',
                borderRadius: '3px',
              }}
            >
              <Repeat size={11} /> REPITIENDO {formatClock(Math.max(0, regionStart ?? 0))}-{formatClock(Math.min(duration, regionEnd ?? 0))}
            </span>
          )}
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
            playerRef.current?.seek(Number((e.target as HTMLInputElement).value))
            paint()
          }}
          onChange={(e) => {
            if (draggingRef.current) {
              if (posTextRef.current) posTextRef.current.textContent = `${formatClock(Number(e.target.value))} / ${formatClock(duration)}`
              return
            }
            playerRef.current?.seek(Number(e.target.value))
            paint()
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <label htmlFor="stem-master" style={{ ...labelStyle, flexShrink: 0 }}>
            VOLUMEN GENERAL
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
            style={{ flex: '1 1 160px', width: 'auto' }}
          />
          <span style={{ fontFamily: mono, fontSize: '11px', color: colors.text, minWidth: '64px' }}>{formatDb(masterDb)}</span>
        </div>
      </div>

      {/* REPETIR SECCION */}
      <div style={{ ...cardStyle, padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
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
              style={{ ...smallInputStyle, width: '100%', marginTop: '4px', padding: '6px 8px' }}
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
                <button type="button" className="stx-btn" onClick={() => markAb(k)} disabled={!anyReady} style={{ ...ghostButton, padding: '5px 8px', fontSize: '11px' }}>
                  MARCAR {k.toUpperCase()}
                </button>
              </div>
            ))}
            {ab.b <= ab.a && <span style={{ fontSize: '11px', color: colors.warning }}>B debe ser mayor que A.</span>}
          </div>
        )}
      </div>

      {metaError && (
        <div role="alert" style={{ color: colors.danger, fontSize: '12px' }}>
          {metaError}
        </div>
      )}

      {/* PISTAS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {record.tracks.map((t) => {
          const st = status[t.id] ?? { kind: 'error', message: 'Pista nueva: vuelve a abrir la canción.' }
          const m = mix[t.id] ?? { db: 0, muted: false, solo: false }
          const ok = st.kind === 'ok'
          return (
            <div
              key={t.id}
              data-testid="stem-track"
              data-role={t.role}
              data-status={st.kind}
              style={{
                ...cardStyle,
                padding: '10px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                minWidth: 0,
                borderColor: st.kind === 'error' ? colors.danger : colors.border,
              }}
            >
              <span
                style={{
                  fontFamily: mono,
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: '3px',
                  background: colors.borderSoft,
                  color: colors.text,
                }}
              >
                {STEM_ROLE_CODES[t.role]}
              </span>
              <div style={{ flex: '1 1 150px', minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: colors.text, overflowWrap: 'anywhere' }}>{t.label}</div>
                <div style={{ fontSize: '10px', color: colors.muted, fontFamily: mono, overflowWrap: 'anywhere' }}>
                  {t.fileName} · {formatBytes(t.size)}
                </div>
                {st.kind === 'loading' && <div style={{ fontSize: '10px', color: colors.muted, fontFamily: mono }}>DECODIFICANDO...</div>}
                {st.kind === 'error' && (
                  <div data-testid="stem-track-error" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: colors.danger }}>
                    <AlertTriangle size={11} /> {st.message}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  type="button"
                  className="stx-btn"
                  aria-pressed={m.muted}
                  aria-label={`Silenciar ${t.label}`}
                  disabled={!ok}
                  onClick={() => updateMix(t.id, { muted: !m.muted })}
                  style={toggleStyle(m.muted, colors.danger)}
                >
                  M
                </button>
                <button
                  type="button"
                  className="stx-btn"
                  aria-pressed={m.solo}
                  aria-label={`Solo ${t.label}`}
                  disabled={!ok}
                  onClick={() => updateMix(t.id, { solo: !m.solo })}
                  style={toggleStyle(m.solo, colors.warning)}
                >
                  S
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 180px', minWidth: 0 }}>
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
                <span style={{ fontFamily: mono, fontSize: '11px', color: colors.text, minWidth: '60px', textAlign: 'right' }}>{formatDb(m.db)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <select
                  className="stx-field"
                  value={t.role}
                  aria-label={`Rol de ${t.label}`}
                  onChange={(e) => changeRole(t.id, e.target.value as StemRole)}
                  style={smallInputStyle}
                >
                  {t.role === 'unknown' && <option value="unknown">Sin asignar</option>}
                  {KNOWN_STEM_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {stemRoleLabel(role)}
                    </option>
                  ))}
                </select>
                {confirmDelete === t.id ? (
                  <>
                    <button
                      type="button"
                      className="stx-btn"
                      onClick={() => removeTrack(t.id)}
                      style={{ ...ghostButton, padding: '5px 8px', fontSize: '11px', background: colors.danger, color: colors.onAccent, borderColor: colors.danger }}
                    >
                      QUITAR
                    </button>
                    <button type="button" className="stx-btn" onClick={() => setConfirmDelete(null)} style={{ ...ghostButton, padding: '5px 8px', fontSize: '11px' }}>
                      NO
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="stx-btn"
                    aria-label={`Quitar ${t.label}`}
                    onClick={() => setConfirmDelete(t.id)}
                    style={{ ...ghostButton, padding: '5px 7px', color: colors.danger }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
