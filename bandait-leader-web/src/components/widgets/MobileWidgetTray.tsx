import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Activity,
  Check,
  Circle,
  Compass,
  Gauge,
  GitBranch,
  Headphones,
  Mic,
  Move,
  Play,
  Sliders,
  Square,
  Wrench,
  X,
} from 'lucide-react'
import { useGlobalAudioEngine } from '../../context/globalAudioContextCore'
import { useHub } from '../../context/hubContextCore'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { cloudBandKey } from '../../services/stemCloud'
import { stemCloudTarget } from '../../services/stemCloudConfig'
import { detectBpmLocal, detectKeyLocal, detectPitchYin, type PitchDetectionResult } from '../../services/studio/dspMath'
import { defaultTrack, newStudioId, type StudioSession } from '../../services/studio/session'
import { addAsset, addClip, addTrack } from '../../services/studio/sessionOps'
import * as studioStore from '../../services/studio/studioStore'
import { applyXyMacro, type XYMode } from '../../services/studio/xyMacro'
import {
  POCKET_SCHEDULER_MS,
  clampPocketBpm,
  linearRegressionTapBpm,
  schedulePocketWindow,
  startPocketCursor,
  type PocketClick,
  type PocketCursor,
} from '../../services/pocketMetronome'
import { encodeWav24 } from '../../services/wav'
import { createSession, withFx, type StudioController } from '../studio/studioState'
import { cardStyle, colors, ghostButton, labelStyle, mono, primaryButton, radius } from '../hubStyles'

export type MobileWidgetId = 'tuner' | 'metronome' | 'xypad' | 'recorder' | 'ab'

interface Props {
  initialWidget?: MobileWidgetId | null
  offsetBottomPx?: number
  onOpenStudio: () => void
}

/** Lo mismo que el conmutador movil del Estudio: el boton flotante solo existe en pantallas chicas. */
const MOBILE_QUERY = '(max-width: 767px)'
/** Objetivo tactil minimo (WCAG 2.5.5 / guias de iOS y Android). */
const TOUCH = '44px'

type AudioContextCtor = typeof AudioContext

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  return window.AudioContext || (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext || null
}

/** Crea el AudioContext y lo reanuda DENTRO del gesto (iOS solo lo deja sonar o escuchar asi). */
function contextInGesture(): AudioContext | null {
  const Ctor = audioContextCtor()
  if (!Ctor) return null
  try {
    const ctx = new Ctor()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    return ctx
  } catch {
    return null
  }
}

function closeContext(ctx: AudioContext | null): void {
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
}

/** true mientras la sesion del Estudio graba (re-render solo cuando cambia). */
function useStudioRecording(controller: StudioController | null): boolean {
  const subscribe = useCallback((cb: () => void) => (controller ? controller.subscribe(cb) : () => undefined), [controller])
  const get = useCallback(() => (controller ? controller.snapshot().recording : false), [controller])
  return useSyncExternalStore(subscribe, get, () => false)
}

const MIC_BUSY_TEXT = 'El Estudio está grabando: el micrófono está ocupado hasta que termine la toma.'

// ---------------------------------------------------------------------------
// 1. Afinador cromatico (YIN)
// ---------------------------------------------------------------------------

const TunerWidget: React.FC<{ studioRecording: boolean }> = ({ studioRecording }) => {
  const [listening, setListening] = useState(false)
  const [starting, setStarting] = useState(false)
  const [a4Hz, setA4HzState] = useState(440)
  const [pitch, setPitch] = useState<PitchDetectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)
  // La referencia la lee el bucle de rAF: por ref, no por el cierre del render en que arranco.
  const a4Ref = useRef(440)
  // Cada arranque lleva un numero; detener o desmontar lo invalida (un getUserMedia pendiente se descarta).
  const genRef = useRef(0)

  const setA4Hz = (next: number) => {
    a4Ref.current = next
    setA4HzState(next)
  }

  const stop = useCallback(() => {
    genRef.current++
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    closeContext(ctxRef.current)
    ctxRef.current = null
    setListening(false)
    setStarting(false)
  }, [])

  useEffect(() => () => stop(), [stop])

  const start = async () => {
    if (listening || starting || studioRecording) return
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Este navegador no da acceso al micrófono.')
      return
    }
    const ctx = contextInGesture()
    if (!ctx) {
      setError('Este navegador no tiene Web Audio.')
      return
    }
    const gen = ++genRef.current
    ctxRef.current = ctx
    setStarting(true)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
    } catch {
      if (gen === genRef.current) {
        stop()
        setError('Permite el acceso al micrófono para usar el afinador cromático.')
      } else {
        closeContext(ctx)
      }
      return
    }
    if (gen !== genRef.current) {
      // Se detuvo o se desmonto mientras el navegador pedia permiso.
      stream.getTracks().forEach((t) => t.stop())
      closeContext(ctx)
      return
    }
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 4096
    src.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    streamRef.current = stream
    setStarting(false)
    setListening(true)

    let lastTick = 0
    const loop = (now: number) => {
      if (gen !== genRef.current) return
      if (now - lastTick >= 65) {
        lastTick = now
        analyser.getFloatTimeDomainData(buf)
        const res = detectPitchYin(buf, ctx.sampleRate, { referenceA4Hz: a4Ref.current, threshold: 0.14 })
        if (res && res.confidence >= 0.7) setPitch(res)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  const inTune = pitch ? Math.abs(pitch.cents) <= 4 : false
  const needlePct = pitch ? Math.max(0, Math.min(100, 50 + pitch.cents)) : 50
  const smallBtn: React.CSSProperties = { ...ghostButton, padding: '4px 10px', minHeight: TOUCH, minWidth: TOUCH, justifyContent: 'center' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} data-testid="widget-tuner">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={labelStyle}>REFERENCIA LA4: {a4Hz} HZ</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" onClick={() => setA4Hz(Math.max(432, a4Hz - 1))} style={smallBtn} aria-label="Bajar la referencia 1 Hz">
            -1 Hz
          </button>
          <button type="button" onClick={() => setA4Hz(440)} style={smallBtn} aria-label="Referencia 440 Hz">
            440
          </button>
          <button type="button" onClick={() => setA4Hz(Math.min(446, a4Hz + 1))} style={smallBtn} aria-label="Subir la referencia 1 Hz">
            +1 Hz
          </button>
        </div>
      </div>

      <div
        style={{
          ...cardStyle,
          padding: '16px',
          textAlign: 'center',
          background: 'var(--b-well)',
          border: inTune ? '1px solid var(--b-success)' : '1px solid var(--b-border)',
        }}
      >
        <div style={{ fontFamily: mono, fontSize: '42px', fontWeight: 800, color: inTune ? colors.success : colors.text, lineHeight: 1.1 }}>
          {pitch ? `${pitch.noteName}${pitch.octave}` : '--'}
        </div>
        <div style={{ fontFamily: mono, fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
          {pitch ? `${pitch.hz.toFixed(1)} Hz · ${pitch.cents >= 0 ? '+' : ''}${pitch.cents.toFixed(1)} cents` : 'Toca una cuerda o canta frente al micrófono'}
        </div>

        {/* Barra de desviacion en cents (-50 .. +50) */}
        <div
          style={{
            position: 'relative',
            height: '12px',
            marginTop: '12px',
            borderRadius: '9999px',
            background: 'var(--b-surface)',
            border: '1px solid var(--b-border-soft)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              bottom: 0,
              width: '2px',
              background: 'var(--b-muted)',
              transform: 'translateX(-50%)',
            }}
          />
          {pitch && (
            <div
              style={{
                position: 'absolute',
                left: `${needlePct}%`,
                top: '1px',
                bottom: '1px',
                width: '10px',
                borderRadius: '9999px',
                background: inTune ? 'var(--b-success)' : 'var(--b-warning)',
                transform: 'translateX(-50%)',
              }}
            />
          )}
        </div>
      </div>

      {error && <div style={{ fontSize: '12px', color: colors.danger }}>{error}</div>}
      {studioRecording && !listening && <div style={{ fontSize: '12px', color: colors.muted }}>{MIC_BUSY_TEXT}</div>}

      <button
        type="button"
        onClick={() => (listening ? stop() : void start())}
        disabled={starting || (!listening && studioRecording)}
        style={{ ...primaryButton(listening ? colors.danger : undefined), minHeight: TOUCH, justifyContent: 'center' }}
        data-testid="widget-tuner-toggle"
      >
        <Mic size={15} />
        {listening ? 'DETENER MICRÓFONO' : starting ? 'ABRIENDO MICRÓFONO...' : 'ENCENDER AFINADOR'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Tap tempo + metronomo de bolsillo (programado en el reloj del AudioContext)
// ---------------------------------------------------------------------------

/** Un golpe de clic en `click.time` del reloj del AudioContext (nunca en "ahora"). */
function scheduleClickSound(ctx: AudioContext, click: PocketClick): void {
  const t = click.time
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(click.accent ? 1120 : 780, t)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.linearRampToValueAtTime(click.accent ? 0.35 : 0.2, t + 0.002)
  gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.045)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.onended = () => {
    osc.disconnect()
    gain.disconnect()
  }
  osc.start(t)
  osc.stop(t + 0.05)
}

const PocketMetronomeWidget: React.FC<{ controller: StudioController | null }> = ({ controller }) => {
  const { activeSong, sharing, saveSong } = useHub()
  const [bpm, setBpm] = useState<number>(() => controller?.snapshot().session.bpm ?? activeSong?.bpm ?? 120)
  const [beatsPerBar, setBeatsPerBar] = useState<number>(() => controller?.snapshot().session.beatsPerBar ?? activeSong?.beatsPerBar ?? 4)
  const [playing, setPlaying] = useState(false)
  const tapsRef = useRef<number[]>([])
  // El programador lee tempo y compas por ref: cambiarlos con el clic sonando no lo reinicia.
  const bpmRef = useRef(bpm)
  const bpbRef = useRef(beatsPerBar)
  const ctxRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<number>(0)
  const rafRef = useRef<number>(0)
  const cursorRef = useRef<PocketCursor | null>(null)
  /** Golpes ya programados que el pulso visual todavia no mostro. */
  const pendingRef = useRef<PocketClick[]>([])
  const dotsRef = useRef<Array<HTMLSpanElement | null>>([])
  const litRef = useRef(-1)

  useEffect(() => {
    bpmRef.current = bpm
  }, [bpm])
  useEffect(() => {
    bpbRef.current = beatsPerBar
  }, [beatsPerBar])

  /** Pinta el pulso por DOM (sin estado React por golpe). */
  const paintBeat = useCallback((beat: number) => {
    if (litRef.current === beat) return
    litRef.current = beat
    dotsRef.current.forEach((dot, idx) => {
      if (!dot) return
      dot.style.background = idx === beat ? (idx === 0 ? 'var(--b-accent)' : 'var(--b-cobalt)') : 'var(--b-border-strong)'
      dot.style.transform = idx === beat ? 'scale(1.25)' : 'scale(1)'
    })
  }, [])

  const stopClick = useCallback(() => {
    window.clearInterval(timerRef.current)
    cancelAnimationFrame(rafRef.current)
    cursorRef.current = null
    pendingRef.current = []
    paintBeat(-1)
    setPlaying(false)
  }, [paintBeat])

  useEffect(
    () => () => {
      window.clearInterval(timerRef.current)
      cancelAnimationFrame(rafRef.current)
      closeContext(ctxRef.current)
      ctxRef.current = null
    },
    []
  )

  const startClick = () => {
    // El AudioContext se crea o reanuda aqui, dentro del toque (iOS).
    let ctx = ctxRef.current
    if (!ctx || ctx.state === 'closed') {
      ctx = contextInGesture()
      ctxRef.current = ctx
    } else if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined)
    }
    if (!ctx) return
    const audioCtx = ctx
    cursorRef.current = startPocketCursor(audioCtx.currentTime)
    pendingRef.current = []

    const tick = () => {
      const cursor = cursorRef.current
      if (!cursor || audioCtx.state === 'closed') return
      const { clicks, cursor: next } = schedulePocketWindow(cursor, audioCtx.currentTime, bpmRef.current, bpbRef.current)
      cursorRef.current = next
      for (const click of clicks) {
        try {
          scheduleClickSound(audioCtx, click)
        } catch {
          // Sin salida de audio: el pulso visual sigue.
        }
        pendingRef.current.push(click)
      }
    }
    const draw = () => {
      const now = audioCtx.currentTime
      const queue = pendingRef.current
      let shown = -1
      while (queue.length > 0 && queue[0].time <= now) shown = queue.shift()!.beat
      if (shown >= 0) paintBeat(shown)
      rafRef.current = requestAnimationFrame(draw)
    }
    tick()
    window.clearInterval(timerRef.current)
    timerRef.current = window.setInterval(tick, POCKET_SCHEDULER_MS)
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(draw)
    setPlaying(true)
  }

  const handleTap = () => {
    const now = performance.now()
    const prev = tapsRef.current
    if (prev.length > 0 && now - prev[prev.length - 1] > 2200) {
      tapsRef.current = [now]
      return
    }
    const next = [...prev, now].slice(-8)
    tapsRef.current = next
    const est = linearRegressionTapBpm(next)
    if (est !== null) setBpm(est)
  }

  const applyBpm = () => {
    if (controller) {
      controller.updateMeta({ bpm, beatsPerBar }, `Tempo ${bpm} BPM`)
    } else if (activeSong && sharing.activeCanEdit) {
      saveSong({ ...activeSong, bpm: Math.round(bpm), beatsPerBar, updatedAt: new Date().toISOString() })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} data-testid="widget-metronome">
      <div style={{ ...cardStyle, padding: '14px', background: 'var(--b-well)', textAlign: 'center' }}>
        <div style={{ fontFamily: mono, fontSize: '36px', fontWeight: 800, color: colors.text }}>{bpm} BPM</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '8px' }} aria-hidden>
          {Array.from({ length: beatsPerBar }, (_, idx) => (
            <span
              key={idx}
              ref={(el) => {
                dotsRef.current[idx] = el
              }}
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '9999px',
                background: 'var(--b-border-strong)',
                transition: 'transform 60ms ease-out',
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {[3, 4, 6].map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => {
              setBeatsPerBar(b)
              litRef.current = -1
            }}
            aria-pressed={beatsPerBar === b}
            style={{
              ...ghostButton,
              flex: 1,
              minHeight: TOUCH,
              justifyContent: 'center',
              background: beatsPerBar === b ? 'var(--b-accent)' : 'var(--b-elevated)',
              color: beatsPerBar === b ? 'var(--b-on-accent)' : colors.text,
            }}
          >
            {b}/{b === 6 ? 8 : 4}
          </button>
        ))}
      </div>

      <input
        type="range"
        min={40}
        max={240}
        step={1}
        value={Math.round(bpm)}
        onChange={(e) => setBpm(clampPocketBpm(Number(e.target.value)))}
        aria-label="Tempo BPM"
        style={{ minHeight: TOUCH }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <button
          type="button"
          onClick={handleTap}
          style={{ ...ghostButton, minHeight: '48px', justifyContent: 'center', fontWeight: 700 }}
          data-testid="widget-metronome-tap"
        >
          MARCAR TEMPO
        </button>
        <button
          type="button"
          onClick={() => (playing ? stopClick() : startClick())}
          style={{ ...primaryButton(), minHeight: '48px', justifyContent: 'center' }}
          data-testid="widget-metronome-play"
        >
          {playing ? <Square size={14} /> : <Play size={14} />}
          {playing ? 'DETENER' : 'SONAR CLIC'}
        </button>
      </div>

      {(controller || (activeSong && sharing.activeCanEdit)) && (
        <button type="button" onClick={applyBpm} style={{ ...ghostButton, minHeight: TOUCH, justifyContent: 'center' }}>
          <Check size={14} />
          APLICAR A {controller ? 'SESIÓN ESTUDIO' : `«${activeSong?.title.slice(0, 18)}»`}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Pad X/Y de macros de mezcla
// ---------------------------------------------------------------------------

const XY_MODES: ReadonlyArray<{ id: XYMode; label: string; hint: string; undo: string }> = [
  { id: 'warmth_air', label: 'CALIDEZ / AIRE', hint: 'X: saturación del master · Y: agudos del master', undo: 'Macro X/Y Calidez y Aire' },
  { id: 'dry_space', label: 'COLA / REVERB', hint: 'X: cola de la reverb · Y: retorno de la reverb', undo: 'Macro X/Y Reverb' },
  { id: 'vox_band', label: 'BANDA / VOZ', hint: 'X: volumen de la banda · Y: volumen de las voces', undo: 'Macro X/Y Voz vs Banda' },
]

interface XyGesture {
  pointerId: number
  base: StudioSession
  x0: number
  y0: number
}

const MacroXYPadWidget: React.FC<{ controller: StudioController | null; onOpenStudio: () => void }> = ({ controller, onOpenStudio }) => {
  const [mode, setMode] = useState<XYMode>('warmth_air')
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 })
  const padRef = useRef<HTMLDivElement>(null)
  // Sesion al poner el dedo: cada movimiento se aplica en relativo a ella, no a la ya movida.
  const gestureRef = useRef<XyGesture | null>(null)
  const modeDef = XY_MODES.find((m) => m.id === mode) ?? XY_MODES[0]

  const pointToPad = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = padRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, 1 - (clientY - rect.top) / Math.max(1, rect.height))),
    }
  }

  const endGesture = (pointerId: number) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== pointerId) return
    gestureRef.current = null
    // Un solo paso de deshacer por gesto (commitLive no apila nada si no hubo cambio).
    controller?.commitLive(modeDef.undo)
  }

  if (!controller) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="widget-xypad">
        <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>
          Abre una sesión en el Estudio DAW para controlar calidez, espacio o balance vocal en tiempo real con el dedo.
        </p>
        <button type="button" onClick={onOpenStudio} style={{ ...primaryButton(), minHeight: TOUCH, justifyContent: 'center' }}>
          <Sliders size={14} /> ABRIR ESTUDIO DAW
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="widget-xypad">
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {XY_MODES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            aria-pressed={mode === id}
            style={{
              ...ghostButton,
              flex: 1,
              minHeight: TOUCH,
              justifyContent: 'center',
              fontSize: '10px',
              background: mode === id ? 'var(--b-accent)' : 'var(--b-elevated)',
              color: mode === id ? 'var(--b-on-accent)' : colors.text,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p style={{ margin: 0, fontFamily: mono, fontSize: '10px', color: colors.muted }}>{modeDef.hint}. Mueve desde donde están hoy.</p>

      <div
        ref={padRef}
        onPointerDown={(e) => {
          if (controller.snapshot().recording) return
          const p = pointToPad(e.clientX, e.clientY)
          if (!p) return
          e.currentTarget.setPointerCapture(e.pointerId)
          gestureRef.current = { pointerId: e.pointerId, base: controller.snapshot().session, x0: p.x, y0: p.y }
          setPos(p)
        }}
        onPointerMove={(e) => {
          const g = gestureRef.current
          if (!g || g.pointerId !== e.pointerId) return
          const p = pointToPad(e.clientX, e.clientY)
          if (!p) return
          setPos(p)
          if (controller.snapshot().recording) return
          controller.applyLive(applyXyMacro(g.base, mode, p.x - g.x0, p.y - g.y0, withFx))
        }}
        onPointerUp={(e) => endGesture(e.pointerId)}
        onPointerCancel={(e) => endGesture(e.pointerId)}
        onLostPointerCapture={(e) => endGesture(e.pointerId)}
        style={{
          position: 'relative',
          height: '180px',
          borderRadius: radius.card,
          background: 'var(--b-well)',
          border: '1px solid var(--b-border-strong)',
          touchAction: 'none',
          cursor: 'crosshair',
          overflow: 'hidden',
        }}
        data-testid="widget-xypad-surface"
      >
        {/* Capa del tamano del pad movida con transform (el % de translate es el de la propia capa). */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            transform: `translate(${pos.x * 100}%, ${(1 - pos.y) * 100}%)`,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: '26px',
              height: '26px',
              borderRadius: '9999px',
              background: 'var(--b-accent)',
              boxShadow: '0 0 0 4px color-mix(in srgb, var(--b-accent) 28%, transparent)',
              transform: 'translate(-50%, -50%)',
            }}
          />
        </div>
        <span style={{ position: 'absolute', left: '8px', bottom: '6px', fontFamily: mono, fontSize: '10px', color: colors.muted }}>
          X: {Math.round(pos.x * 100)}% · Y: {Math.round(pos.y * 100)}%
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. Grabadora rapida de ideas (BPM y tono locales -> sesion del Estudio)
// ---------------------------------------------------------------------------

const QuickIdeaRecorderWidget: React.FC<{
  controller: StudioController | null
  studioRecording: boolean
  onOpenStudio: () => void
  onBusyChange: (busy: boolean) => void
}> = ({ controller, studioRecording, onOpenStudio, onBusyChange }) => {
  const { activeBand, activeSong, sharing, user } = useHub()
  const [recording, setRecording] = useState(false)
  const [starting, setStarting] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const srRef = useRef(48000)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number>(0)
  const genRef = useRef(0)
  const stopAndSaveRef = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => {
    onBusyChange(recording || starting)
  }, [recording, starting, onBusyChange])

  const cleanup = useCallback(() => {
    genRef.current++
    window.clearInterval(timerRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    closeContext(ctxRef.current)
    ctxRef.current = null
    setRecording(false)
    setStarting(false)
  }, [])

  useEffect(
    () => () => {
      cleanup()
      onBusyChange(false)
    },
    [cleanup, onBusyChange]
  )

  const startRec = async () => {
    if (recording || starting) return
    if (studioRecording) {
      setStatus(MIC_BUSY_TEXT)
      return
    }
    setStatus(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Este navegador no da acceso al micrófono.')
      return
    }
    const ctx = contextInGesture()
    if (!ctx) {
      setStatus('Este navegador no tiene Web Audio.')
      return
    }
    const gen = ++genRef.current
    ctxRef.current = ctx
    chunksRef.current = []
    setSeconds(0)
    setStarting(true)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      if (gen === genRef.current) {
        cleanup()
        setStatus('No se pudo abrir el micrófono.')
      } else {
        closeContext(ctx)
      }
      return
    }
    if (gen !== genRef.current || (controller && controller.snapshot().recording)) {
      stream.getTracks().forEach((t) => t.stop())
      if (gen === genRef.current) {
        cleanup()
        setStatus(MIC_BUSY_TEXT)
      } else {
        closeContext(ctx)
      }
      return
    }
    srRef.current = ctx.sampleRate
    const src = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    proc.onaudioprocess = (ev) => {
      chunksRef.current.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
    }
    src.connect(proc)
    proc.connect(ctx.destination)
    streamRef.current = stream
    setStarting(false)
    setRecording(true)
    const startedAt = performance.now()
    timerRef.current = window.setInterval(() => {
      const elapsed = Math.floor((performance.now() - startedAt) / 1000)
      setSeconds(elapsed)
      if (elapsed >= 180) void stopAndSaveRef.current()
    }, 250)
  }

  const stopAndSave = async () => {
    cleanup()
    const chunks = chunksRef.current
    chunksRef.current = []
    const total = chunks.reduce((acc, c) => acc + c.length, 0)
    if (total < srRef.current * 0.3) {
      setStatus('Grabación demasiado corta.')
      return
    }
    setStatus('Analizando BPM y tono y guardando WAV de 24 bits...')
    const monoSamples = new Float32Array(total)
    let offset = 0
    for (const c of chunks) {
      monoSamples.set(c, offset)
      offset += c.length
    }
    const sr = srRef.current
    const bpmEst = detectBpmLocal(monoSamples, sr)
    const keyEst = detectKeyLocal(monoSamples, sr)
    const safeBpm = bpmEst?.bpm ?? 120
    const safeKey = keyEst?.key ?? 'C'
    const wavBuf = encodeWav24([monoSamples], sr)
    const blob = new Blob([wavBuf], { type: 'audio/wav' })
    const label = `Idea ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`

    try {
      if (controller) {
        await controller.addQuickIdeaBlob(blob, label, { bpm: safeBpm, key: safeKey })
        setStatus(`Guardada en la sesión abierta (${safeBpm} BPM · ${safeKey}).`)
        return
      }

      const band = cloudBandKey(activeBand?.id, sharing.activeShared)
      const cloud = sharing.cloudSignedIn && activeBand ? stemCloudTarget(band) : null
      const opened = await createSession({
        title: activeSong ? `${activeSong.title} - ${label}` : label,
        band,
        song: activeSong
          ? { id: activeSong.id, bpm: activeSong.bpm, beatsPerBar: activeSong.beatsPerBar, key: activeSong.key ?? safeKey }
          : { id: '', bpm: safeBpm, beatsPerBar: 4, key: safeKey },
        fullSong: activeSong ?? null,
        updatedBy: user?.id ?? 'local',
        cloud,
        canEditCloud: sharing.activeCanCollaborateStudio,
      })

      let session = opened.session
      if (!activeSong) {
        session = { ...session, songId: null, bpm: safeBpm, key: safeKey }
      }
      const assetId = newStudioId('ast')
      const file = `${assetId}.wav`
      const durationS = monoSamples.length / sr
      const asset = {
        id: assetId,
        file,
        kind: 'recording' as const,
        label,
        channels: 1 as const,
        sampleRate: sr,
        durationS,
        size: blob.size,
        source: null,
      }
      await studioStore.putAsset(session.id, file, blob)
      const trackId = newStudioId('trk')
      session = addAsset(session, { asset })
      session = addTrack(session, { track: defaultTrack({ id: trackId, name: label, role: 'vocals' }) })
      session = addClip(session, {
        trackId,
        clip: {
          id: newStudioId('clp'),
          assetId,
          startS: 0,
          offsetS: 0,
          lengthS: durationS,
          gainDb: 0,
          fadeInS: 0,
          fadeOutS: 0,
          takeGroup: null,
          active: true,
        },
      })
      await studioStore.saveSession(session, { band, etag: opened.etag, dirty: true })
      setStatus(`Sesión «${session.title}» creada (${safeBpm} BPM · ${safeKey}).`)
      onOpenStudio()
    } catch {
      setStatus('No se pudo guardar la grabación rápida.')
    }
  }

  useEffect(() => {
    stopAndSaveRef.current = stopAndSave
  })

  const blocked = !recording && studioRecording

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} data-testid="widget-recorder">
      <div style={{ ...cardStyle, padding: '16px', background: 'var(--b-well)', textAlign: 'center' }}>
        <div style={{ fontFamily: mono, fontSize: '32px', fontWeight: 800, color: recording ? colors.danger : colors.text }}>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </div>
        <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
          {recording
            ? 'Grabando idea (máx. 3:00)... Al detener detecta BPM y tono sin gastar IA.'
            : blocked
              ? MIC_BUSY_TEXT
              : 'Captura un riff, melodía o nota de voz directo hacia el Estudio DAW.'}
        </div>
      </div>

      {status && <div style={{ fontFamily: mono, fontSize: '11px', color: colors.text }}>{status}</div>}

      <button
        type="button"
        onClick={() => (recording ? void stopAndSave() : void startRec())}
        disabled={starting || blocked}
        style={{
          ...primaryButton(recording ? colors.danger : undefined),
          minHeight: '48px',
          justifyContent: 'center',
        }}
        data-testid="widget-recorder-toggle"
      >
        {recording ? <Square size={16} /> : <Circle size={16} />}
        {recording ? 'DETENER Y ENVIAR A ESTUDIO' : starting ? 'ABRIENDO MICRÓFONO...' : 'GRABAR IDEA RÁPIDA'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5. Conmutador A/B de versiones (0 ms)
// ---------------------------------------------------------------------------

const VersionABWidget: React.FC<{ controller: StudioController | null; onOpenStudio: () => void }> = ({ controller, onOpenStudio }) => {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!controller) return
    return controller.subscribe(() => setTick((t) => t + 1))
  }, [controller])

  if (!controller) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="widget-ab">
        <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>
          Abre una sesión en el Estudio DAW para alternar en 0 ms entre tu mezcla actual (A) y cualquier snapshot o rama guardada (B).
        </p>
        <button type="button" onClick={onOpenStudio} style={{ ...primaryButton(), minHeight: TOUCH, justifyContent: 'center' }}>
          <GitBranch size={14} /> ABRIR ESTUDIO DAW
        </button>
      </div>
    )
  }

  const snap = controller.snapshot()
  const commits = snap.vcs.index.commits

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="widget-ab">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={labelStyle}>RAMA: {snap.vcs.activeBranch.toUpperCase()}</span>
        <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>{commits.length} snapshots</span>
      </div>

      <button
        type="button"
        disabled={snap.recording}
        onClick={() => void controller.toggleAbListening()}
        style={{
          ...primaryButton(snap.abState?.active === 'B' ? colors.warning : undefined),
          minHeight: '52px',
          justifyContent: 'center',
          fontSize: '13px',
        }}
        data-testid="widget-ab-toggle"
      >
        <Headphones size={16} />
        {snap.abState?.active === 'B' ? `ESCUCHANDO B (${snap.abState.label.slice(0, 18)})` : 'CONMUTAR A / B (0 MS)'}
      </button>

      <button
        type="button"
        disabled={snap.recording || snap.vcs.saving}
        onClick={() => void controller.commitVcsSnapshot(`Snapshot rápido (${snap.vcs.activeBranch})`)}
        style={{ ...ghostButton, minHeight: TOUCH, justifyContent: 'center' }}
      >
        GUARDAR SNAPSHOT AHORA
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bandeja flotante (MobileWidgetTray)
// ---------------------------------------------------------------------------

const WIDGET_TABS: ReadonlyArray<{ id: MobileWidgetId; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'tuner', label: 'Afinador', icon: Compass },
  { id: 'metronome', label: 'Tempo', icon: Gauge },
  { id: 'xypad', label: 'Macro XY', icon: Move },
  { id: 'recorder', label: 'Idea', icon: Mic },
  { id: 'ab', label: 'A / B', icon: Activity },
]

const DISCARD_TAKE_TEXT = 'Hay una idea grabándose. Si sales ahora se descarta. ¿Descartarla?'

/** Mientras la bandeja esta abierta, vuelve a mirar cada segundo (abrir o cerrar el Estudio no siempre cambia lo que suena). */
const STUDIO_RECHECK_MS = 1000

export const MobileWidgetTray: React.FC<Props> = ({ initialWidget = null, offsetBottomPx = 68, onOpenStudio }) => {
  const { activeBand, sharing } = useHub()
  const audio = useGlobalAudioEngine()
  const mobile = useMediaQuery(MOBILE_QUERY, false)
  const [open, setOpen] = useState<boolean>(() => initialWidget !== null)
  const [activeTab, setActiveTab] = useState<MobileWidgetId>(() => initialWidget ?? 'tuner')
  const recorderBusyRef = useRef(false)
  const onRecorderBusy = useCallback((busy: boolean) => {
    recorderBusyRef.current = busy
  }, [])

  const bandKey = cloudBandKey(activeBand?.id, sharing.activeShared)
  const audioTag = `${activeBand?.id ?? 'none'}:${bandKey}`
  // Sesion del Estudio abierta para esta banda: sigue al audio global (abrir o cerrar la sesion
  // con la bandeja abierta la actualiza), no la foto del momento en que se abrio la bandeja.
  const subscribeStudio = useCallback(
    (cb: () => void) => {
      const off = audio.subscribeNowPlaying(cb)
      const timer = open ? window.setInterval(cb, STUDIO_RECHECK_MS) : 0
      return () => {
        off()
        if (timer) window.clearInterval(timer)
      }
    },
    [audio, open]
  )
  const getStudio = useCallback(() => (open ? audio.adoptStudio(audioTag) : null), [audio, audioTag, open])
  const studioController = useSyncExternalStore(subscribeStudio, getStudio, () => null)
  const studioRecording = useStudioRecording(studioController)

  /** Cerrar o cambiar de widget desmonta la grabadora: con una toma en curso se pregunta antes. */
  const confirmLeaveRecorder = useCallback((): boolean => {
    if (!recorderBusyRef.current) return true
    return window.confirm(DISCARD_TAKE_TEXT)
  }, [])

  const closeTray = useCallback(() => {
    if (confirmLeaveRecorder()) setOpen(false)
  }, [confirmLeaveRecorder])

  const selectTab = (id: MobileWidgetId) => {
    if (id === activeTab) return
    if (activeTab === 'recorder' && !confirmLeaveRecorder()) return
    setActiveTab(id)
  }

  const openStudioFromWidget = () => {
    if (!confirmLeaveRecorder()) return
    setOpen(false)
    onOpenStudio()
  }

  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])
  useEffect(() => {
    const onToggle = () => {
      if (!openRef.current) setOpen(true)
      else if (confirmLeaveRecorder()) setOpen(false)
    }
    window.addEventListener('bandait:toggle-widgets', onToggle)
    return () => window.removeEventListener('bandait:toggle-widgets', onToggle)
  }, [confirmLeaveRecorder])

  return (
    <>
      {/* Disparador flotante: solo en movil (en escritorio la bandeja se abre con ?widget=). */}
      {!open && mobile && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Herramientas de bolsillo"
          title="Abrir herramientas rápidas: afinador, metrónomo, pad X/Y, grabadora de ideas y A/B"
          data-testid="mobile-widget-fab"
          style={{
            position: 'fixed',
            right: '14px',
            bottom: `calc(${offsetBottomPx}px + env(safe-area-inset-bottom, 0px))`,
            zIndex: 40,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            minHeight: TOUCH,
            minWidth: TOUCH,
            padding: '0 12px',
            borderRadius: radius.transport,
            border: '1px solid var(--b-border-strong)',
            background: 'var(--b-elevated)',
            color: colors.text,
            boxShadow: 'var(--b-shadow)',
            fontFamily: mono,
            fontSize: '11px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          <Wrench size={14} style={{ color: 'var(--b-accent)' }} />
          <span>HERRAMIENTAS</span>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Herramientas de bolsillo"
          data-testid="mobile-widget-tray"
          style={{
            position: 'fixed',
            right: '12px',
            bottom: `calc(${offsetBottomPx}px + env(safe-area-inset-bottom, 0px))`,
            zIndex: 920,
            width: 'min(368px, calc(100vw - 24px))',
            maxHeight: 'min(520px, calc(100dvh - 140px))',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '12px',
            borderRadius: radius.card,
            border: '1px solid var(--b-border-strong)',
            background: 'var(--b-modal)',
            boxShadow: 'var(--b-shadow)',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <span style={labelStyle}>KIT RÁPIDO DE ESCENARIO Y BOLSILLO</span>
            <button
              type="button"
              onClick={closeTray}
              aria-label="Cerrar herramientas"
              style={{ ...ghostButton, padding: 0, minHeight: TOUCH, minWidth: TOUCH, justifyContent: 'center' }}
              data-testid="mobile-widget-close"
            >
              <X size={16} />
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '4px' }}>
            {WIDGET_TABS.map((item) => {
              const Icon = item.icon
              const selected = activeTab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectTab(item.id)}
                  aria-pressed={selected}
                  data-testid={`mobile-widget-tab-${item.id}`}
                  style={{
                    ...ghostButton,
                    flexDirection: 'column',
                    gap: '2px',
                    padding: '6px 2px',
                    minHeight: TOUCH,
                    fontSize: '9px',
                    justifyContent: 'center',
                    borderRadius: radius.control,
                    background: selected ? 'var(--b-accent)' : 'var(--b-elevated)',
                    color: selected ? 'var(--b-on-accent)' : colors.text,
                  }}
                >
                  <Icon size={14} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>

          {activeTab === 'tuner' && <TunerWidget studioRecording={studioRecording} />}
          {activeTab === 'metronome' && <PocketMetronomeWidget controller={studioController} />}
          {activeTab === 'xypad' && <MacroXYPadWidget controller={studioController} onOpenStudio={openStudioFromWidget} />}
          {activeTab === 'recorder' && (
            <QuickIdeaRecorderWidget
              controller={studioController}
              studioRecording={studioRecording}
              onOpenStudio={() => {
                setOpen(false)
                onOpenStudio()
              }}
              onBusyChange={onRecorderBusy}
            />
          )}
          {activeTab === 'ab' && <VersionABWidget controller={studioController} onOpenStudio={openStudioFromWidget} />}
        </div>
      )}
    </>
  )
}
