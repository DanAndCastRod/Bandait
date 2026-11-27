import React, { useEffect, useRef, useState } from 'react'
import { zipSync } from 'fflate'
import { CircleCheck, CloudUpload, Download, FileArchive, HardDriveDownload, X } from 'lucide-react'
import { useHub } from '../../context/hubContextCore'
import { slugify } from '../../services/download'
import { CLOUD_MAX_FILE_BYTES, CLOUD_MAX_STEMS, getManifest, isCloudSongId, uploadStems } from '../../services/stemCloud'
import { cloudStemsChanged } from '../../services/stemCloudEvents'
import { formatBytes } from '../../services/stemImport'
import type { StemRole } from '../../services/stemNames'
import { saveStemSong, type StemSongRecord } from '../../services/stemStore'
import { bounce } from '../../services/studio/bounce'
import { trackHasSound } from '../../services/studio/graph'
import type { BounceFile, LoopRegionS, WavBitDepth } from '../../services/studio/types'
import { HubModal } from '../HubModal'
import { errorText, formatTimecode, useStudio, type StudioPanelProps } from './studioState'

interface Props extends StudioPanelProps {
  /** Cancion de la sesion (para "Publicar en la cancion"), o null si es una maqueta libre. */
  song: { id: string; title: string } | null
  onClose: () => void
}

interface ExportedFile {
  /** Nombre del archivo, con extension. */
  name: string
  label: string
  role: StemRole
  file: BounceFile
}

interface Exported {
  mode: 'mix' | 'tracks'
  /** true si cubre la sesion desde el segundo 0 (requisito para publicar como stems). */
  fullRange: boolean
  /** Audios de la sesion que no estaban cargados al exportar: sus clips no suenan en el resultado. */
  missingAudio: number
  files: ExportedFile[]
}

type Phase =
  | { kind: 'setup' }
  | { kind: 'rendering'; fraction: number }
  | { kind: 'done'; result: Exported }
  | { kind: 'checking'; result: Exported }
  | { kind: 'confirm'; result: Exported; cloudCount: number | null }
  | { kind: 'publishing'; result: Exported; done: number; total: number }
  | { kind: 'published'; result: Exported; count: number; localOnly?: boolean }
  | { kind: 'failed'; message: string; result: Exported | null }

function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

function loudness(file: BounceFile): string {
  const lufs = Number.isFinite(file.lufs) ? `${file.lufs.toFixed(1)} LUFS` : 'silencio'
  const peak = Number.isFinite(file.truePeakDb) ? `pico real ${file.truePeakDb.toFixed(1)} dBTP` : 'sin pico'
  return `${lufs} · ${peak}`
}

/**
 * EXPORTAR: mezcla estereo o pistas por separado, en WAV de 16 o 24 bits, con el mismo grafo que
 * suena en el Estudio (bounce.ts). El resultado se descarga, se guarda en stems locales (IndexedDB)
 * o se publica en la nube de la banda (IndexedDB + R2), tras confirmacion.
 */
export const StudioExportDialog: React.FC<Props> = ({ controller, song, onClose }) => {
  const { sharing, registerSongStemsInWorkspace } = useHub()
  const snap = useStudio(controller)
  const { session } = snap
  const loop = snap.engine.loop
  const [mode, setMode] = useState<'mix' | 'tracks'>('mix')
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(24)
  const [onlyLoop, setOnlyLoop] = useState(false)
  const [includeMuted, setIncludeMuted] = useState(false)
  /** Con audios sin cargar, exportar pide una confirmacion explicita. */
  const [acceptIncomplete, setAcceptIncomplete] = useState(false)
  const missingAudio = snap.engine.missingAssetIds.length
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' })
  const abortRef = useRef<AbortController | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  // La confirmacion de publicar pone el foco en CANCELAR: Enter no reemplaza nada por accidente.
  useEffect(() => {
    if (phase.kind === 'confirm') cancelRef.current?.focus({ preventScroll: true })
  }, [phase.kind])

  const busy = phase.kind === 'rendering' || phase.kind === 'checking' || phase.kind === 'publishing'
  // Pistas con algo que suene: clips de audio activos, clips MIDI o un congelado (v2).
  const withAudio = session.tracks.filter(trackHasSound)
  const mutedCount = withAudio.filter((track) => track.mute).length
  // Por separado, una pista en mute (un master o una mezcla de referencia) no sale salvo que se pida:
  // asi no termina publicada como stem por descuido.
  const exportable = mode === 'tracks' && !includeMuted ? withAudio.filter((track) => !track.mute) : withAudio
  const audibleTracks = exportable.length
  const range: LoopRegionS | undefined = onlyLoop && loop ? loop : undefined

  const close = () => {
    abortRef.current?.abort()
    onClose()
  }

  const run = async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ kind: 'rendering', fraction: 0 })
    try {
      const current = controller.snapshot().session
      const result = await bounce(current, controller.engine.getBuffers(), {
        mode,
        bitDepth,
        sampleRate: current.sampleRate,
        range,
        trackIds: mode === 'tracks' ? current.tracks.filter((track) => trackHasSound(track) && (includeMuted || !track.mute)).map((track) => track.id) : undefined,
        signal: ctrl.signal,
        onProgress: (fraction) => {
          if (!ctrl.signal.aborted) setPhase({ kind: 'rendering', fraction })
        },
      })
      if (ctrl.signal.aborted) return
      const base = slugify(current.title)
      const files: ExportedFile[] =
        result.mode === 'mix'
          ? [{ name: `${base}_mezcla_${bitDepth}bit.wav`, label: 'Mezcla', role: 'unknown', file: result.mix }]
          : result.tracks.map((track, index) => ({
              name: `${String(index + 1).padStart(2, '0')}_${slugify(track.name)}.wav`,
              label: track.name,
              role: track.role,
              file: track,
            }))
      setPhase({ kind: 'done', result: { mode: result.mode, fullRange: range === undefined || range.startS === 0, missingAudio: controller.snapshot().engine.missingAssetIds.length, files } })
    } catch (err) {
      if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        setPhase({ kind: 'setup' })
        return
      }
      setPhase({ kind: 'failed', message: errorText(err, 'No se pudo exportar.'), result: null })
    }
  }

  const downloadAll = (result: Exported) => {
    if (result.files.length === 1) {
      saveBlob(result.files[0].name, result.files[0].file.blob)
      return
    }
    void (async () => {
      try {
        const entries: Record<string, [Uint8Array, { level: 0 }]> = {}
        for (const item of result.files) entries[item.name] = [new Uint8Array(await item.file.blob.arrayBuffer()), { level: 0 }]
        const zipped = zipSync(entries)
        saveBlob(`${slugify(session.title)}_pistas.zip`, new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
      } catch {
        controller.notify('error', 'No se pudo armar el ZIP (puede faltar memoria). Descarga las pistas una por una.')
      }
    })()
  }

  const buildStemRecord = (result: Exported, songId: string): { record: StemSongRecord; blobs: Map<string, Blob> } => {
    const blobs = new Map<string, Blob>()
    const tracks = result.files.map((item, index) => {
      const id = `studio_${index}`
      blobs.set(id, item.file.blob)
      return { id, role: item.role, label: item.label, fileName: item.name, size: item.file.blob.size, mimeType: 'audio/wav' }
    })
    const record: StemSongRecord = { songId, offsetMs: 0, updatedAt: new Date().toISOString(), tracks }
    return { record, blobs }
  }

  const localStemBlock = (result: Exported): string | null => {
    if (!song) return 'Esta sesión no parte de una canción de la librería.'
    if (result.missingAudio > 0) return 'Faltan audios por cargar en este equipo.'
    if (!result.fullRange) return 'Exporta desde el compás 1 para guardar como stems.'
    return null
  }

  /** Motivo por el que no se puede publicar este resultado en la nube R2, o null si se puede. */
  const publishBlock = (result: Exported): string | null => {
    const localReason = localStemBlock(result)
    if (localReason) return localReason
    if (!controller.cloud) return 'Entra con tu cuenta de nube para publicar stems.'
    if (!sharing.activeCanEdit) return 'Solo el Owner o el Director musical pueden publicar stems oficiales en la nube.'
    if (!song || !isCloudSongId(song.id)) return 'Esta canción no se puede usar en la nube de stems.'
    if (result.files.length > CLOUD_MAX_STEMS) return `La nube admite hasta ${CLOUD_MAX_STEMS} stems por canción.`
    if (result.files.some((item) => item.file.blob.size > CLOUD_MAX_FILE_BYTES)) return 'Un archivo pasa de 200 MB. Exporta en 16 bits.'
    return null
  }

  const saveLocalStems = async (result: Exported) => {
    if (!song) return
    setPhase({ kind: 'publishing', result, done: 0, total: result.files.length })
    try {
      const newTracks = result.files.map((item) => ({
        role: item.role,
        label: item.label,
        fileName: item.name,
        blob: item.file.blob,
      }))
      const saved = await saveStemSong(song.id, newTracks, 'replace', 0)
      if (sharing.activeCanEdit) {
        registerSongStemsInWorkspace(song.id, song.title, session.bpm, saved.tracks)
      }
      setPhase({ kind: 'published', result, count: saved.tracks.length, localOnly: true })
    } catch (err) {
      setPhase({ kind: 'failed', message: errorText(err, 'No se pudieron guardar los stems en este equipo.'), result })
    }
  }

  const askPublish = async (result: Exported) => {
    const cloud = controller.cloud
    if (!cloud || !song) return
    setPhase({ kind: 'checking', result })
    let cloudCount: number | null = null
    try {
      cloudCount = (await getManifest(cloud, song.id))?.stems.length ?? 0
    } catch {
      // Sin esa consulta la confirmacion avisa igual que puede reemplazar stems.
    }
    setPhase({ kind: 'confirm', result, cloudCount })
  }

  const publish = async (result: Exported) => {
    const cloud = controller.cloud
    if (!cloud || !song) return
    setPhase({ kind: 'publishing', result, done: 0, total: result.files.length })
    try {
      const { record, blobs } = buildStemRecord(result, song.id)
      const newTracks = result.files.map((item) => ({
        role: item.role,
        label: item.label,
        fileName: item.name,
        blob: item.file.blob,
      }))
      await saveStemSong(song.id, newTracks, 'replace', 0)
      // `existing: null` obliga a subir todo: una mezcla nueva puede pesar lo mismo que la anterior.
      const manifest = await uploadStems(cloud, song.id, { record, blobs, existing: null }, (done, total) => setPhase({ kind: 'publishing', result, done, total }))
      registerSongStemsInWorkspace(song.id, song.title, session.bpm, record.tracks)
      cloudStemsChanged({ band: cloud.band, songId: song.id, manifest })
      setPhase({ kind: 'published', result, count: manifest.stems.length, localOnly: false })
    } catch (err) {
      setPhase({ kind: 'failed', message: errorText(err, 'No se pudieron publicar los stems.'), result })
    }
  }

  const result = 'result' in phase ? phase.result : null
  const localBlock = result ? localStemBlock(result) : null
  const block = result ? publishBlock(result) : null

  return (
    <HubModal title="EXPORTAR" onClose={close} maxWidth="560px" testId="studio-export" closeOnEscape={!busy}>
      <div className="stu stu-export">
        {(phase.kind === 'setup' || phase.kind === 'rendering') && (
          <>
            <div className="stu-form-row">
              <span className="stu-label" id="studio-export-mode">
                Qué exportar
              </span>
              <div className="stu-seg" role="group" aria-labelledby="studio-export-mode">
                <button type="button" className="stu-btn" data-on={mode === 'mix'} aria-pressed={mode === 'mix'} disabled={busy} onClick={() => setMode('mix')} data-testid="studio-export-mix">
                  MEZCLA ESTÉREO
                </button>
                <button type="button" className="stu-btn" data-on={mode === 'tracks'} aria-pressed={mode === 'tracks'} disabled={busy} onClick={() => setMode('tracks')} data-testid="studio-export-tracks">
                  PISTAS SEPARADAS
                </button>
              </div>
              <p className="stu-help">
                {mode === 'mix'
                  ? 'Un WAV estéreo con todo lo que suena: efectos, reverb y master incluidos. Respeta mute y solo.'
                  : `Un WAV por pista con sonido (${audibleTracks}), después del fader y el paneo, sin reverb ni master. Ignora el solo; las pistas en mute no salen salvo que lo pidas.`}
              </p>
              {mode === 'tracks' && mutedCount > 0 && (
                <label className="stu-check">
                  <input type="checkbox" checked={includeMuted} disabled={busy} onChange={(event) => setIncludeMuted(event.target.checked)} data-testid="studio-export-muted" />
                  <span>
                    Incluir {mutedCount === 1 ? 'la pista en mute' : `las ${mutedCount} pistas en mute`}
                  </span>
                </label>
              )}
            </div>
            <div className="stu-form-row">
              <span className="stu-label" id="studio-export-bits">
                Resolución
              </span>
              <div className="stu-seg" role="group" aria-labelledby="studio-export-bits">
                {([16, 24] as const).map((bits) => (
                  <button key={bits} type="button" className="stu-btn" data-on={bitDepth === bits} aria-pressed={bitDepth === bits} disabled={busy} onClick={() => setBitDepth(bits)} data-testid={`studio-export-${bits}`}>
                    {bits} BITS
                  </button>
                ))}
              </div>
              <p className="stu-help">WAV a {session.sampleRate} Hz. 24 bits para seguir trabajando el audio; 16 bits pesa un tercio menos.</p>
            </div>
            {loop && (
              <label className="stu-check">
                <input type="checkbox" checked={onlyLoop} disabled={busy} onChange={(event) => setOnlyLoop(event.target.checked)} />
                <span>
                  Solo el tramo en repetición ({formatTimecode(loop.startS)} - {formatTimecode(loop.endS)}). Un tramo no se puede publicar como stems.
                </span>
              </label>
            )}
            {phase.kind === 'rendering' ? (
              <div className="stu-form-row" aria-live="polite">
                <span className="stu-label" data-testid="studio-export-status">
                  EXPORTANDO {Math.round(phase.fraction * 100)} %
                </span>
                <div className="stu-progress" aria-hidden="true">
                  <div style={{ transform: `scaleX(${phase.fraction})` }} />
                </div>
              </div>
            ) : null}
            {missingAudio > 0 && (
              <div className="stu-notice" data-tone="warn" role="alert" data-testid="studio-export-missing">
                <span>
                  {missingAudio === 1 ? 'Falta 1 audio de esta sesión en este equipo' : `Faltan ${missingAudio} audios de esta sesión en este equipo`}: sus clips NO van a sonar en lo que exportes, y no se podrá publicar. Recarga la sesión para volver a bajarlos.
                </span>
                <label className="stu-check">
                  <input type="checkbox" checked={acceptIncomplete} disabled={busy} onChange={(event) => setAcceptIncomplete(event.target.checked)} data-testid="studio-export-incomplete" />
                  <span>Exportar igual, sin esos audios</span>
                </label>
              </div>
            )}
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" onClick={close}>
                {busy ? 'CANCELAR' : 'CERRAR'}
              </button>
              <button type="button" className="stu-btn" data-tone="primary" disabled={busy || audibleTracks === 0 || (missingAudio > 0 && !acceptIncomplete)} onClick={() => void run()} data-testid="studio-export-run">
                <Download size={13} />
                EXPORTAR
              </button>
            </div>
            {audibleTracks === 0 && <p className="stu-help">{withAudio.length === 0 ? 'La sesión no tiene clips activos ni notas: no hay nada que exportar.' : 'Todas las pistas con sonido están en mute: marca la casilla para incluirlas.'}</p>}
          </>
        )}

        {phase.kind === 'failed' && (
          <div className="stu-notice" data-tone="error" role="alert" data-testid="studio-export-error">
            <span>{phase.message}</span>
          </div>
        )}
        {phase.kind === 'failed' && !phase.result && (
          <div className="stu-actions" data-align="end">
            <button type="button" className="stu-btn" data-tone="ghost" onClick={close}>
              CERRAR
            </button>
            <button type="button" className="stu-btn" onClick={() => setPhase({ kind: 'setup' })}>
              VOLVER
            </button>
          </div>
        )}

        {result && (
          <>
            <ul className="stu-files" data-testid="studio-export-files">
              {result.files.map((item) => (
                <li key={item.name}>
                  <span className="stu-files-name">
                    <strong>{item.label}</strong>
                    <span>
                      {formatTimecode(item.file.durationS)} · {formatBytes(item.file.blob.size)} · {loudness(item.file)}
                    </span>
                    {item.file.truePeakDb > 0 && <span data-tone="warn">Pasa de 0 dBFS: el archivo recorta. Baja el volumen o activa el limitador del master.</span>}
                  </span>
                  <button type="button" className="stu-btn" data-size="icon" onClick={() => saveBlob(item.name, item.file.blob)} aria-label={`Descargar ${item.label}`} title={`Descargar ${item.name}`}>
                    <Download size={13} />
                  </button>
                </li>
              ))}
            </ul>

            {phase.kind === 'confirm' && song && (
              <div className="stu-confirm" role="alertdialog" aria-label="Reemplazar los stems de la canción" data-testid="studio-publish-confirm">
                <p>
                  {phase.cloudCount === null ? (
                    <>
                      No se pudo consultar qué stems tiene hoy <strong>{song.title}</strong> en la nube. Si tiene, se <strong>reemplazan</strong> por
                    </>
                  ) : phase.cloudCount > 0 ? (
                    <>
                      Reemplaza los {phase.cloudCount} stems actuales de <strong>{song.title}</strong> en la nube de la banda por
                    </>
                  ) : (
                    <>
                      <strong>{song.title}</strong> no tiene stems en la nube de la banda. Se publican
                    </>
                  )}{' '}
                  {result.files.length === 1 ? 'este archivo' : `estos ${result.files.length} archivos`} del Estudio.
                </p>
                <p className="stu-help">El leader los recibe como cualquier stem publicado. Quien ya descargó los anteriores conserva su copia hasta que descargue los nuevos; los stems de este equipo (PISTAS) no cambian.</p>
                <div className="stu-actions" data-align="end">
                  <button ref={cancelRef} type="button" className="stu-btn" onClick={() => setPhase({ kind: 'done', result })} data-testid="studio-publish-cancel">
                    <X size={13} />
                    CANCELAR
                  </button>
                  <button type="button" className="stu-btn" data-tone="danger" onClick={() => void publish(result)} data-testid="studio-publish-ok">
                    {phase.cloudCount === 0 ? 'PUBLICAR' : 'REEMPLAZAR Y PUBLICAR'}
                  </button>
                </div>
              </div>
            )}

            {(phase.kind === 'publishing' || phase.kind === 'checking') && (
              <div className="stu-form-row" aria-live="polite">
                <span className="stu-label">{phase.kind === 'checking' ? 'CONSULTANDO LA NUBE...' : `SUBIENDO STEMS ${phase.done}/${phase.total}...`}</span>
                <div className="stu-progress" aria-hidden="true">
                  <div style={{ transform: `scaleX(${phase.kind === 'publishing' && phase.total > 0 ? phase.done / phase.total : 0.05})` }} />
                </div>
              </div>
            )}

            {phase.kind === 'published' && song && (
              <p className="stu-ok-note" role="status" data-testid="studio-publish-done">
                <CircleCheck size={14} aria-hidden="true" />
                <span>
                  {phase.count} {phase.count === 1 ? 'stem' : 'stems'} {phase.localOnly ? 'guardados en este equipo para' : 'publicados en este equipo y en la nube para'} <strong>{song.title}</strong>.
                </span>
              </p>
            )}

            {phase.kind !== 'confirm' && (
              <div className="stu-actions" data-align="end">
                <button type="button" className="stu-btn" data-tone="ghost" disabled={busy} onClick={() => setPhase({ kind: 'setup' })}>
                  OTRA EXPORTACIÓN
                </button>
                {song && (
                  <button
                    type="button"
                    className="stu-btn"
                    disabled={busy || localBlock !== null || phase.kind === 'published'}
                    onClick={() => void saveLocalStems(result)}
                    title={localBlock ?? 'Guarda estos WAV en IndexedDB para Ensayo y Stems en este equipo'}
                    data-testid="studio-save-local-stems"
                  >
                    <HardDriveDownload size={13} />
                    STEMS LOCALES
                  </button>
                )}
                <button
                  type="button"
                  className="stu-btn"
                  disabled={busy || block !== null || phase.kind === 'published'}
                  onClick={() => void askPublish(result)}
                  title={block ?? 'Guarda en este equipo y sube los stems oficiales de la canción a la nube R2'}
                  data-testid="studio-publish"
                >
                  <CloudUpload size={13} />
                  PUBLICAR EN LA CANCIÓN
                </button>
                <button type="button" className="stu-btn" data-tone="primary" disabled={busy} onClick={() => downloadAll(result)} data-testid="studio-export-download">
                  {result.files.length > 1 ? <FileArchive size={13} /> : <Download size={13} />}
                  {result.files.length > 1 ? 'DESCARGAR ZIP' : 'DESCARGAR'}
                </button>
              </div>
            )}
            {block && phase.kind !== 'confirm' && <p className="stu-help">Publicar en la canción: {block}</p>}
          </>
        )}
      </div>
    </HubModal>
  )
}
