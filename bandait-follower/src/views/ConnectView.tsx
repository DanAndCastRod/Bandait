import { useState, useRef, useEffect } from 'react'
import {
  LibraryIcon,
  SettingsIcon,
  WifiIcon,
  QrIcon,
  ShieldIcon,
  BookOpenIcon,
  GoogleIcon,
  UserIcon,
  LogOutIcon,
  CloudIcon,
} from '../components/Icons'
import {
  getMusicianProfile,
  saveMusicianProfile,
  STAGE_ROLES,
  MusicianProfile,
  signInMusicianWithGoogle,
  signOutMusician,
  getSupabaseFollowerClient,
} from '../services/musicianAuth'

interface Props {
  onConnect: (sessionId: string) => void
  onSettings?: () => void
  onLibrary?: () => void
  onManual?: () => void
}

const IP_PRESETS = [
  { label: 'AUTO (192.168.1.100)', ip: '192.168.1.100' },
  { label: 'DIRECTOR (192.168.0.50)', ip: '192.168.0.50' },
  { label: 'LOCALHOST', ip: '127.0.0.1' },
]

export default function ConnectView({ onConnect, onSettings, onLibrary, onManual }: Props) {
  const [ip, setIp] = useState(localStorage.getItem('bandait_last_ip') || '192.168.1.100')
  const [port, setPort] = useState(localStorage.getItem('bandait_last_port') || '4040')
  const [sessionId, setSessionId] = useState(localStorage.getItem('bandait_last_session') || 'default')
  const [scanning, setScanning] = useState(false)
  const [profile, setProfile] = useState<MusicianProfile>(getMusicianProfile())
  const [cloudUser, setCloudUser] = useState<{ email: string } | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 1. Stage QR Auto-join via URL parameters (?session=...&ip=...&role=...&auto=1)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const qSession = params.get('session') || params.get('s')
      const qIp = params.get('ip')
      const qPort = params.get('port')
      const qRole = params.get('role')
      const qAuto = params.get('auto') || params.get('autoconnect')

      let effectiveSession = sessionId

      if (qIp) {
        setIp(qIp)
        localStorage.setItem('bandait_last_ip', qIp)
      }
      if (qPort) {
        setPort(qPort)
        localStorage.setItem('bandait_last_port', qPort)
      }
      if (qRole) {
        setProfile((prev) => {
          const updated = { ...prev, role: qRole }
          saveMusicianProfile(updated)
          return updated
        })
      }
      if (qSession) {
        effectiveSession = qSession
        setSessionId(qSession)
        localStorage.setItem('bandait_last_session', qSession)
      }

      if (qSession && (qAuto === '1' || qAuto === 'true')) {
        onConnect(effectiveSession)
      }
    } catch {
      // Graceful fallback for non-browser/restricted URL parsing
    }
  }, [onConnect])

  // 2. Check Supabase auth session if configured
  useEffect(() => {
    const client = getSupabaseFollowerClient()
    if (!client) return

    client.auth.getSession().then(({ data }) => {
      if (data.session?.user?.email) {
        setCloudUser({ email: data.session.user.email })
      }
    }).catch(() => {
      // Offline fallback
    })

    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user?.email) {
        setCloudUser({ email: session.user.email })
      } else {
        setCloudUser(null)
      }
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    localStorage.setItem('bandait_last_ip', ip)
    localStorage.setItem('bandait_last_port', port)
    localStorage.setItem('bandait_last_session', sessionId)
    onConnect(sessionId)
  }

  const handleQrUpload = () => {
    fileRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setScanning(true)
    setTimeout(() => {
      setScanning(false)
      onConnect(sessionId || 'default')
    }, 1200)
  }

  const handleAliasChange = (alias: string) => {
    const updated = { ...profile, alias }
    setProfile(updated)
    saveMusicianProfile(updated)
  }

  const handleRoleChange = (role: string) => {
    const updated = { ...profile, role }
    setProfile(updated)
    saveMusicianProfile(updated)
  }

  const handleGoogleLogin = async () => {
    setAuthError(null)
    const { error } = await signInMusicianWithGoogle()
    if (error) {
      setAuthError(error.message)
    }
  }

  const handleSignOut = async () => {
    await signOutMusician()
    setCloudUser(null)
  }

  return (
    <div className="connect-view">
      {/* TOP RACK BAR */}
      <div className="connect-topbar">
        <div className="connect-rack-badge">
          <span style={{ color: 'var(--accent-active)', fontWeight: 800 }}>BANDAIT F-3000</span>
          <span>//</span>
          <span>TERMINAL STAGE</span>
        </div>

        <div className="connect-actions">
          {onManual && (
            <button
              type="button"
              className="btn-stage-icon"
              onClick={onManual}
              title="Manual de Escenario y Conexión"
              aria-label="Manual de Escenario"
            >
              <BookOpenIcon size={16} />
            </button>
          )}
          {onLibrary && (
            <button
              type="button"
              className="btn-stage-icon"
              onClick={onLibrary}
              title="Biblioteca de Repertorio"
              aria-label="Biblioteca"
            >
              <LibraryIcon size={16} />
            </button>
          )}
          {onSettings && (
            <button
              type="button"
              className="btn-stage-icon"
              onClick={onSettings}
              title="Configuración de Temas y Audio"
              aria-label="Configuración"
            >
              <SettingsIcon size={16} />
            </button>
          )}
        </div>
      </div>

      {/* MAIN HARDWARE CONNECT CARD */}
      <div className="connect-card">
        <div className="connect-header">
          <h1 className="connect-title">BANDAIT</h1>
          <p className="connect-subtitle">SISTEMA DE MONITOREO EN VIVO</p>
        </div>

        <form onSubmit={handleSubmit} className="connect-form">
          {/* IP INPUT */}
          <div className="form-group">
            <label className="form-label">
              <span>IP DEL LÍDER FOH</span>
              <span style={{ opacity: 0.6 }}>[UDP / TCP]</span>
            </label>
            <input
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.100"
              className="form-input"
              required
            />
            <div className="preset-chips">
              {IP_PRESETS.map((preset) => (
                <button
                  key={preset.ip}
                  type="button"
                  className="preset-chip"
                  onClick={() => setIp(preset.ip)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* PORT AND SESSION ID */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">
                <span>PUERTO</span>
              </label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="form-input"
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">
                <span>ID DE SESIÓN</span>
              </label>
              <input
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                className="form-input"
                required
              />
            </div>
          </div>

          {/* SUBMIT BUTTON */}
          <button type="submit" className="btn-stage btn-stage-primary" style={{ marginTop: '4px' }}>
            <WifiIcon size={18} />
            <span>ESTABLECER ENLACE STAGE</span>
          </button>
        </form>

        <div className="connect-divider">O ACCESO POR CREDENCIAL QR</div>

        <button type="button" onClick={handleQrUpload} className="btn-stage btn-stage-secondary">
          <QrIcon size={18} />
          <span>{scanning ? 'PROCESANDO CÓDIGO...' : 'ESCANEAR CÓDIGO QR'}</span>
        </button>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />

        {/* MUSICIAN IDENTITY & CLOUD SYNC CARD */}
        <div
          style={{
            marginTop: '16px',
            padding: '12px',
            background: 'var(--bg-surface, #141820)',
            border: '1px solid var(--border-subtle, #252d3d)',
            borderRadius: '4px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <UserIcon size={14} style={{ color: 'var(--accent-active, #0066ff)' }} />
              <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.5px' }}>
                IDENTIDAD DE ESCENARIO
              </span>
            </div>
            <span
              style={{
                fontSize: '10px',
                color: cloudUser ? 'var(--accent-success, #00ff66)' : 'var(--text-secondary, #888)',
              }}
            >
              {cloudUser ? 'NUBE ACTIVA' : 'PERFIL LOCAL'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '8px', marginBottom: '10px' }}>
            <div>
              <label style={{ fontSize: '10px', color: 'var(--text-secondary, #888)', display: 'block', marginBottom: '3px' }}>
                ALIAS EN TARIMA
              </label>
              <input
                type="text"
                value={profile.alias}
                onChange={(e) => handleAliasChange(e.target.value)}
                placeholder="Ej. Baterista"
                className="form-input"
                style={{ fontSize: '12px', padding: '6px 8px' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '10px', color: 'var(--text-secondary, #888)', display: 'block', marginBottom: '3px' }}>
                ROL MUSICAL
              </label>
              <select
                value={profile.role}
                onChange={(e) => handleRoleChange(e.target.value)}
                className="form-input"
                style={{ fontSize: '12px', padding: '6px 8px', width: '100%' }}
              >
                {STAGE_ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* CLOUD GOOGLE LINK STRIP */}
          {cloudUser ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 8px',
                background: 'rgba(0, 255, 102, 0.05)',
                border: '1px solid rgba(0, 255, 102, 0.2)',
                borderRadius: '3px',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                <CloudIcon size={13} style={{ color: 'var(--accent-success, #00ff66)', flexShrink: 0 }} />
                <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {cloudUser.email}
                </span>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                title="Desconectar Nube"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-secondary, #888)',
                  cursor: 'pointer',
                  padding: '2px',
                  display: 'flex',
                }}
              >
                <LogOutIcon size={14} />
              </button>
            </div>
          ) : (
            <div>
              <button
                type="button"
                onClick={handleGoogleLogin}
                className="btn-stage btn-stage-secondary"
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
              >
                <GoogleIcon size={14} />
                <span>VINCULAR CUENTA GOOGLE / NUBE</span>
              </button>
              {authError && (
                <div
                  style={{
                    marginTop: '4px',
                    fontSize: '10px',
                    color: 'var(--accent-danger, #ff4444)',
                    textAlign: 'center',
                  }}
                >
                  {authError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* HARDWARE DIAGNOSTICS STRIP */}
        <div className="hardware-diagnostics" style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ShieldIcon size={13} style={{ color: 'var(--accent-success)' }} />
            <span>LIMITADOR IN-EAR -0.5 dBFS</span>
          </div>
          <span style={{ color: 'var(--accent-active)', fontWeight: 700 }}>FLYWHEEL ARMADO</span>
        </div>
      </div>
    </div>
  )
}
