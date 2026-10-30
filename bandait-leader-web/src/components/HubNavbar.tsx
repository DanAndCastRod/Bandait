import React, { useRef, useState } from 'react'
import { useHub, type HubSyncStatus } from '../context/hubContextCore'
import { PROVIDER_LABELS } from '../services/authService'
import { GoogleIcon } from './GoogleIcon'
import {
  ListMusic,
  Sliders,
  Users,
  Radio,
  Download,
  Plus,
  LogOut,
  ChevronDown,
  Layers,
  X,
  BookOpen,
  Cloud,
  Library,
  Mic,
  Upload,
} from 'lucide-react'
import { UserManualModal } from './UserManualModal'
import { SupabaseConfigModal } from './SupabaseConfigModal'

export type HubTab = 'playlists' | 'songs' | 'voice' | 'stems' | 'members' | 'equipment'

interface Props {
  activeTab: HubTab
  onSelectTab: (tab: HubTab) => void
}

const SYNC_LABEL: Record<HubSyncStatus['state'], { text: string; color: string }> = {
  local_only: { text: 'SOLO LOCAL', color: '#8E97A3' },
  syncing: { text: 'SINCRONIZANDO', color: '#7AC4D6' },
  synced: { text: 'SINCRONIZADO', color: '#B8CF7A' },
  error: { text: 'ERROR NUBE', color: '#D96459' },
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
          background: '#1A1E23',
          borderBottom: '1px solid #2E343D',
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
              background: 'linear-gradient(135deg, #5CC8C2, #7AA5D6)',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '13px',
              color: '#D5DAE0',
              fontFamily: "'IBM Plex Mono', monospace",
              flexShrink: 0,
            }}
          >
            B
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontWeight: 800,
                fontSize: '13px',
                letterSpacing: '1px',
                color: '#D5DAE0',
                lineHeight: 1.1,
              }}
            >
              BANDAIT
            </div>
            <div
              className="hub-desktop-only"
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '9px',
                color: '#8E97A3',
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
              background: '#232830',
              border: '1px solid #2E343D',
              borderRadius: '4px',
              padding: '5px 8px',
              color: '#D5DAE0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              fontSize: '11px',
              fontFamily: "'IBM Plex Mono', monospace",
              maxWidth: 'clamp(100px, 28vw, 220px)',
              whiteSpace: 'nowrap',
            }}
          >
            <Layers size={13} style={{ color: '#7AA5D6', flexShrink: 0 }} />
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
                background: '#5CC8C2',
                color: '#15181C',
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
                background: '#20252B',
                border: '1px solid #2E343D',
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
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: '10px',
                  color: '#8E97A3',
                  borderBottom: '1px solid #2E343D',
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
                    background: b.id === activeBand?.id ? '#2B313A' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid #2B313A',
                    color: '#D5DAE0',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: b.id === activeBand?.id ? 700 : 400 }}>{b.name}</div>
                    <div style={{ fontSize: '10px', color: '#8E97A3' }}>{b.genre}</div>
                  </div>
                  <span
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: '9px',
                      color: b.id === activeBand?.id ? '#5CC8C2' : '#8E97A3',
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
                  color: '#7AA5D6',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontFamily: "'IBM Plex Mono', monospace",
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

      {/* 4 MAIN NAVIGATION TABS (DESKTOP) */}
      <nav className="hub-desktop-nav" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <button
          onClick={() => onSelectTab('playlists')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'playlists' ? '#232830' : 'transparent',
            border: activeTab === 'playlists' ? '1px solid #5CC8C2' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'playlists' ? '#D5DAE0' : '#8E97A3',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'playlists' ? 700 : 400,
          }}
        >
          <ListMusic size={15} style={{ color: activeTab === 'playlists' ? '#5CC8C2' : 'inherit' }} />
          <span>PLAYLISTS</span>
        </button>

        <button
          onClick={() => onSelectTab('songs')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'songs' ? '#232830' : 'transparent',
            border: activeTab === 'songs' ? '1px solid #B48EDB' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'songs' ? '#D5DAE0' : '#8E97A3',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'songs' ? 700 : 400,
          }}
        >
          <Library size={15} style={{ color: activeTab === 'songs' ? '#B48EDB' : 'inherit' }} />
          <span>CANCIONES</span>
        </button>

        <button
          onClick={() => onSelectTab('voice')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'voice' ? '#232830' : 'transparent',
            border: activeTab === 'voice' ? '1px solid #7AC4D6' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'voice' ? '#D5DAE0' : '#8E97A3',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'voice' ? 700 : 400,
          }}
        >
          <Mic size={15} style={{ color: activeTab === 'voice' ? '#7AC4D6' : 'inherit' }} />
          <span>VOZ Y CONTEOS</span>
        </button>

        <button
          onClick={() => onSelectTab('stems')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'stems' ? '#232830' : 'transparent',
            border: activeTab === 'stems' ? '1px solid #7AA5D6' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'stems' ? '#D5DAE0' : '#8E97A3',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'stems' ? 700 : 400,
          }}
        >
          <Sliders size={15} style={{ color: activeTab === 'stems' ? '#7AA5D6' : 'inherit' }} />
          <span>PISTAS & STEMS</span>
        </button>

        <button
          onClick={() => onSelectTab('members')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'members' ? '#232830' : 'transparent',
            border: activeTab === 'members' ? '1px solid #B8CF7A' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'members' ? '#D5DAE0' : '#8E97A3',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'members' ? 700 : 400,
          }}
        >
          <Users size={15} style={{ color: activeTab === 'members' ? '#B8CF7A' : 'inherit' }} />
          <span>INTEGRANTES</span>
        </button>

        <button
          onClick={() => onSelectTab('equipment')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'equipment' ? '#232830' : 'transparent',
            border: activeTab === 'equipment' ? '1px solid #D9A24E' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'equipment' ? '#D5DAE0' : '#8E97A3',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'equipment' ? 700 : 400,
          }}
        >
          <Radio size={15} style={{ color: activeTab === 'equipment' ? '#D9A24E' : 'inherit' }} />
          <span>EQUIPAMIENTO</span>
        </button>
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
            border: '1px solid #2E343D',
            borderRadius: '4px',
            padding: '5px 8px',
            color: '#8E97A3',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <BookOpen size={13} style={{ color: '#7AA5D6' }} />
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
            border: `1px solid ${syncStatus.state === 'local_only' ? '#2E343D' : syncLabel.color}`,
            borderRadius: '4px',
            padding: '5px 8px',
            color: syncLabel.color,
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: "'IBM Plex Mono', monospace",
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
            border: '1px solid #2E343D',
            borderRadius: '4px',
            padding: '6px 10px',
            color: '#8E97A3',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: "'IBM Plex Mono', monospace",
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
                background: '#232830',
                border: '1px solid #2E343D',
                padding: '3px 8px 3px 3px',
                borderRadius: '20px',
                cursor: 'pointer',
                color: '#D5DAE0',
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
                    background: '#7AA5D6',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: '#15181C',
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
                <span style={{ fontSize: '9px', color: '#8E97A3', fontFamily: "'IBM Plex Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                border: '1px solid #D96459',
                color: '#D96459',
                borderRadius: '4px',
                padding: '5px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                cursor: 'pointer',
                fontFamily: "'IBM Plex Mono', monospace",
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
              background: '#20252B',
              border: '1px solid #2E343D',
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
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '16px',
                letterSpacing: '1px',
              }}
            >
              CREAR NUEVA AGRUPACIÓN
            </h3>
            <form onSubmit={handleCreateBand} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '11px', color: '#8E97A3', fontFamily: "'IBM Plex Mono', monospace" }}>
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
                    background: '#181B20',
                    border: '1px solid #2E343D',
                    borderRadius: '4px',
                    padding: '10px',
                    color: '#D5DAE0',
                    marginTop: '4px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#8E97A3', fontFamily: "'IBM Plex Mono', monospace" }}>
                  GÉNERO / ESTILO
                </label>
                <input
                  type="text"
                  value={newBandGenre}
                  onChange={(e) => setNewBandGenre(e.target.value)}
                  placeholder="Ej: Jazz Fusión / Rock / Sinfónico"
                  style={{
                    width: '100%',
                    background: '#181B20',
                    border: '1px solid #2E343D',
                    borderRadius: '4px',
                    padding: '10px',
                    color: '#D5DAE0',
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
                    border: '1px solid #2E343D',
                    color: '#8E97A3',
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
                    background: '#7AA5D6',
                    border: 'none',
                    color: '#15181C',
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
              background: '#20252B',
              border: '1px solid #2E343D',
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
                borderBottom: '1px solid #2E343D',
                paddingBottom: '12px',
              }}
            >
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: '13px',
                  fontWeight: 700,
                  color: '#D5DAE0',
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
                  color: '#8E97A3',
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
                background: '#181B20',
                padding: '14px',
                borderRadius: '6px',
                border: '1px solid #2E343D',
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
                    background: '#7AA5D6',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '20px',
                    fontWeight: 700,
                    color: '#15181C',
                    flexShrink: 0,
                  }}
                >
                  {user.name.charAt(0)}
                </div>
              )}
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontWeight: 800, fontSize: '15px', color: '#D5DAE0' }}>{user.name}</div>
                <div
                  style={{
                    fontSize: '12px',
                    color: '#8E97A3',
                    fontFamily: "'IBM Plex Mono', monospace",
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
                      color: user.authProvider === 'supabase' ? '#B8CF7A' : '#D9A24E',
                      fontFamily: "'IBM Plex Mono', monospace",
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
                background: '#1A1E23',
                border: '1px solid #2E343D',
                borderRadius: '6px',
                padding: '12px',
                fontSize: '11px',
                color: '#8E97A3',
                fontFamily: "'IBM Plex Mono', monospace",
                lineHeight: 1.6,
              }}
            >
              <div>COPIA LOCAL (LOCALSTORAGE):</div>
              <div style={{ color: '#D5DAE0', fontWeight: 700, wordBreak: 'break-all' }}>
                bandait_workspace_{user.id}
              </div>
              <div style={{ marginTop: '4px' }}>
                NUBE:{' '}
                <span style={{ color: user.authProvider === 'supabase' ? '#B8CF7A' : '#8E97A3', fontWeight: 700 }}>
                  {user.authProvider === 'supabase' ? `fila user_id = ${user.id}` : 'sin nube (perfil local)'}
                </span>
              </div>
              <div style={{ marginTop: '4px' }}>
                BANDA ACTIVA:{' '}
                <span style={{ color: '#5CC8C2', fontWeight: 700 }}>{activeBand?.name}</span>{' '}
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
                border: '1px solid #2E343D',
                color: '#8E97A3',
                borderRadius: '4px',
                padding: '10px',
                fontFamily: "'IBM Plex Mono', monospace",
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
                border: '1px solid #2E343D',
                color: '#8E97A3',
                borderRadius: '4px',
                padding: '10px',
                fontFamily: "'IBM Plex Mono', monospace",
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
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: importMessage.ok ? '#B8CF7A' : '#D96459',
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
                background: '#D96459',
                border: 'none',
                color: '#15181C',
                borderRadius: '4px',
                padding: '12px',
                fontFamily: "'IBM Plex Mono', monospace",
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

    {/* MOBILE BOTTOM NAVIGATION BAR */}
    <nav
      className="hub-mobile-nav"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: '56px',
        background: '#1A1E23',
        borderTop: '1px solid #2E343D',
        alignItems: 'center',
        justifyContent: 'space-around',
        zIndex: 999,
        padding: '0 4px',
        boxSizing: 'border-box',
      }}
    >
      <button
        onClick={() => onSelectTab('playlists')}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          height: '100%',
          background: 'transparent',
          border: 'none',
          color: activeTab === 'playlists' ? '#5CC8C2' : '#8E97A3',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'playlists' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'playlists' ? '2px solid #5CC8C2' : '2px solid transparent',
        }}
      >
        <ListMusic size={18} />
        <span>SETLISTS</span>
      </button>

      <button
        onClick={() => onSelectTab('songs')}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          height: '100%',
          background: 'transparent',
          border: 'none',
          color: activeTab === 'songs' ? '#B48EDB' : '#8E97A3',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'songs' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'songs' ? '2px solid #B48EDB' : '2px solid transparent',
        }}
      >
        <Library size={18} />
        <span>CANCIONES</span>
      </button>

      <button
        onClick={() => onSelectTab('voice')}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          height: '100%',
          background: 'transparent',
          border: 'none',
          color: activeTab === 'voice' ? '#7AC4D6' : '#8E97A3',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'voice' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'voice' ? '2px solid #7AC4D6' : '2px solid transparent',
        }}
      >
        <Mic size={18} />
        <span>VOZ</span>
      </button>

      <button
        onClick={() => onSelectTab('stems')}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          height: '100%',
          background: 'transparent',
          border: 'none',
          color: activeTab === 'stems' ? '#7AA5D6' : '#8E97A3',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'stems' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'stems' ? '2px solid #7AA5D6' : '2px solid transparent',
        }}
      >
        <Sliders size={18} />
        <span>STEMS</span>
      </button>

      <button
        onClick={() => onSelectTab('members')}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          height: '100%',
          background: 'transparent',
          border: 'none',
          color: activeTab === 'members' ? '#B8CF7A' : '#8E97A3',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'members' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'members' ? '2px solid #B8CF7A' : '2px solid transparent',
        }}
      >
        <Users size={18} />
        <span>BANDA</span>
      </button>

      <button
        onClick={() => onSelectTab('equipment')}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          height: '100%',
          background: 'transparent',
          border: 'none',
          color: activeTab === 'equipment' ? '#D9A24E' : '#8E97A3',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'equipment' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'equipment' ? '2px solid #D9A24E' : '2px solid transparent',
        }}
      >
        <Radio size={18} />
        <span>RACKS RF</span>
      </button>
    </nav>
  </>
  )
}
