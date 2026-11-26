import React, { useMemo, useState } from 'react'
import { useHub } from '../context/hubContextCore'
import type { PlaylistSong, Song, TransitionMode } from '../types/hub'
import {
  BPM_MAX,
  BPM_MIN,
  COUNT_IN_BARS_MAX,
  GAP_SEC_MAX,
  TRANSITION_EXPLANATIONS,
  TRANSITION_LABELS,
  TRANSITION_MODES,
  formatDuration,
  playlistItemFromSong,
  songDurationSec,
  totalBars,
  transitionEntryNotice,
} from '../services/workspaceSchema'
import { SetlistAddSongModal } from '../components/SetlistAddSongModal'
import { CommitInput } from '../components/CommitInput'
import { colors, mono } from '../components/hubStyles'
import { ListMusic, Plus, ArrowUp, ArrowDown, Trash2, Clock, Music, Radio, AlertTriangle, Info, Copy, Lock } from 'lucide-react'

const MODE_COLOR: Record<TransitionMode, string> = {
  manual_cue: colors.warning,
  auto_count_in: colors.success,
  gapless: colors.cobalt,
}

/** Duracion del tema en el show: por compases (con el BPM del show) si la cancion tiene secciones. */
function itemDuration(item: PlaylistSong, song: Song | undefined): { sec: number; byBars: boolean } {
  const byBars = song ? songDurationSec(song, item.bpm) : null
  return byBars !== null ? { sec: byBars, byBars: true } : { sec: item.durationSec || 0, byBars: false }
}

export const PlaylistsHubView: React.FC = () => {
  const {
    activeBand,
    playlists,
    activePlaylist,
    songs,
    createPlaylist,
    setActivePlaylist,
    updatePlaylistSong,
    reorderSongs,
    addSongToPlaylist,
    removeSongFromPlaylist,
    createSong,
    bands,
    sharing,
    copyPlaylistToBand,
    deletePlaylist,
  } = useHub()

  const [showAddSongModal, setShowAddSongModal] = useState(false)
  const [showCopy, setShowCopy] = useState(false)
  const [copyTarget, setCopyTarget] = useState('')
  const [copyResult, setCopyResult] = useState<{ ok: boolean; message: string } | null>(null)
  const copyTargets = bands.filter((b) => b.id !== activeBand?.id && sharing.editableBandIds.includes(b.id))
  const [deleteMessage, setDeleteMessage] = useState<{ ok: boolean; message: string } | null>(null)
  const handleDeletePlaylist = () => {
    if (!activePlaylist) return
    if (!window.confirm(`¿Borrar el setlist "${activePlaylist.name}"? Las canciones siguen en la librería.`)) return
    setDeleteMessage(deletePlaylist(activePlaylist.id))
  }
  const handleCopy = () => {
    if (!activePlaylist) return
    const target = copyTarget || copyTargets[0]?.id
    if (!target) return
    setCopyResult(copyPlaylistToBand(activePlaylist.id, target))
  }
  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')

  const songsById = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs])
  const items = activePlaylist?.songs ?? []

  const totalDurationSec = items.reduce((acc, item) => {
    const song = songsById.get(item.songId)
    let sec = itemDuration(item, song).sec
    if (item.transitionMode !== 'gapless' && item.bpm > 0) sec += (item.countInBars * (song?.beatsPerBar ?? 4) * 60) / item.bpm
    if (item.transitionMode === 'auto_count_in') sec += item.gapSec || 0
    return acc + sec
  }, 0)
  const totalRounded = Math.round(totalDurationSec)
  const hours = Math.floor(totalRounded / 3600)
  const minutes = Math.floor((totalRounded % 3600) / 60)
  const seconds = totalRounded % 60
  const formattedDuration = `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`

  const handleCreateNewPlaylist = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPlaylistName.trim()) return
    createPlaylist(newPlaylistName.trim(), 'Setlist programado en el Web Hub')
    setNewPlaylistName('')
    setShowNewPlaylistModal(false)
  }

  const addFromLibrary = (song: Song) => {
    addSongToPlaylist(playlistItemFromSong(song))
  }

  const quickCreate = (data: { title: string; artist: string; bpm: number; key: string }) => {
    const song = createSong({ ...data, beatsPerBar: 4, beatUnit: 4, sections: [] })
    if (song) addSongToPlaylist(playlistItemFromSong(song))
  }

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 }}>
      {/* HEADER BAR */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          borderBottom: 'none',
          paddingBottom: '4px',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ListMusic size={22} style={{ color: 'var(--b-accent)', flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              Programación de Setlists & Transiciones
            </h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--b-muted)' }}>
            Define el repertorio para {activeBand?.name} con canciones de la librería: BPM y tono del show, transiciones y conteos.
          </p>
        </div>

        {/* SETLIST SELECTOR & STATS */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', minWidth: 0 }}>
          {playlists.length > 0 && (
            <select
              aria-label="Setlist activo"
              value={activePlaylist?.id || ''}
              onChange={(e) => {
                const found = playlists.find((p) => p.id === e.target.value)
                if (found) setActivePlaylist(found)
              }}
              style={{
                background: 'var(--b-elevated)',
                border: '1px solid var(--b-border)',
                borderRadius: 'var(--b-radius-field)',
                padding: '8px 12px',
                color: 'var(--b-text)',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '12px',
                fontWeight: 700,
                outlineOffset: '1px',
                maxWidth: '100%',
                minWidth: 0,
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
              background: 'var(--b-elevated)',
              border: '1px solid transparent',
              borderRadius: 'var(--b-radius-field)',
              padding: '8px 14px',
              color: 'var(--b-text)',
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
            disabled={!activePlaylist}
            title={activePlaylist ? undefined : 'Crea primero un setlist'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: activePlaylist ? 'var(--b-accent)' : 'var(--b-disabled)',
              border: 'none',
              borderRadius: 'var(--b-radius-field)',
              padding: '8px 16px',
              color: activePlaylist ? 'var(--b-on-accent)' : 'var(--b-muted)',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontWeight: 700,
              cursor: activePlaylist ? 'pointer' : 'not-allowed',
              boxShadow: activePlaylist ? '0 0 12px color-mix(in srgb, var(--b-accent) 30%, transparent)' : 'none',
            }}
          >
            <Plus size={14} />
            <span>AÑADIR CANCIÓN</span>
          </button>

          <button
            data-testid="copy-setlist-toggle"
            onClick={() => {
              setShowCopy((v) => !v)
              setCopyResult(null)
            }}
            disabled={!activePlaylist}
            title={activePlaylist ? 'Copiar este setlist, con sus canciones, a otra banda' : 'Crea primero un setlist'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'var(--b-elevated)',
              border: '1px solid transparent',
              borderRadius: 'var(--b-radius-field)',
              padding: '8px 14px',
              color: 'var(--b-text)',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
              cursor: activePlaylist ? 'pointer' : 'not-allowed',
              opacity: activePlaylist ? 1 : 0.5,
            }}
          >
            <Copy size={14} />
            <span>COPIAR A OTRA BANDA</span>
          </button>

          <button
            data-testid="delete-setlist"
            onClick={handleDeletePlaylist}
            disabled={!activePlaylist || !sharing.activeCanEdit}
            title={!activePlaylist ? 'No hay setlist' : sharing.activeCanEdit ? 'Borrar este setlist' : 'Tu rol es de solo lectura'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'transparent',
              border: '1px solid color-mix(in srgb, var(--b-danger) 50%, transparent)',
              borderRadius: 'var(--b-radius-field)',
              padding: '8px 14px',
              color: 'var(--b-danger-text)',
              fontSize: '12px',
              fontFamily: "'IBM Plex Mono', monospace",
              cursor: activePlaylist && sharing.activeCanEdit ? 'pointer' : 'not-allowed',
              opacity: activePlaylist && sharing.activeCanEdit ? 1 : 0.5,
            }}
          >
            <Trash2 size={14} />
            <span>BORRAR SETLIST</span>
          </button>
        </div>
      </div>

      {deleteMessage && (
        <div
          role="status"
          data-testid="delete-setlist-result"
          style={{ fontSize: '12px', fontFamily: "'IBM Plex Mono', monospace", color: deleteMessage.ok ? 'var(--b-success)' : 'var(--b-danger-text)' }}
        >
          {deleteMessage.message}
        </div>
      )}

      {!sharing.activeCanEdit && (
        <div
          role="note"
          data-testid="read-only-banner"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'color-mix(in srgb, var(--b-warning) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--b-warning) 40%, transparent)',
            borderRadius: 'var(--b-radius-field)',
            padding: '10px 14px',
            color: 'var(--b-warning-text)',
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <Lock size={14} />
          SOLO LECTURA: en esta banda compartida tu rol no edita. Puedes estudiar el repertorio y copiar setlists a una banda tuya.
        </div>
      )}

      {showCopy && activePlaylist && (
        <div
          data-testid="copy-setlist-panel"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '10px',
            background: 'var(--b-card)',
            border: '1px solid transparent',
            borderRadius: 'var(--b-radius-card)',
            padding: '12px 16px',
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          {copyTargets.length === 0 ? (
            <span style={{ color: 'var(--b-muted)' }}>
              No tienes otra banda donde puedas editar. Crea una banda o pide rol de director en una compartida.
            </span>
          ) : (
            <>
              <label htmlFor="copy-target" style={{ color: 'var(--b-muted)' }}>
                COPIAR "{activePlaylist.name}" A
              </label>
              <select
                id="copy-target"
                value={copyTarget || copyTargets[0].id}
                onChange={(e) => setCopyTarget(e.target.value)}
                style={{
                  background: 'var(--b-input)',
                  border: '1px solid var(--b-border)',
                  borderRadius: 'var(--b-radius-field)',
                  padding: '6px 10px',
                  color: 'var(--b-text)',
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: '12px',
                }}
              >
                {copyTargets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {sharing.sharedBandIds.includes(b.id) ? ' (compartida)' : ''}
                  </option>
                ))}
              </select>
              <button
                data-testid="copy-setlist-confirm"
                onClick={handleCopy}
                style={{
                  background: 'var(--b-cobalt)',
                  border: 'none',
                  borderRadius: 'var(--b-radius-field)',
                  padding: '6px 14px',
                  color: 'var(--b-on-strong)',
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                COPIAR
              </button>
              <span style={{ color: 'var(--b-faint)', flexBasis: '100%' }}>
                Las canciones que ya existan en la banda de destino (mismo título y artista) se reutilizan; las demás se copian.
              </span>
            </>
          )}
          {copyResult && (
            <span role="status" style={{ flexBasis: '100%', color: copyResult.ok ? 'var(--b-success)' : 'var(--b-danger-text)' }}>
              {copyResult.message}
            </span>
          )}
        </div>
      )}

      {/* METRIC STRIP */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
          gap: '12px',
        }}
      >
        <div style={{ background: 'var(--b-card)', border: '1px solid transparent', borderRadius: 'var(--b-radius-card)', padding: '12px 16px' }}>
          <div style={{ fontSize: '11px', color: 'var(--b-muted)', fontFamily: "'IBM Plex Mono', monospace" }}>
            DURACIÓN ESTIMADA DEL SHOW
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <Clock size={18} style={{ color: 'var(--b-cobalt)' }} />
            <span style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'IBM Plex Mono', monospace" }}>{formattedDuration}</span>
          </div>
        </div>

        <div style={{ background: 'var(--b-card)', border: '1px solid transparent', borderRadius: 'var(--b-radius-card)', padding: '12px 16px' }}>
          <div style={{ fontSize: '11px', color: 'var(--b-muted)', fontFamily: "'IBM Plex Mono', monospace" }}>
            TOTAL CANCIONES PROGRAMADAS
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <Music size={18} style={{ color: 'var(--b-accent)' }} />
            <span style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'IBM Plex Mono', monospace" }}>{items.length} TEMAS</span>
          </div>
        </div>

        <div style={{ background: 'var(--b-card)', border: '1px solid transparent', borderRadius: 'var(--b-radius-card)', padding: '12px 16px' }}>
          <div style={{ fontSize: '11px', color: 'var(--b-muted)', fontFamily: "'IBM Plex Mono', monospace" }}>
            SINCRONIZACIÓN CON ESCENARIO
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <Radio size={18} style={{ color: 'var(--b-success)' }} />
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--b-success)', fontFamily: "'IBM Plex Mono', monospace" }}>
              LISTO // REPOSITORIO ACTIVO
            </span>
          </div>
        </div>
      </div>

      {/* SONGS REORDERABLE TABLE (desplazamiento horizontal dentro del recuadro, nunca de la pagina) */}
      <div
        className="touch-scroll-x"
        style={{
          background: 'var(--b-card)',
          border: '1px solid transparent',
          borderRadius: 'var(--b-radius-card)',
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          maxWidth: '100%',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--b-border)',
                background: 'var(--b-elevated)',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '10px',
                color: 'var(--b-muted)',
                letterSpacing: '1px',
              }}
            >
              <th style={{ padding: '12px 14px', width: '50px' }}>ORDEN</th>
              <th style={{ padding: '12px 14px' }}>TÍTULO & ARTISTA</th>
              <th style={{ padding: '12px 14px' }}>BPM SHOW</th>
              <th style={{ padding: '12px 14px' }}>TONO SHOW (CAMELOT)</th>
              <th style={{ padding: '12px 14px', minWidth: '250px' }}>ENTRADA / TRANSICIÓN</th>
              <th style={{ padding: '12px 14px' }}>DURACIÓN</th>
              <th style={{ padding: '12px 14px' }}>NOTAS DEL DIRECTOR</th>
              <th style={{ padding: '12px 14px', textAlign: 'right', width: '120px' }}>ACCIONES</th>
            </tr>
          </thead>
          <tbody>
            {!activePlaylist || items.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: 'var(--b-muted)', fontSize: '13px' }}>
                  No hay canciones en este setlist. Pulsa [+ AÑADIR CANCIÓN] para elegirlas de la librería.
                </td>
              </tr>
            ) : (
              items.map((item, index) => {
                const isFirst = index === 0
                const isLast = index === items.length - 1
                const song = songsById.get(item.songId)
                const prevSong = index > 0 ? songsById.get(items[index - 1].songId) : null
                const notice = transitionEntryNotice(index, item.transitionMode, prevSong)
                const dur = itemDuration(item, song)
                const usesCountIn = item.transitionMode !== 'gapless'

                return (
                  <tr
                    key={item.id}
                    data-testid="setlist-row"
                    data-song-title={item.title}
                    style={{
                      borderBottom: '1px solid var(--b-hover)',
                      background: index % 2 === 0 ? 'var(--b-card)' : 'var(--b-surface)',
                      verticalAlign: 'top',
                    }}
                  >
                    {/* ORDER # */}
                    <td style={{ padding: '12px 14px', fontFamily: mono, fontWeight: 700 }}>
                      <span style={{ color: 'var(--b-accent)' }}>#{String(index + 1).padStart(2, '0')}</span>
                    </td>

                    {/* TITLE + LIBRERIA */}
                    <td style={{ padding: '12px 14px', minWidth: '160px' }}>
                      <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--b-text)' }}>{song?.title ?? item.title}</div>
                      <div style={{ fontSize: '11px', color: 'var(--b-muted)' }}>{song?.artist ?? item.artist}</div>
                      <div style={{ fontSize: '10px', fontFamily: mono, marginTop: '3px' }}>
                        {!song ? (
                          <span style={{ color: colors.danger }}>NO ESTÁ EN LA LIBRERÍA</span>
                        ) : song.sections.length > 0 ? (
                          <span style={{ color: colors.muted }}>
                            {song.sections.length} secc. · {totalBars(song.sections)} compases
                          </span>
                        ) : (
                          <span style={{ color: colors.warning }}>SIN SECCIONES</span>
                        )}
                      </div>
                    </td>

                    {/* BPM DEL SHOW */}
                    <td style={{ padding: '12px 14px', fontFamily: mono, fontSize: '13px', whiteSpace: 'nowrap' }}>
                      <CommitInput
                        ariaLabel={`BPM del show de ${item.title}`}
                        testId="item-bpm"
                        inputMode="decimal"
                        width="60px"
                        value={String(item.bpm)}
                        onCommit={(text) => {
                          const n = Number(text)
                          if (!/^\d+(\.\d+)?$/.test(text.trim()) || n < BPM_MIN || n > BPM_MAX) return false
                          updatePlaylistSong(item.id, { bpm: n })
                          return true
                        }}
                        title={`${BPM_MIN} a ${BPM_MAX}`}
                      />
                      {song && song.bpm !== item.bpm && (
                        <div style={{ fontSize: '10px', color: 'var(--b-muted)', marginTop: '3px' }}>orig. {song.bpm}</div>
                      )}
                    </td>

                    {/* TONO DEL SHOW */}
                    <td style={{ padding: '12px 14px', fontFamily: mono }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <CommitInput
                          ariaLabel={`Tono del show de ${item.title}`}
                          testId="item-showkey"
                          width="54px"
                          value={item.showKey}
                          onCommit={(text) => {
                            updatePlaylistSong(item.id, { showKey: text.trim() })
                            return true
                          }}
                        />
                        {item.camelot && (
                          <span
                            style={{
                              background: 'var(--b-hover)',
                              border: '1px solid var(--b-border-strong)',
                              padding: '1px 6px',
                              borderRadius: 'var(--b-radius-field)',
                              fontSize: '10px',
                              color: 'var(--b-text)',
                            }}
                          >
                            {item.camelot}
                          </span>
                        )}
                      </div>
                      {(song?.key ?? item.key) && (song?.key ?? item.key) !== item.showKey && (
                        <div style={{ fontSize: '10px', color: 'var(--b-muted)', marginTop: '3px' }}>orig. {song?.key ?? item.key}</div>
                      )}
                    </td>

                    {/* TRANSICION, CONTEO Y PAUSA */}
                    <td style={{ padding: '12px 14px', minWidth: '250px', maxWidth: '320px' }}>
                      <select
                        aria-label={`Transición de ${item.title}`}
                        data-testid="item-transition"
                        value={item.transitionMode}
                        onChange={(e) => updatePlaylistSong(item.id, { transitionMode: e.target.value as TransitionMode })}
                        style={{
                          background: 'var(--b-elevated)',
                          border: '1px solid var(--b-border)',
                          borderRadius: 'var(--b-radius-field)',
                          padding: '4px 8px',
                          color: MODE_COLOR[item.transitionMode],
                          fontFamily: mono,
                          fontSize: '11px',
                          fontWeight: 700,
                          outlineOffset: '1px',
                        }}
                      >
                        {TRANSITION_MODES.map((m) => (
                          <option key={m} value={m}>
                            [{TRANSITION_LABELS[m]}]
                          </option>
                        ))}
                      </select>
                      <div data-testid="item-transition-help" style={{ fontSize: '11px', color: 'var(--b-muted)', marginTop: '4px', lineHeight: 1.4 }}>
                        {TRANSITION_EXPLANATIONS[item.transitionMode]}
                      </div>

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', marginTop: '6px', alignItems: 'center', fontSize: '11px', fontFamily: mono, color: 'var(--b-text-soft)' }}>
                        {usesCountIn ? (
                          <>
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              CONTEO
                              <select
                                aria-label={`Compases de conteo de ${item.title}`}
                                data-testid="item-countin"
                                value={item.countInBars}
                                onChange={(e) => updatePlaylistSong(item.id, { countInBars: Number(e.target.value) })}
                                style={{ background: 'var(--b-elevated)', border: '1px solid var(--b-border)', borderRadius: 'var(--b-radius-field)', color: 'var(--b-text)', fontFamily: mono, fontSize: '11px', padding: '2px 4px' }}
                              >
                                {Array.from({ length: COUNT_IN_BARS_MAX + 1 }, (_, n) => (
                                  <option key={n} value={n}>
                                    {n} {n === 1 ? 'compás' : 'compases'}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                aria-label={`Conteo hablado de ${item.title}`}
                                data-testid="item-countin-voice"
                                checked={item.countInVoice}
                                disabled={item.countInBars === 0}
                                onChange={(e) => updatePlaylistSong(item.id, { countInVoice: e.target.checked })}
                                style={{ accentColor: colors.orange }}
                              />
                              VOZ
                            </label>
                          </>
                        ) : (
                          <span style={{ color: 'var(--b-muted)' }}>Sin conteo.</span>
                        )}
                        {item.transitionMode === 'auto_count_in' && (
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            PAUSA
                            <CommitInput
                              ariaLabel={`Pausa en segundos antes de ${item.title}`}
                              testId="item-gap"
                              inputMode="decimal"
                              width="48px"
                              value={String(item.gapSec)}
                              onCommit={(text) => {
                                const n = Number(text.replace(',', '.'))
                                if (text.trim() === '' || !Number.isFinite(n) || n < 0 || n > GAP_SEC_MAX) return false
                                updatePlaylistSong(item.id, { gapSec: n })
                                return true
                              }}
                              title={`0 a ${GAP_SEC_MAX} segundos`}
                            />
                            s
                          </label>
                        )}
                      </div>

                      {notice && (
                        <div
                          data-testid={notice.level === 'warn' ? 'item-transition-warning' : 'item-transition-info'}
                          style={{
                            display: 'flex',
                            gap: '5px',
                            marginTop: '6px',
                            fontSize: '11px',
                            lineHeight: 1.4,
                            color: notice.level === 'warn' ? colors.warning : 'var(--b-muted)',
                          }}
                        >
                          {notice.level === 'warn' ? (
                            <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
                          ) : (
                            <Info size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
                          )}
                          <span>{notice.text}</span>
                        </div>
                      )}
                    </td>

                    {/* DURATION */}
                    <td style={{ padding: '12px 14px', fontFamily: mono, fontSize: '12px', whiteSpace: 'nowrap' }}>
                      {formatDuration(dur.sec)}
                      <div style={{ fontSize: '10px', color: 'var(--b-muted)' }}>{dur.byBars ? 'por compases' : 'estimada'}</div>
                    </td>

                    {/* NOTES */}
                    <td style={{ padding: '12px 14px', fontSize: '12px', color: 'var(--b-muted)', maxWidth: '220px', minWidth: '140px' }}>
                      <input
                        type="text"
                        aria-label={`Notas de ${item.title}`}
                        value={item.notes || ''}
                        onChange={(e) => updatePlaylistSong(item.id, { notes: e.target.value })}
                        placeholder="Nota técnica..."
                        style={{
                          width: '100%',
                          background: 'transparent',
                          border: '1px solid transparent',
                          borderRadius: 'var(--b-radius-field)',
                          padding: '4px 6px',
                          color: 'var(--b-text-soft)',
                          fontSize: '11px',
                        }}
                        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--b-border)')}
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
                          aria-label={`Mover ${item.title} arriba`}
                          style={{
                            background: 'var(--b-elevated)',
                            border: '1px solid transparent',
                            color: isFirst ? 'var(--b-disabled)' : 'var(--b-text)',
                            borderRadius: 'var(--b-radius-field)',
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
                          aria-label={`Mover ${item.title} abajo`}
                          style={{
                            background: 'var(--b-elevated)',
                            border: '1px solid transparent',
                            color: isLast ? 'var(--b-disabled)' : 'var(--b-text)',
                            borderRadius: 'var(--b-radius-field)',
                            padding: '4px 6px',
                            cursor: isLast ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <ArrowDown size={13} />
                        </button>

                        <button
                          onClick={() => removeSongFromPlaylist(item.id)}
                          title="Quitar del setlist (la canción sigue en la librería)"
                          aria-label={`Quitar ${item.title} del setlist`}
                          style={{
                            background: 'var(--b-elevated)',
                            border: '1px solid transparent',
                            color: 'var(--b-danger)',
                            borderRadius: 'var(--b-radius-field)',
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

      {/* ADD SONG FROM LIBRARY */}
      {showAddSongModal && activePlaylist && (
        <SetlistAddSongModal
          songs={songs}
          inSetlist={new Set(items.map((it) => it.songId))}
          defaultArtist={activeBand?.name ?? ''}
          onAdd={addFromLibrary}
          onQuickCreate={quickCreate}
          onClose={() => setShowAddSongModal(false)}
        />
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
            background: 'var(--b-overlay)',
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
              background: 'var(--b-modal)',
              border: '1px solid transparent',
              borderRadius: 'var(--b-radius-card)',
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
                <label htmlFor="new-playlist-name" style={{ fontSize: '11px', color: 'var(--b-muted)', fontFamily: "'IBM Plex Mono', monospace" }}>
                  NOMBRE DEL SETLIST
                </label>
                <input
                  id="new-playlist-name"
                  type="text"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  placeholder="Ej: Acústico Teatros 2026"
                  required
                  style={{
                    width: '100%',
                    background: 'var(--b-input)',
                    border: '1px solid var(--b-border)',
                    borderRadius: 'var(--b-radius-field)',
                    padding: '10px',
                    color: 'var(--b-text)',
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
                    background: 'var(--b-elevated)',
                    border: '1px solid transparent',
                    color: 'var(--b-muted)',
                    padding: '8px 16px',
                    borderRadius: 'var(--b-radius-field)',
                    cursor: 'pointer',
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: 'var(--b-cobalt)',
                    border: 'none',
                    color: 'var(--b-on-strong)',
                    padding: '8px 20px',
                    borderRadius: 'var(--b-radius-field)',
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
