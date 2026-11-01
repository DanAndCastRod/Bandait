import React, { useEffect, useRef, useState } from 'react'
import { AudioLines, CircleCheck, CloudDownload, FileAudio, RefreshCw, X } from 'lucide-react'
import { downloadStems, StemCloudError, type CloudManifest, type CloudTarget } from '../services/stemCloud'
import { StemStoreError, type StemSongRecord } from '../services/stemStore'
import { formatBytes } from '../services/stemImport'
import {
  SEPARATION_ACCEPT,
  separationFileProblem,
  separationStatusText,
  startSeparation,
  watchSeparation,
  type AnalysisState,
} from '../services/stemAnalysis'
import { cloudStemsChanged } from '../services/stemCloudEvents'
import { cardStyle, colors, ghostButton, mono, primaryButton } from './hubStyles'

interface Props {
  song: { id: string; title: string }
  target: CloudTarget
  /** Stems que la cancion ya tiene en la nube (null: todavia no se sabe). */
  cloudStemCount: number | null
  /** La cancion tiene stems en este navegador (IndexedDB). */
  hasLocal: boolean
  /** La separacion termino: manifiesto nuevo de la nube y borrador listo. */
  onDone?: (manifest: CloudManifest | null) => void
  /** Se descargaron los stems nuevos a este equipo. */
  onLocalReplaced?: (record: StemSongRecord) => void
  /** Texto corto de contexto bajo el titulo (cambia entre CANCIONES y PISTAS). */
  hint?: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm'; file: File }
  | { kind: 'uploading'; file: File; fraction: number | null }
  | { kind: 'watching'; state: AnalysisState }
  | { kind: 'done'; manifest: CloudManifest | null }
  | { kind: 'downloading'; manifest: CloudManifest | null; done: number; total: number }
  | { kind: 'downloaded'; count: number }
  | { kind: 'failed'; message: string }

function errorText(err: unknown): string {
  if (err instanceof StemCloudError || err instanceof StemStoreError) return err.message
  return 'No se pudo completar la separación.'
}

/** Fraccion de la barra de progreso de cada fase (subir 0-35 %, Music AI 35-45 %, copiar 45-100 %). */
function progressOf(phase: Phase): number | null {
  if (phase.kind === 'uploading') return phase.fraction === null ? null : 0.35 * phase.fraction
  if (phase.kind === 'watching') {
    const s = phase.state
    if (s.status === 'IMPORTING') return s.total > 0 ? 0.45 + 0.55 * (s.done / s.total) : 0.45
    if (s.status === 'SUCCEEDED') return 1
    return 0.4
  }
  if (phase.kind === 'downloading') return phase.total > 0 ? phase.done / phase.total : 0
  return null
}

/**
 * SUBIR CANCION Y SEPARAR: el editor sube el audio completo de la cancion, Music AI lo separa en
 * stems (voz, bateria, bajo, guitarras, teclados, otros), el Worker los copia a la nube de la
 * banda reemplazando los que hubiera y deja el borrador del analisis. Solo editores con nube:
 * la vista que lo monta lo decide. Al desmontarse deja de consultar.
 */
export const SplitUpload: React.FC<Props> = ({ song, target, cloudStemCount, hasLocal, onDone, onLocalReplaced, hint }) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  // La confirmacion aparece en linea, a veces debajo del borde visible (y en movil, bajo la barra
  // inferior fija): se trae a la vista con su scroll-margin y el foco pasa a CANCELAR.
  useEffect(() => {
    if (phase.kind !== 'confirm') return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    confirmRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
    cancelRef.current?.focus({ preventScroll: true })
  }, [phase.kind])

  const run = async (file: File) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ kind: 'uploading', file, fraction: null })
    try {
      await startSeparation(target, song.id, file, (fraction) => {
        if (!ctrl.signal.aborted) setPhase({ kind: 'uploading', file, fraction })
      })
      if (ctrl.signal.aborted) return
      setPhase({ kind: 'watching', state: { status: 'STARTED', jobId: null } })
      const final = await watchSeparation(target, song.id, {
        signal: ctrl.signal,
        onState: (state) => {
          if (!ctrl.signal.aborted && state.status !== 'SUCCEEDED' && state.status !== 'FAILED') setPhase({ kind: 'watching', state })
        },
      })
      if (!final || ctrl.signal.aborted) return
      if (final.status === 'FAILED') {
        setPhase({ kind: 'failed', message: final.error })
        return
      }
      const manifest = final.status === 'SUCCEEDED' ? final.stems : null
      cloudStemsChanged({ band: target.band, songId: song.id, manifest })
      setPhase({ kind: 'done', manifest })
      onDone?.(manifest)
    } catch (err) {
      if (!ctrl.signal.aborted) setPhase({ kind: 'failed', message: errorText(err) })
    }
  }

  const pick = (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return
    const problem = separationFileProblem(file)
    if (problem) {
      setPhase({ kind: 'failed', message: problem })
      return
    }
    if (cloudStemCount && cloudStemCount > 0) setPhase({ kind: 'confirm', file })
    else void run(file)
  }

  const downloadNew = async (manifest: CloudManifest | null) => {
    const ctrl = abortRef.current
    setPhase({ kind: 'downloading', manifest, done: 0, total: manifest?.stems.length ?? 0 })
    try {
      const { record } = await downloadStems(target, song.id, (done, total) => {
        if (!ctrl?.signal.aborted) setPhase({ kind: 'downloading', manifest, done, total })
      })
      if (ctrl?.signal.aborted) return
      onLocalReplaced?.(record)
      setPhase({ kind: 'downloaded', count: record.tracks.length })
    } catch (err) {
      if (!ctrl?.signal.aborted) setPhase({ kind: 'failed', message: errorText(err) })
    }
  }

  const busy = phase.kind === 'uploading' || phase.kind === 'watching' || phase.kind === 'downloading'
  const progress = progressOf(phase)
  const statusText =
    phase.kind === 'uploading'
      ? phase.fraction === null
        ? `SUBIENDO ${formatBytes(phase.file.size)}...`
        : `SUBIENDO ${Math.round(phase.fraction * 100)} %...`
      : phase.kind === 'watching'
        ? separationStatusText(phase.state)
        : phase.kind === 'downloading'
          ? `DESCARGANDO STEMS NUEVOS ${phase.done}/${phase.total}...`
          : null

  return (
    <div data-testid="split-upload" data-phase={phase.kind} style={{ ...cardStyle, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: mono, fontSize: '12px', fontWeight: 700, color: colors.text }}>
            <AudioLines size={14} style={{ color: colors.violet }} /> SUBIR CANCIÓN Y SEPARAR
          </span>
          <span style={{ fontSize: '12px', color: colors.muted }}>
            {hint ?? 'Sube el audio completo de la canción y Music AI la separa en voz, batería, bajo, guitarras, teclados y otros.'} WAV, FLAC, MP3 o M4A
            hasta 95 MB. <strong style={{ color: colors.text, fontWeight: 600 }}>Gasta créditos de Music AI y tarda unos minutos</strong>; al terminar deja
            también el borrador de secciones y acordes.
          </span>
        </div>
        {(phase.kind === 'idle' || phase.kind === 'failed' || phase.kind === 'downloaded' || phase.kind === 'done') && (
          <button
            type="button"
            className="stx-btn"
            data-testid="split-pick"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            style={{ ...primaryButton(colors.violet), color: colors.onAccent, alignSelf: 'center' }}
          >
            <FileAudio size={13} /> {phase.kind === 'idle' ? 'SUBIR CANCIÓN Y SEPARAR' : 'SEPARAR OTRO AUDIO'}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={SEPARATION_ACCEPT}
          data-testid="split-file-input"
          aria-label="Audio de la canción para separar"
          onChange={(e) => pick(e.target.files?.[0])}
          style={{ display: 'none' }}
        />
      </div>

      {phase.kind === 'confirm' && (
        <div role="alertdialog" aria-label="Reemplazar los stems de la nube" data-testid="split-confirm" className="stx-fade-in split-confirm" ref={confirmRef}>
          <div style={{ fontSize: '13px', color: colors.text }}>
            Reemplaza los {cloudStemCount} stems actuales de <strong>{song.title}</strong> en la nube de la banda por los que separe Music AI de{' '}
            <span style={{ fontFamily: mono, fontSize: '12px', overflowWrap: 'anywhere' }}>{phase.file.name}</span> ({formatBytes(phase.file.size)}).
          </div>
          <div style={{ fontSize: '12px', color: colors.muted }}>Quien ya los descargó conserva su copia hasta que descargue los nuevos.</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button ref={cancelRef} type="button" className="stx-btn" onClick={() => setPhase({ kind: 'idle' })} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
              <X size={13} /> CANCELAR
            </button>
            <button
              type="button"
              className="stx-btn"
              data-testid="split-confirm-ok"
              onClick={() => void run(phase.file)}
              style={{ ...primaryButton(colors.warning), color: colors.onAccent }}
            >
              REEMPLAZAR Y SEPARAR
            </button>
          </div>
        </div>
      )}

      {statusText && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div data-testid="split-status" aria-live="polite" style={{ fontFamily: mono, fontSize: '11px', color: colors.cobalt }}>
            {statusText}
          </div>
          <div className="split-progress" data-indeterminate={progress === null ? 'true' : 'false'} aria-hidden="true">
            <div className="split-progress-fill" style={{ transform: `scaleX(${progress ?? 0.3})` }} />
          </div>
          {phase.kind === 'watching' && <div style={{ fontSize: '11px', color: colors.muted }}>Puedes seguir trabajando en el hub; no cierres esta vista hasta que termine.</div>}
        </div>
      )}

      {phase.kind === 'done' && (
        <div data-testid="split-done" className="stx-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: colors.success }}>
            <CircleCheck size={14} /> Listo: {phase.manifest ? `${phase.manifest.stems.length} stems` : 'los stems'} en la nube de la banda y el borrador del análisis
            disponible.
          </div>
          {hasLocal && (
            <div data-testid="split-local-note" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px', color: colors.warning }}>
              <span style={{ flex: '1 1 240px' }}>
                Los stems de este equipo son los anteriores; los de la nube son nuevos. No se borró nada: descárgalos cuando quieras usarlos aquí.
              </span>
              <button
                type="button"
                className="stx-btn"
                data-testid="split-download-new"
                onClick={() => void downloadNew(phase.manifest)}
                style={{ ...primaryButton(colors.cyan), color: colors.onAccent, padding: '6px 12px', fontSize: '11px' }}
              >
                <CloudDownload size={13} /> DESCARGAR LOS NUEVOS
              </button>
            </div>
          )}
        </div>
      )}

      {phase.kind === 'downloaded' && (
        <div data-testid="split-downloaded" style={{ fontSize: '12px', color: colors.success }}>
          {phase.count} stems nuevos guardados en este equipo.
        </div>
      )}

      {phase.kind === 'failed' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div role="alert" data-testid="split-error" style={{ flex: '1 1 240px', fontSize: '12px', color: colors.danger }}>
            {phase.message}
          </div>
          <button type="button" className="stx-btn" onClick={() => setPhase({ kind: 'idle' })} style={{ ...ghostButton, padding: '6px 10px', fontSize: '11px' }}>
            <RefreshCw size={12} /> ENTENDIDO
          </button>
        </div>
      )}
    </div>
  )
}
