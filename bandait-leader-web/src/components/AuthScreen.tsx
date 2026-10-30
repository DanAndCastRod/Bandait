import React, { useState, useEffect, useRef } from 'react'
import { GoogleIcon } from './GoogleIcon'
import { useHub } from '../context/hubContextCore'
import { DEMO_PROFILES, loadGoogleIdentityScript } from '../services/authService'
import {
  ListMusic,
  Sliders,
  Users,
  Radio,
  Settings,
  Key,
  ArrowRight,
  BookOpen,
  Cloud,
  HardDrive,
  FlaskConical,
} from 'lucide-react'
import { UserManualModal } from './UserManualModal'
import { SupabaseConfigModal } from './SupabaseConfigModal'

const mono = "'IBM Plex Mono', monospace"

const sectionStyle: React.CSSProperties = {
  background: '#181B20',
  border: '1px solid #2E343D',
  borderRadius: '6px',
  padding: '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 700,
  fontFamily: mono,
  color: '#D5DAE0',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
}

const helpStyle: React.CSSProperties = { margin: 0, fontSize: '11px', color: '#8E97A3', lineHeight: 1.5 }

const disabledExplainStyle: React.CSSProperties = {
  background: '#20252B',
  border: '1px dashed #2E343D',
  borderRadius: '4px',
  padding: '10px 12px',
  fontSize: '11px',
  color: '#8E97A3',
  lineHeight: 1.5,
}

const linkButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#5CC8C2',
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
  fontSize: 'inherit',
  fontFamily: 'inherit',
}

const inputStyle: React.CSSProperties = {
  background: '#15181C',
  border: '1px solid #2E343D',
  borderRadius: '4px',
  padding: '10px 12px',
  color: '#D5DAE0',
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
}

export const AuthScreen: React.FC = () => {
  const {
    cloud,
    authNotice,
    dismissAuthNotice,
    signInWithCloudGoogle,
    loginWithGoogleCredential,
    loginWithLocalProfile,
    loginWithDemoProfile,
    googleClientId,
    setGoogleClientId,
  } = useHub()

  const [personalName, setPersonalName] = useState('')
  const [personalEmail, setPersonalEmail] = useState('')
  const [showClientIdModal, setShowClientIdModal] = useState(false)
  const [showCloudModal, setShowCloudModal] = useState(false)
  const [showDemo, setShowDemo] = useState(false)
  const [clientIdInput, setClientIdInput] = useState(googleClientId || '')
  const [clientIdError, setClientIdError] = useState<string | null>(null)
  const [gisState, setGisState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [authError, setAuthError] = useState<string | null>(null)
  const [cloudBusy, setCloudBusy] = useState(false)
  const [showManualModal, setShowManualModal] = useState(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      return p.get('manual') === '1' || p.get('view') === 'manual'
    } catch {
      return false
    }
  })

  const googleBtnRef = useRef<HTMLDivElement>(null)

  // Google Identity Services solo se carga si hay un Client ID configurado. Crea un PERFIL LOCAL.
  useEffect(() => {
    if (!googleClientId) return
    let cancelled = false
    loadGoogleIdentityScript()
      .then(() => {
        const gis = window.google?.accounts?.id
        if (cancelled || !gis || !googleBtnRef.current) return
        gis.initialize({
          client_id: googleClientId,
          callback: (response) => {
            try {
              loginWithGoogleCredential(response.credential)
            } catch (err: unknown) {
              setAuthError(err instanceof Error ? err.message : 'Error con la credencial de Google.')
            }
          },
          auto_select: false,
        })
        googleBtnRef.current.innerHTML = ''
        gis.renderButton(googleBtnRef.current, {
          theme: 'filled_black',
          size: 'large',
          width: 320,
          text: 'continue_with',
          shape: 'rectangular',
        })
        setGisState('ready')
      })
      .catch(() => {
        if (!cancelled) setGisState('error')
      })
    return () => {
      cancelled = true
    }
  }, [googleClientId, loginWithGoogleCredential])

  const handleCloudLogin = async () => {
    setAuthError(null)
    setCloudBusy(true)
    const error = await signInWithCloudGoogle()
    // Si no hubo error el navegador ya esta saliendo hacia Google.
    if (error) {
      setAuthError(error)
      setCloudBusy(false)
    }
  }

  const handleLocalSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(null)
    if (!personalName.trim()) {
      setAuthError('Escribe un nombre o alias para el perfil local.')
      return
    }
    if (!personalEmail.trim() || !personalEmail.includes('@')) {
      setAuthError('Escribe un correo (solo se usa como etiqueta del perfil local).')
      return
    }
    loginWithLocalProfile(personalName.trim(), personalEmail.trim())
  }

  const handleSaveClientId = (e: React.FormEvent) => {
    e.preventDefault()
    const error = setGoogleClientId(clientIdInput.trim())
    if (error) {
      setClientIdError(error)
      return
    }
    setClientIdError(null)
    setGisState('loading')
    setShowClientIdModal(false)
  }

  const cloudDisabledReason = cloud.configError
    ? cloud.configError
    : !cloud.configured
      ? 'Supabase no está configurado en esta compilación del Hub (faltan VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY).'
      : null

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        background: 'radial-gradient(circle at 50% 15%, #20252B 0%, #15181C 80%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        boxSizing: 'border-box',
        color: '#D5DAE0',
        fontFamily: "'Space Grotesk', -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '560px',
          background: 'linear-gradient(180deg, #1B1F24 0%, #181B20 100%)',
          border: '1px solid #2E343D',
          borderRadius: '8px',
          padding: 'clamp(20px, 5vw, 36px) clamp(16px, 4vw, 32px)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7)',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          position: 'relative',
          boxSizing: 'border-box',
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
            background: 'linear-gradient(90deg, #5CC8C2, #7AA5D6)',
            borderRadius: '8px 8px 0 0',
          }}
        />

        {/* HEADER */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: mono, fontSize: '11px', fontWeight: 700, color: '#5CC8C2', letterSpacing: '2px', marginBottom: '6px' }}>
            [BANDAIT 3.0 // CLOUD & WEB ADMIN HUB]
          </div>
          <h1 style={{ fontSize: '30px', fontWeight: 800, letterSpacing: '-0.5px', margin: '0 0 8px 0', color: '#D5DAE0' }}>
            Acceso a tu Workspace
          </h1>
          <p style={{ fontSize: '13px', color: '#8E97A3', margin: 0, lineHeight: 1.5 }}>
            Administra agrupaciones, setlists, stems y ruteo. Solo la cuenta de nube sincroniza entre dispositivos; los
            perfiles locales guardan todo en este navegador.
          </p>

          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '12px' }}>
            <button
              type="button"
              onClick={() => setShowManualModal(true)}
              style={{
                background: 'rgba(122, 165, 214, 0.08)',
                border: '1px solid rgba(122, 165, 214, 0.35)',
                color: '#7AC4D6',
                padding: '7px 14px',
                borderRadius: '4px',
                fontFamily: mono,
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.5px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
              }}
            >
              <BookOpen size={14} />
              MANUAL TÉCNICO & GUÍA FOH
            </button>
          </div>
        </div>

        {/* NOTICE FROM AUTH FLOW (OAuth return, expired session, unsynced changes) */}
        {authNotice && (
          <div
            role="status"
            data-testid="auth-notice"
            style={{
              background: 'rgba(217, 162, 78, 0.12)',
              border: '1px solid #D9A24E',
              borderRadius: '4px',
              padding: '10px 14px',
              color: '#E3C07A',
              fontSize: '12px',
              fontFamily: mono,
              display: 'flex',
              justifyContent: 'space-between',
              gap: '10px',
            }}
          >
            <span>[AVISO // AUTH]: {authNotice}</span>
            <button type="button" onClick={dismissAuthNotice} style={{ ...linkButtonStyle, color: '#E3C07A' }}>
              CERRAR
            </button>
          </div>
        )}

        {/* ERROR NOTIFICATION */}
        {authError && (
          <div
            role="alert"
            data-testid="auth-error"
            style={{
              background: 'rgba(217, 100, 89, 0.15)',
              border: '1px solid #D96459',
              borderRadius: '4px',
              padding: '10px 14px',
              color: '#E8A49B',
              fontSize: '12px',
              fontFamily: mono,
            }}
          >
            [ERROR // AUTH]: {authError}
          </div>
        )}

        {/* 1. CLOUD ACCOUNT: GOOGLE VIA SUPABASE AUTH */}
        <section style={{ ...sectionStyle, border: '1px solid rgba(184, 207, 122, 0.45)' }} aria-label="Cuenta de nube">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <div style={sectionTitleStyle}>
              <Cloud size={14} style={{ color: '#B8CF7A' }} />
              <span>CUENTA DE NUBE // GOOGLE VIA SUPABASE</span>
            </div>
            <button
              type="button"
              onClick={() => setShowCloudModal(true)}
              style={{ ...linkButtonStyle, color: '#7AA5D6', fontFamily: mono, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <Settings size={12} />
              <span>{cloud.configured ? 'Ver configuración' : 'Configurar Supabase'}</span>
            </button>
          </div>
          <p style={helpStyle}>
            La única opción que sincroniza tu workspace entre dispositivos. Supabase verifica tu identidad de Google y la
            base de datos solo te deja leer y escribir tu propia fila.
          </p>
          <button
            type="button"
            data-testid="cloud-login"
            onClick={handleCloudLogin}
            disabled={cloudDisabledReason !== null || cloudBusy}
            title={cloudDisabledReason ?? 'Continuar con Google (nube)'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              background: cloudDisabledReason ? '#232830' : '#D5DAE0',
              color: cloudDisabledReason ? '#7C8591' : '#15181C',
              border: '1px solid #2E343D',
              borderRadius: '4px',
              padding: '11px 18px',
              fontSize: '13px',
              fontWeight: 700,
              fontFamily: mono,
              cursor: cloudDisabledReason || cloudBusy ? 'not-allowed' : 'pointer',
              opacity: cloudBusy ? 0.7 : 1,
            }}
          >
            <GoogleIcon size={16} />
            <span>{cloudBusy ? 'REDIRIGIENDO A GOOGLE...' : 'CONTINUAR CON GOOGLE (NUBE)'}</span>
          </button>
          {cloudDisabledReason && (
            <div style={disabledExplainStyle} data-testid="cloud-disabled-reason">
              <span style={{ color: '#D96459', fontWeight: 700 }}>Nube no disponible: </span>
              {cloudDisabledReason}{' '}
              <button type="button" onClick={() => setShowCloudModal(true)} style={linkButtonStyle}>
                Configurar Supabase
              </button>
            </div>
          )}
          {/* Served under /hub/ in production, so ../privacidad/ is the landing's /privacidad/. */}
          <p style={{ margin: '10px 0 0', fontSize: '11px', color: '#8E97A3', fontFamily: mono }} data-testid="privacy-note">
            Al continuar con Google aceptas la{' '}
            <a href="../privacidad/" style={{ color: '#7AC4D6' }}>
              política de privacidad
            </a>
            .
          </p>
        </section>

        {/* 2. GOOGLE IDENTITY SERVICES: LOCAL PROFILE ONLY */}
        <section style={sectionStyle} aria-label="Google perfil local">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <div style={sectionTitleStyle}>
              <GoogleIcon size={14} />
              <span>GOOGLE // PERFIL LOCAL (SIN NUBE)</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setClientIdError(null)
                setShowClientIdModal(true)
              }}
              style={{ ...linkButtonStyle, color: '#7AA5D6', fontFamily: mono, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
              title="Configurar Google Client ID"
            >
              <Settings size={12} />
              <span>{googleClientId ? 'Client ID activo' : 'Configurar Client ID'}</span>
            </button>
          </div>
          <p style={helpStyle}>
            Usa tu nombre y foto de Google para un perfil de este navegador. El token de Google no se verifica en ningún
            servidor, así que este perfil no abre la sincronización en la nube.
          </p>
          {googleClientId ? (
            <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
              <div ref={googleBtnRef} style={{ minHeight: '44px' }}>
                {gisState !== 'ready' && (
                  <div style={{ fontSize: '12px', color: '#8E97A3' }}>
                    {gisState === 'error' ? 'No se pudo cargar Google Identity Services.' : 'Cargando servicio de Google...'}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                data-testid="gis-login-disabled"
                disabled
                title="No hay Google Client ID configurado"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  background: '#232830',
                  color: '#7C8591',
                  border: '1px solid #2E343D',
                  borderRadius: '4px',
                  padding: '11px 18px',
                  fontSize: '13px',
                  fontWeight: 700,
                  fontFamily: mono,
                  cursor: 'not-allowed',
                }}
              >
                <GoogleIcon size={16} />
                <span>CONTINUAR CON GOOGLE (PERFIL LOCAL)</span>
              </button>
              <div style={disabledExplainStyle}>
                <span style={{ color: '#7AA5D6', fontWeight: 700 }}>Deshabilitado: </span>
                no hay un Google Client ID configurado (VITE_GOOGLE_CLIENT_ID).{' '}
                <button
                  type="button"
                  onClick={() => {
                    setClientIdError(null)
                    setShowClientIdModal(true)
                  }}
                  style={linkButtonStyle}
                >
                  Agregar un Client ID
                </button>{' '}
                o usa la cuenta de nube.
              </div>
            </>
          )}
        </section>

        {/* 3. LOCAL PROFILE (NAME + EMAIL LABEL) */}
        <form onSubmit={handleLocalSubmit} style={{ ...sectionStyle, background: '#1B1F24' }} aria-label="Perfil local">
          <div style={sectionTitleStyle}>
            <HardDrive size={14} style={{ color: '#D9A24E' }} />
            <span>PERFIL LOCAL // SOLO ESTE NAVEGADOR</span>
          </div>
          <p style={helpStyle}>
            Sin verificación de identidad y sin acceso a la nube. El correo es solo una etiqueta para separar perfiles en
            este navegador; tus datos no salen de aquí (exporta el JSON para respaldarlos).
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label htmlFor="local-name" style={{ fontSize: '11px', color: '#8E97A3', fontFamily: mono }}>
              NOMBRE O ALIAS DE MÚSICO
            </label>
            <input
              id="local-name"
              type="text"
              value={personalName}
              onChange={(e) => setPersonalName(e.target.value)}
              placeholder="Ej: Daniel Castro"
              required
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label htmlFor="local-email" style={{ fontSize: '11px', color: '#8E97A3', fontFamily: mono }}>
              CORREO (ETIQUETA, NO SE VERIFICA)
            </label>
            <input
              id="local-email"
              type="email"
              value={personalEmail}
              onChange={(e) => setPersonalEmail(e.target.value)}
              placeholder="tu.correo@ejemplo.com"
              required
              style={inputStyle}
            />
          </div>

          <button
            type="submit"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              background: '#7AA5D6',
              color: '#15181C',
              border: 'none',
              borderRadius: '4px',
              padding: '12px 18px',
              fontSize: '13px',
              fontWeight: 700,
              fontFamily: mono,
              cursor: 'pointer',
              marginTop: '4px',
            }}
          >
            <span>ENTRAR CON PERFIL LOCAL</span>
            <ArrowRight size={14} />
          </button>
        </form>

        {/* 4. DEMO MODE (EXPLICIT) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            type="button"
            data-testid="demo-toggle"
            onClick={() => setShowDemo((v) => !v)}
            aria-expanded={showDemo}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              background: 'transparent',
              border: '1px dashed #5CC8C2',
              borderRadius: '4px',
              padding: '9px 14px',
              color: '#5CC8C2',
              fontFamily: mono,
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '1px',
              cursor: 'pointer',
            }}
          >
            <FlaskConical size={14} />
            <span>{showDemo ? 'OCULTAR MODO DEMO' : 'MODO DEMO // DATOS FICTICIOS'}</span>
          </button>

          {showDemo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }} data-testid="demo-profiles">
              <p style={{ ...helpStyle, textAlign: 'center' }}>
                Perfiles inventados para explorar el Hub. Los datos son ficticios, viven solo en este navegador y nunca se
                suben a la nube.
              </p>
              {DEMO_PROFILES.map((prof) => (
                <button
                  key={prof.id}
                  type="button"
                  onClick={() => loginWithDemoProfile(prof)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: '#20252B',
                    border: '1px solid #2B313A',
                    borderRadius: '6px',
                    padding: '10px 14px',
                    color: '#D5DAE0',
                    cursor: 'pointer',
                    textAlign: 'left',
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
                      <div style={{ fontSize: '11px', color: '#8E97A3', fontFamily: mono }}>{prof.email}</div>
                    </div>
                  </div>
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: '10px',
                      color: '#5CC8C2',
                      border: '1px solid #5CC8C2',
                      padding: '2px 6px',
                      borderRadius: '3px',
                    }}
                  >
                    {prof.id === 'usr_director_01' ? 'DEMO OWNER' : prof.id === 'usr_foh_02' ? 'DEMO FOH' : 'DEMO BATERISTA'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* TECHNICAL PILLARS FOOTER */}
        <div
          style={{
            borderTop: '1px solid #2E343D',
            paddingTop: '16px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8E97A3' }}>
            <ListMusic size={15} style={{ color: '#5CC8C2' }} />
            <span>Setlists & Transición</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8E97A3' }}>
            <Sliders size={15} style={{ color: '#7AA5D6' }} />
            <span>Stems & Limitador dBFS</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8E97A3' }}>
            <Users size={15} style={{ color: '#B8CF7A' }} />
            <span>Múltiples Bandas & Roles</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#8E97A3' }}>
            <Radio size={15} style={{ color: '#D9A24E' }} />
            <span>Racks ASIO & In-Ear RF</span>
          </div>
        </div>
      </div>

      {/* GOOGLE CLIENT ID CONFIG MODAL */}
      {showClientIdModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
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
              padding: '24px',
              width: '100%',
              maxWidth: '480px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Key size={18} style={{ color: '#7AA5D6' }} />
              <h3 style={{ margin: 0, fontSize: '16px', fontFamily: mono }}>GOOGLE CLIENT ID (PERFIL LOCAL)</h3>
            </div>

            <p style={{ margin: 0, fontSize: '12px', color: '#8E97A3', lineHeight: 1.5 }}>
              OAuth 2.0 Client ID (tipo Aplicación web) de Google Cloud Console, con este dominio en "Orígenes de
              JavaScript autorizados". Se guarda solo en este navegador y tiene prioridad sobre VITE_GOOGLE_CLIENT_ID.
              Recuerda: este botón crea un perfil local; la nube usa el login de Supabase.
            </p>

            {clientIdError && (
              <div role="alert" style={{ fontSize: '12px', color: '#E8A49B', fontFamily: mono }}>
                [ERROR]: {clientIdError}
              </div>
            )}

            <form onSubmit={handleSaveClientId} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label htmlFor="gis-client-id" style={{ fontSize: '11px', color: '#8E97A3', fontFamily: mono }}>
                  CLIENT ID (VACÍO PARA QUITAR EL OVERRIDE)
                </label>
                <input
                  id="gis-client-id"
                  type="text"
                  value={clientIdInput}
                  onChange={(e) => setClientIdInput(e.target.value)}
                  placeholder="termina en .apps.googleusercontent.com"
                  style={{ ...inputStyle, width: '100%', fontSize: '12px', fontFamily: mono, marginTop: '4px', padding: '8px 10px' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowClientIdModal(false)}
                  style={{
                    background: '#232830',
                    border: '1px solid #2E343D',
                    borderRadius: '4px',
                    padding: '8px 14px',
                    color: '#8E97A3',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontFamily: mono,
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: '#7AA5D6',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '8px 16px',
                    color: '#15181C',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 700,
                    fontFamily: mono,
                  }}
                >
                  GUARDAR
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCloudModal && <SupabaseConfigModal onClose={() => setShowCloudModal(false)} />}

      {showManualModal && <UserManualModal onClose={() => setShowManualModal(false)} />}
    </div>
  )
}
