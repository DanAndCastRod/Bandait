import { useEffect, useState, useRef } from 'react'
import { getAllSetlists, StoredSetlist } from '../db/indexedDb'
import DiffPreviewModal from '../components/DiffPreviewModal'
import {
  calculateDiffPreview,
  getCurrentMasterWorkbook,
  applyMasterWorkbookToDb,
  getSampleIncomingWorkbook,
} from '../services/xlsxService'
import { DiffPreview, ExcelMasterWorkbook } from '../types/xlsx'
import { LibraryIcon, UploadIcon, DownloadIcon, ShieldIcon } from '../components/Icons'

interface Props {
  onSelectSetlist: (id: string) => void
  onBack: () => void
}

export default function LibraryView({ onSelectSetlist, onBack }: Props) {
  const [setlists, setSetlists] = useState<StoredSetlist[]>([])
  const [loading, setLoading] = useState(true)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  // Diff Preview state
  const [diffPreview, setDiffPreview] = useState<DiffPreview | null>(null)
  const [pendingWorkbook, setPendingWorkbook] = useState<ExcelMasterWorkbook | null>(null)
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadSetlists = () => {
    setLoading(true)
    getAllSetlists()
      .then((items) => {
        setSetlists(items)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    loadSetlists()
  }, [])

  const handleOpenSampleImport = () => {
    const current = getCurrentMasterWorkbook()
    const incoming = getSampleIncomingWorkbook()
    const diff = calculateDiffPreview(current, incoming)
    setPendingWorkbook(incoming)
    setDiffPreview(diff)
    setIsDiffModalOpen(true)
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string
        const incoming = JSON.parse(text) as ExcelMasterWorkbook
        if (!incoming.canciones || !incoming.setlists) {
          setStatusMessage('[ERR] Formato no reconocido de libro maestro.')
          return
        }
        const current = getCurrentMasterWorkbook()
        const diff = calculateDiffPreview(current, incoming)
        setPendingWorkbook(incoming)
        setDiffPreview(diff)
        setIsDiffModalOpen(true)
      } catch {
        setStatusMessage('[ERR] No se pudo procesar el archivo.')
      }
    }
    reader.readAsText(file)
  }

  const handleConfirmDiff = async () => {
    if (!pendingWorkbook) return
    try {
      await applyMasterWorkbookToDb(pendingWorkbook)
      setIsDiffModalOpen(false)
      setPendingWorkbook(null)
      setDiffPreview(null)
      loadSetlists()
      setStatusMessage('[OK] Libro maestro aplicado con éxito a la base de datos local.')
      setTimeout(() => setStatusMessage(null), 4000)
    } catch {
      setStatusMessage('[ERR] Error al guardar datos del libro maestro en IndexedDB.')
    }
  }

  const handleCancelDiff = () => {
    setIsDiffModalOpen(false)
    setPendingWorkbook(null)
    setDiffPreview(null)
  }

  const handleExportWorkbook = () => {
    const current = getCurrentMasterWorkbook()
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(current, null, 2))
    const downloadAnchor = document.createElement('a')
    downloadAnchor.setAttribute('href', dataStr)
    downloadAnchor.setAttribute('download', `bandait_master_${new Date().toISOString().slice(0, 10)}.json`)
    document.body.appendChild(downloadAnchor)
    downloadAnchor.click()
    downloadAnchor.remove()
    setStatusMessage('[OK] Libro maestro exportado correctamente.')
    setTimeout(() => setStatusMessage(null), 3000)
  }

  return (
    <div className="library-view">
      {/* HEADER */}
      <div className="library-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <button type="button" className="btn-stage btn-stage-secondary" onClick={onBack} style={{ padding: '8px 14px', fontSize: '12px' }}>
            [VOLVER]
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <LibraryIcon size={20} style={{ color: 'var(--accent-active)' }} />
            <h1 className="library-title" style={{ margin: 0 }}>BIBLIOTECA // CATÁLOGO</h1>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".json,.xlsx"
            style={{ display: 'none' }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn-stage btn-stage-primary"
            style={{ padding: '8px 14px', fontSize: '11px' }}
          >
            <UploadIcon size={14} />
            <span>IMPORTAR LIBRO</span>
          </button>

          <button
            type="button"
            onClick={handleOpenSampleImport}
            className="btn-stage btn-stage-secondary"
            style={{ padding: '8px 14px', fontSize: '11px' }}
          >
            <span>DIFF PREVIEW DEMO</span>
          </button>

          <button
            type="button"
            onClick={handleExportWorkbook}
            className="btn-stage btn-stage-secondary"
            style={{ padding: '8px 14px', fontSize: '11px' }}
          >
            <DownloadIcon size={14} />
            <span>EXPORTAR JSON</span>
          </button>
        </div>
      </div>

      {/* MULTI-BAND INFO BADGE */}
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--theme-border)',
          borderRadius: 'var(--theme-radius)',
          padding: '10px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldIcon size={14} style={{ color: 'var(--accent-success)' }} />
          <span>
            <span style={{ color: 'var(--text-disabled)' }}>AGRUPACIÓN ACTIVA:</span>{' '}
            <strong style={{ color: 'var(--text-primary)' }}>LOS INQUIETOS DEL ROCK</strong>
          </span>
        </div>
        <span>
          <span style={{ color: 'var(--text-disabled)' }}>ROL:</span>{' '}
          <strong style={{ color: 'var(--accent-active)' }}>[MUSIC DIRECTOR]</strong>
        </span>
      </div>

      {statusMessage && (
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--accent-active)',
            color: 'var(--accent-active)',
            padding: '10px 16px',
            borderRadius: 'var(--theme-radius)',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {statusMessage}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '40px', fontFamily: 'var(--font-mono)', fontSize: '13px' }}>
          Cargando setlists cacheados en memoria local...
        </div>
      )}

      {!loading && setlists.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '48px 24px', background: 'var(--bg-surface)', borderRadius: 'var(--theme-radius)', border: '1px dashed var(--theme-border)' }}>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', color: 'var(--text-primary)', marginBottom: '8px' }}>
            No hay setlists almacenados localmente en IndexedDB.
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', maxWidth: '440px', margin: '0 auto' }}>
            Importa un archivo maestro XLSX/JSON o pulsa [DIFF PREVIEW DEMO] para precargar el repertorio del show.
          </p>
        </div>
      )}

      <div className="setlist-grid">
        {setlists.map((sl) => (
          <div
            key={sl.id}
            className="setlist-card"
            onClick={() => onSelectSetlist(sl.id)}
          >
            <div className="setlist-name">
              {sl.name}
            </div>
            <div className="setlist-meta">
              {sl.songs.length} CANCIONES // SINCRONIZADO OFFLINE
            </div>
            <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  fontWeight: 800,
                  color: 'var(--accent-active)',
                  letterSpacing: '1px',
                }}
              >
                [CARGAR EN ESCENARIO &gt;]
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* DIFF PREVIEW MODAL */}
      {diffPreview && (
        <DiffPreviewModal
          diff={diffPreview}
          isOpen={isDiffModalOpen}
          onConfirm={handleConfirmDiff}
          onCancel={handleCancelDiff}
        />
      )}
    </div>
  )
}
