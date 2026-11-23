import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, Play, RefreshCw, Sparkles, Square, X } from 'lucide-react'
import { slugify } from '../../services/download'
import { StemCloudError } from '../../services/stemCloud'
import { encodeWavPcm } from '../../services/wav'
import { AUDIO_TO_MIDI_MAX_SECONDS, availability as audioToMidiAvailability, transcribe } from '../../services/studio/audioToMidi'
import { renderMix } from '../../services/studio/bounce'
import { trackHasSound } from '../../services/studio/graph'
import { normalizeNotes } from '../../services/studio/midiOps'
import {
  analysisPlacementForClip,
  analysisSessionPatch,
  analysisToChords,
  analysisToMarkers,
  rebeatMarkers,
  analyzeRequestForAsset,
  COMPOSE_LENGTH_BARS_MAX,
  COMPOSE_LENGTH_BARS_MIN,
  COMPOSE_ROLES,
  composeRequestForSession,
  composeResultToClip,
  type AnalysisPlacement,
  barsToSeconds,
  estimateV2,
  estimateText,
  formatUsd,
  generateRequestForSession,
  JOB_DEFAULT_TARGET_LUFS,
  JOB_GENERATE_SECONDS_MAX,
  JOB_GENERATE_SECONDS_MIN,
  JOB_TARGET_LUFS_MAX,
  JOB_TARGET_LUFS_MIN,
  jobErrorMessage,
  jobStatusTextV2,
  clearPendingJob,
  readPendingJobV2,
  resumeJobV2,
  runJobV2,
  writePendingJob,
  suggestionsForSession,
  suggestionTitle,
} from '../../services/studio/jobs'
import { gainToTargetLufs, integratedLufs, truePeakDb } from '../../services/studio/loudness'
import {
  assetFileName,
  defaultInstrument,
  defaultInstrumentTrack,
  defaultMidiClip,
  findClip,
  findTrack,
  newStudioId,
  roundBeat,
  secondsToBeats,
  STUDIO_MAX_MARKERS,
  STUDIO_MAX_NOTES_PER_CLIP,
  STUDIO_MAX_PROMPT,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACK_NAME,
  STUDIO_MAX_TRACKS,
  STUDIO_MIDI_MIN_CLIP_BEATS,
  type StudioMidiNote,
  type StudioSession,
} from '../../services/studio/session'
import { addInstrumentTrack, addMidiClip, applyMixSuggestion, setChords, setMarkers, trimClip, updateSessionMeta, updateTrack } from '../../services/studio/sessionOps'
import * as studioCloud from '../../services/studio/studioCloud'
import type {
  ComposeRole,
  MixSuggestion,
  StudioJobAsset,
  StudioJobEstimateV2,
  StudioJobKindV2,
  StudioJobRequestV2,
  StudioJobStateV2,
} from '../../services/studio/types'
import { errorText, formatTimecode, useStudio, type StudioController, type StudioPanelProps } from './studioState'

// ---------------------------------------------------------------------------
// Flujo comun de un trabajo de pago: preparar -> costo -> confirmar -> lanzar -> resultado
// ---------------------------------------------------------------------------

type SucceededState = Extract<StudioJobStateV2, { status: 'SUCCEEDED' }>

interface Prepared<C> {
  request: StudioJobRequestV2
  /** Sube a la nube el audio que el trabajo necesita. Repetir es seguro. */
  upload?: () => Promise<void>
  /** Lo que la seccion necesita al recibir el resultado. */
  context: C
}

type Flow<C> =
  | { kind: 'idle' }
  | { kind: 'working'; text: string; fraction: number | null }
  | { kind: 'confirm'; prepared: Prepared<C>; estimate: StudioJobEstimateV2; uploaded: boolean }
  | { kind: 'running'; state: StudioJobStateV2 | null }
  | { kind: 'done'; prepared: Prepared<C>; state: SucceededState }
  | { kind: 'failed'; title: string; message: string; retry: boolean }
  /** Hay un trabajo ya lanzado (y cobrado) cuyo resultado no se ha recibido: se consulta, no se relanza. */
  | { kind: 'pending'; jobId: string; message: string }

/** Como guarda y recupera cada seccion su contexto, para retomar un trabajo tras recargar. */
interface ContextCodec<C> {
  save: (context: C) => unknown
  /** null si lo guardado no sirve (danado o de otra version); el contexto va envuelto porque puede ser null. */
  restore: (saved: unknown) => { context: C } | null
}

const PENDING_FOUND = 'Hay un trabajo que ya se lanzó en esta sesión y cuyo resultado no se recibió. Consúltalo antes de lanzar otro: volver a lanzar se cobra de nuevo.'

function pendingStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

interface PrepareTools {
  signal: AbortSignal
  progress: (text: string, fraction?: number | null) => void
}

function failureOf(err: unknown): Extract<Flow<never>, { kind: 'failed' }> {
  if (err instanceof StemCloudError) {
    const message = jobErrorMessage(err)
    if (err.code === 'provider_unavailable') return { kind: 'failed', title: 'PROVEEDOR NO DISPONIBLE', message, retry: false }
    if (err.code === 'quota_exceeded' || err.status === 429) return { kind: 'failed', title: 'CUOTA DEL MES AGOTADA', message, retry: false }
    if (err.status === 401) return { kind: 'failed', title: 'SIN SESIÓN DE NUBE', message, retry: false }
    if (err.status === 403) return { kind: 'failed', title: 'SIN PERMISO', message, retry: false }
  }
  return { kind: 'failed', title: 'EL TRABAJO FALLÓ', message: jobErrorMessage(err), retry: true }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * Estado de un trabajo de pago. Nada se lanza sin pasar por `confirm`, que solo existe despues
 * de mostrar el costo estimado; y el resultado queda en `done` hasta que la seccion lo acepta o
 * lo descarta: un trabajo nunca toca la sesion por su cuenta.
 */
function useJobFlow<C>(controller: StudioController, kind: StudioJobKindV2, codec: ContextCodec<C>) {
  const sessionId = controller.sessionId
  // Un trabajo lanzado en una visita anterior (pestana cerrada, cambio de vista, corte de red)
  // sigue en la nube: al montar se ofrece consultarlo en vez de dejar lanzar otro.
  const [flow, setFlow] = useState<Flow<C>>(() => {
    const pending = readPendingJobV2(pendingStorage(), sessionId, kind)
    return pending ? { kind: 'pending', jobId: pending.jobId, message: PENDING_FOUND } : { kind: 'idle' }
  })
  const abortRef = useRef<AbortController | null>(null)
  /** Contexto completo del trabajo en curso (puede traer cosas no serializables, como la mezcla). */
  const contextRef = useRef<{ jobId: string; prepared: Prepared<C> } | null>(null)

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  const begin = (): AbortController => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    return ctrl
  }

  /** Prepara la peticion y pide el costo. Termina en `confirm` o en `failed`. */
  const quote = async (prepare: (tools: PrepareTools) => Promise<Prepared<C>>): Promise<void> => {
    const cloud = controller.cloud
    if (!cloud) return
    const ctrl = begin()
    const progress = (text: string, fraction: number | null = null) => {
      if (!ctrl.signal.aborted) setFlow({ kind: 'working', text, fraction })
    }
    progress('PREPARANDO...')
    try {
      const prepared = await prepare({ signal: ctrl.signal, progress })
      if (ctrl.signal.aborted) return
      progress('CONSULTANDO EL COSTO...')
      let uploaded = false
      let quoted: StudioJobEstimateV2
      try {
        quoted = await estimateV2(cloud, controller.sessionId, prepared.request)
      } catch (err) {
        // La estimacion valida igual que el lanzamiento: si pide el audio en la nube, se sube antes.
        if (!(err instanceof StemCloudError) || err.code !== 'no_asset' || !prepared.upload) throw err
        progress('SUBIENDO EL AUDIO...')
        await prepared.upload()
        uploaded = true
        if (ctrl.signal.aborted) return
        progress('CONSULTANDO EL COSTO...')
        quoted = await estimateV2(cloud, controller.sessionId, prepared.request)
      }
      if (ctrl.signal.aborted) return
      setFlow({ kind: 'confirm', prepared, estimate: quoted, uploaded })
    } catch (err) {
      if (ctrl.signal.aborted || isAbort(err)) return
      setFlow(failureOf(err))
    }
  }

  const forgetPending = () => {
    contextRef.current = null
    clearPendingJob(pendingStorage(), sessionId, kind)
  }

  /** Estado final de un trabajo: resultado, fallo real del proveedor, o "todavia no termina". */
  const settle = (final: StudioJobStateV2, prepared: Prepared<C>) => {
    if (final.status === 'SUCCEEDED') {
      // El pendiente se conserva hasta que la seccion acepta o descarta el resultado (reset).
      setFlow({ kind: 'done', prepared, state: final })
    } else if (final.status === 'FAILED' && final.resumable) {
      setFlow({ kind: 'pending', jobId: final.jobId, message: final.error })
    } else if (final.status === 'FAILED') {
      forgetPending()
      setFlow({ kind: 'failed', title: jobStatusTextV2(final), message: final.error, retry: true })
    }
  }

  /** El usuario acepto el costo: sube lo que falte, lanza y espera el resultado. */
  const confirm = async (): Promise<void> => {
    const cloud = controller.cloud
    if (!cloud || flow.kind !== 'confirm') return
    const { prepared, uploaded } = flow
    const ctrl = begin()
    let launched: string | null = null
    try {
      if (prepared.upload && !uploaded) {
        setFlow({ kind: 'working', text: 'SUBIENDO EL AUDIO...', fraction: null })
        await prepared.upload()
        if (ctrl.signal.aborted) return
      }
      setFlow({ kind: 'running', state: null })
      let accepted = false
      try {
        const final = await runJobV2(cloud, sessionId, prepared.request, {
          signal: ctrl.signal,
          // El id se guarda ANTES de enviar: si la pestana se cierra o la red se cae con el
          // trabajo ya aceptado, queda con que consultarlo.
          onStarted: (jobId) => {
            launched = jobId
            contextRef.current = { jobId, prepared }
            writePendingJob(pendingStorage(), sessionId, { jobId, kind, request: prepared.request, context: codec.save(prepared.context), at: Date.now() })
          },
          onState: (state) => {
            accepted = true
            if (!ctrl.signal.aborted && state.status !== 'SUCCEEDED' && state.status !== 'FAILED') setFlow({ kind: 'running', state })
          },
        })
        if (!final || ctrl.signal.aborted) return
        settle(final, prepared)
      } catch (err) {
        if (ctrl.signal.aborted) return
        const network = err instanceof StemCloudError && err.code === 'network'
        // El Worker rechazo el POST con un codigo (cuota, proveedor, permiso): no se lanzo ni se
        // cobro nada, y reintentar es seguro.
        if (!launched || (!accepted && !network)) {
          forgetPending()
          setFlow(failureOf(err))
          return
        }
        // Trabajo aceptado, o respuesta perdida por la red (pudo aceptarse): el fallo es de la
        // consulta, no del trabajo. Se consulta de nuevo; relanzar cobraria otra vez.
        setFlow({ kind: 'pending', jobId: launched, message: `${network ? 'Se perdió la conexión con la nube.' : jobErrorMessage(err)} Si el trabajo alcanzó a lanzarse sigue en la nube: consúltalo de nuevo antes de relanzar.` })
      }
    } catch (err) {
      if (ctrl.signal.aborted) return
      setFlow(failureOf(err))
    }
  }

  /** Vuelve a consultar un trabajo ya lanzado. No lanza ni cobra nada. */
  const resume = async (): Promise<void> => {
    const cloud = controller.cloud
    if (flow.kind !== 'pending') return
    const jobId = flow.jobId
    if (!cloud) {
      setFlow({ kind: 'pending', jobId, message: 'Necesitas una sesión de nube activa para consultar el trabajo.' })
      return
    }
    const saved = readPendingJobV2(pendingStorage(), sessionId, kind)
    const live = contextRef.current?.jobId === jobId ? contextRef.current.prepared : null
    const restored = saved && saved.jobId === jobId ? codec.restore(saved.context) : null
    const prepared: Prepared<C> | null = live ?? (saved && restored ? { request: saved.request, context: restored.context } : null)
    const ctrl = begin()
    setFlow({ kind: 'running', state: null })
    try {
      const final = await resumeJobV2(cloud, sessionId, jobId, {
        signal: ctrl.signal,
        onState: (state) => {
          if (!ctrl.signal.aborted && state.status !== 'SUCCEEDED' && state.status !== 'FAILED') setFlow({ kind: 'running', state })
        },
      })
      if (!final || ctrl.signal.aborted) return
      if (final.status === 'SUCCEEDED' && !prepared) {
        // Sin el contexto guardado no se puede armar el resultado en esta seccion.
        forgetPending()
        setFlow({ kind: 'failed', title: 'RESULTADO SIN CONTEXTO', message: 'El trabajo terminó, pero este equipo ya no tiene los datos para agregarlo a la sesión. El audio quedó en la nube de la sesión.', retry: false })
        return
      }
      settle(final, prepared as Prepared<C>)
    } catch (err) {
      if (ctrl.signal.aborted) return
      if (err instanceof StemCloudError && err.code === 'no_job') {
        // La nube no conoce ese trabajo: nunca llego a lanzarse, asi que no se cobro.
        forgetPending()
        setFlow({ kind: 'failed', title: 'EL TRABAJO NO LLEGÓ A LANZARSE', message: 'La nube no tiene ese trabajo: no se cobró. Puedes lanzarlo de nuevo.', retry: true })
        return
      }
      setFlow({ kind: 'pending', jobId, message: `${jobErrorMessage(err)} El trabajo sigue en la nube: consúltalo de nuevo más tarde.` })
    }
  }

  /** Deja de seguir un trabajo pendiente. No lo cancela en la nube ni devuelve el cobro. */
  const forget = () => {
    abortRef.current?.abort()
    forgetPending()
    setFlow({ kind: 'idle' })
  }

  const reset = () => {
    abortRef.current?.abort()
    forgetPending()
    setFlow({ kind: 'idle' })
  }

  return { flow, quote, confirm, reset, resume, forget }
}

interface FlowViewProps<C> {
  flow: Flow<C>
  /** Quien cobra: "Music AI", "Google (Lyria)"... */
  provider: string
  onConfirm: () => void
  onCancel: () => void
  onRetry: () => void
  /** Volver a consultar un trabajo ya lanzado (no cobra). */
  onResume: () => void
  /** Dejar de seguir un trabajo pendiente. */
  onForget: () => void
  testId: string
}

/** Lo comun de un trabajo en curso: progreso, costo y confirmacion, espera y fallo. */
function JobFlowView<C>({ flow, provider, onConfirm, onCancel, onRetry, onResume, onForget, testId }: FlowViewProps<C>) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // El foco va a CANCELAR: gastar creditos nunca es la accion por defecto.
  useEffect(() => {
    if (flow.kind === 'confirm') cancelRef.current?.focus({ preventScroll: true })
  }, [flow.kind])

  if (flow.kind === 'working') {
    return (
      <div className="stu-form-row" aria-live="polite" data-testid={`${testId}-working`}>
        <span className="stu-label">{flow.text}</span>
        <div className="stu-progress" data-indeterminate={flow.fraction === null} aria-hidden="true">
          <div style={flow.fraction === null ? undefined : { transform: `scaleX(${flow.fraction})` }} />
        </div>
        <button type="button" className="stu-btn" data-tone="ghost" onClick={onCancel}>
          CANCELAR
        </button>
      </div>
    )
  }
  if (flow.kind === 'confirm') {
    return (
      <div className="stu-confirm" role="alertdialog" aria-label="Confirmar el costo del trabajo" data-testid={`${testId}-confirm`}>
        <p>
          <strong>{estimateText(flow.estimate)}</strong>
        </p>
        <p className="stu-help">
          Gasta créditos de {provider} y no se puede deshacer el cobro. El resultado no cambia la sesión hasta que lo aceptes.
        </p>
        <div className="stu-actions" data-align="end">
          <button ref={cancelRef} type="button" className="stu-btn" onClick={onCancel} data-testid={`${testId}-cancel`}>
            <X size={13} />
            CANCELAR
          </button>
          <button type="button" className="stu-btn" data-tone="primary" disabled={!flow.estimate.allowed} onClick={onConfirm} title={flow.estimate.allowed ? undefined : 'Pasaría el tope mensual de la banda'} data-testid={`${testId}-launch`}>
            LANZAR POR {formatUsd(flow.estimate.estimatedCostUsd)}
          </button>
        </div>
      </div>
    )
  }
  if (flow.kind === 'running') {
    const importing = flow.state?.status === 'IMPORTING' && flow.state.total > 0 ? flow.state.done / flow.state.total : null
    return (
      <div className="stu-form-row" aria-live="polite" data-testid={`${testId}-running`}>
        <span className="stu-label">{flow.state ? jobStatusTextV2(flow.state) : 'LANZANDO EL TRABAJO...'}</span>
        <div className="stu-progress" data-indeterminate={importing === null} aria-hidden="true">
          <div style={importing === null ? undefined : { transform: `scaleX(${importing})` }} />
        </div>
        <p className="stu-help">Puede tardar unos minutos. Puedes seguir editando; no cierres la sesión hasta que termine.</p>
      </div>
    )
  }
  if (flow.kind === 'pending') {
    return (
      <div className="stu-notice" data-tone="warn" role="alert" data-testid={`${testId}-pending`}>
        <span>
          <strong>TRABAJO PENDIENTE.</strong> {flow.message}
        </span>
        <div className="stu-notice-actions">
          <button type="button" className="stu-btn" data-tone="primary" onClick={onResume} title="Consulta el trabajo ya lanzado. No cobra de nuevo" data-testid={`${testId}-resume`}>
            <RefreshCw size={12} />
            CONSULTAR DE NUEVO
          </button>
          <button type="button" className="stu-btn" data-tone="ghost" onClick={onForget} title="Deja de seguir este trabajo. No lo cancela ni devuelve el cobro; su audio queda en la nube de la sesión" data-testid={`${testId}-forget`}>
            OLVIDAR
          </button>
        </div>
      </div>
    )
  }
  if (flow.kind === 'failed') {
    return (
      <div className="stu-notice" data-tone={flow.retry ? 'error' : 'warn'} role="alert" data-testid={`${testId}-failed`}>
        <span>
          <strong>{flow.title}.</strong> {flow.message}
        </span>
        <div className="stu-notice-actions">
          {flow.retry && (
            <button type="button" className="stu-btn" onClick={onRetry} title="Vuelve a pedir el costo antes de lanzar">
              <RefreshCw size={12} />
              REINTENTAR
            </button>
          )}
          <button type="button" className="stu-btn" data-tone="ghost" onClick={onCancel}>
            ENTENDIDO
          </button>
        </div>
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Ayudas de audio
// ---------------------------------------------------------------------------

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const channels = [buffer.getChannelData(0)]
  if (buffer.numberOfChannels > 1) channels.push(buffer.getChannelData(1))
  return channels
}

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

function clampTarget(value: number): number {
  return Number.isFinite(value) ? Math.min(JOB_TARGET_LUFS_MAX, Math.max(JOB_TARGET_LUFS_MIN, value)) : JOB_DEFAULT_TARGET_LUFS
}

function lufsText(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} LUFS` : 'silencio'
}

/** Sesion con la ultima pista (la recien agregada) en mute. */
function muteLastTrack(session: StudioSession): StudioSession {
  const last = session.tracks[session.tracks.length - 1]
  return last ? updateTrack(session, { trackId: last.id, patch: { mute: true } }) : session
}

const TargetField: React.FC<{ value: number; onChange: (value: number) => void; disabled: boolean; id: string }> = ({ value, onChange, disabled, id }) => (
  <label className="stu-form-row" htmlFor={id}>
    <span className="stu-label">Volumen objetivo (LUFS)</span>
    <input
      id={id}
      type="number"
      className="stu-field"
      min={JOB_TARGET_LUFS_MIN}
      max={JOB_TARGET_LUFS_MAX}
      step={0.5}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      onBlur={() => onChange(clampTarget(value))}
    />
  </label>
)

/**
 * Comparacion A/B fuera del motor: dos fuentes arrancan juntas y solo cambia cual se oye, con un
 * cruce corto. Los niveles llegan ya igualados (nunca se sube ninguna: se baja la mas fuerte).
 */
class AbPlayer {
  private readonly ctx: AudioContext
  private sources: AudioBufferSourceNode[] = []
  private gains: GainNode[] = []
  private readonly levels: readonly [number, number]
  private readonly buffers: readonly [AudioBuffer, AudioBuffer]

  constructor(ctx: AudioContext, a: AudioBuffer, b: AudioBuffer, gainADb: number, gainBDb: number) {
    this.ctx = ctx
    this.buffers = [a, b]
    this.levels = [Math.pow(10, gainADb / 20), Math.pow(10, gainBDb / 20)]
  }

  start(which: 0 | 1, onEnded: () => void): void {
    this.stop()
    const at = this.ctx.currentTime + 0.05
    this.buffers.forEach((buffer, index) => {
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      const gain = this.ctx.createGain()
      gain.gain.value = index === which ? this.levels[index] : 0
      source.connect(gain).connect(this.ctx.destination)
      source.start(at)
      this.sources.push(source)
      this.gains.push(gain)
    })
    // Termina cuando acaba la mas larga.
    const longest = this.buffers[0].duration >= this.buffers[1].duration ? 0 : 1
    const sources = this.sources
    sources[longest].onended = () => {
      if (this.sources === sources) onEnded()
    }
  }

  select(which: 0 | 1): void {
    const now = this.ctx.currentTime
    this.gains.forEach((gain, index) => gain.gain.setTargetAtTime(index === which ? this.levels[index] : 0, now, 0.012))
  }

  stop(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Una fuente que no llego a arrancar no se puede detener: basta con desconectarla.
      }
      source.disconnect()
    }
    for (const gain of this.gains) gain.disconnect()
    this.sources = []
    this.gains = []
  }
}

// ---------------------------------------------------------------------------
// MASTERIZAR (Music AI) y normalizar en este equipo
// ---------------------------------------------------------------------------

interface MasterContext {
  /** La mezcla que se envio, para la comparacion A/B. null al retomar el trabajo tras recargar: se vuelve a exportar. */
  mix: AudioBuffer | null
  mixLufs: number
}

const MASTER_CODEC: ContextCodec<MasterContext> = {
  save: (context) => ({ mixLufs: context.mixLufs }),
  restore: (saved) => {
    const mixLufs = (saved as { mixLufs?: unknown } | null)?.mixLufs
    return typeof mixLufs === 'number' && Number.isFinite(mixLufs) ? { context: { mix: null, mixLufs } } : null
  },
}

type AbState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; blob: Blob; trimDb: number; masterLufs: number } | { status: 'failed'; message: string }

type NormState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; blob: Blob; beforeLufs: number; afterLufs: number; gainDb: number; limited: boolean; target: number }
  | { kind: 'failed'; message: string }

const MasterSection: React.FC<{ controller: StudioController; canRun: boolean; hasAudio: boolean }> = ({ controller, canRun, hasAudio }) => {
  const [target, setTarget] = useState(JOB_DEFAULT_TARGET_LUFS)
  const { flow, quote, confirm, reset, resume, forget } = useJobFlow<MasterContext>(controller, 'master', MASTER_CODEC)
  const [ab, setAb] = useState<AbState>({ status: 'idle' })
  const [playing, setPlaying] = useState(false)
  const [which, setWhich] = useState<0 | 1>(1)
  const [accepting, setAccepting] = useState(false)
  const [norm, setNorm] = useState<NormState>({ kind: 'idle' })
  const playerRef = useRef<AbPlayer | null>(null)
  /** Master ya decodificado para la comparacion (no esta en la sesion hasta que se acepta). */
  const masterRef = useRef<AudioBuffer | null>(null)
  /** Mezcla vuelta a exportar para el A/B de un trabajo retomado. */
  const mixAgainRef = useRef<AudioBuffer | null>(null)

  useEffect(
    () => () => {
      playerRef.current?.stop()
    },
    []
  )

  const stopPlayer = () => {
    playerRef.current?.stop()
    playerRef.current = null
    setPlaying(false)
  }

  const start = () => {
    stopPlayer()
    masterRef.current = null
    mixAgainRef.current = null
    setAb({ status: 'idle' })
    void quote(async ({ signal, progress }) => {
      const cloud = controller.cloud
      if (!cloud) throw new Error('Necesitas una sesión de nube activa.')
      const session = controller.snapshot().session
      progress('EXPORTANDO LA MEZCLA...')
      const mix = await renderMix(session, controller.engine.getBuffers(), { sampleRate: session.sampleRate, signal })
      const channels = channelsOf(mix)
      const mixLufs = integratedLufs(channels, mix.sampleRate)
      if (!Number.isFinite(mixLufs)) throw new Error('La mezcla es silencio: no hay nada que masterizar.')
      // La mezcla va directo a la nube: no es un audio de la sesion ni se guarda en este equipo.
      const id = newStudioId('ast')
      const file = assetFileName(id, 'wav')
      const blob = new Blob([encodeWavPcm(channels, mix.sampleRate, 24)], { type: 'audio/wav' })
      return {
        request: { kind: 'master', assetId: id, durationS: Math.min(STUDIO_MAX_SESSION_SECONDS, mix.duration), targetLufs: clampTarget(target) },
        upload: async () => {
          await studioCloud.putAsset(cloud, controller.sessionId, file, blob)
        },
        context: { mix, mixLufs },
      }
    })
  }

  const discard = () => {
    stopPlayer()
    masterRef.current = null
    setAb({ status: 'idle' })
    reset()
  }

  const done = flow.kind === 'done' && 'assets' in flow.state ? { asset: flow.state.assets[0] as StudioJobAsset | undefined, context: flow.prepared.context, costUsd: flow.state.costUsd } : null

  const toggleAb = async (jobAsset: StudioJobAsset, context: MasterContext) => {
    if (playing) {
      stopPlayer()
      return
    }
    const cloud = controller.cloud
    if (!cloud) return
    try {
      const ctx = controller.engine.getContext()
      let ready = ab.status === 'ready' ? ab : null
      let master = ready ? masterRef.current : null
      if (!ready || !master) {
        setAb({ status: 'loading' })
        const blob = ready?.blob ?? (await studioCloud.getAsset(cloud, controller.sessionId, jobAsset.file))
        master = await ctx.decodeAudioData(await blob.arrayBuffer())
        masterRef.current = master
        const masterLufs = integratedLufs(channelsOf(master), master.sampleRate)
        // Igualado en volumen: se baja el mas fuerte hasta el otro (delta > 0 = master mas fuerte).
        const delta = Number.isFinite(masterLufs) ? masterLufs - context.mixLufs : 0
        ready = { status: 'ready', blob, trimDb: delta, masterLufs }
        setAb(ready)
      }
      controller.pause()
      if (ctx.state === 'suspended') await ctx.resume()
      // Al retomar el trabajo tras recargar no queda la mezcla enviada: se exporta la de ahora.
      const current = controller.snapshot().session
      const mix = context.mix ?? (mixAgainRef.current ??= await renderMix(current, controller.engine.getBuffers(), { sampleRate: current.sampleRate }))
      const player = new AbPlayer(ctx, mix, master, ready.trimDb < 0 ? ready.trimDb : 0, ready.trimDb > 0 ? -ready.trimDb : 0)
      playerRef.current = player
      player.start(which, () => {
        playerRef.current = null
        setPlaying(false)
      })
      setPlaying(true)
    } catch (err) {
      setAb({ status: 'failed', message: errorText(err, 'No se pudo bajar el master para escucharlo.') })
    }
  }

  const pick = (next: 0 | 1) => {
    setWhich(next)
    playerRef.current?.select(next)
  }

  const accept = async (jobAsset: StudioJobAsset) => {
    stopPlayer()
    setAccepting(true)
    try {
      const asset = await controller.adoptCloudAsset(jobAsset, { blob: ab.status === 'ready' ? ab.blob : undefined })
      const next = muteLastTrack(controller.addAssetAsTrack(controller.snapshot().session, asset, { name: 'Master' }))
      controller.apply(next, 'Agregar pista Master')
      controller.notify('info', 'La pista Master entró silenciada para no sumarse a la mezcla. Para oírla en la sesión ponla en solo; pasa por el master de la sesión.')
      setAb({ status: 'idle' })
      reset()
    } catch (err) {
      controller.notify('error', errorText(err, 'No se pudo agregar el master a la sesión.'))
    } finally {
      setAccepting(false)
    }
  }

  // ---- normalizacion en este equipo (sin nube y sin costo) ----

  const normalize = async () => {
    setNorm({ kind: 'working' })
    try {
      const session = controller.snapshot().session
      const goal = clampTarget(target)
      const mix = await renderMix(session, controller.engine.getBuffers(), { sampleRate: session.sampleRate })
      const channels = channelsOf(mix)
      const beforeLufs = integratedLufs(channels, mix.sampleRate)
      if (!Number.isFinite(beforeLufs)) throw new Error('La mezcla es silencio: no hay nada que normalizar.')
      const peak = truePeakDb(channels, mix.sampleRate)
      const gainDb = gainToTargetLufs(beforeLufs, goal, peak, -1)
      const gain = Math.pow(10, gainDb / 20)
      for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain
      const blob = new Blob([encodeWavPcm(channels, mix.sampleRate, 24)], { type: 'audio/wav' })
      setNorm({ kind: 'done', blob, beforeLufs, afterLufs: beforeLufs + gainDb, gainDb, limited: gainDb < goal - beforeLufs - 0.05, target: goal })
    } catch (err) {
      setNorm({ kind: 'failed', message: errorText(err, 'No se pudo normalizar la mezcla.') })
    }
  }

  const addNormalized = async (result: Extract<NormState, { kind: 'done' }>) => {
    setAccepting(true)
    try {
      const label = `Mezcla ${result.afterLufs.toFixed(1)} LUFS`
      const { asset } = await controller.ingestAudio(result.blob, 'mezcla_normalizada.wav', 'bounce', label)
      const next = muteLastTrack(controller.addAssetAsTrack(controller.snapshot().session, asset, { name: 'Mezcla normalizada' }))
      controller.apply(next, 'Agregar mezcla normalizada')
      controller.notify('info', 'La mezcla normalizada entró como pista silenciada, para no sumarse a la mezcla.')
      setNorm({ kind: 'idle' })
    } catch (err) {
      controller.notify('error', errorText(err, 'No se pudo agregar la mezcla normalizada.'))
    } finally {
      setAccepting(false)
    }
  }

  const idle = flow.kind === 'idle' || flow.kind === 'failed'

  return (
    <details className="stu-job" open data-testid="studio-job-master">
      <summary>
        <span>MASTERIZAR</span>
        <span className="stu-label">Music AI</span>
      </summary>
      <div className="stu-job-body">
        <p className="stu-help">Exporta la mezcla, la sube y Music AI devuelve un master al volumen pedido. El master llega como audio nuevo: tú decides si entra a la sesión.</p>
        <TargetField id="studio-master-target" value={target} onChange={setTarget} disabled={!idle || norm.kind === 'working'} />
        {idle && (
          <div className="stu-actions">
            <button type="button" className="stu-btn" data-tone="primary" disabled={!canRun || !hasAudio} onClick={start} data-testid="studio-master-start">
              <Sparkles size={13} />
              MASTERIZAR...
            </button>
            <button type="button" className="stu-btn" disabled={!hasAudio || norm.kind === 'working'} onClick={() => void normalize()} title="Sin nube y sin costo: sube o baja la mezcla hasta el volumen objetivo, sin pasar de -1 dBTP" data-testid="studio-normalize">
              {norm.kind === 'working' ? 'NORMALIZANDO...' : 'NORMALIZAR AQUÍ'}
            </button>
          </div>
        )}
        <JobFlowView flow={flow} provider="Music AI" onConfirm={() => void confirm()} onCancel={discard} onRetry={start} onResume={() => void resume()} onForget={forget} testId="studio-master" />

        {done && !done.asset && (
          <div className="stu-notice" data-tone="warn" role="status">
            <span>El trabajo terminó sin devolver audio.</span>
            <button type="button" className="stu-btn" data-tone="ghost" onClick={discard}>
              ENTENDIDO
            </button>
          </div>
        )}
        {done && done.asset && (
          <div className="stu-result" data-testid="studio-master-result">
            <strong>MASTER LISTO: {done.asset.label}</strong>
            <span className="stu-help">
              {done.costUsd !== null ? `Costo anotado: ${formatUsd(done.costUsd)}. ` : ''}Mezcla enviada: {lufsText(done.context.mixLufs)}.
              {ab.status === 'ready' ? ` Master: ${lufsText(ab.masterLufs)}.` : ''}
            </span>
            <div className="stu-actions">
              <button type="button" className="stu-btn" data-on={playing} data-accent="play" aria-pressed={playing} disabled={ab.status === 'loading'} onClick={() => void toggleAb(done.asset as StudioJobAsset, done.context)} data-testid="studio-ab-play">
                {playing ? <Square size={12} /> : <Play size={12} />}
                {ab.status === 'loading' ? 'BAJANDO...' : playing ? 'DETENER' : 'ESCUCHAR A/B'}
              </button>
              <div className="stu-seg" role="group" aria-label="Qué se oye en la comparación">
                <button type="button" className="stu-btn" data-on={which === 0} aria-pressed={which === 0} onClick={() => pick(0)} data-testid="studio-ab-a">
                  A · MEZCLA
                </button>
                <button type="button" className="stu-btn" data-on={which === 1} aria-pressed={which === 1} onClick={() => pick(1)} data-testid="studio-ab-b">
                  B · MASTER
                </button>
              </div>
            </div>
            <p className="stu-help">
              {ab.status === 'ready'
                ? Math.abs(ab.trimDb) < 0.05
                  ? 'Los dos suenan al mismo volumen: no hizo falta igualar.'
                  : `Igualados en volumen: ${ab.trimDb > 0 ? 'el master' : 'la mezcla'} suena ${Math.abs(ab.trimDb).toFixed(1)} dB más bajo solo en esta comparación, para que no gane el más fuerte.`
                : 'La comparación iguala el volumen de los dos, para juzgar el sonido y no cuál suena más fuerte.'}
            </p>
            {ab.status === 'failed' && (
              <p className="stu-help" role="alert" data-tone="error">
                {ab.message}
              </p>
            )}
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" disabled={accepting} onClick={discard}>
                DESCARTAR
              </button>
              <button type="button" className="stu-btn" data-tone="primary" disabled={accepting} onClick={() => void accept(done.asset as StudioJobAsset)} data-testid="studio-master-accept">
                <Check size={13} />
                {accepting ? 'AGREGANDO...' : 'AGREGAR PISTA MASTER'}
              </button>
            </div>
          </div>
        )}

        {norm.kind === 'failed' && (
          <div className="stu-notice" data-tone="error" role="alert">
            <span>{norm.message}</span>
            <button type="button" className="stu-btn" data-tone="ghost" onClick={() => setNorm({ kind: 'idle' })}>
              ENTENDIDO
            </button>
          </div>
        )}
        {norm.kind === 'done' && (
          <div className="stu-result" data-testid="studio-normalize-result">
            <strong>MEZCLA NORMALIZADA EN ESTE EQUIPO</strong>
            <span className="stu-help">
              De {lufsText(norm.beforeLufs)} a {lufsText(norm.afterLufs)} ({norm.gainDb >= 0 ? '+' : ''}
              {norm.gainDb.toFixed(1)} dB).
              {norm.limited ? ` No llega a ${norm.target.toFixed(1)} LUFS: subir más pasaría el pico real de -1 dBTP. Para más volumen hace falta masterizar.` : ''} Solo cambia el volumen: no comprime ni ecualiza.
            </span>
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" disabled={accepting} onClick={() => setNorm({ kind: 'idle' })}>
                DESCARTAR
              </button>
              <button type="button" className="stu-btn" onClick={() => saveBlob(`${slugify(controller.snapshot().session.title)}_${norm.afterLufs.toFixed(0)}lufs.wav`, norm.blob)}>
                <Download size={13} />
                DESCARGAR
              </button>
              <button type="button" className="stu-btn" data-tone="primary" disabled={accepting} onClick={() => void addNormalized(norm)} data-testid="studio-normalize-accept">
                AGREGAR COMO PISTA
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// SEPARAR un audio en stems (Music AI)
// ---------------------------------------------------------------------------

interface SeparateContext {
  assetId: string
}

const SEPARATE_CODEC: ContextCodec<SeparateContext> = {
  save: (context) => context,
  restore: (saved) => {
    const assetId = (saved as { assetId?: unknown } | null)?.assetId
    return typeof assetId === 'string' ? { context: { assetId } } : null
  },
}

const SeparateSection: React.FC<{ controller: StudioController; session: StudioSession; canRun: boolean }> = ({ controller, session, canRun }) => {
  const candidates = session.assets.filter((asset) => asset.kind !== 'stem')
  const [picked, setPicked] = useState('')
  const { flow, quote, confirm, reset, resume, forget } = useJobFlow<SeparateContext>(controller, 'separate', SEPARATE_CODEC)
  const [accepting, setAccepting] = useState<{ done: number; total: number } | null>(null)
  const assetId = candidates.some((asset) => asset.id === picked) ? picked : (candidates.find((asset) => asset.kind === 'import')?.id ?? candidates[0]?.id ?? '')
  const idle = flow.kind === 'idle' || flow.kind === 'failed'

  const start = () => {
    const asset = controller.snapshot().session.assets.find((item) => item.id === assetId)
    if (!asset) return
    void quote(async () => ({
      request: { kind: 'separate', assetId: asset.id, durationS: Math.min(STUDIO_MAX_SESSION_SECONDS, asset.durationS) },
      upload: () => controller.ensureAssetInCloud(asset.file),
      context: { assetId: asset.id },
    }))
  }

  const stems = flow.kind === 'done' && 'assets' in flow.state ? flow.state.assets : null

  const accept = async (jobAssets: readonly StudioJobAsset[], sourceId: string) => {
    setAccepting({ done: 0, total: jobAssets.length })
    try {
      const adopted: { job: StudioJobAsset; asset: Awaited<ReturnType<StudioController['adoptCloudAsset']>> }[] = []
      for (const job of jobAssets) {
        adopted.push({ job, asset: await controller.adoptCloudAsset(job) })
        setAccepting({ done: adopted.length, total: jobAssets.length })
      }
      // Los stems caen donde esta el audio original (su primer clip), para quedar alineados.
      let next = controller.snapshot().session
      const source = next.tracks.flatMap((track) => track.clips).find((clip) => clip.assetId === sourceId)
      const origin = source ? source.startS - source.offsetS : 0
      let skipped = 0
      for (const { job, asset } of adopted) {
        if (next.tracks.length >= STUDIO_MAX_TRACKS) {
          skipped++
          continue
        }
        next = controller.addAssetAsTrack(next, asset, { name: job.label || 'Stem', role: job.role ?? 'unknown', startS: Math.max(0, origin), offsetS: Math.max(0, -origin) })
      }
      controller.apply(next, 'Agregar stems separados')
      if (skipped > 0) controller.notify('warn', `La sesión llegó a ${STUDIO_MAX_TRACKS} pistas: ${skipped} ${skipped === 1 ? 'stem quedó' : 'stems quedaron'} sin agregar. Quita pistas y vuelve a separar, o impórtalos desde la nube.`)
      reset()
    } catch (err) {
      controller.notify('error', errorText(err, 'No se pudieron agregar los stems a la sesión.'))
    } finally {
      setAccepting(null)
    }
  }

  return (
    <details className="stu-job" data-testid="studio-job-separate">
      <summary>
        <span>SEPARAR EN STEMS</span>
        <span className="stu-label">Music AI</span>
      </summary>
      <div className="stu-job-body">
        <p className="stu-help">Separa un audio de la sesión en voz, batería, bajo y demás. Cada stem entra como una pista nueva, alineada con el original.</p>
        {candidates.length === 0 ? (
          <p className="stu-help">Importa primero un audio completo (una canción o una maqueta) a la sesión.</p>
        ) : (
          <label className="stu-form-row">
            <span className="stu-label">Audio a separar</span>
            <select className="stu-field" value={assetId} disabled={!idle} onChange={(event) => setPicked(event.target.value)} data-testid="studio-separate-asset">
              {candidates.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.label || asset.file} ({formatTimecode(asset.durationS)})
                </option>
              ))}
            </select>
          </label>
        )}
        {idle && (
          <button type="button" className="stu-btn" data-tone="primary" disabled={!canRun || !assetId} onClick={start} data-testid="studio-separate-start">
            <Sparkles size={13} />
            SEPARAR...
          </button>
        )}
        <JobFlowView flow={flow} provider="Music AI" onConfirm={() => void confirm()} onCancel={reset} onRetry={start} onResume={() => void resume()} onForget={forget} testId="studio-separate" />
        {stems && flow.kind === 'done' && (
          <div className="stu-result" data-testid="studio-separate-result">
            <strong>{jobStatusTextV2(flow.state)}</strong>
            <span className="stu-help">{stems.map((stem) => stem.label).join(', ') || 'Sin stems.'}</span>
            {accepting && <span className="stu-label">BAJANDO STEMS {accepting.done}/{accepting.total}...</span>}
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" disabled={accepting !== null} onClick={reset}>
                DESCARTAR
              </button>
              <button type="button" className="stu-btn" data-tone="primary" disabled={accepting !== null || stems.length === 0} onClick={() => void accept(stems, flow.prepared.context.assetId)} data-testid="studio-separate-accept">
                <Check size={13} />
                AGREGAR {stems.length} {stems.length === 1 ? 'PISTA' : 'PISTAS'}
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// GENERAR con Lyria (por URiT IA, STUDIO_V2.md 4.6)
// ---------------------------------------------------------------------------

/**
 * Hasta esta duracion el Worker usa el clip corto de Lyria, que entrega 30 s siempre; mas largo,
 * el modelo de canciones, que toma la duracion como una indicacion del texto. Se cobra por cancion.
 */
const LYRIA_CLIP_SECONDS = 30

interface GenerateContext {
  prompt: string
  lengthS: number
}

const GENERATE_CODEC: ContextCodec<GenerateContext> = {
  save: (context) => context,
  restore: (saved) => {
    const s = saved as { prompt?: unknown; lengthS?: unknown } | null
    return s && typeof s.prompt === 'string' && typeof s.lengthS === 'number' && Number.isFinite(s.lengthS) ? { context: { prompt: s.prompt, lengthS: s.lengthS } } : null
  },
}

const GenerateSection: React.FC<{ controller: StudioController; session: StudioSession; canRun: boolean }> = ({ controller, session, canRun }) => {
  const [prompt, setPrompt] = useState('')
  const [bars, setBars] = useState(8)
  const [instrumental, setInstrumental] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const { flow, quote, confirm, reset, resume, forget } = useJobFlow<GenerateContext>(controller, 'generate', GENERATE_CODEC)
  const idle = flow.kind === 'idle' || flow.kind === 'failed'
  const safeBars = Number.isFinite(bars) && bars >= 1 ? Math.round(bars) : 1
  const wantedS = barsToSeconds(session, safeBars)
  const outOfRange = wantedS < JOB_GENERATE_SECONDS_MIN || wantedS > JOB_GENERATE_SECONDS_MAX

  const start = () => {
    const text = prompt.trim()
    if (!text) return
    void quote(async () => {
      const current = controller.snapshot().session
      const request = generateRequestForSession(current, { provider: 'lyria', prompt: text, bars: safeBars, instrumental })
      return { request, context: { prompt: text, lengthS: barsToSeconds(current, safeBars) } }
    })
  }

  const generated = flow.kind === 'done' && 'assets' in flow.state ? flow.state.assets[0] : undefined

  const accept = async (job: StudioJobAsset, context: GenerateContext) => {
    setAccepting(true)
    try {
      const asset = await controller.adoptCloudAsset(job)
      // El nombre de la pista lleva "IA": queda marcada en la cabecera, la mezcla y el inspector.
      let next = controller.addAssetAsTrack(controller.snapshot().session, asset, { name: `IA: ${context.prompt}`.slice(0, 40) })
      const clip = next.tracks[next.tracks.length - 1]?.clips[0]
      // El proveedor puede devolver mas de lo pedido: el clip se recorta a los compases pedidos.
      if (clip && clip.lengthS > context.lengthS + 0.01) next = trimClip(next, { clipId: clip.id, edge: 'end', toS: clip.startS + context.lengthS })
      controller.apply(next, 'Agregar audio generado por IA')
      reset()
    } catch (err) {
      controller.notify('error', errorText(err, 'No se pudo agregar el audio generado.'))
    } finally {
      setAccepting(false)
    }
  }

  return (
    <details className="stu-job" data-testid="studio-job-generate">
      <summary>
        <span>GENERAR AUDIO</span>
        <span className="stu-label">Lyria</span>
      </summary>
      <div className="stu-job-body">
        <div className="stu-form-row">
          <span className="stu-label" id="studio-generate-provider">
            Proveedor
          </span>
          <div className="stu-seg" role="group" aria-labelledby="studio-generate-provider">
            <button type="button" className="stu-btn" data-on="true" aria-pressed="true">
              LYRIA
            </button>
            <button type="button" className="stu-btn" disabled aria-pressed="false" title="Suno no tiene todavía una API con acceso oficial" data-testid="studio-generate-suno">
              SUNO · SIN ACCESO OFICIAL
            </button>
          </div>
        </div>
        <label className="stu-form-row">
          <span className="stu-param-head">
            <span className="stu-label">Qué generar</span>
            <span className="stu-label">
              {prompt.length}/{STUDIO_MAX_PROMPT}
            </span>
          </span>
          <textarea
            className="stu-field stu-textarea"
            rows={3}
            value={prompt}
            maxLength={STUDIO_MAX_PROMPT}
            disabled={!idle}
            placeholder="Pad cálido de sintetizador, sin batería"
            onChange={(event) => setPrompt(event.target.value)}
            aria-describedby="studio-generate-prompt-help"
            data-testid="studio-generate-prompt"
          />
        </label>
        <p className="stu-help" id="studio-generate-prompt-help">
          El tempo, la tonalidad y la duración se agregan solos al texto. Puedes marcar secciones ([Verse], [Chorus]) o tiempos ([0:00 - 0:10]). Lyria rechaza voces de artistas reales y letras con derechos.
        </p>
        <label className="stu-form-row">
          <span className="stu-label">Duración en compases</span>
          <input type="number" className="stu-field" min={1} max={128} step={1} value={bars} disabled={!idle} onChange={(event) => setBars(Number(event.target.value))} data-testid="studio-generate-bars" />
        </label>
        <dl className="stu-kv">
          <dt>Tempo de la sesión</dt>
          <dd>
            {session.bpm} BPM · {session.beatsPerBar} por compás
          </dd>
          <dt>Tonalidad</dt>
          <dd>{session.key ?? 'sin definir'}</dd>
          <dt>Duración pedida</dt>
          <dd>{wantedS.toFixed(1)} s</dd>
          <dt>Modelo</dt>
          <dd data-testid="studio-generate-model">{wantedS <= LYRIA_CLIP_SECONDS ? 'Clip corto (30 s)' : 'Canción'}</dd>
        </dl>
        <p className="stu-help" data-testid="studio-generate-length-note">
          {wantedS <= LYRIA_CLIP_SECONDS
            ? 'El clip corto de Lyria dura siempre 30 s: si pides menos, llega de 30 s y el clip se recorta a los compases al agregarlo.'
            : 'La duración va como indicación en el texto: Lyria no la garantiza. Si llega más largo, el clip se recorta a los compases; si llega más corto, queda como llegó.'}{' '}
          Se cobra por canción, no por segundo: el costo estimado aparece antes de confirmar.
        </p>
        {outOfRange && (
          <p className="stu-help" data-tone="warn">
            Se puede pedir entre {JOB_GENERATE_SECONDS_MIN} y {JOB_GENERATE_SECONDS_MAX} segundos: se pedirá {Math.min(JOB_GENERATE_SECONDS_MAX, Math.max(JOB_GENERATE_SECONDS_MIN, wantedS)).toFixed(0)} s y el clip se recorta a los compases.
          </p>
        )}
        <label className="stu-check">
          <input type="checkbox" checked={instrumental} disabled={!idle} onChange={(event) => setInstrumental(event.target.checked)} />
          <span>Instrumental (sin voz)</span>
        </label>
        {idle && (
          <button type="button" className="stu-btn" data-tone="primary" disabled={!canRun || prompt.trim().length === 0} onClick={start} data-testid="studio-generate-start">
            <Sparkles size={13} />
            GENERAR...
          </button>
        )}
        <JobFlowView flow={flow} provider="Google (Lyria) vía URiT IA" onConfirm={() => void confirm()} onCancel={reset} onRetry={start} onResume={() => void resume()} onForget={forget} testId="studio-generate" />
        {flow.kind === 'done' && (
          <div className="stu-result" data-testid="studio-generate-result">
            <strong>{generated ? `AUDIO GENERADO: ${generated.label}` : 'El trabajo terminó sin devolver audio.'}</strong>
            <p className="stu-ai-note">
              <Sparkles size={13} aria-hidden="true" />
              <span>Entra como pista nueva en el compás 1, marcada como generada por IA en la sesión. Revisa los términos de Lyria antes de publicar música con este audio.</span>
            </p>
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" disabled={accepting} onClick={reset}>
                DESCARTAR
              </button>
              {generated && (
                <button type="button" className="stu-btn" data-tone="primary" disabled={accepting} onClick={() => void accept(generated, flow.prepared.context)} data-testid="studio-generate-accept">
                  <Check size={13} />
                  {accepting ? 'AGREGANDO...' : 'AGREGAR COMO PISTA'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// ASISTENTE DE MEZCLA
// ---------------------------------------------------------------------------

const SuggestionList: React.FC<{ controller: StudioController; session: StudioSession; suggestions: readonly MixSuggestion[]; onClose: () => void }> = ({ controller, session, suggestions, onClose }) => {
  const [handled, setHandled] = useState<Readonly<Record<number, 'applied' | 'discarded'>>>({})
  const visible = suggestionsForSession(session, suggestions)
  const pending = suggestions.filter((item, index) => handled[index] === undefined && visible.includes(item)).length

  const apply = (suggestion: MixSuggestion, index: number) => {
    const title = suggestionTitle(controller.snapshot().session, suggestion)
    const before = controller.snapshot().session
    // Cada sugerencia aceptada es un paso de deshacer propio.
    controller.run(`Asistente: ${title}`, (current) => applyMixSuggestion(current, { suggestion }))
    if (controller.snapshot().session === before) controller.notify('info', `"${title}" ya estaba aplicado: la sesión no cambió.`)
    setHandled((current) => ({ ...current, [index]: 'applied' }))
  }

  return (
    <div className="stu-result" data-testid="studio-assist-result">
      <strong>{suggestions.length === 0 ? 'El asistente no propone cambios: la mezcla ya está cerca del objetivo.' : `${pending} ${pending === 1 ? 'sugerencia pendiente' : 'sugerencias pendientes'}`}</strong>
      <ul className="stu-suggestions">
        {suggestions.map((suggestion, index) => {
          const state = handled[index]
          const gone = !visible.includes(suggestion)
          return (
            <li key={index} data-state={gone ? 'gone' : (state ?? 'pending')} data-testid="studio-suggestion">
              <strong>{suggestionTitle(session, suggestion)}</strong>
              <span>{suggestion.reason}</span>
              {gone ? (
                <span className="stu-label">LA PISTA YA NO EXISTE</span>
              ) : state ? (
                <span className="stu-badge" data-tone={state === 'applied' ? 'ok' : undefined}>
                  {state === 'applied' ? 'APLICADA · CTRL+Z LA DESHACE' : 'DESCARTADA'}
                </span>
              ) : (
                <div className="stu-actions">
                  <button type="button" className="stu-btn" data-size="small" onClick={() => apply(suggestion, index)} data-testid="studio-suggestion-apply">
                    <Check size={12} />
                    APLICAR
                  </button>
                  <button type="button" className="stu-btn" data-size="small" data-tone="ghost" onClick={() => setHandled((current) => ({ ...current, [index]: 'discarded' }))} data-testid="studio-suggestion-discard">
                    DESCARTAR
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <div className="stu-actions" data-align="end">
        <button type="button" className="stu-btn" data-tone="ghost" onClick={onClose}>
          {pending > 0 ? 'DESCARTAR EL RESTO' : 'CERRAR'}
        </button>
      </div>
    </div>
  )
}

/** El asistente no necesita contexto: el resultado se aplica sobre la sesion vigente. */
const ASSIST_CODEC: ContextCodec<null> = { save: () => null, restore: () => ({ context: null }) }

const AssistSection: React.FC<{ controller: StudioController; session: StudioSession; canRun: boolean; hasAudio: boolean }> = ({ controller, session, canRun, hasAudio }) => {
  const [target, setTarget] = useState(JOB_DEFAULT_TARGET_LUFS)
  const { flow, quote, confirm, reset, resume, forget } = useJobFlow<null>(controller, 'assist', ASSIST_CODEC)
  const idle = flow.kind === 'idle' || flow.kind === 'failed'

  const start = () => {
    void quote(async ({ signal, progress }) => {
      // La misma medicion que MEDIR MEZCLA del chat: queda guardada en el controlador y el
      // asistente del chat la recibe en el resumen (STUDIO_V2.md 4.3.2).
      const measured = await controller.measureForChat({ targetLufs: clampTarget(target), signal, progress })
      return { request: { kind: 'assist', metrics: measured.metrics }, context: null }
    })
  }

  const suggestions = flow.kind === 'done' && 'suggestions' in flow.state ? flow.state.suggestions : null

  return (
    <details className="stu-job" data-testid="studio-job-assist">
      <summary>
        <span>ASISTENTE DE MEZCLA</span>
        <span className="stu-label">Modelo de lenguaje</span>
      </summary>
      <div className="stu-job-body">
        <p className="stu-help">Mide cada pista en este equipo (volumen, pico y energía por banda) y manda solo esos números, nunca audio. Propone cambios de fader, EQ y compresor; tú aceptas uno por uno.</p>
        <TargetField id="studio-assist-target" value={target} onChange={setTarget} disabled={!idle} />
        {idle && (
          <button type="button" className="stu-btn" data-tone="primary" disabled={!canRun || !hasAudio} onClick={start} data-testid="studio-assist-start">
            <Sparkles size={13} />
            ANALIZAR LA MEZCLA...
          </button>
        )}
        <JobFlowView flow={flow} provider="el modelo de lenguaje" onConfirm={() => void confirm()} onCancel={reset} onRetry={start} onResume={() => void resume()} onForget={forget} testId="studio-assist" />
        {suggestions && flow.kind === 'done' && <SuggestionList key={flow.state.jobId} controller={controller} session={session} suggestions={suggestions} onClose={reset} />}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// v2 · COMPONER un clip MIDI (modelo de lenguaje)
// ---------------------------------------------------------------------------

const COMPOSE_ROLE_LABELS: Record<ComposeRole, string> = { drums: 'BATERÍA', bass: 'BAJO', chords: 'ACORDES', melody: 'MELODÍA' }

/** Instrumento de la pista nueva cuando el clip compuesto no va a una pista existente. */
const COMPOSE_ROLE_INSTRUMENT: Record<ComposeRole, { type: 'synth' | 'drums'; preset: string; name: string }> = {
  drums: { type: 'drums', preset: 'basico', name: 'IA: Batería' },
  bass: { type: 'synth', preset: 'bajo_sub', name: 'IA: Bajo' },
  chords: { type: 'synth', preset: 'teclas_suaves', name: 'IA: Acordes' },
  melody: { type: 'synth', preset: 'lead_brillante', name: 'IA: Melodía' },
}

interface ComposeContext {
  /** Pista de instrumento destino, o null para crear una. */
  trackId: string | null
  role: ComposeRole
  startBeat: number
}

const COMPOSE_CODEC: ContextCodec<ComposeContext> = {
  save: (context) => context,
  restore: (saved) => {
    const s = saved as Partial<ComposeContext> | null
    if (!s || !COMPOSE_ROLES.includes(s.role as ComposeRole) || typeof s.startBeat !== 'number' || !Number.isFinite(s.startBeat)) return null
    return { context: { trackId: typeof s.trackId === 'string' ? s.trackId : null, role: s.role as ComposeRole, startBeat: s.startBeat } }
  },
}

/** Beat del compas donde esta el cabezal (el clip compuesto empieza ahi). */
function playheadBarBeat(controller: StudioController, session: StudioSession): number {
  const beat = secondsToBeats(controller.engine.position(), session.bpm)
  return Math.max(0, Math.floor(beat / session.beatsPerBar + 1e-6) * session.beatsPerBar)
}

const ComposeSection: React.FC<{ controller: StudioController; session: StudioSession; canRun: boolean }> = ({ controller, session, canRun }) => {
  const [prompt, setPrompt] = useState('')
  const [role, setRole] = useState<ComposeRole>('chords')
  const [bars, setBars] = useState(4)
  const [target, setTarget] = useState('')
  const [accepting, setAccepting] = useState(false)
  const { flow, quote, confirm, reset, resume, forget } = useJobFlow<ComposeContext>(controller, 'compose', COMPOSE_CODEC)
  const idle = flow.kind === 'idle' || flow.kind === 'failed'
  const instrumentTracks = session.tracks.filter((track) => track.kind === 'instrument')
  const targetId = instrumentTracks.some((track) => track.id === target) ? target : ''
  const safeBars = Number.isFinite(bars) ? Math.min(COMPOSE_LENGTH_BARS_MAX, Math.max(COMPOSE_LENGTH_BARS_MIN, Math.round(bars))) : 4

  const start = () => {
    const text = prompt.trim()
    if (!text) return
    void quote(async () => {
      const current = controller.snapshot().session
      const startBeat = playheadBarBeat(controller, current)
      const request = composeRequestForSession(current, { prompt: text, role, lengthBars: safeBars, startBeat })
      return { request, context: { trackId: targetId || null, role, startBeat } }
    })
  }

  const composed = flow.kind === 'done' && flow.state.kind === 'compose' ? flow.state : null

  const accept = (context: ComposeContext) => {
    if (!composed) return
    setAccepting(true)
    const clipId = newStudioId('mid')
    // Pista (si hace falta) y clip en UN paso de deshacer.
    const ok = controller.run('Agregar clip compuesto por IA', (current) => {
      let next = current
      let trackId = context.trackId && findTrack(current, context.trackId)?.kind === 'instrument' ? context.trackId : null
      if (!trackId) {
        const spec = COMPOSE_ROLE_INSTRUMENT[context.role]
        trackId = newStudioId('trk')
        next = addInstrumentTrack(next, { track: defaultInstrumentTrack({ id: trackId, name: spec.name, instrument: defaultInstrument(spec.type, spec.preset) }) })
      }
      return addMidiClip(next, { trackId, clip: composeResultToClip(composed, { clipId, startBeat: context.startBeat }) })
    })
    setAccepting(false)
    if (ok) {
      controller.select(clipId)
      reset()
    }
  }

  return (
    <details className="stu-job" data-testid="studio-job-compose">
      <summary>
        <span>COMPONER MIDI</span>
        <span className="stu-label">Modelo de lenguaje</span>
      </summary>
      <div className="stu-job-body">
        <p className="stu-help">Escribe qué quieres y el asistente compone un clip MIDI con el tempo, la tonalidad y el compás de la sesión. Entra como clip nuevo en el compás del cabezal, solo si lo aceptas.</p>
        <label className="stu-form-row">
          <span className="stu-param-head">
            <span className="stu-label">Qué componer</span>
            <span className="stu-label">
              {prompt.length}/{STUDIO_MAX_PROMPT}
            </span>
          </span>
          <textarea
            className="stu-field stu-textarea"
            rows={3}
            value={prompt}
            maxLength={STUDIO_MAX_PROMPT}
            disabled={!idle}
            placeholder="Acordes de balada en negras, con un cambio al cuarto compás"
            onChange={(event) => setPrompt(event.target.value)}
            data-testid="studio-compose-prompt"
          />
        </label>
        <div className="stu-form-row">
          <span className="stu-label" id="studio-compose-role">
            Rol
          </span>
          <div className="stu-seg" role="group" aria-labelledby="studio-compose-role">
            {COMPOSE_ROLES.map((item) => (
              <button key={item} type="button" className="stu-btn" data-on={role === item} aria-pressed={role === item} disabled={!idle} onClick={() => setRole(item)} data-testid={`studio-compose-role-${item}`}>
                {COMPOSE_ROLE_LABELS[item]}
              </button>
            ))}
          </div>
        </div>
        <label className="stu-form-row">
          <span className="stu-label">Largo en compases</span>
          <input
            type="number"
            className="stu-field"
            min={COMPOSE_LENGTH_BARS_MIN}
            max={COMPOSE_LENGTH_BARS_MAX}
            step={1}
            value={bars}
            disabled={!idle}
            onChange={(event) => setBars(Number(event.target.value))}
            onBlur={() => setBars(safeBars)}
            data-testid="studio-compose-bars"
          />
        </label>
        <label className="stu-form-row">
          <span className="stu-label">Pista</span>
          <select className="stu-field" value={targetId} disabled={!idle} onChange={(event) => setTarget(event.target.value)} data-testid="studio-compose-track">
            <option value="">Pista nueva ({COMPOSE_ROLE_INSTRUMENT[role].name.replace('IA: ', '')})</option>
            {instrumentTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </select>
        </label>
        <dl className="stu-kv">
          <dt>Tempo</dt>
          <dd>
            {session.bpm} BPM · {session.beatsPerBar} por compás
          </dd>
          <dt>Tonalidad</dt>
          <dd>{session.key ?? 'sin definir'}</dd>
        </dl>
        {idle && (
          <button type="button" className="stu-btn" data-tone="primary" disabled={!canRun || prompt.trim().length === 0} onClick={start} data-testid="studio-compose-start">
            <Sparkles size={13} />
            COMPONER...
          </button>
        )}
        <JobFlowView flow={flow} provider="el modelo de lenguaje" onConfirm={() => void confirm()} onCancel={reset} onRetry={start} onResume={() => void resume()} onForget={forget} testId="studio-compose" />
        {flow.kind === 'done' && (
          <div className="stu-result" data-testid="studio-compose-result">
            <strong>{jobStatusTextV2(flow.state)}</strong>
            {composed && (
              <span className="stu-help">
                {composed.description} {composed.notes.length > 0 ? `Clip de ${(composed.lengthBeats / session.beatsPerBar).toFixed(composed.lengthBeats % session.beatsPerBar === 0 ? 0 : 1)} compases.` : ''}
              </span>
            )}
            <p className="stu-ai-note">
              <Sparkles size={13} aria-hidden="true" />
              <span>Entra como clip MIDI nuevo en el compás {Math.floor(flow.prepared.context.startBeat / session.beatsPerBar) + 1}. Puedes editarlo en el piano roll; Ctrl+Z lo quita.</span>
            </p>
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" disabled={accepting} onClick={reset}>
                DESCARTAR
              </button>
              {composed && composed.notes.length > 0 && (
                <button type="button" className="stu-btn" data-tone="primary" disabled={accepting} onClick={() => accept(flow.prepared.context)} data-testid="studio-compose-accept">
                  <Check size={13} />
                  AGREGAR CLIP MIDI
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// v2 · AUDIO A MIDI (en este equipo, sin costo)
// ---------------------------------------------------------------------------

type ToMidiState =
  | { kind: 'idle' }
  | { kind: 'working'; fraction: number | null }
  | { kind: 'done'; clipId: string; trackName: string; startS: number; lengthS: number; bpm: number; notes: StudioMidiNote[] }
  | { kind: 'failed'; message: string }

/** Copia la ventana del clip (offset y largo) a un buffer propio. */
function clipWindow(ctx: BaseAudioContext, buffer: AudioBuffer, offsetS: number, lengthS: number): AudioBuffer | null {
  const sr = buffer.sampleRate
  const from = Math.max(0, Math.floor(offsetS * sr))
  const length = Math.min(buffer.length - from, Math.ceil(lengthS * sr))
  if (length <= 0) return null
  const out = ctx.createBuffer(buffer.numberOfChannels, length, sr)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) out.copyToChannel(buffer.getChannelData(ch).subarray(from, from + length), ch)
  return out
}

const AudioToMidiSection: React.FC<{ controller: StudioController; session: StudioSession; selectedClipId: string | null; recording: boolean }> = ({ controller, session, selectedClipId, recording }) => {
  const [state, setState] = useState<ToMidiState>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const status = useMemo(() => audioToMidiAvailability(), [])
  const loc = selectedClipId ? findClip(session, selectedClipId) : null
  const asset = loc ? session.assets.find((item) => item.id === loc.clip.assetId) : undefined

  useEffect(() => () => abortRef.current?.abort(), [])

  const run = async () => {
    if (!loc) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setState({ kind: 'working', fraction: null })
    try {
      const buffer = controller.engine.getBuffers().get(loc.clip.assetId)
      if (!buffer) throw new Error('El audio de este clip no está cargado en este equipo.')
      if (loc.clip.lengthS > AUDIO_TO_MIDI_MAX_SECONDS) throw new Error('Para pasar a MIDI, el clip debe durar 10 minutos o menos. Divídelo primero.')
      const slice = clipWindow(controller.engine.getContext(), buffer, loc.clip.offsetS, loc.clip.lengthS)
      if (!slice) throw new Error('La ventana del clip está vacía.')
      const bpm = controller.snapshot().session.bpm
      const notes = await transcribe(slice, {
        bpm,
        signal: ctrl.signal,
        onProgress: (fraction) => {
          if (!ctrl.signal.aborted) setState({ kind: 'working', fraction })
        },
      })
      if (ctrl.signal.aborted) return
      setState({ kind: 'done', clipId: loc.clip.id, trackName: loc.track.name, startS: loc.clip.startS, lengthS: loc.clip.lengthS, bpm, notes })
    } catch (err) {
      if (ctrl.signal.aborted || isAbort(err)) return
      setState({ kind: 'failed', message: errorText(err, 'No se pudo pasar el audio a MIDI.') })
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    setState({ kind: 'idle' })
  }

  const accept = (done: Extract<ToMidiState, { kind: 'done' }>) => {
    const clipId = newStudioId('mid')
    const ok = controller.run('Audio a MIDI', (current) => {
      // Si el tempo cambio despues de transcribir, las notas se reescalan para seguir al audio.
      const scale = current.bpm / done.bpm
      const lengthBeats = roundBeat(Math.max(STUDIO_MIDI_MIN_CLIP_BEATS, secondsToBeats(done.lengthS, current.bpm)))
      const scaled = done.notes.map((n) => ({ ...n, start: n.start * scale, length: n.length * scale }))
      const notes = normalizeNotes(scaled, lengthBeats).slice(0, STUDIO_MAX_NOTES_PER_CLIP)
      const trackId = newStudioId('trk')
      const name = `MIDI: ${done.trackName}`.slice(0, STUDIO_MAX_TRACK_NAME)
      const next = addInstrumentTrack(current, { track: defaultInstrumentTrack({ id: trackId, name, instrument: defaultInstrument('synth', 'teclas_suaves') }) })
      return addMidiClip(next, { trackId, clip: defaultMidiClip({ id: clipId, startBeat: roundBeat(secondsToBeats(done.startS, current.bpm)), lengthBeats, notes }) })
    })
    if (ok) {
      controller.select(clipId)
      setState({ kind: 'idle' })
    }
  }

  return (
    <details className="stu-job" data-testid="studio-job-tomidi">
      <summary>
        <span>AUDIO A MIDI</span>
        <span className="stu-label">En este equipo</span>
      </summary>
      <div className="stu-job-body">
        <p className="stu-help">Transcribe a notas el clip de audio elegido (una línea melódica o un instrumento solo funciona mejor que una mezcla). Corre en este navegador: no sube audio ni cuesta créditos.</p>
        {!status.available ? (
          <div className="stu-notice" data-tone="info" role="status" data-testid="studio-tomidi-unavailable">
            <span>
              <strong>NO DISPONIBLE.</strong> {status.reason}
            </span>
          </div>
        ) : !loc ? (
          <p className="stu-help" data-testid="studio-tomidi-pick">
            Elige un clip de audio en la línea de tiempo.
          </p>
        ) : (
          <dl className="stu-kv">
            <dt>Clip</dt>
            <dd>
              {loc.track.name} · {asset?.label || asset?.file || loc.clip.assetId}
            </dd>
            <dt>Ventana</dt>
            <dd>
              {formatTimecode(loc.clip.startS)} · {loc.clip.lengthS.toFixed(2)} s
            </dd>
          </dl>
        )}
        {status.model && (
          <p className="stu-help">
            Modelo: {status.model}
            {status.license ? ` (${status.license})` : ''}. La primera vez descarga el modelo.
          </p>
        )}
        {(state.kind === 'idle' || state.kind === 'failed') && (
          <button type="button" className="stu-btn" data-tone="primary" disabled={!status.available || !loc || recording} onClick={() => void run()} data-testid="studio-tomidi-start">
            PASAR A MIDI
          </button>
        )}
        {state.kind === 'working' && (
          <div className="stu-form-row" aria-live="polite" data-testid="studio-tomidi-working">
            <span className="stu-label">{state.fraction === null ? 'CARGANDO EL MODELO...' : `TRANSCRIBIENDO ${Math.round(state.fraction * 100)}%`}</span>
            <div className="stu-progress" data-indeterminate={state.fraction === null} aria-hidden="true">
              <div style={state.fraction === null ? undefined : { transform: `scaleX(${state.fraction})` }} />
            </div>
            <button type="button" className="stu-btn" data-tone="ghost" onClick={cancel}>
              CANCELAR
            </button>
          </div>
        )}
        {state.kind === 'failed' && (
          <div className="stu-notice" data-tone="error" role="alert">
            <span>{state.message}</span>
            <button type="button" className="stu-btn" data-tone="ghost" onClick={() => setState({ kind: 'idle' })}>
              ENTENDIDO
            </button>
          </div>
        )}
        {state.kind === 'done' && (
          <div className="stu-result" data-testid="studio-tomidi-result">
            <strong>{state.notes.length === 0 ? 'NO SE ENCONTRARON NOTAS' : state.notes.length === 1 ? '1 NOTA' : `${state.notes.length} NOTAS`}</strong>
            <span className="stu-help">Entra como pista de sintetizador nueva, alineada con el clip. El audio original no cambia.</span>
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" onClick={() => setState({ kind: 'idle' })}>
                DESCARTAR
              </button>
              {state.notes.length > 0 && (
                <button type="button" className="stu-btn" data-tone="primary" disabled={recording} onClick={() => accept(state)} data-testid="studio-tomidi-accept">
                  <Check size={13} />
                  AGREGAR PISTA MIDI
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// v2 · ANALIZAR un audio (Music AI)
// ---------------------------------------------------------------------------

interface AnalyzeContext {
  clipId: string
  placement: AnalysisPlacement
}

const ANALYZE_CODEC: ContextCodec<AnalyzeContext> = {
  save: (context) => context,
  restore: (saved) => {
    const s = saved as Partial<AnalyzeContext> | null
    const p = s?.placement as Partial<AnalysisPlacement> | undefined
    if (!s || typeof s.clipId !== 'string' || !p || typeof p.clipStartS !== 'number' || typeof p.clipOffsetS !== 'number' || typeof p.bpm !== 'number') return null
    return { context: { clipId: s.clipId, placement: { clipStartS: p.clipStartS, clipOffsetS: p.clipOffsetS, clipLengthS: typeof p.clipLengthS === 'number' ? p.clipLengthS : null, bpm: p.bpm } } }
  },
}

type AnalysisItem = 'bpm' | 'key' | 'beatsPerBar' | 'markers' | 'chords'

const AnalyzeSection: React.FC<{ controller: StudioController; session: StudioSession; selectedClipId: string | null; canRun: boolean }> = ({ controller, session, selectedClipId, canRun }) => {
  const [picked, setPicked] = useState('')
  const [applied, setApplied] = useState<ReadonlySet<AnalysisItem>>(new Set())
  /** Marcas agregadas desde este analisis -> su instante en segundos (para el tempo aplicado despues). */
  const markerSecondsRef = useRef<Map<string, number>>(new Map())
  /** Los acordes de la sesion vienen de este analisis: el tempo aplicado despues los recalcula. */
  const chordsSavedRef = useRef(false)
  const { flow, quote, confirm, reset, resume, forget } = useJobFlow<AnalyzeContext>(controller, 'analyze', ANALYZE_CODEC)
  const idle = flow.kind === 'idle' || flow.kind === 'failed'
  const clips = session.tracks.flatMap((track) => track.clips.filter((clip) => clip.active).map((clip) => ({ track, clip })))
  const preferred = selectedClipId && clips.some((item) => item.clip.id === selectedClipId) ? selectedClipId : (clips[0]?.clip.id ?? '')
  const clipId = clips.some((item) => item.clip.id === picked) ? picked : preferred

  const start = () => {
    const current = controller.snapshot().session
    const loc = findClip(current, clipId)
    const asset = loc ? current.assets.find((item) => item.id === loc.clip.assetId) : undefined
    if (!loc || !asset) return
    setApplied(new Set())
    void quote(async () => ({
      request: analyzeRequestForAsset(asset),
      upload: () => controller.ensureAssetInCloud(asset.file),
      context: { clipId: loc.clip.id, placement: analysisPlacementForClip(current, loc.clip) },
    }))
  }

  const analysis = flow.kind === 'done' && flow.state.kind === 'analyze' ? flow.state.analysis : null
  const patch = analysis ? analysisSessionPatch(session, analysis) : null

  const mark = (item: AnalysisItem) => setApplied((current) => new Set([...current, item]))

  /** Donde esta AHORA el clip analizado: si se movio o cambio el tempo, todo sigue al audio. */
  const placementIn = (current: StudioSession, context: AnalyzeContext): AnalysisPlacement => {
    const loc = findClip(current, context.clipId)
    return loc ? analysisPlacementForClip(current, loc.clip) : { ...context.placement, bpm: current.bpm }
  }

  const applyMeta = (item: Exclude<AnalysisItem, 'markers' | 'chords'>, label: string) => {
    if (!patch) return
    const value = patch[item]
    if (value === undefined) return
    const context = flow.kind === 'done' ? flow.prepared.context : null
    // Cada dato es un paso de deshacer propio. Con el tempo, las marcas y los acordes del analisis
    // ya guardados se recalculan en el mismo paso: siguen al audio, no a los beats.
    const ok = controller.run(label, (current) => {
      let next = updateSessionMeta(current, { patch: { [item]: value } })
      if (item !== 'bpm' || next.bpm === current.bpm) return next
      if (markerSecondsRef.current.size > 0) next = setMarkers(next, { markers: rebeatMarkers(next.markers, markerSecondsRef.current, next.bpm) })
      if (chordsSavedRef.current && analysis && context) next = setChords(next, { chords: analysisToChords(analysis, placementIn(next, context)) })
      return next
    })
    if (ok) mark(item)
  }

  /** GUARDAR ACORDES: reemplaza los acordes de referencia de la sesion (STUDIO_V2.md 2.9). */
  const applyChords = (context: AnalyzeContext) => {
    if (!analysis) return
    const current = controller.snapshot().session
    const chords = analysisToChords(analysis, placementIn(current, context))
    if (chords.length === 0) {
      controller.notify('info', 'Ningún acorde del análisis cae dentro del clip analizado.')
      return
    }
    if (controller.run('Guardar acordes del análisis', (s) => setChords(s, { chords }))) {
      chordsSavedRef.current = true
      mark('chords')
    }
  }

  const applyMarkers = (context: AnalyzeContext) => {
    if (!analysis) return
    const current = controller.snapshot().session
    // La posicion se toma de la sesion de AHORA: si el clip se movio o cambio el tempo, las marcas siguen al audio.
    const loc = findClip(current, context.clipId)
    const placement = loc ? analysisPlacementForClip(current, loc.clip) : { ...context.placement, bpm: current.bpm }
    const proposed = analysisToMarkers(analysis, placement)
    if (proposed.length === 0) {
      controller.notify('info', 'Ninguna sección del análisis cae dentro del clip analizado.')
      return
    }
    const room = STUDIO_MAX_MARKERS - current.markers.length
    if (room <= 0) {
      controller.notify('warn', `La sesión ya tiene ${STUDIO_MAX_MARKERS} marcas: quita alguna antes de agregar las del análisis.`)
      return
    }
    const added = proposed.slice(0, room)
    if (controller.run('Agregar marcas del análisis', (s) => setMarkers(s, { markers: [...s.markers, ...added] }))) {
      for (const m of added) markerSecondsRef.current.set(m.id, (m.beat * 60) / placement.bpm)
      mark('markers')
      if (proposed.length > room) controller.notify('warn', `Solo cupieron ${room} de ${proposed.length} marcas (tope ${STUDIO_MAX_MARKERS}).`)
    }
  }

  const close = () => {
    setApplied(new Set())
    markerSecondsRef.current = new Map()
    chordsSavedRef.current = false
    reset()
  }

  return (
    <details className="stu-job" data-testid="studio-job-analyze">
      <summary>
        <span>ANALIZAR AUDIO</span>
        <span className="stu-label">Music AI</span>
      </summary>
      <div className="stu-job-body">
        <p className="stu-help">Detecta tempo, tonalidad, compás, secciones y acordes de un clip de audio. Cada dato se aplica a la sesión por separado, solo si lo aceptas.</p>
        {clips.length === 0 ? (
          <p className="stu-help">Importa primero un audio a la sesión.</p>
        ) : (
          <label className="stu-form-row">
            <span className="stu-label">Clip a analizar</span>
            <select className="stu-field" value={clipId} disabled={!idle} onChange={(event) => setPicked(event.target.value)} data-testid="studio-analyze-clip">
              {clips.map(({ track, clip }) => (
                <option key={clip.id} value={clip.id}>
                  {track.name} · {formatTimecode(clip.startS)} ({clip.lengthS.toFixed(1)} s)
                </option>
              ))}
            </select>
          </label>
        )}
        {idle && (
          <button type="button" className="stu-btn" data-tone="primary" disabled={!canRun || !clipId} onClick={start} data-testid="studio-analyze-start">
            <Sparkles size={13} />
            ANALIZAR...
          </button>
        )}
        <JobFlowView flow={flow} provider="Music AI" onConfirm={() => void confirm()} onCancel={close} onRetry={start} onResume={() => void resume()} onForget={forget} testId="studio-analyze" />
        {analysis && flow.kind === 'done' && (
          <div className="stu-result" data-testid="studio-analyze-result">
            <strong>{jobStatusTextV2(flow.state)}</strong>
            <ul className="stu-suggestions">
              <AnalysisRow
                title={analysis.bpm === null ? 'Tempo: no detectado' : `Tempo: ${analysis.bpm.toFixed(1)} BPM`}
                detail={`La sesión está en ${session.bpm} BPM.`}
                state={applied.has('bpm') ? 'applied' : patch?.bpm === undefined ? 'same' : 'pending'}
                action="APLICAR TEMPO"
                onApply={() => applyMeta('bpm', 'Tempo del análisis')}
                testId="studio-analyze-bpm"
              />
              <AnalysisRow
                title={analysis.key === null ? 'Tonalidad: no detectada' : `Tonalidad: ${analysis.key}`}
                detail={`La sesión tiene ${session.key ?? 'tonalidad sin definir'}.`}
                state={applied.has('key') ? 'applied' : patch?.key === undefined ? 'same' : 'pending'}
                action="APLICAR TONALIDAD"
                onApply={() => applyMeta('key', 'Tonalidad del análisis')}
                testId="studio-analyze-key"
              />
              <AnalysisRow
                title={`Compás: ${analysis.beatsPerBar} tiempos`}
                detail={`La sesión tiene ${session.beatsPerBar}. Music AI no siempre informa el compás: revísalo.`}
                state={applied.has('beatsPerBar') ? 'applied' : patch?.beatsPerBar === undefined ? 'same' : 'pending'}
                action="APLICAR COMPÁS"
                onApply={() => applyMeta('beatsPerBar', 'Compás del análisis')}
                testId="studio-analyze-meter"
              />
              <AnalysisRow
                title={analysis.markers.length === 1 ? '1 sección' : `${analysis.markers.length} secciones`}
                detail={analysis.markers.slice(0, 8).map((m) => `${m.label} ${formatTimecode(m.timeS)}`).join(' · ') || 'Sin secciones.'}
                state={applied.has('markers') ? 'applied' : analysis.markers.length === 0 ? 'same' : 'pending'}
                action="AGREGAR MARCAS"
                onApply={() => applyMarkers(flow.prepared.context)}
                testId="studio-analyze-markers"
              />
              {analysis.chords.length > 0 && (
                <AnalysisRow
                  title={analysis.chords.length === 1 ? '1 acorde' : `${analysis.chords.length} acordes`}
                  detail="Se guardan en la sesión como referencia (no suenan). El asistente del chat los usa para no sugerir a ciegas."
                  state={applied.has('chords') ? 'applied' : 'pending'}
                  action="GUARDAR ACORDES"
                  onApply={() => applyChords(flow.prepared.context)}
                  testId="studio-analyze-chords-save"
                />
              )}
            </ul>
            {analysis.chords.length > 0 && (
              <div className="stu-form-row">
                <span className="stu-label">Acordes ({analysis.chords.length}) · guía</span>
                <p className="stu-chords stu-mono" data-testid="studio-analyze-chords">
                  {analysis.chords.slice(0, 48).map((c) => c.name).join('  ')}
                  {analysis.chords.length > 48 ? '  ...' : ''}
                </p>
              </div>
            )}
            <div className="stu-actions" data-align="end">
              <button type="button" className="stu-btn" data-tone="ghost" onClick={close}>
                CERRAR
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

const AnalysisRow: React.FC<{ title: string; detail: string; state: 'pending' | 'applied' | 'same'; action: string; onApply: () => void; testId: string }> = ({ title, detail, state, action, onApply, testId }) => (
  <li data-state={state === 'pending' ? 'pending' : 'applied'} data-testid={testId}>
    <strong>{title}</strong>
    <span>{detail}</span>
    {state === 'pending' ? (
      <div className="stu-actions">
        <button type="button" className="stu-btn" data-size="small" onClick={onApply}>
          <Check size={12} />
          {action}
        </button>
      </div>
    ) : (
      <span className="stu-badge" data-tone={state === 'applied' ? 'ok' : undefined}>
        {state === 'applied' ? 'APLICADO · CTRL+Z LO DESHACE' : 'SIN CAMBIOS'}
      </span>
    )}
  </li>
)

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface JobsPanelProps extends StudioPanelProps {
  /** Abre la ventana del asistente (el chat vive en StudioAssistant, no en este panel). */
  onOpenAssistant?: () => void
  /** Atajo vigente para mostrar u ocultar el asistente, para el texto del boton. */
  assistantShortcut?: string
}

/**
 * Trabajos de IA del Estudio: componer MIDI y asistente de mezcla (modelo de lenguaje),
 * masterizar, separar y analizar (Music AI), generar (Lyria), y audio a MIDI en este equipo. El
 * chat del asistente tiene su propia ventana (StudioAssistant); aqui queda un acceso. Solo Owner
 * y Director musical lanzan los de pago; antes de cada uno se muestra el costo estimado y se pide
 * confirmacion, y ningun resultado entra a la sesion sin que el usuario lo acepte. La
 * normalizacion y el audio a MIDI corren en este equipo, sin nube ni costo.
 */
export const StudioJobsPanel: React.FC<JobsPanelProps> = ({ controller, onOpenAssistant, assistantShortcut = 'Alt+A' }) => {
  const snap = useStudio(controller)
  const { session } = snap
  // Con audios sin cargar la mezcla saldria incompleta (el motor salta los clips sin audio):
  // masterizar o medir eso seria pagar por un resultado que no sirve.
  const missing = snap.engine.missingAssetIds.length
  const hasAudio = snap.ready && missing === 0 && session.tracks.some(trackHasSound)
  const canRun = snap.ready && snap.cloudAvailable && snap.canEditCloud && !snap.recording
  const blocked = !snap.cloudAvailable
    ? 'Sin nube configurada o sin sesión de nube: los trabajos de IA no están disponibles. Entra con tu cuenta de nube. La normalización y el audio a MIDI funcionan en este equipo sin conexión.'
    : !snap.canEditCloud
      ? 'Solo el Owner o el Director musical de la banda pueden lanzar trabajos de IA: gastan créditos de la banda.'
      : null

  return (
    <div className="stu-jobs" data-testid="studio-jobs">
      {blocked && (
        <div className="stu-notice" data-tone="info" role="status" data-testid="studio-jobs-blocked">
          <span>{blocked}</span>
        </div>
      )}
      {missing > 0 && (
        <div className="stu-notice" data-tone="warn" role="status" data-testid="studio-jobs-missing">
          <span>
            {missing === 1 ? 'Falta 1 audio de esta sesión en este equipo.' : `Faltan ${missing} audios de esta sesión en este equipo.`} MASTERIZAR, NORMALIZAR y el ASISTENTE quedan bloqueados: trabajarían sobre una mezcla incompleta. Recarga la sesión para volver a bajarlos.
          </span>
        </div>
      )}
      {onOpenAssistant && (
        <div className="stu-job stu-job-link" data-testid="studio-jobs-assistant">
          <span className="stu-chat-call-text">
            <strong>ASISTENTE (CHAT)</strong>
            <span className="stu-help">Tiene su propia ventana: acoplada a la derecha, flotante o minimizada ({assistantShortcut}).</span>
          </span>
          <button type="button" className="stu-btn" data-size="small" onClick={onOpenAssistant} data-testid="studio-jobs-open-assistant">
            <Sparkles size={12} />
            ABRIR
          </button>
        </div>
      )}
      <ComposeSection controller={controller} session={session} canRun={canRun} />
      <AudioToMidiSection controller={controller} session={session} selectedClipId={snap.selectedClipId} recording={snap.recording} />
      <AnalyzeSection controller={controller} session={session} selectedClipId={snap.selectedClipId} canRun={canRun} />
      <MasterSection controller={controller} canRun={canRun} hasAudio={hasAudio} />
      <SeparateSection controller={controller} session={session} canRun={canRun} />
      <GenerateSection controller={controller} session={session} canRun={canRun} />
      <AssistSection controller={controller} session={session} canRun={canRun} hasAudio={hasAudio} />
    </div>
  )
}
