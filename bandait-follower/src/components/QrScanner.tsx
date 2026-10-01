import { useCallback, useEffect, useRef, useState } from 'react'
import type { Html5Qrcode } from 'html5-qrcode'
import { QrConnectionData, parseQrData } from '../services/qrDiscovery'
import { CloseIcon, QrIcon } from './Icons'

interface Props {
  onResult: (data: QrConnectionData) => void
  onCancel: () => void
}

const CAMERA_ID = 'bandait-qr-camera'
const FILE_ID = 'bandait-qr-file'

type Mode = 'idle' | 'starting' | 'scanning' | 'decoding'

function cameraAvailable(): { ok: boolean; reason: string | null } {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return { ok: false, reason: 'SIN NAVEGADOR' }
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'LA CAMARA EN VIVO REQUIERE HTTPS. USA "FOTO DEL QR" O INGRESA LA IP A MANO.',
    }
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return { ok: false, reason: 'ESTE NAVEGADOR NO EXPONE LA CAMARA. USA "FOTO DEL QR".' }
  }
  return { ok: true, reason: null }
}

function describeCameraError(err: unknown): string {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  if (/NotAllowed|Permission|denied/i.test(text)) {
    return 'PERMISO DE CAMARA DENEGADO. ACTIVALO EN EL NAVEGADOR, USA "FOTO DEL QR" O INGRESA LA IP A MANO.'
  }
  if (/NotFound|no camera|Requested device not found/i.test(text)) {
    return 'NO SE ENCONTRO CAMARA. USA "FOTO DEL QR" O INGRESA LA IP A MANO.'
  }
  if (/NotReadable|in use|Could not start/i.test(text)) {
    return 'LA CAMARA ESTA EN USO POR OTRA APP.'
  }
  return `NO SE PUDO ABRIR LA CAMARA (${text.slice(0, 80)})`
}

async function loadLibrary(): Promise<typeof import('html5-qrcode')> {
  return import('html5-qrcode')
}

/**
 * Reads the leader connection QR (JSON, http:// or bandait:// URL, parsed by
 * services/qrDiscovery). It never connects by itself: it hands the parsed
 * data to onResult. Camera permission errors are shown, never thrown.
 */
export default function QrScanner({ onResult, onCancel }: Props) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(false)
  const doneRef = useRef(false)
  const [mode, setMode] = useState<Mode>('idle')
  const [error, setError] = useState<string | null>(null)
  const camera = cameraAvailable()

  const stopCamera = useCallback(async () => {
    const scanner = scannerRef.current
    scannerRef.current = null
    if (!scanner) return
    try {
      if (scanner.isScanning) await scanner.stop()
    } catch {
      // Already stopped.
    }
    try {
      scanner.clear()
    } catch {
      // Element may already be gone.
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void stopCamera()
    }
  }, [stopCamera])

  const accept = useCallback(
    (text: string): boolean => {
      const data = parseQrData(text)
      if (!data) {
        if (mountedRef.current) setError('QR NO RECONOCIDO: NO ES UNA CREDENCIAL BANDAIT.')
        return false
      }
      if (doneRef.current) return true
      doneRef.current = true
      void stopCamera()
      onResult(data)
      return true
    },
    [onResult, stopCamera],
  )

  const startCamera = async () => {
    if (!camera.ok || mode === 'starting' || mode === 'scanning') return
    setError(null)
    setMode('starting')
    try {
      const { Html5Qrcode: Scanner } = await loadLibrary()
      if (!mountedRef.current) return
      const scanner = new Scanner(CAMERA_ID, { verbose: false })
      scannerRef.current = scanner
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decoded) => {
          accept(decoded)
        },
        () => {
          // No QR in this frame yet.
        },
      )
      if (mountedRef.current) setMode('scanning')
    } catch (err) {
      await stopCamera()
      if (mountedRef.current) {
        setError(describeCameraError(err))
        setMode('idle')
      }
    }
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setMode('decoding')
    try {
      await stopCamera()
      const { Html5Qrcode: Scanner } = await loadLibrary()
      const decoder = new Scanner(FILE_ID, { verbose: false })
      const text = await decoder.scanFile(file, false)
      try {
        decoder.clear()
      } catch {
        // Nothing rendered.
      }
      accept(text)
    } catch {
      if (mountedRef.current) setError('NO SE ENCONTRO UN QR LEGIBLE EN LA FOTO. ACERCATE Y EVITA REFLEJOS.')
    } finally {
      if (mountedRef.current) setMode('idle')
    }
  }

  const cancel = async () => {
    await stopCamera()
    onCancel()
  }

  return (
    <div className="qr-scanner-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="form-label" style={{ margin: 0 }}>
          <span>LECTOR DE CREDENCIAL QR</span>
        </span>
        <button type="button" className="btn-stage-icon" onClick={cancel} aria-label="Cerrar lector QR">
          <CloseIcon size={14} />
        </button>
      </div>

      <div id={CAMERA_ID} className="qr-camera-view" />
      <div id={FILE_ID} style={{ display: 'none' }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' }}>
        <button
          type="button"
          className="btn-stage btn-stage-primary"
          onClick={startCamera}
          disabled={!camera.ok || mode === 'starting' || mode === 'scanning'}
        >
          <QrIcon size={16} />
          <span>{mode === 'starting' ? 'ABRIENDO...' : mode === 'scanning' ? 'APUNTA AL QR' : 'CAMARA EN VIVO'}</span>
        </button>
        <button
          type="button"
          className="btn-stage btn-stage-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={mode === 'decoding'}
        >
          <span>{mode === 'decoding' ? 'LEYENDO FOTO...' : 'FOTO DEL QR'}</span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      {!camera.ok && camera.reason && <div className="qr-scanner-note">{camera.reason}</div>}
      {error && (
        <div className="qr-scanner-note error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
