import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { cloudBandKey } from '../../services/stemCloud'
import { stemCloudTarget } from '../../services/stemCloudConfig'
import { detectBpmLocal, detectKeyLocal, detectPitchYin, type PitchDetectionResult } from '../../services/studio/dspMath'
import { defaultFx, defaultTrack, newStudioId, STUDIO_MASTER_ID } from '../../services/studio/session'
import { addAsset, addClip, addTrack, updateMaster } from '../../services/studio/sessionOps'
import * as studioStore from '../../services/studio/studioStore'
import { encodeWav24 } from '../../services/wav'
import { createSession, withFx, type StudioController } from '../studio/studioState'
import { cardStyle, colors, ghostButton, labelStyle, mono, primaryButton, radius } from '../hubStyles'

export type MobileWidgetId = 'tuner' | 'metronome' | 'xypad' | 'recorder' | 'ab'

interface Props {
  initialWidget?: MobileWidgetId | null
  offsetBottomPx?: number
  onOpenStudio: () => void
}

/** Regresion lineal por minimos cuadrados t_k = a + b*k para estimar BPM estable con hasta 8 taps. */
function linearRegressionTapBpm(tapsMs: readonly number[]): number | null {
  if (tapsMs.length < 2) return null
  const n = tapsMs.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += tapsMs[i]
    sumXY += i * tapsMs[i]
    sumXX += i * i
  }
  const denom = n * sumXX - sumX * sumX
  if (denom <= 0) return null
  const slopeMs = (n * sumXY - sumX * sumY) / denom
  if (!(slopeMs > 180 && slopeMs < 2000)) return null
  return Math.max(40, Math.min(260, Math.round((60000 / slopeMs) * 10) / 10))
}

// ---------------------------------------------------------------------------
// 1. Afinador Cromatico Matematico (YIN < 0,5 cents)
// ---------------------------------------------------------------------------

const TunerWidget: React.FC = () => {
  const [listening, setListening] = useState(false)
  const [a4Hz, setA4Hz] = useState(440)
  const [pitch, setPitch] = useState<PitchDetectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => undefined)
      ctxRef.current = null
    }
    setListening(false)
  }, [])

  useEffect(() => () => stop(), [stop])

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 4096
      src.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      streamRef.current = stream
      ctxRef.current = ctx
      setListening(true)

      let lastTick = 0
      const loop = (now: number) => {
        if (now - lastTick >= 65) {
          lastTick = now
          analyser.getFloatTimeDomainData(buf)
          const res = detectPitchYin(buf, ctx.sampleRate, { referenceA4Hz: a4Hz, threshold: 0.14 })
          if (res && res.confidence >= 0.7) {
            setPitch(res)
          }
        }
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    } catch {
      setError('Permite el acceso al micrófono para usar el afinador cromático.')
      stop()
    }
  }

  const inTune = pitch ? Math.abs(pitch.cents) <= 4 : false
  const needlePct = pitch ? Math.max(0, Math.min(100, 50 + pitch.cents)) : 50

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} data-testid="widget-tuner">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={labelStyle}>REFERENCIA LA4: {a4Hz} HZ</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" onClick={() => setA4Hz((v) => Math.max(432, v - 1))} style={{ ...ghostButton, padding: '4px 8px', minHeight: '32px' }}>
            -1 Hz
          </button>
          <button type="button" onClick={() => setA4Hz(440)} style={{ ...ghostButton, padding: '4px 8px', minHeight: '32px' }}>
            440
          </button>
          <button type="button" onClick={() => setA4Hz((v) => Math.min(446, v + 1))} style={{ ...ghostButton, padding: '4px 8px', minHeight: '32px' }}>
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

      <button
        type="button"
        onClick={() => (listening ? stop() : void start())}
        style={{ ...primaryButton(listening ? colors.danger : undefined), minHeight: '44px', justifyContent: 'center' }}
        data-testid="widget-tuner-toggle"
      >
        <Mic size={15} />
        {listening ? 'DETENER MICRÓFONO' : 'ENCENDER AFINADOR YIN'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Tap Tempo + Metronomo Sintetizado de Bolsillo
// ---------------------------------------------------------------------------

const PocketMetronomeWidget: React.FC<{ controller: StudioController | null }> = ({ controller }) => {
  const { activeSong, sharing, saveSong } = useHub()
  const [bpm, setBpm] = useState<number>(() => controller?.snapshot().session.bpm ?? activeSong?.bpm ?? 120)
  const [beatsPerBar, setBeatsPerBar] = useState<number>(() => controller?.snapshot().session.beatsPerBar ?? activeSong?.beatsPerBar ?? 4)
  const [playing, setPlaying] = useState(false)
  const [beatIdx, setBeatIdx] = useState(0)
  const tapsRef = useRef<number[]>([])
  const timerRef = useRef<number>(0)
  const audioCtxRef = useRef<AudioContext | null>(null)

  const stopClick = useCallback(() => {
    window.clearInterval(timerRef.current)
    setPlaying(false)
    setBeatIdx(0)
  }, [])

  useEffect(() => {
    return () => {
      window.clearInterval(timerRef.current)
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => undefined)
      }
    }
  }, [])

  const triggerClick = useCallback((accent: boolean) => {
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!audioCtxRef.current) audioCtxRef.current = new Ctor()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') void ctx.resume()
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(accent ? 1120 : 780, now)
      gain.gain.setValueAtTime(accent ? 0.35 : 0.2, now)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.045)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.05)
    } catch {
      // Sin salida de audio disponible.
    }
  }, [])

  useEffect(() => {
    if (!playing) return
    let step = 0
    triggerClick(true)
    const intervalMs = (60 / bpm) * 1000
    timerRef.current = window.setInterval(() => {
      step = (step + 1) % beatsPerBar
      setBeatIdx(step)
      triggerClick(step === 0)
    }, intervalMs)
    return () => window.clearInterval(timerRef.current)
  }, [playing, bpm, beatsPerBar, triggerClick])

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
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
          {Array.from({ length: beatsPerBar }, (_, idx) => (
            <span
              key={idx}
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '9999px',
                background: playing && beatIdx === idx ? (idx === 0 ? 'var(--b-accent)' : 'var(--b-cobalt)') : 'var(--b-border-strong)',
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
            onClick={() => setBeatsPerBar(b)}
            style={{
              ...ghostButton,
              flex: 1,
              minHeight: '38px',
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
        onChange={(e) => setBpm(Number(e.target.value))}
        aria-label="Tempo BPM"
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <button
          type="button"
          onClick={handleTap}
          style={{ ...ghostButton, minHeight: '48px', justifyContent: 'center', fontWeight: 700 }}
          data-testid="widget-metronome-tap"
        >
          TAP TEMPO
        </button>
        <button
          type="button"
          onClick={() => {
            if (playing) {
              stopClick()
            } else {
              setBeatIdx(0)
              setPlaying(true)
            }
          }}
          style={{ ...primaryButton(), minHeight: '48px', justifyContent: 'center' }}
          data-testid="widget-metronome-play"
        >
          {playing ? <Square size={14} /> : <Play size={14} />}
          {playing ? 'DETENER' : 'SONAR CLIC'}
        </button>
      </div>

      {(controller || (activeSong && sharing.activeCanEdit)) && (
        <button type="button" onClick={applyBpm} style={{ ...ghostButton, minHeight: '40px', justifyContent: 'center' }}>
          <Check size={14} />
          APLICAR A {controller ? 'SESIÓN ESTUDIO' : `«${activeSong?.title.slice(0, 18)}»`}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Pad X/Y Macro de Mezcla y Expresion en Vivo
// ---------------------------------------------------------------------------

type XYMode = 'warmth_air' | 'dry_space' | 'vox_band'

const MacroXYPadWidget: React.FC<{ controller: StudioController | null; onOpenStudio: () => void }> = ({ controller, onOpenStudio }) => {
  const [mode, setMode] = useState<XYMode>('warmth_air')
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 })
  const padRef = useRef<HTMLDivElement>(null)

  const applyMacro = (nx: number, ny: number, commit: boolean) => {
    setPos({ x: nx, y: ny })
    if (!controller) return
    const snap = controller.snapshot()
    if (snap.recording) return

    if (mode === 'dry_space') {
      const returnDb = Math.round((-36 + ny * 32) * 10) / 10
      const decayS = Math.round((0.6 + nx * 3.4) * 100) / 100
      controller.applyLive(updateMaster(snap.session, { patch: { reverb: { returnDb, decayS } } }))
      if (commit) controller.commitLive('Macro X/Y Reverb')
    } else if (mode === 'warmth_air') {
      const baseSat = defaultFx('saturator')
      const baseEq = defaultFx('eq')
      let next = withFx(snap.session, STUDIO_MASTER_ID, {
        ...baseSat,
        params: { ...baseSat.params, driveDb: Math.round(nx * 14 * 10) / 10, mix: 0.65 },
      })
      next = withFx(next, STUDIO_MASTER_ID, {
        ...baseEq,
        params: { ...baseEq.params, highDb: Math.round((ny - 0.3) * 9 * 10) / 10 },
      })
      controller.applyLive(next)
      if (commit) controller.commitLive('Macro X/Y Calidez y Aire')
    } else if (mode === 'vox_band') {
      const voxBoost = (ny - 0.5) * 8
      const bandTrim = (nx - 0.5) * 8
      for (const t of snap.session.tracks) {
        if (t.role === 'vocals') {
          controller.updateTrackLive(t.id, { volumeDb: Math.max(-24, Math.min(6, Math.round(voxBoost * 10) / 10)) })
        } else if (t.role !== 'click' && t.role !== 'guide') {
          controller.updateTrackLive(t.id, { volumeDb: Math.max(-24, Math.min(6, Math.round(bandTrim * 10) / 10)) })
        }
      }
      if (commit) controller.commitLive('Macro X/Y Voz vs Banda')
    }
  }

  const updateFromPointer = (clientX: number, clientY: number, commit: boolean) => {
    const el = padRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)))
    const ny = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / Math.max(1, rect.height)))
    applyMacro(nx, ny, commit)
  }

  if (!controller) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="widget-xypad">
        <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>
          Abre una sesión en el Estudio DAW para controlar calidez analógica, espacio estéreo o balance vocal en tiempo real con el dedo.
        </p>
        <button type="button" onClick={onOpenStudio} style={{ ...primaryButton(), minHeight: '44px', justifyContent: 'center' }}>
          <Sliders size={14} /> ABRIR ESTUDIO DAW
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="widget-xypad">
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {(
          [
            ['warmth_air', 'TAPE / AIR'],
            ['dry_space', 'DECAY / REV'],
            ['vox_band', 'BANDA / VOZ'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            style={{
              ...ghostButton,
              flex: 1,
              minHeight: '36px',
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

      <div
        ref={padRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          updateFromPointer(e.clientX, e.clientY, false)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return
          updateFromPointer(e.clientX, e.clientY, false)
        }}
        onPointerUp={(e) => updateFromPointer(e.clientX, e.clientY, true)}
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
        <div
          style={{
            position: 'absolute',
            left: `${pos.x * 100}%`,
            top: `${(1 - pos.y) * 100}%`,
            width: '26px',
            height: '26px',
            borderRadius: '9999px',
            background: 'var(--b-accent)',
            boxShadow: '0 0 0 4px color-mix(in srgb, var(--b-accent) 28%, transparent)',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
          }}
        />
        <span style={{ position: 'absolute', left: '8px', bottom: '6px', fontFamily: mono, fontSize: '10px', color: colors.muted }}>
          X: {Math.round(pos.x * 100)}% · Y: {Math.round(pos.y * 100)}%
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. Grabadora Rapida de Ideas (1 toque + BPM/Tono local -> Sesion Estudio)
// ---------------------------------------------------------------------------

const QuickIdeaRecorderWidget: React.FC<{ controller: StudioController | null; onOpenStudio: () => void }> = ({
  controller,
  onOpenStudio,
}) => {
  const { activeBand, activeSong, sharing, user } = useHub()
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const srRef = useRef(48000)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number>(0)

  const cleanup = useCallback(() => {
    window.clearInterval(timerRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => undefined)
      ctxRef.current = null
    }
    setRecording(false)
  }, [])

  useEffect(() => () => cleanup(), [cleanup])

  const startRec = async () => {
    setStatus(null)
    chunksRef.current = []
    setSeconds(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      srRef.current = ctx.sampleRate
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      proc.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0)
        chunksRef.current.push(new Float32Array(input))
      }
      src.connect(proc)
      proc.connect(ctx.destination)
      streamRef.current = stream
      ctxRef.current = ctx
      setRecording(true)
      let ticks = 0
      timerRef.current = window.setInterval(() => {
        ticks += 1
        const elapsed = Math.floor(ticks / 4)
        setSeconds(elapsed)
        if (elapsed >= 180) void stopAndSave()
      }, 250)
    } catch {
      setStatus('No se pudo abrir el micrófono.')
      cleanup()
    }
  }

  const stopAndSave = async () => {
    cleanup()
    const chunks = chunksRef.current
    const total = chunks.reduce((acc, c) => acc + c.length, 0)
    if (total < srRef.current * 0.3) {
      setStatus('Grabación demasiado corta.')
      return
    }
    setStatus('Analizando BPM/Tono y guardando WAV 24-bit...')
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
        setStatus(`Guardada en sesión abierta (${safeBpm} BPM · ${safeKey}).`)
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} data-testid="widget-recorder">
      <div style={{ ...cardStyle, padding: '16px', background: 'var(--b-well)', textAlign: 'center' }}>
        <div style={{ fontFamily: mono, fontSize: '32px', fontWeight: 800, color: recording ? colors.danger : colors.text }}>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </div>
        <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
          {recording
            ? 'Grabando idea (máx. 3:00)... Al detener detecta BPM y Tono sin gastar IA.'
            : 'Captura un riff, melodía o nota de voz directo hacia el Estudio DAW.'}
        </div>
      </div>

      {status && <div style={{ fontFamily: mono, fontSize: '11px', color: colors.text }}>{status}</div>}

      <button
        type="button"
        onClick={() => (recording ? void stopAndSave() : void startRec())}
        style={{
          ...primaryButton(recording ? colors.danger : undefined),
          minHeight: '48px',
          justifyContent: 'center',
        }}
        data-testid="widget-recorder-toggle"
      >
        {recording ? <Square size={16} /> : <Circle size={16} />}
        {recording ? 'DETENER Y ENVIAR A ESTUDIO' : 'GRABAR IDEA RÁPIDA'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5. Conmutador A/B de Versiones (0 ms)
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
        <button type="button" onClick={onOpenStudio} style={{ ...primaryButton(), minHeight: '44px', justifyContent: 'center' }}>
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
        style={{ ...ghostButton, minHeight: '40px', justifyContent: 'center' }}
      >
        GUARDAR SNAPSHOT AHORA
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bandeja Flotante Principal (MobileWidgetTray)
// ---------------------------------------------------------------------------

const WIDGET_TABS: ReadonlyArray<{ id: MobileWidgetId; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'tuner', label: 'Afinador', icon: Compass },
  { id: 'metronome', label: 'Tempo', icon: Gauge },
  { id: 'xypad', label: 'Macro XY', icon: Move },
  { id: 'recorder', label: 'Idea', icon: Mic },
  { id: 'ab', label: 'A / B', icon: Activity },
]

export const MobileWidgetTray: React.FC<Props> = ({ initialWidget = null, offsetBottomPx = 68, onOpenStudio }) => {
  const { activeBand, sharing } = useHub()
  const audio = useGlobalAudioEngine()
  const [open, setOpen] = useState< boolean >(() => initialWidget !== null)
  const [activeTab, setActiveTab] = useState<MobileWidgetId>(() => initialWidget ?? 'tuner')

  const bandKey = cloudBandKey(activeBand?.id, sharing.activeShared)
  const audioTag = `${activeBand?.id ?? 'none'}:${bandKey}`
  const studioController = useMemo(() => (open ? audio.adoptStudio(audioTag) : null), [audio, audioTag, open])

  useEffect(() => {
    const onToggle = () => setOpen((v) => !v)
    window.addEventListener('bandait:toggle-widgets', onToggle)
    return () => window.removeEventListener('bandait:toggle-widgets', onToggle)
  }, [])

  return (
    <>
      {/* Disparador compacto flotante de bolsillo */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Herramientas y widgets de bolsillo"
          title="Abrir herramientas rápidas: Afinador YIN, Metrónomo, Pad XY, Grabadora de Ideas y A/B"
          data-testid="mobile-widget-fab"
          style={{
            position: 'fixed',
            right: '14px',
            bottom: `calc(${offsetBottomPx}px + env(safe-area-inset-bottom, 0px))`,
            zIndex: 40,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            minHeight: '38px',
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
          <Wrench size={13} style={{ color: 'var(--b-accent)' }} />
          <span>TOOLS</span>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Widgets musicales de bolsillo"
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
              onClick={() => setOpen(false)}
              aria-label="Cerrar widgets"
              style={{ ...ghostButton, padding: '4px 6px', minHeight: '28px' }}
              data-testid="mobile-widget-close"
            >
              <X size={14} />
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
                  onClick={() => setActiveTab(item.id)}
                  data-testid={`mobile-widget-tab-${item.id}`}
                  style={{
                    ...ghostButton,
                    flexDirection: 'column',
                    gap: '2px',
                    padding: '6px 2px',
                    minHeight: '44px',
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

          {activeTab === 'tuner' && <TunerWidget />}
          {activeTab === 'metronome' && <PocketMetronomeWidget controller={studioController} />}
          {activeTab === 'xypad' && <MacroXYPadWidget controller={studioController} onOpenStudio={() => { setOpen(false); onOpenStudio() }} />}
          {activeTab === 'recorder' && <QuickIdeaRecorderWidget controller={studioController} onOpenStudio={() => { setOpen(false); onOpenStudio() }} />}
          {activeTab === 'ab' && <VersionABWidget controller={studioController} onOpenStudio={() => { setOpen(false); onOpenStudio() }} />}
        </div>
      )}
    </>
  )
}
