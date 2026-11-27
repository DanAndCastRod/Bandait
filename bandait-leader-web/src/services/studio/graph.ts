/**
 * El grafo de audio del Estudio. `buildGraph` es UNO SOLO para escuchar (AudioContext) y para
 * exportar (OfflineAudioContext): lo que suena es lo que se exporta (plan, regla 3).
 *
 * Por pista:  entrada -> inserts (fx) -> paneo -> fader/mute/solo -> compensacion -> salida
 *                                                                    salida -> suma del master
 *                                                                    salida -> envio -> reverb
 * Master:     suma + retorno de reverb -> fx (eq, compresor) -> volumeDb -> limitador -> `master`
 *
 * Los clips no son nodos del grafo: `scheduleClips` los programa contra las entradas de pista,
 * alineados a la muestra en el reloj del contexto (mismo patron que stemPlayer.ts).
 *
 * v2: una pista de instrumento lleva su instrumento (instruments/) conectado a la entrada de la
 * pista, antes de los efectos: mute, solo, fader, paneo, envio y efectos funcionan igual que en
 * una de audio. El instrumento SI es parte del grafo (tambien en OfflineAudioContext); sus notas
 * las programa instruments/schedule.ts. Si el instrumento no esta disponible (un WAM fuera de la
 * lista cerrada) la pista queda sin instrumento y suena su congelado.
 *
 * Compensacion de retardo: el DynamicsCompressorNode retrasa su senal unos 6 ms. Para que una
 * pista comprimida no quede corrida respecto a las demas, cada pista lleva un retardo igual a lo
 * que le falta para alcanzar a la mas lenta. `graphLatency` informa el total, que bounce recorta.
 *
 * La logica de programacion (que clips suenan en un rango, a que muestra arrancan, la curva de
 * ganancia y fades) esta en funciones puras exportadas: planClips, clipEnvelope, clipFadeFactor,
 * clipsEqual, topologySignature, graphLatency, reverbTailSeconds, trackHasSound. Se prueban con
 * node (graph.ts importa instruments/factory.ts, que tampoco toca Web Audio al cargarse).
 */
import { dbToGain } from '../stemTiming.ts'
import { createFxUnit, createReverbUnit, fxLatencySeconds, measureWaveShaperLatency, setParam, type FxUnit, type ReverbUnit } from './fx.ts'
import { instrumentKey } from './instruments/core.ts'
import { EMPTY_PREPARATION, createInstrument } from './instruments/factory.ts'
import { STUDIO_REVERB_RETURN_DB_MIN, STUDIO_REVERB_SEND_DB_MIN, type StudioClip, type StudioFx, type StudioSession, type StudioTrack } from './session.ts'
import { evaluateFadeCurve } from './waveOps.ts'
import type {
  GraphApi,
  GraphCapabilities,
  InstrumentPreparation,
  ScheduleClipsOptions,
  ScheduledClips,
  StudioBuffers,
  StudioGraph,
  StudioInstrumentNode,
} from './types.ts'

// ---------------------------------------------------------------------------
// Logica pura
// ---------------------------------------------------------------------------

/** Micro-fade cuando un clip arranca o se corta a la mitad (posicionar, repetir, exportar un tramo). */
export const DECLICK_S = 0.003
/** Constante de tiempo con la que `ScheduledClips.stop` apaga lo que suena. */
export const STOP_FADE_S = 0.002

/** Punto de la curva de ganancia de un clip: `tS` desde que arranca su fuente; entre puntos, rampa lineal. */
export interface EnvelopePoint {
  tS: number
  gain: number
}

/**
 * Factor de fade (0..1) de un clip en el instante `tInClipS` medido desde su inicio. Admite curvas
 * lineales, exponenciales y coseno elevado (scurve): es la misma curva que programa el motor y dibuja el lienzo.
 */
export function clipFadeFactor(clip: Pick<StudioClip, 'lengthS' | 'fadeInS' | 'fadeOutS' | 'fadeShape'>, tInClipS: number): number {
  const t = Math.max(0, Math.min(tInClipS, clip.lengthS))
  const shape = clip.fadeShape ?? 'linear'
  const fadeIn = clip.fadeInS > 0 ? evaluateFadeCurve(Math.min(1, t / clip.fadeInS), shape) : 1
  const fadeOut = clip.fadeOutS > 0 ? evaluateFadeCurve(Math.min(1, (clip.lengthS - t) / clip.fadeOutS), shape) : 1
  return Math.max(0, Math.min(fadeIn, fadeOut))
}

/**
 * Curva de ganancia (ganancia de clip por fades y polaridad) del tramo de un clip que va de `skipS`
 * a `skipS + durationS`, ambos medidos desde el inicio del clip. Si el tramo no empieza en el inicio
 * del clip o no llega a su final, agrega un micro-fade de DECLICK_S en ese borde.
 */
export function clipEnvelope(
  clip: Pick<StudioClip, 'lengthS' | 'fadeInS' | 'fadeOutS' | 'gainDb' | 'phaseInvert' | 'fadeShape'>,
  skipS: number,
  durationS: number,
): EnvelopePoint[] {
  const polarity = clip.phaseInvert === true ? -1 : 1
  const gain = dbToGain(clip.gainDb) * polarity
  const start = Math.max(0, skipS)
  const end = Math.min(clip.lengthS, start + Math.max(0, durationS))
  const span = end - start
  if (!(span > 0)) return [{ tS: 0, gain: 0 }]
  const edge = 1e-6
  const declickIn = start > edge ? Math.min(DECLICK_S, span / 2) : 0
  const declickOut = end < clip.lengthS - edge ? Math.min(DECLICK_S, span / 2) : 0
  const marks = [start, end, clip.fadeInS, clip.lengthS - clip.fadeOutS]
  if (declickIn > 0) marks.push(start + declickIn)
  if (declickOut > 0) marks.push(end - declickOut)

  // Con curvas no lineales ('exp' o 'scurve'), muestrear 8 segmentos por fade para rampa fiel (< 0,1 dB).
  const shape = clip.fadeShape ?? 'linear'
  if (shape !== 'linear') {
    const steps = 8
    if (clip.fadeInS > 0) {
      for (let k = 1; k < steps; k++) marks.push((clip.fadeInS * k) / steps)
    }
    if (clip.fadeOutS > 0) {
      const foStart = clip.lengthS - clip.fadeOutS
      for (let k = 1; k < steps; k++) marks.push(foStart + (clip.fadeOutS * k) / steps)
    }
  }

  const times = marks.filter((t) => t >= start && t <= end).sort((a, b) => a - b)
  const points: EnvelopePoint[] = []
  for (const t of times) {
    const tS = t - start
    if (points.length > 0 && tS - points[points.length - 1].tS < 1e-9) continue
    let factor = clipFadeFactor(clip, t)
    if (declickIn > 0) factor *= Math.min(1, (t - start) / declickIn)
    if (declickOut > 0) factor *= Math.min(1, (end - t) / declickOut)
    const g = gain * Math.max(0, factor)
    points.push({ tS, gain: Object.is(g, -0) ? 0 : g })
  }
  return points
}

/** Un clip (o el tramo de un clip) listo para programar. Tiempos ya cuantizados a muestras. */
export interface ClipPlan {
  trackId: string
  clipId: string
  assetId: string
  /** Muestras despues de `fromS` en que arranca la fuente (>= 0). */
  startFrame: number
  /** Primera muestra del audio que suena. */
  offsetFrame: number
  /** Muestras que suenan. */
  frames: number
  /** Las mismas tres cantidades en segundos (frame / sampleRate). */
  delayS: number
  bufferOffsetS: number
  durationS: number
  envelope: EnvelopePoint[]
}

export interface PlanClipsOptions {
  fromS: number
  untilS?: number
  trackIds?: ReadonlySet<string>
  /** Frecuencia del contexto donde se va a programar. */
  sampleRate: number
}

/**
 * Que clips suenan desde `fromS` (y hasta `untilS`, si viene) y en que muestra arranca cada uno.
 * Solo los clips con `active: true`; mute y solo no se miran aqui (son del grafo).
 *
 * La cuantizacion se ancla al origen del audio de cada clip (startS - offsetS): dos clips que
 * salen de dividir uno solo comparten origen, asi que el segundo empieza exactamente en la
 * muestra donde termina el primero, sin repetir ni saltarse ninguna.
 */
export function planClips(session: StudioSession, options: PlanClipsOptions): ClipPlan[] {
  const { fromS, sampleRate } = options
  const untilS = options.untilS ?? Number.POSITIVE_INFINITY
  const plans: ClipPlan[] = []
  if (!(sampleRate > 0) || !Number.isFinite(fromS)) return plans
  for (const track of session.tracks) {
    if (options.trackIds && !options.trackIds.has(track.id)) continue
    for (const clip of track.clips) {
      if (!clip.active) continue
      const playStart = Math.max(clip.startS, fromS)
      const playEnd = Math.min(clip.startS + clip.lengthS, untilS)
      if (!(playEnd > playStart)) continue
      const origin = clip.startS - clip.offsetS
      const originFrame = Math.round((origin - fromS) * sampleRate)
      let offsetFrame = Math.max(0, Math.round((playStart - origin) * sampleRate))
      const endFrame = Math.round((playEnd - origin) * sampleRate)
      let startFrame = originFrame + offsetFrame
      if (startFrame < 0) {
        // Dos redondeos pueden dejar el arranque una muestra antes de `fromS`: se entra una despues.
        offsetFrame -= startFrame
        startFrame = 0
      }
      const frames = endFrame - offsetFrame
      if (frames < 1) continue
      plans.push({
        trackId: track.id,
        clipId: clip.id,
        assetId: clip.assetId,
        startFrame,
        offsetFrame,
        frames,
        delayS: startFrame / sampleRate,
        bufferOffsetS: offsetFrame / sampleRate,
        durationS: frames / sampleRate,
        envelope: clipEnvelope(clip, playStart - clip.startS, playEnd - playStart),
      })
    }
  }
  return plans
}

function sameClip(a: StudioClip, b: StudioClip): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.assetId === b.assetId &&
      a.startS === b.startS &&
      a.offsetS === b.offsetS &&
      a.lengthS === b.lengthS &&
      a.gainDb === b.gainDb &&
      a.fadeInS === b.fadeInS &&
      a.fadeOutS === b.fadeOutS &&
      a.active === b.active &&
      (a.phaseInvert === true) === (b.phaseInvert === true) &&
      (a.fadeShape ?? 'linear') === (b.fadeShape ?? 'linear'))
  )
}

/**
 * true si las dos sesiones programan exactamente los mismos clips (cambios de fader, paneo,
 * efectos, nombre o grupo de toma no cuentan). El motor lo usa para no reprogramar de mas.
 */
export function clipsEqual(a: StudioSession, b: StudioSession): boolean {
  if (a === b || a.tracks === b.tracks) return true
  if (a.tracks.length !== b.tracks.length) return false
  const byId = new Map<string, StudioTrack>()
  for (const track of a.tracks) byId.set(track.id, track)
  for (const track of b.tracks) {
    const other = byId.get(track.id)
    if (!other) return false
    if (other.clips === track.clips) continue
    if (other.clips.length !== track.clips.length) return false
    for (let i = 0; i < track.clips.length; i++) {
      if (!sameClip(other.clips[i], track.clips[i])) return false
    }
  }
  return true
}

/**
 * Huella de la topologia: pistas (sin importar el orden) con los tipos de sus efectos en orden,
 * y los del master. Si dos sesiones tienen la misma huella, `StudioGraph.update` alcanza.
 * v2: una pista de instrumento agrega `@` y su tipo (y el plugin, en WAM): cambiar de instrumento
 * reconstruye; cambiar sus parametros no.
 */
export function topologySignature(session: StudioSession): string {
  const chain = (fx: readonly StudioFx[]) => fx.map((f) => f.type).join(',')
  const tracks = session.tracks.map((t) => (t.kind === 'instrument' ? `${t.id}@${instrumentKey(t.instrument)}:${chain(t.fx)}` : `${t.id}:${chain(t.fx)}`)).sort()
  return `${tracks.join('|')}#${chain(session.master.fx)}`
}

export interface GraphLatency {
  /** Retardo comun de todas las salidas de pista (ya compensadas entre si), en segundos. */
  trackBusS: number
  /** Retardo que agrega la cadena del master. */
  masterS: number
  /** trackBusS + masterS: lo que tarda la mezcla en salir por `master`. */
  totalS: number
}

function chainLatency(fx: readonly StudioFx[], sampleRate: number, limiterWorklet: boolean): number {
  let total = 0
  for (const f of fx) total += fxLatencySeconds(f.type, sampleRate, limiterWorklet)
  return total
}

/** Retardo del grafo de `session` a `sampleRate`. El bypass no lo cambia: el camino seco retrasa igual. */
export function graphLatency(session: StudioSession, sampleRate: number, limiterWorklet: boolean): GraphLatency {
  let trackBusS = 0
  for (const track of session.tracks) trackBusS = Math.max(trackBusS, chainLatency(track.fx, sampleRate, limiterWorklet))
  const masterS = chainLatency(session.master.fx, sampleRate, limiterWorklet)
  return { trackBusS, masterS, totalS: trackBusS + masterS }
}

/** Cola de reverb que hay que dejar sonar despues del ultimo clip; 0 si ninguna pista audible envia. */
export function reverbTailSeconds(session: StudioSession): number {
  if (session.master.reverb.returnDb <= STUDIO_REVERB_RETURN_DB_MIN) return 0
  const anySolo = session.tracks.some((t) => t.solo)
  const sends = session.tracks.some((t) => trackAudible(t, anySolo) && t.reverbSendDb > STUDIO_REVERB_SEND_DB_MIN && trackHasSound(t))
  return sends ? session.master.reverb.decayS : 0
}

/** true si la pista tiene algo que suene: un clip de audio activo, un clip MIDI sin silenciar o un congelado. */
export function trackHasSound(track: Pick<StudioTrack, 'clips' | 'midiClips' | 'frozenAssetId'>): boolean {
  return track.clips.some((c) => c.active) || (track.midiClips ?? []).some((c) => !c.muted) || Boolean(track.frozenAssetId)
}

/** Regla de STUDIO_V1.md 2.3: con algun solo suenan solo las pistas en solo; mute gana sobre solo. */
export function trackAudible(track: Pick<StudioTrack, 'mute' | 'solo'>, anySolo: boolean): boolean {
  return !track.mute && (!anySolo || track.solo)
}

// ---------------------------------------------------------------------------
// Contexto: worklet del limitador
// ---------------------------------------------------------------------------

const preparing = new WeakMap<BaseAudioContext, Promise<GraphCapabilities>>()
const prepared = new WeakMap<BaseAudioContext, GraphCapabilities>()

async function loadLimiterWorklet(ctx: BaseAudioContext): Promise<GraphCapabilities> {
  try {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return { limiterWorklet: false }
    const { LIMITER_WORKLET_URL } = await import('./limiterModule.ts')
    await ctx.audioWorklet.addModule(LIMITER_WORKLET_URL)
    return { limiterWorklet: true }
  } catch {
    // Navegador sin AudioWorklet o modulo que no carga: el grafo usa el limitador de respaldo.
    return { limiterWorklet: false }
  }
}

export function prepareGraphContext(ctx: BaseAudioContext): Promise<GraphCapabilities> {
  let pending = preparing.get(ctx)
  if (!pending) {
    // El retardo del saturador se mide antes de construir el grafo: entra en la compensacion entre pistas.
    pending = Promise.all([loadLimiterWorklet(ctx), measureWaveShaperLatency(ctx.sampleRate)]).then(([capabilities]) => {
      prepared.set(ctx, capabilities)
      return capabilities
    })
    preparing.set(ctx, pending)
  }
  return pending
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

/** Lo que devuelve buildGraph: el contrato de types.ts mas el retardo real del grafo construido. */
export interface BuiltStudioGraph extends StudioGraph {
  /** Retardo real (segun el limitador que de verdad quedo: worklet o respaldo). */
  readonly latency: GraphLatency
  /** true si el limitador del master es el worklet; false si es el respaldo o no hay limitador. */
  readonly limiterWorklet: boolean
}

interface Strip {
  track: StudioTrack
  audible: boolean
  input: GainNode
  units: FxUnit[]
  panner: StereoPannerNode
  fader: GainNode
  send: GainNode
  output: GainNode
  nodes: AudioNode[]
}

function disconnect(node: AudioNode): void {
  try {
    node.disconnect()
  } catch {
    // ya desconectado
  }
}

export function buildGraph(ctx: BaseAudioContext, session: StudioSession, buffers: StudioBuffers, instruments?: InstrumentPreparation): BuiltStudioGraph {
  // Los canales de cada audio no cambian la topologia: una fuente mono sube a estereo en el
  // paneo. `buffers` llega al sampler, que busca sus muestras al tocar cada nota.
  const preparation = instruments ?? EMPTY_PREPARATION
  const wantWorklet = prepared.get(ctx)?.limiterWorklet ?? false
  const signature = topologySignature(session)
  const extras: AudioNode[] = []
  let disposed = false
  let applied = session

  // --- master ---
  const sum = ctx.createGain()
  sum.channelCount = 2
  sum.channelCountMode = 'explicit'
  const reverb: ReverbUnit = createReverbUnit(ctx, session.master.reverb.decayS, session.master.reverb.returnDb)
  reverb.output.connect(sum)
  const masterUnits: FxUnit[] = []
  let limiterUnit: FxUnit | null = null
  let limiterWorklet = false
  let node: AudioNode = sum
  for (const fx of session.master.fx) {
    if (fx.type === 'limiter') continue
    const { unit } = createFxUnit(ctx, fx, false)
    node.connect(unit.input)
    node = unit.output
    masterUnits.push(unit)
  }
  const masterVolume = ctx.createGain()
  masterVolume.gain.value = dbToGain(session.master.volumeDb)
  node.connect(masterVolume)
  node = masterVolume
  const limiterFx = session.master.fx.find((fx) => fx.type === 'limiter')
  if (limiterFx) {
    const created = createFxUnit(ctx, limiterFx, wantWorklet)
    limiterUnit = created.unit
    limiterWorklet = created.worklet
    node.connect(limiterUnit.input)
    node = limiterUnit.output
  }
  const master = ctx.createGain()
  node.connect(master)
  extras.push(sum, masterVolume, master)

  // --- pistas ---
  const stripLatency = (strip: FxUnit[]) => strip.reduce((total, unit) => total + unit.latencyS, 0)
  const anySolo = session.tracks.some((t) => t.solo)
  const built = session.tracks.map((track) => {
    const units = track.fx.map((fx) => createFxUnit(ctx, fx, false).unit)
    return { track, units, latencyS: stripLatency(units) }
  })
  const trackBusS = built.reduce((max, b) => Math.max(max, b.latencyS), 0)
  const strips = new Map<string, Strip>()
  const trackInputs = new Map<string, AudioNode>()
  const trackOutputs = new Map<string, AudioNode>()
  for (const { track, units, latencyS } of built) {
    const input = ctx.createGain()
    const nodes: AudioNode[] = [input]
    let tail: AudioNode = input
    for (const unit of units) {
      tail.connect(unit.input)
      tail = unit.output
    }
    const panner = ctx.createStereoPanner()
    panner.pan.value = track.pan
    tail.connect(panner)
    const fader = ctx.createGain()
    const audible = trackAudible(track, anySolo)
    fader.gain.value = audible ? dbToGain(track.volumeDb) : 0
    panner.connect(fader)
    tail = fader
    const lag = trackBusS - latencyS
    if (lag > 0) {
      const delay = ctx.createDelay(Math.max(0.05, lag * 2))
      delay.delayTime.value = lag
      tail.connect(delay)
      tail = delay
      nodes.push(delay)
    }
    const output = ctx.createGain()
    tail.connect(output)
    output.connect(sum)
    const send = ctx.createGain()
    send.gain.value = dbToGain(track.reverbSendDb)
    output.connect(send)
    send.connect(reverb.input)
    nodes.push(panner, fader, output, send)
    strips.set(track.id, { track, audible, input, units, panner, fader, send, output, nodes })
    trackInputs.set(track.id, input)
    trackOutputs.set(track.id, output)
  }

  // --- instrumentos (v2): la salida del instrumento entra donde entrarian los clips de audio ---
  const instrumentNodes = new Map<string, StudioInstrumentNode>()
  /** Los WAM son de la preparacion (se reutilizan entre grafos): el grafo solo los desconecta. */
  const ownedInstruments = new Set<StudioInstrumentNode>()
  for (const track of session.tracks) {
    if (track.kind !== 'instrument' || !track.instrument || preparation.unavailable.has(track.id)) continue
    const input = trackInputs.get(track.id)
    const node = input ? createInstrument(ctx, track.id, track.instrument, buffers, preparation) : null
    if (!input || !node) continue
    node.output.connect(input)
    instrumentNodes.set(track.id, node)
    if (track.instrument.type !== 'wam') ownedInstruments.add(node)
  }

  const masterS = masterUnits.reduce((total, unit) => total + unit.latencyS, 0) + (limiterUnit ? limiterUnit.latencyS : 0)
  const latency: GraphLatency = { trackBusS, masterS, totalS: trackBusS + masterS }

  const update = (next: StudioSession): boolean => {
    if (disposed) return false
    if (next === applied) return true
    if (topologySignature(next) !== signature) return false
    // Primero lo que puede obligar a reconstruir, para no dejar cambios a medias.
    for (const track of next.tracks) {
      const strip = strips.get(track.id)
      if (!strip) return false
      const node = instrumentNodes.get(track.id)
      if (node && !ownedInstruments.has(node) && track.instrument !== strip.track.instrument) return false
    }
    const solo = next.tracks.some((t) => t.solo)
    for (const track of next.tracks) {
      const strip = strips.get(track.id)
      if (!strip) return false
      const audible = trackAudible(track, solo)
      if (strip.track === track && strip.audible === audible) continue
      const node = instrumentNodes.get(track.id)
      // Mismo tipo garantizado por la huella: synth, drums y sampler aplican siempre en caliente.
      if (node && track.instrument && track.instrument !== strip.track.instrument) node.update(track.instrument)
      track.fx.forEach((fx, i) => {
        if (strip.track.fx[i] !== fx) strip.units[i].update(fx, false)
      })
      setParam(ctx, strip.panner.pan, track.pan, false)
      setParam(ctx, strip.fader.gain, audible ? dbToGain(track.volumeDb) : 0, false)
      setParam(ctx, strip.send.gain, dbToGain(track.reverbSendDb), false)
      strip.track = track
      strip.audible = audible
    }
    if (next.master !== applied.master) {
      let unitIndex = 0
      for (const fx of next.master.fx) {
        if (fx.type === 'limiter') limiterUnit?.update(fx, false)
        else masterUnits[unitIndex++].update(fx, false)
      }
      setParam(ctx, masterVolume.gain, dbToGain(next.master.volumeDb), false)
      reverb.update(next.master.reverb.decayS, next.master.reverb.returnDb, false)
    }
    applied = next
    return true
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const [trackId, node] of instrumentNodes) {
      if (ownedInstruments.has(node)) {
        node.dispose()
      } else {
        const input = trackInputs.get(trackId)
        try {
          if (input) node.output.disconnect(input)
        } catch {
          // ya desconectado
        }
      }
    }
    instrumentNodes.clear()
    ownedInstruments.clear()
    for (const strip of strips.values()) {
      for (const unit of strip.units) unit.dispose()
      for (const n of strip.nodes) disconnect(n)
    }
    strips.clear()
    trackInputs.clear()
    trackOutputs.clear()
    for (const unit of masterUnits) unit.dispose()
    limiterUnit?.dispose()
    reverb.dispose()
    for (const n of extras) disconnect(n)
  }

  return { master, trackInputs, trackOutputs, instruments: instrumentNodes, update, dispose, latency, limiterWorklet }
}

// ---------------------------------------------------------------------------
// scheduleClips
// ---------------------------------------------------------------------------

function applyEnvelope(param: AudioParam, envelope: readonly EnvelopePoint[], when: number): void {
  const first = envelope[0]
  param.value = first.gain
  // Sin fades ni micro-fades la ganancia es constante: no hace falta automatizacion.
  if (envelope.every((point) => point.gain === first.gain)) return
  param.setValueAtTime(first.gain, when)
  for (let i = 1; i < envelope.length; i++) param.linearRampToValueAtTime(envelope[i].gain, when + envelope[i].tS)
}

export function scheduleClips(ctx: BaseAudioContext, graph: StudioGraph, session: StudioSession, buffers: StudioBuffers, options: ScheduleClipsOptions): ScheduledClips {
  const sampleRate = ctx.sampleRate
  // El arranque tambien se cuantiza: todas las fuentes de la tanda caen en la misma rejilla.
  const baseFrame = Math.round(Math.max(0, options.atCtxTime) * sampleRate)
  const plans = planClips(session, { fromS: options.fromS, untilS: options.untilS, trackIds: options.trackIds, sampleRate })
  /** Una compuerta por pista y por tanda: detener es apagarla, sin tocar la curva de cada clip. */
  const gates = new Map<string, GainNode>()
  const voices = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>()
  let disposed = false

  for (const plan of plans) {
    const buffer = buffers.get(plan.assetId)
    const input = graph.trackInputs.get(plan.trackId)
    if (!buffer || !input) continue
    const available = buffer.duration - plan.bufferOffsetS
    if (!(available > 0)) continue
    let gate = gates.get(plan.trackId)
    if (!gate) {
      gate = ctx.createGain()
      gate.connect(input)
      gates.set(plan.trackId, gate)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    const when = (baseFrame + plan.startFrame) / sampleRate
    applyEnvelope(gain.gain, plan.envelope, when)
    source.connect(gain)
    gain.connect(gate)
    const voice = { source, gain }
    source.onended = () => {
      voices.delete(voice)
      source.disconnect()
      gain.disconnect()
    }
    source.start(when, plan.bufferOffsetS, Math.min(plan.durationS, available))
    voices.add(voice)
  }

  return {
    stop(atCtxTime?: number) {
      if (disposed) return
      const at = Math.max(atCtxTime ?? ctx.currentTime, ctx.currentTime)
      for (const gate of gates.values()) gate.gain.setTargetAtTime(0, at, STOP_FADE_S)
      for (const { source } of voices) {
        try {
          source.stop(at + STOP_FADE_S * 10)
        } catch {
          // ya detenida
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const { source, gain } of voices) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // ya detenida
        }
        source.disconnect()
        gain.disconnect()
      }
      voices.clear()
      for (const gate of gates.values()) gate.disconnect()
      gates.clear()
    },
  }
}

void ({ prepareGraphContext, buildGraph, scheduleClips } satisfies GraphApi)
