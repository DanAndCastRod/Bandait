import React, { useRef, useState } from 'react'
import { useHub, type HubSyncStatus } from '../context/hubContextCore'
import { PROVIDER_LABELS } from '../services/authService'
import { GoogleIcon } from './GoogleIcon'
import {
  ListMusic,
  Sliders,
  Users,
  Music,
  Settings,
  Download,
  Plus,
  LogOut,
  ChevronDown,
  Layers,
  X,
  BookOpen,
  Cloud,
  Library,
  Upload,
} from 'lucide-react'
import { UserManualModal } from './UserManualModal'
import { SupabaseConfigModal } from './SupabaseConfigModal'
import { colors, mono } from './hubStyles'

/**
 * Vistas del hub, con los mismos nombres y el mismo orden que el lider 2.3. El hub no tiene
 * Escenario: una pagina HTTPS no puede abrir ws:// hacia el lider en la LAN (contenido mixto).
 */
export type HubTab = 'setlists' | 'songs' | 'rehearsal' | 'tracks' | 'band' | 'settings'

interface TabDef {
  id: HubTab
  label: string
  /** Etiqueta corta de la barra inferior en movil. */
  short: string
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  accent: string
}

const HUB_TABS: readonly TabDef[] = [
  { id: 'setlists', label: 'SETLISTS', short: 'SETLISTS', icon: ListMusic, accent: colors.orange },
  { id: 'songs', label: 'CANCIONES', short: 'CANCIONES', icon: Library, accent: colors.violet },
  { id: 'rehearsal', label: 'ENSAYO', short: 'ENSAYO', icon: Music, accent: colors.cyan },
  { id: 'tracks', label: 'PISTAS', short: 'PISTAS', icon: Sliders, accent: colors.cobalt },
  { id: 'band', label: 'BANDA', short: 'BANDA', icon: Users, accent: colors.success },
  { id: 'settings', label: 'AJUSTES', short: 'AJUSTES', icon: Settings, accent: colors.warning },
]

interface Props {
  activeTab: HubTab
  onSelectTab: (tab: HubTab) => void
}

const SYNC_LABEL: Record<HubSyncStatus['state'], { text: string; color: string }> = {
  local_only: { text: 'SOLO LOCAL', color: colors.muted },
  syncing: { text: 'SINCRONIZANDO', color: colors.cyan },
  synced: { text: 'SINCRONIZADO', color: colors.success },
  error: { text: 'ERROR NUBE', color: colors.danger },
}

function syncTitle(status: HubSyncStatus): string {
  if (status.state === 'synced') return `Sincronizado con la nube (${new Date(status.at).toLocaleTimeString()})`
  return status.detail
}

export const HubNavbar: React.FC<Props> = ({ activeTab, onSelectTab }) => {
  const { user, bands, activeBand, activeBandRole, switchBand, createBand, logout, exportWorkspaceJson, importWorkspaceJson, syncStatus, sharing } =
    useHub()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importMessage, setImportMessage] = useState<{ ok: boolean; text: string } | null>(null)

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
  const syncLabel = SYNC_LABEL[syncStatus.state]
  const hasGoogleIdentity = user?.authProvider === 'supabase' || user?.authProvider === 'google_local'
  const [showBandMenu, setShowBandMenu] = useState(false)
  const [showNewBandModal, setShowNewBandModal] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [showManualModal, setShowManualModal] = useState(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      return p.get('manual') === '1' || p.get('view') === 'manual'
    } catch {
      return false
    }
  })
  const [showSupabaseModal, setShowSupabaseModal] = useState(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      return p.get('cloud') === '1' || p.get('supabase') === '1'
    } catch {
      return false
    }
  })
  const [newBandName, setNewBandName] = useState('')
  const [newBandGenre, setNewBandGenre] = useState('')

  const handleCreateBand = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newBandName.trim()) return
    createBand(newBandName.trim(), newBandGenre.trim() || 'Rock / Pop')
    setNewBandName('')
    setNewBandGenre('')
    setShowNewBandModal(false)
    setShowBandMenu(false)
  }

  return (
    <>
      <header
        className="hub-header"
        style={{
          background: colors.cardAlt,
          borderBottom: `1px solid ${colors.border}`,
          padding: '8px clamp(8px, 2vw, 16px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
      {/* BRAND & MULTI-BAND SWITCHER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexShrink: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          <div
            style={{
              width: '26px',
              height: '26px',
              background: `linear-gradient(135deg, ${colors.orange}, ${colors.cobalt})`,
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '13px',
              color: colors.text,
              fontFamily: mono,
              flexShrink: 0,
            }}
          >
            B
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                fontFamily: mono,
                fontWeight: 800,
                fontSize: '13px',
                letterSpacing: '1px',
                color: colors.text,
                lineHeight: 1.1,
              }}
            >
              BANDAIT
            </div>
            <div
              className="hub-desktop-only"
              style={{
                fontFamily: mono,
                fontSize: '9px',
                color: colors.muted,
                letterSpacing: '1.5px',
              }}
            >
              WEB ADMIN HUB
            </div>
          </div>
        </div>

        {/* MULTI-BAND SELECTOR DROPDOWN */}
        <div style={{ position: 'relative', minWidth: 0, flexShrink: 1 }}>
          <button
            data-testid="band-switcher"
            onClick={() => setShowBandMenu(!showBandMenu)}
            style={{
              background: colors.elevated,
              border: `1px solid ${colors.border}`,
              borderRadius: '4px',
              padding: '5px 8px',
              color: colors.text,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              fontSize: '11px',
              fontFamily: mono,
              maxWidth: 'clamp(100px, 28vw, 220px)',
              whiteSpace: 'nowrap',
            }}
          >
            <Layers size={13} style={{ color: colors.cobalt, flexShrink: 0 }} />
            <span
              style={{
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeBand ? activeBand.name : 'Banda'}
            </span>
            <span
              className="hub-desktop-only"
              style={{
                fontSize: '9px',
                background: colors.orange,
                color: colors.onAccent,
                padding: '1px 5px',
                borderRadius: '2px',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              [{(activeBandRole ?? '').toUpperCase()}]
            </span>
            <ChevronDown size={12} style={{ opacity: 0.6, flexShrink: 0 }} />
          </button>

          {showBandMenu && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '6px',
                background: colors.modal,
                border: `1px solid ${colors.border}`,
                borderRadius: '6px',
                width: '260px',
                boxShadow: '0 10px 25px rgba(0, 0, 0, 0.6)',
                zIndex: 200,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '8px 12px',
                  fontFamily: mono,
                  fontSize: '10px',
                  color: colors.muted,
                  borderBottom: `1px solid ${colors.border}`,
                }}
              >
                TUS AGRUPACIONES //
              </div>

              {bands.map((b) => (
                <button
                  key={b.id}
                  onClick={() => {
                    switchBand(b.id)
                    setShowBandMenu(false)
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: b.id === activeBand?.id ? colors.borderSoft : 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${colors.borderSoft}`,
                    color: colors.text,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: b.id === activeBand?.id ? 700 : 400 }}>{b.name}</div>
                    <div style={{ fontSize: '10px', color: colors.muted }}>{b.genre}</div>
                  </div>
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: '9px',
                      color: b.id === activeBand?.id ? colors.orange : colors.muted,
                    }}
                  >
                    {sharing.sharedBandIds.includes(b.id) ? 'COMPARTIDA ' : ''}[{b.currentUserRole}]
                  </span>
                </button>
              ))}

              <button
                onClick={() => {
                  setShowNewBandModal(true)
                  setShowBandMenu(false)
                }}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'transparent',
                  border: 'none',
                  color: colors.cobalt,
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontFamily: mono,
                  fontWeight: 700,
                }}
              >
                <Plus size={14} />
                <span>+ NUEVA AGRUPACIÓN</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* NAVEGACION PRINCIPAL (ESCRITORIO) */}
      <nav className="hub-desktop-nav" aria-label="Vistas del hub" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        {HUB_TABS.map((tab) => {
          const active = activeTab === tab.id
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              className="stx-btn"
              data-testid={`tab-${tab.id}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 14px',
                background: active ? colors.elevated : 'transparent',
                border: active ? `1px solid ${tab.accent}` : '1px solid transparent',
                borderRadius: '4px',
                color: active ? colors.text : colors.muted,
                cursor: 'pointer',
                fontSize: '13px',
                fontFamily: mono,
                fontWeight: active ? 700 : 400,
              }}
            >
              <Icon size={15} style={{ color: active ? tab.accent : 'inherit' }} />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </nav>

      {/* ACTIONS & USER PROFILE */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        {/* MANUAL & DOCS BUTTON */}
        <button
          onClick={() => setShowManualModal(true)}
          title="Manual de Usuario & Guía Técnica"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            background: 'transparent',
            border: `1px solid ${colors.border}`,
            borderRadius: '4px',
            padding: '5px 8px',
            color: colors.muted,
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: mono,
          }}
        >
          <BookOpen size={13} style={{ color: colors.cobalt }} />
          <span className="hub-desktop-only">MANUAL</span>
        </button>

        {/* CLOUD SYNC STATUS (local only / syncing / synced / error) */}
        <button
          onClick={() => setShowSupabaseModal(true)}
          title={`${syncLabel.text}: ${syncTitle(syncStatus)}`}
          data-testid="sync-status"
          data-sync-state={syncStatus.state}
          aria-label={`Estado de la nube: ${syncLabel.text}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            background: syncStatus.state === 'local_only' ? 'transparent' : `${syncLabel.color}1a`,
            border: `1px solid ${syncStatus.state === 'local_only' ? colors.border : syncLabel.color}`,
            borderRadius: '4px',
            padding: '5px 8px',
            color: syncLabel.color,
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: mono,
          }}
        >
          <Cloud size={13} />
          <span className="hub-desktop-only">{syncLabel.text}</span>
        </button>

        <button
          onClick={exportWorkspaceJson}
          title="Exportar la banda activa y el workspace v2 completo como JSON"
          className="hub-desktop-only"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            border: `1px solid ${colors.border}`,
            borderRadius: '4px',
            padding: '6px 10px',
            color: colors.muted,
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: mono,
          }}
        >
          <Download size={13} />
          <span>EXPORTAR JSON</span>
        </button>

        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            {/* USER PROFILE TRIGGER */}
            <button
              onClick={() => setShowProfileModal(true)}
              title={`Usuario: ${user.name} (${user.email}) - Ver perfil`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: colors.elevated,
                border: `1px solid ${colors.border}`,
                padding: '3px 8px 3px 3px',
                borderRadius: '20px',
                cursor: 'pointer',
                color: colors.text,
                maxWidth: '180px',
              }}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.name}
                  style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    background: colors.cobalt,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: colors.onAccent,
                    flexShrink: 0,
                  }}
                >
                  {user.name.charAt(0)}
                </div>
              )}

              <div className="hub-desktop-only" style={{ display: 'flex', flexDirection: 'column', textAlign: 'left', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {user.name}
                  </span>
                  {hasGoogleIdentity && <GoogleIcon size={12} />}
                </div>
                <span style={{ fontSize: '9px', color: colors.muted, fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.email}
                </span>
              </div>
            </button>

            {/* DIRECT LOGOUT BUTTON ALWAYS VISIBLE */}
            <button
              onClick={() => void logout()}
              title="Cerrar sesión"
              style={{
                background: 'rgba(217, 100, 89, 0.15)',
                border: `1px solid ${colors.danger}`,
                color: colors.danger,
                borderRadius: '4px',
                padding: '5px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                cursor: 'pointer',
                fontFamily: mono,
                fontSize: '10px',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              <LogOut size={14} />
              <span className="hub-desktop-only">SALIR</span>
            </button>
          </div>
        )}
      </div>

      {/* CREATE NEW BAND MODAL */}
      {showNewBandModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: colors.modal,
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              padding: '24px',
              width: '100%',
              maxWidth: '420px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.7)',
            }}
          >
            <h3
              style={{
                margin: '0 0 16px 0',
                fontFamily: mono,
                fontSize: '16px',
                letterSpacing: '1px',
              }}
            >
              CREAR NUEVA AGRUPACIÓN
            </h3>
            <form onSubmit={handleCreateBand} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '11px', color: colors.muted, fontFamily: mono }}>
                  NOMBRE DE LA BANDA O PROYECTO
                </label>
                <input
                  type="text"
                  value={newBandName}
                  onChange={(e) => setNewBandName(e.target.value)}
                  placeholder="Ej: Big Band Pereira"
                  required
                  style={{
                    width: '100%',
                    background: colors.input,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '4px',
                    padding: '10px',
                    color: colors.text,
                    marginTop: '4px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: colors.muted, fontFamily: mono }}>
                  GÉNERO / ESTILO
                </label>
                <input
                  type="text"
                  value={newBandGenre}
                  onChange={(e) => setNewBandGenre(e.target.value)}
                  placeholder="Ej: Jazz Fusión / Rock / Sinfónico"
                  style={{
                    width: '100%',
                    background: colors.input,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '4px',
                    padding: '10px',
                    color: colors.text,
                    marginTop: '4px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowNewBandModal(false)}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${colors.border}`,
                    color: colors.muted,
                    padding: '8px 16px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: colors.cobalt,
                    border: 'none',
                    color: colors.onAccent,
                    padding: '8px 20px',
                    borderRadius: '4px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  CREAR BANDA
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* USER PROFILE & LOGOUT MODAL */}
      {showProfileModal && user && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: colors.modal,
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              padding: 'clamp(16px, 4vw, 24px)',
              width: '100%',
              maxWidth: '380px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.8)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              maxHeight: '90dvh',
              overflowY: 'auto',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: `1px solid ${colors.border}`,
                paddingBottom: '12px',
              }}
            >
              <div
                style={{
                  fontFamily: mono,
                  fontSize: '13px',
                  fontWeight: 700,
                  color: colors.text,
                  letterSpacing: '1px',
                }}
              >
                PERFIL & SESIÓN
              </div>
              <button
                onClick={() => setShowProfileModal(false)}
                aria-label="Cerrar perfil"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: colors.muted,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px',
                }}
              >
                <X size={18} />
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                background: colors.input,
                padding: '14px',
                borderRadius: '6px',
                border: `1px solid ${colors.border}`,
              }}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.name}
                  style={{ width: '48px', height: '48px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    background: colors.cobalt,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '20px',
                    fontWeight: 700,
                    color: colors.onAccent,
                    flexShrink: 0,
                  }}
                >
                  {user.name.charAt(0)}
                </div>
              )}
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontWeight: 800, fontSize: '15px', color: colors.text }}>{user.name}</div>
                <div
                  style={{
                    fontSize: '12px',
                    color: colors.muted,
                    fontFamily: mono,
                    wordBreak: 'break-all',
                  }}
                >
                  {user.email}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                  {hasGoogleIdentity && <GoogleIcon size={12} />}
                  <span
                    data-testid="profile-provider"
                    style={{
                      fontSize: '10px',
                      color: user.authProvider === 'supabase' ? colors.success : colors.warning,
                      fontFamily: mono,
                      fontWeight: 700,
                    }}
                  >
                    {PROVIDER_LABELS[user.authProvider]}
                  </span>
                </div>
              </div>
            </div>

            <div
              style={{
                background: colors.cardAlt,
                border: `1px solid ${colors.border}`,
                borderRadius: '6px',
                padding: '12px',
                fontSize: '11px',
                color: colors.muted,
                fontFamily: mono,
                lineHeight: 1.6,
              }}
            >
              <div>COPIA LOCAL (LOCALSTORAGE):</div>
              <div style={{ color: colors.text, fontWeight: 700, wordBreak: 'break-all' }}>
                bandait_workspace_{user.id}
              </div>
              <div style={{ marginTop: '4px' }}>
                NUBE:{' '}
                <span style={{ color: user.authProvider === 'supabase' ? colors.success : colors.muted, fontWeight: 700 }}>
                  {user.authProvider === 'supabase' ? `fila user_id = ${user.id}` : 'sin nube (perfil local)'}
                </span>
              </div>
              <div style={{ marginTop: '4px' }}>
                BANDA ACTIVA:{' '}
                <span style={{ color: colors.orange, fontWeight: 700 }}>{activeBand?.name}</span>{' '}
                [{(activeBandRole ?? '').toUpperCase()}]
              </div>
            </div>

            <button
              onClick={() => {
                setShowProfileModal(false)
                exportWorkspaceJson()
              }}
              style={{
                background: 'transparent',
                border: `1px solid ${colors.border}`,
                color: colors.muted,
                borderRadius: '4px',
                padding: '10px',
                fontFamily: mono,
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              <Download size={14} />
              <span>EXPORTAR COPIA DE SEGURIDAD JSON</span>
            </button>

            <button
              onClick={() => importInputRef.current?.click()}
              data-testid="import-workspace"
              style={{
                background: 'transparent',
                border: `1px solid ${colors.border}`,
                color: colors.muted,
                borderRadius: '4px',
                padding: '10px',
                fontFamily: mono,
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              <Upload size={14} />
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
                style={{
                  fontSize: '11px',
                  fontFamily: mono,
                  color: importMessage.ok ? colors.success : colors.danger,
                  lineHeight: 1.5,
                }}
              >
                {importMessage.text}
              </div>
            )}

            <button
              onClick={() => {
                setShowProfileModal(false)
                void logout()
              }}
              style={{
                background: colors.danger,
                border: 'none',
                color: colors.onAccent,
                borderRadius: '4px',
                padding: '12px',
                fontFamily: mono,
                fontSize: '12px',
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                boxShadow: '0 4px 14px rgba(217, 100, 89, 0.4)',
              }}
            >
              <LogOut size={16} />
              <span>CERRAR SESIÓN</span>
            </button>
          </div>
        </div>
      )}

      {/* USER MANUAL & TECHNICAL GUIDE MODAL */}
      {showManualModal && <UserManualModal onClose={() => setShowManualModal(false)} />}

      {/* SUPABASE CLOUD SYNC MODAL */}
      {showSupabaseModal && <SupabaseConfigModal onClose={() => setShowSupabaseModal(false)} />}
    </header>

    {/* BARRA INFERIOR EN MOVIL */}
    <nav
      className="hub-mobile-nav"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: '56px',
        background: colors.cardAlt,
        borderTop: `1px solid ${colors.border}`,
        alignItems: 'center',
        justifyContent: 'space-around',
        zIndex: 999,
        padding: '0 4px',
        boxSizing: 'border-box',
      }}
    >
      {HUB_TABS.map((tab) => {
        const active = activeTab === tab.id
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            type="button"
            className="stx-btn"
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectTab(tab.id)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              height: '100%',
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              color: active ? tab.accent : colors.muted,
              fontSize: '10px',
              fontFamily: mono,
              fontWeight: active ? 700 : 400,
              cursor: 'pointer',
              borderTop: active ? `2px solid ${tab.accent}` : '2px solid transparent',
            }}
          >
            <Icon size={18} />
            <span>{tab.short}</span>
          </button>
        )
      })}
    </nav>
  </>
  )
}
