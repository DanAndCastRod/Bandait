import React, { useState, useEffect, useRef } from 'react'
import { GoogleIcon } from './GoogleIcon'
import { useHub } from '../context/HubContext'
import { DEMO_PROFILES } from '../services/authService'
import {
  ListMusic,
  Sliders,
  Users,
  Radio,
  ShieldCheck,
  Settings,
  Key,
  ArrowRight,
} from 'lucide-react'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string
            callback: (response: { credential: string }) => void
            auto_select?: boolean
          }) => void
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: string
              size?: string
              width?: number | string
              text?: string
              shape?: string
            }
          ) => void
          prompt?: () => void
        }
      }
    }
  }
}

export const AuthScreen: React.FC = () => {
  const {
    loginWithGoogleCredential,
    loginWithPersonalAccount,
    loginWithDemoProfile,
    googleClientId,
    setGoogleClientId,
  } = useHub()

  const [personalName, setPersonalName] = useState('')
  const [personalEmail, setPersonalEmail] = useState('')
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [clientIdInput, setClientIdInput] = useState(googleClientId || '')
  const [gisLoaded, setGisLoaded] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const googleBtnRef = useRef<HTMLDivElement>(null)

  // Initialize Google Identity Services if available and clientId is set
  useEffect(() => {
    const checkGis = () => {
      if (window.google?.accounts?.id) {
        setGisLoaded(true)
        if (googleClientId && googleBtnRef.current) {
          try {
            window.google.accounts.id.initialize({
              client_id: googleClientId,
              callback: (response) => {
                try {
                  loginWithGoogleCredential(response.credential)
                } catch (err: unknown) {
                  setAuthError(err instanceof Error ? err.message : 'Error de autenticación Google')
                }
              },
              auto_select: false,
            })
            googleBtnRef.current.innerHTML = ''
            window.google.accounts.id.renderButton(googleBtnRef.current, {
              theme: 'filled_black',
              size: 'large',
              width: 320,
              text: 'continue_with',
              shape: 'rectangular',
            })
          } catch (e) {
            console.warn('Error initializing Google GIS:', e)
          }
        }
      }
    }

    checkGis()
    const interval = setInterval(checkGis, 800)
    return () => clearInterval(interval)
  }, [googleClientId, loginWithGoogleCredential])

  const handlePersonalSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(null)
    if (!personalEmail.trim() || !personalEmail.includes('@')) {
      setAuthError('Por favor ingresa un correo de Google válido.')
      return
    }
    loginWithPersonalAccount(personalName.trim() || personalEmail.split('@')[0], personalEmail.trim())
  }

  const handleSaveClientId = (e: React.FormEvent) => {
    e.preventDefault()
    setGoogleClientId(clientIdInput.trim())
    setShowConfigModal(false)
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        background: 'radial-gradient(circle at 50% 15%, #161b26 0%, #0a0c10 80%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        boxSizing: 'border-box',
        color: '#ffffff',
        fontFamily: "'Space Grotesk', -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '560px',
          background: 'linear-gradient(180deg, #131720 0%, #0d1017 100%)',
          border: '1px solid #2a3346',
          borderRadius: '8px',
          padding: '36px 32px',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7)',
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
          position: 'relative',
        }}
      >
        {/* TOP ACCENT LINE */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: 'linear-gradient(90deg, #ff4500, #0066ff)',
            borderRadius: '8px 8px 0 0',
          }}
        />

        {/* HEADER */}
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '11px',
              fontWeight: 700,
              color: '#ff4500',
              letterSpacing: '2px',
              marginBottom: '6px',
            }}
          >
            [BANDAIT 3.0 // CLOUD & WEB ADMIN HUB]
          </div>
          <h1
            style={{
              fontSize: '30px',
              fontWeight: 800,
              letterSpacing: '-0.5px',
              margin: '0 0 8px 0',
              color: '#ffffff',
            }}
          >
            Acceso a tu Workspace
          </h1>
          <p
            style={{
              fontSize: '13px',
              color: '#94a3b8',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            Vincula tu cuenta de Google para administrar tus agrupaciones, setlists maestros, matrices de stems y ruteo ASIO con persistencia autónoma.
          </p>
        </div>

        {/* ERROR NOTIFICATION */}
        {authError && (
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid #ef4444',
              borderRadius: '4px',
              padding: '10px 14px',
              color: '#fca5a5',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            [ERROR // AUTH]: {authError}
          </div>
        )}

        {/* GOOGLE NATIVE IDENTITY SECTION */}
        <div
          style={{
            background: '#0d1017',
            border: '1px solid #2a3346',
            borderRadius: '6px',
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <GoogleIcon size={18} />
              <span style={{ fontSize: '13px', fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>
                GOOGLE OAUTH 2.0 PKCE
              </span>
            </div>

            <button
              onClick={() => setShowConfigModal(true)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#0066ff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                fontFamily: "'IBM Plex Mono', monospace",
                textDecoration: 'underline',
              }}
              title="Configurar Google Cloud Client ID"
            >
              <Settings size={12} />
              <span>{googleClientId ? 'Client ID Activo' : 'Configurar Client ID'}</span>
            </button>
          </div>

          {/* Render container for official Google Identity Services button */}
          {googleClientId ? (
            <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
              <div ref={googleBtnRef} style={{ minHeight: '44px' }}>
                {!gisLoaded && (
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                    Cargando servicio de Google...
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                width: '100%',
                background: '#161b26',
                border: '1px dashed #2a3346',
                borderRadius: '4px',
                padding: '12px 14px',
                fontSize: '11px',
                color: '#94a3b8',
                lineHeight: 1.4,
              }}
            >
              <span style={{ color: '#0066ff', fontWeight: 700 }}>Google Identity Services: </span>
              Para activar el botón nativo de Google en este dominio,{' '}
              <button
                onClick={() => setShowConfigModal(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#ff4500',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 'inherit',
                  fontFamily: 'inherit',
                }}
              >
                agrega tu Client ID de Google Cloud
              </button>
              , o vincula tu cuenta directamente abajo:
            </div>
          )}
        </div>

        {/* DIRECT PERSONAL ACCOUNT LOGIN FORM */}
        <form
          onSubmit={handlePersonalSubmit}
          style={{
            background: '#131720',
            border: '1px solid #2a3346',
            borderRadius: '6px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <div
            style={{
              fontSize: '12px',
              fontWeight: 700,
              fontFamily: "'IBM Plex Mono', monospace",
              color: '#e2e8f0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <ShieldCheck size={14} style={{ color: '#10b981' }} />
            <span>VINCULAR CUENTA PERSONAL // TU WORKSPACE REAL</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
              NOMBRE COMPLETO O ALIAS DE MÚSICO
            </label>
            <input
              type="text"
              value={personalName}
              onChange={(e) => setPersonalName(e.target.value)}
              placeholder="Ej: Daniel Castro"
              required
              style={{
                background: '#0a0c10',
                border: '1px solid #2a3346',
                borderRadius: '4px',
                padding: '10px 12px',
                color: '#ffffff',
                fontSize: '13px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
              CORREO ELECTRÓNICO (GOOGLE / GMAIL)
            </label>
            <input
              type="email"
              value={personalEmail}
              onChange={(e) => setPersonalEmail(e.target.value)}
              placeholder="tu.usuario@gmail.com"
              required
              style={{
                background: '#0a0c10',
                border: '1px solid #2a3346',
                borderRadius: '4px',
                padding: '10px 12px',
                color: '#ffffff',
                fontSize: '13px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <button
            type="submit"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              background: '#0066ff',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              padding: '12px 18px',
              fontSize: '13px',
              fontWeight: 700,
              fontFamily: "'IBM Plex Mono', monospace",
              cursor: 'pointer',
              marginTop: '4px',
              transition: 'background 0.15s ease',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = '#0052cc')}
            onMouseOut={(e) => (e.currentTarget.style.background = '#0066ff')}
          >
            <span>INGRESAR A MI WORKSPACE PERSONAL</span>
            <ArrowRight size={14} />
          </button>
        </form>

        {/* DEMO PROFILES SECTION */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '10px',
              color: '#64748b',
              letterSpacing: '1px',
            }}
          >
            <div style={{ flex: 1, height: '1px', background: '#1e293b' }} />
            <span>O EXPLORAR ESCENARIOS DE DEMOSTRACIÓN (MODO ROADIE)</span>
            <div style={{ flex: 1, height: '1px', background: '#1e293b' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {DEMO_PROFILES.map((prof) => (
              <button
                key={prof.id}
                onClick={() => loginWithDemoProfile(prof)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#161b26',
                  border: '1px solid #222938',
                  borderRadius: '6px',
                  padding: '10px 14px',
                  color: '#ffffff',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.borderColor = '#0066ff'
                  e.currentTarget.style.background = '#1a202c'
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.borderColor = '#222938'
                  e.currentTarget.style.background = '#161b26'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <img
                    src={prof.avatarUrl}
                    alt={prof.name}
                    style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover' }}
                  />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '13px' }}>{prof.name}</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                      {prof.email}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '10px',
                    color: '#ff4500',
                    border: '1px solid #ff4500',
                    padding: '2px 6px',
                    borderRadius: '3px',
                  }}
                >
                  {prof.id === 'usr_director_01'
                    ? 'DIRECTOR'
                    : prof.id === 'usr_foh_02'
                    ? 'FOH MASTER'
                    : 'BATERISTA'}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* TECHNICAL PILLARS FOOTER */}
        <div
          style={{
            borderTop: '1px solid #2a3346',
            paddingTop: '16px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <ListMusic size={15} style={{ color: '#ff4500' }} />
            <span>Setlists & Transición</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <Sliders size={15} style={{ color: '#0066ff' }} />
            <span>Stems & Limitador dBFS</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <Users size={15} style={{ color: '#10b981' }} />
            <span>Múltiples Bandas & Roles</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <Radio size={15} style={{ color: '#f59e0b' }} />
            <span>Racks ASIO & In-Ear RF</span>
          </div>
        </div>
      </div>

      {/* GOOGLE CLIENT ID CONFIG MODAL */}
      {showConfigModal && (
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
          }}
        >
          <div
            style={{
              background: '#161b26',
              border: '1px solid #2a3346',
              borderRadius: '8px',
              padding: '24px',
              width: '100%',
              maxWidth: '480px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Key size={18} style={{ color: '#0066ff' }} />
              <h3 style={{ margin: 0, fontSize: '16px', fontFamily: "'IBM Plex Mono', monospace" }}>
                CONFIGURAR GOOGLE CLIENT ID
              </h3>
            </div>

            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.4 }}>
              Ingresa el <strong>OAuth 2.0 Client ID</strong> registrado en Google Cloud Console para activar el popup y botón oficial de Google en este dominio.
            </p>

            <form onSubmit={handleSaveClientId} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  GOOGLE CLIENT ID (.apps.googleusercontent.com)
                </label>
                <input
                  type="text"
                  value={clientIdInput}
                  onChange={(e) => setClientIdInput(e.target.value)}
                  placeholder="ej: 123456789-abcdef.apps.googleusercontent.com"
                  style={{
                    width: '100%',
                    background: '#0a0c10',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    fontSize: '12px',
                    fontFamily: "'IBM Plex Mono', monospace",
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowConfigModal(false)}
                  style={{
                    background: '#1a202c',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 14px',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontFamily: "'IBM Plex Mono', monospace",
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: '#0066ff',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '8px 16px',
                    color: '#ffffff',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 700,
                    fontFamily: "'IBM Plex Mono', monospace",
                  }}
                >
                  GUARDAR CONFIGURACIÓN
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
