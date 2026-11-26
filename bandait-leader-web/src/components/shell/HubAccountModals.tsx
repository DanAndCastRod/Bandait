import React, { useRef, useState } from 'react'
import { Download, LogOut, Upload } from 'lucide-react'
import { useHub } from '../../context/hubContextCore'
import { PROVIDER_LABELS } from '../../services/authService'
import { GoogleIcon } from '../GoogleIcon'
import { HubModal } from '../HubModal'
import { colors, ghostButton, inputStyle, labelStyle, mono, primaryButton, radius } from '../hubStyles'
import { Avatar } from './HubShellParts'

/** Perfil y sesion: identidad, copia local, exportar e importar el workspace y cerrar sesion. */
export const ProfileModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { user, activeBand, activeBandRole, logout, exportWorkspaceJson, importWorkspaceJson } = useHub()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importMessage, setImportMessage] = useState<{ ok: boolean; text: string } | null>(null)
  if (!user) return null
  const hasGoogleIdentity = user.authProvider === 'supabase' || user.authProvider === 'google_local'

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return
    const confirmed = window.confirm(
      'Importar reemplaza TODO tu workspace en este navegador (y en la nube si tienes sesión) por el del archivo. Si quieres conservar el actual, exporta antes una copia. ¿Continuar?'
    )
    if (!confirmed) return
    try {
      const result = importWorkspaceJson(await file.text())
      setImportMessage({ ok: result.ok, text: result.message })
    } catch {
      setImportMessage({ ok: false, text: 'No se pudo leer el archivo.' })
    }
  }

  const rowButton: React.CSSProperties = { ...ghostButton, width: '100%', padding: '11px 14px', fontWeight: 600 }

  return (
    <HubModal title="PERFIL Y SESIÓN" onClose={onClose} maxWidth="400px" closeLabel="Cerrar perfil" testId="profile-modal">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', background: colors.cardAlt, padding: '14px', borderRadius: radius.card }}>
          <Avatar name={user.name} url={user.avatarUrl} size={48} />
          <div style={{ overflow: 'hidden', minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '15px', color: colors.text }}>{user.name}</div>
            <div style={{ fontSize: '12px', color: colors.muted, fontFamily: mono, wordBreak: 'break-all' }}>{user.email}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              {hasGoogleIdentity && <GoogleIcon size={12} />}
              <span
                data-testid="profile-provider"
                style={{
                  fontSize: '11px',
                  color: user.authProvider === 'supabase' ? 'var(--b-success-text)' : 'var(--b-warning-text)',
                  fontFamily: mono,
                  fontWeight: 700,
                }}
              >
                {PROVIDER_LABELS[user.authProvider]}
              </span>
            </div>
          </div>
        </div>

        <div style={{ background: colors.cardAlt, borderRadius: radius.card, padding: '12px 14px', fontSize: '11px', color: colors.muted, fontFamily: mono, lineHeight: 1.6 }}>
          <div>COPIA LOCAL (LOCALSTORAGE):</div>
          <div style={{ color: colors.text, fontWeight: 700, wordBreak: 'break-all' }}>bandait_workspace_{user.id}</div>
          <div style={{ marginTop: '4px' }}>
            NUBE:{' '}
            <span style={{ color: user.authProvider === 'supabase' ? 'var(--b-success-text)' : colors.muted, fontWeight: 700 }}>
              {user.authProvider === 'supabase' ? `fila user_id = ${user.id}` : 'sin nube (perfil local)'}
            </span>
          </div>
          <div style={{ marginTop: '4px' }}>
            BANDA ACTIVA: <span style={{ color: colors.text, fontWeight: 700 }}>{activeBand?.name}</span> [{(activeBandRole ?? '').toUpperCase()}]
          </div>
        </div>

        <button
          type="button"
          className="hub-press"
          onClick={() => {
            onClose()
            exportWorkspaceJson()
          }}
          style={rowButton}
        >
          <Download size={14} aria-hidden />
          <span>EXPORTAR COPIA DE SEGURIDAD JSON</span>
        </button>

        <button type="button" className="hub-press" onClick={() => importInputRef.current?.click()} data-testid="import-workspace" style={rowButton}>
          <Upload size={14} aria-hidden />
          <span>IMPORTAR COPIA JSON</span>
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          aria-label="Archivo JSON a importar"
          data-testid="import-workspace-file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            void handleImportFile(file)
          }}
        />
        {importMessage && (
          <div
            data-testid="import-workspace-message"
            role="status"
            style={{ fontSize: '11px', fontFamily: mono, color: importMessage.ok ? 'var(--b-success-text)' : 'var(--b-danger-text)', lineHeight: 1.5 }}
          >
            {importMessage.text}
          </div>
        )}

        <button
          type="button"
          className="hub-press"
          onClick={() => {
            onClose()
            void logout()
          }}
          style={{ ...primaryButton(colors.danger), width: '100%', padding: '12px' }}
        >
          <LogOut size={16} aria-hidden />
          <span>CERRAR SESIÓN</span>
        </button>
      </div>
    </HubModal>
  )
}

/** Crear una agrupacion nueva (banda o proyecto) y dejarla activa. */
export const NewBandModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { createBand } = useHub()
  const [name, setName] = useState('')
  const [genre, setGenre] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createBand(name.trim(), genre.trim() || 'Rock / Pop')
    onClose()
  }

  return (
    <HubModal title="CREAR NUEVA AGRUPACIÓN" onClose={onClose} maxWidth="420px" testId="new-band-modal">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={labelStyle}>
          NOMBRE DE LA BANDA O PROYECTO
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Big Band Pereira" required autoFocus style={inputStyle} />
        </label>
        <label style={labelStyle}>
          GÉNERO / ESTILO
          <input type="text" value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="Ej: Jazz Fusión / Rock / Sinfónico" style={inputStyle} />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px', flexWrap: 'wrap' }}>
          <button type="button" className="hub-press" onClick={onClose} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
            CANCELAR
          </button>
          <button type="submit" className="hub-press" style={primaryButton()}>
            CREAR BANDA
          </button>
        </div>
      </form>
    </HubModal>
  )
}
