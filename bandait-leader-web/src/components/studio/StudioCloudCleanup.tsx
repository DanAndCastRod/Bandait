import React, { useState } from 'react'
import { Eraser } from 'lucide-react'
import type { CloudTarget } from '../../services/stemCloud'
import { formatBytes } from '../../services/stemImport'
import * as studioCloud from '../../services/studio/studioCloud'
import type { StudioCleanupReport } from '../../services/studio/types'
import { errorText } from './studioState'

type Phase = 'idle' | 'checking' | 'ready' | 'confirm' | 'cleaning' | 'done'

function audios(n: number): string {
  return n === 1 ? '1 audio' : `${n} audios`
}

function blockedText(report: StudioCleanupReport): string | null {
  if (report.blocked === 'session_unreadable') return 'Una sesión de la nube no se pudo leer: por seguridad no se borra nada. Reintenta más tarde.'
  if (report.blocked === 'incomplete') return 'La banda tiene demasiadas sesiones para revisarlas de una vez: no se borra nada ahora. El barrido diario de la nube sigue por su cuenta.'
  return null
}

/**
 * Accion LIMPIAR AUDIOS SIN USAR de la nube del Estudio (STUDIO_V2.md 3.1): cuenta los audios que
 * ninguna sesion usa (GET .../studio/_cleanup) y, tras confirmar, los borra (POST). Solo se monta
 * para el Owner o el Director musical con sesion de nube. La nube tambien los limpia sola (cron
 * diario y despues de guardar); esto es para hacerlo ya.
 */
export const StudioCloudCleanup: React.FC<{ cloud: CloudTarget; onDone?: () => void }> = ({ cloud, onDone }) => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [report, setReport] = useState<StudioCleanupReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const inspect = async () => {
    setPhase('checking')
    setError(null)
    try {
      setReport(await studioCloud.inspectOrphans(cloud))
      setPhase('ready')
    } catch (err) {
      setError(errorText(err, 'No se pudo revisar la nube.'))
      setPhase('idle')
    }
  }

  const clean = async () => {
    setPhase('cleaning')
    setError(null)
    try {
      setReport(await studioCloud.cleanOrphans(cloud))
      setPhase('done')
      onDone?.()
    } catch (err) {
      setError(errorText(err, 'No se pudieron borrar los audios sin usar.'))
      setPhase('ready')
    }
  }

  const blocked = report ? blockedText(report) : null
  let message: string
  if (phase === 'checking') message = 'Revisando los audios de la nube...'
  else if (phase === 'cleaning') message = 'Borrando los audios sin usar...'
  else if (phase === 'done' && report) {
    message = blocked ?? (report.deleted ? `Se borraron ${audios(report.deleted)} (${formatBytes(report.deletedBytes)}).` : 'No quedó nada por borrar.')
  } else if (phase === 'confirm' && report) {
    message = `¿Borrar ${audios(report.orphans)} (${formatBytes(report.bytes)}) que ninguna sesión usa? No se puede deshacer.`
  } else if (report && phase === 'ready') {
    message = blocked ?? (report.orphans
      ? `${audios(report.orphans)} sin usar en la nube (${formatBytes(report.bytes)}): ninguna sesión los usa y tienen más de 2 horas.`
      : 'No hay audios sin usar en la nube.')
  } else {
    message = 'Audios que quedaron en la nube sin que ninguna sesión los use (tomas descartadas, resultados de IA sin importar).'
  }

  return (
    <div className="stu-notice" data-tone={error ? 'error' : 'info'} role="status" data-testid="studio-cloud-cleanup" style={{ marginTop: '12px' }}>
      <span>{error ?? message}</span>
      <div className="stu-notice-actions">
        {phase === 'confirm' && report ? (
          <>
            <button type="button" className="stu-btn" data-tone="danger" onClick={() => void clean()} data-testid="studio-cleanup-confirm">
              BORRAR {audios(report.orphans).toUpperCase()}
            </button>
            <button type="button" className="stu-btn" autoFocus onClick={() => setPhase('ready')}>
              CANCELAR
            </button>
          </>
        ) : phase === 'ready' && report && report.orphans > 0 && !blocked ? (
          <button type="button" className="stu-btn" data-tone="danger" onClick={() => setPhase('confirm')} data-testid="studio-cleanup-clean">
            <Eraser size={13} />
            LIMPIAR AUDIOS SIN USAR
          </button>
        ) : (
          <button
            type="button"
            className="stu-btn"
            disabled={phase === 'checking' || phase === 'cleaning'}
            onClick={() => void inspect()}
            data-testid="studio-cleanup-check"
          >
            <Eraser size={13} />
            {phase === 'idle' ? 'AUDIOS SIN USAR' : 'REVISAR DE NUEVO'}
          </button>
        )}
      </div>
    </div>
  )
}
