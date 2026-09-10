import React, { useState, useEffect } from 'react'
import {
  Cloud,
  CheckCircle2,
  AlertCircle,
  X,
  Database,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import {
  getSupabaseConfig,
  saveSupabaseConfig,
  clearSupabaseConfig,
  checkSupabaseHealth,
  syncWorkspaceToCloud,
} from '../services/supabaseClient'
import { useHub } from '../context/HubContext'

interface Props {
  onClose: () => void
}

export const SupabaseConfigModal: React.FC<Props> = ({ onClose }) => {
  const { user } = useHub()
  const [url, setUrl] = useState('')
  const [anonKey, setAnonKey] = useState('')
  const [status, setStatus] = useState<{ loading: boolean; ok?: boolean; message?: string }>({
    loading: false,
  })

  useEffect(() => {
    const config = getSupabaseConfig()
    setUrl(config.url)
    setAnonKey(config.anonKey)
    if (config.isConfigured) {
      handleTestConnection()
    }
  }, [])

  const handleTestConnection = async () => {
    setStatus({ loading: true })
    const res = await checkSupabaseHealth()
    setStatus({ loading: false, ok: res.ok, message: res.message })
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || !anonKey.trim()) return

    const saved = saveSupabaseConfig(url, anonKey)
    if (saved) {
      setStatus({ loading: true })
      const res = await checkSupabaseHealth()
      setStatus({ loading: false, ok: res.ok, message: res.message })
    }
  }

  const handleClear = () => {
    clearSupabaseConfig()
    setUrl('')
    setAnonKey('')
    setStatus({ loading: false, ok: false, message: 'Configuracion eliminada. El sistema opera en modo Local-First.' })
  }

  const handleSyncNow = async () => {
    if (!user) return
    setStatus({ loading: true })
    const raw = localStorage.getItem(`bandait_workspace_${user.id}`)
    if (!raw) {
      setStatus({ loading: false, ok: false, message: 'No hay datos locales para sincronizar.' })
      return
    }

    try {
      const parsed = JSON.parse(raw)
      const success = await syncWorkspaceToCloud(user.id, parsed)
      if (success) {
        setStatus({ loading: false, ok: true, message: 'Workspace sincronizado exitosamente con la nube Supabase.' })
      } else {
        setStatus({ loading: false, ok: false, message: 'Error al sincronizar. Revisa la tabla bandait_workspaces.' })
      }
    } catch {
      setStatus({ loading: false, ok: false, message: 'Error al procesar el workspace local.' })
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
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
        style={{
          background: '#161b26',
          border: '1px solid #2a3346',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '520px',
          padding: '24px',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.9)',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          maxHeight: '90dvh',
          overflowY: 'auto',
        }}
      >
        {/* HEADER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #2a3346', paddingBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Cloud size={20} style={{ color: '#0066ff' }} />
            <h3 style={{ margin: 0, fontFamily: "'IBM Plex Mono', monospace", fontSize: '15px', color: '#ffffff' }}>
              SINCRONIZACION EN LA NUBE // SUPABASE
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px' }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
          Conecta tu proyecto de Supabase para sincronizacion automatica entre tu laptop, tableta y telefonos de la banda en tiempo real. Si no esta configurado, Bandait opera 100% de forma autonoma en <strong style={{ color: '#ffffff' }}>Local-First</strong>.
        </p>

        {/* STATUS BANNER */}
        {status.message && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
              background: status.ok ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
              border: `1px solid ${status.ok ? '#10b981' : '#ef4444'}`,
              color: status.ok ? '#10b981' : '#ef4444',
            }}
          >
            {status.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{status.message}</span>
          </div>
        )}

        {/* FORM */}
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
              SUPABASE PROJECT URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xyzproject.supabase.co"
              required
              style={{
                width: '100%',
                background: '#0d1017',
                border: '1px solid #2a3346',
                borderRadius: '4px',
                padding: '8px 10px',
                color: '#ffffff',
                marginTop: '4px',
                boxSizing: 'border-box',
                fontSize: '13px',
              }}
            />
          </div>

          <div>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
              SUPABASE ANON KEY
            </label>
            <input
              type="password"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsIn..."
              required
              style={{
                width: '100%',
                background: '#0d1017',
                border: '1px solid #2a3346',
                borderRadius: '4px',
                padding: '8px 10px',
                color: '#ffffff',
                marginTop: '4px',
                boxSizing: 'border-box',
                fontSize: '13px',
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={status.loading || !url}
                style={{
                  background: 'transparent',
                  border: '1px solid #2a3346',
                  color: '#94a3b8',
                  padding: '7px 12px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontFamily: "'IBM Plex Mono', monospace",
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <RefreshCw size={12} className={status.loading ? 'spin' : ''} />
                <span>PROBAR CONEXION</span>
              </button>

              {url && (
                <button
                  type="button"
                  onClick={handleClear}
                  style={{
                    background: 'transparent',
                    border: '1px solid #ef4444',
                    color: '#ef4444',
                    padding: '7px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                  title="Eliminar configuracion"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              {status.ok && (
                <button
                  type="button"
                  onClick={handleSyncNow}
                  style={{
                    background: '#10b981',
                    border: 'none',
                    color: '#ffffff',
                    padding: '7px 14px',
                    borderRadius: '4px',
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <Database size={12} />
                  <span>SINCRONIZAR AHORA</span>
                </button>
              )}

              <button
                type="submit"
                style={{
                  background: '#0066ff',
                  border: 'none',
                  color: '#ffffff',
                  padding: '7px 16px',
                  borderRadius: '4px',
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                GUARDAR Y ACTIVAR
              </button>
            </div>
          </div>
        </form>

        <div style={{ background: '#0d1017', border: '1px solid #2a3346', borderRadius: '4px', padding: '10px', fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
          <strong style={{ color: '#ffffff' }}>ESPECIFICACION SQL (TABLA SUPABASE):</strong>
          <pre style={{ margin: '6px 0 0 0', fontFamily: "'IBM Plex Mono', monospace", fontSize: '10px', color: '#10b981' }}>
{`CREATE TABLE bandait_workspaces (
  user_id TEXT PRIMARY KEY,
  workspace JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);`}
          </pre>
        </div>
      </div>
    </div>
  )
}
