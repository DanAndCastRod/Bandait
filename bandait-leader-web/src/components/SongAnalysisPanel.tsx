import React, { useEffect, useRef, useState } from 'react'
import { CloudDownload, Copy, RefreshCw, Sparkles, X } from 'lucide-react'
import type { Song, SongSection } from '../types/hub'
import { downloadStems, getManifest, isCloudSongId, StemCloudError } from '../services/stemCloud'
import { listStemSongs, loadStemSong, StemStoreError } from '../services/stemStore'
import { mixStemsToWav, MixError } from '../services/stemMix'
import {
  ANALYSIS_POLL_MS,
  ANALYSIS_TIMEOUT_MS,
  analysisErrorMessage,
  draftToSongSections,
  getAnalysis,
  startAnalysis,
  type AnalysisDraft,
} from '../services/stemAnalysis'
import { BPM_MAX, BPM_MIN, SECTION_KIND_LABELS } from '../services/workspaceSchema'
import { uuidv4 } from '../services/uuid'
import { useStemCloudTarget } from '../hooks/useStemCloudTarget'
import { ChordProPreview } from './ChordProPreview'
import { cardStyle, colors, ghostButton, inputStyle, mono, primaryButton } from './hubStyles'

export interface AcceptedDraft {
  sections: SongSection[]
  /** Solo si el usuario marco aplicar el BPM sugerido. */
  bpm?: number
  /** Solo si el usuario marco aplicar el tono sugerido. */
  key?: string
}

interface Props {
  song: Song
  /** Tiempos por compas del formulario (para avisar si el borrador asume otros). */
  beatsPerBar: number
  onAccept: (accepted: AcceptedDraft) => void
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'working'; text: string }
  | { kind: 'running'; since: number }
  | { kind: 'draft'; draft: AnalysisDraft; createdAt: string | null }
  | { kind: 'failed'; message: string }
  | { kind: 'accepted'; count: number }
  | { kind: 'dismissed' }
  /** Quien no es editor y no hay borrador que mostrar: el panel no aparece. */
  | { kind: 'hidden' }

/** De donde saldria la mezcla para analizar. */
type StemSource = 'checking' | 'local' | 'cloud' | 'none'

function errorText(err: unknown): string {
  if (err instanceof MixError || err instanceof StemCloudError || err instanceof StemStoreError) return err.message
  return 'No se pudo completar el análisis.'
}

/** Reloj para el limite de espera del analisis (fuera del componente: no es parte del render). */
function nowMs(): number {
  return Date.now()
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * ANALIZAR CON IA, dentro del editor de una cancion. Con sesion de nube, al abrir el editor
 * consulta el ultimo analisis guardado (lo pudo lanzar el lider): el borrador se ve aunque los
 * stems no esten en este navegador. Editores: ACEPTAR (reemplaza las secciones del formulario sin
 * guardar), DESCARTAR y ANALIZAR, que usa los stems de este equipo o primero los descarga de la
 * nube. Los demas integrantes ven el borrador en solo lectura, si el Worker se lo entrega.
 */
export const SongAnalysisPanel: React.FC<Props> = ({ song, beatsPerBar, onAccept }) => {
  const { target, canEdit } = useStemCloudTarget()
  const [hasLocal, setHasLocal] = useState<boolean | null>(null)
  const [cloudStems, setCloudStems] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [applyBpm, setApplyBpm] = useState(false)
  const [applyKey, setApplyKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)

  // Stems en este equipo (IndexedDB); sin nube, son la unica fuente.
  useEffect(() => {
    aliveRef.current = true
    let cancelled = false
    listStemSongs()
      .then((list) => {
        if (!cancelled) setHasLocal(list.some((r) => r.songId === song.id && r.tracks.length > 0))
      })
      .catch(() => {
        if (!cancelled) setHasLocal(false)
      })
    return () => {
      cancelled = true
      aliveRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [song.id])

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const poll = async (since: number) => {
    if (!target || !aliveRef.current) return
    try {
      const state = await getAnalysis(target, song.id)
      if (!aliveRef.current) return
      if (state.status === 'SUCCEEDED') {
        setApplyBpm(false)
        setApplyKey(false)
        setPhase({ kind: 'draft', draft: state.draft, createdAt: state.createdAt })
      } else if (!canEdit) {
        // Solo lectura: sin borrador terminado no hay nada que mostrarle.
        setPhase({ kind: 'hidden' })
      } else if (state.status === 'FAILED') setPhase({ kind: 'failed', message: state.error })
      else if (state.status === 'none') setPhase({ kind: 'none' })
      else if (nowMs() - since > ANALYSIS_TIMEOUT_MS) setPhase({ kind: 'failed', message: analysisErrorMessage('timeout') })
      else {
        setPhase({ kind: 'running', since })
        clearTimer()
        timerRef.current = setTimeout(() => void poll(since), ANALYSIS_POLL_MS)
      }
    } catch (err) {
      if (!aliveRef.current) return
      // Un no editor recibe 403 del Worker (hoy solo editores leen el analisis): sin panel.
      setPhase(canEdit ? { kind: 'failed', message: errorText(err) } : { kind: 'hidden' })
    }
  }

  // Al abrir el editor: primero el ultimo analisis; y si no hay stems aqui, si estan en la nube.
  const songCloudOk = !!target && isCloudSongId(song.id)
  useEffect(() => {
    if (!songCloudOk || !target) return
    let cancelled = false
    void (async () => {
      await poll(nowMs())
      if (cancelled || !canEdit) return
      try {
        const manifest = await getManifest(target, song.id)
        if (!cancelled) setCloudStems(manifest ? manifest.stems.length : 0)
      } catch {
        if (!cancelled) setCloudStems(0)
      }
    })()
    return () => {
      cancelled = true
    }
    // poll lee target/canEdit/song.id del render actual; solo se lanza al cambiar estos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songCloudOk, target, canEdit, song.id])

  const source: StemSource = hasLocal === null ? 'checking' : hasLocal ? 'local' : cloudStems === null ? 'checking' : cloudStems > 0 ? 'cloud' : 'none'

  // Sin nube (o con un id que el Worker no acepta): solo un aviso para editores.
  if (!songCloudOk) {
    if (!canEdit || (!target && !hasLocal)) return null
    return (
      <div data-testid="song-analysis" data-phase="no-cloud" style={{ ...cardStyle, padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: mono, fontSize: '12px', fontWeight: 700, color: colors.text }}>
          <Sparkles size={14} style={{ color: colors.violet }} /> ANALIZAR CON IA
        </span>
        <div style={{ fontSize: '12px', color: colors.muted }}>
          {target ? 'El id de esta canción no es válido para la nube.' : 'Necesitas una sesión de nube activa: el análisis corre en la nube de la banda.'}
        </div>
      </div>
    )
  }
  if (phase.kind === 'hidden' || (!canEdit && phase.kind !== 'draft')) return null

  const analyze = async () => {
    if (!target || !canEdit) return
    clearTimer()
    try {
      if (!hasLocal) {
        // Los stems estan en la nube y no en este navegador: primero se descargan a IndexedDB.
        setPhase({ kind: 'working', text: 'DESCARGANDO STEMS DE LA NUBE...' })
        await downloadStems(target, song.id, (done, total) => aliveRef.current && setPhase({ kind: 'working', text: `DESCARGANDO STEMS ${done}/${total}...` }))
        if (!aliveRef.current) return
        setHasLocal(true)
      }
      setPhase({ kind: 'working', text: 'LEYENDO STEMS...' })
      const loaded = await loadStemSong(song.id)
      if (!loaded) throw new MixError('La canción no tiene stems en este equipo.')
      const inputs = loaded.record.tracks.flatMap((t) => {
        const blob = loaded.blobs.get(t.id)
        return blob ? [{ role: t.role, blob }] : []
      })
      const wav = await mixStemsToWav(inputs, (text) => aliveRef.current && setPhase({ kind: 'working', text }))
      if (!aliveRef.current) return
      setPhase({ kind: 'working', text: `ENVIANDO MEZCLA (${(wav.size / (1024 * 1024)).toFixed(1)} MB)...` })
      await startAnalysis(target, song.id, wav)
      await poll(nowMs())
    } catch (err) {
      if (aliveRef.current) setPhase({ kind: 'failed', message: errorText(err) })
    }
  }

  const accept = (draft: AnalysisDraft) => {
    const accepted: AcceptedDraft = { sections: draftToSongSections(draft, uuidv4) }
    if (applyBpm && draft.bpm !== null && draft.bpm >= BPM_MIN && draft.bpm <= BPM_MAX) accepted.bpm = draft.bpm
    if (applyKey && draft.key) accepted.key = draft.key
    onAccept(accepted)
    setPhase({ kind: 'accepted', count: accepted.sections.length })
  }

  const copyLyrics = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => aliveRef.current && setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const reload = () => {
    setPhase({ kind: 'loading' })
    void poll(nowMs())
  }

  const busy = phase.kind === 'loading' || phase.kind === 'working' || phase.kind === 'running'
  const small: React.CSSProperties = { ...ghostButton, padding: '6px 10px', fontSize: '11px' }
  const analyzeButton = (again: boolean) => {
    const fromCloud = source === 'cloud'
    const label = fromCloud ? `DESCARGAR STEMS Y ANALIZAR${again ? ' DE NUEVO' : ''}` : again ? 'ANALIZAR DE NUEVO' : 'ANALIZAR'
    return (
      <button
        type="button"
        className="stx-btn"
        data-testid="analysis-start"
        disabled={busy || source === 'checking' || source === 'none'}
        title={source === 'none' ? 'No hay stems de esta canción en este equipo ni en la nube' : undefined}
        onClick={() => void analyze()}
        style={{ ...primaryButton(colors.violet), color: colors.onAccent, padding: '6px 12px', fontSize: '11px' }}
      >
        {fromCloud ? <CloudDownload size={13} /> : <Sparkles size={13} />} {label}
      </button>
    )
  }
  const noStemsNote =
    canEdit && source === 'none' ? (
      <div data-testid="analysis-no-stems" style={{ fontSize: '12px', color: colors.warning }}>
        No hay stems de esta canción en este equipo ni en la nube: cárgalos en PISTAS para poder analizarla.
      </div>
    ) : null

  return (
    <div data-testid="song-analysis" data-phase={phase.kind} style={{ ...cardStyle, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: mono, fontSize: '12px', fontWeight: 700, color: colors.text }}>
          <Sparkles size={14} style={{ color: colors.violet }} /> {canEdit ? 'ANALIZAR CON IA' : 'BORRADOR DEL ANÁLISIS CON IA'}
        </span>
        <span style={{ fontSize: '11px', color: colors.muted }}>Secciones, acordes por compás, BPM y tono a partir de los stems de la canción.</span>
      </div>

      {!canEdit && (
        <div data-testid="analysis-readonly" style={{ fontSize: '12px', color: colors.muted }}>
          Solo lectura: solo el Owner o el Director musical pueden aceptar este borrador o analizar de nuevo.
        </div>
      )}

      {phase.kind === 'loading' && <div style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>CONSULTANDO EL ÚLTIMO ANÁLISIS...</div>}

      {phase.kind === 'none' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: colors.muted }}>
            Esta canción no tiene análisis. Se envía una mezcla mono de los stems (sin clic ni guía) y tarda uno a tres minutos.
            {source === 'cloud' && ' Los stems están en la nube: primero se descargan a este equipo.'}
          </span>
          {analyzeButton(false)}
        </div>
      )}

      {phase.kind === 'working' && (
        <div data-testid="analysis-status" style={{ fontFamily: mono, fontSize: '11px', color: colors.cobalt }}>
          {phase.text}
        </div>
      )}
      {phase.kind === 'running' && (
        <div data-testid="analysis-status" style={{ fontFamily: mono, fontSize: '11px', color: colors.cobalt }}>
          ANALIZANDO EN LA NUBE... se consulta cada {ANALYSIS_POLL_MS / 1000} s. Puedes seguir editando.
        </div>
      )}

      {phase.kind === 'failed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div role="alert" data-testid="analysis-error" style={{ fontSize: '12px', color: colors.danger }}>
            {phase.message}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="stx-btn" onClick={reload} style={small}>
              <RefreshCw size={12} /> CONSULTAR DE NUEVO
            </button>
            {analyzeButton(true)}
          </div>
        </div>
      )}

      {phase.kind === 'accepted' && (
        <div data-testid="analysis-accepted" style={{ fontSize: '12px', color: colors.success }}>
          Borrador aplicado: {phase.count} secciones en el formulario. Revisa los compases y pulsa GUARDAR CANCIÓN para conservarlo.
        </div>
      )}
      {phase.kind === 'dismissed' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: colors.muted }}>Borrador descartado. Sigue guardado en la nube.</span>
          <button type="button" className="stx-btn" onClick={reload} style={small}>
            VER DE NUEVO
          </button>
          {analyzeButton(true)}
        </div>
      )}

      {phase.kind === 'draft' && (
        <DraftView
          draft={phase.draft}
          createdAt={phase.createdAt}
          song={song}
          beatsPerBar={beatsPerBar}
          readOnly={!canEdit}
          applyBpm={applyBpm}
          applyKey={applyKey}
          setApplyBpm={setApplyBpm}
          setApplyKey={setApplyKey}
          copied={copied}
          onCopy={copyLyrics}
          onAccept={() => accept(phase.draft)}
          onDismiss={() => setPhase({ kind: 'dismissed' })}
          analyzeAgain={canEdit ? analyzeButton(true) : null}
        />
      )}
      {noStemsNote}
    </div>
  )
}

interface DraftViewProps {
  draft: AnalysisDraft
  createdAt: string | null
  song: Song
  beatsPerBar: number
  /** Quien no es editor: sin casillas ni ACEPTAR / DESCARTAR. */
  readOnly: boolean
  applyBpm: boolean
  applyKey: boolean
  setApplyBpm: (v: boolean) => void
  setApplyKey: (v: boolean) => void
  copied: boolean
  onCopy: (text: string) => void
  onAccept: () => void
  onDismiss: () => void
  analyzeAgain: React.ReactNode | null
}

const DraftView: React.FC<DraftViewProps> = (p) => {
  const { draft } = p
  const bpmOk = draft.bpm !== null && draft.bpm >= BPM_MIN && draft.bpm <= BPM_MAX
  const lyrics = draft.lyrics_unplaced.join('\n')
  const totalBars = draft.sections.reduce((n, s) => n + s.bars, 0)
  return (
    <div data-testid="analysis-draft" style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontFamily: mono, fontSize: '11px', color: colors.muted }}>
        <span>
          BORRADOR{p.createdAt ? ` DEL ${formatDate(p.createdAt).toUpperCase()}` : ''} · {draft.sections.length} SECCIONES · {totalBars} COMPASES
        </span>
        {p.analyzeAgain && <span style={{ marginLeft: 'auto' }}>{p.analyzeAgain}</span>}
      </div>

      {p.readOnly ? (
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: colors.text }}>
          <span>
            BPM sugerido: <strong>{draft.bpm ?? 'sin dato'}</strong> <span style={{ color: colors.muted }}>(actual {p.song.bpm})</span>
          </span>
          <span>
            Tono sugerido: <strong>{draft.key ?? 'sin dato'}</strong> <span style={{ color: colors.muted }}>(actual {p.song.key || 'sin tono'})</span>
          </span>
        </div>
      ) : (
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: bpmOk ? colors.text : colors.disabled, cursor: bpmOk ? 'pointer' : 'not-allowed' }}>
          <input
            type="checkbox"
            className="stx-field"
            data-testid="analysis-apply-bpm"
            disabled={!bpmOk}
            checked={p.applyBpm}
            onChange={(e) => p.setApplyBpm(e.target.checked)}
            style={{ accentColor: colors.violet }}
          />
          BPM sugerido: <strong>{draft.bpm ?? 'sin dato'}</strong> <span style={{ color: colors.muted }}>(actual {p.song.bpm})</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: draft.key ? colors.text : colors.disabled, cursor: draft.key ? 'pointer' : 'not-allowed' }}>
          <input
            type="checkbox"
            className="stx-field"
            data-testid="analysis-apply-key"
            disabled={!draft.key}
            checked={p.applyKey}
            onChange={(e) => p.setApplyKey(e.target.checked)}
            style={{ accentColor: colors.violet }}
          />
          Tono sugerido: <strong>{draft.key ?? 'sin dato'}</strong> <span style={{ color: colors.muted }}>(actual {p.song.key || 'sin tono'})</span>
        </label>
      </div>
      )}
      {draft.beats_per_bar !== p.beatsPerBar && (
        <div style={{ fontSize: '11px', color: colors.warning }}>
          El borrador cuenta {draft.beats_per_bar} tiempos por compás y la canción tiene {p.beatsPerBar}: revisa los compases después de aceptar.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {draft.sections.map((s, i) => (
          <div key={i} data-testid="analysis-section" style={{ border: `1px solid ${colors.borderSoft}`, borderRadius: '4px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
            <div style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
              <strong style={{ color: colors.text }}>{s.label}</strong> · {SECTION_KIND_LABELS[s.kind]} · c. {s.start_bar}-{s.start_bar + s.bars - 1} ({s.bars} compases)
            </div>
            <ChordProPreview chordpro={s.chordpro} emptyText="Sin acordes detectados." />
          </div>
        ))}
        {draft.sections.length === 0 && <div style={{ fontSize: '12px', color: colors.warning }}>El análisis no encontró secciones.</div>}
      </div>

      {lyrics && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>LETRA SIN UBICAR (sin tiempos: pégala en cada sección)</span>
            <button type="button" className="stx-btn" onClick={() => p.onCopy(lyrics)} style={{ ...ghostButton, padding: '4px 8px', fontSize: '11px' }}>
              <Copy size={12} /> {p.copied ? 'COPIADA' : 'COPIAR LETRA'}
            </button>
          </div>
          <textarea readOnly aria-label="Letra sin ubicar" value={lyrics} rows={Math.min(8, draft.lyrics_unplaced.length + 1)} style={{ ...inputStyle, fontSize: '12px', resize: 'vertical' }} />
        </div>
      )}

      {draft.notes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '11px', color: colors.muted }}>
          {draft.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {!p.readOnly && (
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button type="button" className="stx-btn" data-testid="analysis-dismiss" onClick={p.onDismiss} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
          <X size={13} /> DESCARTAR
        </button>
        <button
          type="button"
          className="stx-btn"
          data-testid="analysis-accept"
          disabled={draft.sections.length === 0}
          onClick={p.onAccept}
          title="Reemplaza las secciones del formulario; la canción se guarda al pulsar GUARDAR CANCIÓN"
          style={{ ...primaryButton(colors.violet), color: colors.onAccent }}
        >
          ACEPTAR
        </button>
      </div>
      )}
    </div>
  )
}
