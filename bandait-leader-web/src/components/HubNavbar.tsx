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
} from 'lucide-react'

export type HubTab = 'playlists' | 'stems' | 'members' | 'equipment'

interface Props {
  activeTab: HubTab
  onSelectTab: (tab: HubTab) => void
}

export const HubNavbar: React.FC<Props> = ({ activeTab, onSelectTab }) => {
  const { user, bands, activeBand, switchBand, createBand, logout, exportMasterXlsxJson } = useHub()
  const [showBandMenu, setShowBandMenu] = useState(false)
  const [showNewBandModal, setShowNewBandModal] = useState(false)
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
    <header
      style={{
        background: '#12151c',
        borderBottom: '1px solid #2a3346',
        padding: '10px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      {/* BRAND & MULTI-BAND SWITCHER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              width: '28px',
              height: '28px',
              background: 'linear-gradient(135deg, #ff4500, #0066ff)',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '14px',
              color: '#ffffff',
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            B
          </div>
          <div>
            <div
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontWeight: 800,
                fontSize: '14px',
                letterSpacing: '1px',
                color: '#ffffff',
                lineHeight: 1.1,
              }}
            >
              BANDAIT
            </div>
            <div
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
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowBandMenu(!showBandMenu)}
            style={{
              background: '#1a202c',
              border: '1px solid #2a3346',
              borderRadius: '4px',
              padding: '6px 12px',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              cursor: 'pointer',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            <Layers size={14} style={{ color: '#0066ff' }} />
            <span style={{ fontWeight: 700 }}>{activeBand ? activeBand.name : 'Seleccionar Banda'}</span>
            <span
              style={{
                fontSize: '9px',
                background: '#ff4500',
                color: '#ffffff',
                padding: '1px 5px',
                borderRadius: '2px',
                fontWeight: 700,
              }}
            >
              [{activeBand?.currentUserRole.toUpperCase()}]
            </span>
            <ChevronDown size={14} style={{ opacity: 0.6 }} />
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

      {/* 4 MAIN NAVIGATION TABS */}
      <nav style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          onClick={exportMasterXlsxJson}
          title="Exportar Libro Maestro XLSX/JSON"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            border: '1px solid #2a3346',
            borderRadius: '4px',
            padding: '6px 12px',
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: '#1a202c',
              border: '1px solid #2a3346',
              padding: '4px 10px 4px 6px',
              borderRadius: '20px',
            }}
          >
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name}
                style={{ width: '26px', height: '26px', borderRadius: '50%', objectFit: 'cover' }}
              />
            ) : (
              <div
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  background: '#0066ff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                }}
              >
                {user.name.charAt(0)}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>{user.name}</span>
                <GoogleIcon size={12} />
              </div>
              <span style={{ fontSize: '9px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                {user.email}
              </span>
            </div>

            <button
              onClick={logout}
              title="Cerrar Sesión Google"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#ef4444',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                marginLeft: '4px',
              }}
            >
              <LogOut size={14} />
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
    </header>
  )
}
