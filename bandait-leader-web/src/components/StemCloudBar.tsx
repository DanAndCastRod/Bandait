import React from 'react'
import { AlertTriangle, Cloud, CloudDownload, CloudOff, CloudUpload, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudManifest } from '../services/stemCloud'
import { cardStyle, colors, ghostButton, mono, primaryButton } from './hubStyles'

/** Estado de la nube para una cancion (la vista lo guarda por banda y cancion). */
export type CloudSongState =
  | { kind: 'none' }
  | { kind: 'present'; manifest: CloudManifest }
  | { kind: 'uploading'; done: number; total: number; manifest: CloudManifest | null }
  | { kind: 'downloading'; done: number; total: number; manifest: CloudManifest | null }
  | { kind: 'error'; message: string; manifest: CloudManifest | null }

interface Props {
  /** undefined: todavia se esta consultando el manifiesto. */
  state: CloudSongState | undefined
  hasLocal: boolean
  /** La nube tiene lo mismo que este equipo. */
  inSync: boolean
  canEdit: boolean
  /** Archivos locales que el lider no puede reproducir (m4a/aac). */
  leaderUnplayable: string[]
  onUpload: () => void
  onDownload: () => void
  onRetry: () => void
  onDeleteCloud: () => void
}

type Badge = { text: string; tone: 'muted' | 'ok' | 'busy' | 'warn' | 'error'; icon: React.ReactNode }

function badgeFor(p: Props): Badge {
  const s = p.state
  if (!s) return { text: 'CONSULTANDO LA NUBE...', tone: 'busy', icon: <RefreshCw size={12} /> }
  switch (s.kind) {
    case 'uploading':
      return { text: `SUBIENDO ${s.done}/${s.total}`, tone: 'busy', icon: <CloudUpload size={12} /> }
    case 'downloading':
      return { text: `DESCARGANDO ${s.done}/${s.total}`, tone: 'busy', icon: <CloudDownload size={12} /> }
    case 'error':
      return { text: 'ERROR', tone: 'error', icon: <AlertTriangle size={12} /> }
    case 'none':
      return p.hasLocal
        ? { text: 'SOLO EN ESTE EQUIPO', tone: 'muted', icon: <CloudOff size={12} /> }
        : { text: 'SIN STEMS EN LA NUBE', tone: 'muted', icon: <CloudOff size={12} /> }
    case 'present':
      if (!p.hasLocal) return { text: `EN LA NUBE · ${s.manifest.stems.length} STEMS`, tone: 'ok', icon: <Cloud size={12} /> }
      return p.inSync
        ? { text: 'EN LA NUBE', tone: 'ok', icon: <Cloud size={12} /> }
        : { text: 'LA NUBE TIENE OTRA VERSIÓN', tone: 'warn', icon: <AlertTriangle size={12} /> }
  }
}

const TONE: Record<Badge['tone'], { bg: string; fg: string; border: string }> = {
  muted: { bg: colors.elevated, fg: colors.muted, border: colors.border },
  ok: { bg: colors.success, fg: colors.onAccent, border: colors.success },
  busy: { bg: colors.cobalt, fg: colors.onAccent, border: colors.cobalt },
  warn: { bg: colors.warning, fg: colors.onAccent, border: colors.warning },
  error: { bg: colors.danger, fg: colors.onAccent, border: colors.danger },
}

/** Barra de estado y acciones de la nube de stems para la cancion elegida. */
export const StemCloudBar: React.FC<Props> = (props) => {
  const { state, hasLocal, inSync, canEdit, leaderUnplayable, onUpload, onDownload, onRetry, onDeleteCloud } = props
  const badge = badgeFor(props)
  const tone = TONE[badge.tone]
  const busy = state?.kind === 'uploading' || state?.kind === 'downloading' || state === undefined
  const cloudManifest = state && state.kind === 'present' ? state.manifest : state && 'manifest' in state ? state.manifest : null
  const showUpload = canEdit && hasLocal && !(state?.kind === 'present' && inSync)
  const showDownload = !!cloudManifest && !(hasLocal && inSync)
  const smallBtn: React.CSSProperties = { ...ghostButton, padding: '6px 10px', fontSize: '11px' }

  return (
    <div
      data-testid="stem-cloud"
      data-cloud-state={state ? state.kind : 'checking'}
      style={{ ...cardStyle, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>NUBE DE LA BANDA</span>
        <span
          data-testid="stem-cloud-status"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            fontFamily: mono,
            fontSize: '11px',
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: '3px',
            background: tone.bg,
            color: tone.fg,
            border: `1px solid ${tone.border}`,
          }}
        >
          {badge.icon} {badge.text}
        </span>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginLeft: 'auto' }}>
          {showUpload && (
            <button
              type="button"
              className="stx-btn"
              data-testid="stem-cloud-upload"
              disabled={busy}
              onClick={onUpload}
              style={{ ...primaryButton(colors.cobalt), color: colors.onAccent, padding: '6px 10px', fontSize: '11px' }}
            >
              <CloudUpload size={13} /> {cloudManifest ? 'SUBIR ESTA VERSIÓN' : 'SUBIR A LA NUBE'}
            </button>
          )}
          {showDownload && (
            <button type="button" className="stx-btn" data-testid="stem-cloud-download" disabled={busy} onClick={onDownload} style={smallBtn}>
              <CloudDownload size={13} /> DESCARGAR DE LA NUBE
            </button>
          )}
          {state?.kind === 'error' && (
            <button type="button" className="stx-btn" disabled={busy} onClick={onRetry} style={smallBtn}>
              <RefreshCw size={12} /> REINTENTAR
            </button>
          )}
          {canEdit && cloudManifest && !hasLocal && (
            <button
              type="button"
              className="stx-btn"
              data-testid="stem-cloud-delete"
              disabled={busy}
              onClick={onDeleteCloud}
              style={{ ...smallBtn, color: colors.danger }}
            >
              <Trash2 size={12} /> BORRAR DE LA NUBE
            </button>
          )}
        </div>
      </div>

      {state?.kind === 'error' && (
        <div role="alert" data-testid="stem-cloud-error" style={{ fontSize: '12px', color: colors.danger }}>
          {state.message}
        </div>
      )}
      {showDownload && hasLocal && (
        <div style={{ fontSize: '11px', color: colors.muted }}>Descargar reemplaza los stems de este equipo por los de la nube.</div>
      )}
      {!canEdit && hasLocal && (
        <div data-testid="stem-cloud-readonly" style={{ fontSize: '12px', color: colors.muted }}>
          Solo el Owner o el Director musical pueden subir stems a la nube de esta banda. Los tuyos quedan en este equipo.
        </div>
      )}
      {canEdit && (
        <div data-testid="stem-cloud-leader-note" style={{ fontSize: '11px', color: leaderUnplayable.length > 0 ? colors.warning : colors.muted }}>
          {leaderUnplayable.length > 0
            ? `El líder solo reproduce MP3, WAV, FLAC u OGG: ${leaderUnplayable.join(', ')} se sube${leaderUnplayable.length === 1 ? '' : 'n'} pero el líder no ${leaderUnplayable.length === 1 ? 'lo' : 'los'} podrá tocar.`
            : 'Al subir: el líder solo reproduce MP3, WAV, FLAC u OGG (no M4A).'}
        </div>
      )}
    </div>
  )
}
