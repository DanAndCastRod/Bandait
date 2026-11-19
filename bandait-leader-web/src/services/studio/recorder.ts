/**
 * Grabador del Estudio Bandait (docs/PLAN_ESTUDIO_BANDAIT.md, seccion 5). Usa APIs del navegador.
 *
 *   entrada (getUserMedia) -> MediaStreamAudioSourceNode -+-> worklet de captura -> escritor OPFS
 *                                                         +-> separador -> un analizador por canal
 *                                                         +-> monitoreo por software (apagado)
 *
 * - Comparte el AudioContext del motor (engine.getContext()): un solo reloj para reproducir y
 *   grabar. No lo crea ni lo cierra.
 * - No usa MediaRecorder. El worklet entrega bloques Float32 por canal y un Web Worker escribe
 *   cada canal armado en un WAV de 24 bits en OPFS, a medida que llega.
 * - La posicion de la toma sale de latency.takeStartSeconds con el tiempo del contexto del primer
 *   bloque y la latencia de ida y vuelta (calibrada, o la estimacion del navegador).
 * - Nada aqui emite eventos por fotograma: los niveles se LEEN con readLevel desde rAF.
 *
 * Ademas de StudioRecorderApi la clase expone lo que necesita la prueba de interfaz de la fase 0
 * (StudioDeviceProbe): startWithoutTransport, captureSeconds, getLastRoundTrips, getLastTakeStats
 * y readInputStats.
 */
import captureWorkletUrl from './recorder.worklet.ts?worker&url'
import {
  LATENCY_MIN_CONFIDENCE,
  browserLatencySeconds,
  calibrationSignal,
  estimateDelaySamples,
  loadCalibration,
  saveCalibration,
  takeStartSeconds,
} from './latency.ts'
import { STUDIO_MAX_ASSET_BYTES, assetFileName, newStudioId, type StudioAsset } from './session.ts'
import { STUDIO_OPFS_ROOT, deleteAsset } from './studioStore.ts'
import type { WriterCommand, WriterEvent, WriterFileSpec } from './opfsWriter.worker.ts'
import type { CaptureCommand, CaptureEvent, CaptureRecycleMessage, CaptureSinkMessage } from './recorder.worklet.ts'
import type {
  KeyValueStorage,
  LatencyCalibration,
  MeterReading,
  OpenInputOptions,
  PlayStart,
  RecordedTake,
  RecorderArm,
  RecorderSettingsReport,
  RecorderStatus,
  RecorderWarning,
  RecordingStart,
  StudioEngineApi,
  StudioInputDevice,
  StudioRecorderApi,
  StudioRecorderDeps,
} from './types.ts'

/** Nombre con que recorder.worklet.ts registra su procesador. */
const CAPTURE_PROCESSOR = 'bandait-studio-capture'
/** Mediciones por calibracion; se guarda la mediana. */
const CALIBRATION_ROUNDS = 3
/** Retardo maximo que busca la correlacion. */
const CALIBRATION_MAX_DELAY_MS = 500
/** Margen entre el arranque de la captura y la emision de la senal. */
const CALIBRATION_LEAD_S = 0.15
/** Volumen con que sale la senal de calibracion. */
const CALIBRATION_GAIN = 0.8
/** `takeId` de un error del escritor que no pertenece a una toma en particular. */
const ANY_TAKE = '*'
const METER_FFT = 2048
const SILENCE_DB = -Infinity

const OPEN_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 3_000
const STOP_TIMEOUT_MS = 3_000
const CLOSE_TIMEOUT_MS = 15_000

const WARNING_MESSAGES: Record<RecorderWarning, string> = {
  echo_cancellation_on: 'El navegador dejó activa la cancelación de eco: la señal llega procesada.',
  noise_suppression_on: 'El navegador dejó activa la supresión de ruido: la señal llega procesada.',
  auto_gain_control_on: 'El navegador dejó activo el control automático de ganancia: el nivel cambia solo.',
  fewer_channels: 'Esta entrada entrega un solo canal: se graba como pista mono. Es lo normal en un micrófono integrado; en una interfaz de dos entradas significa que el navegador no las separa.',
  sample_rate_mismatch: 'La entrada trabaja a otra frecuencia que la sesión: el navegador convierte la señal.',
  uncalibrated: 'Sin calibrar: las tomas se alinean con la latencia que estima el navegador.',
}

/** Texto en espanol de un aviso del informe de la entrada. */
export function recorderWarningMessage(warning: RecorderWarning): string {
  return WARNING_MESSAGES[warning]
}

/** Una medicion de latencia de ida y vuelta. */
export interface RoundTripMeasurement {
  seconds: number
  delaySamples: number
  /** 0..1 (latency.estimateDelaySamples). */
  confidence: number
}

/** Audio capturado en memoria (pruebas cortas y calibracion). */
export interface MemoryCapture {
  /** Entrada 1 y entrada 2, del mismo largo. */
  channels: [Float32Array, Float32Array]
  sampleRate: number
  firstBlockCtxTime: number
  /** Cuantos de render que el hilo de audio se salto. */
  droppedQuanta: number
  /** Maximo de canales que trajo la entrada. */
  inputChannels: number
}

/** Detalle de la ultima toma cerrada, para diagnostico. */
export interface TakeStats {
  /** Muestras por canal que capturo el worklet. */
  capturedFrames: number
  /** Muestras por canal que quedaron escritas (huecos incluidos). */
  writtenFrames: number
  /** Cuantos de render que el hilo de audio se salto (saltos de currentFrame). */
  droppedQuanta: number
  /** Cuantos en que la entrada no trajo canales. */
  emptyQuanta: number
  /** Bloques que no llegaron del worklet al escritor. */
  missingBlocks: number
  /** Muestras de silencio agregadas para tapar huecos. */
  gapFrames: number
  /** Bloques que el escritor no pudo guardar. */
  failedBlocks: number
  /** La toma se corto por el tope de tamano por audio. */
  truncated: boolean
  /** Maximo de canales que trajo la entrada. */
  inputChannels: number
  /** Error de escritura, en espanol; null si no hubo. */
  error: string | null
}

/** Estadisticas de audio del track de entrada, si el navegador las expone. */
export interface InputTrackStats {
  deliveredFrames: number
  totalFrames: number
  /** totalFrames - deliveredFrames: muestras que el navegador no entrego a tiempo. */
  droppedFrames: number
  /** Latencia de entrada promedio en segundos; null si no viene. */
  averageLatencySeconds: number | null
}

/**
 * NO VERIFICADO: lee `MediaStreamTrack.stats` (MediaStreamTrackAudioStats, Chrome reciente). No se
 * pudo confirmar en documentacion oficial desde este equipo, asi que se lee con cuidado y devuelve
 * null si el navegador no lo trae o trae otra forma. Solo sirve de diagnostico: ninguna decision
 * del grabador depende de este valor.
 */
export function readInputTrackStats(track: MediaStreamTrack): InputTrackStats | null {
  try {
    const stats = (track as unknown as { stats?: unknown }).stats
    if (typeof stats !== 'object' || stats === null) return null
    const s = stats as Record<string, unknown>
    const delivered = s.deliveredFrames
    const total = s.totalFrames
    if (typeof delivered !== 'number' || typeof total !== 'number') return null
    const average = s.averageLatency
    return {
      deliveredFrames: delivered,
      totalFrames: total,
      droppedFrames: Math.max(0, total - delivered),
      averageLatencySeconds: typeof average === 'number' && Number.isFinite(average) ? average / 1000 : null,
    }
  } catch {
    return null
  }
}

function userMediaError(err: unknown): Error {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('El navegador no tiene permiso para usar el micrófono. Concédelo en el candado de la barra de direcciones y reintenta.')
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error('No se encontró esa entrada de audio. Revisa que la interfaz esté conectada y vuelve a buscar las entradas.')
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new Error('La entrada de audio está en uso por otro programa o el sistema no la deja abrir.')
  }
  return new Error('No se pudo abrir la entrada de audio.')
}

/** Espera un evento de un conjunto de oyentes. `pick` devuelve undefined si el evento no es el esperado. */
function waitEvent<E, R>(listeners: Set<(event: E) => void>, pick: (event: E) => R | undefined, timeoutMs: number, timeoutMessage: string): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const listener = (event: E) => {
      let value: R | undefined
      try {
        value = pick(event)
      } catch (err) {
        finish()
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      if (value === undefined) return
      finish()
      resolve(value)
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error(timeoutMessage))
    }, timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      listeners.delete(listener)
    }
    listeners.add(listener)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>()

/** Carga el worklet de captura una vez por contexto. */
function loadCaptureWorklet(ctx: AudioContext): Promise<void> {
  let load = workletLoads.get(ctx)
  if (!load) {
    load = ctx.audioWorklet.addModule(captureWorkletUrl).catch((err: unknown) => {
      workletLoads.delete(ctx)
      throw err
    })
    workletLoads.set(ctx, load)
  }
  return load
}

type StoppedEvent = Extract<CaptureEvent, { type: 'stopped' }>
type ClosedEvent = Extract<WriterEvent, { type: 'closed' }>

interface TakeFile {
  arm: RecorderArm
  assetId: string
  file: string
}

interface ActiveTake {
  takeId: string
  files: TakeFile[]
  firstBlockCtxTime: number
  playStart: PlayStart
  roundTripSeconds: number
  calibrated: boolean
}

export class StudioRecorder implements StudioRecorderApi {
  private readonly ctx: AudioContext
  private readonly sessionId: string
  private readonly storage: KeyValueStorage
  private readonly getLatencyOffsetMs: () => number

  private status: RecorderStatus = 'closed'
  private readonly statusListeners = new Set<(status: RecorderStatus) => void>()
  private readonly captureListeners = new Set<(event: CaptureEvent) => void>()
  private readonly writerListeners = new Set<(event: WriterEvent) => void>()

  private stream: MediaStream | null = null
  private track: MediaStreamTrack | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private capture: AudioWorkletNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private analysers: AnalyserNode[] = []
  private silentSink: GainNode | null = null
  private monitorGain: GainNode | null = null
  private writer: Worker | null = null

  private readonly meterBuffer = new Float32Array(METER_FFT)
  private readonly readings: [MeterReading, MeterReading] = [
    { peakDb: SILENCE_DB, rmsDb: SILENCE_DB },
    { peakDb: SILENCE_DB, rmsDb: SILENCE_DB },
  ]

  private requested: OpenInputOptions | null = null
  private outputLabel = ''
  private report: RecorderSettingsReport | null = null
  private arms: RecorderArm[] = []
  private take: ActiveTake | null = null
  private monitor = false
  private busy = false
  private lastRoundTrips: RoundTripMeasurement[] = []
  private lastTakeStats: TakeStats | null = null

  constructor(deps: StudioRecorderDeps) {
    this.ctx = deps.context
    this.sessionId = deps.sessionId
    this.storage = deps.calibrationStorage
    this.getLatencyOffsetMs = deps.getLatencyOffsetMs
  }

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  getStatus(): RecorderStatus {
    return this.status
  }

  onStatusChange(listener: (status: RecorderStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  private setStatus(status: RecorderStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of [...this.statusListeners]) {
      try {
        listener(status)
      } catch {
        // Un oyente que falla no debe tumbar la grabacion.
      }
    }
  }

  private idleStatus(): RecorderStatus {
    if (!this.capture) return 'closed'
    return this.arms.length > 0 ? 'armed' : 'open'
  }

  // -------------------------------------------------------------------------
  // Entradas
  // -------------------------------------------------------------------------

  async listInputs(): Promise<StudioInputDevice[]> {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!media?.enumerateDevices) throw new Error('Este navegador no permite listar entradas de audio. Usa Chrome o Edge de escritorio.')
    const inputsOf = async () => (await media.enumerateDevices()).filter((device) => device.kind === 'audioinput')
    let inputs = await inputsOf()
    // Sin permiso de microfono el navegador oculta las etiquetas: se pide una vez y se suelta.
    if (!this.stream && inputs.some((device) => device.label === '') && media.getUserMedia) {
      let probe: MediaStream
      try {
        probe = await media.getUserMedia({ audio: true })
      } catch (err) {
        throw userMediaError(err)
      }
      for (const track of probe.getTracks()) track.stop()
      inputs = await inputsOf()
    }
    return inputs.map((device) => ({ deviceId: device.deviceId, label: device.label, groupId: device.groupId }))
  }

  async open(options: OpenInputOptions): Promise<RecorderSettingsReport> {
    if (this.take || this.busy) throw new Error('Termina la grabación o la medición en curso antes de cambiar de entrada.')
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!media?.getUserMedia || typeof AudioWorkletNode === 'undefined' || !this.ctx.audioWorklet) {
      throw new Error('Este navegador no permite grabar en el Estudio. Usa Chrome o Edge de escritorio.')
    }
    this.release()

    // Sin entrada elegida (o 'default') se graba con la entrada por defecto del sistema: el
    // microfono y el controlador propios del equipo. channelCount va como 'ideal' para que una
    // entrada mono abra igual y se grabe como una pista mono.
    const useDefault = options.deviceId === '' || options.deviceId === 'default'
    let stream: MediaStream
    try {
      stream = await media.getUserMedia({
        audio: {
          ...(useDefault ? {} : { deviceId: { exact: options.deviceId } }),
          channelCount: { ideal: options.channels },
          sampleRate: this.ctx.sampleRate,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
    } catch (err) {
      throw userMediaError(err)
    }
    const track = stream.getAudioTracks()[0]
    if (!track) {
      for (const t of stream.getTracks()) t.stop()
      throw new Error('La entrada elegida no entregó audio.')
    }

    try {
      await loadCaptureWorklet(this.ctx)
      const ctx = this.ctx
      const source = ctx.createMediaStreamSource(stream)
      // 'clamped-max' + 'discrete': el worklet ve los canales que la entrada trae de verdad (1 o 2;
      // de una interfaz con mas, los dos primeros). Una entrada mono NO se duplica al canal 2: el
      // worklet la informa como un solo canal y deja el segundo en silencio.
      const capture = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'clamped-max',
        channelInterpretation: 'discrete',
      })
      // Sumidero mudo hacia la salida: garantiza que el navegador procese el worklet y los
      // analizadores aunque nada mas los escuche.
      const silentSink = ctx.createGain()
      silentSink.gain.value = 0
      silentSink.connect(ctx.destination)
      const splitter = ctx.createChannelSplitter(2)
      const analysers = [0, 1].map((channel) => {
        const analyser = ctx.createAnalyser()
        analyser.fftSize = METER_FFT
        analyser.smoothingTimeConstant = 0
        splitter.connect(analyser, channel)
        analyser.connect(silentSink)
        return analyser
      })
      const monitorGain = ctx.createGain()
      monitorGain.gain.value = this.monitor ? 1 : 0
      source.connect(capture)
      capture.connect(silentSink)
      source.connect(splitter)
      source.connect(monitorGain)
      monitorGain.connect(ctx.destination)
      capture.port.onmessage = (event: MessageEvent) => {
        const message = event.data as CaptureEvent
        for (const listener of [...this.captureListeners]) listener(message)
      }

      this.stream = stream
      this.track = track
      this.source = source
      this.capture = capture
      this.splitter = splitter
      this.analysers = analysers
      this.silentSink = silentSink
      this.monitorGain = monitorGain
    } catch (err) {
      for (const t of stream.getTracks()) t.stop()
      this.release()
      throw err instanceof Error && err.message ? new Error(`No se pudo preparar la captura de audio: ${err.message}`) : new Error('No se pudo preparar la captura de audio.')
    }

    track.onended = () => {
      // La interfaz se desconecto. Grabando, la toma se conserva hasta que llamen a stop().
      if (this.track === track && !this.take && !this.busy) {
        this.release()
        this.setStatus('closed')
      }
    }

    this.requested = options
    this.arms = []
    // La latencia de ida y vuelta depende de la pareja entrada + salida: la calibracion se guarda
    // con las dos etiquetas. Si el navegador no deja leer la salida, queda solo la de la entrada.
    this.outputLabel = ''
    try {
      const devices = await media.enumerateDevices()
      const outputs = devices.filter((device) => device.kind === 'audiooutput')
      this.outputLabel = (outputs.find((device) => device.deviceId === 'default') ?? outputs[0])?.label ?? ''
    } catch {
      this.outputLabel = ''
    }
    const report = this.buildReport()
    if (!report) throw new Error('No se pudo leer la configuración de la entrada.')
    this.report = report
    this.setStatus('open')
    return report
  }

  reportSettings(): RecorderSettingsReport | null {
    return this.report
  }

  /** Etiqueta con la que se guarda la calibracion: entrada y salida por defecto del sistema. */
  private calibrationLabel(inputLabel: string): string {
    return this.outputLabel ? `${inputLabel} > ${this.outputLabel}` : inputLabel
  }

  private loadCalibrationFor(label: string): LatencyCalibration | null {
    try {
      return loadCalibration(this.storage, this.calibrationLabel(label), this.ctx.sampleRate)
    } catch {
      return null
    }
  }

  /** Compara lo pedido con lo que el navegador respeto (MediaStreamTrack.getSettings()). */
  private buildReport(): RecorderSettingsReport | null {
    const track = this.track
    const requested = this.requested
    if (!track || !requested) return null
    const settings = track.getSettings() as MediaTrackSettings & { latency?: unknown }
    // Si el navegador informa un modo como texto en vez de un booleano (NO VERIFICADO que valores
    // usa), se toma como procesamiento activo: es preferible un aviso de mas que uno de menos.
    const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : typeof value === 'string' ? true : null)
    const channelCount = typeof settings.channelCount === 'number' ? settings.channelCount : 0
    const sampleRate = typeof settings.sampleRate === 'number' ? settings.sampleRate : null
    const echoCancellation = flag(settings.echoCancellation)
    const noiseSuppression = flag(settings.noiseSuppression)
    const autoGainControl = flag(settings.autoGainControl)
    const calibration = this.loadCalibrationFor(track.label)

    const warnings: RecorderWarning[] = []
    if (echoCancellation === true) warnings.push('echo_cancellation_on')
    if (noiseSuppression === true) warnings.push('noise_suppression_on')
    if (autoGainControl === true) warnings.push('auto_gain_control_on')
    // channelCount 0 = el navegador no lo informo: no se puede afirmar que falten canales.
    if (channelCount > 0 && channelCount < requested.channels) warnings.push('fewer_channels')
    if (sampleRate !== null && sampleRate !== this.ctx.sampleRate) warnings.push('sample_rate_mismatch')
    if (!calibration) warnings.push('uncalibrated')

    return {
      deviceId: typeof settings.deviceId === 'string' ? settings.deviceId : requested.deviceId,
      label: track.label,
      channelCount,
      sampleRate,
      echoCancellation,
      noiseSuppression,
      autoGainControl,
      inputLatencySeconds: typeof settings.latency === 'number' && Number.isFinite(settings.latency) ? settings.latency : null,
      calibration,
      warnings,
    }
  }

  arm(arms: readonly RecorderArm[]): void {
    if (!this.capture) throw new Error('Abre una entrada antes de armar pistas.')
    if (this.take) throw new Error('No se puede cambiar el arme mientras se graba.')
    // Una pista graba un solo canal: si se repite, vale el ultimo.
    const byTrack = new Map<string, RecorderArm>()
    for (const arm of arms) byTrack.set(arm.trackId, { trackId: arm.trackId, channel: arm.channel })
    this.arms = [...byTrack.values()]
    if (!this.busy) this.setStatus(this.idleStatus())
  }

  // -------------------------------------------------------------------------
  // Tomas
  // -------------------------------------------------------------------------

  private ensureWriter(): Worker {
    if (this.writer) return this.writer
    const writer = new Worker(new URL('./opfsWriter.worker.ts', import.meta.url), { type: 'module' })
    writer.onmessage = (event: MessageEvent) => {
      const message = event.data as WriterEvent
      for (const listener of [...this.writerListeners]) listener(message)
    }
    writer.onerror = () => {
      // El worker murio: se descarta (la proxima toma crea otro) y se avisa a quien este esperando.
      if (this.writer === writer) this.writer = null
      writer.terminate()
      const message: WriterEvent = { type: 'error', takeId: ANY_TAKE, message: 'El escritor de tomas se detuvo por un error.' }
      for (const listener of [...this.writerListeners]) listener(message)
    }
    this.writer = writer
    return writer
  }

  private postCapture(command: CaptureCommand, transfer: Transferable[] = []): void {
    this.capture?.port.postMessage(command, transfer)
  }

  /** Latencia de ida y vuelta vigente: calibrada o estimada, mas el ajuste manual de la sesion. */
  private currentRoundTrip(): { seconds: number; calibrated: boolean } {
    const calibration = this.track ? this.loadCalibrationFor(this.track.label) : null
    const offsetMs = this.getLatencyOffsetMs()
    const offset = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
    if (calibration) return { seconds: calibration.roundTripSeconds + offset, calibrated: true }
    const estimate = browserLatencySeconds({
      baseLatency: Number.isFinite(this.ctx.baseLatency) ? this.ctx.baseLatency : 0,
      outputLatency: Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency : 0,
      inputLatency: this.report?.inputLatencySeconds ?? 0,
    })
    return { seconds: estimate + offset, calibrated: false }
  }

  /** Abre los archivos en el escritor y arranca el worklet. Devuelve el tiempo del primer bloque. */
  private async beginTake(takeId: string, files: TakeFile[]): Promise<number> {
    const writer = this.ensureWriter()
    const channel = new MessageChannel()
    const specs: WriterFileSpec[] = files.map((f) => ({ file: f.file, channels: f.arm.channel === 'stereo' ? [0, 1] : [f.arm.channel] }))
    const opened = waitEvent(
      this.writerListeners,
      (event) => {
        if (event.takeId !== takeId && event.takeId !== ANY_TAKE) return undefined
        if (event.type === 'error') throw new Error(event.message)
        return event.type === 'opened' ? true : undefined
      },
      OPEN_TIMEOUT_MS,
      'El almacenamiento del navegador no respondió al abrir la toma.'
    )
    const open: WriterCommand = {
      type: 'open',
      takeId,
      root: STUDIO_OPFS_ROOT,
      sessionId: this.sessionId,
      sampleRate: this.ctx.sampleRate,
      files: specs,
      maxBytes: STUDIO_MAX_ASSET_BYTES,
      port: channel.port1,
    }
    writer.postMessage(open, [channel.port1])
    try {
      await opened
    } catch (err) {
      channel.port2.close()
      throw err
    }

    const started = waitEvent(
      this.captureListeners,
      (event) => (event.type === 'started' && event.takeId === takeId ? event.firstTime : undefined),
      START_TIMEOUT_MS,
      'El motor de audio no está corriendo: no llegó audio de la entrada.'
    )
    this.postCapture({ type: 'start', takeId, sink: channel.port2 }, [channel.port2])
    try {
      return await started
    } catch (err) {
      await this.endTake(takeId).catch(() => null)
      await this.discardFiles(files)
      throw err
    }
  }

  /** Detiene el worklet y espera a que el escritor cierre los archivos. */
  private async endTake(takeId: string): Promise<{ stopped: StoppedEvent | null; closed: ClosedEvent }> {
    const stoppedWait = waitEvent(
      this.captureListeners,
      (event) => (event.type === 'stopped' && event.takeId === takeId ? event : undefined),
      STOP_TIMEOUT_MS,
      'sin respuesta del worklet'
    ).catch(() => null)
    const closedWait = waitEvent(
      this.writerListeners,
      (event) => {
        if (event.takeId !== takeId && event.takeId !== ANY_TAKE) return undefined
        if (event.type === 'error') throw new Error(event.message)
        return event.type === 'closed' ? event : undefined
      },
      CLOSE_TIMEOUT_MS,
      'El almacenamiento del navegador no respondió al cerrar la toma. El audio escrito se puede recuperar al reabrir la sesión.'
    )
    // El rechazo se maneja abajo; esto evita un "unhandled rejection" mientras se espera al worklet.
    closedWait.catch(() => undefined)
    this.postCapture({ type: 'stop', takeId })
    const stopped = await stoppedWait
    // Worklet colgado o entrada cerrada: el escritor cierra con lo que tenga.
    if (!stopped) this.writer?.postMessage({ type: 'finish', takeId } satisfies WriterCommand)
    const closed = await closedWait
    return { stopped, closed }
  }

  private async discardFiles(files: TakeFile[]): Promise<void> {
    for (const f of files) await deleteAsset(this.sessionId, f.file).catch(() => undefined)
  }

  private async startTake(resolvePlayStart: (firstBlockCtxTime: number) => Promise<PlayStart>): Promise<RecordingStart> {
    if (!this.capture || !this.track) throw new Error('Abre una entrada antes de grabar.')
    if (this.take) throw new Error('Ya hay una grabación en curso.')
    if (this.busy) throw new Error('Espera a que termine la medición en curso.')
    if (this.arms.length === 0) throw new Error('Arma al menos una pista para grabar.')
    this.busy = true
    try {
      // El worklet solo corre con el contexto activo. Debe llamarse desde un gesto del usuario.
      if (this.ctx.state !== 'running') await this.ctx.resume()
      const takeId = newStudioId('tk')
      const files: TakeFile[] = this.arms.map((arm) => {
        const assetId = newStudioId('ast')
        return { arm, assetId, file: assetFileName(assetId, 'wav') }
      })
      const firstBlockCtxTime = await this.beginTake(takeId, files)
      let playStart: PlayStart
      try {
        playStart = await resolvePlayStart(firstBlockCtxTime)
      } catch (err) {
        await this.endTake(takeId).catch(() => null)
        await this.discardFiles(files)
        throw err
      }
      const roundTrip = this.currentRoundTrip()
      this.take = { takeId, files, firstBlockCtxTime, playStart, roundTripSeconds: roundTrip.seconds, calibrated: roundTrip.calibrated }
      this.setStatus('recording')
      return { ...playStart, roundTripSeconds: roundTrip.seconds, calibrated: roundTrip.calibrated }
    } finally {
      this.busy = false
    }
  }

  /**
   * Empieza a capturar los canales armados y arranca el motor con conteo previo. La captura
   * arranca ANTES del conteo, asi que la toma lo incluye: su `startSeconds` cae antes de la
   * posicion de arranque (quien arma el clip puede recortar ese tramo). Si el motor ya suena,
   * `engine.play` devuelve el arranque vigente y la toma entra de inmediato (pinchazo).
   */
  start(engine: StudioEngineApi): Promise<RecordingStart> {
    return this.startTake(() => engine.play({ countIn: true }))
  }

  /**
   * Graba sin transporte (prueba de interfaz): la toma empieza en la posicion 0 de una linea de
   * tiempo que arranca con su primer bloque.
   */
  startWithoutTransport(): Promise<RecordingStart> {
    return this.startTake(async (firstBlockCtxTime) => ({ positionAtStart: 0, playStartCtxTime: firstBlockCtxTime }))
  }

  async stop(): Promise<RecordedTake[]> {
    const take = this.take
    if (!take) return []
    this.take = null
    // Hasta que el escritor cierre los archivos no se puede arrancar otra toma ni medir.
    this.busy = true
    this.setStatus('stopping')
    try {
      const { stopped, closed } = await this.endTake(take.takeId)
      const droppedBlocks = (stopped?.droppedQuanta ?? 0) + closed.missingBlocks + closed.failedBlocks
      this.lastTakeStats = {
        capturedFrames: stopped?.frames ?? 0,
        writtenFrames: closed.files[0]?.frames ?? 0,
        droppedQuanta: stopped?.droppedQuanta ?? 0,
        emptyQuanta: stopped?.emptyQuanta ?? 0,
        missingBlocks: closed.missingBlocks,
        gapFrames: closed.gapFrames,
        failedBlocks: closed.failedBlocks,
        truncated: closed.truncated,
        inputChannels: stopped?.inputChannels ?? 0,
        error: closed.error,
      }
      const startSeconds = takeStartSeconds({
        positionAtStart: take.playStart.positionAtStart,
        firstBlockCtxTime: take.firstBlockCtxTime,
        playStartCtxTime: take.playStart.playStartCtxTime,
        roundTripSeconds: take.roundTripSeconds,
      })
      const sampleRate = this.ctx.sampleRate
      const takes: RecordedTake[] = []
      for (const f of take.files) {
        const written = closed.files.find((result) => result.file === f.file)
        if (!written || written.frames === 0) {
          // Sin audio no hay toma: no se deja un WAV vacio que luego pareceria huerfano.
          await deleteAsset(this.sessionId, f.file).catch(() => undefined)
          continue
        }
        const durationSeconds = written.frames / sampleRate
        const asset: StudioAsset = {
          id: f.assetId,
          file: f.file,
          kind: 'recording',
          label: f.arm.channel === 'stereo' ? 'Entradas 1-2' : `Entrada ${f.arm.channel + 1}`,
          channels: written.channels,
          sampleRate,
          durationS: durationSeconds,
          size: written.bytes,
          source: null,
        }
        takes.push({
          assetId: f.assetId,
          channel: f.arm.channel,
          trackId: f.arm.trackId,
          startSeconds,
          durationSeconds,
          droppedBlocks,
          calibrated: take.calibrated,
          asset,
        })
      }
      return takes
    } finally {
      this.busy = false
      this.setStatus(this.idleStatus())
    }
  }

  /** Detalle de la ultima toma cerrada con stop(); null si todavia no hubo. */
  getLastTakeStats(): TakeStats | null {
    return this.lastTakeStats
  }

  /** Estadisticas del track de entrada (NO VERIFICADO, ver readInputTrackStats); null si no hay. */
  readInputStats(): InputTrackStats | null {
    return this.track ? readInputTrackStats(this.track) : null
  }

  // -------------------------------------------------------------------------
  // Captura en memoria y calibracion
  // -------------------------------------------------------------------------

  /** Captura `seconds` de las dos entradas en memoria. `onStarted` corre al llegar el primer bloque. */
  private async captureMemory(seconds: number, onStarted?: (firstBlockCtxTime: number) => void): Promise<MemoryCapture> {
    if (!this.capture) throw new Error('Abre una entrada antes de medir.')
    if (this.ctx.state !== 'running') await this.ctx.resume()
    const sampleRate = this.ctx.sampleRate
    const wanted = Math.max(1, Math.ceil(seconds * sampleRate))
    const takeId = newStudioId('tk')
    const channel = new MessageChannel()
    const ch0 = new Float32Array(wanted)
    const ch1 = new Float32Array(wanted)
    let filled = 0
    let firstFrame = -1
    let resolveFull: () => void = () => undefined
    const full = new Promise<void>((resolve) => {
      resolveFull = resolve
    })
    channel.port1.onmessage = (event: MessageEvent) => {
      const message = event.data as CaptureSinkMessage
      if (!message || message.type !== 'block') return
      if (firstFrame < 0) firstFrame = message.frame
      // Se ubica por `frame`: un hueco queda en silencio y la senal no se corre.
      const at = message.frame - firstFrame
      const n = Math.min(message.frames, wanted - at)
      if (n > 0) {
        ch0.set(new Float32Array(message.ch0, 0, n), at)
        ch1.set(new Float32Array(message.ch1, 0, n), at)
        filled = Math.max(filled, at + n)
      }
      const recycle: CaptureRecycleMessage = { type: 'recycle', buffers: [message.ch0, message.ch1] }
      channel.port1.postMessage(recycle, [message.ch0, message.ch1])
      if (at + message.frames >= wanted) resolveFull()
    }

    const started = waitEvent(
      this.captureListeners,
      (event) => (event.type === 'started' && event.takeId === takeId ? event.firstTime : undefined),
      START_TIMEOUT_MS,
      'El motor de audio no está corriendo: no llegó audio de la entrada.'
    )
    const stoppedWait = waitEvent(
      this.captureListeners,
      (event) => (event.type === 'stopped' && event.takeId === takeId ? event : undefined),
      seconds * 1000 + START_TIMEOUT_MS + STOP_TIMEOUT_MS + 2000,
      'sin respuesta del worklet'
    ).catch(() => null)
    this.postCapture({ type: 'start', takeId, sink: channel.port2 }, [channel.port2])
    let firstBlockCtxTime: number
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      firstBlockCtxTime = await started
      onStarted?.(firstBlockCtxTime)
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, seconds * 1000 + 2000)
      })
      await Promise.race([full, timeout])
    } finally {
      clearTimeout(timer)
      this.postCapture({ type: 'stop', takeId })
    }
    const stopped = await stoppedWait
    // Deja pasar los bloques que quedaron en cola antes de cerrar el puerto.
    await sleep(0)
    channel.port1.onmessage = null
    channel.port1.close()
    if (filled < wanted) throw new Error('La entrada dejó de entregar audio durante la medición.')
    return {
      channels: [ch0, ch1],
      sampleRate,
      firstBlockCtxTime,
      droppedQuanta: stopped?.droppedQuanta ?? 0,
      inputChannels: stopped?.inputChannels ?? 0,
    }
  }

  private async withMeasurement<T>(run: () => Promise<T>): Promise<T> {
    if (!this.capture) throw new Error('Abre una entrada antes de medir.')
    if (this.take) throw new Error('No se puede medir mientras se graba.')
    if (this.busy) throw new Error('Ya hay una medición en curso.')
    this.busy = true
    this.setStatus('calibrating')
    try {
      return await run()
    } finally {
      this.busy = false
      this.setStatus(this.idleStatus())
    }
  }

  /**
   * Captura unos segundos de las dos entradas en memoria, sin escribir nada en disco (prueba de
   * canales independientes). Maximo 30 segundos. Mientras dura, el estado es 'calibrating'.
   */
  captureSeconds(seconds: number): Promise<MemoryCapture> {
    const bounded = Math.min(30, Math.max(0.1, Number.isFinite(seconds) ? seconds : 1))
    return this.withMeasurement(() => this.captureMemory(bounded))
  }

  /** Una medicion: emite la senal de calibracion, la graba por la entrada 1 y correlaciona. */
  private async measureRoundTrip(): Promise<RoundTripMeasurement> {
    const ctx = this.ctx
    const sampleRate = ctx.sampleRate
    const signal = calibrationSignal(sampleRate)
    const buffer = ctx.createBuffer(1, signal.length, sampleRate)
    buffer.getChannelData(0).set(signal)
    const signalSeconds = signal.length / sampleRate
    const total = CALIBRATION_LEAD_S + signalSeconds + CALIBRATION_MAX_DELAY_MS / 1000 + 0.1

    let emitFrame = 0
    let player: AudioBufferSourceNode | null = null
    let playerGain: GainNode | null = null
    try {
      const capture = await this.captureMemory(total, (firstBlockCtxTime) => {
        // La senal sale en un numero entero de muestras: asi el indice dentro de lo grabado es exacto.
        emitFrame = Math.ceil((Math.max(ctx.currentTime, firstBlockCtxTime) + CALIBRATION_LEAD_S) * sampleRate)
        player = ctx.createBufferSource()
        player.buffer = buffer
        playerGain = ctx.createGain()
        playerGain.gain.value = CALIBRATION_GAIN
        player.connect(playerGain)
        playerGain.connect(ctx.destination)
        player.start(emitFrame / sampleRate)
      })
      const firstFrame = Math.round(capture.firstBlockCtxTime * sampleRate)
      const startIndex = Math.max(0, emitFrame - firstFrame)
      const recorded = capture.channels[0].subarray(startIndex)
      const estimate = estimateDelaySamples(signal, recorded, sampleRate, CALIBRATION_MAX_DELAY_MS)
      return { seconds: estimate.delaySamples / sampleRate, delaySamples: estimate.delaySamples, confidence: estimate.confidence }
    } finally {
      const usedPlayer = player as AudioBufferSourceNode | null
      const usedGain = playerGain as GainNode | null
      try {
        usedPlayer?.stop()
      } catch {
        // No llego a arrancar.
      }
      usedPlayer?.disconnect()
      usedGain?.disconnect()
    }
  }

  /**
   * Mide la latencia de ida y vuelta: 3 mediciones, guarda la mediana y la devuelve. Rechaza si
   * la confianza es baja. No comprueba que el motor este detenido (no lo conoce): quien llama
   * debe detenerlo antes, o la musica se mezcla con la senal de calibracion.
   */
  async calibrate(): Promise<LatencyCalibration> {
    const track = this.track
    if (!track) throw new Error('Abre una entrada antes de calibrar.')
    return this.withMeasurement(async () => {
      // El monitoreo por software devolveria la entrada a la salida y falsearia la medicion.
      const monitorGain = this.monitorGain
      if (monitorGain) monitorGain.gain.value = 0
      const rounds: RoundTripMeasurement[] = []
      try {
        for (let i = 0; i < CALIBRATION_ROUNDS; i++) {
          rounds.push(await this.measureRoundTrip())
          await sleep(120)
        }
      } finally {
        this.lastRoundTrips = rounds
        if (monitorGain) monitorGain.gain.value = this.monitor ? 1 : 0
      }
      const weakest = Math.min(...rounds.map((round) => round.confidence))
      if (!(weakest >= LATENCY_MIN_CONFIDENCE)) {
        throw new Error(
          'No se pudo medir la latencia: la señal de calibración no llegó con claridad a la Entrada 1. Con una interfaz, conecta un cable de la Salida 1 a la Entrada 1; con el micrófono del equipo, acerca el audífono o el parlante al micrófono. Sube el volumen de salida y repite.'
        )
      }
      const sorted = [...rounds].sort((a, b) => a.seconds - b.seconds)
      const calibration: LatencyCalibration = {
        deviceLabel: this.calibrationLabel(track.label),
        sampleRate: this.ctx.sampleRate,
        roundTripSeconds: sorted[Math.floor(sorted.length / 2)].seconds,
        confidence: weakest,
        spreadSeconds: sorted[sorted.length - 1].seconds - sorted[0].seconds,
        measuredAt: new Date().toISOString(),
      }
      saveCalibration(this.storage, calibration)
      this.report = this.buildReport()
      return calibration
    })
  }

  /** Las mediciones de la ultima calibracion (tambien si fallo por confianza baja). */
  getLastRoundTrips(): readonly RoundTripMeasurement[] {
    return this.lastRoundTrips
  }

  // -------------------------------------------------------------------------
  // Niveles y monitoreo
  // -------------------------------------------------------------------------

  /**
   * Nivel de un canal de la entrada. Para no asignar memoria por fotograma devuelve SIEMPRE el
   * mismo objeto por canal, actualizado: quien lo guarde debe copiar los numeros.
   */
  readLevel(channel: 0 | 1): MeterReading {
    const reading = this.readings[channel]
    const analyser = this.analysers[channel]
    if (!analyser) {
      reading.peakDb = SILENCE_DB
      reading.rmsDb = SILENCE_DB
      return reading
    }
    const data = this.meterBuffer
    analyser.getFloatTimeDomainData(data)
    let peak = 0
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    reading.peakDb = peak > 0 ? 20 * Math.log10(peak) : SILENCE_DB
    reading.rmsDb = rms > 0 ? 20 * Math.log10(rms) : SILENCE_DB
    return reading
  }

  setMonitor(enabled: boolean): void {
    this.monitor = enabled
    const gain = this.monitorGain
    if (!gain || this.status === 'calibrating') return
    // Rampa corta para que no suene un clic al abrir o cerrar.
    gain.gain.setTargetAtTime(enabled ? 1 : 0, this.ctx.currentTime, 0.015)
  }

  // -------------------------------------------------------------------------
  // Cierre
  // -------------------------------------------------------------------------

  /** Suelta la entrada, los nodos y el escritor. No toca el AudioContext (es del motor). */
  private release(): void {
    if (this.track) this.track.onended = null
    if (this.capture) this.capture.port.onmessage = null
    for (const node of [this.source, this.capture, this.splitter, ...this.analysers, this.monitorGain, this.silentSink]) {
      try {
        node?.disconnect()
      } catch {
        // Ya estaba desconectado.
      }
    }
    if (this.stream) for (const track of this.stream.getTracks()) track.stop()
    this.writer?.terminate()
    this.stream = null
    this.track = null
    this.source = null
    this.capture = null
    this.splitter = null
    this.analysers = []
    this.silentSink = null
    this.monitorGain = null
    this.writer = null
    this.requested = null
    this.report = null
    this.arms = []
  }

  async close(): Promise<void> {
    if (this.take) {
      try {
        await this.stop()
      } catch {
        // La toma quedo en disco sin cerrar: se recupera al reabrir la sesion.
      }
    }
    this.release()
    this.setStatus('closed')
  }
}
