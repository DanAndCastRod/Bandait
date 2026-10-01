import React, { useMemo, useState } from 'react'
import { AlertTriangle, Copy, Library, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import type { Song } from '../types/hub'
import { formatDuration, songDurationSec, totalBars } from '../services/workspaceSchema'
import { SongEditorModal } from '../components/SongEditorModal'
import { HubModal } from '../components/HubModal'
import {
  cardStyle,
  colors,
  ghostButton,
  headerBarStyle,
  iconButton,
  inputStyle,
  mono,
  primaryButton,
  searchKey,
  viewStyle,
} from '../components/hubStyles'

interface Usage {
  playlistId: string
  playlistName: string
  count: number
}

export const SongsHubView: React.FC = () => {
  const { activeBand, songs, playlists, saveSong, duplicateSong, deleteSong } = useHub()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Song | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Song | null>(null)

  const usageBySong = useMemo(() => {
    const map = new Map<string, Usage[]>()
    for (const pl of playlists) {
      const counts = new Map<string, number>()
      for (const it of pl.songs) counts.set(it.songId, (counts.get(it.songId) ?? 0) + 1)
      for (const [songId, count] of counts) {
        const list = map.get(songId) ?? []
        list.push({ playlistId: pl.id, playlistName: pl.name, count })
        map.set(songId, list)
      }
    }
    return map
  }, [playlists])

  const filtered = useMemo(() => {
    const q = searchKey(query)
    const list = q ? songs.filter((s) => searchKey(`${s.title} ${s.artist} ${s.key}`).includes(q)) : songs
    return [...list].sort((a, b) => a.title.localeCompare(b.title, 'es'))
  }, [songs, query])

  const deletingUsage = deleting ? usageBySong.get(deleting.id) ?? [] : []

  return (
    <div style={viewStyle}>
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Library size={22} style={{ color: colors.violet, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Librería de Canciones</h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted }}>
            Canciones de {activeBand?.name}: secciones en compases, acordes en ChordPro y avisos de voz. El líder las descarga para tocar el
            show.
          </p>
        </div>
        <button type="button" onClick={() => setEditing('new')} style={{ ...primaryButton(), boxShadow: '0 0 12px rgba(255, 69, 0, 0.3)' }}>
          <Plus size={14} /> NUEVA CANCIÓN
        </button>
      </div>

      <div style={{ position: 'relative', maxWidth: '420px', width: '100%' }}>
        <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-40%)', color: colors.muted }} />
        <input
          aria-label="Buscar canción"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por título, artista o tono..."
          style={{ ...inputStyle, paddingLeft: '30px' }}
        />
      </div>

      {songs.length === 0 && (
        <div style={{ ...cardStyle, padding: '32px 16px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
          La librería está vacía. Pulsa [+ NUEVA CANCIÓN] o pega una canción completa en ChordPro.
        </div>
      )}
      {songs.length > 0 && filtered.length === 0 && (
        <div style={{ color: colors.muted, fontSize: '13px' }}>Ninguna canción coincide con "{query}".</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: '12px' }}>
        {filtered.map((song) => {
          const usage = usageBySong.get(song.id) ?? []
          const bars = totalBars(song.sections)
          const dur = songDurationSec(song)
          return (
            <div
              key={song.id}
              data-testid="song-card"
              data-song-title={song.title}
              style={{ ...cardStyle, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '15px', color: colors.text, overflowWrap: 'anywhere' }}>{song.title}</div>
                <div style={{ fontSize: '11px', color: colors.muted, overflowWrap: 'anywhere' }}>{song.artist || 'Sin artista'}</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', fontFamily: mono, fontSize: '11px' }}>
                <span style={{ color: colors.text, fontWeight: 700 }}>{song.bpm} BPM</span>
                <span style={{ color: colors.muted }}>
                  {song.beatsPerBar}/{song.beatUnit}
                </span>
                {song.key && <span style={{ color: colors.cobalt, fontWeight: 700 }}>{song.key}</span>}
                {song.camelot && (
                  <span style={{ background: '#1e293b', border: '1px solid #334155', padding: '0 5px', borderRadius: '3px', color: '#e2e8f0' }}>
                    {song.camelot}
                  </span>
                )}
              </div>
              <div data-testid="song-card-sections" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
                {song.sections.length > 0 ? (
                  <>
                    {song.sections.length} {song.sections.length === 1 ? 'sección' : 'secciones'} · {bars} compases
                    {dur !== null ? ` · ~${formatDuration(dur)}` : ''}
                  </>
                ) : (
                  <span style={{ color: colors.warning, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <AlertTriangle size={12} /> SIN SECCIONES: el líder no conoce su final
                  </span>
                )}
              </div>
              <div style={{ fontSize: '11px', color: usage.length ? colors.success : colors.disabled, fontFamily: mono }}>
                {usage.length ? `En ${usage.length} setlist${usage.length > 1 ? 's' : ''}` : 'Sin setlists'}
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: 'auto', flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setEditing(song)} style={{ ...ghostButton, padding: '6px 10px', fontSize: '11px' }}>
                  <Pencil size={12} /> EDITAR
                </button>
                <button
                  type="button"
                  onClick={() => duplicateSong(song.id)}
                  aria-label={`Duplicar ${song.title}`}
                  style={{ ...ghostButton, padding: '6px 10px', fontSize: '11px' }}
                >
                  <Copy size={12} /> DUPLICAR
                </button>
                <button type="button" onClick={() => setDeleting(song)} aria-label={`Eliminar ${song.title}`} style={iconButton(colors.danger)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {editing && (
        <SongEditorModal
          initial={editing === 'new' ? null : editing}
          defaultArtist={activeBand?.name ?? ''}
          onCancel={() => setEditing(null)}
          onSave={(song) => {
            saveSong(song)
            setEditing(null)
          }}
        />
      )}

      {deleting && (
        <HubModal title="ELIMINAR CANCIÓN" onClose={() => setDeleting(null)} maxWidth="440px" testId="song-delete-confirm">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px', color: colors.muted }}>
            <div>
              ¿Eliminar <strong style={{ color: colors.text }}>{deleting.title}</strong> de la librería de {activeBand?.name}?
            </div>
            {deletingUsage.length > 0 ? (
              <div style={{ border: `1px solid ${colors.warning}`, borderRadius: '4px', padding: '10px', color: colors.warning }}>
                <div style={{ fontWeight: 700, marginBottom: '6px' }}>Está en {deletingUsage.length} setlist(s); se quitará de:</div>
                <ul data-testid="song-delete-usage" style={{ margin: 0, paddingLeft: '18px' }}>
                  {deletingUsage.map((u) => (
                    <li key={u.playlistId}>
                      {u.playlistName}
                      {u.count > 1 ? ` (${u.count} veces)` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div>No está en ningún setlist.</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setDeleting(null)} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
                CANCELAR
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteSong(deleting.id)
                  setDeleting(null)
                }}
                style={primaryButton(colors.danger)}
              >
                {deletingUsage.length > 0 ? 'ELIMINAR Y QUITAR DE LOS SETLISTS' : 'ELIMINAR'}
              </button>
            </div>
          </div>
        </HubModal>
      )}
    </div>
  )
}
