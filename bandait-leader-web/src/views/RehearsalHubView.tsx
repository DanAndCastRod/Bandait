import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AArrowDown, AArrowUp, ArrowRight, CloudDownload, Keyboard, Maximize2, Minimize2, Minus, Music, Pause, Pencil, Play, Plus, Repeat, SkipBack, SkipForward, Sliders } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import { StemStudio } from '../components/StemStudio'
import { useStudioApi } from '../components/studioApi'
import { ChordProPreview } from '../components/ChordProPreview'
import { HubModal } from '../components/HubModal'
import { transposeChordPro, transposeKey } from '../services/chordpro'
import {
  DEFAULT_FONT_STEP,
  FONT_SCALES,
  PROMPTER_SHORTCUTS,
  barSeekTarget,
  barsLeftInSection,
  beatInBar,
  clampFontStep,
  keyTargetOf,
  keyToAction,
  sectionNavTarget,
} from '../services/prompterKeys'
import { listStemSongs, StemStoreError, type StemSongRecord } from '../services/stemStore'
import { downloadStems, getManifest, isCloudSongId, StemCloudError, type CloudManifest } from '../services/stemCloud'
import { formatBytes } from '../services/stemImport'
import type { StemPlayer } from '../services/stemPlayer'
import { barAtTime, sectionIndexAtBar, sectionSpans, type SectionSpan } from '../services/stemTiming'
import { useStemCloudTarget } from '../hooks/useStemCloudTarget'
import { onCloudStemsChanged } from '../services/stemCloudEvents'
import type { Song } from '../types/hub'
import { cardStyle, colors, labelStyle, mono, primaryButton, smallInputStyle, viewStyle } from '../components/hubStyles'

type PrompterMode = 'chords' | 'lyrics'

interface Props {
  onOpenTracks: () => void
  /** Abre la cancion en el editor de CANCIONES (para agregarle secciones). */
  onEditSong: (songId: string) => void
}

/** Consultas de manifiesto en paralelo al abrir ENSAYO (una por cancion sin stems locales). */
const MANIFEST_CONCURRENCY = 4

/**
 * ENSAYO: ensayo individual en casa. Reproduce los stems de una cancion (de este equipo, o
 * descargados de la nube de la banda) y sigue la seccion actual con su ChordPro. Usa el mismo
 * reproductor que PISTAS (StemStudio); el prompter lee la posicion con rAF y solo vuelve a pintar
 * React cuando cambia la seccion. Descargar es lectura: cualquier integrante puede hacerlo.
 */
export const RehearsalHubView: React.FC<Props> = ({ onOpenTracks, onEditSong }) => {
  const { songs } = useHub()
  const { target, bandKey } = useStemCloudTarget()
  const [records, setRecords] = useState<Map<string, StemSongRecord> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pickedId, setPickedId] = useState<string | null>(null)
  /** Manifiestos de la nube por `${bandKey}:${songId}` (null = sin stems en la nube). */
  const [cloud, setCloud] = useState<Map<string, CloudManifest | null>>(() => new Map())
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [download, setDownload] = useState<{ songId: string; done: number; total: number } | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    listStemSongs()
      .then((list) => {
        if (!cancelled) setRecords(new Map(list.map((r) => [r.songId, r])))
      })
      .catch((err) => {
        if (cancelled) return
        setRecords(new Map())
        setLoadError(err instanceof StemStoreError ? err.message : 'No se pudo leer el almacenamiento local.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const cloudKey = useCallback((songId: string) => `${bandKey}:${songId}`, [bandKey])

  // La nube cambio por otro camino (separar con Music AI): se usa el manifiesto nuevo o se vuelve a pedir.
  useEffect(
    () =>
      onCloudStemsChanged((change) => {
        if (change.band !== bandKey) return
        const key = cloudKey(change.songId)
        setCloud((prev) => {
          const next = new Map(prev)
          if (change.manifest) next.set(key, change.manifest)
          else next.delete(key)
          return next
        })
      }),
    [bandKey, cloudKey]
  )

  // Canciones sin stems en este navegador cuyo manifiesto falta consultar.
  const pending = useMemo(
    () => (target && records ? songs.filter((s) => !records.has(s.id) && isCloudSongId(s.id) && !cloud.has(cloudKey(s.id))) : []),
    [target, records, songs, cloud, cloudKey]
  )

  useEffect(() => {
    if (!target || pending.length === 0) return
    const queue = pending.filter((s) => !inFlight.current.has(cloudKey(s.id)))
    if (queue.length === 0) return
    for (const s of queue) inFlight.current.add(cloudKey(s.id))
    let firstError: string | null = null
    const results = new Map<string, CloudManifest | null>()
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const key = cloudKey(s.id)
        try {
          results.set(key, await getManifest(target, s.id))
        } catch (err) {
          results.set(key, null)
          if (!firstError) firstError = err instanceof StemCloudError ? err.message : 'No se pudo consultar la nube.'
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(MANIFEST_CONCURRENCY, queue.length) }, worker)).then(() => {
      for (const key of results.keys()) inFlight.current.delete(key)
      setCloud((prev) => new Map([...prev, ...results]))
      if (firstError) setCloudError(firstError)
    })
  }, [target, pending, cloudKey])

  const cloudOnly = useMemo(
    () =>
      records && target
        ? songs.filter((s) => !records.has(s.id) && (cloud.get(cloudKey(s.id))?.stems.length ?? 0) > 0)
        : [],
    [songs, records, target, cloud, cloudKey]
  )
  const options = useMemo(() => {
    const local = records ? songs.filter((s) => records.has(s.id)) : []
    return [...local.map((s) => ({ song: s, where: 'local' as const })), ...cloudOnly.map((s) => ({ song: s, where: 'cloud' as const }))].sort((a, b) =>
      a.song.title.localeCompare(b.song.title, 'es')
    )
  }, [songs, records, cloudOnly])

  const picked = options.find((o) => o.song.id === pickedId) ?? options[0] ?? null
  const song = picked?.song ?? null
  const record = song && records ? records.get(song.id) ?? null : null
  const manifest = song ? cloud.get(cloudKey(song.id)) ?? null : null
  const checkingCloud = pending.length > 0

  const setRecord = (songId: string, next: StemSongRecord | null) =>
    setRecords((prev) => {
      const map = new Map(prev ?? [])
      if (next) map.set(songId, next)
      else map.delete(songId)
      return map
    })

  const downloadSong = async (songId: string) => {
    if (!target || download) return
    setDownloadError(null)
    setDownload({ songId, done: 0, total: manifest?.stems.length ?? 0 })
    try {
      const { record: rec } = await downloadStems(target, songId, (done, total) => setDownload({ songId, done, total }))
      setRecord(songId, rec)
    } catch (err) {
      setDownloadError(err instanceof StemCloudError || err instanceof StemStoreError ? err.message : 'No se pudieron descargar los stems.')
    } finally {
      setDownload(null)
    }
  }

  return (
    <div style={viewStyle}>
      <div className="rh-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Music size={22} style={{ color: colors.cyan, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Ensayo</h2>
          </div>
          <p data-testid="rehearsal-context" style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted, maxWidth: '62ch' }}>
            Ensayo individual, en casa: toca encima de los stems y sigue la sección con sus acordes o su letra. En vivo manda el líder.
          </p>
        </div>
        {song && (
          <div style={{ minWidth: 0 }}>
            <label htmlFor="rehearsal-song" style={labelStyle}>
              CANCIÓN
            </label>
            <select
              id="rehearsal-song"
              data-testid="rehearsal-song-select"
              className="stx-field"
              value={song.id}
              onChange={(e) => {
                setPickedId(e.target.value)
                setDownloadError(null)
              }}
              style={{ ...smallInputStyle, width: '100%', marginTop: '4px', padding: '9px 10px', fontSize: '14px', fontFamily: 'inherit' }}
            >
              {options.map((o) => (
                <option key={o.song.id} value={o.song.id}>
                  {o.song.title} · {o.song.bpm} BPM · {o.where === 'local' ? 'en este equipo' : 'en la nube'}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loadError && (
        <div role="alert" style={{ ...cardStyle, padding: '10px 12px', color: colors.danger, fontSize: '12px', borderColor: colors.danger }}>
          {loadError}
        </div>
      )}

      {records === null && <div style={{ fontFamily: mono, fontSize: '12px', color: colors.muted }}>LEYENDO STEMS GUARDADOS...</div>}
      {checkingCloud && (
        <div data-testid="rehearsal-cloud-checking" style={{ fontFamily: mono, fontSize: '12px', color: colors.muted }}>
          CONSULTANDO LOS STEMS DE LA NUBE DE LA BANDA...
        </div>
      )}
      {cloudError && <div style={{ fontSize: '12px', color: colors.warning }}>{cloudError}</div>}

      {records !== null && !checkingCloud && options.length === 0 && (
        <div
          data-testid="rehearsal-empty"
          style={{ ...cardStyle, padding: '32px 16px', textAlign: 'center', color: colors.muted, fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}
        >
          <Music size={28} style={{ color: colors.disabled }} aria-hidden="true" />
          <span style={{ maxWidth: '52ch' }}>
            {target
              ? 'Ninguna canción de esta banda tiene stems en este equipo ni en la nube. Cárgalos en PISTAS y vuelve a ensayar.'
              : 'Ninguna canción de esta banda tiene stems en este equipo. Cárgalos en PISTAS y vuelve a ensayar.'}
          </span>
          <button type="button" className="stx-btn" onClick={onOpenTracks} style={{ ...primaryButton(colors.cobalt), color: colors.onAccent }}>
            <Sliders size={13} /> IR A PISTAS
          </button>
        </div>
      )}

      {song && !record && manifest && (
        <div
          data-testid="rehearsal-cloud-only"
          style={{ ...cardStyle, padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0, maxWidth: '720px' }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '18px', fontWeight: 800, color: colors.text }}>{song.title}</span>
            <span style={{ fontFamily: mono, fontSize: '11px', color: colors.cyan }}>EN LA NUBE</span>
          </div>
          <div style={{ fontSize: '13px', color: colors.muted }}>
            Sus stems están en la nube de la banda ({manifest.stems.length} stems, {formatBytes(manifest.stems.reduce((n, s) => n + s.size, 0))}). Descárgalos a
            este equipo para ensayar; quedan guardados aquí.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="stx-btn"
              data-testid="rehearsal-download"
              disabled={!!download}
              onClick={() => void downloadSong(song.id)}
              style={{ ...primaryButton(colors.cyan), color: colors.onAccent }}
            >
              <CloudDownload size={14} /> DESCARGAR PARA ENSAYAR
            </button>
            {download && download.songId === song.id && (
              <span data-testid="rehearsal-download-progress" style={{ fontFamily: mono, fontSize: '12px', color: colors.cobalt }}>
                DESCARGANDO {download.done}/{download.total}...
              </span>
            )}
          </div>
          {downloadError && (
            <div role="alert" style={{ fontSize: '12px', color: colors.danger }}>
              {downloadError}
            </div>
          )}
        </div>
      )}

      {song && record && (
        <RehearsalSession
          key={`${song.id}:${record.tracks.map((t) => t.id).join(',')}`}
          song={song}
          record={record}
          origin={picked?.where ?? 'local'}
          onRecordChange={(next) => setRecord(song.id, next)}
          onEditSong={() => onEditSong(song.id)}
          onOpenTracks={onOpenTracks}
        />
      )}
    </div>
  )
}

interface SessionProps {
  song: Song
  record: StemSongRecord
  origin: 'local' | 'cloud'
  onRecordChange: (record: StemSongRecord | null) => void
  onEditSong: () => void
  onOpenTracks: () => void
}

/** Tamano base del prompter: legible a un metro del portatil y sin desbordar en el telefono. */
const PROMPTER_SIZE = 'clamp(18px, 1rem + 1vw, 30px)'
/** En modo foco, la letra se lee desde el atril. */
const FOCUS_SIZE = 'clamp(24px, 1rem + 2.6vw, 60px)'
const FONT_STEP_KEY = 'bandait_rehearsal_font_step'
/** Puntos del pulso como maximo (compases de 12/8 y similares). */
const MAX_BEATS = 12

function readFontStep(): number {
  try {
    return clampFontStep(window.localStorage.getItem(FONT_STEP_KEY))
  } catch {
    return DEFAULT_FONT_STEP
  }
}

function saveFontStep(step: number) {
  try {
    window.localStorage.setItem(FONT_STEP_KEY, String(step))
  } catch {
    // Sin localStorage (modo privado, bloqueado): el tamano dura lo que dure la vista.
  }
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: mono,
    fontSize: '11px',
    fontWeight: 700,
    padding: '6px 10px',
    borderRadius: '4px',
    border: `1px solid ${active ? colors.cyan : colors.border}`,
    background: active ? colors.cyan : colors.elevated,
    color: active ? colors.onAccent : colors.muted,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
  }
}

const toolButton: React.CSSProperties = {
  ...chipStyle(false),
  color: colors.text,
  padding: '6px 8px',
  minWidth: '32px',
  justifyContent: 'center',
}

/**
 * Prompter + reproductor de una cancion. Se monta de nuevo al cambiar de cancion o de pistas.
 * Un solo rAF lee la posicion y escribe al DOM (compas, pulso, progreso); React solo vuelve a
 * pintar al cambiar de seccion o al entrar en los 2 ultimos compases de una.
 */
const RehearsalSession: React.FC<SessionProps> = ({ song, record, origin, onRecordChange, onEditSong, onOpenTracks }) => {
  const [mode, setMode] = useState<PrompterMode>('chords')
  const [current, setCurrent] = useState(-1)
  const [warn, setWarn] = useState(0)
  const [transpose, setTranspose] = useState(0)
  const [fontStep, setFontStep] = useState(readFontStep)
  const [focus, setFocus] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const playerRef = useRef<StemPlayer | null>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const pulseRef = useRef<HTMLDivElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const progressTextRef = useRef<HTMLSpanElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const lastBarText = useRef('')
  const lastProgressText = useRef('')
  const lastBeat = useRef(-2)
  const currentRef = useRef(-1)
  const warnRef = useRef(0)

  const offsetMs = record.offsetMs
  const spans = useMemo(() => sectionSpans(song, offsetMs), [song, offsetMs])
  const beats = Math.max(1, Math.min(MAX_BEATS, Math.round(song.beatsPerBar) || 4))
  const onPlayer = useCallback((p: StemPlayer | null) => {
    playerRef.current = p
  }, [])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const pos = playerRef.current ? playerRef.current.position() : 0
      const bar = barAtTime(pos, song.bpm, song.beatsPerBar, offsetMs)
      const idx = sectionIndexAtBar(spans, bar)
      if (idx !== currentRef.current) {
        currentRef.current = idx
        setCurrent(idx)
      }
      const span = idx >= 0 && idx < spans.length ? spans[idx] : null
      // Aviso de cambio: en los 2 ultimos compases, si viene otra seccion.
      const left = span && idx + 1 < spans.length ? barsLeftInSection(span, bar) : 0
      const nextWarn = left > 0 && left <= 2 ? left : 0
      if (nextWarn !== warnRef.current) {
        warnRef.current = nextWarn
        setWarn(nextWarn)
      }

      const text = !Number.isFinite(bar) ? '' : bar < 1 ? 'ANTES DEL COMPÁS 1' : `COMPÁS ${Math.floor(bar)}`
      if (text !== lastBarText.current && barRef.current) {
        lastBarText.current = text
        barRef.current.textContent = text
      }

      // Pulso: un punto por tiempo, el actual encendido (CSS anima transform y opacity).
      const beat = beatInBar(bar, song.beatsPerBar)
      if (beat !== lastBeat.current && pulseRef.current) {
        lastBeat.current = beat
        const dots = pulseRef.current.children
        for (let i = 0; i < dots.length; i++) (dots[i] as HTMLElement).dataset.on = i === beat ? '1' : '0'
      }

      // Progreso de la seccion actual.
      const within = span ? Math.min(1, Math.max(0, (bar - span.startBar) / span.bars)) : 0
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${within})`
      const ptext = span ? `compás ${Math.floor(bar) - span.startBar + 1} de ${span.bars}` : ''
      if (ptext !== lastProgressText.current && progressTextRef.current) {
        lastProgressText.current = ptext
        progressTextRef.current.textContent = ptext
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [spans, song.bpm, song.beatsPerBar, offsetMs, barRef, pulseRef, progressRef, progressTextRef])

  // Los nodos del compas, el pulso y el progreso se vuelven a montar al entrar o salir del modo
  // foco: se fuerza la proxima escritura.
  useEffect(() => {
    lastBarText.current = ''
    lastProgressText.current = ''
    lastBeat.current = -2
  }, [focus, current])

  // La seccion actual queda a la vista en el riel (solo se desplaza el riel, no la pagina).
  useEffect(() => {
    const rail = railRef.current
    const chip = rail?.querySelector<HTMLElement>(`[data-index="${Math.max(0, current)}"]`)
    if (!rail || !chip) return
    const left = chip.offsetLeft - rail.offsetLeft - (rail.clientWidth - chip.offsetWidth) / 2
    rail.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }, [current, focus, railRef])

  const changeFont = useCallback((delta: number) => {
    setFontStep((prev) => {
      const next = clampFontStep(prev + delta)
      saveFontStep(next)
      return next
    })
  }, [])

  return (
    <StemStudio
      song={song}
      record={record}
      onRecordChange={onRecordChange}
      onPlayer={onPlayer}
      layout="rehearsal"
      onManageTracks={onOpenTracks}
      stage={
        <RehearsalPrompter
          song={song}
          spans={spans}
          offsetMs={offsetMs}
          current={current}
          warn={warn}
          beats={beats}
          origin={origin}
          mode={mode}
          onMode={setMode}
          transpose={transpose}
          onTranspose={setTranspose}
          fontStep={fontStep}
          onFont={changeFont}
          focus={focus}
          onFocus={setFocus}
          helpOpen={helpOpen}
          onHelp={setHelpOpen}
          barRef={barRef}
          railRef={railRef}
          pulseRef={pulseRef}
          progressRef={progressRef}
          progressTextRef={progressTextRef}
          stageRef={stageRef}
          onEditSong={onEditSong}
        />
      }
    />
  )
}

interface PrompterProps {
  song: Song
  spans: SectionSpan[]
  /** Offset de alineacion de los stems (ms hasta el compas 1). */
  offsetMs: number
  current: number
  warn: number
  beats: number
  origin: 'local' | 'cloud'
  mode: PrompterMode
  onMode: (mode: PrompterMode) => void
  transpose: number
  onTranspose: React.Dispatch<React.SetStateAction<number>>
  fontStep: number
  onFont: (delta: number) => void
  focus: boolean
  onFocus: (focus: boolean) => void
  helpOpen: boolean
  onHelp: (open: boolean) => void
  barRef: React.RefObject<HTMLSpanElement | null>
  railRef: React.RefObject<HTMLDivElement | null>
  pulseRef: React.RefObject<HTMLDivElement | null>
  progressRef: React.RefObject<HTMLDivElement | null>
  progressTextRef: React.RefObject<HTMLSpanElement | null>
  stageRef: React.RefObject<HTMLElement | null>
  onEditSong: () => void
}

/**
 * Prompter de ENSAYO: barra de herramientas (tamano, tono, vista, foco, atajos), pulso, riel de
 * secciones, seccion actual con su progreso y la siguiente con aviso. Lee el transporte con
 * useStudioApi() (StemStudio lo provee) y atiende los atajos de teclado mientras esta montado.
 */
const RehearsalPrompter: React.FC<PrompterProps> = ({
  song,
  spans,
  offsetMs,
  current,
  warn,
  beats,
  origin,
  mode,
  onMode,
  transpose,
  onTranspose,
  fontStep,
  onFont,
  focus,
  onFocus,
  helpOpen,
  onHelp,
  barRef,
  railRef,
  pulseRef,
  progressRef,
  progressTextRef,
  stageRef,
  onEditSong,
}) => {
  const api = useStudioApi()
  const sections = song.sections
  const cur = current >= 0 && current < spans.length ? spans[current] : null
  const curSection = cur ? sections.find((s) => s.id === cur.id) ?? null : null
  const nextIdx = current < 0 ? 0 : current + 1
  const next = nextIdx < spans.length ? spans[nextIdx] : null
  const nextSection = next ? sections.find((s) => s.id === next.id) ?? null : null
  const status = spans.length === 0 ? 'none' : current < 0 ? 'before' : current >= spans.length ? 'after' : 'in'
  const targetKey = transpose === 0 ? song.key || null : transposeKey(song.key, transpose)
  const curBody = useMemo(() => (curSection ? transposeChordPro(curSection.chordpro, transpose, targetKey) : ''), [curSection, transpose, targetKey])
  const nextBody = useMemo(() => (nextSection ? transposeChordPro(nextSection.chordpro, transpose, targetKey) : ''), [nextSection, transpose, targetKey])
  const scale = FONT_SCALES[fontStep]
  const fontSize = `calc(${focus ? FOCUS_SIZE : PROMPTER_SIZE} * ${scale})`
  const songTiming = useMemo(() => ({ bpm: song.bpm, beatsPerBar: song.beatsPerBar, offsetMs }), [song.bpm, song.beatsPerBar, offsetMs])

  const go = useCallback((sec: number | null) => {
    if (sec !== null && Number.isFinite(sec) && api.ready) api.seek(Math.max(0, sec))
  }, [api])
  const sectionStep = useCallback((dir: -1 | 1) => go(sectionNavTarget(spans, api.position(), dir, songTiming)), [go, spans, api, songTiming])
  const toggleLoop = useCallback(() => {
    if (cur && api.ready) api.toggleSectionLoop(cur.id)
  }, [cur, api])

  // Modo foco: pantalla completa si el navegador la da; si no, una capa fija que cubre la vista.
  // Si se sale del foco antes de que el navegador conceda la pantalla completa (Esc rapido), al
  // llegar se devuelve: si no, quedaria en pantalla completa sin el modo foco.
  const wantFocusRef = useRef(false)
  const enterFocus = useCallback(() => {
    wantFocusRef.current = true
    onFocus(true)
    const stage = stageRef.current
    if (stage && typeof stage.requestFullscreen === 'function' && !document.fullscreenElement) {
      stage
        .requestFullscreen()
        .then(() => {
          if (!wantFocusRef.current && document.fullscreenElement && typeof document.exitFullscreen === 'function') document.exitFullscreen().catch(() => {})
        })
        .catch(() => {
          // Sin pantalla completa (iOS, iframe, permiso): queda la capa fija.
        })
    }
  }, [onFocus, stageRef])
  const exitFocus = useCallback(() => {
    wantFocusRef.current = false
    onFocus(false)
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') document.exitFullscreen().catch(() => {})
  }, [onFocus])

  // Si el navegador sale de pantalla completa por su cuenta (Esc), se sale del modo foco.
  useEffect(() => {
    let wasFull = false
    const onChange = () => {
      const full = !!document.fullscreenElement && document.fullscreenElement === stageRef.current
      if (wasFull && !full) {
        wantFocusRef.current = false
        onFocus(false)
      }
      wasFull = full
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [onFocus, stageRef])

  // Al desmontar (otra vista, otra cancion) no se queda la pantalla completa puesta.
  useEffect(
    () => () => {
      if (document.fullscreenElement && typeof document.exitFullscreen === 'function') document.exitFullscreen().catch(() => {})
    },
    []
  )

  // Atajos de teclado: solo con ENSAYO montado, sin modales abiertos y fuera de los campos de texto.
  const handler = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    handler.current = (e: KeyboardEvent) => {
      if (e.defaultPrevented || helpOpen) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const action = keyToAction(e, keyTargetOf(e.target as HTMLElement | null))
      if (!action) return
      switch (action.type) {
        case 'togglePlay':
          if (api.ready) api.togglePlay()
          break
        case 'bars':
          go(barSeekTarget(api.position(), action.delta, songTiming))
          break
        case 'section':
          sectionStep(action.dir)
          break
        case 'gotoSection':
          if (action.index < spans.length) go(spans[action.index].startSec)
          break
        case 'toggleLoop':
          toggleLoop()
          break
        case 'start':
          go(0)
          break
        case 'mode':
          onMode(action.mode)
          break
        case 'fontSize':
          onFont(action.delta)
          break
        case 'transpose':
          onTranspose((t) => Math.max(-11, Math.min(11, t + action.delta)))
          break
        case 'transposeReset':
          onTranspose(0)
          break
        case 'focus':
          if (focus) exitFocus()
          else enterFocus()
          break
        case 'exit':
          if (!focus) return
          exitFocus()
          break
        case 'mixer':
          api.toggleMixer()
          break
        case 'help':
          onHelp(true)
          break
      }
      e.preventDefault()
    }
  })
  useEffect(() => {
    // Espacio sobre un boton: se reproduce o pausa y el boton no se activa al soltar la tecla.
    let swallowSpaceUp = false
    const onDown = (e: KeyboardEvent) => {
      handler.current(e)
      if (e.defaultPrevented && e.key === ' ') swallowSpaceUp = true
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && swallowSpaceUp) {
        swallowSpaceUp = false
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [])

  // En modo foco, en pantallas tactiles: tocar el tercio izquierdo o derecho cambia de seccion.
  const onStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!focus || e.pointerType !== 'touch') return
    if ((e.target as HTMLElement).closest('button, a, input, select, summary')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / Math.max(1, rect.width)
    if (x < 1 / 3) sectionStep(-1)
    else if (x > 2 / 3) sectionStep(1)
  }

  const keyLabel = song.key || null

  const toolbar = (
    <div className="rh-toolbar" role="toolbar" aria-label="Herramientas del prompter">
      <div className="rh-toolgroup" role="group" aria-label="Tamaño de la letra">
        <button type="button" className="stx-btn" aria-label="Letra más chica" title="Letra más chica (-)" disabled={fontStep <= 0} onClick={() => onFont(-1)} style={toolButton}>
          <AArrowDown size={15} />
        </button>
        <button
          type="button"
          className="stx-btn"
          data-testid="rehearsal-font-up"
          aria-label="Letra más grande"
          title="Letra más grande (+)"
          disabled={fontStep >= FONT_SCALES.length - 1}
          onClick={() => onFont(1)}
          style={toolButton}
        >
          <AArrowUp size={15} />
        </button>
      </div>
      <div className="rh-toolgroup" role="group" aria-label="Transponer">
        <button type="button" className="stx-btn" aria-label="Bajar medio tono" title="Bajar medio tono (Shift T)" disabled={transpose <= -11} onClick={() => onTranspose((t) => Math.max(-11, t - 1))} style={toolButton}>
          <Minus size={14} />
        </button>
        {transpose === 0 ? (
          <span data-testid="rehearsal-key" style={{ ...toolButton, cursor: 'default', color: colors.muted, minWidth: '96px' }}>
            TONO {keyLabel ?? 'ORIGINAL'}
          </span>
        ) : (
          <button
            type="button"
            className="stx-btn"
            data-testid="rehearsal-key"
            aria-label={`Tono ${targetKey ?? ''}, ${transpose > 0 ? `+${transpose}` : transpose} semitonos. Volver al tono original`}
            title="Volver al tono original (Shift 0)"
            onClick={() => onTranspose(0)}
            style={{ ...toolButton, minWidth: '96px' }}
          >
            <span>TONO {keyLabel ?? ''}</span>
            {keyLabel && <ArrowRight size={12} aria-hidden="true" />}
            <span style={{ color: colors.cyan }}>{targetKey ?? ''}</span>
            <span style={{ color: colors.muted }}>{transpose > 0 ? `+${transpose}` : transpose}</span>
          </button>
        )}
        <button type="button" className="stx-btn" aria-label="Subir medio tono" title="Subir medio tono (T)" disabled={transpose >= 11} onClick={() => onTranspose((t) => Math.min(11, t + 1))} style={toolButton}>
          <Plus size={14} />
        </button>
      </div>
      <div className="rh-toolgroup" role="group" aria-label="Vista del prompter">
        {(['chords', 'lyrics'] as const).map((m) => (
          <button key={m} type="button" className="stx-btn" aria-pressed={mode === m} title={m === 'chords' ? 'Acordes (C)' : 'Solo letra (L)'} onClick={() => onMode(m)} style={chipStyle(mode === m)}>
            {m === 'chords' ? 'ACORDES' : 'LETRA'}
          </button>
        ))}
      </div>
      <div className="rh-toolgroup" style={{ marginLeft: 'auto' }}>
        <button
          type="button"
          className="stx-btn"
          data-testid="rehearsal-focus"
          aria-pressed={focus}
          aria-label={focus ? 'Salir del modo foco' : 'Modo foco'}
          title={focus ? 'Salir del modo foco (Esc)' : 'Modo foco (F)'}
          onClick={focus ? exitFocus : enterFocus}
          style={toolButton}
        >
          {focus ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button type="button" className="stx-btn" data-testid="rehearsal-help" aria-label="Atajos de teclado" title="Atajos de teclado (?)" onClick={() => onHelp(true)} style={toolButton}>
          <Keyboard size={15} />
        </button>
      </div>
    </div>
  )

  const pulse = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
      <span ref={barRef} data-testid="rehearsal-bar" style={{ fontFamily: mono, fontSize: '13px', fontWeight: 700, color: colors.cyan, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }} />
      <div ref={pulseRef} className="rh-pulse" data-testid="rehearsal-pulse" aria-hidden="true">
        {Array.from({ length: beats }, (_, i) => (
          <span key={i} className="rh-beat" data-accent={i === 0 ? '1' : '0'} data-on="0" />
        ))}
      </div>
    </div>
  )

  return (
    <section
      ref={stageRef}
      data-testid="rehearsal-prompter"
      data-focus={focus ? 'true' : 'false'}
      data-font-step={fontStep}
      aria-label="Prompter"
      className={focus ? 'rh-stage rh-focus' : 'rh-stage'}
      style={{ ...cardStyle, padding: focus ? 'clamp(14px, 3vw, 40px)' : 'clamp(14px, 2vw, 22px)', background: colors.oled }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 220px' }}>
          <div style={{ fontSize: focus ? '15px' : '18px', fontWeight: 800, color: focus ? colors.muted : colors.text, overflowWrap: 'anywhere' }}>{song.title}</div>
          {!focus && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px', fontFamily: mono, fontSize: '11px', color: colors.muted }}>
              {song.artist && <span>{song.artist}</span>}
              <span>{song.bpm} BPM</span>
              <span>
                {song.beatsPerBar}/{song.beatUnit}
              </span>
              <span style={{ color: origin === 'cloud' ? colors.cyan : colors.success }}>{origin === 'cloud' ? 'DE LA NUBE' : 'EN ESTE EQUIPO'}</span>
            </div>
          )}
        </div>
        {pulse}
      </div>

      {toolbar}

      {spans.length > 0 && (
        <div ref={railRef} className="rh-sections" role="list" aria-label="Secciones">
          {spans.map((s, i) => {
            const state = status === 'after' || i < current ? 'past' : i === current ? 'current' : 'next'
            const looping = api.loopSectionId === s.id
            return (
              <button
                key={s.id}
                type="button"
                role="listitem"
                className="rh-chip"
                data-index={i}
                data-state={state}
                data-testid="rehearsal-section-chip"
                aria-current={state === 'current' ? 'step' : undefined}
                aria-label={`Ir a ${s.label}, compases ${s.startBar} a ${s.startBar + s.bars - 1}`}
                title={i < 9 ? `Tecla ${i + 1}` : undefined}
                disabled={!api.ready}
                onClick={() => go(s.startSec)}
              >
                <span style={{ fontSize: '12px', fontWeight: 700, color: state === 'current' ? colors.cyan : colors.text, whiteSpace: 'nowrap' }}>
                  {i < 9 && <span style={{ fontFamily: mono, color: colors.disabled, marginRight: '6px' }}>{i + 1}</span>}
                  {s.label}
                </span>
                <span style={{ fontFamily: mono, fontSize: '10px', color: colors.muted, display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                  c. {s.startBar}-{s.startBar + s.bars - 1}
                  {looping && <Repeat size={10} style={{ color: colors.success }} aria-label="Se repite" />}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {status === 'none' && (
        <div data-testid="rehearsal-no-sections" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px', padding: '8px 0' }}>
          <span style={{ fontSize: '13px', color: colors.muted, maxWidth: '62ch' }}>
            {song.sections.length === 0
              ? 'Esta canción no tiene secciones con compases, así que no hay nada que seguir. Agrégalas en CANCIONES: a mano, pegando ChordPro o aceptando el borrador de ANALIZAR CON IA.'
              : 'El tempo o los compases de la canción no son válidos: revísalos en CANCIONES.'}
          </span>
          <button type="button" className="stx-btn" data-testid="rehearsal-edit-song" onClick={onEditSong} style={{ ...primaryButton(colors.violet), color: colors.onAccent }}>
            <Pencil size={13} /> ABRIR EN CANCIONES
          </button>
        </div>
      )}

      {status !== 'none' && (
        <div className="rh-stage-body" onPointerUp={onStagePointerUp}>
          <div
            key={current}
            data-testid="rehearsal-current"
            data-section-index={current}
            data-label={cur?.label ?? ''}
            className="stx-fade-in"
            style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, minHeight: '9em' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: focus ? 'clamp(24px, 1rem + 1.6vw, 40px)' : 'clamp(22px, 1.2rem + 0.8vw, 30px)', fontWeight: 800, color: colors.text, letterSpacing: '-0.5px' }}>
                {status === 'in' && cur ? cur.label : status === 'before' ? 'Antes de empezar' : 'Fin de la canción'}
              </span>
              <span ref={progressTextRef} data-testid="rehearsal-progress-text" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted, fontVariantNumeric: 'tabular-nums' }} />
              {status === 'in' && cur && !focus && (
                <button
                  type="button"
                  className="stx-btn"
                  data-testid="rehearsal-loop-current"
                  aria-pressed={api.loopSectionId === cur.id}
                  title="Repetir la sección (R)"
                  disabled={!api.ready}
                  onClick={toggleLoop}
                  style={{ ...chipStyle(api.loopSectionId === cur.id), marginLeft: 'auto', ...(api.loopSectionId === cur.id ? { background: colors.success, borderColor: colors.success } : {}) }}
                >
                  <Repeat size={12} /> {api.loopSectionId === cur.id ? 'REPITIENDO' : 'REPETIR SECCIÓN'}
                </button>
              )}
            </div>
            <div className="rh-progress" aria-hidden="true">
              <div ref={progressRef} className="rh-progress-fill" />
            </div>
            {status === 'in' && curSection && (
              <ChordProPreview
                chordpro={curBody}
                mode={mode}
                layout="flow"
                bare
                fontSize={fontSize}
                testId="rehearsal-current-chordpro"
                emptyText={mode === 'lyrics' ? 'Sección sin letra.' : 'Sección sin letra ni acordes.'}
              />
            )}
          </div>

          {next && (
            <div data-testid="rehearsal-next" data-label={next.label} data-warn={warn > 0 ? String(warn) : undefined} className="rh-next">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontFamily: mono, fontSize: '11px', color: colors.muted }}>
                <span>
                  SIGUIENTE: <strong style={{ color: colors.text }}>{next.label}</strong> · c. {next.startBar}-{next.startBar + next.bars - 1}
                </span>
                {warn > 0 && (
                  <span key={warn} data-testid="rehearsal-next-countdown" className="rh-countdown stx-fade-in">
                    {warn === 2 ? `${next.label} en 2` : 'en 1'}
                  </span>
                )}
              </div>
              {nextSection && (
                <ChordProPreview chordpro={nextBody} mode={mode} layout="flow" bare fontSize={focus ? 18 : 15} testId="rehearsal-next-chordpro" emptyText="Sin contenido." />
              )}
            </div>
          )}
        </div>
      )}

      {focus && (
        <div className="rh-focus-transport" role="group" aria-label="Transporte">
          <button type="button" className="stx-btn" aria-label="Sección anterior" disabled={!api.ready || spans.length === 0} onClick={() => sectionStep(-1)} style={{ ...toolButton, padding: '10px 14px' }}>
            <SkipBack size={16} />
          </button>
          <button
            type="button"
            className="stx-btn"
            data-testid="rehearsal-focus-play"
            aria-label={api.playing ? 'Pausa' : 'Reproducir'}
            disabled={!api.ready}
            onClick={api.togglePlay}
            style={{ ...primaryButton(colors.cobalt), color: colors.onAccent, padding: '10px 22px', minWidth: '120px' }}
          >
            {api.playing ? <Pause size={16} /> : <Play size={16} />}
            {api.playing ? 'PAUSA' : 'REPRODUCIR'}
          </button>
          <button type="button" className="stx-btn" aria-label="Sección siguiente" disabled={!api.ready || spans.length === 0} onClick={() => sectionStep(1)} style={{ ...toolButton, padding: '10px 14px' }}>
            <SkipForward size={16} />
          </button>
          <button
            type="button"
            className="stx-btn"
            aria-label="Repetir la sección"
            aria-pressed={!!cur && api.loopSectionId === cur.id}
            disabled={!api.ready || !cur}
            onClick={toggleLoop}
            style={{ ...chipStyle(!!cur && api.loopSectionId === cur.id), padding: '10px 14px', ...(cur && api.loopSectionId === cur.id ? { background: colors.success, borderColor: colors.success } : {}) }}
          >
            <Repeat size={16} />
          </button>
        </div>
      )}

      {!focus && (
        <div style={{ fontSize: '11px', color: colors.disabled, fontFamily: mono }}>
          Pulsa ? para ver los atajos. Tempo de práctica: todavía no; cambiar la velocidad en Web Audio también cambia el tono.
        </div>
      )}

      {helpOpen && (
        <HubModal title="ATAJOS DE TECLADO" onClose={() => onHelp(false)} maxWidth="560px" testId="rehearsal-shortcuts">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <tbody>
              {PROMPTER_SHORTCUTS.map((s) => (
                <tr key={s.action} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <td style={{ padding: '8px 12px 8px 0', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                    {s.keys.map((k) => (
                      <kbd key={k} className="rh-kbd">
                        {k}
                      </kbd>
                    ))}
                  </td>
                  <td style={{ padding: '8px 0', color: colors.text }}>{s.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: '12px 0 0', fontSize: '12px', color: colors.muted }}>
            Los atajos no actúan mientras escribes en un campo. En modo foco, en el teléfono, toca el tercio izquierdo o derecho de la letra para cambiar de sección.
          </p>
        </HubModal>
      )}
    </section>
  )
}
