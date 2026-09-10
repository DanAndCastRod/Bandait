import React, { useState } from 'react'
import { useHub } from '../context/HubContext'
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
} from 'lucide-react'
import { UserManualModal } from './UserManualModal'
import { SupabaseConfigModal } from './SupabaseConfigModal'
import { getSupabaseConfig } from '../services/supabaseClient'

export type HubTab = 'playlists' | 'stems' | 'members' | 'equipment'

interface Props {
  activeTab: HubTab
  onSelectTab: (tab: HubTab) => void
}

export const HubNavbar: React.FC<Props> = ({ activeTab, onSelectTab }) => {
  const { user, bands, activeBand, switchBand, createBand, logout, exportMasterXlsxJson } = useHub()
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
  const isCloudConfigured = getSupabaseConfig().isConfigured
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
        style={{
          background: '#12151c',
          borderBottom: '1px solid #2a3346',
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
              background: 'linear-gradient(135deg, #ff4500, #0066ff)',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '13px',
              color: '#ffffff',
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
                color: '#ffffff',
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
                color: '#94a3b8',
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
            onClick={() => setShowBandMenu(!showBandMenu)}
            style={{
              background: '#1a202c',
              border: '1px solid #2a3346',
              borderRadius: '4px',
              padding: '5px 8px',
              color: '#ffffff',
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
            <Layers size={13} style={{ color: '#0066ff', flexShrink: 0 }} />
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
                background: '#ff4500',
                color: '#ffffff',
                padding: '1px 5px',
                borderRadius: '2px',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              [{activeBand?.currentUserRole.toUpperCase()}]
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
                background: '#161b26',
                border: '1px solid #2a3346',
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
                  color: '#94a3b8',
                  borderBottom: '1px solid #2a3346',
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
                    background: b.id === activeBand?.id ? '#1f293d' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid #222938',
                    color: '#ffffff',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: b.id === activeBand?.id ? 700 : 400 }}>{b.name}</div>
                    <div style={{ fontSize: '10px', color: '#94a3b8' }}>{b.genre}</div>
                  </div>
                  <span
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: '9px',
                      color: b.id === activeBand?.id ? '#ff4500' : '#94a3b8',
                    }}
                  >
                    [{b.currentUserRole}]
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
                  color: '#0066ff',
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
            background: activeTab === 'playlists' ? '#1a202c' : 'transparent',
            border: activeTab === 'playlists' ? '1px solid #ff4500' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'playlists' ? '#ffffff' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'playlists' ? 700 : 400,
          }}
        >
          <ListMusic size={15} style={{ color: activeTab === 'playlists' ? '#ff4500' : 'inherit' }} />
          <span>PLAYLISTS</span>
        </button>

        <button
          onClick={() => onSelectTab('stems')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'stems' ? '#1a202c' : 'transparent',
            border: activeTab === 'stems' ? '1px solid #0066ff' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'stems' ? '#ffffff' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'stems' ? 700 : 400,
          }}
        >
          <Sliders size={15} style={{ color: activeTab === 'stems' ? '#0066ff' : 'inherit' }} />
          <span>PISTAS & STEMS</span>
        </button>

        <button
          onClick={() => onSelectTab('members')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'members' ? '#1a202c' : 'transparent',
            border: activeTab === 'members' ? '1px solid #10b981' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'members' ? '#ffffff' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'members' ? 700 : 400,
          }}
        >
          <Users size={15} style={{ color: activeTab === 'members' ? '#10b981' : 'inherit' }} />
          <span>INTEGRANTES</span>
        </button>

        <button
          onClick={() => onSelectTab('equipment')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: activeTab === 'equipment' ? '#1a202c' : 'transparent',
            border: activeTab === 'equipment' ? '1px solid #f59e0b' : '1px solid transparent',
            borderRadius: '4px',
            color: activeTab === 'equipment' ? '#ffffff' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: activeTab === 'equipment' ? 700 : 400,
          }}
        >
          <Radio size={15} style={{ color: activeTab === 'equipment' ? '#f59e0b' : 'inherit' }} />
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
            border: '1px solid #2a3346',
            borderRadius: '4px',
            padding: '5px 8px',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <BookOpen size={13} style={{ color: '#0066ff' }} />
          <span className="hub-desktop-only">MANUAL</span>
        </button>

        {/* SUPABASE CLOUD SYNC BUTTON */}
        <button
          onClick={() => setShowSupabaseModal(true)}
          title={isCloudConfigured ? 'Sincronización en la Nube Activa' : 'Configurar Nube Supabase'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            background: isCloudConfigured ? 'rgba(16, 185, 129, 0.1)' : 'transparent',
            border: `1px solid ${isCloudConfigured ? '#10b981' : '#2a3346'}`,
            borderRadius: '4px',
            padding: '5px 8px',
            color: isCloudConfigured ? '#10b981' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <Cloud size={13} />
          <span className="hub-desktop-only">{isCloudConfigured ? 'NUBE OK' : 'NUBE'}</span>
        </button>

        <button
          onClick={exportMasterXlsxJson}
          title="Exportar Libro Maestro XLSX/JSON"
          className="hub-desktop-only"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            border: '1px solid #2a3346',
            borderRadius: '4px',
            padding: '6px 10px',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <Download size={13} />
          <span>EXPORTAR MAESTRO</span>
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
                background: '#1a202c',
                border: '1px solid #2a3346',
                padding: '3px 8px 3px 3px',
                borderRadius: '20px',
                cursor: 'pointer',
                color: '#ffffff',
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
                    background: '#0066ff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: '#ffffff',
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
                  <GoogleIcon size={12} />
                </div>
                <span style={{ fontSize: '9px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.email}
                </span>
              </div>
            </button>

            {/* DIRECT LOGOUT BUTTON ALWAYS VISIBLE */}
            <button
              onClick={logout}
              title="Cerrar Sesión Google"
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid #ef4444',
                color: '#ef4444',
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
              background: '#161b26',
              border: '1px solid #2a3346',
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
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
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
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  GÉNERO / ESTILO
                </label>
                <input
                  type="text"
                  value={newBandGenre}
                  onChange={(e) => setNewBandGenre(e.target.value)}
                  placeholder="Ej: Jazz Fusión / Rock / Sinfónico"
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '10px',
                    color: '#ffffff',
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
                    border: '1px solid #2a3346',
                    color: '#94a3b8',
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
                    background: '#0066ff',
                    border: 'none',
                    color: '#ffffff',
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
              background: '#161b26',
              border: '1px solid #2a3346',
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
                borderBottom: '1px solid #2a3346',
                paddingBottom: '12px',
              }}
            >
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: '13px',
                  fontWeight: 700,
                  color: '#ffffff',
                  letterSpacing: '1px',
                }}
              >
                PERFIL & SESIÓN
              </div>
              <button
                onClick={() => setShowProfileModal(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
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
                background: '#0d1017',
                padding: '14px',
                borderRadius: '6px',
                border: '1px solid #2a3346',
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
                    background: '#0066ff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '20px',
                    fontWeight: 700,
                    color: '#ffffff',
                    flexShrink: 0,
                  }}
                >
                  {user.name.charAt(0)}
                </div>
              )}
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontWeight: 800, fontSize: '15px', color: '#ffffff' }}>{user.name}</div>
                <div
                  style={{
                    fontSize: '12px',
                    color: '#94a3b8',
                    fontFamily: "'IBM Plex Mono', monospace",
                    wordBreak: 'break-all',
                  }}
                >
                  {user.email}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                  <GoogleIcon size={12} />
                  <span
                    style={{
                      fontSize: '10px',
                      color: '#10b981',
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontWeight: 700,
                    }}
                  >
                    CUENTA VERIFICADA
                  </span>
                </div>
              </div>
            </div>

            <div
              style={{
                background: '#12151c',
                border: '1px solid #2a3346',
                borderRadius: '6px',
                padding: '12px',
                fontSize: '11px',
                color: '#94a3b8',
                fontFamily: "'IBM Plex Mono', monospace",
                lineHeight: 1.6,
              }}
            >
              <div>ESPACIO DE TRABAJO LOCAL:</div>
              <div style={{ color: '#ffffff', fontWeight: 700, wordBreak: 'break-all' }}>
                bandait_workspace_{user.id}
              </div>
              <div style={{ marginTop: '4px' }}>
                BANDA ACTIVA:{' '}
                <span style={{ color: '#ff4500', fontWeight: 700 }}>{activeBand?.name}</span>{' '}
                [{activeBand?.currentUserRole.toUpperCase()}]
              </div>
            </div>

            <button
              onClick={() => {
                setShowProfileModal(false)
                exportMasterXlsxJson()
              }}
              style={{
                background: 'transparent',
                border: '1px solid #2a3346',
                color: '#94a3b8',
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
              <span>EXPORTAR COPIA DE SEGURIDAD XLSX</span>
            </button>

            <button
              onClick={() => {
                setShowProfileModal(false)
                logout()
              }}
              style={{
                background: '#ef4444',
                border: 'none',
                color: '#ffffff',
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
                boxShadow: '0 4px 14px rgba(239, 68, 68, 0.4)',
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
        background: '#12151c',
        borderTop: '1px solid #2a3346',
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
          color: activeTab === 'playlists' ? '#ff4500' : '#94a3b8',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'playlists' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'playlists' ? '2px solid #ff4500' : '2px solid transparent',
        }}
      >
        <ListMusic size={18} />
        <span>SETLISTS</span>
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
          color: activeTab === 'stems' ? '#0066ff' : '#94a3b8',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'stems' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'stems' ? '2px solid #0066ff' : '2px solid transparent',
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
          color: activeTab === 'members' ? '#10b981' : '#94a3b8',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'members' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'members' ? '2px solid #10b981' : '2px solid transparent',
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
          color: activeTab === 'equipment' ? '#f59e0b' : '#94a3b8',
          fontSize: '10px',
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: activeTab === 'equipment' ? 700 : 400,
          cursor: 'pointer',
          borderTop: activeTab === 'equipment' ? '2px solid #f59e0b' : '2px solid transparent',
        }}
      >
        <Radio size={18} />
        <span>RACKS RF</span>
      </button>
    </nav>
  </>
  )
}
