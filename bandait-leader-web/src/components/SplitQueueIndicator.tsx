import React, { useEffect, useId, useRef, useState } from 'react'
import { AudioLines, RefreshCw, Trash2, X } from 'lucide-react'
import { isActive, type SplitJob, type SplitJobStatus } from '../services/splitQueue'
import { formatBytes } from '../services/stemImport'
import { useSplitJobs, useSplitQueue } from '../context/splitQueueContextCore'
import { colors, mono } from './hubStyles'
import '../styles/audio.css'

const STATUS_LABEL: Record<SplitJobStatus, string> = {
  queued: 'EN COLA',
  uploading: 'SUBIENDO',
  separating: 'SEPARANDO',
  importing: 'IMPORTANDO',
  done: 'LISTO',
  error: 'ERROR',
  canceled: 'CANCELADO',
  interrupted: 'INTERRUMPIDO',
}

function busy(job: SplitJob): boolean {
  return isActive(job.status) || job.local === 'downloading'
}

interface Props {
  /** 'compact' (rail colapsado): solo el icono y el conteo. */
  variant?: 'full' | 'compact'
  /** Lado al que se abre la lista: 'start' (por defecto, rail o cabecera a la izquierda) o 'end'. */
  align?: 'start' | 'end'
}

/**
 * Estado de la cola global "Drop & Split": una pildora con el conteo de trabajos en curso y una
 * lista desplegable con su fase, progreso y acciones (cancelar, reintentar, quitar). No ocupa
 * nada si la cola esta vacia. Pensada para el rail del Shell; hoy la monta PISTAS.
 */
export const SplitQueueIndicator: React.FC<Props> = ({ variant = 'full', align = 'start' }) => {
  const { queue } = useSplitQueue()
  const jobs = useSplitJobs()
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  // Cerrar al hacer clic fuera o con Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (jobs.length === 0) return null
  const running = jobs.filter(busy).length
  const finished = jobs.length - running
  const ordered = [...jobs].reverse()

  const retry = (job: SplitJob) => {
    const result = queue.retry(job.id)
    setNotice(result.ok ? null : result.message)
  }

  return (
    <div className="ga-queue" ref={rootRef} data-testid="split-queue" data-align={align}>
      <button
        type="button"
        className="ga-queue-pill"
        data-testid="split-queue-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={running > 0 ? `Separaciones: ${running} en curso` : `Separaciones: ${finished} terminadas`}
        onClick={() => setOpen((v) => !v)}
      >
        {running > 0 ? <span className="ga-queue-pulse" aria-hidden="true" /> : <AudioLines size={14} aria-hidden="true" />}
        {variant === 'full' && <span>SEPARACIONES</span>}
        <span className="ga-queue-count" data-idle={running === 0 ? 'true' : 'false'} data-testid="split-queue-count">
          {running > 0 ? running : finished}
        </span>
      </button>
      {open && (
        <div id={panelId} className="ga-queue-panel" role="region" aria-label="Cola de separaciones" data-testid="split-queue-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px 4px' }}>
            <span style={{ flex: 1, fontSize: '13px', fontWeight: 600, color: colors.text }}>Separaciones</span>
            {finished > 0 && (
              <button type="button" className="ga-pill" data-size="sm" data-tone="ghost" onClick={() => queue.clearFinished()} data-testid="split-queue-clear">
                LIMPIAR TERMINADAS
              </button>
            )}
          </div>
          {notice && (
            <div role="alert" className="ga-alert" style={{ padding: '8px 12px' }}>
              {notice}
            </div>
          )}
          {ordered.map((job) => {
            const active = busy(job)
            const message = job.status === 'error' || job.status === 'interrupted' || job.status === 'canceled' ? job.error : job.localError
            return (
              <div key={job.id} className="ga-queue-item" data-testid="split-queue-item" data-status={job.status}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 600, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.songTitle}>
                    {job.songTitle}
                  </span>
                  <span className="ga-queue-status" data-status={job.status}>
                    {STATUS_LABEL[job.status]}
                  </span>
                </div>
                <div style={{ fontFamily: mono, fontSize: '10px', color: colors.muted, overflowWrap: 'anywhere' }}>
                  {job.fileName ? `${job.fileName} · ${formatBytes(job.fileSize)}` : 'Audio de la canción'}
                  {job.status === 'done' && job.stemCount !== null ? ` · ${job.stemCount} stems` : ''}
                  {job.local === 'saved' ? ' · en este equipo' : ''}
                </div>
                {active && (
                  <>
                    {job.detail && <div style={{ fontFamily: mono, fontSize: '10px', color: colors.text }}>{job.detail}</div>}
                    <div className="ga-queue-bar" data-indeterminate={job.progress === null ? 'true' : 'false'} aria-hidden="true">
                      <span style={{ transform: `scaleX(${job.progress ?? 0.3})` }} />
                    </div>
                  </>
                )}
                {message && <div style={{ fontSize: '11px', color: job.status === 'canceled' ? colors.muted : colors.danger }}>{message}</div>}
                <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  {isActive(job.status) && (
                    <button type="button" className="ga-pill" data-size="sm" data-tone="ghost" onClick={() => queue.cancel(job.id)} data-testid="split-queue-cancel">
                      <X size={12} /> CANCELAR
                    </button>
                  )}
                  {(job.status === 'error' || job.status === 'canceled' || job.status === 'interrupted') &&
                    (queue.canRetry(job.id) ? (
                      <button type="button" className="ga-pill" data-size="sm" onClick={() => retry(job)} data-testid="split-queue-retry">
                        <RefreshCw size={12} /> REINTENTAR
                      </button>
                    ) : (
                      <span style={{ fontSize: '11px', color: colors.muted, alignSelf: 'center' }}>Para reintentar, vuelve a elegir el audio en STEMS Y PISTAS.</span>
                    ))}
                  {!active && (
                    <button type="button" className="ga-pill" data-size="sm" data-tone="ghost" aria-label={`Quitar ${job.songTitle} de la lista`} onClick={() => queue.dismiss(job.id)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
