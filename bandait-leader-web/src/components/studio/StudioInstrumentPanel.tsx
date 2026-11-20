import React, { useRef, useState } from 'react'
import { Play, Plus, RotateCcw, Snowflake, Trash2, Upload } from 'lucide-react'
import { instrumentAvailability } from '../../services/studio/instruments/index'
import { listPlugins } from '../../services/studio/instruments/wamHost'
import {
  defaultInstrument,
  drumsPresetParams,
  STUDIO_CLIP_GAIN_DB_MAX,
  STUDIO_CLIP_GAIN_DB_MIN,
  STUDIO_DRUM_VOICE_LABELS,
  STUDIO_DRUM_VOICE_NOTES,
  STUDIO_DRUM_VOICES,
  STUDIO_DRUMS_PARAM_SPECS,
  STUDIO_DRUMS_PRESETS,
  STUDIO_INSTRUMENT_TYPE_LABELS,
  STUDIO_SAMPLER_PARAM_SPECS,
  STUDIO_SYNTH_PARAM_SPECS,
  STUDIO_SYNTH_PRESETS,
  synthPresetParams,
  type DrumVoice,
  type StudioDrumsInstrument,
  type StudioInstrument,
  type StudioInstrumentParamSpec,
  type StudioNumberParamSpec,
  type StudioSamplerInstrument,
  type StudioSamplerZone,
  type StudioSession,
  type StudioSynthInstrument,
  type StudioTrack,
} from '../../services/studio/session'
import { errorText, formatDb, pitchName, useStudio, type StudioController } from './studioState'

interface Props {
  controller: StudioController
  /** Pista de instrumento que se edita. */
  trackId: string
}

// ---------------------------------------------------------------------------
// Control deslizante (mismo comportamiento que el del inspector)
// ---------------------------------------------------------------------------

type Curve = 'linear' | 'log' | 'pow'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  curve?: Curve
  format: (value: number) => string
  resetTo?: number
  disabled?: boolean
  compact?: boolean
  onLive: (value: number) => void
  onCommit: () => void
  testId?: string
}

const STEPS = 1000

/**
 * Deslizante con recorrido lineal, logaritmico (frecuencias, min > 0) o cubico (tiempos desde 0:
 * mas resolucion en los valores cortos). Cambia en caliente y cierra el paso de deshacer al soltar.
 */
const InstrumentSlider: React.FC<SliderProps> = ({ label, value, min, max, step, curve = 'linear', format, resetTo, disabled, compact, onLive, onCommit, testId }) => {
  const toPosition = (v: number) => {
    if (curve === 'log') return Math.round((Math.log(Math.max(v, min) / min) / Math.log(max / min)) * STEPS)
    if (curve === 'pow') return Math.round(Math.cbrt((Math.max(v, min) - min) / (max - min)) * STEPS)
    return v
  }
  const fromPosition = (p: number) => {
    const raw = curve === 'log' ? min * Math.pow(max / min, p / STEPS) : curve === 'pow' ? min + (max - min) * Math.pow(p / STEPS, 3) : p
    return Math.min(max, Math.max(min, Math.round(raw / step) * step))
  }
  const mapped = curve !== 'linear'
  const input = (
    <input
      type="range"
      className="stu-range"
      min={mapped ? 0 : min}
      max={mapped ? STEPS : max}
      step={mapped ? 1 : step}
      value={toPosition(value)}
      disabled={disabled}
      onChange={(event) => onLive(fromPosition(Number(event.target.value)))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      onBlur={onCommit}
      onDoubleClick={() => {
        if (resetTo === undefined || disabled) return
        onLive(resetTo)
        onCommit()
      }}
      aria-label={label}
      aria-valuetext={format(value)}
      title={resetTo === undefined ? label : `${label}. Doble clic: ${format(resetTo)}`}
      data-testid={testId}
    />
  )
  if (compact) {
    return (
      <span className="stu-drum-cell">
        {input}
        <span className="stu-param-val">{format(value)}</span>
      </span>
    )
  }
  return (
    <label className="stu-param">
      <span className="stu-param-head">
        <span className="stu-label">{label}</span>
        <span className="stu-param-val">{format(value)}</span>
      </span>
      {input}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Textos de los parametros
// ---------------------------------------------------------------------------

const signedDb = (value: number) => `${formatDb(value)} dB`
const hertz = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : value < 10 ? `${value.toFixed(2)} Hz` : `${Math.round(value)} Hz`)
const millis = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`)
const percent = (value: number) => `${Math.round(value * 100)}%`
const cents = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)} ct`
const semis = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(value % 1 === 0 ? 0 : 1)} st`

interface ParamUi {
  label: string
  step: number
  curve?: Curve
  format: (value: number) => string
}

const SYNTH_UI: Readonly<Record<string, ParamUi>> = {
  osc1Octave: { label: 'Octava', step: 1, format: (v) => (v > 0 ? `+${v}` : String(v)) },
  osc1DetuneCents: { label: 'Afinación fina', step: 1, format: cents },
  osc1Level: { label: 'Nivel', step: 0.01, format: percent },
  osc2Octave: { label: 'Octava', step: 1, format: (v) => (v > 0 ? `+${v}` : String(v)) },
  osc2DetuneCents: { label: 'Afinación fina', step: 1, format: cents },
  osc2Level: { label: 'Nivel', step: 0.01, format: percent },
  noiseLevel: { label: 'Ruido', step: 0.01, format: percent },
  filterCutoffHz: { label: 'Corte', step: 1, curve: 'log', format: hertz },
  filterResonance: { label: 'Resonancia (Q)', step: 0.1, curve: 'log', format: (v) => v.toFixed(1) },
  filterEnvOctaves: { label: 'Envolvente (octavas)', step: 0.1, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} oct` },
  filterAttackMs: { label: 'Ataque', step: 1, curve: 'pow', format: millis },
  filterDecayMs: { label: 'Caída', step: 1, curve: 'pow', format: millis },
  filterSustain: { label: 'Sostén', step: 0.01, format: percent },
  filterReleaseMs: { label: 'Relajación', step: 1, curve: 'pow', format: millis },
  ampAttackMs: { label: 'Ataque', step: 1, curve: 'pow', format: millis },
  ampDecayMs: { label: 'Caída', step: 1, curve: 'pow', format: millis },
  ampSustain: { label: 'Sostén', step: 0.01, format: percent },
  ampReleaseMs: { label: 'Relajación', step: 1, curve: 'pow', format: millis },
  lfoRateHz: { label: 'Velocidad del LFO', step: 0.01, curve: 'log', format: hertz },
  lfoDepth: { label: 'Profundidad', step: 0.01, format: percent },
  velocitySens: { label: 'Sensibilidad a la velocidad', step: 0.01, format: percent },
  gainDb: { label: 'Ganancia de salida', step: 0.5, format: signedDb },
}

const SAMPLER_UI: Readonly<Record<string, ParamUi>> = {
  ampAttackMs: { label: 'Ataque', step: 1, curve: 'pow', format: millis },
  ampDecayMs: { label: 'Caída', step: 1, curve: 'pow', format: millis },
  ampSustain: { label: 'Sostén', step: 0.01, format: percent },
  ampReleaseMs: { label: 'Relajación', step: 1, curve: 'pow', format: millis },
  velocitySens: { label: 'Sensibilidad a la velocidad', step: 0.01, format: percent },
  gainDb: { label: 'Ganancia de salida', step: 0.5, format: signedDb },
}

const ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  wave: { sine: 'Senoidal', triangle: 'Triangular', sawtooth: 'Sierra', square: 'Cuadrada' },
  filterType: { lowpass: 'Pasa bajos', highpass: 'Pasa altos', bandpass: 'Pasa banda' },
  lfoTarget: { off: 'Apagado', pitch: 'Afinación', filter: 'Filtro', amp: 'Volumen' },
  mode: { sustain: 'Sostenido (mientras dura la nota)', one_shot: 'Un disparo (suena completo)' },
}

const ENUM_TITLES: Readonly<Record<string, string>> = {
  osc1Wave: 'Forma de onda',
  osc2Wave: 'Forma de onda',
  filterType: 'Tipo de filtro',
  lfoWave: 'Forma del LFO',
  lfoTarget: 'Destino del LFO',
  mode: 'Modo',
}

function enumLabels(key: string): Readonly<Record<string, string>> {
  if (key.endsWith('Wave')) return ENUM_LABELS.wave
  return ENUM_LABELS[key] ?? {}
}

const SYNTH_GROUPS: readonly { title: string; keys: readonly string[] }[] = [
  { title: 'Oscilador 1', keys: ['osc1Wave', 'osc1Octave', 'osc1DetuneCents', 'osc1Level'] },
  { title: 'Oscilador 2', keys: ['osc2Wave', 'osc2Octave', 'osc2DetuneCents', 'osc2Level', 'noiseLevel'] },
  { title: 'Filtro', keys: ['filterType', 'filterCutoffHz', 'filterResonance', 'filterEnvOctaves', 'filterAttackMs', 'filterDecayMs', 'filterSustain', 'filterReleaseMs'] },
  { title: 'Volumen (ADSR)', keys: ['ampAttackMs', 'ampDecayMs', 'ampSustain', 'ampReleaseMs', 'velocitySens'] },
  { title: 'LFO', keys: ['lfoWave', 'lfoTarget', 'lfoRateHz', 'lfoDepth'] },
  { title: 'Salida', keys: ['gainDb'] },
]

function specOf(specs: readonly StudioInstrumentParamSpec[], key: string): StudioInstrumentParamSpec | null {
  return specs.find((spec) => spec.key === key) ?? null
}

// ---------------------------------------------------------------------------
// Secciones por tipo
// ---------------------------------------------------------------------------

interface EditorProps<I extends StudioInstrument> {
  controller: StudioController
  track: StudioTrack
  instrument: I
  disabled: boolean
}

/** Parametros genericos (synth y sampler): enum como lista, numero como deslizante. */
function ParamControl({
  spec,
  ui,
  value,
  disabled,
  onLive,
  onCommit,
  onPick,
  testPrefix,
}: {
  spec: StudioInstrumentParamSpec
  ui: ParamUi | undefined
  value: number | string
  disabled: boolean
  onLive: (value: number) => void
  onCommit: (label: string) => void
  onPick: (value: string, label: string) => void
  testPrefix: string
}) {
  if (spec.kind === 'enum') {
    const labels = enumLabels(spec.key)
    const title = ENUM_TITLES[spec.key] ?? spec.key
    return (
      <label className="stu-param">
        <span className="stu-label">{title}</span>
        <select className="stu-field" value={String(value)} disabled={disabled} onChange={(event) => onPick(event.target.value, title)} data-testid={`${testPrefix}-${spec.key}`}>
          {spec.values.map((option) => (
            <option key={option} value={option}>
              {labels[option] ?? option}
            </option>
          ))}
        </select>
      </label>
    )
  }
  const label = ui?.label ?? spec.key
  return (
    <InstrumentSlider
      label={label}
      value={typeof value === 'number' ? value : spec.def}
      min={spec.min}
      max={spec.max}
      step={spec.integer ? 1 : (ui?.step ?? 0.01)}
      curve={ui?.curve}
      format={ui?.format ?? ((v) => String(v))}
      resetTo={spec.def}
      disabled={disabled}
      onLive={onLive}
      onCommit={() => onCommit(label)}
      testId={`${testPrefix}-${spec.key}`}
    />
  )
}

const SynthEditor: React.FC<EditorProps<StudioSynthInstrument>> = ({ controller, track, instrument, disabled }) => {
  const params = instrument.params as unknown as Record<string, number | string>
  const live = (key: string, value: number | string) => {
    const current = controller.snapshot().session.tracks.find((t) => t.id === track.id)?.instrument
    if (current?.type !== 'synth') return
    controller.setTrackInstrumentLive(track.id, { ...current, preset: null, params: { ...current.params, [key]: value } })
  }
  return (
    <>
      {SYNTH_GROUPS.map((group) => (
        <fieldset key={group.title} className="stu-inst-group">
          <legend className="stu-label">{group.title}</legend>
          {group.keys.map((key) => {
            const spec = specOf(STUDIO_SYNTH_PARAM_SPECS, key)
            if (!spec) return null
            return (
              <ParamControl
                key={key}
                spec={spec}
                ui={SYNTH_UI[key]}
                value={params[key]}
                disabled={disabled}
                onLive={(value) => live(key, value)}
                onCommit={(label) => controller.commitLive(`${label} (sintetizador)`)}
                onPick={(value, label) => controller.setTrackInstrument(track.id, { ...instrument, preset: null, params: { ...instrument.params, [key]: value } as StudioSynthInstrument['params'] }, `${label} (sintetizador)`)}
                testPrefix="studio-synth"
              />
            )
          })}
        </fieldset>
      ))}
    </>
  )
}

const DrumsEditor: React.FC<EditorProps<StudioDrumsInstrument>> = ({ controller, track, instrument, disabled }) => {
  const params = instrument.params as unknown as Record<string, number>
  const live = (key: string, value: number) => {
    const current = controller.snapshot().session.tracks.find((t) => t.id === track.id)?.instrument
    if (current?.type !== 'drums') return
    controller.setTrackInstrumentLive(track.id, { ...current, preset: null, params: { ...current.params, [key]: value } })
  }
  const numberSpec = (key: string) => specOf(STUDIO_DRUMS_PARAM_SPECS, key) as StudioNumberParamSpec | null
  const camel = (voice: DrumVoice) => voice.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
  const gain = numberSpec('gainDb')
  return (
    <fieldset className="stu-inst-group">
      <legend className="stu-label">Voces</legend>
      <div className="stu-drum-grid" role="table" aria-label="Voces de la caja de ritmos">
        <div className="stu-drum-row stu-drum-headrow" role="row">
          <span role="columnheader" className="stu-label">Voz</span>
          <span role="columnheader" className="stu-label">Nivel</span>
          <span role="columnheader" className="stu-label">Afinación</span>
          <span role="columnheader" className="stu-label">Caída</span>
        </div>
        {STUDIO_DRUM_VOICES.map((voice) => {
          const base = camel(voice)
          const level = numberSpec(`${base}LevelDb`)
          const tune = numberSpec(`${base}Tune`)
          const decay = numberSpec(`${base}Decay`)
          const name = STUDIO_DRUM_VOICE_LABELS[voice]
          return (
            <div key={voice} className="stu-drum-row" role="row">
              <button
                type="button"
                className="stu-drum-name"
                role="rowheader"
                onClick={() => controller.previewPitch(STUDIO_DRUM_VOICE_NOTES[voice], 110)}
                title={`Escuchar ${name} (nota ${STUDIO_DRUM_VOICE_NOTES[voice]})`}
                aria-label={`Escuchar ${name}`}
              >
                {name}
              </button>
              {level && (
                <InstrumentSlider compact label={`${name}: nivel`} value={params[level.key]} min={level.min} max={level.max} step={0.5} format={(v) => (v <= -60 ? '-inf' : formatDb(v))} resetTo={level.def} disabled={disabled} onLive={(v) => live(level.key, v)} onCommit={() => controller.commitLive(`Nivel de ${name}`)} />
              )}
              {tune && <InstrumentSlider compact label={`${name}: afinación`} value={params[tune.key]} min={tune.min} max={tune.max} step={0.5} format={semis} resetTo={tune.def} disabled={disabled} onLive={(v) => live(tune.key, v)} onCommit={() => controller.commitLive(`Afinación de ${name}`)} />}
              {decay && <InstrumentSlider compact label={`${name}: caída`} value={params[decay.key]} min={decay.min} max={decay.max} step={0.05} curve="log" format={(v) => `x${v.toFixed(2)}`} resetTo={decay.def} disabled={disabled} onLive={(v) => live(decay.key, v)} onCommit={() => controller.commitLive(`Caída de ${name}`)} />}
            </div>
          )
        })}
      </div>
      {gain && (
        <InstrumentSlider label="Ganancia de salida" value={params.gainDb} min={gain.min} max={gain.max} step={0.5} format={signedDb} resetTo={gain.def} disabled={disabled} onLive={(v) => live('gainDb', v)} onCommit={() => controller.commitLive('Ganancia de la caja de ritmos')} testId="studio-drums-gainDb" />
      )}
    </fieldset>
  )
}

const ZONE_NUMBER_FIELDS: readonly { key: keyof StudioSamplerZone; label: string; min: number; max: number; step: number }[] = [
  { key: 'rootPitch', label: 'Nota raíz', min: 0, max: 127, step: 1 },
  { key: 'lowPitch', label: 'Nota más baja', min: 0, max: 127, step: 1 },
  { key: 'highPitch', label: 'Nota más alta', min: 0, max: 127, step: 1 },
  { key: 'lowVelocity', label: 'Velocidad mínima', min: 1, max: 127, step: 1 },
  { key: 'highVelocity', label: 'Velocidad máxima', min: 1, max: 127, step: 1 },
  { key: 'gainDb', label: 'Ganancia (dB)', min: STUDIO_CLIP_GAIN_DB_MIN, max: STUDIO_CLIP_GAIN_DB_MAX, step: 0.5 },
  { key: 'tuneCents', label: 'Afinación (ct)', min: -100, max: 100, step: 1 },
]

const SamplerEditor: React.FC<EditorProps<StudioSamplerInstrument> & { session: StudioSession }> = ({ controller, track, instrument, disabled, session }) => {
  const fileRef = useRef<HTMLInputElement>(null)
  const [assetPick, setAssetPick] = useState('')
  const [rootPick, setRootPick] = useState(60)
  const params = instrument.params as unknown as Record<string, number | string>
  const live = (key: string, value: number) => {
    const current = controller.snapshot().session.tracks.find((t) => t.id === track.id)?.instrument
    if (current?.type !== 'sampler') return
    controller.setTrackInstrumentLive(track.id, { ...current, params: { ...current.params, [key]: value } })
  }
  const setZone = (index: number, patch: Partial<StudioSamplerZone>, label: string) => {
    const zones = instrument.zones.map((zone, i) => (i === index ? { ...zone, ...patch } : zone))
    controller.setTrackInstrument(track.id, { ...instrument, zones }, label)
  }
  const removeZone = (index: number) => controller.setTrackInstrument(track.id, { ...instrument, zones: instrument.zones.filter((_zone, i) => i !== index) }, 'Quitar zona del sampler')
  const audioAssets = session.assets.filter((asset) => asset.durationS > 0)

  return (
    <>
      <fieldset className="stu-inst-group">
        <legend className="stu-label">Volumen y modo</legend>
        {STUDIO_SAMPLER_PARAM_SPECS.map((spec) => (
          <ParamControl
            key={spec.key}
            spec={spec}
            ui={SAMPLER_UI[spec.key]}
            value={params[spec.key]}
            disabled={disabled}
            onLive={(value) => live(spec.key, value)}
            onCommit={(label) => controller.commitLive(`${label} (sampler)`)}
            onPick={(value, label) => controller.setTrackInstrument(track.id, { ...instrument, params: { ...instrument.params, [spec.key]: value } as StudioSamplerInstrument['params'] }, `${label} (sampler)`)}
            testPrefix="studio-sampler"
          />
        ))}
      </fieldset>

      <fieldset className="stu-inst-group">
        <legend className="stu-label">Zonas ({instrument.zones.length})</legend>
        {instrument.zones.length === 0 && <p className="stu-help">Sin zonas el sampler no suena. Agrega un audio: se afina desde su nota raíz y cubre todo el teclado.</p>}
        <ul className="stu-zones" data-testid="studio-sampler-zones">
          {instrument.zones.map((zone, index) => {
            const asset = session.assets.find((item) => item.id === zone.assetId)
            return (
              <li key={`${zone.assetId}-${index}`} className="stu-zone">
                <div className="stu-param-head">
                  <strong className="stu-zone-name">{asset?.label || 'Audio'}</strong>
                  <span className="stu-label">
                    {pitchName(zone.lowPitch)}–{pitchName(zone.highPitch)} · raíz {pitchName(zone.rootPitch)}
                  </span>
                  <button type="button" className="stu-btn" data-size="mini" data-tone="ghost" disabled={disabled} onClick={() => removeZone(index)} aria-label={`Quitar la zona ${asset?.label || index + 1}`} title="Quitar la zona">
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="stu-zone-fields">
                  {ZONE_NUMBER_FIELDS.map((field) => (
                    <label key={field.key} className="stu-zone-field">
                      <span className="stu-label">{field.label}</span>
                      <input
                        key={`${field.key}-${String(zone[field.key])}`}
                        type="number"
                        className="stu-field"
                        data-size="mini"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        defaultValue={String(zone[field.key])}
                        disabled={disabled}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                        onBlur={(event) => {
                          const raw = Number(event.target.value.replace(',', '.'))
                          if (!Number.isFinite(raw)) {
                            event.target.value = String(zone[field.key])
                            return
                          }
                          const value = Math.min(field.max, Math.max(field.min, field.step === 1 ? Math.round(raw) : raw))
                          if (value === zone[field.key]) {
                            event.target.value = String(value)
                            return
                          }
                          setZone(index, { [field.key]: value }, `${field.label} de la zona`)
                        }}
                      />
                    </label>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="stu-zone-add">
          <select className="stu-field" value={assetPick} disabled={disabled || audioAssets.length === 0} onChange={(event) => setAssetPick(event.target.value)} aria-label="Audio de la sesión para la zona nueva" data-testid="studio-sampler-asset">
            <option value="">{audioAssets.length === 0 ? 'La sesión no tiene audios' : 'Audio de la sesión...'}</option>
            {audioAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.label || asset.file}
              </option>
            ))}
          </select>
          <label className="stu-zone-field" style={{ flex: '0 0 76px' }}>
            <span className="stu-label">Raíz</span>
            <select className="stu-field" data-size="mini" value={rootPick} disabled={disabled} onChange={(event) => setRootPick(Number(event.target.value))} aria-label="Nota raíz de la zona nueva">
              {Array.from({ length: 128 }, (_v, pitch) => (
                <option key={pitch} value={pitch}>
                  {pitchName(pitch)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="stu-btn"
            disabled={disabled || !assetPick}
            onClick={() => {
              void controller.addSamplerZone(track.id, { assetId: assetPick }, rootPick)
              setAssetPick('')
            }}
            data-testid="studio-sampler-add"
          >
            <Plus size={13} />
            ZONA
          </button>
          <button type="button" className="stu-btn" disabled={disabled} onClick={() => fileRef.current?.click()} title="Agregar una zona desde un archivo de audio" data-testid="studio-sampler-file">
            <Upload size={13} />
            ARCHIVO
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.wav,.flac,.mp3,.m4a,.ogg,.aac"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void controller.addSamplerZone(track.id, { file }, rootPick)
            }}
          />
        </div>
      </fieldset>
    </>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Instrumento de una pista: tipo, preset, parametros, zonas del sampler y congelado. Los
 * deslizantes cambian el motor en caliente y dejan un solo paso de deshacer al soltar; tocar un
 * parametro deja el preset como "personalizado" (el sonido lo definen los parametros).
 */
export const StudioInstrumentPanel: React.FC<Props> = ({ controller, trackId }) => {
  const snap = useStudio(controller)
  const { session, recording } = snap
  const track = session.tracks.find((t) => t.id === trackId) ?? null
  if (!track || track.kind !== 'instrument' || !track.instrument) return null
  const instrument = track.instrument
  const availability = instrumentAvailability(instrument)
  const frozen = track.frozenAssetId ? session.assets.find((asset) => asset.id === track.frozenAssetId) : null
  const freezing = snap.freezing === track.id
  const disabled = recording
  const plugin = instrument.type === 'wam' ? listPlugins().find((p) => p.id === instrument.pluginId) : null
  const noteCount = track.midiClips.reduce((total, clip) => total + clip.notes.length, 0)

  const changeType = (type: string) => {
    if (type === instrument.type || (type !== 'synth' && type !== 'drums' && type !== 'sampler')) return
    try {
      controller.setTrackInstrument(track.id, defaultInstrument(type), `Cambiar a ${STUDIO_INSTRUMENT_TYPE_LABELS[type].toLowerCase()}`)
    } catch (err) {
      controller.notify('error', errorText(err))
    }
  }

  const changePreset = (id: string) => {
    if (instrument.type === 'synth') {
      const preset = STUDIO_SYNTH_PRESETS.find((p) => p.id === id)
      if (preset) controller.setTrackInstrument(track.id, { type: 'synth', preset: preset.id, params: synthPresetParams(preset.id) }, `Preset ${preset.label}`)
    } else if (instrument.type === 'drums') {
      const preset = STUDIO_DRUMS_PRESETS.find((p) => p.id === id)
      if (preset) controller.setTrackInstrument(track.id, { type: 'drums', preset: preset.id, params: drumsPresetParams(preset.id) }, `Preset ${preset.label}`)
    }
  }

  const presets = instrument.type === 'synth' ? STUDIO_SYNTH_PRESETS : instrument.type === 'drums' ? STUDIO_DRUMS_PRESETS : null
  const currentPreset = instrument.type === 'synth' || instrument.type === 'drums' ? instrument.preset : null
  const testPitch = instrument.type === 'drums' ? 38 : 60

  return (
    <section className="stu-section" aria-label={`Instrumento de ${track.name}`} data-testid="studio-instrument-panel">
      <div className="stu-param-head">
        <span className="stu-label">Instrumento</span>
        <span className="stu-badge" data-tone={availability.available ? 'ok' : 'warn'}>
          {availability.available ? 'DISPONIBLE' : 'NO DISPONIBLE'}
        </span>
      </div>
      <strong className="stu-inspector-title">{track.name}</strong>
      {!availability.available && (
        <p className="stu-help" role="status">
          {availability.reason ?? 'El instrumento no está disponible en este equipo.'} {frozen ? 'Suena su audio congelado.' : 'Sin audio congelado, esta pista no suena aquí.'}
        </p>
      )}

      <div className="stu-inst-pick">
        <label className="stu-param">
          <span className="stu-label">Tipo</span>
          <select className="stu-field" value={instrument.type} disabled={disabled} onChange={(event) => changeType(event.target.value)} data-testid="studio-instrument-type">
            <option value="synth">{STUDIO_INSTRUMENT_TYPE_LABELS.synth}</option>
            <option value="drums">{STUDIO_INSTRUMENT_TYPE_LABELS.drums}</option>
            <option value="sampler">{STUDIO_INSTRUMENT_TYPE_LABELS.sampler}</option>
            {instrument.type === 'wam' && <option value="wam">{STUDIO_INSTRUMENT_TYPE_LABELS.wam}</option>}
          </select>
        </label>
        {presets && (
          <label className="stu-param">
            <span className="stu-label">Preset</span>
            <select className="stu-field" value={currentPreset ?? ''} disabled={disabled} onChange={(event) => changePreset(event.target.value)} data-testid="studio-instrument-preset">
              {currentPreset === null && <option value="">Personalizado</option>}
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="stu-actions">
        <button type="button" className="stu-btn" disabled={!availability.available} onClick={() => controller.previewPitch(testPitch, 100)} title="Tocar una nota de prueba" data-testid="studio-instrument-test">
          <Play size={13} />
          PROBAR
        </button>
        {currentPreset && (
          <button type="button" className="stu-btn" data-tone="ghost" disabled={disabled} onClick={() => changePreset(currentPreset)} title="Volver a los valores del preset">
            <RotateCcw size={13} />
            RESTABLECER
          </button>
        )}
      </div>

      {instrument.type === 'synth' && <SynthEditor controller={controller} track={track} instrument={instrument} disabled={disabled} />}
      {instrument.type === 'drums' && <DrumsEditor controller={controller} track={track} instrument={instrument} disabled={disabled} />}
      {instrument.type === 'sampler' && <SamplerEditor controller={controller} track={track} instrument={instrument} disabled={disabled} session={session} />}
      {instrument.type === 'wam' && (
        <fieldset className="stu-inst-group">
          <legend className="stu-label">Plugin web</legend>
          <dl className="stu-kv">
            <dt>Plugin</dt>
            <dd>{plugin ? plugin.name : instrument.pluginId}</dd>
            {plugin && (
              <>
                <dt>Autor</dt>
                <dd>{plugin.vendor}</dd>
                <dt>Versión</dt>
                <dd>{plugin.version}</dd>
                <dt>Licencia</dt>
                <dd>{plugin.license}</dd>
              </>
            )}
          </dl>
          <p className="stu-help">El estado del plugin se guarda con la sesión; sus controles propios todavía no se muestran aquí.</p>
        </fieldset>
      )}

      <fieldset className="stu-inst-group" data-testid="studio-freeze">
        <legend className="stu-label">Congelar</legend>
        <p className="stu-help">
          Congelar guarda el sonido del instrumento como audio de la sesión (sin efectos ni fader). Ese audio suena en un equipo donde el instrumento no esté disponible.
        </p>
        {frozen && (
          <p className="stu-ok-note">
            <Snowflake size={13} aria-hidden="true" />
            <span>
              Congelado: {frozen.label || frozen.file} ({frozen.durationS.toFixed(1)} s). Si cambias las notas, vuelve a congelar.
            </span>
          </p>
        )}
        <div className="stu-actions">
          <button
            type="button"
            className="stu-btn"
            disabled={disabled || freezing || snap.freezing !== null || !availability.available || noteCount === 0}
            onClick={() => void controller.freezeTrack(track.id)}
            title={noteCount === 0 ? 'La pista no tiene notas' : 'Renderiza el instrumento a audio'}
            data-testid="studio-freeze-button"
          >
            <Snowflake size={13} />
            {freezing ? 'CONGELANDO...' : frozen ? 'VOLVER A CONGELAR' : 'CONGELAR'}
          </button>
          {frozen && (
            <button type="button" className="stu-btn" data-tone="ghost" disabled={disabled || freezing} onClick={() => controller.unfreezeTrack(track.id)} data-testid="studio-unfreeze">
              QUITAR CONGELADO
            </button>
          )}
        </div>
      </fieldset>
    </section>
  )
}
