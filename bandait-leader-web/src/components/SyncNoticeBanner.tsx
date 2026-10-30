import React from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useHub } from '../context/hubContextCore'

const mono = "'IBM Plex Mono', monospace"

/** Aviso de conflicto resuelto con respaldo local, y error de sincronizacion persistente. */
export const SyncNoticeBanner: React.FC<{ onOpenCloud: () => void }> = ({ onOpenCloud }) => {
  const { syncNotice, dismissSyncNotice, syncStatus, retrySync } = useHub()
  const showError = syncStatus.state === 'error'
  if (!syncNotice && !showError) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px clamp(8px, 2vw, 16px) 0' }}>
      {syncNotice && (
        <div
          role="status"
          data-testid="sync-notice"
          style={{
            background: 'rgba(217, 162, 78, 0.12)',
            border: '1px solid #D9A24E',
            borderRadius: '4px',
            padding: '8px 12px',
            color: '#E3C07A',
            fontSize: '12px',
            fontFamily: mono,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span style={{ flex: 1 }}>[SYNC]: {syncNotice.message}</span>
          <button
            type="button"
            onClick={onOpenCloud}
            style={{ background: 'none', border: 'none', color: '#E3C07A', textDecoration: 'underline', cursor: 'pointer', fontFamily: mono, fontSize: '11px' }}
          >
            VER RESPALDOS
          </button>
          <button
            type="button"
            onClick={dismissSyncNotice}
            aria-label="Cerrar aviso"
            style={{ background: 'none', border: 'none', color: '#E3C07A', cursor: 'pointer', padding: 0 }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {showError && (
        <div
          role="alert"
          data-testid="sync-error"
          style={{
            background: 'rgba(217, 100, 89, 0.12)',
            border: '1px solid #D96459',
            borderRadius: '4px',
            padding: '8px 12px',
            color: '#E8A49B',
            fontSize: '12px',
            fontFamily: mono,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: 1 }}>[NUBE]: {syncStatus.detail} Tus cambios siguen guardados en este navegador.</span>
          <button
            type="button"
            onClick={retrySync}
            style={{ background: 'transparent', border: '1px solid #D96459', color: '#D96459', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontFamily: mono, fontSize: '11px' }}
          >
            REINTENTAR
          </button>
        </div>
      )}
    </div>
  )
}
