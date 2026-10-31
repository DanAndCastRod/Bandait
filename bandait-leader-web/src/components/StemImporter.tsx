import React, { useMemo, useState } from 'react'
import { AlertTriangle, FileArchive, Loader2, Upload, X } from 'lucide-react'
import type { Song } from '../types/hub'
import { KNOWN_STEM_ROLES, STEM_ROLE_CODES, stemRoleLabel, type StemRole } from '../services/stemNames'
import { defaultLabels, formatBytes, scanImportFiles, type ImportScan, type StemCandidate } from '../services/stemImport'
import { requestPersistentStorage, saveStemSong, StemStoreError, type StemSongRecord } from '../services/stemStore'
import { cardStyle, colors, ghostButton, mono, primaryButton, smallInputStyle } from './hubStyles'

interface Props {
  song: Song
  /** Etiquetas de los stems ya guardados (para numerar "Guitarra 2" al agregar). */
  existingLabels: string[]
  onSaved: (record: StemSongRecord) => void
  /** Ausente cuando la cancion aun no tiene stems: no hay nada a que volver. */
  onCancel?: () => void
}

interface Row extends StemCandidate {
  include: boolean
}

const ACCEPT = '.zip,.mp3,.m4a,.wav,.flac,.ogg,.aac,audio/*,application/zip'

export const StemImporter: React.FC<Props> = ({ song, existingLabels, onSaved, onCancel }) => {
  const [rows, setRows] = useState<Row[]>([])
  const [ignored, setIgnored] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState<'scanning' | 'saving' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const included = rows.filter((r) => r.include)
  const unknownCount = included.filter((r) => r.role === 'unknown').length
  const hasExisting = existingLabels.length > 0

  // Etiqueta con la que se guardara cada fila incluida (al agregar, sigue la numeracion existente).
  const labels = useMemo(() => {
    const inc = rows.filter((r) => r.include)
    const appendLabels = defaultLabels(
      inc.map((r) => r.role),
      existingLabels
    )
    const replaceLabels = defaultLabels(inc.map((r) => r.role))
    const map = new Map<string, { append: string; replace: string }>()
    inc.forEach((r, i) => map.set(r.key, { append: appendLabels[i], replace: replaceLabels[i] }))
    return map
  }, [rows, existingLabels])

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || busy) return
    setBusy('scanning')
    setSaveError(null)
    let scan: ImportScan
    try {
      scan = await scanImportFiles(files)
    } catch {
      scan = { candidates: [], ignored: [], errors: ['No se pudieron leer los archivos seleccionados.'] }
    }
    setRows((prev) => [...prev, ...scan.candidates.map((c) => ({ ...c, include: true }))])
    setIgnored((prev) => [...prev, ...scan.ignored])
    setErrors((prev) => [...prev, ...scan.errors])
    setBusy(null)
  }

  const save = async (mode: 'replace' | 'append') => {
    if (busy || included.length === 0 || unknownCount > 0) return
    setBusy('saving')
    setSaveError(null)
    try {
      await requestPersistentStorage()
      const record = await saveStemSong(
        song.id,
        included.map((r) => {
          const l = labels.get(r.key)
          return { role: r.role, label: (mode === 'append' ? l?.append : l?.replace) ?? stemRoleLabel(r.role), fileName: r.fileName, blob: r.blob }
        }),
        mode
      )
      onSaved(record)
    } catch (err) {
      setSaveError(err instanceof StemStoreError ? err.message : 'No se pudieron guardar los stems.')
      setBusy(null)
    }
  }

  const updateRow = (key: string, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  return (
    <div data-testid="stem-importer" className="stx-fade-in" style={{ ...cardStyle, padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: mono, fontSize: '12px', fontWeight: 700, color: colors.text }}>IMPORTAR STEMS</div>
          <div style={{ fontSize: '12px', color: colors.muted, overflowWrap: 'anywhere' }}>
            Para <strong style={{ color: colors.text }}>{song.title}</strong>. Se guardan solo en este navegador.
          </div>
        </div>
        {onCancel && (
          <button type="button" className="stx-btn" onClick={onCancel} disabled={busy === 'saving'} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
            <X size={13} /> CANCELAR
          </button>
        )}
      </div>

      <label
        className="stx-drop"
        data-over={dragOver ? 'true' : 'false'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void addFiles(Array.from(e.dataTransfer.files))
        }}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '6px',
          padding: '18px 12px',
          border: `1px dashed ${dragOver ? colors.cobalt : colors.border}`,
          borderRadius: '6px',
          background: colors.input,
          cursor: busy ? 'progress' : 'pointer',
          textAlign: 'center',
          color: colors.muted,
          fontSize: '12px',
        }}
      >
        {busy === 'scanning' ? <Loader2 size={20} style={{ color: colors.cobalt }} /> : <FileArchive size={20} style={{ color: colors.cobalt }} />}
        <span style={{ fontFamily: mono, fontWeight: 700, color: colors.text }}>
          {busy === 'scanning' ? 'LEYENDO ARCHIVOS...' : 'ELEGIR ZIP O ARCHIVOS DE AUDIO'}
        </span>
        <span>Exportación de Moises (ZIP) o archivos sueltos: mp3, m4a, wav, flac, ogg, aac. También puedes soltarlos aquí.</span>
        <input
          data-testid="stem-file-input"
          type="file"
          multiple
          accept={ACCEPT}
          disabled={busy !== null}
          aria-label="Archivos de stems"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void addFiles(files)
          }}
          style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' }}
        />
      </label>

      {errors.length > 0 && (
        <ul data-testid="stem-import-errors" style={{ margin: 0, paddingLeft: '18px', color: colors.danger, fontSize: '12px' }}>
          {errors.map((e, i) => (
            <li key={i} style={{ overflowWrap: 'anywhere' }}>
              {e}
            </li>
          ))}
        </ul>
      )}
      {ignored.length > 0 && (
        <div data-testid="stem-import-ignored" style={{ fontSize: '11px', color: colors.muted, fontFamily: mono, overflowWrap: 'anywhere' }}>
          {ignored.length} archivo(s) ignorado(s), no son audio: {ignored.slice(0, 6).join(', ')}
          {ignored.length > 6 ? '...' : ''}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows.map((r) => {
            const label = labels.get(r.key)
            const shown = label ? (hasExisting ? label.append : label.replace) : null
            return (
              <div
                key={r.key}
                data-testid="stem-candidate"
                data-role={r.role}
                data-file={r.fileName}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                  padding: '8px 10px',
                  borderRadius: '4px',
                  border: `1px solid ${r.include && r.role === 'unknown' ? colors.warning : colors.border}`,
                  background: colors.cardAlt,
                  opacity: r.include ? 1 : 0.55,
                  minWidth: 0,
                }}
              >
                <input
                  type="checkbox"
                  className="stx-field"
                  checked={r.include}
                  onChange={(e) => updateRow(r.key, { include: e.target.checked })}
                  aria-label={`Incluir ${r.fileName}`}
                  style={{ accentColor: colors.cobalt, cursor: 'pointer' }}
                />
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: '3px',
                    background: r.role === 'unknown' ? colors.warning : colors.borderSoft,
                    color: r.role === 'unknown' ? colors.onAccent : colors.text,
                  }}
                >
                  {STEM_ROLE_CODES[r.role]}
                </span>
                <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: colors.text, overflowWrap: 'anywhere' }}>{r.fileName}</div>
                  <div style={{ fontSize: '10px', color: colors.muted, fontFamily: mono, overflowWrap: 'anywhere' }}>
                    {formatBytes(r.blob.size)} · {r.source}
                    {r.path !== r.fileName ? ` · ${r.path}` : ''}
                  </div>
                </div>
                <select
                  className="stx-field"
                  value={r.role}
                  aria-label={`Rol de ${r.fileName}`}
                  onChange={(e) => updateRow(r.key, { role: e.target.value as StemRole })}
                  style={{ ...smallInputStyle, borderColor: r.role === 'unknown' ? colors.warning : colors.border }}
                >
                  {r.role === 'unknown' && <option value="unknown">Elegir rol...</option>}
                  {KNOWN_STEM_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {stemRoleLabel(role)}
                    </option>
                  ))}
                </select>
                {shown && r.role !== 'unknown' && (
                  <span data-testid="stem-candidate-label" style={{ fontFamily: mono, fontSize: '11px', color: colors.cobalt }}>
                    {shown}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {unknownCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: colors.warning, fontSize: '12px' }}>
          <AlertTriangle size={13} /> {unknownCount} pista(s) sin rol reconocido: elige el rol o desmárcalas para guardar.
        </div>
      )}
      {saveError && (
        <div role="alert" style={{ color: colors.danger, fontSize: '12px' }}>
          {saveError}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
          {hasExisting && (
            <button
              type="button"
              className="stx-btn"
              disabled={busy !== null || included.length === 0 || unknownCount > 0}
              onClick={() => void save('append')}
              style={ghostButton}
            >
              AGREGAR A LOS {existingLabels.length} GUARDADOS
            </button>
          )}
          <button
            type="button"
            className="stx-btn"
            data-testid="stem-save"
            disabled={busy !== null || included.length === 0 || unknownCount > 0}
            onClick={() => void save('replace')}
            style={{ ...primaryButton(colors.cobalt), color: colors.onAccent }}
          >
            <Upload size={13} />
            {busy === 'saving' ? 'GUARDANDO...' : hasExisting ? `REEMPLAZAR POR ${included.length}` : `GUARDAR ${included.length} STEM${included.length === 1 ? '' : 'S'}`}
          </button>
        </div>
      )}
    </div>
  )
}
