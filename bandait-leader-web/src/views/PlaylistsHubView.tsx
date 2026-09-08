import React, { useState } from 'react'
import { useHub } from '../context/HubContext'
import type { TransitionMode } from '../types/hub'
import {
  ListMusic,
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
  Clock,
  Music,
  Radio,
} from 'lucide-react'

export const PlaylistsHubView: React.FC = () => {
  const {
    activeBand,
    playlists,
    activePlaylist,
    createPlaylist,
    setActivePlaylist,
    updatePlaylistSong,
    reorderSongs,
    addSongToPlaylist,
    removeSongFromPlaylist,
  } = useHub()

  const [showAddSongModal, setShowAddSongModal] = useState(false)
  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')

  // Form for new song
  const [songTitle, setSongTitle] = useState('')
  const [songArtist, setSongArtist] = useState(activeBand?.name || '')
  const [songBpm, setSongBpm] = useState(120)
  const [songKey, setSongKey] = useState('Am')
  const [songShowKey, setSongShowKey] = useState('Am')
  const [songCamelot, setSongCamelot] = useState('8A')
  const [songDuration, setSongDuration] = useState(210) // 3m 30s
  const [songMode, setSongMode] = useState<TransitionMode>('manual_cue')
  const [songNotes, setSongNotes] = useState('')

  const totalDurationSec = activePlaylist?.songs.reduce((acc, s) => acc + s.durationSec, 0) || 0
  const hours = Math.floor(totalDurationSec / 3600)
  const minutes = Math.floor((totalDurationSec % 3600) / 60)
  const seconds = totalDurationSec % 60
  const formattedDuration = `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`

  const handleCreateNewPlaylist = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPlaylistName.trim()) return
    createPlaylist(newPlaylistName.trim(), 'Setlist programado en el Web Hub')
    setNewPlaylistName('')
    setShowNewPlaylistModal(false)
  }

  const handleAddSong = (e: React.FormEvent) => {
    e.preventDefault()
    if (!songTitle.trim()) return

    addSongToPlaylist({
      title: songTitle.trim(),
      artist: songArtist.trim() || activeBand?.name || 'Bandait',
      bpm: Number(songBpm),
      key: songKey,
      showKey: songShowKey,
      camelot: songCamelot,
      durationSec: Number(songDuration),
      transitionMode: songMode,
      countInBars: songMode === 'auto_count_in' ? 1 : 2,
      notes: songNotes.trim(),
    })

    setSongTitle('')
    setSongNotes('')
    setShowAddSongModal(false)
  }

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* HEADER BAR */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          borderBottom: '1px solid #2a3346',
          paddingBottom: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ListMusic size={22} style={{ color: '#ff4500' }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              Programación de Setlists & Transiciones
            </h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
            Define el repertorio para {activeBand?.name}, asigna transiciones continuas y notas de escenario.
          </p>
        </div>

        {/* SETLIST SELECTOR & STATS */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {playlists.length > 0 && (
            <select
              value={activePlaylist?.id || ''}
              onChange={(e) => {
                const found = playlists.find((p) => p.id === e.target.value)
                if (found) setActivePlaylist(found)
              }}
              style={{
                background: '#1a202c',
                border: '1px solid #2a3346',
                borderRadius: '4px',
                padding: '8px 12px',
                color: '#ffffff',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '12px',
                fontWeight: 700,
                outline: 'none',
              }}
            >
              {playlists.map((pl) => (
                <option key={pl.id} value={pl.id}>
                  {pl.name} ({pl.songs.length} temas)
                </option>
              ))}
            </select>
          )}

          <button
            onClick={() => setShowNewPlaylistModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: '#1a202c',
              border: '1px solid #2a3346',
              borderRadius: '4px',
              padding: '8px 14px',
              color: '#ffffff',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
              cursor: 'pointer',
            }}
          >
            <Plus size={14} />
            <span>NUEVO SETLIST</span>
          </button>

          <button
            onClick={() => setShowAddSongModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: '#ff4500',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 16px',
              color: '#ffffff',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 0 12px rgba(255, 69, 0, 0.3)',
            }}
          >
            <Plus size={14} />
            <span>AÑADIR CANCIÓN</span>
          </button>
        </div>
      </div>

      {/* METRIC STRIP */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '12px',
        }}
      >
        <div style={{ background: '#131720', border: '1px solid #2a3346', borderRadius: '6px', padding: '12px 16px' }}>
          <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
            DURACIÓN ESTIMADA DEL SHOW
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <Clock size={18} style={{ color: '#0066ff' }} />
            <span style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'IBM Plex Mono', monospace" }}>
              {formattedDuration}
            </span>
          </div>
        </div>

        <div style={{ background: '#131720', border: '1px solid #2a3346', borderRadius: '6px', padding: '12px 16px' }}>
          <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
            TOTAL CANCIONES PROGRAMADAS
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <Music size={18} style={{ color: '#ff4500' }} />
            <span style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'IBM Plex Mono', monospace" }}>
              {activePlaylist?.songs.length || 0} TEMAS
            </span>
          </div>
        </div>

        <div style={{ background: '#131720', border: '1px solid #2a3346', borderRadius: '6px', padding: '12px 16px' }}>
          <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
            SINCRONIZACIÓN CON ESCENARIO
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <Radio size={18} style={{ color: '#10b981' }} />
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#10b981', fontFamily: "'IBM Plex Mono', monospace" }}>
              LISTO // REPOSITORIO ACTIVO
            </span>
          </div>
        </div>
      </div>

      {/* SONGS REORDERABLE TABLE */}
      <div
        className="touch-scroll-x"
        style={{
          background: '#131720',
          border: '1px solid #2a3346',
          borderRadius: '6px',
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid #2a3346',
                background: '#1a202c',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '10px',
                color: '#94a3b8',
                letterSpacing: '1px',
              }}
            >
              <th style={{ padding: '12px 14px', width: '50px' }}>ORDEN</th>
              <th style={{ padding: '12px 14px' }}>TÍTULO & ARTISTA</th>
              <th style={{ padding: '12px 14px' }}>TEMPO</th>
              <th style={{ padding: '12px 14px' }}>TONO SHOW (CAMELOT)</th>
              <th style={{ padding: '12px 14px' }}>MODO TRANSICIÓN</th>
              <th style={{ padding: '12px 14px' }}>DURACIÓN</th>
              <th style={{ padding: '12px 14px' }}>NOTAS DEL DIRECTOR</th>
              <th style={{ padding: '12px 14px', textAlign: 'right', width: '120px' }}>ACCIONES</th>
            </tr>
          </thead>
          <tbody>
            {!activePlaylist || activePlaylist.songs.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                  No hay canciones en este setlist. Pulsa [+ AÑADIR CANCIÓN] para comenzar la programación.
                </td>
              </tr>
            ) : (
              activePlaylist.songs.map((song, index) => {
                const isFirst = index === 0
                const isLast = index === activePlaylist.songs.length - 1
                const minutes = Math.floor(song.durationSec / 60)
                const secs = String(song.durationSec % 60).padStart(2, '0')

                return (
                  <tr
                    key={song.id}
                    style={{
                      borderBottom: '1px solid #1f2737',
                      background: index % 2 === 0 ? '#131720' : '#11141c',
                      transition: 'background 0.15s',
                    }}
                  >
                    {/* ORDER # */}
                    <td style={{ padding: '12px 14px', fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>
                      <span style={{ color: '#ff4500' }}>#{String(song.orderIndex).padStart(2, '0')}</span>
                    </td>

                    {/* TITLE */}
                    <td style={{ padding: '12px 14px' }}>
                      <div style={{ fontWeight: 700, fontSize: '14px', color: '#ffffff' }}>{song.title}</div>
                      <div style={{ fontSize: '11px', color: '#94a3b8' }}>{song.artist}</div>
                    </td>

                    {/* BPM */}
                    <td style={{ padding: '12px 14px', fontFamily: "'IBM Plex Mono', monospace", fontSize: '13px' }}>
                      <span style={{ fontWeight: 700, color: '#ffffff' }}>{song.bpm}</span>{' '}
                      <span style={{ fontSize: '10px', color: '#94a3b8' }}>BPM</span>
                    </td>

                    {/* KEY & CAMELOT */}
                    <td style={{ padding: '12px 14px', fontFamily: "'IBM Plex Mono', monospace" }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 700, color: '#0066ff' }}>{song.showKey}</span>
                        {song.key !== song.showKey && (
                          <span style={{ fontSize: '10px', color: '#94a3b8', textDecoration: 'line-through' }}>
                            {song.key}
                          </span>
                        )}
                        <span
                          style={{
                            background: '#1e293b',
                            border: '1px solid #334155',
                            padding: '1px 6px',
                            borderRadius: '3px',
                            fontSize: '10px',
                            color: '#e2e8f0',
                          }}
                        >
                          {song.camelot}
                        </span>
                      </div>
                    </td>

                    {/* TRANSITION MODE */}
                    <td style={{ padding: '12px 14px' }}>
                      <select
                        value={song.transitionMode}
                        onChange={(e) =>
                          updatePlaylistSong(song.id, { transitionMode: e.target.value as TransitionMode })
                        }
                        style={{
                          background: '#1a202c',
                          border: '1px solid #2a3346',
                          borderRadius: '4px',
                          padding: '4px 8px',
                          color:
                            song.transitionMode === 'manual_cue'
                              ? '#f59e0b'
                              : song.transitionMode === 'auto_count_in'
                              ? '#10b981'
                              : '#0066ff',
                          fontFamily: "'IBM Plex Mono', monospace",
                          fontSize: '11px',
                          fontWeight: 700,
                          outline: 'none',
                        }}
                      >
                        <option value="manual_cue">[MANUAL CUE]</option>
                        <option value="auto_count_in">[AUTO CONTEO]</option>
                        <option value="gapless">[GAPLESS / CONTINUO]</option>
                      </select>
                    </td>

                    {/* DURATION */}
                    <td style={{ padding: '12px 14px', fontFamily: "'IBM Plex Mono', monospace", fontSize: '12px' }}>
                      {minutes}:{secs}
                    </td>

                    {/* NOTES */}
                    <td style={{ padding: '12px 14px', fontSize: '12px', color: '#94a3b8', maxWidth: '220px' }}>
                      <input
                        type="text"
                        value={song.notes || ''}
                        onChange={(e) => updatePlaylistSong(song.id, { notes: e.target.value })}
                        placeholder="Nota técnica..."
                        style={{
                          width: '100%',
                          background: 'transparent',
                          border: '1px solid transparent',
                          borderRadius: '3px',
                          padding: '4px 6px',
                          color: '#cbd5e1',
                          fontSize: '11px',
                        }}
                        onFocus={(e) => (e.currentTarget.style.borderColor = '#2a3346')}
                        onBlur={(e) => (e.currentTarget.style.borderColor = 'transparent')}
                      />
                    </td>

                    {/* ACTIONS */}
                    <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '4px' }}>
                        <button
                          disabled={isFirst}
                          onClick={() => reorderSongs(index, index - 1)}
                          title="Mover arriba"
                          style={{
                            background: '#1a202c',
                            border: '1px solid #2a3346',
                            color: isFirst ? '#475569' : '#ffffff',
                            borderRadius: '3px',
                            padding: '4px 6px',
                            cursor: isFirst ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <ArrowUp size={13} />
                        </button>

                        <button
                          disabled={isLast}
                          onClick={() => reorderSongs(index, index + 1)}
                          title="Mover abajo"
                          style={{
                            background: '#1a202c',
                            border: '1px solid #2a3346',
                            color: isLast ? '#475569' : '#ffffff',
                            borderRadius: '3px',
                            padding: '4px 6px',
                            cursor: isLast ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <ArrowDown size={13} />
                        </button>

                        <button
                          onClick={() => removeSongFromPlaylist(song.id)}
                          title="Eliminar del setlist"
                          style={{
                            background: '#1a202c',
                            border: '1px solid #2a3346',
                            color: '#ef4444',
                            borderRadius: '3px',
                            padding: '4px 6px',
                            cursor: 'pointer',
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ADD SONG MODAL */}
      {showAddSongModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: '#161b26',
              border: '1px solid #2a3346',
              borderRadius: '8px',
              padding: 'clamp(16px, 4vw, 24px)',
              width: '100%',
              maxWidth: '500px',
              maxHeight: '90dvh',
              overflowY: 'auto',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.7)',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontFamily: "'IBM Plex Mono', monospace", fontSize: '16px' }}>
              AGREGAR CANCIÓN AL SETLIST
            </h3>

            <form onSubmit={handleAddSong} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  TÍTULO DE LA CANCIÓN
                </label>
                <input
                  type="text"
                  value={songTitle}
                  onChange={(e) => setSongTitle(e.target.value)}
                  placeholder="Ej: Fuego en Tarima"
                  required
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  ARTISTA / AUTOR
                </label>
                <input
                  type="text"
                  value={songArtist}
                  onChange={(e) => setSongArtist(e.target.value)}
                  placeholder="Ej: Los Inquietos del Rock"
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    TEMPO (BPM)
                  </label>
                  <input
                    type="number"
                    value={songBpm}
                    onChange={(e) => setSongBpm(parseInt(e.target.value) || 120)}
                    required
                    style={{
                      width: '100%',
                      background: '#0d1017',
                      border: '1px solid #2a3346',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      color: '#ffffff',
                      marginTop: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    DURACIÓN (SEGUNDOS)
                  </label>
                  <input
                    type="number"
                    value={songDuration}
                    onChange={(e) => setSongDuration(parseInt(e.target.value) || 180)}
                    required
                    style={{
                      width: '100%',
                      background: '#0d1017',
                      border: '1px solid #2a3346',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      color: '#ffffff',
                      marginTop: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    TONO ORIG.
                  </label>
                  <input
                    type="text"
                    value={songKey}
                    onChange={(e) => setSongKey(e.target.value)}
                    style={{
                      width: '100%',
                      background: '#0d1017',
                      border: '1px solid #2a3346',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      color: '#ffffff',
                      marginTop: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    TONO SHOW
                  </label>
                  <input
                    type="text"
                    value={songShowKey}
                    onChange={(e) => setSongShowKey(e.target.value)}
                    style={{
                      width: '100%',
                      background: '#0d1017',
                      border: '1px solid #2a3346',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      color: '#ffffff',
                      marginTop: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    CAMELOT
                  </label>
                  <input
                    type="text"
                    value={songCamelot}
                    onChange={(e) => setSongCamelot(e.target.value)}
                    placeholder="8A"
                    style={{
                      width: '100%',
                      background: '#0d1017',
                      border: '1px solid #2a3346',
                      borderRadius: '4px',
                      padding: '8px 10px',
                      color: '#ffffff',
                      marginTop: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  MODO DE TRANSICIÓN
                </label>
                <select
                  value={songMode}
                  onChange={(e) => setSongMode(e.target.value as TransitionMode)}
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="manual_cue">Manual Cue (Pausa / Espera orden del director)</option>
                  <option value="auto_count_in">Auto Conteo (4 pulsos de clic sincronizado)</option>
                  <option value="gapless">Gapless (Entrada inmediata sin pausa)</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  NOTAS TÉCNICAS PARA EL SHOW
                </label>
                <input
                  type="text"
                  value={songNotes}
                  onChange={(e) => setSongNotes(e.target.value)}
                  placeholder="Ej: Silencio al final, solo de guitarra..."
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  onClick={() => setShowAddSongModal(false)}
                  style={{
                    background: 'transparent',
                    border: '1px solid #2a3346',
                    color: '#94a3b8',
                    padding: '8px 16px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: '#ff4500',
                    border: 'none',
                    color: '#ffffff',
                    padding: '8px 20px',
                    borderRadius: '4px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  GUARDAR CANCIÓN
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE NEW PLAYLIST MODAL */}
      {showNewPlaylistModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: '#161b26',
              border: '1px solid #2a3346',
              borderRadius: '8px',
              padding: 'clamp(16px, 4vw, 24px)',
              width: '100%',
              maxWidth: '420px',
              maxHeight: '90dvh',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontFamily: "'IBM Plex Mono', monospace", fontSize: '16px' }}>
              NUEVO SETLIST PARA {activeBand?.name.toUpperCase()}
            </h3>
            <form onSubmit={handleCreateNewPlaylist} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  NOMBRE DEL SETLIST
                </label>
                <input
                  type="text"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  placeholder="Ej: Acústico Teatros 2026"
                  required
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowNewPlaylistModal(false)}
                  style={{
                    background: 'transparent',
                    border: '1px solid #2a3346',
                    color: '#94a3b8',
                    padding: '8px 16px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: '#0066ff',
                    border: 'none',
                    color: '#ffffff',
                    padding: '8px 20px',
                    borderRadius: '4px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  CREAR SETLIST
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
