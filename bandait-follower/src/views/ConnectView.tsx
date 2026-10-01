import { useState, useEffect, useMemo, useCallback } from 'react'
import QrScanner from '../components/QrScanner'
import { QrConnectionData } from '../services/qrDiscovery'
import { detectLeaderInfo } from '../services/leaderInfo'
import { currentPageContext, decideConnection, qrEntryMode } from '../services/connectionGuard'
import { LeaderInfo } from '../types/protocol'
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
  isCloudAuthConfigured,
} from '../services/musicianAuth'

export interface ConnectRequest {
  ip: string
  port: string
  sessionId: string
  /**
   * The exact profile this join uses (role and alias). Passed explicitly so a
   * join never reads a profile that React state or storage has not caught up
   * with yet (e.g. ?role=director&auto=1 from the stage QR).
   */
  profile: MusicianProfile
}

interface Props {
  onConnect: (req: ConnectRequest) => void
  /** Creates/resumes the AudioContext; must be called inside a user gesture. */
  onArmAudio: () => void
  onSettings?: () => void
  onLibrary?: () => void
  onManual?: () => void
}

interface UrlOverrides {
  ip: string | null
  port: string | null
  session: string | null
}

/**
 * URL parameters (?session=&ip=&port=&role=&alias=&auto=1) are consumed once
 * per page load. Without this, coming back to this view after SALIR re-read
 * ?auto=1 and rejoined immediately. They always override /leader-info.json.
 */
let urlParamsConsumed = false
let urlOverrides: UrlOverrides = { ip: null, port: null, session: null }
/** auto=1 whose ip/port/session must come from /leader-info.json (consumed once). */
let pendingAutoJoin: { profile: MusicianProfile; stored: UrlOverrides } | null = null

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage blocked: values still apply for this join.
  }
}

function validate(ip: string, port: string, sessionId: string): string | null {
  if (!ip.trim()) return 'FALTA LA IP DEL LIDER'
  if (/\s|\/|:/.test(ip.trim())) return 'IP INVALIDA: ESCRIBE SOLO LA DIRECCION (EJ. 192.168.1.100)'
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'PUERTO INVALIDO (1-65535)'
  if (!sessionId.trim()) return 'FALTA EL ID DE SESION'
  return null
}

const IP_PRESETS = [
  { label: 'AUTO (192.168.1.100)', ip: '192.168.1.100' },
  { label: 'DIRECTOR (192.168.0.50)', ip: '192.168.0.50' },
  { label: 'LOCALHOST', ip: '127.0.0.1' },
]

export default function ConnectView({ onConnect, onArmAudio, onSettings, onLibrary, onManual }: Props) {
  const [ip, setIp] = useState(readStorage('bandait_last_ip') || '192.168.1.100')
  const [port, setPort] = useState(readStorage('bandait_last_port') || '4040')
  const [sessionId, setSessionId] = useState(readStorage('bandait_last_session') || 'default')
  const [showScanner, setShowScanner] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [profile, setProfile] = useState<MusicianProfile>(getMusicianProfile())
  const [cloudUser, setCloudUser] = useState<{ email: string } | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  /** Set when this page was served by the leader (GET ./leader-info.json answered v3 JSON). */
  const [served, setServed] = useState<LeaderInfo | null>(null)
  /** Set when the HTTPS guard refused a direct socket: top-level link to the leader-served follower. */
  const [guardUrl, setGuardUrl] = useState<string | null>(null)
  const cloudConfigured = isCloudAuthConfigured()
  const page = useMemo(() => currentPageContext(), [])
  const qrMode = qrEntryMode(page)

  /**
   * The single path to a join (form, one-tap, QR, auto=1). From HTTPS a LAN
   * target is never dialed: the guard offers "ABRIR DESDE EL LIDER" instead.
   */
  const attemptJoin = useCallback(
    (target: { ip: string; port: string; sessionId: string }, joinProfile: MusicianProfile): boolean => {
      let keep: URLSearchParams | undefined
      try {
        keep = new URLSearchParams(window.location.search)
      } catch {
        keep = undefined
      }
      const decision = decideConnection(page, target, { role: joinProfile.role, alias: joinProfile.alias, keep })
      if (decision.kind === 'open_from_leader') {
        setGuardUrl(decision.url)
        return false
      }
      setGuardUrl(null)
      onConnect({ ...target, profile: joinProfile })
      return true
    },
    [onConnect, page],
  )

  // 1. URL parameters (stage QR: ?ip=&port=&session=&role=&alias=&auto=1), once per load.
  useEffect(() => {
    if (urlParamsConsumed) return
    urlParamsConsumed = true
    try {
      const params = new URLSearchParams(window.location.search)
      const qSession = params.get('session') || params.get('s')
      const qIp = params.get('ip')
      const qPort = params.get('port')
      const qRole = params.get('role')
      const qAlias = params.get('alias')
      const qAuto = params.get('auto') || params.get('autoconnect')
      urlOverrides = { ip: qIp, port: qPort, session: qSession }

      const stored: UrlOverrides = {
        ip: readStorage('bandait_last_ip'),
        port: readStorage('bandait_last_port'),
        session: readStorage('bandait_last_session'),
      }
      let effectiveProfile = getMusicianProfile()

      if (qIp) {
        setIp(qIp)
        writeStorage('bandait_last_ip', qIp)
      }
      if (qPort) {
        setPort(qPort)
        writeStorage('bandait_last_port', qPort)
      }
      if (qSession) {
        setSessionId(qSession)
        writeStorage('bandait_last_session', qSession)
      }
      if (qRole || (qAlias && qAlias.trim())) {
        // Synchronous: build, persist and set the profile BEFORE any join below
        // (saving inside a setState updater ran too late and joined as musician).
        effectiveProfile = {
          ...effectiveProfile,
          ...(qRole ? { role: qRole } : {}),
          ...(qAlias && qAlias.trim() ? { alias: qAlias.trim().slice(0, 40) } : {}),
        }
        saveMusicianProfile(effectiveProfile)
        setProfile(effectiveProfile)
      }

      const wantsAuto = qAuto === '1' || qAuto === 'true'
      if (wantsAuto) {
        // Strip the auto flag so a reload or SALIR never rejoins by itself.
        params.delete('auto')
        params.delete('autoconnect')
        const query = params.toString()
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)

        const target = { ip: qIp ?? '', port: qPort ?? stored.port ?? '4040', sessionId: qSession ?? '' }
        if (qIp && qSession && !validate(target.ip, target.port, target.sessionId)) {
          // Complete link (the leader's QR): join now. No gesture: Stage shows ACTIVAR AUDIO.
          attemptJoin(target, effectiveProfile)
        } else {
          // Missing ip/port/session: wait for /leader-info.json (bounded, ~1.5 s).
          pendingAutoJoin = { profile: effectiveProfile, stored }
        }
      }
    } catch {
      // Graceful fallback for non-browser/restricted URL parsing
    }
  }, [attemptJoin])

  // 2. Served by the leader? (contract section 8). URL parameters still win.
  useEffect(() => {
    let cancelled = false
    detectLeaderInfo()
      .then((outcome) => {
        if (cancelled) return
        const pending = pendingAutoJoin
        pendingAutoJoin = null
        if (outcome.kind === 'served') {
          const info = outcome.info
          setServed(info)
          const merged = {
            ip: urlOverrides.ip ?? info.ip,
            port: urlOverrides.port ?? String(info.port),
            sessionId: urlOverrides.session ?? info.sessionId,
          }
          setIp(merged.ip)
          setPort(merged.port)
          setSessionId(merged.sessionId)
          if (pending && !validate(merged.ip, merged.port, merged.sessionId)) attemptJoin(merged, pending.profile)
          return
        }
        // Not served by a leader: an incomplete auto=1 link keeps the old behaviour
        // (needs at least ?session=, the rest from the last successful values).
        if (pending && urlOverrides.session) {
          const fallback = {
            ip: urlOverrides.ip ?? pending.stored.ip ?? '',
            port: urlOverrides.port ?? pending.stored.port ?? '4040',
            sessionId: urlOverrides.session,
          }
          if (!validate(fallback.ip, fallback.port, fallback.sessionId)) attemptJoin(fallback, pending.profile)
        }
      })
      .catch(() => {
        // detectLeaderInfo never rejects; nothing to do.
      })
    return () => {
      cancelled = true
    }
  }, [attemptJoin])

  // 3. Check Supabase auth session if configured (SDK is loaded lazily)
  useEffect(() => {
    if (!isCloudAuthConfigured()) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    getSupabaseFollowerClient()
      .then((client) => {
        if (!client || cancelled) return
        client.auth
          .getSession()
          .then(({ data }) => {
            if (!cancelled && data.session?.user?.email) {
              setCloudUser({ email: data.session.user.email })
            }
          })
          .catch(() => {
            // Offline fallback
          })
        const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
          if (cancelled) return
          if (session?.user?.email) {
            setCloudUser({ email: session.user.email })
          } else {
            setCloudUser(null)
          }
        })
        unsubscribe = () => listener.subscription.unsubscribe()
      })
      .catch(() => {
        // Cloud unavailable: the local profile keeps working.
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const join = (nextIp: string, nextPort: string, nextSession: string, joinProfile: MusicianProfile = profile) => {
    const cleanIp = nextIp.trim()
    const cleanPort = nextPort.trim()
    const cleanSession = nextSession.trim()
    const error = validate(cleanIp, cleanPort, cleanSession)
    setFormError(error)
    if (error) return
    writeStorage('bandait_last_ip', cleanIp)
    writeStorage('bandait_last_port', cleanPort)
    writeStorage('bandait_last_session', cleanSession)
    attemptJoin({ ip: cleanIp, port: cleanPort, sessionId: cleanSession }, joinProfile)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onArmAudio() // inside the submit gesture: unlocks iOS audio
    join(ip, port, sessionId)
  }

  /** Served by the leader: one tap with the prefilled values (URL overrides included). */
  const handleServedJoin = () => {
    onArmAudio()
    join(ip, port, sessionId)
  }

  const handleOpenFromLeader = () => {
    if (!guardUrl) return
    try {
      window.location.assign(guardUrl) // top-level navigation: allowed from HTTPS
    } catch {
      // The link is also shown as text below.
    }
  }

  const handleOpenScanner = () => {
    onArmAudio() // the scan button press is the user gesture
    setFormError(null)
    setShowScanner(true)
  }

  const handleAliasChange = (alias: string) => {
    const updated = { ...profile, alias }
    setProfile(updated)
    saveMusicianProfile(updated)
  }

  const handleRoleChange = (role: string): MusicianProfile => {
    const updated = { ...profile, role }
    setProfile(updated)
    saveMusicianProfile(updated)
    return updated
  }

  const handleQrResult = (data: QrConnectionData) => {
    setShowScanner(false)
    const nextIp = data.ip
    const nextPort = String(data.port)
    setIp(nextIp)
    setPort(nextPort)
    setSessionId(data.sessionId)
    // Join with the profile just built: `profile` in this closure is still the old one.
    const joinProfile = data.role ? handleRoleChange(data.role) : profile
    join(nextIp, nextPort, data.sessionId, joinProfile)
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

        {guardUrl && (
          <div className="https-guard" role="alert">
            <strong>CONEXION BLOQUEADA POR EL NAVEGADOR</strong>
            <p>
              Esta pagina se abrio por HTTPS (internet) y el navegador no permite conectarse por ws:// a un
              lider en la red local (contenido mixto). Abre el follower servido por el propio lider: se
              conservan sesion, rol y alias.
            </p>
            <button type="button" className="btn-stage btn-stage-primary" onClick={handleOpenFromLeader}>
              <WifiIcon size={16} />
              <span>ABRIR DESDE EL LIDER</span>
            </button>
            <code className="https-guard-url">{guardUrl}</code>
          </div>
        )}

        {served && (
          <div className="served-banner" role="status">
            <div className="served-banner-title">
              SERVIDO POR EL LIDER {served.ip}:{served.port}
            </div>
            <div className="served-banner-meta">SESION: {sessionId}</div>
            <button type="button" className="btn-stage btn-stage-primary" onClick={handleServedJoin}>
              <WifiIcon size={16} />
              <span>UNIRSE CON UN TOQUE</span>
            </button>
          </div>
        )}

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
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)', gap: '10px' }}>
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

          {formError && (
            <div role="alert" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-danger)' }}>
              {formError}
            </div>
          )}

          {/* SUBMIT BUTTON */}
          <button type="submit" className="btn-stage btn-stage-primary" style={{ marginTop: '4px' }}>
            <WifiIcon size={18} />
            <span>ESTABLECER ENLACE STAGE</span>
          </button>
        </form>

        <div className="connect-divider">O ACCESO POR CREDENCIAL QR</div>

        {qrMode === 'native_camera' ? (
          <div className="qr-native-note" role="note">
            <QrIcon size={18} />
            <span>Escanea el QR del lider con la camara del telefono</span>
          </div>
        ) : showScanner ? (
          <QrScanner onResult={handleQrResult} onCancel={() => setShowScanner(false)} />
        ) : (
          <button type="button" onClick={handleOpenScanner} className="btn-stage btn-stage-secondary">
            <QrIcon size={18} />
            <span>ESCANEAR CÓDIGO QR</span>
          </button>
        )}

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
              {cloudUser ? 'NUBE ACTIVA' : cloudConfigured ? 'PERFIL LOCAL' : 'PERFIL LOCAL (NUBE NO CONFIGURADA)'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: '8px', marginBottom: '10px' }}>
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
          ) : cloudConfigured ? (
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
          ) : null}
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
