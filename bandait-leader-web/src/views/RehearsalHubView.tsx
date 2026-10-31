import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CloudDownload, Music, Pencil, Sliders } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import { StemStudio } from '../components/StemStudio'
import { ChordProPreview } from '../components/ChordProPreview'
import { listStemSongs, StemStoreError, type StemSongRecord } from '../services/stemStore'
import { downloadStems, getManifest, isCloudSongId, StemCloudError, type CloudManifest } from '../services/stemCloud'
import { formatBytes } from '../services/stemImport'
import type { StemPlayer } from '../services/stemPlayer'
import { barAtTime, sectionIndexAtBar, sectionSpans } from '../services/stemTiming'
import { useStemCloudTarget } from '../hooks/useStemCloudTarget'
import type { Song } from '../types/hub'
import { cardStyle, colors, headerBarStyle, labelStyle, mono, primaryButton, smallInputStyle, viewStyle } from '../components/hubStyles'

type PrompterMode = 'chords' | 'lyrics'

interface Props {
  onOpenTracks: () => void
  /** Abre la cancion en el editor de CANCIONES (para agregarle secciones). */
  onEditSong: (songId: string) => void
}

/** Consultas de manifiesto en paralelo al abrir ENSAYO (una por cancion sin stems locales). */
const MANIFEST_CONCURRENCY = 4

/**
 * ENSAYO: ensayo individual en casa. Reproduce los stems de una cancion (de este equipo, o
 * descargados de la nube de la banda) y sigue la seccion actual con su ChordPro. Usa el mismo
 * reproductor que PISTAS (StemStudio); el prompter lee la posicion con rAF y solo vuelve a pintar
 * React cuando cambia la seccion. Descargar es lectura: cualquier integrante puede hacerlo.
 */
export const RehearsalHubView: React.FC<Props> = ({ onOpenTracks, onEditSong }) => {
  const { songs } = useHub()
  const { target, bandKey } = useStemCloudTarget()
  const [records, setRecords] = useState<Map<string, StemSongRecord> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pickedId, setPickedId] = useState<string | null>(null)
  /** Manifiestos de la nube por `${bandKey}:${songId}` (null = sin stems en la nube). */
  const [cloud, setCloud] = useState<Map<string, CloudManifest | null>>(() => new Map())
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [download, setDownload] = useState<{ songId: string; done: number; total: number } | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    listStemSongs()
      .then((list) => {
        if (!cancelled) setRecords(new Map(list.map((r) => [r.songId, r])))
      })
      .catch((err) => {
        if (cancelled) return
        setRecords(new Map())
        setLoadError(err instanceof StemStoreError ? err.message : 'No se pudo leer el almacenamiento local.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const cloudKey = useCallback((songId: string) => `${bandKey}:${songId}`, [bandKey])

  // Canciones sin stems en este navegador cuyo manifiesto falta consultar.
  const pending = useMemo(
    () => (target && records ? songs.filter((s) => !records.has(s.id) && isCloudSongId(s.id) && !cloud.has(cloudKey(s.id))) : []),
    [target, records, songs, cloud, cloudKey]
  )

  useEffect(() => {
    if (!target || pending.length === 0) return
    const queue = pending.filter((s) => !inFlight.current.has(cloudKey(s.id)))
    if (queue.length === 0) return
    for (const s of queue) inFlight.current.add(cloudKey(s.id))
    let firstError: string | null = null
    const results = new Map<string, CloudManifest | null>()
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const key = cloudKey(s.id)
        try {
          results.set(key, await getManifest(target, s.id))
        } catch (err) {
          results.set(key, null)
          if (!firstError) firstError = err instanceof StemCloudError ? err.message : 'No se pudo consultar la nube.'
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(MANIFEST_CONCURRENCY, queue.length) }, worker)).then(() => {
      for (const key of results.keys()) inFlight.current.delete(key)
      setCloud((prev) => new Map([...prev, ...results]))
      if (firstError) setCloudError(firstError)
    })
  }, [target, pending, cloudKey])

  const cloudOnly = useMemo(
    () =>
      records && target
        ? songs.filter((s) => !records.has(s.id) && (cloud.get(cloudKey(s.id))?.stems.length ?? 0) > 0)
        : [],
    [songs, records, target, cloud, cloudKey]
  )
  const options = useMemo(() => {
    const local = records ? songs.filter((s) => records.has(s.id)) : []
    return [...local.map((s) => ({ song: s, where: 'local' as const })), ...cloudOnly.map((s) => ({ song: s, where: 'cloud' as const }))].sort((a, b) =>
      a.song.title.localeCompare(b.song.title, 'es')
    )
  }, [songs, records, cloudOnly])

  const picked = options.find((o) => o.song.id === pickedId) ?? options[0] ?? null
  const song = picked?.song ?? null
  const record = song && records ? records.get(song.id) ?? null : null
  const manifest = song ? cloud.get(cloudKey(song.id)) ?? null : null
  const checkingCloud = pending.length > 0

  const setRecord = (songId: string, next: StemSongRecord | null) =>
    setRecords((prev) => {
      const map = new Map(prev ?? [])
      if (next) map.set(songId, next)
      else map.delete(songId)
      return map
    })

  const downloadSong = async (songId: string) => {
    if (!target || download) return
    setDownloadError(null)
    setDownload({ songId, done: 0, total: manifest?.stems.length ?? 0 })
    try {
      const { record: rec } = await downloadStems(target, songId, (done, total) => setDownload({ songId, done, total }))
      setRecord(songId, rec)
    } catch (err) {
      setDownloadError(err instanceof StemCloudError || err instanceof StemStoreError ? err.message : 'No se pudieron descargar los stems.')
    } finally {
      setDownload(null)
    }
  }

  return (
    <div style={viewStyle}>
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Music size={22} style={{ color: colors.cyan, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Ensayo</h2>
          </div>
          <p data-testid="rehearsal-context" style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted }}>
            Ensayo individual, en casa: toca encima de los stems de la canción y sigue la sección actual con sus acordes o su letra. Repite una
            sección desde REPETIR. En vivo manda el líder.
          </p>
        </div>
      </div>

      {loadError && (
        <div role="alert" style={{ ...cardStyle, padding: '10px 12px', color: colors.danger, fontSize: '12px', borderColor: colors.danger }}>
          {loadError}
        </div>
      )}

      {records === null && <div style={{ fontFamily: mono, fontSize: '12px', color: colors.muted }}>LEYENDO STEMS GUARDADOS...</div>}
      {checkingCloud && (
        <div data-testid="rehearsal-cloud-checking" style={{ fontFamily: mono, fontSize: '12px', color: colors.muted }}>
          CONSULTANDO LOS STEMS DE LA NUBE DE LA BANDA...
        </div>
      )}
      {cloudError && <div style={{ fontSize: '12px', color: colors.warning }}>{cloudError}</div>}

      {records !== null && !checkingCloud && options.length === 0 && (
        <div data-testid="rehearsal-empty" style={{ ...cardStyle, padding: '24px 16px', textAlign: 'center', color: colors.muted, fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          {target
            ? 'Ninguna canción de esta banda tiene stems en este equipo ni en la nube. Cárgalos en PISTAS y vuelve a ensayar.'
            : 'Ninguna canción de esta banda tiene stems en este equipo. Cárgalos en PISTAS y vuelve a ensayar.'}
          <button type="button" className="stx-btn" onClick={onOpenTracks} style={{ ...primaryButton(colors.cobalt), color: colors.onAccent }}>
            <Sliders size={13} /> IR A PISTAS
          </button>
        </div>
      )}

      {song && (
        <div style={{ ...cardStyle, padding: '12px 14px', minWidth: 0 }}>
          <label htmlFor="rehearsal-song" style={labelStyle}>
            CANCIÓN
          </label>
          <select
            id="rehearsal-song"
            data-testid="rehearsal-song-select"
            className="stx-field"
            value={song.id}
            onChange={(e) => {
              setPickedId(e.target.value)
              setDownloadError(null)
            }}
            style={{ ...smallInputStyle, width: '100%', marginTop: '4px', padding: '7px 8px', fontSize: '13px' }}
          >
            {options.map((o) => (
              <option key={o.song.id} value={o.song.id}>
                {o.song.title} · {o.song.bpm} BPM · {o.where === 'local' ? 'en este equipo' : 'en la nube'}
              </option>
            ))}
          </select>
        </div>
      )}

      {song && !record && manifest && (
        <div data-testid="rehearsal-cloud-only" style={{ ...cardStyle, padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
          <div style={{ fontSize: '13px', color: colors.text }}>
            Los stems de <strong>{song.title}</strong> están en la nube de la banda ({manifest.stems.length} stems,{' '}
            {formatBytes(manifest.stems.reduce((n, s) => n + s.size, 0))}). Descárgalos a este equipo para ensayar; quedan guardados aquí.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="stx-btn"
              data-testid="rehearsal-download"
              disabled={!!download}
              onClick={() => void downloadSong(song.id)}
              style={{ ...primaryButton(colors.cyan), color: colors.onAccent }}
            >
              <CloudDownload size={14} /> DESCARGAR PARA ENSAYAR
            </button>
            {download && download.songId === song.id && (
              <span data-testid="rehearsal-download-progress" style={{ fontFamily: mono, fontSize: '12px', color: colors.cobalt }}>
                DESCARGANDO {download.done}/{download.total}...
              </span>
            )}
          </div>
          {downloadError && (
            <div role="alert" style={{ fontSize: '12px', color: colors.danger }}>
              {downloadError}
            </div>
          )}
        </div>
      )}

      {song && record && (
        <RehearsalSession
          key={`${song.id}:${record.tracks.map((t) => t.id).join(',')}`}
          song={song}
          record={record}
          onRecordChange={(next) => setRecord(song.id, next)}
          onEditSong={() => onEditSong(song.id)}
        />
      )}
    </div>
  )
}

interface SessionProps {
  song: Song
  record: StemSongRecord
  onRecordChange: (record: StemSongRecord | null) => void
  onEditSong: () => void
}

/** Prompter + reproductor de una cancion. Se monta de nuevo al cambiar de cancion o de pistas. */
const RehearsalSession: React.FC<SessionProps> = ({ song, record, onRecordChange, onEditSong }) => {
  const [mode, setMode] = useState<PrompterMode>('chords')
  const [current, setCurrent] = useState(-1)
  const playerRef = useRef<StemPlayer | null>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const lastBarText = useRef('')
  const currentRef = useRef(-1)

  const offsetMs = record.offsetMs
  const spans = useMemo(() => sectionSpans(song, offsetMs), [song, offsetMs])
  const onPlayer = useCallback((p: StemPlayer | null) => {
    playerRef.current = p
  }, [])

  // Sigue la posicion por rAF: el texto del compas se escribe al DOM; React solo pinta al cambiar de seccion.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const pos = playerRef.current ? playerRef.current.position() : 0
      const bar = barAtTime(pos, song.bpm, song.beatsPerBar, offsetMs)
      const idx = sectionIndexAtBar(spans, bar)
      if (idx !== currentRef.current) {
        currentRef.current = idx
        setCurrent(idx)
      }
      const text = !Number.isFinite(bar) ? '' : bar < 1 ? 'ANTES DEL COMPÁS 1' : `COMPÁS ${Math.floor(bar)}`
      if (text !== lastBarText.current && barRef.current) {
        lastBarText.current = text
        barRef.current.textContent = text
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [spans, song.bpm, song.beatsPerBar, offsetMs])

  const sections = song.sections
  const cur = current >= 0 && current < spans.length ? spans[current] : null
  const curSection = cur ? sections.find((s) => s.id === cur.id) ?? null : null
  const nextIdx = current < 0 ? 0 : current + 1
  const next = nextIdx < spans.length ? spans[nextIdx] : null
  const nextSection = next ? sections.find((s) => s.id === next.id) ?? null : null
  const status = spans.length === 0 ? 'none' : current < 0 ? 'before' : current >= spans.length ? 'after' : 'in'

  return (
    <>
      <div data-testid="rehearsal-prompter" style={{ ...cardStyle, padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0, background: colors.oled }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span ref={barRef} data-testid="rehearsal-bar" style={{ fontFamily: mono, fontSize: '12px', fontWeight: 700, color: colors.muted, fontVariantNumeric: 'tabular-nums' }} />
          <span style={{ fontFamily: mono, fontSize: '11px', color: colors.disabled }}>
            {song.bpm} BPM · {song.beatsPerBar}/{song.beatUnit}
          </span>
          <div role="group" aria-label="Vista del prompter" style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
            {(['chords', 'lyrics'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="stx-btn"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                style={{
                  fontFamily: mono,
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '5px 10px',
                  borderRadius: '3px',
                  border: `1px solid ${mode === m ? colors.cyan : colors.border}`,
                  background: mode === m ? colors.cyan : colors.elevated,
                  color: mode === m ? colors.onAccent : colors.muted,
                  cursor: 'pointer',
                }}
              >
                {m === 'chords' ? 'ACORDES' : 'LETRA'}
              </button>
            ))}
          </div>
        </div>

        {status === 'none' && (
          <div data-testid="rehearsal-no-sections" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: colors.muted }}>
              {song.sections.length === 0
                ? 'Esta canción no tiene secciones con compases, así que no hay nada que seguir. Agrégalas en CANCIONES: a mano, pegando ChordPro o aceptando el borrador de ANALIZAR CON IA.'
                : 'El tempo o los compases de la canción no son válidos: revísalos en CANCIONES.'}
            </span>
            <button type="button" className="stx-btn" data-testid="rehearsal-edit-song" onClick={onEditSong} style={{ ...primaryButton(colors.violet), color: colors.onAccent }}>
              <Pencil size={13} /> ABRIR EN CANCIONES
            </button>
          </div>
        )}

        {status !== 'none' && (
          <div
            key={current}
            data-testid="rehearsal-current"
            data-section-index={current}
            data-label={cur?.label ?? ''}
            className="stx-fade-in"
            style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '22px', fontWeight: 800, color: colors.text }}>
                {status === 'in' && cur ? cur.label : status === 'before' ? 'Antes de empezar' : 'Fin de la canción'}
              </span>
              {status === 'in' && cur && (
                <span style={{ fontFamily: mono, fontSize: '12px', color: colors.cyan }}>
                  c. {cur.startBar}-{cur.startBar + cur.bars - 1}
                </span>
              )}
            </div>
            {status === 'in' && curSection && (
              <ChordProPreview
                chordpro={curSection.chordpro}
                mode={mode}
                fontSize={18}
                testId="rehearsal-current-chordpro"
                emptyText={mode === 'lyrics' ? 'Sección sin letra.' : 'Sección sin letra ni acordes.'}
              />
            )}
          </div>
        )}

        {next && (
          <div data-testid="rehearsal-next" data-label={next.label} style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, opacity: 0.6 }}>
            <div style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
              SIGUIENTE: <strong style={{ color: colors.text }}>{next.label}</strong> · c. {next.startBar}-{next.startBar + next.bars - 1}
            </div>
            {nextSection && <ChordProPreview chordpro={nextSection.chordpro} mode={mode} fontSize={13} testId="rehearsal-next-chordpro" emptyText="Sin contenido." />}
          </div>
        )}
      </div>

      <div style={{ fontSize: '11px', color: colors.muted, fontFamily: mono }}>
        Tempo de práctica: todavía no. Cambiar la velocidad en Web Audio también cambia el tono.
      </div>

      <StemStudio song={song} record={record} onRecordChange={onRecordChange} onPlayer={onPlayer} />
    </>
  )
}
