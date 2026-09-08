import { useState, useRef } from 'react'
import { LibraryIcon, SettingsIcon, WifiIcon, QrIcon, ShieldIcon } from '../components/Icons'

interface Props {
  onConnect: (sessionId: string) => void
  onSettings?: () => void
  onLibrary?: () => void
}

const IP_PRESETS = [
  { label: 'AUTO (192.168.1.100)', ip: '192.168.1.100' },
  { label: 'DIRECTOR (192.168.0.50)', ip: '192.168.0.50' },
  { label: 'LOCALHOST', ip: '127.0.0.1' },
]

export default function ConnectView({ onConnect, onSettings, onLibrary }: Props) {
  const [ip, setIp] = useState(localStorage.getItem('bandait_last_ip') || '192.168.1.100')
  const [port, setPort] = useState(localStorage.getItem('bandait_last_port') || '4040')
  const [sessionId, setSessionId] = useState(localStorage.getItem('bandait_last_session') || 'default')
  const [scanning, setScanning] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

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
      onConnect('default')
    }, 1200)
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

        {/* HARDWARE DIAGNOSTICS STRIP */}
        <div className="hardware-diagnostics">
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
