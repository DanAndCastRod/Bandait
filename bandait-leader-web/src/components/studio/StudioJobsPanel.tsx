import React, { useEffect, useRef, useState } from 'react'
import { Check, Download, Play, RefreshCw, Sparkles, Square, X } from 'lucide-react'
import { slugify } from '../../services/download'
import { StemCloudError } from '../../services/stemCloud'
import { encodeWavPcm } from '../../services/wav'
import { bounceTrackIds, renderMix, soloTrackSession } from '../../services/studio/bounce'
import {
  barsToSeconds,
  buildMixMetrics,
  estimate,
  estimateText,
  formatUsd,
  generateRequestForSession,
  JOB_DEFAULT_TARGET_LUFS,
  JOB_GENERATE_SECONDS_MAX,
  JOB_GENERATE_SECONDS_MIN,
  JOB_TARGET_LUFS_MAX,
  JOB_TARGET_LUFS_MIN,
  jobErrorMessage,
  jobStatusText,
  measureTrack,
  clearPendingJob,
  readPendingJob,
  resumeJob,
  runJob,
  writePendingJob,
  suggestionsForSession,
  suggestionTitle,
} from '../../services/studio/jobs'
import { gainToTargetLufs, integratedLufs, truePeakDb } from '../../services/studio/loudness'
import {
  assetFileName,
  findTrack,
  newStudioId,
  sessionEndSeconds,
  STUDIO_MAX_PROMPT,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACKS,
  STUDIO_REVERB_SEND_DB_MIN,
  type StudioSession,
} from '../../services/studio/session'
import { applyMixSuggestion, trimClip, updateTrack } from '../../services/studio/sessionOps'
import * as studioCloud from '../../services/studio/studioCloud'
import type { MixSuggestion, StudioJobAsset, StudioJobEstimate, StudioJobKind, StudioJobRequest, StudioJobState, TrackMetrics } from '../../services/studio/types'
import { errorText, formatTimecode, useStudio, type StudioController, type StudioPanelProps } from './studioState'

// ---------------------------------------------------------------------------
// Flujo comun de un trabajo de pago: preparar -> costo -> confirmar -> lanzar -> resultado
// ---------------------------------------------------------------------------

type SucceededState = Extract<StudioJobState, { status: 'SUCCEEDED' }>

interface Prepared<C> {
  request: StudioJobRequest
  /** Sube a la nube el audio que el trabajo necesita. Repetir es seguro. */
  upload?: () => Promise<void>
  /** Lo que la seccion necesita al recibir el resultado. */
  context: C
}

type Flow<C> =
  | { kind: 'idle' }
  | { kind: 'working'; text: string; fraction: number | null }
  | { kind: 'confirm'; prepared: Prepared<C>; estimate: StudioJobEstimate; uploaded: boolean }
  | { kind: 'running'; state: StudioJobState | null }
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
function useJobFlow<C>(controller: StudioController, kind: StudioJobKind, codec: ContextCodec<C>) {
  const sessionId = controller.sessionId
  // Un trabajo lanzado en una visita anterior (pestana cerrada, cambio de vista, corte de red)
  // sigue en la nube: al montar se ofrece consultarlo en vez de dejar lanzar otro.
  const [flow, setFlow] = useState<Flow<C>>(() => {
    const pending = readPendingJob(pendingStorage(), sessionId, kind)
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
      let quoted: StudioJobEstimate
      try {
        quoted = await estimate(cloud, controller.sessionId, prepared.request)
      } catch (err) {
        // La estimacion valida igual que el lanzamiento: si pide el audio en la nube, se sube antes.
        if (!(err instanceof StemCloudError) || err.code !== 'no_asset' || !prepared.upload) throw err
        progress('SUBIENDO EL AUDIO...')
        await prepared.upload()
        uploaded = true
        if (ctrl.signal.aborted) return
        progress('CONSULTANDO EL COSTO...')
        quoted = await estimate(cloud, controller.sessionId, prepared.request)
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
  const settle = (final: StudioJobState, prepared: Prepared<C>) => {
    if (final.status === 'SUCCEEDED') {
      // El pendiente se conserva hasta que la seccion acepta o descarta el resultado (reset).
      setFlow({ kind: 'done', prepared, state: final })
    } else if (final.status === 'FAILED' && final.resumable) {
      setFlow({ kind: 'pending', jobId: final.jobId, message: final.error })
    } else if (final.status === 'FAILED') {
      forgetPending()
      setFlow({ kind: 'failed', title: jobStatusText(final), message: final.error, retry: true })
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
        const final = await runJob(cloud, sessionId, prepared.request, {
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
    const saved = readPendingJob(pendingStorage(), sessionId, kind)
    const live = contextRef.current?.jobId === jobId ? contextRef.current.prepared : null
    const restored = saved && saved.jobId === jobId ? codec.restore(saved.context) : null
    const prepared: Prepared<C> | null = live ?? (saved && restored ? { request: saved.request, context: restored.context } : null)
    const ctrl = begin()
    setFlow({ kind: 'running', state: null })
    try {
      const final = await resumeJob(cloud, sessionId, jobId, {
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
        <span className="stu-label">{flow.state ? jobStatusText(flow.state) : 'LANZANDO EL TRABAJO...'}</span>
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
            <strong>{jobStatusText(flow.state)}</strong>
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
// GENERAR con Lyria
// ---------------------------------------------------------------------------

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
            data-testid="studio-generate-prompt"
          />
        </label>
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
        </dl>
        {outOfRange && (
          <p className="stu-help" data-tone="warn">
            El proveedor genera entre {JOB_GENERATE_SECONDS_MIN} y {JOB_GENERATE_SECONDS_MAX} segundos: se pedirá {Math.min(JOB_GENERATE_SECONDS_MAX, Math.max(JOB_GENERATE_SECONDS_MIN, wantedS)).toFixed(0)} s y el clip se recorta a los compases.
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
        <JobFlowView flow={flow} provider="Google (Lyria)" onConfirm={() => void confirm()} onCancel={reset} onRetry={start} onResume={() => void resume()} onForget={forget} testId="studio-generate" />
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
      const current = controller.snapshot().session
      const buffers = controller.engine.getBuffers()
      const ids = bounceTrackIds(current)
      const steps = ids.length + 1
      progress('MIDIENDO LA MEZCLA...', 0)
      const mix = await renderMix(current, buffers, { sampleRate: current.sampleRate, signal })
      // La mezcla se mide y se suelta antes de seguir: nunca hay mas de un render en memoria.
      const metrics = buildMixMetrics({ targetLufs: clampTarget(target), master: { channels: channelsOf(mix), sampleRate: mix.sampleRate }, tracks: [] })
      const range = { startS: 0, endS: sessionEndSeconds(current) }
      const tracks: TrackMetrics[] = []
      for (let i = 0; i < ids.length; i++) {
        const track = findTrack(current, ids[i])
        const solo = soloTrackSession(current, ids[i])
        if (!track || !solo) continue
        progress(`MIDIENDO PISTA ${i + 1}/${ids.length}...`, (i + 1) / steps)
        // La pista sola, despues de su fader y su paneo: sin reverb ni volumen del master.
        const alone: StudioSession = { ...solo, tracks: [{ ...solo.tracks[0], reverbSendDb: STUDIO_REVERB_SEND_DB_MIN }], master: { ...solo.master, volumeDb: 0 } }
        const rendered = await renderMix(alone, buffers, { sampleRate: current.sampleRate, range, signal })
        tracks.push(measureTrack(track, channelsOf(rendered), rendered.sampleRate))
      }
      return { request: { kind: 'assist', metrics: { ...metrics, tracks } }, context: null }
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
// Panel
// ---------------------------------------------------------------------------

/**
 * Trabajos de IA del Estudio: masterizar y separar (Music AI), generar (Lyria) y asistente de
 * mezcla. Solo Owner y Director musical los lanzan; antes de cada uno se muestra el costo
 * estimado y se pide confirmacion, y ningun resultado entra a la sesion sin que el usuario lo
 * acepte. La normalizacion a un LUFS objetivo corre en este equipo, sin nube ni costo.
 */
export const StudioJobsPanel: React.FC<StudioPanelProps> = ({ controller }) => {
  const snap = useStudio(controller)
  const { session } = snap
  // Con audios sin cargar la mezcla saldria incompleta (el motor salta los clips sin audio):
  // masterizar o medir eso seria pagar por un resultado que no sirve.
  const missing = snap.engine.missingAssetIds.length
  const hasAudio = snap.ready && missing === 0 && session.tracks.some((track) => track.clips.some((clip) => clip.active))
  const canRun = snap.ready && snap.cloudAvailable && snap.canEditCloud && !snap.recording
  const blocked = !snap.cloudAvailable
    ? 'Sin nube configurada o sin sesión de nube: los trabajos de IA no están disponibles. Entra con tu cuenta de nube. La normalización en este equipo funciona sin conexión.'
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
      <MasterSection controller={controller} canRun={canRun} hasAudio={hasAudio} />
      <SeparateSection controller={controller} session={session} canRun={canRun} />
      <GenerateSection controller={controller} session={session} canRun={canRun} />
      <AssistSection controller={controller} session={session} canRun={canRun} hasAudio={hasAudio} />
    </div>
  )
}
