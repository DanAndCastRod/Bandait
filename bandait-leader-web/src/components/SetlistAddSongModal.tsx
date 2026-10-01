import React, { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import type { Song } from '../types/hub'
import { BPM_MAX, BPM_MIN, formatDuration, songDurationSec } from '../services/workspaceSchema'
import { HubModal } from './HubModal'
import { cardStyle, colors, ghostButton, inputStyle, labelStyle, mono, primaryButton, searchKey } from './hubStyles'

interface Props {
  songs: Song[]
  /** songIds que ya estan en el setlist (solo para marcarlos; se pueden repetir). */
  inSetlist: ReadonlySet<string>
  defaultArtist: string
  onAdd: (song: Song) => void
  /** Crea la cancion en la libreria y la agrega al setlist. */
  onQuickCreate: (data: { title: string; artist: string; bpm: number; key: string }) => void
  onClose: () => void
}

export const SetlistAddSongModal: React.FC<Props> = ({ songs, inSetlist, defaultArtist, onAdd, onQuickCreate, onClose }) => {
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState(defaultArtist)
  const [bpmText, setBpmText] = useState('120')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = searchKey(query)
    const list = q ? songs.filter((s) => searchKey(`${s.title} ${s.artist}`).includes(q)) : songs
    return [...list].sort((a, b) => a.title.localeCompare(b.title, 'es'))
  }, [songs, query])

  const quickCreate = (e: React.FormEvent) => {
    e.preventDefault()
    const bpm = Number(bpmText)
    if (!title.trim()) return setError('Escribe el título.')
    if (!/^\d+(\.\d+)?$/.test(bpmText.trim()) || bpm < BPM_MIN || bpm > BPM_MAX) return setError(`El BPM debe estar entre ${BPM_MIN} y ${BPM_MAX}.`)
    setError(null)
    onQuickCreate({ title: title.trim(), artist: artist.trim(), bpm, key: key.trim() })
    setAdded(title.trim())
    setTitle('')
    setKey('')
  }

  return (
    <HubModal title="AÑADIR CANCIÓN AL SETLIST" onClose={onClose} maxWidth="560px" testId="setlist-add-song">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-40%)', color: colors.muted }} />
          <input
            aria-label="Buscar en la librería"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en la librería de la banda..."
            style={{ ...inputStyle, paddingLeft: '30px' }}
            autoFocus
          />
        </div>

        {added && (
          <div data-testid="setlist-add-feedback" style={{ fontSize: '11px', color: colors.success, fontFamily: mono }}>
            "{added}" se agregó al final del setlist.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '38dvh', overflowY: 'auto', minWidth: 0 }}>
          {songs.length === 0 && (
            <div style={{ fontSize: '12px', color: colors.muted }}>La librería está vacía: crea la canción abajo o en la pestaña CANCIONES.</div>
          )}
          {songs.length > 0 && filtered.length === 0 && <div style={{ fontSize: '12px', color: colors.muted }}>Sin coincidencias.</div>}
          {filtered.map((s) => {
            const dur = songDurationSec(s)
            return (
              <div
                key={s.id}
                data-testid="library-pick"
                style={{ ...cardStyle, padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', minWidth: 0 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '13px', color: colors.text, overflowWrap: 'anywhere' }}>{s.title}</div>
                  <div style={{ fontSize: '11px', color: colors.muted, fontFamily: mono }}>
                    {s.artist ? `${s.artist} · ` : ''}
                    {s.bpm} BPM{s.key ? ` · ${s.key}` : ''}
                    {s.sections.length > 0 ? ` · ${s.sections.length} secc.${dur !== null ? ` ~${formatDuration(dur)}` : ''}` : ' · sin secciones'}
                    {inSetlist.has(s.id) ? ' · ya en el setlist' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onAdd(s)
                    setAdded(s.title)
                  }}
                  aria-label={`Añadir ${s.title}`}
                  style={{ ...primaryButton(), padding: '6px 10px', fontSize: '11px', flexShrink: 0 }}
                >
                  <Plus size={12} /> AÑADIR
                </button>
              </div>
            )
          })}
        </div>

        <form
          onSubmit={quickCreate}
          data-testid="quick-create-song"
          style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div style={{ fontFamily: mono, fontSize: '12px', fontWeight: 700, color: colors.text }}>CREAR CANCIÓN RÁPIDA</div>
          <div style={{ fontSize: '11px', color: colors.muted }}>
            Se crea en la librería sin secciones y se agrega al setlist. Sus secciones y acordes se editan en CANCIONES.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
            <div>
              <label htmlFor="quick-title" style={labelStyle}>
                TÍTULO
              </label>
              <input id="quick-title" value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label htmlFor="quick-artist" style={labelStyle}>
                ARTISTA
              </label>
              <input id="quick-artist" value={artist} onChange={(e) => setArtist(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label htmlFor="quick-bpm" style={labelStyle}>
                BPM
              </label>
              <input id="quick-bpm" inputMode="decimal" value={bpmText} onChange={(e) => setBpmText(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label htmlFor="quick-key" style={labelStyle}>
                TONO
              </label>
              <input id="quick-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Am" style={inputStyle} />
            </div>
          </div>
          {error && <div style={{ color: colors.danger, fontSize: '12px' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
            <button type="button" onClick={onClose} style={{ ...ghostButton, background: 'transparent', color: colors.muted }}>
              CERRAR
            </button>
            <button type="submit" style={primaryButton(colors.cobalt)}>
              CREAR Y AÑADIR
            </button>
          </div>
        </form>
      </div>
    </HubModal>
  )
}
