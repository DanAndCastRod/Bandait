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
      <div className="library-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button className="btn-back" onClick={onBack} style={{ fontFamily: 'var(--font-mono)' }}>
            [VOLVER]
          </button>
          <h1 className="library-title" style={{ margin: 0 }}>BIBLIOTECA // CATÁLOGO</h1>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".json,.xlsx"
            style={{ display: 'none' }}
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              background: 'transparent',
              border: '1px solid var(--accent-active)',
              color: 'var(--accent-active)',
              padding: '8px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              cursor: 'pointer',
              borderRadius: '4px',
            }}
          >
            [IMPORTAR ARCHIVO]
          </button>

          <button
            onClick={handleOpenSampleImport}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--theme-border)',
              color: 'var(--text-primary)',
              padding: '8px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              cursor: 'pointer',
              borderRadius: '4px',
            }}
          >
            [DIFF PREVIEW DEMO]
          </button>

          <button
            onClick={handleExportWorkbook}
            style={{
              background: 'transparent',
              border: '1px solid var(--theme-border)',
              color: 'var(--text-secondary)',
              padding: '8px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              cursor: 'pointer',
              borderRadius: '4px',
            }}
          >
            [EXPORTAR JSON]
          </button>
        </div>
      </div>

      {/* MULTI-BAND INFO BADGE */}
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--theme-border)',
          borderRadius: '4px',
          padding: '8px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span>
          <span style={{ color: 'var(--text-disabled)' }}>AGRUPACIÓN ACTIVA:</span>{' '}
          <strong style={{ color: 'var(--accent-active)' }}>LOS INQUIETOS DEL ROCK</strong>
        </span>
        <span>
          <span style={{ color: 'var(--text-disabled)' }}>ROL:</span>{' '}
          <strong style={{ color: 'var(--accent-active)' }}>[MUSIC DIRECTOR]</strong>
        </span>
      </div>

      {statusMessage && (
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--accent-active)',
            color: 'var(--accent-active)',
            padding: '10px 14px',
            borderRadius: '4px',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {statusMessage}
        </div>
      )}

      {loading && <div className="library-loading">Cargando setlists cacheados...</div>}

      {!loading && setlists.length === 0 && (
        <div className="library-empty">
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '14px' }}>No hay setlists almacenados localmente.</p>
          <p className="library-hint" style={{ color: 'var(--text-secondary)' }}>
            Importa un archivo maestro o pulsa [DIFF PREVIEW DEMO] para precargar el catálogo.
          </p>
        </div>
      )}

      <div className="setlist-grid">
        {setlists.map((sl) => (
          <div
            key={sl.id}
            className="setlist-card"
            onClick={() => onSelectSetlist(sl.id)}
            style={{ cursor: 'pointer' }}
          >
            <div className="setlist-name" style={{ fontFamily: 'var(--font-mono)', fontWeight: 'bold' }}>
              {sl.name}
            </div>
            <div className="setlist-meta" style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '6px' }}>
              {sl.songs.length} canciones
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
