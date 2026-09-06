import { useState, useRef } from 'react'

interface Props {
  onConnect: (sessionId: string) => void
  onSettings?: () => void
  onLibrary?: () => void
}

export default function ConnectView({ onConnect, onSettings, onLibrary }: Props) {
  const [ip, setIp] = useState(localStorage.getItem('bandait_last_ip') || '')
  const [port, setPort] = useState(localStorage.getItem('bandait_last_port') || '4040')
  const [sessionId, setSessionId] = useState('default')
  const [scanning, setScanning] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    localStorage.setItem('bandait_last_ip', ip)
    localStorage.setItem('bandait_last_port', port)
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
    }, 1500)
  }

  return (
    <div className="connect-view">
      <div style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px' }}>
        {onLibrary && (
          <button
            type="button"
            onClick={onLibrary}
            style={{
              background: 'transparent',
              border: '1px solid var(--text-secondary)',
              color: 'var(--text-secondary)',
              padding: '6px 12px',
              borderRadius: '4px',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
            }}
          >
            [LIB]
          </button>
        )}
        {onSettings && (
          <button
            type="button"
            onClick={onSettings}
            style={{
              background: 'transparent',
              border: '1px solid var(--text-secondary)',
              color: 'var(--text-secondary)',
              padding: '6px 12px',
              borderRadius: '4px',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
            }}
          >
            [CFG]
          </button>
        )}
      </div>

      <h1 className="connect-title">BANDAIT</h1>
      <p className="connect-subtitle">Stage Monitor</p>

      <form onSubmit={handleSubmit} className="connect-form">
        <label className="form-label">
          Leader IP
          <input
            type="text"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.1.10"
            className="form-input"
            required
          />
        </label>

        <label className="form-label">
          Port
          <input
            type="text"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="form-input"
            required
          />
        </label>

        <label className="form-label">
          Session ID
          <input
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="form-input"
            required
          />
        </label>

        <button type="submit" className="btn-primary">
          CONNECT
        </button>
      </form>

      <div className="connect-divider">OR</div>

      <button onClick={handleQrUpload} className="btn-secondary">
        {scanning ? 'SCANNING...' : 'SCAN QR CODE'}
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
    </div>
  )
}
