import React, { useState } from 'react'
import { Cloud, CheckCircle2, AlertCircle, X, RefreshCw, Trash2, ShieldCheck, Download, RotateCcw, LogIn } from 'lucide-react'
import {
  checkAnonExposure,
  clearSupabaseOverride,
  getAuthRedirectUrl,
  saveSupabaseConfig,
  type HealthResult,
} from '../services/supabaseClient'
import { useHub } from '../context/hubContextCore'
import { PROVIDER_LABELS } from '../services/authService'

interface Props {
  onClose: () => void
}

const mono = "'IBM Plex Mono', monospace"

const labelStyle: React.CSSProperties = { fontSize: '11px', color: '#94a3b8', fontFamily: mono }

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#0d1017',
  border: '1px solid #2a3346',
  borderRadius: '4px',
  padding: '8px 10px',
  color: '#ffffff',
  marginTop: '4px',
  boxSizing: 'border-box',
  fontSize: '13px',
}

const smallButton: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #2a3346',
  color: '#94a3b8',
  padding: '7px 12px',
  borderRadius: '4px',
  fontSize: '11px',
  fontFamily: mono,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
}

const boxStyle: React.CSSProperties = {
  background: '#0d1017',
  border: '1px solid #2a3346',
  borderRadius: '4px',
  padding: '12px',
  fontSize: '11px',
  color: '#94a3b8',
  lineHeight: 1.5,
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

const SOURCE_LABEL = {
  build: 'variables de compilación (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)',
  override: 'override guardado en este navegador',
  none: 'sin configurar',
} as const

function banner(level: 'ok' | 'warn' | 'error', message: string, testId?: string) {
  const color = level === 'ok' ? '#10b981' : level === 'warn' ? '#f59e0b' : '#ef4444'
  return (
    <div
      role={level === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      style={{
        padding: '10px 12px',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        fontSize: '12px',
        fontFamily: mono,
        background: `${color}1f`,
        border: `1px solid ${color}`,
        color,
        lineHeight: 1.4,
      }}
    >
      {level === 'ok' ? <CheckCircle2 size={16} style={{ flexShrink: 0 }} /> : <AlertCircle size={16} style={{ flexShrink: 0 }} />}
      <span>{message}</span>
    </div>
  )
}

export const SupabaseConfigModal: React.FC<Props> = ({ onClose }) => {
  const { user, cloud, syncStatus, retrySync, signInWithCloudGoogle, backups, restoreBackup, downloadBackup } = useHub()
  const [url, setUrl] = useState(cloud.source === 'override' ? cloud.url : '')
  const [anonKey, setAnonKey] = useState('')
  const [formMessage, setFormMessage] = useState<{ level: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const [health, setHealth] = useState<HealthResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    const result = saveSupabaseConfig(url, anonKey)
    if (!result.ok) {
      setFormMessage({ level: 'error', text: result.reason })
      return
    }
    setFormMessage({ level: 'ok', text: 'Configuración guardada. Recargando el Hub para aplicarla...' })
    setTimeout(() => window.location.reload(), 600)
  }

  const handleClearOverride = () => {
    clearSupabaseOverride()
    setFormMessage({ level: 'ok', text: 'Override eliminado. Recargando el Hub...' })
    setTimeout(() => window.location.reload(), 600)
  }

  const handleSecurityCheck = async () => {
    setChecking(true)
    setHealth(await checkAnonExposure())
    setChecking(false)
  }

  const handleCloudLogin = async () => {
    setBusy(true)
    const error = await signInWithCloudGoogle()
    if (error) {
      setFormMessage({ level: 'error', text: error })
      setBusy(false)
    }
  }

  const handleRestore = (backupId: string) => {
    if (!window.confirm('Esto reemplaza el workspace actual por el respaldo y lo sube a la nube como versión nueva. ¿Continuar?')) {
      return
    }
    const error = restoreBackup(backupId)
    setFormMessage(error ? { level: 'error', text: error } : { level: 'ok', text: 'Respaldo restaurado. Se subirá a la nube.' })
  }

  const isCloudUser = user?.authProvider === 'supabase'
  const statusLevel: 'ok' | 'warn' | 'error' =
    syncStatus.state === 'synced' ? 'ok' : syncStatus.state === 'error' ? 'error' : 'warn'
  const statusText =
    syncStatus.state === 'synced'
      ? `Sincronizado. Última confirmación: ${new Date(syncStatus.at).toLocaleTimeString()}.`
      : syncStatus.detail

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.88)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
        boxSizing: 'border-box',
      }}
    >
      <div
        role="dialog"
        aria-label="Nube Supabase"
        style={{
          background: '#161b26',
          border: '1px solid #2a3346',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '560px',
          padding: '24px',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.9)',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          maxHeight: '90dvh',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        {/* HEADER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #2a3346', paddingBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Cloud size={20} style={{ color: '#0066ff' }} />
            <h3 style={{ margin: 0, fontFamily: mono, fontSize: '15px', color: '#ffffff' }}>NUBE // SUPABASE</h3>
          </div>
          <button onClick={onClose} aria-label="Cerrar" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px' }}>
            <X size={18} />
          </button>
        </div>

        {formMessage && banner(formMessage.level, formMessage.text, 'cloud-form-message')}

        {/* IDENTITY & SYNC STATUS */}
        {user && (
          <div style={boxStyle}>
            <strong style={{ color: '#ffffff', fontFamily: mono }}>IDENTIDAD Y ESTADO</strong>
            <div>
              Perfil: <span style={{ color: '#ffffff' }}>{user.email || user.name}</span> //{' '}
              <span style={{ color: isCloudUser ? '#10b981' : '#f59e0b', fontFamily: mono }}>{PROVIDER_LABELS[user.authProvider]}</span>
            </div>
            {banner(statusLevel, statusText, 'cloud-sync-detail')}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {isCloudUser && syncStatus.state === 'error' && (
                <button type="button" onClick={retrySync} style={smallButton}>
                  <RefreshCw size={12} />
                  <span>REINTENTAR AHORA</span>
                </button>
              )}
              {!isCloudUser && cloud.configured && (
                <button type="button" onClick={handleCloudLogin} disabled={busy} style={{ ...smallButton, color: '#10b981', borderColor: '#10b981' }}>
                  <LogIn size={12} />
                  <span>{cloud.sessionEmail ? `CAMBIAR A LA CUENTA DE NUBE (${cloud.sessionEmail})` : 'INICIAR SESIÓN CON GOOGLE (NUBE)'}</span>
                </button>
              )}
            </div>
            {!isCloudUser && cloud.configured && (
              <div>
                Al iniciar sesión en la nube se usa otro workspace (el de tu cuenta). Este perfil local queda intacto en este
                navegador; exporta su JSON si quieres conservarlo aparte.
              </div>
            )}
          </div>
        )}

        {/* CURRENT CONFIG */}
        <div style={boxStyle}>
          <strong style={{ color: '#ffffff', fontFamily: mono }}>CONFIGURACIÓN ACTUAL</strong>
          <div>
            Origen: <span style={{ color: '#ffffff' }}>{SOURCE_LABEL[cloud.source]}</span>
          </div>
          {cloud.url && (
            <div style={{ wordBreak: 'break-all' }}>
              URL: <span style={{ color: '#ffffff', fontFamily: mono }}>{cloud.url}</span>
            </div>
          )}
          <div style={{ wordBreak: 'break-all' }}>
            URL de retorno del login (agrégala en Supabase, Authentication, URL Configuration):{' '}
            <span style={{ color: '#ffffff', fontFamily: mono }}>{getAuthRedirectUrl()}</span>
          </div>
          {cloud.configError && banner('error', cloud.configError, 'cloud-config-error')}
          {cloud.configured && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button type="button" onClick={handleSecurityCheck} disabled={checking} style={smallButton}>
                <ShieldCheck size={12} />
                <span>{checking ? 'COMPROBANDO...' : 'COMPROBAR SEGURIDAD DE LA TABLA (SIN SESIÓN)'}</span>
              </button>
              {health && banner(health.level, health.message, 'cloud-health')}
            </div>
          )}
        </div>

        {/* OVERRIDE FORM */}
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <strong style={{ color: '#ffffff', fontFamily: mono, fontSize: '11px' }}>OVERRIDE EN ESTE NAVEGADOR (OPCIONAL)</strong>
          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', lineHeight: 1.5 }}>
            Solo la <strong style={{ color: '#ffffff' }}>anon key</strong> o la <strong style={{ color: '#ffffff' }}>publishable key</strong>.
            Las claves service_role y sb_secret_ se rechazan: ignoran RLS y darían acceso a todos los workspaces.
          </p>
          <div>
            <label htmlFor="sb-url" style={labelStyle}>
              SUPABASE PROJECT URL
            </label>
            <input
              id="sb-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://<proyecto>.supabase.co"
              required
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="sb-key" style={labelStyle}>
              SUPABASE ANON / PUBLISHABLE KEY
            </label>
            <input
              id="sb-key"
              type="password"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder="eyJ... o sb_publishable_..."
              required
              autoComplete="off"
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
            {cloud.source === 'override' ? (
              <button type="button" onClick={handleClearOverride} style={{ ...smallButton, borderColor: '#ef4444', color: '#ef4444' }}>
                <Trash2 size={12} />
                <span>QUITAR OVERRIDE</span>
              </button>
            ) : (
              <span />
            )}
            <button
              type="submit"
              style={{
                background: '#0066ff',
                border: 'none',
                color: '#ffffff',
                padding: '7px 16px',
                borderRadius: '4px',
                fontFamily: mono,
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              GUARDAR Y RECARGAR
            </button>
          </div>
        </form>

        {/* LOCAL BACKUPS FROM CONFLICTS */}
        {isCloudUser && (
          <div style={boxStyle} data-testid="cloud-backups">
            <strong style={{ color: '#ffffff', fontFamily: mono }}>RESPALDOS LOCALES DE CONFLICTOS ({backups.length}/3)</strong>
            {backups.length === 0 && <div>No hay respaldos. Se crean cuando un conflicto descarta cambios de un lado.</div>}
            {backups.map((b) => (
              <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: mono }}>
                  {new Date(b.savedAt).toLocaleString()} // copia {b.side === 'local' ? 'de este navegador' : 'de la nube'}
                </span>
                <span style={{ display: 'flex', gap: '6px' }}>
                  <button type="button" onClick={() => downloadBackup(b.id)} style={smallButton}>
                    <Download size={12} />
                    <span>DESCARGAR</span>
                  </button>
                  <button type="button" onClick={() => handleRestore(b.id)} style={smallButton}>
                    <RotateCcw size={12} />
                    <span>RESTAURAR</span>
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <div style={{ ...boxStyle, color: '#94a3b8' }}>
          <strong style={{ color: '#ffffff', fontFamily: mono }}>BASE DE DATOS</strong>
          <div>
            Tabla <span style={{ fontFamily: mono, color: '#10b981' }}>public.bandait_workspaces</span> (una fila por usuario,
            clave <span style={{ fontFamily: mono }}>user_id = auth.uid()</span>). El SQL seguro (RLS, revoke a anon,
            políticas por usuario) está en docs/DEPLOY.md, sección 3. Debe ejecutarse en tu proyecto Supabase.
          </div>
        </div>
      </div>
    </div>
  )
}
