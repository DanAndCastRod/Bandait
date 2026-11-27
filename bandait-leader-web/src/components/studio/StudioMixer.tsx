import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Activity, ChevronDown, ChevronUp, Download, Power, RotateCcw, Sliders, Sparkles, Wand2 } from 'lucide-react'
import { STEM_ROLE_CODES, stemRoleLabel } from '../../services/stemNames'
import {
  defaultFx,
  STUDIO_MASTER_ID,
  STUDIO_REVERB_DECAY_S_MAX,
  STUDIO_REVERB_DECAY_S_MIN,
  STUDIO_REVERB_RETURN_DB_MAX,
  STUDIO_REVERB_RETURN_DB_MIN,
  STUDIO_REVERB_SEND_DB_MAX,
  STUDIO_REVERB_SEND_DB_MIN,
  type StudioFx,
  type StudioFxType,
  type StudioSession,
  type StudioTrack,
} from '../../services/studio/session'
import { dbToFader, FADER_MARKS, faderToDb } from '../../services/studio/faderScale'
import { updateMaster } from '../../services/studio/sessionOps'
import { StudioEqCurve } from './StudioInspector'
import { studioTrackColor } from '../../services/studioCanvasPalette'
import { ledColors, newMeterState, paintLedMeter, type MeterState } from './ledMeter'
import { errorText, formatDb, formatPan, trackColor, useStudio, withFx, type StudioController, type StudioFxSelection, type StudioPanelProps } from './studioState'
import { useStudioCanvasPalette } from './useStudioCanvasPalette'

interface Props extends StudioPanelProps {
  /** Abre el inspector en el efecto recien elegido (la vista muestra la pestana INSPECTOR). */
  onEditFx: () => void
  /** Abre el dialogo de exportar. */
  onExport: () => void
  /** Consola desplegada (la vista guarda el estado). */
  open: boolean
  onToggle: () => void
  /** Atajo vigente de view.toggle_mixer, para el titulo del boton. */
  toggleShortcut: string
}

// ---------------------------------------------------------------------------
// Escala del fader (services/studio/faderScale.ts: de +12 a -60 dB, 0 dB a tres cuartos)
// ---------------------------------------------------------------------------

const FADER_STEPS = 1000
const FADER_STEP = 5

const faderValue = (db: number) => Math.round((dbToFader(db) * FADER_STEPS) / FADER_STEP) * FADER_STEP

// ---------------------------------------------------------------------------
// Medidores LED (un solo requestAnimationFrame para todo el mezclador)
// ---------------------------------------------------------------------------

// paintLedMeter y ledColors viven en ledMeter.ts: las cabeceras de pista usan los mismos LED.
const paintMeter = paintLedMeter

function loudnessText(value: number): string {
  return Number.isFinite(value) && value > -70 ? value.toFixed(1) : '--.-'
}

type RegisterMeter = (id: string, canvas: HTMLCanvasElement | null) => void

// ---------------------------------------------------------------------------
// Piezas de un canal
// ---------------------------------------------------------------------------

/** Cambio en caliente con una operacion que puede lanzar: el error se muestra, no se propaga. */
function live(controller: StudioController, operation: (session: StudioSession) => StudioSession): void {
  try {
    controller.applyLive(operation(controller.snapshot().session))
  } catch (err) {
    controller.notify('error', errorText(err))
  }
}

const FX_SHORT: Readonly<Record<StudioFxType, string>> = {
  eq: 'EQ',
  compressor: 'COMP',
  de_esser: 'DS',
  saturator: 'SAT',
  stereo_imager: 'IMG',
  limiter: 'LIM',
}
const FX_NAMES: Readonly<Record<StudioFxType, string>> = {
  eq: 'EQ',
  compressor: 'compresor',
  de_esser: 'de-esser',
  saturator: 'saturador',
  stereo_imager: 'imagen estéreo',
  limiter: 'limitador',
}

interface InsertProps {
  controller: StudioController
  targetId: string
  targetName: string
  type: StudioFxType
  chain: readonly StudioFx[]
  selected: boolean
  onEditFx: () => void
}

/** Ranura de insert: el nombre abre (o crea) el efecto en el inspector; el boton lateral es el bypass. */
const InsertSlot: React.FC<InsertProps> = ({ controller, targetId, targetName, type, chain, selected, onEditFx }) => {
  const fx = chain.find((item) => item.type === type) ?? null
  const state = !fx ? 'empty' : fx.bypass ? 'bypass' : 'on'
  const open = () => {
    if (!fx && !controller.run(`Agregar ${FX_NAMES[type]}`, (session) => withFx(session, targetId, defaultFx(type)))) return
    controller.selectFx({ targetId, type })
    onEditFx()
  }
  return (
    <div className="stu-insert" data-state={state} data-selected={selected}>
      <button
        type="button"
        className="stu-insert-name"
        onClick={open}
        aria-label={fx ? `Editar ${FX_NAMES[type]} de ${targetName}${fx.bypass ? ' (en bypass)' : ''}` : `Agregar ${FX_NAMES[type]} a ${targetName}`}
        title={fx ? 'Editar en el inspector' : `Agregar ${FX_NAMES[type]}`}
        data-testid={`studio-insert-${targetId}-${type}`}
      >
        {fx ? FX_SHORT[type] : `+ ${FX_SHORT[type]}`}
      </button>
      {fx && (
        <button
          type="button"
          className="stu-insert-power"
          aria-pressed={!fx.bypass}
          aria-label={`${fx.bypass ? 'Activar' : 'Poner en bypass'} ${FX_NAMES[type]} de ${targetName}`}
          title={fx.bypass ? 'En bypass: activar' : 'Activo: poner en bypass'}
          onClick={() => controller.run(fx.bypass ? `Activar ${FX_NAMES[type]}` : `Bypass de ${FX_NAMES[type]}`, (session) => withFx(session, targetId, { ...fx, bypass: !fx.bypass } as StudioFx))}
        >
          <Power size={11} />
        </button>
      )}
    </div>
  )
}

interface FaderProps {
  label: string
  valueDb: number
  meterId: string
  registerMeter: RegisterMeter
  onLive: (db: number) => void
  onCommit: () => void
  onReset: () => void
}

/** Fader vertical con su escala en dB y el medidor al lado, los tres sobre la misma escala. */
const FaderColumn: React.FC<FaderProps> = ({ label, valueDb, meterId, registerMeter, onLive, onCommit, onReset }) => (
  <div className="stu-strip-fader">
    <div className="stu-scale" aria-hidden="true">
      {FADER_MARKS.map((db) => (
        <span key={db} data-zero={db === 0} style={{ bottom: `${dbToFader(db) * 100}%` }}>
          {db > 0 ? `+${db}` : db}
        </span>
      ))}
    </div>
    <input
      type="range"
      className="stu-fader"
      min={0}
      max={FADER_STEPS}
      step={FADER_STEP}
      value={faderValue(valueDb)}
      onChange={(event) => onLive(faderToDb(Number(event.target.value) / FADER_STEPS))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      onBlur={onCommit}
      onDoubleClick={onReset}
      aria-label={label}
      aria-valuetext={`${formatDb(valueDb)} dB`}
      title="Doble clic: 0 dB"
    />
    <canvas className="stu-strip-meter" aria-hidden="true" ref={(canvas) => registerMeter(meterId, canvas)} />
  </div>
)

interface MiniProps {
  label: string
  short: string
  value: number
  min: number
  max: number
  step: number
  text: string
  resetTo: number
  onLive: (value: number) => void
  onCommit: () => void
}

/** Control horizontal pequeno de un canal (paneo, envio a reverb). */
const MiniSlider: React.FC<MiniProps> = ({ label, short, value, min, max, step, text, resetTo, onLive, onCommit }) => (
  <label className="stu-mini" title={`${label}. Doble clic: valor por defecto`}>
    <span className="stu-mini-head">
      <span>{short}</span>
      <span>{text}</span>
    </span>
    <input
      type="range"
      className="stu-range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onLive(Number(event.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      onBlur={onCommit}
      onDoubleClick={() => {
        onLive(resetTo)
        onCommit()
      }}
      aria-label={label}
      aria-valuetext={text}
    />
  </label>
)

function sendText(db: number): string {
  return db <= STUDIO_REVERB_SEND_DB_MIN ? 'no' : formatDb(db)
}

// ---------------------------------------------------------------------------
// Canal de pista
// ---------------------------------------------------------------------------

interface StripProps {
  controller: StudioController
  track: StudioTrack
  index: number
  sampleRate: number
  selectedFx: StudioFxSelection | null
  /** Algun clip de la pista usa audio generado por IA. */
  generated: boolean
  registerMeter: RegisterMeter
  onEditFx: () => void
}

const TrackStrip: React.FC<StripProps> = React.memo(({ controller, track, index, sampleRate, selectedFx, generated, registerMeter, onEditFx }) => {
  const eq = track.fx.find((item) => item.type === 'eq')
  const picked = selectedFx?.targetId === track.id ? selectedFx.type : null
  const palette = useStudioCanvasPalette()
  return (
    <div className="stu-strip" role="group" aria-label={`Canal ${index + 1}: ${track.name}`} style={{ ['--stu-track' as string]: studioTrackColor(palette, trackColor(index, track.role)) }} data-testid={`studio-strip-${track.id}`}>
      <div className="stu-strip-head">
        <span className="stu-strip-name" title={track.name}>
          {track.name}
        </span>
        <span className="stu-strip-tags">
          <span className="stu-strip-role" title={`Rol: ${stemRoleLabel(track.role)}`}>
            {STEM_ROLE_CODES[track.role]}
          </span>
          {generated && (
            <span className="stu-badge" data-tone="warn" title="Esta pista tiene audio generado por IA" data-testid={`studio-strip-ai-${track.id}`}>
              <Sparkles size={10} aria-hidden="true" />
              IA
            </span>
          )}
        </span>
      </div>

      <div className="stu-strip-inserts">
        <InsertSlot controller={controller} targetId={track.id} targetName={track.name} type="eq" chain={track.fx} selected={picked === 'eq'} onEditFx={onEditFx} />
        {eq && eq.type === 'eq' ? <StudioEqCurve params={eq.params} sampleRate={sampleRate} bypass={eq.bypass} className="stu-eq-mini" /> : <span className="stu-eq-mini" data-empty="true" aria-hidden="true" />}
        <InsertSlot controller={controller} targetId={track.id} targetName={track.name} type="compressor" chain={track.fx} selected={picked === 'compressor'} onEditFx={onEditFx} />
        <InsertSlot controller={controller} targetId={track.id} targetName={track.name} type="de_esser" chain={track.fx} selected={picked === 'de_esser'} onEditFx={onEditFx} />
        <InsertSlot controller={controller} targetId={track.id} targetName={track.name} type="saturator" chain={track.fx} selected={picked === 'saturator'} onEditFx={onEditFx} />
        <InsertSlot controller={controller} targetId={track.id} targetName={track.name} type="stereo_imager" chain={track.fx} selected={picked === 'stereo_imager'} onEditFx={onEditFx} />
      </div>

      <MiniSlider
        label="Envío a reverb"
        short="REV"
        value={track.reverbSendDb}
        min={STUDIO_REVERB_SEND_DB_MIN}
        max={STUDIO_REVERB_SEND_DB_MAX}
        step={1}
        text={sendText(track.reverbSendDb)}
        resetTo={STUDIO_REVERB_SEND_DB_MIN}
        onLive={(reverbSendDb) => controller.updateTrackLive(track.id, { reverbSendDb })}
        onCommit={() => controller.commitLive('Envío a reverb')}
      />
      <MiniSlider
        label="Paneo"
        short="PAN"
        value={track.pan}
        min={-1}
        max={1}
        step={0.02}
        text={formatPan(track.pan)}
        resetTo={0}
        onLive={(pan) => controller.updateTrackLive(track.id, { pan })}
        onCommit={() => controller.commitLive('Paneo de pista')}
      />

      <FaderColumn
        label={`Volumen de ${track.name} en dB`}
        valueDb={track.volumeDb}
        meterId={track.id}
        registerMeter={registerMeter}
        onLive={(volumeDb) => controller.updateTrackLive(track.id, { volumeDb })}
        onCommit={() => controller.commitLive('Volumen de pista')}
        onReset={() => controller.updateTrack(track.id, { volumeDb: 0 }, 'Volumen de pista')}
      />
      <span className="stu-strip-db">{formatDb(track.volumeDb)}</span>

      <div className="stu-strip-keys">
        <button
          type="button"
          className="stu-btn"
          data-size="mini"
          data-on={track.mute}
          data-accent="warn"
          aria-pressed={track.mute}
          onClick={() => controller.updateTrack(track.id, { mute: !track.mute }, track.mute ? 'Quitar mute' : 'Mute')}
          aria-label={`Mute de ${track.name}`}
          title="Mute"
        >
          M
        </button>
        <button
          type="button"
          className="stu-btn"
          data-size="mini"
          data-on={track.solo}
          data-accent="play"
          aria-pressed={track.solo}
          onClick={() => controller.updateTrack(track.id, { solo: !track.solo }, track.solo ? 'Quitar solo' : 'Solo')}
          aria-label={`Solo de ${track.name}`}
          title="Solo"
        >
          S
        </button>
      </div>
    </div>
  )
})
TrackStrip.displayName = 'TrackStrip'

// ---------------------------------------------------------------------------
// Master
// ---------------------------------------------------------------------------

interface MasterProps {
  controller: StudioController
  session: StudioSession
  selectedFx: StudioFxSelection | null
  registerMeter: RegisterMeter
  registerReadout: (key: 'integrated' | 'momentary' | 'peak', element: HTMLElement | null) => void
  onEditFx: () => void
}

const MasterStrip: React.FC<MasterProps> = ({ controller, session, selectedFx, registerMeter, registerReadout, onEditFx }) => {
  const master = session.master
  const eq = master.fx.find((item) => item.type === 'eq')
  const picked = selectedFx?.targetId === STUDIO_MASTER_ID ? selectedFx.type : null
  const hasLimiter = master.fx.some((item) => item.type === 'limiter' && !item.bypass)
  const setReverb = (patch: Partial<StudioSession['master']['reverb']>) => live(controller, (current) => updateMaster(current, { patch: { reverb: { ...current.master.reverb, ...patch } } }))

  return (
    <div className="stu-strip" data-master="true" role="group" aria-label="Canal master" data-testid="studio-strip-master">
      <div className="stu-strip-head">
        <span className="stu-strip-name">MASTER</span>
        <span className="stu-strip-tags">
          {!hasLimiter && (
            <span className="stu-badge" data-tone="warn" title="Sin limitador activo, la mezcla puede pasar de 0 dB">
              SIN LIM
            </span>
          )}
        </span>
      </div>

      <div className="stu-master-cols">
        <div className="stu-master-col">
          <div className="stu-strip-inserts">
            <InsertSlot controller={controller} targetId={STUDIO_MASTER_ID} targetName="Master" type="eq" chain={master.fx} selected={picked === 'eq'} onEditFx={onEditFx} />
            {eq && eq.type === 'eq' ? <StudioEqCurve params={eq.params} sampleRate={session.sampleRate} bypass={eq.bypass} className="stu-eq-mini" /> : <span className="stu-eq-mini" data-empty="true" aria-hidden="true" />}
            <InsertSlot controller={controller} targetId={STUDIO_MASTER_ID} targetName="Master" type="compressor" chain={master.fx} selected={picked === 'compressor'} onEditFx={onEditFx} />
            <InsertSlot controller={controller} targetId={STUDIO_MASTER_ID} targetName="Master" type="de_esser" chain={master.fx} selected={picked === 'de_esser'} onEditFx={onEditFx} />
            <InsertSlot controller={controller} targetId={STUDIO_MASTER_ID} targetName="Master" type="saturator" chain={master.fx} selected={picked === 'saturator'} onEditFx={onEditFx} />
            <InsertSlot controller={controller} targetId={STUDIO_MASTER_ID} targetName="Master" type="stereo_imager" chain={master.fx} selected={picked === 'stereo_imager'} onEditFx={onEditFx} />
            <InsertSlot controller={controller} targetId={STUDIO_MASTER_ID} targetName="Master" type="limiter" chain={master.fx} selected={picked === 'limiter'} onEditFx={onEditFx} />
          </div>
          <MiniSlider
            label="Reverb compartida: decaimiento"
            short="REV S"
            value={master.reverb.decayS}
            min={STUDIO_REVERB_DECAY_S_MIN}
            max={STUDIO_REVERB_DECAY_S_MAX}
            step={0.1}
            text={`${master.reverb.decayS.toFixed(1)} s`}
            resetTo={1.8}
            onLive={(decayS) => setReverb({ decayS })}
            onCommit={() => controller.commitLive('Decaimiento de la reverb')}
          />
          <MiniSlider
            label="Reverb compartida: retorno"
            short="RET"
            value={master.reverb.returnDb}
            min={STUDIO_REVERB_RETURN_DB_MIN}
            max={STUDIO_REVERB_RETURN_DB_MAX}
            step={0.5}
            text={sendText(master.reverb.returnDb)}
            resetTo={0}
            onLive={(returnDb) => setReverb({ returnDb })}
            onCommit={() => controller.commitLive('Retorno de la reverb')}
          />
          <dl className="stu-loud" aria-label="Sonoridad del master">
            <dt title="LUFS integrado desde el último arranque o reinicio. Es una estimación: la medida exacta es la del archivo exportado.">LUFS INT</dt>
            <dd ref={(element) => registerReadout('integrated', element)} data-testid="studio-lufs-integrated">
              --.-
            </dd>
            <dt title="LUFS momentáneo (400 ms)">LUFS MOM</dt>
            <dd ref={(element) => registerReadout('momentary', element)}>--.-</dd>
            <dt title="Pico real máximo desde el último reinicio, en dBTP">PICO REAL</dt>
            <dd ref={(element) => registerReadout('peak', element)} data-testid="studio-true-peak">
              --.-
            </dd>
          </dl>
          <button type="button" className="stu-btn" data-size="small" onClick={() => controller.engine.resetMasterLoudness()} title="Reinicia el LUFS integrado y el pico real">
            <RotateCcw size={11} />
            REINICIAR
          </button>
        </div>

        <div className="stu-master-col" data-fader="true">
          <FaderColumn
            label="Volumen del master en dB"
            valueDb={master.volumeDb}
            meterId={STUDIO_MASTER_ID}
            registerMeter={registerMeter}
            onLive={(volumeDb) => live(controller, (current) => updateMaster(current, { patch: { volumeDb } }))}
            onCommit={() => controller.commitLive('Volumen del master')}
            onReset={() => controller.run('Volumen del master', (current) => updateMaster(current, { patch: { volumeDb: 0 } }))}
          />
          <span className="stu-strip-db">{formatDb(master.volumeDb)}</span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mezclador
// ---------------------------------------------------------------------------

export const StudioMixer: React.FC<Props> = ({ controller, onEditFx, onExport, open, onToggle, toggleShortcut }) => {
  const snap = useStudio(controller)
  const { session } = snap
  const collapsed = !open
  const palette = useStudioCanvasPalette()
  const meters = useRef(new Map<string, HTMLCanvasElement>())
  const readouts = useRef(new Map<string, HTMLElement>())

  const registerMeter = useCallback<RegisterMeter>((id, canvas) => {
    if (canvas) meters.current.set(id, canvas)
    else meters.current.delete(id)
  }, [])
  const registerReadout = useCallback((key: 'integrated' | 'momentary' | 'peak', element: HTMLElement | null) => {
    if (element) readouts.current.set(key, element)
    else readouts.current.delete(key)
  }, [])

  // Un cambio de tema reinicia el bucle: estados nuevos, asi que cada medidor se repinta entero.
  useEffect(() => {
    const leds = ledColors(palette)
    const states = new Map<string, MeterState>()
    const texts = new Map<string, string>()
    const write = (key: string, text: string, alert: boolean) => {
      const element = readouts.current.get(key)
      const signature = `${text}|${alert}`
      if (!element || texts.get(key) === signature) return
      texts.set(key, signature)
      element.textContent = text
      element.dataset.alert = alert ? 'true' : 'false'
    }
    return controller.onFrame(() => {
      if (meters.current.size === 0) return
      const now = performance.now()
      for (const [id, canvas] of meters.current) {
        let state = states.get(id)
        if (!state) {
          state = newMeterState()
          states.set(id, state)
        }
        if (id === STUDIO_MASTER_ID) {
          const reading = controller.engine.readMasterMeter()
          paintMeter(canvas, state, reading.peakDb, reading.rmsDb, now, leds)
          write('integrated', loudnessText(reading.integratedLufs), false)
          write('momentary', loudnessText(reading.momentaryLufs), false)
          write('peak', loudnessText(reading.truePeakDb), reading.truePeakDb > -1)
        } else {
          const reading = controller.engine.readTrackMeter(id)
          paintMeter(canvas, state, reading.peakDb, reading.rmsDb, now, leds)
        }
      }
    })
  }, [controller, palette])

  const generatedTracks = useMemo(() => {
    const generated = new Set(session.assets.filter((asset) => asset.kind === 'generated').map((asset) => asset.id))
    const ids = new Set<string>()
    if (generated.size === 0) return ids
    for (const track of session.tracks) if (track.clips.some((clip) => generated.has(clip.assetId))) ids.add(track.id)
    return ids
  }, [session.assets, session.tracks])

  return (
    <section className="stu-mixer" aria-label="Consola de mezcla" data-testid="studio-mixer" data-collapsed={collapsed}>
      <header className="stu-mixer-bar">
        <button
          type="button"
          className="stu-btn"
          data-tone="ghost"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls="studio-mixer-body"
          title={`${collapsed ? 'Mostrar' : 'Ocultar'} la consola (${toggleShortcut})`}
          data-testid="studio-mixer-toggle"
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          CONSOLA
        </button>
        <span className="stu-label">
          {session.tracks.length} {session.tracks.length === 1 ? 'pista' : 'pistas'}
        </span>
        <span className="stu-bar-spacer" />
        <button
          type="button"
          className="stu-btn"
          data-size="small"
          disabled={snap.recording || !snap.ready || session.tracks.length < 2}
          onClick={() => controller.unmaskMixBark(0.75)}
          title="Desenmascarar colisiones espectrales entre pistas (24 bandas Bark, 0 cuota IA)"
          data-testid="studio-unmask-btn"
        >
          <Sliders size={12} />
          DESENMASCARAR
        </button>
        <button
          type="button"
          className="stu-btn"
          data-size="small"
          disabled={snap.recording || !snap.ready || snap.dspBusy !== null}
          onClick={() => void controller.applyAutoMaster('streaming', 'balanced')}
          title="Auto-Master DSP local medido sobre el render (-14 LUFS Streaming, pico real bajo -1 dBTP, 0 cuota IA)"
          data-testid="studio-automaster-btn"
        >
          <Wand2 size={12} />
          AUTO-MASTER
        </button>
        <button
          type="button"
          className="stu-btn"
          data-size="small"
          data-on={snap.labMode}
          aria-pressed={snap.labMode}
          onClick={() => {
            controller.toggleLabMode()
            if (!snap.labMode) onEditFx()
          }}
          title="Mostrar u ocultar analizador científico LAB (FFT, cascada espectral, Lissajous M/S, matriz Bark)"
          data-testid="studio-lab-toggle"
        >
          <Activity size={12} />
          LAB
        </button>
        <button type="button" className="stu-btn" onClick={onExport} disabled={snap.recording || !snap.ready} title="Exportar la mezcla o las pistas a WAV" data-testid="studio-export-open">
          <Download size={13} />
          EXPORTAR
        </button>
      </header>
      {!collapsed && (
        <div className="stu-mixer-body" id="studio-mixer-body">
          <div className="stu-strips">
            {session.tracks.length === 0 ? (
              <p className="stu-help stu-strips-empty">Sin pistas todavía. Importa audio o agrega una pista en la línea de tiempo.</p>
            ) : (
              session.tracks.map((track, index) => (
                <TrackStrip
                  key={track.id}
                  controller={controller}
                  track={track}
                  index={index}
                  sampleRate={session.sampleRate}
                  selectedFx={snap.selectedFx?.targetId === track.id ? snap.selectedFx : null}
                  generated={generatedTracks.has(track.id)}
                  registerMeter={registerMeter}
                  onEditFx={onEditFx}
                />
              ))
            )}
          </div>
          <MasterStrip controller={controller} session={session} selectedFx={snap.selectedFx} registerMeter={registerMeter} registerReadout={registerReadout} onEditFx={onEditFx} />
        </div>
      )}
    </section>
  )
}
