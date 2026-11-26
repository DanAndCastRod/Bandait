import React, { useEffect, useRef, useState } from 'react'
import { AudioLines, CircleCheck, CloudDownload, FileAudio, RefreshCw, X } from 'lucide-react'
import type { CloudManifest, CloudTarget } from '../services/stemCloud'
import type { StemSongRecord } from '../services/stemStore'
import { formatBytes } from '../services/stemImport'
import { SEPARATION_ACCEPT, separationFileProblem } from '../services/stemAnalysis'
import { isActive, type SplitJob } from '../services/splitQueue'
import { useSplitJobs, useSplitLocalSaved, useSplitQueue } from '../context/splitQueueContextCore'
import { colors, mono } from './hubStyles'
import '../styles/audio.css'

interface Props {
  song: { id: string; title: string }
  target: CloudTarget
  /** Stems que la cancion ya tiene en la nube (null: todavia no se sabe). */
  cloudStemCount: number | null
  /** La cancion tiene stems en este navegador (IndexedDB). */
  hasLocal: boolean
  /** Al terminar, bajar e importar los stems a este equipo como parte del trabajo. */
  importLocal?: boolean
  /** La separacion termino (con esta vista montada): manifiesto nuevo de la nube y borrador listo. */
  onDone?: (manifest: CloudManifest | null) => void
  /** Se guardaron los stems nuevos en este equipo. */
  onLocalReplaced?: (record: StemSongRecord) => void
  /** Texto corto de contexto bajo el titulo (cambia entre CANCIONES y PISTAS). */
  hint?: string
}

type Phase = 'idle' | 'confirm' | 'queued' | 'uploading' | 'watching' | 'done' | 'downloading' | 'downloaded' | 'canceled' | 'failed'

function phaseOf(job: SplitJob | null): Phase {
  if (!job) return 'idle'
  switch (job.status) {
    case 'queued':
      return 'queued'
    case 'uploading':
      return 'uploading'
    case 'separating':
    case 'importing':
      return 'watching'
    case 'done':
      return job.local === 'downloading' ? 'downloading' : job.local === 'saved' ? 'downloaded' : 'done'
    case 'canceled':
      return 'canceled'
    case 'error':
    case 'interrupted':
      return 'failed'
  }
}

/**
 * SUBIR CANCION Y SEPARAR: el editor sube el audio completo de la cancion, Music AI lo separa en
 * stems (voz, bateria, bajo, guitarras, teclados, otros), el Worker los copia a la nube de la
 * banda reemplazando los que hubiera y deja el borrador del analisis. Solo editores con nube:
 * la vista que lo monta lo decide.
 *
 * El trabajo va a la cola global "Drop & Split" (services/splitQueue.ts): sigue aunque el musico
 * cambie de vista, y al volver este panel muestra como termino. Aqui solo se elige el archivo, se
 * confirma el reemplazo y se ve el estado del ultimo trabajo de la cancion.
 */
export const SplitUpload: React.FC<Props> = ({ song, target, cloudStemCount, hasLocal, importLocal = false, onDone, onLocalReplaced, hint }) => {
  const { queue } = useSplitQueue()
  const jobs = useSplitJobs()
  const [pending, setPending] = useState<File | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  /** Trabajo que el musico ya dio por visto (ENTENDIDO): el panel vuelve al inicio. */
  const [dismissedId, setDismissedId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  let latest: SplitJob | null = null
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].band === target.band && jobs[i].songId === song.id) {
      latest = jobs[i]
      break
    }
  }
  const job = latest && latest.id !== dismissedId ? latest : null
  const phase: Phase = pending ? 'confirm' : pickError ? 'failed' : phaseOf(job)

  // onDone cuando el trabajo de esta cancion pasa a 'done' con el panel montado.
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])
  const lastSeen = useRef<{ id: string; status: SplitJob['status'] } | null>(null)
  const jobId = job?.id ?? null
  const jobStatus = job?.status ?? null
  useEffect(() => {
    const prev = lastSeen.current
    lastSeen.current = jobId && jobStatus ? { id: jobId, status: jobStatus } : null
    if (jobId && prev && prev.id === jobId && prev.status !== 'done' && jobStatus === 'done') onDoneRef.current?.(queue.manifestOf(jobId))
  }, [jobId, jobStatus, queue])

  // Stems nuevos guardados en este equipo (por esta cola), para la vista que monta el panel.
  useSplitLocalSaved(target.band, (event) => {
    if (event.songId === song.id) onLocalReplaced?.(event.record)
  })

  // La confirmacion aparece en linea, a veces debajo del borde visible (y en movil, bajo la barra
  // inferior fija): se trae a la vista con su scroll-margin y el foco pasa a CANCELAR.
  useEffect(() => {
    if (phase !== 'confirm') return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    confirmRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
    cancelRef.current?.focus({ preventScroll: true })
  }, [phase])

  const enqueue = (file: File) => {
    setPending(null)
    const result = queue.enqueue({ band: target.band, songId: song.id, songTitle: song.title, file, target, importLocal: importLocal && !hasLocal })
    if (!result.ok) {
      setPickError(result.message)
      return
    }
    setPickError(null)
    setDismissedId(null)
  }

  const pick = (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return
    const problem = separationFileProblem(file)
    if (problem) {
      setPickError(problem)
      return
    }
    setPickError(null)
    if (cloudStemCount && cloudStemCount > 0) setPending(file)
    else enqueue(file)
  }

  const reset = () => {
    setPickError(null)
    if (job && !isActive(job.status)) setDismissedId(job.id)
  }

  const canPick = phase === 'idle' || phase === 'failed' || phase === 'downloaded' || phase === 'done' || phase === 'canceled'
  const progress = job && (phase === 'uploading' || phase === 'watching' || phase === 'downloading') ? job.progress : null
  const statusText =
    phase === 'queued'
      ? 'EN COLA: ARRANCA CUANDO TERMINE LA SEPARACIÓN EN CURSO...'
      : phase === 'uploading'
        ? job?.detail ?? `SUBIENDO ${formatBytes(job?.fileSize ?? 0)}...`
        : phase === 'watching' || phase === 'downloading'
          ? job?.detail ?? 'SEPARANDO EN MUSIC AI...'
          : null
  const failure = pickError ?? (job && (job.status === 'error' || job.status === 'interrupted') ? job.error : null)

  return (
    <div data-testid="split-upload" data-phase={phase} className="ga-panel ga-split" data-tight="true">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <span className="ga-icon-dot" aria-hidden="true">
          <AudioLines size={16} />
        </span>
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: colors.text }}>Subir canción y separar</span>
          <span style={{ fontSize: '12px', color: colors.muted }}>
            {hint ?? 'Sube el audio completo de la canción y Music AI la separa en voz, batería, bajo, guitarras, teclados y otros.'} WAV, FLAC, MP3 o M4A
            hasta 95 MB. <strong style={{ color: colors.text, fontWeight: 600 }}>Gasta créditos de Music AI y tarda unos minutos</strong>; al terminar deja
            también el borrador de secciones y acordes.
          </span>
        </div>
        {canPick && (
          <button type="button" className="ga-pill" data-tone="accent" data-testid="split-pick" onClick={() => inputRef.current?.click()} style={{ alignSelf: 'center' }}>
            <FileAudio size={13} /> {phase === 'idle' ? 'SUBIR CANCIÓN Y SEPARAR' : 'SEPARAR OTRO AUDIO'}
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

      {pending && (
        <div role="alertdialog" aria-label="Reemplazar los stems de la nube" data-testid="split-confirm" className="stx-fade-in split-confirm" ref={confirmRef}>
          <div style={{ fontSize: '13px', color: colors.text }}>
            Reemplaza los {cloudStemCount} stems actuales de <strong>{song.title}</strong> en la nube de la banda por los que separe Music AI de{' '}
            <span style={{ fontFamily: mono, fontSize: '12px', overflowWrap: 'anywhere' }}>{pending.name}</span> ({formatBytes(pending.size)}).
          </div>
          <div style={{ fontSize: '12px', color: colors.muted }}>Quien ya los descargó conserva su copia hasta que descargue los nuevos.</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button ref={cancelRef} type="button" className="ga-pill" data-tone="ghost" onClick={() => setPending(null)}>
              <X size={13} /> CANCELAR
            </button>
            <button type="button" className="ga-pill" data-tone="warning" data-testid="split-confirm-ok" onClick={() => enqueue(pending)}>
              REEMPLAZAR Y SEPARAR
            </button>
          </div>
        </div>
      )}

      {statusText && job && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div data-testid="split-status" aria-live="polite" style={{ flex: '1 1 200px', fontFamily: mono, fontSize: '11px', color: colors.text }}>
              {statusText}
            </div>
            {isActive(job.status) && (
              <button type="button" className="ga-pill" data-size="sm" data-tone="ghost" data-testid="split-cancel" onClick={() => queue.cancel(job.id)}>
                <X size={12} /> CANCELAR
              </button>
            )}
          </div>
          <div className="split-progress" data-indeterminate={progress === null ? 'true' : 'false'} aria-hidden="true">
            <div className="split-progress-fill" style={{ transform: `scaleX(${progress ?? 0.3})` }} />
          </div>
          {phase !== 'downloading' && (
            <div style={{ fontSize: '11px', color: colors.muted }}>Sigue aunque cambies de vista. No cierres ni recargues la pestaña hasta que termine.</div>
          )}
        </div>
      )}

      {phase === 'done' && job && (
        <div data-testid="split-done" className="stx-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: colors.success }}>
            <CircleCheck size={14} /> Listo: {job.stemCount !== null ? `${job.stemCount} stems` : 'los stems'} en la nube de la banda y el borrador del análisis
            disponible.
          </div>
          {job.localError && (
            <div role="alert" data-testid="split-local-error" style={{ fontSize: '12px', color: colors.danger }}>
              No se pudieron guardar en este equipo: {job.localError}
            </div>
          )}
          {(hasLocal || job.localError) && (
            <div data-testid="split-local-note" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px', color: colors.warning }}>
              <span style={{ flex: '1 1 240px' }}>
                {hasLocal
                  ? 'Los stems de este equipo son los anteriores; los de la nube son nuevos. No se borró nada: descárgalos cuando quieras usarlos aquí.'
                  : 'Los stems nuevos están en la nube; descárgalos para usarlos aquí.'}
              </span>
              <button type="button" className="ga-pill" data-size="sm" data-tone="accent" data-testid="split-download-new" onClick={() => void queue.downloadLocal(job.id)}>
                <CloudDownload size={13} /> DESCARGAR LOS NUEVOS
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'downloaded' && job && (
        <div data-testid="split-downloaded" style={{ fontSize: '12px', color: colors.success }}>
          {job.localCount ?? 0} stems nuevos guardados en este equipo.
        </div>
      )}

      {phase === 'canceled' && job && (
        <div data-testid="split-canceled" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px', fontSize: '12px', color: colors.muted }}>Separación cancelada. {job.error ?? 'No se subió nada.'}</div>
          {queue.canRetry(job.id) && (
            <button type="button" className="ga-pill" data-size="sm" onClick={() => queue.retry(job.id)}>
              <RefreshCw size={12} /> REINTENTAR
            </button>
          )}
          <button type="button" className="ga-pill" data-size="sm" data-tone="ghost" onClick={reset}>
            ENTENDIDO
          </button>
        </div>
      )}

      {phase === 'failed' && failure && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div role="alert" data-testid="split-error" style={{ flex: '1 1 240px', fontSize: '12px', color: colors.danger }}>
            {failure}
          </div>
          {!pickError && job && queue.canRetry(job.id) && (
            <button type="button" className="ga-pill" data-size="sm" data-testid="split-retry" onClick={() => queue.retry(job.id)}>
              <RefreshCw size={12} /> REINTENTAR
            </button>
          )}
          <button type="button" className="ga-pill" data-size="sm" data-tone="ghost" onClick={reset}>
            ENTENDIDO
          </button>
        </div>
      )}
    </div>
  )
}
