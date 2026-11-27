import React, { useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeftRight, Check, Music2 } from 'lucide-react'
import { useHub } from '../../context/hubContextCore'
import { HubModal } from '../HubModal'
import { sessionToNewSong, studioToSongPatch } from '../../services/studio/songStudioBridge'
import type { StudioSession } from '../../services/studio/session'
import { playlistItemFromSong } from '../../services/workspaceSchema'
import type { Playlist, Song } from '../../types/hub'
import type { StudioController } from './studioState'

interface Props {
  controller: StudioController
  session: StudioSession
  /** Cancion ligada a la sesion; sin ella el dialogo ofrece promover la maqueta. */
  song: Song | undefined
  playlists: readonly Playlist[]
  onClose: () => void
}

/**
 * Puente Cancion <-> Estudio. Se monta solo con el dialogo abierto, asi que la vista previa
 * (studioToSongPatch) no se recalcula con cada cambio de la sesion mientras esta cerrado.
 * Sobrescribir la ficha guarda antes una version de la cancion (control de versiones de la
 * Libreria), y si se van secciones con letra hay que confirmarlo de forma explicita.
 */
export const StudioSongBridgeDialog: React.FC<Props> = ({ controller, session, song, playlists, onClose }) => {
  const { sharing, saveSong, commitSongVersion, addSongToPlaylistById, setActiveSongId } = useHub()
  const [promoteArtist, setPromoteArtist] = useState('')
  const [promotePlaylistId, setPromotePlaylistId] = useState('')
  const [lyricsAck, setLyricsAck] = useState(false)
  const canEdit = sharing.activeCanEdit

  const preview = useMemo(() => (song ? studioToSongPatch(song, session) : null), [song, session])
  const needsLyricsAck = !!preview && preview.lyricsRemoved.length > 0

  const applyStudioToSong = () => {
    if (!song || !preview || !canEdit || !preview.changed) return
    if (needsLyricsAck && !lyricsAck) return
    // Version de la ficha tal como esta, para poder volver a ella desde VERSIONES de la cancion.
    commitSongVersion(song.id, 'Antes de sincronizar desde el Estudio')
    saveSong(preview.updatedSong)
    onClose()
    controller.notify('info', `Ficha de «${preview.updatedSong.title}» actualizada con el arreglo del Estudio (versión anterior guardada).`)
  }

  const importFromSong = () => {
    if (!song) return
    controller.syncStructureFromSong(song)
    onClose()
  }

  const promoteFreeDemo = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canEdit) return
    const created = sessionToNewSong(session, { artist: promoteArtist.trim() })
    saveSong(created)
    const target = promotePlaylistId ? playlists.find((p) => p.id === promotePlaylistId) : undefined
    // Al setlist elegido por id: el setlist activo no cambia.
    if (target) addSongToPlaylistById(target.id, playlistItemFromSong(created))
    controller.linkSongId(created.id)
    setActiveSongId(created.id)
    onClose()
    controller.notify(
      'info',
      target
        ? `Maqueta promovida a canción oficial: «${created.title}», agregada a «${target.name}».`
        : `Maqueta promovida a canción oficial: «${created.title}».`
    )
  }

  return (
    <HubModal
      title={song ? 'PUENTE ESTUDIO <-> CANCIÓN' : 'PROMOVER MAQUETA A CANCIÓN'}
      onClose={onClose}
      maxWidth="540px"
      testId="studio-song-bridge-modal"
    >
      <div className="stu" style={{ padding: 0 }}>
        {song && preview ? (
          <>
            <div className="stu-section">
              <span className="stu-label">Sincronizar hacia Librería ({song.title})</span>
              <p className="stu-help">
                Envía tempo, compás, tonalidad, duración, marcadores de sección y acordes del Estudio a la ficha oficial de la canción. Las secciones que
                siguen teniendo marcador conservan su letra; antes de sobrescribir se guarda una versión de la ficha.
              </p>
              <div className="stu-result" data-testid="studio-bridge-diff">
                <strong>VISTA PREVIA DE CAMBIOS</strong>
                {preview.summary.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    {preview.summary.map((line) => (
                      <li key={line} data-testid="studio-bridge-diff-line">
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Sin cambios: la ficha ya coincide con el Estudio.</p>
                )}
              </div>
              {needsLyricsAck && (
                <div className="stu-confirm" role="alert" data-testid="studio-bridge-lyrics-warning">
                  <p style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <span>
                      Estas secciones no tienen marcador en el Estudio y se eliminarán de la ficha con su letra:{' '}
                      <strong>{preview.lyricsRemoved.map((s) => s.label).join(', ')}</strong>. Para conservarlas, añade su marcador en la
                      línea de tiempo antes de sincronizar.
                    </span>
                  </p>
                  <label className="stu-check">
                    <input
                      type="checkbox"
                      checked={lyricsAck}
                      onChange={(e) => setLyricsAck(e.target.checked)}
                      data-testid="studio-bridge-lyrics-ack"
                    />
                    <span>Entiendo: eliminar esas secciones (la versión anterior queda guardada).</span>
                  </label>
                </div>
              )}
              <div className="stu-actions" data-align="end">
                <button
                  type="button"
                  className="stu-btn"
                  data-tone="primary"
                  disabled={!canEdit || !preview.changed || (needsLyricsAck && !lyricsAck)}
                  onClick={applyStudioToSong}
                  data-testid="studio-bridge-push-song"
                >
                  <Check size={13} />
                  ACTUALIZAR FICHA DE CANCIÓN
                </button>
              </div>
              {!canEdit && <p className="stu-help">Solo Owner o Director Musical pueden sobrescribir la ficha oficial del repertorio.</p>}
            </div>
            <div className="stu-section">
              <span className="stu-label">Traer estructura desde Librería al Estudio</span>
              <p className="stu-help">
                Importa las {song.sections.length} secciones y acordes ChordPro actuales de «{song.title}» como marcadores y pista armónica en esta sesión
                (con opción de Deshacer).
              </p>
              <div className="stu-actions" data-align="end">
                <button type="button" className="stu-btn" onClick={importFromSong} data-testid="studio-bridge-pull-song">
                  <ArrowLeftRight size={13} />
                  IMPORTAR DESDE CANCIÓN
                </button>
              </div>
            </div>
          </>
        ) : (
          <form className="stu-section" onSubmit={promoteFreeDemo}>
            <span className="stu-label">Promover Maqueta Libre al Repertorio</span>
            <p className="stu-help">
              Crea una canción oficial en la Librería heredando título ({session.title}), {session.bpm} BPM, tonalidad ({session.key || 'C'}), marcadores
              como secciones y acordes como ChordPro.
            </p>
            <label className="stu-form-row">
              <span className="stu-label">Artista / Autor (opcional)</span>
              <input className="stu-field" value={promoteArtist} onChange={(e) => setPromoteArtist(e.target.value)} placeholder="Nombre de la banda o compositor" />
            </label>
            {playlists.length > 0 && (
              <label className="stu-form-row">
                <span className="stu-label">Agregar también a Setlist (opcional)</span>
                <select
                  className="stu-field"
                  value={promotePlaylistId}
                  onChange={(e) => setPromotePlaylistId(e.target.value)}
                  data-testid="studio-bridge-promote-playlist"
                >
                  <option value="">No agregar a ningún setlist por ahora</option>
                  {playlists.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" onClick={onClose}>
                CANCELAR
              </button>
              <button type="submit" className="stu-btn" data-tone="primary" disabled={!canEdit} data-testid="studio-bridge-promote">
                <Music2 size={13} />
                CREAR CANCIÓN OFICIAL
              </button>
            </div>
            {!canEdit && <p className="stu-help">Solo Owner o Director Musical pueden crear canciones oficiales en una banda compartida.</p>}
          </form>
        )}
      </div>
    </HubModal>
  )
}
