import React, { useEffect, useMemo, useState } from 'react'
import { HardDrive, Sliders, Trash2, Upload } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import { HubModal } from '../components/HubModal'
import { StemImporter } from '../components/StemImporter'
import { StemStudio } from '../components/StemStudio'
import { formatBytes } from '../services/stemImport'
import { deleteStemSong, listStemSongs, storageEstimate, StemStoreError, type StemSongRecord } from '../services/stemStore'
import { cardStyle, colors, ghostButton, headerBarStyle, labelStyle, mono, primaryButton, smallInputStyle, viewStyle } from '../components/hubStyles'

/**
 * PISTAS & STEMS: cada musico carga los stems de una cancion de la libreria y los estudia en casa.
 * Todo queda en ESTE navegador (IndexedDB, services/stemStore.ts); nada se sube a la nube.
 */
export const StemsHubView: React.FC = () => {
  const { songs } = useHub()
  const [records, setRecords] = useState<Map<string, StemSongRecord> | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [pickedSongId, setPickedSongId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState<{ songId: string; title: string } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const [usageTick, setUsageTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    listStemSongs()
      .then((list) => {
        if (!cancelled) setRecords(new Map(list.map((r) => [r.songId, r])))
      })
      .catch((err) => {
        if (cancelled) return
        setRecords(new Map())
        setListError(err instanceof StemStoreError ? err.message : 'No se pudo leer el almacenamiento local.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void storageEstimate().then((u) => {
      if (!cancelled) setUsage(u)
    })
    return () => {
      cancelled = true
    }
  }, [usageTick])

  const sortedSongs = useMemo(() => [...songs].sort((a, b) => a.title.localeCompare(b.title, 'es')), [songs])
  const songIds = useMemo(() => new Set(songs.map((s) => s.id)), [songs])
  const orphans = useMemo(() => (records ? [...records.values()].filter((r) => !songIds.has(r.songId)) : []), [records, songIds])

  // Cancion elegida; por defecto la primera con stems y si no hay, la primera de la libreria.
  const selectedSong =
    sortedSongs.find((s) => s.id === pickedSongId) ?? sortedSongs.find((s) => records?.has(s.id)) ?? sortedSongs[0] ?? null
  const record = selectedSong && records ? records.get(selectedSong.id) ?? null : null
  const showImporter = !!selectedSong && records !== null && (importing || !record)

  const setRecord = (songId: string, next: StemSongRecord | null) => {
    setRecords((prev) => {
      const map = new Map(prev ?? [])
      if (next) map.set(songId, next)
      else map.delete(songId)
      return map
    })
    setUsageTick((n) => n + 1)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await deleteStemSong(deleting.songId)
      setRecord(deleting.songId, null)
      setDeleting(null)
      setDeleteError(null)
    } catch (err) {
      setDeleteError(err instanceof StemStoreError ? err.message : 'No se pudieron borrar los stems.')
    }
  }

  const studioKey = record ? `${record.songId}:${record.tracks.map((t) => t.id).join(',')}` : 'none'

  return (
    <div style={viewStyle}>
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sliders size={22} style={{ color: colors.cobalt, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Estudio de Stems</h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted }}>
            Carga los stems de una canción (ZIP de Moises o archivos sueltos) y estúdialos en casa: mute, solo y repetir una sección. Los
            archivos quedan solo en este navegador.
          </p>
        </div>
        {usage && (
          <div
            data-testid="stem-storage"
            title="Espacio usado por el hub en este navegador"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: mono, fontSize: '11px', color: colors.muted }}
          >
            <HardDrive size={13} /> {formatBytes(usage.usage)} de {formatBytes(usage.quota)}
          </div>
        )}
      </div>

      {listError && (
        <div role="alert" style={{ ...cardStyle, padding: '10px 12px', color: colors.danger, fontSize: '12px', borderColor: colors.danger }}>
          {listError}
        </div>
      )}

      {songs.length === 0 ? (
        <div style={{ ...cardStyle, padding: '32px 16px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
          La librería de esta banda está vacía. Crea la canción en CANCIONES y vuelve aquí para cargar sus stems.
        </div>
      ) : (
        <div style={{ ...cardStyle, padding: '12px 14px', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap', minWidth: 0 }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <label htmlFor="stem-song" style={labelStyle}>
              CANCIÓN
            </label>
            <select
              id="stem-song"
              data-testid="stem-song-select"
              className="stx-field"
              value={selectedSong?.id ?? ''}
              onChange={(e) => {
                setPickedSongId(e.target.value)
                setImporting(false)
              }}
              style={{ ...smallInputStyle, width: '100%', marginTop: '4px', padding: '7px 8px', fontSize: '13px' }}
            >
              {sortedSongs.map((s) => {
                const r = records?.get(s.id)
                return (
                  <option key={s.id} value={s.id}>
                    {s.title}
                    {r ? ` · ${r.tracks.length} stem${r.tracks.length === 1 ? '' : 's'}` : ''}
                  </option>
                )
              })}
            </select>
          </div>
          {selectedSong && record && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="stx-btn"
                onClick={() => setImporting((v) => !v)}
                aria-expanded={importing}
                style={{ ...primaryButton(colors.cobalt), color: colors.onAccent }}
              >
                <Upload size={13} /> {importing ? 'CERRAR IMPORTACIÓN' : 'IMPORTAR MÁS'}
              </button>
              <button
                type="button"
                className="stx-btn"
                data-testid="stem-delete-song"
                onClick={() => setDeleting({ songId: selectedSong.id, title: selectedSong.title })}
                style={{ ...ghostButton, color: colors.danger }}
              >
                <Trash2 size={13} /> BORRAR STEMS
              </button>
            </div>
          )}
        </div>
      )}

      {records === null && songs.length > 0 && (
        <div style={{ fontFamily: mono, fontSize: '12px', color: colors.muted }}>LEYENDO STEMS GUARDADOS...</div>
      )}

      {showImporter && selectedSong && (
        <StemImporter
          key={selectedSong.id}
          song={selectedSong}
          existingLabels={record?.tracks.map((t) => t.label) ?? []}
          onSaved={(next) => {
            setRecord(selectedSong.id, next)
            setImporting(false)
          }}
          onCancel={record ? () => setImporting(false) : undefined}
        />
      )}

      {selectedSong && record && <StemStudio key={studioKey} song={selectedSong} record={record} onRecordChange={(next) => setRecord(selectedSong.id, next)} />}

      {orphans.length > 0 && (
        <div style={{ ...cardStyle, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
            STEMS DE CANCIONES QUE NO ESTÁN EN ESTA BANDA (otra banda o canción borrada)
          </div>
          {orphans.map((r) => (
            <div key={r.songId} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px', color: colors.text }}>
              <span style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>
                {r.tracks.map((t) => t.label).join(', ')} · {formatBytes(r.tracks.reduce((n, t) => n + t.size, 0))}
              </span>
              <button
                type="button"
                className="stx-btn"
                onClick={() => setDeleting({ songId: r.songId, title: 'una canción que no está en esta banda' })}
                style={{ ...ghostButton, padding: '5px 8px', fontSize: '11px', color: colors.danger }}
              >
                <Trash2 size={12} /> BORRAR
              </button>
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <HubModal
          title="BORRAR STEMS"
          onClose={() => {
            setDeleting(null)
            setDeleteError(null)
          }}
          maxWidth="420px"
          testId="stem-delete-confirm"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px', color: colors.muted }}>
            <div>
              ¿Borrar de este navegador los stems de <strong style={{ color: colors.text }}>{deleting.title}</strong>? La canción sigue en la
              librería; solo se borran los archivos de audio.
            </div>
            {deleteError && <div style={{ color: colors.danger }}>{deleteError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="stx-btn"
                onClick={() => {
                  setDeleting(null)
                  setDeleteError(null)
                }}
                style={{ ...ghostButton, background: 'transparent', color: colors.muted }}
              >
                CANCELAR
              </button>
              <button type="button" className="stx-btn" onClick={() => void confirmDelete()} style={{ ...primaryButton(colors.danger), color: colors.onAccent }}>
                BORRAR
              </button>
            </div>
          </div>
        </HubModal>
      )}
    </div>
  )
}
