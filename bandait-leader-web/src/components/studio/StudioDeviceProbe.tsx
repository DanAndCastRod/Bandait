import React, { useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, Cable, Check, Copy, Mic, Minus, Play, RefreshCw, Square, Timer, X } from 'lucide-react'
import { STUDIO_SAMPLE_RATES } from '../../services/studio/session.ts'
import { StudioRecorder, recorderWarningMessage, type RoundTripMeasurement, type TakeStats } from '../../services/studio/recorder.ts'
import { deleteSession } from '../../services/studio/studioStore.ts'
import type { KeyValueStorage, RecorderSettingsReport, StudioInputDevice } from '../../services/studio/types.ts'
import { canvasPalette, cardStyle, colors, ghostButton, labelStyle, mono, primaryButton, smallInputStyle } from '../hubStyles'

/**
 * Prueba de interfaz del Estudio (docs/PLAN_ESTUDIO_BANDAIT.md, fase 0). Panel autonomo: crea su
 * propio AudioContext y su propio grabador, no depende del motor ni de una sesion. Con la interfaz
 * conectada responde lo que el plan da por supuesto: dos canales independientes, procesamiento de
 * voz apagado, bloques perdidos en una grabacion larga y variacion de la latencia de ida y vuelta.
 *
 * Nada de audio pasa por estado de React: los niveles y el avance de la grabacion se pintan con
 * refs, canvas y requestAnimationFrame.
 */

/** Criterio de salida de la fase 0. */
const CRITERION_SECONDS = 600
const CRITERION_SPREAD_MS = 2
const CHANNEL_TEST_SECONDS = 3
/** Por debajo de este nivel no hay senal con que juzgar la prueba de canales. */
const SIGNAL_FLOOR_DB = -60
const METER_HEIGHT = 58
const METER_FLOOR_DB = -60

const DURATIONS: Array<{ seconds: number; label: string }> = [
  { seconds: 10, label: '10 segundos' },
  { seconds: 60, label: '1 minuto' },
  { seconds: 300, label: '5 minutos' },
  { seconds: 600, label: '10 minutos (criterio)' },
]

type Busy = null | 'listing' | 'opening' | 'channels' | 'drops' | 'latency'
type Outcome = 'pass' | 'fail' | 'pending'

interface ContextInfo {
  sampleRate: number
  baseLatencyMs: number
  outputLatencyMs: number
}

interface ChannelResult {
  outcome: Outcome
  message: string
  level1Db: number
  level2Db: number
  correlation: number
  inputChannels: number
}

interface DropResult {
  outcome: Outcome
  requestedSeconds: number
  recordedSeconds: number
  cancelled: boolean
  droppedBlocks: number
  stats: TakeStats | null
  /** Muestras que el track de entrada dice no haber entregado; null si el navegador no lo informa. */
  inputDroppedFrames: number | null
  /** Reloj del sistema menos reloj de audio, en ms, al terminar. */
  clockDriftMs: number
  error: string | null
}

interface LatencyResult {
  outcome: Outcome
  rounds: RoundTripMeasurement[]
  spreadMs: number | null
  medianMs: number | null
  error: string | null
}

/** localStorage si se puede usar; si no (navegacion privada), memoria. */
function probeStorage(): KeyValueStorage {
  const memory = new Map<string, string>()
  return {
    getItem(key) {
      try {
        return localStorage.getItem(key)
      } catch {
        return memory.get(key) ?? null
      }
    },
    setItem(key, value) {
      try {
        localStorage.setItem(key, value)
      } catch {
        memory.set(key, value)
      }
    },
    removeItem(key) {
      try {
        localStorage.removeItem(key)
      } catch {
        memory.delete(key)
      }
    },
  }
}

function toDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity
}

function formatDb(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : 'silencio'
}

function formatMs(seconds: number): string {
  return `${(seconds * 1000).toFixed(2)} ms`
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Ocurrió un error inesperado.'
}

/** Nivel de cada canal y correlacion de Pearson entre los dos. */
function analyzeChannels(a: Float32Array, b: Float32Array, inputChannels: number): ChannelResult {
  const n = Math.min(a.length, b.length)
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < n; i++) {
    sumA += a[i]
    sumB += b[i]
  }
  const meanA = n > 0 ? sumA / n : 0
  const meanB = n > 0 ? sumB / n : 0
  let varA = 0
  let varB = 0
  let cov = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    varA += da * da
    varB += db * db
    cov += da * db
  }
  const level1Db = toDb(n > 0 ? Math.sqrt(varA / n) : 0)
  const level2Db = toDb(n > 0 ? Math.sqrt(varB / n) : 0)
  const correlation = varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : 0
  const base = { level1Db, level2Db, correlation, inputChannels }

  // Entrada de un canal (lo normal en el microfono del equipo): el criterio de dos canales no
  // aplica y se graba una pista mono. No se puede saber desde aqui si el aparato tiene dos entradas.
  if (inputChannels < 2) {
    if (!(level1Db > SIGNAL_FLOOR_DB)) {
      return { ...base, outcome: 'pending', message: 'No llegó señal a la entrada. Habla o toca mientras corre la prueba y repítela.' }
    }
    return {
      ...base,
      outcome: 'pass',
      message: 'Entrada de un solo canal: se graba como pista mono y el criterio de dos canales no aplica. Si esta entrada es una interfaz de dos canales, el navegador no las está separando: en ese caso cuenta como NO CUMPLE.',
    }
  }
  // Un preamplificador real siempre trae algo de ruido de fondo; ceros exactos son un canal que no existe.
  if (varB === 0) {
    return { ...base, outcome: 'fail', message: 'La Entrada 2 llega en silencio digital (ni ruido de fondo): el navegador no está entregando ese canal.' }
  }
  if (!(level1Db > SIGNAL_FLOOR_DB)) {
    return { ...base, outcome: 'pending', message: 'No llegó señal a la Entrada 1. Habla o toca por la Entrada 1 mientras corre la prueba y repítela.' }
  }
  // Mono duplicado: los dos canales son la misma senal al mismo nivel. La diafonia electrica de
  // una interfaz real tambien se parece, pero llega decenas de dB mas abajo.
  if (Math.abs(correlation) >= 0.98 && Math.abs(level1Db - level2Db) < 1.5) {
    return { ...base, outcome: 'fail', message: 'Los dos canales traen la misma señal al mismo nivel: el navegador está duplicando una entrada mono.' }
  }
  return { ...base, outcome: 'pass', message: 'Las dos entradas llegan como canales independientes.' }
}

function outcomeText(outcome: Outcome): string {
  return outcome === 'pass' ? 'CUMPLE' : outcome === 'fail' ? 'NO CUMPLE' : 'PENDIENTE'
}

function flagText(value: boolean | null): string {
  return value === null ? 'no informado' : value ? 'ACTIVO' : 'apagado'
}

interface ProbeSnapshot {
  context: ContextInfo | null
  report: RecorderSettingsReport | null
  channels: ChannelResult | null
  drops: DropResult | null
  latency: LatencyResult | null
}

function overallVerdict(s: ProbeSnapshot): { outcome: Outcome; text: string } {
  const outcomes = [s.channels?.outcome ?? 'pending', s.drops?.outcome ?? 'pending', s.latency?.outcome ?? 'pending']
  if (outcomes.includes('fail')) {
    return { outcome: 'fail', text: 'NO CUMPLE el criterio de salida de la fase 0. Según el plan, la grabación pasa al leader (fase 6).' }
  }
  if (outcomes.includes('pending')) return { outcome: 'pending', text: 'INCOMPLETO: faltan pruebas por correr o por repetir.' }
  if (s.drops && s.drops.requestedSeconds < CRITERION_SECONDS) {
    return { outcome: 'pending', text: 'CUMPLE en prueba corta. Para cerrar la fase 0 repite la grabación con 10 minutos.' }
  }
  if (s.channels && s.channels.inputChannels < 2) {
    return { outcome: 'pass', text: 'CUMPLE para una entrada de un canal: se puede grabar en el navegador, una pista mono a la vez. Los dos canales independientes siguen por probar con la interfaz.' }
  }
  return { outcome: 'pass', text: 'CUMPLE el criterio de salida de la fase 0: se puede grabar en el navegador.' }
}

/** `date` solo viene al copiar: el texto que se pinta no depende del reloj. */
function buildReportText(s: ProbeSnapshot, date: string | null): string {
  const lines: string[] = []
  lines.push('ESTUDIO BANDAIT - PRUEBA DE INTERFAZ (FASE 0)')
  if (date) lines.push(`Fecha: ${date}`)
  lines.push(`Navegador: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'desconocido'}`)
  if (s.context) {
    lines.push(`AudioContext: ${s.context.sampleRate} Hz, baseLatency ${s.context.baseLatencyMs.toFixed(2)} ms, outputLatency ${s.context.outputLatencyMs.toFixed(2)} ms`)
  }
  lines.push('')
  lines.push('ENTRADA')
  if (s.report) {
    const r = s.report
    lines.push(`  Dispositivo: ${r.label || '(sin etiqueta)'}`)
    lines.push(`  Canales entregados: ${r.channelCount > 0 ? r.channelCount : 'no informado'} (pedidos: 2)`)
    lines.push(`  Frecuencia de la entrada: ${r.sampleRate ?? 'no informada'}`)
    lines.push(`  Cancelación de eco: ${flagText(r.echoCancellation)}`)
    lines.push(`  Supresión de ruido: ${flagText(r.noiseSuppression)}`)
    lines.push(`  Control automático de ganancia: ${flagText(r.autoGainControl)}`)
    lines.push(`  Latencia de entrada informada: ${r.inputLatencySeconds === null ? 'no informada' : formatMs(r.inputLatencySeconds)}`)
    for (const warning of r.warnings) lines.push(`  AVISO: ${recorderWarningMessage(warning)}`)
  } else {
    lines.push('  Sin entrada abierta.')
  }
  lines.push('')
  lines.push(`1. CANALES INDEPENDIENTES: ${outcomeText(s.channels?.outcome ?? 'pending')}`)
  if (s.channels) {
    lines.push(`  ${s.channels.message}`)
    lines.push(`  Entrada 1: ${formatDb(s.channels.level1Db)} | Entrada 2: ${formatDb(s.channels.level2Db)} | correlación: ${s.channels.correlation.toFixed(3)} | canales vistos por el worklet: ${s.channels.inputChannels}`)
  }
  lines.push(`2. BLOQUES PERDIDOS: ${outcomeText(s.drops?.outcome ?? 'pending')}`)
  if (s.drops) {
    const d = s.drops
    lines.push(`  Duración pedida: ${d.requestedSeconds} s | grabada: ${d.recordedSeconds.toFixed(2)} s${d.cancelled ? ' (cancelada)' : ''}`)
    lines.push(`  Bloques perdidos: ${d.droppedBlocks}`)
    if (d.stats) {
      lines.push(`  Detalle: cuantos saltados ${d.stats.droppedQuanta}, cuantos sin entrada ${d.stats.emptyQuanta}, bloques sin llegar ${d.stats.missingBlocks}, bloques sin escribir ${d.stats.failedBlocks}, silencio agregado ${d.stats.gapFrames} muestras, cortada por tamaño: ${d.stats.truncated ? 'sí' : 'no'}`)
    }
    lines.push(`  Muestras no entregadas según el track (dato del navegador, sin verificar): ${d.inputDroppedFrames ?? 'no informado'}`)
    lines.push(`  Reloj del sistema menos reloj de audio: ${d.clockDriftMs.toFixed(1)} ms`)
    if (d.error) lines.push(`  Error: ${d.error}`)
  }
  lines.push(`3. LATENCIA DE IDA Y VUELTA: ${outcomeText(s.latency?.outcome ?? 'pending')}`)
  if (s.latency) {
    s.latency.rounds.forEach((round, index) => {
      lines.push(`  Medición ${index + 1}: ${formatMs(round.seconds)} (${round.delaySamples} muestras, confianza ${round.confidence.toFixed(2)})`)
    })
    if (s.latency.medianMs !== null) lines.push(`  Mediana: ${s.latency.medianMs.toFixed(2)} ms`)
    if (s.latency.spreadMs !== null) lines.push(`  Variación: ${s.latency.spreadMs.toFixed(3)} ms (criterio: menor a ${CRITERION_SPREAD_MS} ms)`)
    if (s.latency.error) lines.push(`  Error: ${s.latency.error}`)
  }
  lines.push('')
  lines.push(`VEREDICTO: ${overallVerdict(s).text}`)
  return lines.join('\n')
}

const OUTCOME_TONE: Record<Outcome, { bg: string; fg: string; border: string }> = {
  pass: { bg: colors.success, fg: colors.onAccent, border: colors.success },
  fail: { bg: colors.danger, fg: colors.onAccent, border: colors.danger },
  pending: { bg: colors.elevated, fg: colors.muted, border: colors.border },
}

const OutcomeBadge: React.FC<{ outcome: Outcome }> = ({ outcome }) => {
  const tone = OUTCOME_TONE[outcome]
  const icon = outcome === 'pass' ? <Check size={12} /> : outcome === 'fail' ? <X size={12} /> : <Minus size={12} />
  return (
    <span
      data-outcome={outcome}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontFamily: mono,
        fontSize: '11px',
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: '3px',
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {icon}
      {outcomeText(outcome)}
    </span>
  )
}

const Fact: React.FC<{ label: string; value: string; tone?: 'ok' | 'warn' | 'muted' }> = ({ label, value, tone = 'muted' }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
    <span style={labelStyle}>{label}</span>
    <span
      style={{
        fontFamily: mono,
        fontSize: '13px',
        fontWeight: 600,
        color: tone === 'ok' ? colors.success : tone === 'warn' ? colors.warning : colors.text,
        overflowWrap: 'anywhere',
      }}
    >
      {value}
    </span>
  </div>
)

const sectionStyle: React.CSSProperties = { ...cardStyle, padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }
const sectionHeadStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
const sectionTitleStyle: React.CSSProperties = { fontFamily: mono, fontSize: '12px', fontWeight: 700, letterSpacing: '0.4px', color: colors.text }
const hintStyle: React.CSSProperties = { fontSize: '13px', color: colors.muted, lineHeight: 1.5, maxWidth: '72ch' }
const factsStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }
const actionStyle: React.CSSProperties = { ...ghostButton, padding: '8px 12px', fontSize: '11px', fontWeight: 700 }
const mainActionStyle: React.CSSProperties = { ...primaryButton(), color: colors.onAccent, padding: '8px 12px', fontSize: '11px' }

/** Panel de la fase 0: prueba de la interfaz de audio en este navegador. */
export const StudioDeviceProbe: React.FC = () => {
  const [sampleRate, setSampleRate] = useState(48000)
  const [devices, setDevices] = useState<StudioInputDevice[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<ContextInfo | null>(null)
  const [report, setReport] = useState<RecorderSettingsReport | null>(null)
  const [channels, setChannels] = useState<ChannelResult | null>(null)
  const [drops, setDrops] = useState<DropResult | null>(null)
  const [latency, setLatency] = useState<LatencyResult | null>(null)
  const [dropSeconds, setDropSeconds] = useState(CRITERION_SECONDS)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const ctxRef = useRef<AudioContext | null>(null)
  const recorderRef = useRef<StudioRecorder | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const storageRef = useRef<KeyValueStorage | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const progressFillRef = useRef<HTMLDivElement | null>(null)
  const progressTextRef = useRef<HTMLSpanElement | null>(null)
  /** Grabacion de prueba en curso: la lee el bucle de rAF para pintar el avance. */
  const dropRunRef = useRef<{ startedAt: number; seconds: number } | null>(null)
  const cancelDropRef = useRef<(() => void) | null>(null)

  const isOpen = report !== null

  // Al salir del panel: soltar la interfaz, cerrar el contexto y borrar los audios de prueba.
  useEffect(() => {
    return () => {
      cancelDropRef.current?.()
      const recorder = recorderRef.current
      const ctx = ctxRef.current
      const sessionId = sessionIdRef.current
      recorderRef.current = null
      ctxRef.current = null
      void (async () => {
        await recorder?.close().catch(() => undefined)
        await ctx?.close().catch(() => undefined)
        if (sessionId) await deleteSession(sessionId).catch(() => undefined)
      })()
    }
  }, [])

  // Medidores y avance de la grabacion: canvas y rAF, sin estado de React por fotograma.
  useEffect(() => {
    if (!isOpen) return
    const canvas = canvasRef.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return
    let width = canvas.clientWidth
    const fit = () => {
      const dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.round(METER_HEIGHT * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(canvas)

    const hold = [METER_FLOOR_DB, METER_FLOOR_DB]
    const clipUntil = [0, 0]
    let last = performance.now()
    let raf = 0
    const xOf = (db: number, span: number) => Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)) * span

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const recorder = recorderRef.current
      const left = 46
      const span = Math.max(10, width - left - 86)
      // El canvas no entiende var(--b-*): colores del tema resueltos en cada cuadro.
      const pal = canvasPalette()
      g.clearRect(0, 0, width, METER_HEIGHT)
      g.font = `600 11px ${mono}`
      g.textBaseline = 'middle'
      for (let ch = 0; ch < 2; ch++) {
        const reading = recorder ? recorder.readLevel(ch as 0 | 1) : null
        const peakDb = reading ? reading.peakDb : -Infinity
        const rmsDb = reading ? reading.rmsDb : -Infinity
        // Retencion de pico: cae 18 dB por segundo.
        hold[ch] = Math.max(peakDb, hold[ch] - 18 * dt, METER_FLOOR_DB)
        if (peakDb >= -0.1) clipUntil[ch] = now + 1500
        const y = 6 + ch * 26
        g.fillStyle = pal.muted
        g.textAlign = 'left'
        g.fillText(`IN ${ch + 1}`, 0, y + 9)
        g.fillStyle = pal.elevated
        g.fillRect(left, y, span, 18)
        g.fillStyle = hold[ch] > -6 ? pal.warning : pal.orange
        g.fillRect(left, y, xOf(rmsDb, span), 18)
        g.fillStyle = now < clipUntil[ch] ? pal.danger : pal.text
        g.fillRect(left + xOf(hold[ch], span) - 1, y, 2, 18)
        // Marcas de -18 y -6 dB.
        g.fillStyle = pal.border
        g.fillRect(left + xOf(-18, span), y, 1, 18)
        g.fillRect(left + xOf(-6, span), y, 1, 18)
        g.fillStyle = now < clipUntil[ch] ? pal.danger : pal.text
        g.textAlign = 'right'
        g.fillText(now < clipUntil[ch] ? 'SATURA' : Number.isFinite(peakDb) ? `${peakDb.toFixed(1)} dB` : '-inf dB', width, y + 9)
      }

      const run = dropRunRef.current
      const fill = progressFillRef.current
      const text = progressTextRef.current
      if (run && fill && text) {
        const elapsed = (now - run.startedAt) / 1000
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, elapsed / run.seconds))})`
        const label = `${formatClock(elapsed)} / ${formatClock(run.seconds)}`
        if (text.textContent !== label) text.textContent = label
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [isOpen])

  /** El grabador de la prueba, con un AudioContext a la frecuencia elegida. */
  async function ensureRecorder(): Promise<StudioRecorder> {
    const existing = recorderRef.current
    const ctx = ctxRef.current
    if (existing && ctx && ctx.state !== 'closed' && ctx.sampleRate === sampleRate) return existing
    await existing?.close().catch(() => undefined)
    await ctx?.close().catch(() => undefined)
    let next: AudioContext
    try {
      next = new AudioContext({ sampleRate, latencyHint: 'interactive' })
    } catch {
      throw new Error(`Este equipo no deja abrir la salida de audio a ${sampleRate} Hz. Prueba otra frecuencia.`)
    }
    if (!sessionIdRef.current) sessionIdRef.current = `probe_${Date.now().toString(36)}`
    if (!storageRef.current) storageRef.current = probeStorage()
    const recorder = new StudioRecorder({
      context: next,
      sessionId: sessionIdRef.current,
      calibrationStorage: storageRef.current,
      getLatencyOffsetMs: () => 0,
    })
    ctxRef.current = next
    recorderRef.current = recorder
    return recorder
  }

  function readContext(): ContextInfo | null {
    const ctx = ctxRef.current
    if (!ctx) return null
    return {
      sampleRate: ctx.sampleRate,
      baseLatencyMs: (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0) * 1000,
      outputLatencyMs: (Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0) * 1000,
    }
  }

  function resetResults() {
    setChannels(null)
    setDrops(null)
    setLatency(null)
    setCopyState('idle')
  }

  async function handleList() {
    setBusy('listing')
    setError(null)
    try {
      const recorder = await ensureRecorder()
      const found = await recorder.listInputs()
      setDevices(found)
      // Sin eleccion previa: la entrada por defecto del equipo.
      if (!found.some((device) => device.deviceId === deviceId)) setDeviceId((found.find((device) => device.deviceId === 'default') ?? found[0])?.deviceId ?? '')
      if (found.length === 0) setError('No se encontró ninguna entrada de audio. Revisa que el micrófono del equipo esté habilitado, o conecta una interfaz, y vuelve a buscar.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleOpen() {
    if (!deviceId) return
    setBusy('opening')
    setError(null)
    resetResults()
    try {
      const recorder = await ensureRecorder()
      const opened = await recorder.open({ deviceId, channels: 2 })
      setReport(opened)
      setContext(readContext())
    } catch (err) {
      setReport(null)
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleChannels() {
    const recorder = recorderRef.current
    if (!recorder) return
    setBusy('channels')
    setError(null)
    try {
      const capture = await recorder.captureSeconds(CHANNEL_TEST_SECONDS)
      setChannels(analyzeChannels(capture.channels[0], capture.channels[1], capture.inputChannels))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleDrops() {
    const recorder = recorderRef.current
    const ctx = ctxRef.current
    const sessionId = sessionIdRef.current
    if (!recorder || !ctx || !sessionId) return
    const seconds = dropSeconds
    setBusy('drops')
    setError(null)
    setDrops(null)
    let recording = false
    try {
      recorder.arm([
        { trackId: 'probe_in_1', channel: 0 },
        { trackId: 'probe_in_2', channel: 1 },
      ])
      const before = recorder.readInputStats()
      await recorder.startWithoutTransport()
      recording = true
      const wallStart = performance.now()
      const ctxStart = ctx.currentTime
      dropRunRef.current = { startedAt: wallStart, seconds }
      const cancelled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), seconds * 1000)
        cancelDropRef.current = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
      const clockDriftMs = performance.now() - wallStart - (ctx.currentTime - ctxStart) * 1000
      recording = false
      const takes = await recorder.stop()
      const stats = recorder.getLastTakeStats()
      const after = recorder.readInputStats()
      const droppedBlocks = takes.reduce((max, take) => Math.max(max, take.droppedBlocks), 0)
      const failure = stats?.error ?? (takes.length === 0 ? 'La grabación no dejó audio.' : stats?.truncated ? 'La grabación se cortó por el tope de tamaño.' : null)
      setDrops({
        outcome: cancelled ? 'pending' : failure || droppedBlocks > 0 ? 'fail' : 'pass',
        requestedSeconds: seconds,
        recordedSeconds: takes[0]?.durationSeconds ?? 0,
        cancelled,
        droppedBlocks,
        stats,
        inputDroppedFrames: before && after ? Math.max(0, after.droppedFrames - before.droppedFrames) : null,
        clockDriftMs,
        error: failure,
      })
    } catch (err) {
      if (recording) await recorder.stop().catch(() => undefined)
      setError(errorMessage(err))
    } finally {
      dropRunRef.current = null
      cancelDropRef.current = null
      try {
        recorder.arm([])
      } catch {
        // La entrada se cerro durante la prueba.
      }
      // Los audios de prueba no se conservan.
      await deleteSession(sessionId).catch(() => undefined)
      setBusy(null)
    }
  }

  async function handleLatency() {
    const recorder = recorderRef.current
    if (!recorder) return
    setBusy('latency')
    setError(null)
    setLatency(null)
    try {
      const calibration = await recorder.calibrate()
      const spreadMs = calibration.spreadSeconds * 1000
      setLatency({
        outcome: spreadMs < CRITERION_SPREAD_MS ? 'pass' : 'fail',
        rounds: [...recorder.getLastRoundTrips()],
        spreadMs,
        medianMs: calibration.roundTripSeconds * 1000,
        error: null,
      })
      setReport(recorder.reportSettings())
    } catch (err) {
      setLatency({ outcome: 'pending', rounds: [...recorder.getLastRoundTrips()], spreadMs: null, medianMs: null, error: errorMessage(err) })
    } finally {
      setContext(readContext())
      setBusy(null)
    }
  }

  const snapshot: ProbeSnapshot = { context, report, channels, drops, latency }
  const verdict = overallVerdict(snapshot)
  const reportText = buildReportText(snapshot, null)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildReportText(snapshot, new Date().toISOString()))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const locked = busy !== null
  const voiceOff = report !== null && report.echoCancellation !== true && report.noiseSuppression !== true && report.autoGainControl !== true

  return (
    <div data-testid="studio-device-probe" style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0, color: colors.text }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted, letterSpacing: '0.6px' }}>ESTUDIO · FASE 0</span>
        <h2 style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '-0.2px' }}>Prueba de interfaz</h2>
        <p style={hintStyle}>
          Comprueba en este navegador lo que el Estudio necesita para grabar: dos canales independientes, cero bloques perdidos y una latencia de ida y
          vuelta estable. Conecta la interfaz y, para la medición de latencia, un cable de la Salida 1 a la Entrada 1.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="stx-fade-in"
          style={{ ...cardStyle, borderColor: colors.danger, padding: '10px 12px', display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '13px' }}
        >
          <AlertTriangle size={16} color={colors.danger} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>{error}</span>
        </div>
      )}

      {/* Entrada */}
      <section style={sectionStyle} aria-label="Entrada de audio">
        <div style={sectionHeadStyle}>
          <Mic size={14} color={colors.cobalt} />
          <span style={sectionTitleStyle}>ENTRADA</span>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ ...labelStyle, flex: '1 1 240px', minWidth: 0 }}>
            INTERFAZ
            <select
              className="stx-field"
              data-testid="probe-device"
              value={deviceId}
              disabled={locked || devices.length === 0}
              onChange={(event) => setDeviceId(event.target.value)}
              style={{ ...smallInputStyle, width: '100%', padding: '8px', marginTop: '4px' }}
            >
              {devices.length === 0 && <option value="">Busca las entradas primero</option>}
              {devices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Entrada ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label style={{ ...labelStyle, flex: '0 1 150px', minWidth: 0 }}>
            FRECUENCIA
            <select
              className="stx-field"
              data-testid="probe-rate"
              value={sampleRate}
              disabled={locked}
              onChange={(event) => setSampleRate(Number(event.target.value))}
              style={{ ...smallInputStyle, width: '100%', padding: '8px', marginTop: '4px' }}
            >
              {STUDIO_SAMPLE_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate} Hz
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="stx-btn" data-testid="probe-list" disabled={locked} onClick={() => void handleList()} style={actionStyle}>
            <RefreshCw size={13} />
            {busy === 'listing' ? 'BUSCANDO...' : 'BUSCAR ENTRADAS'}
          </button>
          <button
            type="button"
            className="stx-btn"
            data-testid="probe-open"
            disabled={locked || !deviceId}
            onClick={() => void handleOpen()}
            style={mainActionStyle}
          >
            <Play size={13} />
            {busy === 'opening' ? 'ABRIENDO...' : isOpen ? 'REABRIR' : 'ABRIR'}
          </button>
        </div>

        {report && (
          <div className="stx-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={factsStyle}>
              <Fact label="CANALES (PEDIDOS: 2)" value={report.channelCount > 0 ? String(report.channelCount) : 'no informado'} tone={report.channelCount >= 2 ? 'ok' : 'warn'} />
              <Fact label="FRECUENCIA DE ENTRADA" value={report.sampleRate === null ? 'no informada' : `${report.sampleRate} Hz`} tone={report.sampleRate === null || report.sampleRate === context?.sampleRate ? 'muted' : 'warn'} />
              <Fact label="CANCELACIÓN DE ECO" value={flagText(report.echoCancellation)} tone={report.echoCancellation === true ? 'warn' : report.echoCancellation === false ? 'ok' : 'muted'} />
              <Fact label="SUPRESIÓN DE RUIDO" value={flagText(report.noiseSuppression)} tone={report.noiseSuppression === true ? 'warn' : report.noiseSuppression === false ? 'ok' : 'muted'} />
              <Fact label="GANANCIA AUTOMÁTICA" value={flagText(report.autoGainControl)} tone={report.autoGainControl === true ? 'warn' : report.autoGainControl === false ? 'ok' : 'muted'} />
              <Fact label="LATENCIA DE ENTRADA" value={report.inputLatencySeconds === null ? 'no informada' : formatMs(report.inputLatencySeconds)} />
              {context && <Fact label="SALIDA (BASE + SALIDA)" value={`${context.baseLatencyMs.toFixed(1)} + ${context.outputLatencyMs.toFixed(1)} ms`} />}
              <Fact label="PROCESAMIENTO DE VOZ" value={voiceOff ? 'apagado' : 'REVISAR'} tone={voiceOff ? 'ok' : 'warn'} />
            </div>
            {report.warnings.length > 0 && (
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {report.warnings.map((warning) => (
                  <li key={warning} style={{ display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: '12px', color: colors.warning }}>
                    <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <span>{recorderWarningMessage(warning)}</span>
                  </li>
                ))}
              </ul>
            )}
            <canvas ref={canvasRef} aria-label="Niveles de las dos entradas" style={{ width: '100%', height: `${METER_HEIGHT}px`, display: 'block' }} />
          </div>
        )}
      </section>

      {/* 1. Canales */}
      <section style={sectionStyle} aria-label="Canales independientes">
        <div style={sectionHeadStyle}>
          <Activity size={14} color={colors.cobalt} />
          <span style={sectionTitleStyle}>1. CANALES INDEPENDIENTES</span>
          <OutcomeBadge outcome={channels?.outcome ?? 'pending'} />
        </div>
        <p style={hintStyle}>
          Envía señal solo a la Entrada 1 (habla o toca) y deja la Entrada 2 sin nada conectado. La prueba graba {CHANNEL_TEST_SECONDS} segundos y compara
          los dos canales: si llegan iguales, el navegador está duplicando una entrada mono.
        </p>
        <div>
          <button type="button" className="stx-btn" data-testid="probe-channels" disabled={locked || !isOpen} onClick={() => void handleChannels()} style={actionStyle}>
            <Play size={13} />
            {busy === 'channels' ? 'ESCUCHANDO...' : 'PROBAR CANALES'}
          </button>
        </div>
        {channels && (
          <div className="stx-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <span style={{ fontSize: '13px' }}>{channels.message}</span>
            <div style={factsStyle}>
              <Fact label="ENTRADA 1" value={formatDb(channels.level1Db)} />
              <Fact label="ENTRADA 2" value={formatDb(channels.level2Db)} />
              <Fact label="CORRELACIÓN" value={channels.correlation.toFixed(3)} />
              <Fact label="CANALES EN EL WORKLET" value={String(channels.inputChannels)} />
            </div>
          </div>
        )}
      </section>

      {/* 2. Bloques perdidos */}
      <section style={sectionStyle} aria-label="Bloques perdidos">
        <div style={sectionHeadStyle}>
          <Timer size={14} color={colors.cobalt} />
          <span style={sectionTitleStyle}>2. BLOQUES PERDIDOS</span>
          <OutcomeBadge outcome={drops?.outcome ?? 'pending'} />
        </div>
        <p style={hintStyle}>
          Graba las dos entradas por el mismo camino que usará el Estudio (worklet, escritor y disco del navegador) y cuenta lo que se pierde. La prueba de
          10 minutos ocupa cerca de 175 MB mientras corre; los audios se borran al terminar.
        </p>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ ...labelStyle, flex: '0 1 220px', minWidth: 0 }}>
            DURACIÓN
            <select
              className="stx-field"
              data-testid="probe-duration"
              value={dropSeconds}
              disabled={locked}
              onChange={(event) => setDropSeconds(Number(event.target.value))}
              style={{ ...smallInputStyle, width: '100%', padding: '8px', marginTop: '4px' }}
            >
              {DURATIONS.map((option) => (
                <option key={option.seconds} value={option.seconds}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {busy === 'drops' ? (
            <button type="button" className="stx-btn" data-testid="probe-drops-cancel" onClick={() => cancelDropRef.current?.()} style={{ ...actionStyle, borderColor: colors.danger, color: colors.danger }}>
              <Square size={13} />
              CANCELAR
            </button>
          ) : (
            <button type="button" className="stx-btn" data-testid="probe-drops" disabled={locked || !isOpen} onClick={() => void handleDrops()} style={actionStyle}>
              <Play size={13} />
              GRABAR Y CONTAR
            </button>
          )}
        </div>
        {busy === 'drops' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ flex: 1, height: '4px', borderRadius: '2px', background: colors.borderSoft, overflow: 'hidden' }}>
              <div ref={progressFillRef} style={{ height: '100%', background: colors.orange, transformOrigin: 'left center', transform: 'scaleX(0)' }} />
            </div>
            <span ref={progressTextRef} style={{ fontFamily: mono, fontSize: '12px', color: colors.muted, minWidth: '96px', textAlign: 'right' }}>
              0:00 / {formatClock(dropSeconds)}
            </span>
          </div>
        )}
        {drops && (
          <div className="stx-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {drops.cancelled && <span style={{ fontSize: '13px', color: colors.warning }}>Prueba cancelada: el resultado no cuenta para el veredicto.</span>}
            {drops.error && <span style={{ fontSize: '13px', color: colors.danger }}>{drops.error}</span>}
            <div style={factsStyle}>
              <Fact label="BLOQUES PERDIDOS" value={String(drops.droppedBlocks)} tone={drops.droppedBlocks === 0 ? 'ok' : 'warn'} />
              <Fact label="GRABADO" value={`${drops.recordedSeconds.toFixed(1)} s de ${drops.requestedSeconds} s`} />
              <Fact label="CUANTOS SALTADOS" value={String(drops.stats?.droppedQuanta ?? 0)} />
              <Fact label="BLOQUES SIN ESCRIBIR" value={String((drops.stats?.missingBlocks ?? 0) + (drops.stats?.failedBlocks ?? 0))} />
              <Fact
                label="NO ENTREGADAS (TRACK)"
                value={drops.inputDroppedFrames === null ? 'no informado' : `${drops.inputDroppedFrames} muestras`}
                tone={drops.inputDroppedFrames !== null && drops.inputDroppedFrames > 0 ? 'warn' : 'muted'}
              />
              <Fact label="RELOJ SISTEMA - AUDIO" value={`${drops.clockDriftMs.toFixed(1)} ms`} />
            </div>
            <p style={{ ...hintStyle, fontSize: '12px' }}>
              El veredicto usa los bloques perdidos entre el hilo de audio y el disco. Las muestras no entregadas por el track son un dato del navegador sin
              verificar: si no es cero, repite la prueba y revisa el búfer de la interfaz.
            </p>
          </div>
        )}
      </section>

      {/* 3. Latencia */}
      <section style={sectionStyle} aria-label="Latencia de ida y vuelta">
        <div style={sectionHeadStyle}>
          <Cable size={14} color={colors.cobalt} />
          <span style={sectionTitleStyle}>3. LATENCIA DE IDA Y VUELTA</span>
          <OutcomeBadge outcome={latency?.outcome ?? 'pending'} />
        </div>
        <p style={hintStyle}>
          Conecta un cable de la Salida 1 a la Entrada 1 (o acerca el audífono al micrófono). Sonarán tres ráfagas de clics: baja el volumen de los
          audífonos antes de medir. El criterio pide que las tres mediciones difieran en menos de {CRITERION_SPREAD_MS} ms. Si la medición sale bien, queda
          guardada como calibración de esta interfaz.
        </p>
        <div>
          <button type="button" className="stx-btn" data-testid="probe-latency" disabled={locked || !isOpen} onClick={() => void handleLatency()} style={actionStyle}>
            <Play size={13} />
            {busy === 'latency' ? 'MIDIENDO...' : 'MEDIR LATENCIA'}
          </button>
        </div>
        {latency && (
          <div className="stx-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {latency.error && <span style={{ fontSize: '13px', color: colors.danger }}>{latency.error}</span>}
            <div style={factsStyle}>
              {latency.rounds.map((round, index) => (
                <Fact key={index} label={`MEDICIÓN ${index + 1} (CONF. ${round.confidence.toFixed(2)})`} value={formatMs(round.seconds)} tone={round.confidence >= 0.5 ? 'muted' : 'warn'} />
              ))}
              {latency.medianMs !== null && <Fact label="MEDIANA" value={`${latency.medianMs.toFixed(2)} ms`} />}
              {latency.spreadMs !== null && <Fact label="VARIACIÓN" value={`${latency.spreadMs.toFixed(3)} ms`} tone={latency.spreadMs < CRITERION_SPREAD_MS ? 'ok' : 'warn'} />}
            </div>
          </div>
        )}
      </section>

      {/* Veredicto */}
      <section style={{ ...sectionStyle, borderColor: OUTCOME_TONE[verdict.outcome].border }} aria-label="Veredicto" data-testid="probe-verdict" data-outcome={verdict.outcome}>
        <div style={sectionHeadStyle}>
          <span style={sectionTitleStyle}>VEREDICTO</span>
          <OutcomeBadge outcome={verdict.outcome} />
        </div>
        <span style={{ fontSize: '14px', fontWeight: 600 }}>{verdict.text}</span>
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <li style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px' }}>
            <OutcomeBadge outcome={channels?.outcome ?? 'pending'} />
            Dos canales independientes
          </li>
          <li style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px' }}>
            <OutcomeBadge outcome={drops?.outcome ?? 'pending'} />
            Cero bloques perdidos en 10 minutos
            {drops && drops.outcome === 'pass' && drops.requestedSeconds < CRITERION_SECONDS && (
              <span style={{ color: colors.warning, fontFamily: mono, fontSize: '11px' }}>PRUEBA DE {drops.requestedSeconds} s</span>
            )}
          </li>
          <li style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px' }}>
            <OutcomeBadge outcome={latency?.outcome ?? 'pending'} />
            Variación de latencia menor a {CRITERION_SPREAD_MS} ms
          </li>
        </ul>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="stx-btn" data-testid="probe-copy" onClick={() => void handleCopy()} style={actionStyle}>
            {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
            {copyState === 'copied' ? 'INFORME COPIADO' : 'COPIAR INFORME'}
          </button>
          {copyState === 'failed' && <span style={{ fontSize: '12px', color: colors.warning }}>No se pudo copiar: selecciona el texto del informe de abajo.</span>}
        </div>
        <details>
          <summary className="stx-field" style={{ cursor: 'pointer', fontFamily: mono, fontSize: '11px', color: colors.muted, padding: '4px 0' }}>
            VER INFORME
          </summary>
          <pre
            data-testid="probe-report"
            style={{
              marginTop: '8px',
              padding: '12px',
              background: colors.input,
              border: `1px solid ${colors.border}`,
              borderRadius: '4px',
              fontFamily: mono,
              fontSize: '12px',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              userSelect: 'text',
            }}
          >
            {reportText}
          </pre>
        </details>
      </section>
    </div>
  )
}
