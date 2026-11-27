import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HardDrive, Sliders, Trash2, Upload } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import { useGlobalAudioEngine } from '../context/globalAudioContextCore'
import { useSplitLocalSaved } from '../context/splitQueueContextCore'
import { HubModal } from '../components/HubModal'
import { StemImporter } from '../components/StemImporter'
import { StemStudio } from '../components/StemStudio'
import { StemCloudBar, type CloudSongState } from '../components/StemCloudBar'
import { SplitUpload } from '../components/SplitUpload'
import { onCloudStemsChanged } from '../services/stemCloudEvents'
import { formatBytes } from '../services/stemImport'
import { deleteStemSong, listStemSongs, loadStemSong, storageEstimate, StemStoreError, type StemSongRecord } from '../services/stemStore'
import {
  cloudBandKey,
  deleteCloudStems,
  downloadStems,
  getManifest,
  isCloudSongId,
  leaderCanPlay,
  manifestMatchesRecord,
  StemCloudError,
  uploadStems,
  type CloudManifest,
} from '../services/stemCloud'
import { stemCloudTarget } from '../services/stemCloudConfig'
import { colors, headerBarStyle, labelStyle, mono, smallInputStyle, viewStyle } from '../components/hubStyles'
import '../styles/audio.css'

interface DeleteRequest {
  songId: string
  title: string
  /** Hay stems en este equipo. */
  local: boolean
  /** Se pueden borrar tambien de la nube (editor y la nube los tiene). */
  cloud: boolean
}

function manifestOf(state: CloudSongState | undefined): CloudManifest | null {
  if (!state || state.kind === 'none') return null
  return state.manifest
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof StemCloudError || err instanceof StemStoreError) return err.message
  return fallback
}

/**
 * PISTAS: cada musico carga los stems de una cancion de la libreria y los estudia en casa.
 * El audio vive en ESTE navegador (IndexedDB, services/stemStore.ts). Con VITE_BANDAIT_STEMS_URL y
 * sesion de nube, ademas se sincroniza con el Worker bandait-stems (services/stemCloud.ts):
 * Owner y Director suben y borran; cualquier integrante descarga.
 *
 * El reproductor es del audio global: salir de la vista no corta el audio, y al volver se elige
 * por defecto la cancion que esta cargada. SUBIR Y SEPARAR encola el trabajo en la cola global
 * (sigue al cambiar de vista).
 */
export const StemsHubView: React.FC = () => {
  const { songs, sharing, activeBand, activeSongId, setActiveSongId } = useHub()
  const audio = useGlobalAudioEngine()
  const [records, setRecords] = useState<Map<string, StemSongRecord> | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  // Por defecto, la cancion que suena (o sono) en el reproductor global o la activa transversal.
  const [pickedSongId, setPickedSongId] = useState<string | null>(() => audio.currentStemSongId() ?? activeSongId)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [cloudStates, setCloudStates] = useState<Record<string, CloudSongState>>({})
  const checkedRef = useRef(new Set<string>())
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

  // Cancion elegida; prioriza la activa transversal, luego la elegida localmente o la primera con stems.
  const selectedSong =
    (activeSongId ? sortedSongs.find((s) => s.id === activeSongId) : undefined) ??
    sortedSongs.find((s) => s.id === pickedSongId) ??
    sortedSongs.find((s) => records?.has(s.id)) ??
    sortedSongs[0] ??
    null
  const record = selectedSong && records ? records.get(selectedSong.id) ?? null : null
  const showImporter = !!selectedSong && records !== null && (importing || !record)

  // Nube: solo con la URL del Worker compilada y una sesion de Supabase vigente.
  const bandKey = cloudBandKey(activeBand?.id, sharing.activeShared)
  const cloudEnabled = sharing.cloudSignedIn && !!activeBand
  const target = useMemo(() => (cloudEnabled ? stemCloudTarget(bandKey) : null), [cloudEnabled, bandKey])
  const canEditCloud = sharing.activeCanEdit
  const cloudKey = useCallback((songId: string) => `${bandKey}:${songId}`, [bandKey])
  const songCloud = !!target && !!selectedSong && isCloudSongId(selectedSong.id)
  const cloudState = selectedSong ? cloudStates[cloudKey(selectedSong.id)] : undefined

  const setCloud = useCallback((key: string, state: CloudSongState | null) => {
    setCloudStates((prev) => {
      const next = { ...prev }
      if (state) next[key] = state
      else delete next[key]
      return next
    })
  }, [])

  const checkCloud = useCallback(
    (songId: string) => {
      if (!target) return
      const key = cloudKey(songId)
      getManifest(target, songId)
        .then((manifest) => setCloud(key, manifest ? { kind: 'present', manifest } : { kind: 'none' }))
        .catch((err) => setCloud(key, { kind: 'error', message: errorText(err, 'No se pudo consultar la nube.'), manifest: null }))
    },
    [target, cloudKey, setCloud]
  )

  // Consultar el manifiesto de la cancion elegida una vez por banda y cancion.
  const selectedId = selectedSong?.id ?? null
  useEffect(() => {
    if (!target || !selectedId || !isCloudSongId(selectedId)) return
    const key = cloudKey(selectedId)
    if (checkedRef.current.has(key)) return
    checkedRef.current.add(key)
    checkCloud(selectedId)
  }, [target, selectedId, cloudKey, checkCloud])

  // La nube cambio por otro camino (separar con Music AI): se olvida el manifiesto guardado.
  useEffect(
    () =>
      onCloudStemsChanged((change) => {
        if (change.band !== bandKey) return
        const key = cloudKey(change.songId)
        if (change.manifest) {
          setCloud(key, { kind: 'present', manifest: change.manifest })
        } else {
          setCloud(key, null)
          checkCloud(change.songId)
        }
      }),
    [bandKey, cloudKey, setCloud, checkCloud]
  )

  const uploadSong = async (songId: string, existing: CloudManifest | null) => {
    if (!target || !canEditCloud || !isCloudSongId(songId)) return
    const key = cloudKey(songId)
    setCloud(key, { kind: 'uploading', done: 0, total: 0, manifest: existing })
    try {
      const loaded = await loadStemSong(songId)
      if (!loaded) throw new StemCloudError('missing_local', 0)
      const manifest = await uploadStems(target, songId, { record: loaded.record, blobs: loaded.blobs, existing }, (done, total) =>
        setCloud(key, { kind: 'uploading', done, total, manifest: existing })
      )
      setCloud(key, { kind: 'present', manifest })
    } catch (err) {
      setCloud(key, { kind: 'error', message: errorText(err, 'No se pudieron subir los stems.'), manifest: existing })
    }
  }

  const downloadSong = async (songId: string, existing: CloudManifest | null) => {
    if (!target) return
    const key = cloudKey(songId)
    setCloud(key, { kind: 'downloading', done: 0, total: existing?.stems.length ?? 0, manifest: existing })
    try {
      const { record: rec, manifest } = await downloadStems(target, songId, (done, total) =>
        setCloud(key, { kind: 'downloading', done, total, manifest: existing })
      )
      setRecord(songId, rec)
      setCloud(key, { kind: 'present', manifest })
    } catch (err) {
      setCloud(key, { kind: 'error', message: errorText(err, 'No se pudieron descargar los stems.'), manifest: existing })
    }
  }

  const setRecord = (songId: string, next: StemSongRecord | null) => {
    setRecords((prev) => {
      const map = new Map(prev ?? [])
      if (next) map.set(songId, next)
      else map.delete(songId)
      return map
    })
    setUsageTick((n) => n + 1)
  }

  // La cola global guardo stems nuevos en este equipo (aunque SUBIR Y SEPARAR ya no este a la vista).
  useSplitLocalSaved(bandKey, (event) => setRecord(event.songId, event.record))

  const confirmDelete = async (alsoCloud: boolean) => {
    if (!deleting || deleteBusy) return
    const req = deleting
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      // Primero la nube: si falla, lo local queda intacto y se puede reintentar.
      if (alsoCloud && req.cloud && target) {
        await deleteCloudStems(target, req.songId)
        setCloud(cloudKey(req.songId), { kind: 'none' })
      }
      if (req.local) {
        await deleteStemSong(req.songId)
        // Sin archivos no hay nada que reproducir: el audio global suelta esa cancion.
        audio.releaseStem(req.songId)
        setRecord(req.songId, null)
      }
      setDeleting(null)
    } catch (err) {
      setDeleteError(errorText(err, 'No se pudieron borrar los stems.'))
    } finally {
      setDeleteBusy(false)
    }
  }

  const closeDelete = () => {
    if (deleteBusy) return
    setDeleting(null)
    setDeleteError(null)
  }

  const cloudManifest = manifestOf(cloudState)
  const inSync = !!cloudManifest && !!record && manifestMatchesRecord(cloudManifest, record)
  const leaderUnplayable = record ? record.tracks.filter((t) => !leaderCanPlay(t.fileName)).map((t) => t.fileName) : []
  const importerCloudNote = songCloud
    ? canEditCloud
      ? 'Al guardar se suben también a la nube de la banda. El líder solo reproduce MP3, WAV, FLAC u OGG (no M4A).'
      : 'Solo el Owner o el Director musical pueden subir stems a la nube de esta banda: estos quedan en este equipo.'
    : null

  const studioKey = record ? `${record.songId}:${record.tracks.map((t) => t.id).join(',')}` : 'none'

  return (
    <div style={viewStyle}>
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="ga-icon-dot" aria-hidden="true">
              <Sliders size={18} />
            </span>
            <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 600, letterSpacing: '-0.015em' }}>Estudio de Stems</h2>
          </div>
          <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: colors.muted, maxWidth: '72ch' }}>
            Carga los stems de una canción (ZIP de Moises o archivos sueltos) y estúdialos en casa: mute, solo y repetir una sección.
            {target
              ? ' Se guardan en este navegador y en la nube de la banda, de donde los descargan los demás integrantes y el líder.'
              : ' Los archivos quedan solo en este navegador.'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {usage && (
            <div
              data-testid="stem-storage"
              title="Espacio usado por el hub en este navegador"
              className="ga-chip"
              style={{ height: '34px', padding: '0 12px', color: colors.muted, fontWeight: 500 }}
            >
              <HardDrive size={13} /> {formatBytes(usage.usage)} de {formatBytes(usage.quota)}
            </div>
          )}
        </div>
      </div>

      {listError && (
        <div role="alert" className="ga-alert">
          {listError}
        </div>
      )}

      {songs.length === 0 ? (
        <div className="ga-panel" style={{ padding: '32px 16px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
          La librería de esta banda está vacía. Crea la canción en CANCIONES y vuelve aquí para cargar sus stems.
        </div>
      ) : (
        <div className="ga-panel" data-tight="true" style={{ flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap' }}>
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
                setActiveSongId(e.target.value)
                setImporting(false)
              }}
              style={{ ...smallInputStyle, width: '100%', marginTop: '4px', padding: '8px 12px', fontSize: '13px' }}
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
              <button type="button" className="ga-pill" data-tone="accent" onClick={() => setImporting((v) => !v)} aria-expanded={importing}>
                <Upload size={13} /> {importing ? 'CERRAR IMPORTACIÓN' : 'IMPORTAR MÁS'}
              </button>
              <button
                type="button"
                className="ga-pill"
                data-tone="danger-ghost"
                data-testid="stem-delete-song"
                onClick={() =>
                  setDeleting({
                    songId: selectedSong.id,
                    title: selectedSong.title,
                    local: true,
                    cloud: songCloud && canEditCloud && !!cloudManifest,
                  })
                }
              >
                <Trash2 size={13} /> BORRAR STEMS
              </button>
            </div>
          )}
        </div>
      )}

      {records === null && songs.length > 0 && <div style={{ fontFamily: mono, fontSize: '12px', color: colors.muted }}>LEYENDO STEMS GUARDADOS...</div>}

      {songCloud && selectedSong && records !== null && (
        <StemCloudBar
          state={cloudState}
          hasLocal={!!record}
          inSync={inSync}
          canEdit={canEditCloud}
          leaderUnplayable={leaderUnplayable}
          onUpload={() => void uploadSong(selectedSong.id, cloudManifest)}
          onDownload={() => void downloadSong(selectedSong.id, cloudManifest)}
          onRetry={() => {
            setCloud(cloudKey(selectedSong.id), null)
            checkCloud(selectedSong.id)
          }}
          onDeleteCloud={() => setDeleting({ songId: selectedSong.id, title: selectedSong.title, local: false, cloud: true })}
        />
      )}

      {showImporter && selectedSong && (
        <StemImporter
          key={selectedSong.id}
          song={selectedSong}
          existingLabels={record?.tracks.map((t) => t.label) ?? []}
          cloudNote={importerCloudNote}
          onSaved={(next) => {
            setRecord(selectedSong.id, next)
            setImporting(false)
            if (songCloud && canEditCloud) void uploadSong(selectedSong.id, cloudManifest)
          }}
          onCancel={record ? () => setImporting(false) : undefined}
        />
      )}

      {showImporter && selectedSong && songCloud && canEditCloud && target && (
        <SplitUpload
          key={`split:${selectedSong.id}`}
          song={selectedSong}
          target={target}
          cloudStemCount={cloudState === undefined ? null : cloudManifest ? cloudManifest.stems.length : 0}
          hasLocal={!!record}
          // Sin stems en este equipo, la cola los baja e importa al terminar.
          importLocal={!record}
          hint="¿No tienes los stems? Sube el audio completo y Music AI lo separa en voz, batería, bajo, guitarras, teclados y otros."
          onLocalReplaced={(next) => {
            setRecord(selectedSong.id, next)
            setImporting(false)
          }}
        />
      )}

      {selectedSong && record && <StemStudio key={studioKey} song={selectedSong} record={record} onRecordChange={(next) => setRecord(selectedSong.id, next)} />}

      {orphans.length > 0 && (
        <div className="ga-panel" data-tight="true" style={{ gap: '8px' }}>
          <div style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>STEMS DE CANCIONES QUE NO ESTÁN EN ESTA BANDA (otra banda o canción borrada)</div>
          {orphans.map((r) => (
            <div key={r.songId} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px', color: colors.text }}>
              <span style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>
                {r.tracks.map((t) => t.label).join(', ')} · {formatBytes(r.tracks.reduce((n, t) => n + t.size, 0))}
              </span>
              <button
                type="button"
                className="ga-pill"
                data-size="sm"
                data-tone="danger-ghost"
                onClick={() => setDeleting({ songId: r.songId, title: 'una canción que no está en esta banda', local: true, cloud: false })}
              >
                <Trash2 size={12} /> BORRAR
              </button>
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <HubModal title="BORRAR STEMS" onClose={closeDelete} maxWidth="440px" testId="stem-delete-confirm">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px', color: colors.muted }}>
            <div>
              {deleting.local ? (
                <>
                  ¿Borrar los stems de <strong style={{ color: colors.text }}>{deleting.title}</strong>? La canción sigue en la librería; solo se
                  borran los archivos de audio.
                </>
              ) : (
                <>
                  ¿Borrar de la nube de la banda los stems de <strong style={{ color: colors.text }}>{deleting.title}</strong>? Nadie de la
                  banda los podrá descargar y el líder dejará de tenerlos.
                </>
              )}
            </div>
            {deleting.local && deleting.cloud && (
              <div style={{ fontSize: '12px' }}>Puedes borrarlos solo de este equipo (siguen en la nube para la banda) o también de la nube.</div>
            )}
            {deleteError && (
              <div role="alert" data-testid="stem-delete-error" style={{ color: colors.danger }}>
                {deleteError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
              <button type="button" className="ga-pill" data-tone="ghost" disabled={deleteBusy} onClick={closeDelete}>
                CANCELAR
              </button>
              {deleting.local && (
                <button
                  type="button"
                  className="ga-pill"
                  data-testid="stem-delete-local"
                  data-tone={deleting.cloud ? 'danger-ghost' : 'danger'}
                  disabled={deleteBusy}
                  onClick={() => void confirmDelete(false)}
                >
                  {deleting.cloud ? 'SOLO ESTE EQUIPO' : 'BORRAR'}
                </button>
              )}
              {deleting.cloud && (
                <button type="button" className="ga-pill" data-tone="danger" data-testid="stem-delete-cloud" disabled={deleteBusy} onClick={() => void confirmDelete(true)}>
                  {deleteBusy ? 'BORRANDO...' : deleting.local ? 'ESTE EQUIPO Y LA NUBE' : 'BORRAR DE LA NUBE'}
                </button>
              )}
            </div>
          </div>
        </HubModal>
      )}
    </div>
  )
}
