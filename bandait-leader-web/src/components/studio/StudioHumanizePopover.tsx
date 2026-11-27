import React, { useState } from 'react'
import { Activity, Music, Sliders, X } from 'lucide-react'
import { describeGroove, type GrooveGrid } from '../../services/studio/groove'
import { STUDIO_HUMANIZE_MAX_LAID_BACK_MS, STUDIO_HUMANIZE_MAX_STRUM_MS, STUDIO_HUMANIZE_PRESETS, resolveHumanize } from '../../services/studio/midiOps'
import type { ChordProgressionPreset, ChordVoicingStyle } from '../../services/studio/productionTools'
import type { HumanizeOptions, HumanizePresetId } from '../../services/studio/types'
import { useStudio, type StudioController } from './studioState'

interface Props {
  controller: StudioController
  onClose: () => void
}

/**
 * Valores que Daniel Castaneda movio a mano. Lo que no esta aqui sigue al preset escalado por la
 * intensidad (midiOps.resolveHumanize), asi mover "Intensidad" mueve tambien swing, strum y acento.
 */
interface Overrides {
  swing?: number
  swingGrid?: '1/8' | '1/16'
  strumMs?: number
  accentStrength?: number
}

/** Swing (0..0.5) <-> porcentaje del par (50 % recto, 66 % tresillo, 75 % puntillo). */
const swingToPct = (swing: number) => 50 + swing * 50
const pctToSwing = (pct: number) => Math.max(0, Math.min(0.5, (pct - 50) / 50))

export const StudioHumanizePopover: React.FC<Props> = ({ controller, onClose }) => {
  const snap = useStudio(controller)
  const [preset, setPreset] = useState<HumanizePresetId>(snap.piano.humanizePreset ?? 'pocket')
  const [amount, setAmount] = useState<number>(snap.piano.humanizeAmount || 0.5)
  const [overrides, setOverrides] = useState<Overrides>({})
  const [laidBackMs, setLaidBackMs] = useState<number>(0)

  const [grooveClipId, setGrooveClipId] = useState<string>('')
  const [grooveGrid, setGrooveGrid] = useState<GrooveGrid>('1/16')
  const [grooveStrength, setGrooveStrength] = useState<number>(0.8)
  const [grooveVelocity, setGrooveVelocity] = useState<number>(0.5)

  const [progPreset, setProgPreset] = useState<ChordProgressionPreset>('pop_1564')
  const [voicing, setVoicing] = useState<ChordVoicingStyle>('sevenths')
  const [bars, setBars] = useState<number>(4)

  const pianoLoc = controller.pianoClip()
  const drumKit = pianoLoc?.track.instrument?.type === 'drums'
  const bpm = snap.session.bpm

  const options: HumanizeOptions = { preset, amount, ...overrides, ...(drumKit ? { laidBackMs } : {}) }
  // Lo que se va a aplicar, con el tempo de la sesion (ms) y la bateria detectada.
  const effective = resolveHumanize({ ...options, bpm, drumKit })

  // Barato (recorre las pistas de audio): se recalcula en cada render, que llega con cada cambio de sesion.
  const grooveSources = controller.grooveSourceClips()
  const groove = snap.piano.groove
  const pickedGrooveClip = grooveClipId || grooveSources[0]?.clipId || ''

  const selectPreset = (id: HumanizePresetId) => {
    setPreset(id)
    setOverrides({})
    controller.setHumanizePreset(id)
  }

  const applyHumanize = () => {
    controller.setPiano({ humanizeAmount: amount })
    controller.setHumanizePreset(preset)
    controller.humanizeNotes(options)
    onClose()
  }

  const applyProgression = () => {
    const clipId = controller.insertChordProgressionClip({
      preset: progPreset,
      voicing,
      bars,
      trackId: snap.selectedTrackId ?? undefined,
    })
    if (clipId) {
      controller.openPianoRoll(clipId)
    }
    onClose()
  }

  const strumLabel =
    Math.abs(effective.strumMs) < 0.5 ? 'Recto' : `${effective.strumMs > 0 ? 'Abajo ' : 'Arriba '}${Math.round(Math.abs(effective.strumMs))} ms`

  return (
    <div className="stu-popover stu-humanize-popover" role="dialog" aria-label="Humanización analógica y generador MIDI" data-testid="studio-humanize-popover">
      <div className="stu-param-head">
        <strong className="stu-label">Humanización Analógica (Tiempo + Dinámica)</strong>
        <button type="button" className="stu-btn" data-size="mini" data-tone="ghost" onClick={onClose} aria-label="Cerrar">
          <X size={13} />
        </button>
      </div>

      <div className="stu-seg" role="group" aria-label="Preset de humanización">
        {STUDIO_HUMANIZE_PRESETS.map((spec) => (
          <button
            key={spec.id}
            type="button"
            className="stu-btn"
            data-size="small"
            data-on={preset === spec.id}
            aria-pressed={preset === spec.id}
            onClick={() => selectPreset(spec.id)}
            title={spec.description}
            data-testid={`studio-humanize-preset-${spec.id}`}
          >
            {spec.label}
          </button>
        ))}
      </div>

      {drumKit ? (
        <p className="stu-help" data-testid="studio-humanize-drumkit">
          Batería: humanización por pieza (bombo y caja ajustados, hi-hat con más dinámica y acento en corcheas).
        </p>
      ) : null}

      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Intensidad global (escala todo el preset)</span>
          <span className="stu-param-val">
            {Math.round(amount * 100)}% · ±{Math.round(effective.timingMs)} ms
          </span>
        </span>
        <input
          type="range"
          className="stu-range"
          min={5}
          max={100}
          step={5}
          value={Math.round(amount * 100)}
          onChange={(e) => setAmount(Number(e.target.value) / 100)}
          data-testid="studio-humanize-amount"
        />
      </label>

      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Groove / Swing</span>
          <span className="stu-param-val" data-testid="studio-humanize-swing-val">
            {Math.round(swingToPct(effective.swing))}% ({effective.swingGrid})
          </span>
        </span>
        <input
          type="range"
          className="stu-range"
          min={50}
          max={75}
          step={1}
          value={Math.round(swingToPct(effective.swing))}
          onChange={(e) => setOverrides((o) => ({ ...o, swing: pctToSwing(Number(e.target.value)) }))}
          aria-valuetext={`${Math.round(swingToPct(effective.swing))} % (66 % = tresillo, 75 % = puntillo)`}
          data-testid="studio-humanize-swing"
        />
      </label>
      <div className="stu-seg" role="group" aria-label="Rejilla del swing">
        {(['1/8', '1/16'] as const).map((g) => (
          <button
            key={g}
            type="button"
            className="stu-btn"
            data-size="mini"
            data-on={effective.swingGrid === g}
            aria-pressed={effective.swingGrid === g}
            onClick={() => setOverrides((o) => ({ ...o, swingGrid: g }))}
            data-testid={`studio-humanize-swing-grid-${g === '1/8' ? '8' : '16'}`}
          >
            SWING {g}
          </button>
        ))}
      </div>

      {drumKit ? (
        <label className="stu-param">
          <span className="stu-param-head">
            <span className="stu-label">Caja atrás (laid back)</span>
            <span className="stu-param-val">{laidBackMs === 0 ? 'En el tiempo' : `+${laidBackMs} ms`}</span>
          </span>
          <input
            type="range"
            className="stu-range"
            min={0}
            max={STUDIO_HUMANIZE_MAX_LAID_BACK_MS}
            step={1}
            value={laidBackMs}
            onChange={(e) => setLaidBackMs(Number(e.target.value))}
            data-testid="studio-humanize-laidback"
          />
        </label>
      ) : (
        <label className="stu-param">
          <span className="stu-param-head">
            <span className="stu-label">Rasgueo de acordes (Strum)</span>
            <span className="stu-param-val">{strumLabel}</span>
          </span>
          <input
            type="range"
            className="stu-range"
            min={-STUDIO_HUMANIZE_MAX_STRUM_MS}
            max={STUDIO_HUMANIZE_MAX_STRUM_MS}
            step={1}
            value={Math.round(effective.strumMs)}
            onChange={(e) => setOverrides((o) => ({ ...o, strumMs: Number(e.target.value) }))}
            data-testid="studio-humanize-strum"
          />
        </label>
      )}

      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Acento métrico del compás</span>
          <span className="stu-param-val">{Math.round(effective.accentStrength * 100)}%</span>
        </span>
        <input
          type="range"
          className="stu-range"
          min={0}
          max={100}
          step={5}
          value={Math.round(effective.accentStrength * 100)}
          onChange={(e) => setOverrides((o) => ({ ...o, accentStrength: Number(e.target.value) / 100 }))}
        />
      </label>

      <div className="stu-actions">
        <button type="button" className="stu-btn" data-tone="primary" disabled={snap.recording} onClick={applyHumanize} data-testid="studio-humanize-apply">
          <Sliders size={13} />
          APLICAR HUMANIZACIÓN
        </button>
      </div>

      <hr className="stu-divider" />

      <strong className="stu-label">Groove de la banda (desde un clip de audio)</strong>
      {grooveSources.length === 0 ? (
        <p className="stu-help">Graba o importa la batería (u otra pista con golpes claros) para tomar su groove.</p>
      ) : (
        <>
          <div className="stu-inst-pick">
            <select
              className="stu-field"
              value={pickedGrooveClip}
              onChange={(e) => setGrooveClipId(e.target.value)}
              aria-label="Clip de audio del que se toma el groove"
              data-testid="studio-groove-source"
            >
              {grooveSources.map((s) => (
                <option key={s.clipId} value={s.clipId}>
                  {s.label}
                </option>
              ))}
            </select>
            <select className="stu-field" value={grooveGrid} onChange={(e) => setGrooveGrid(e.target.value as GrooveGrid)} aria-label="Rejilla del groove">
              <option value="1/16">Semicorcheas (1/16)</option>
              <option value="1/8">Corcheas (1/8)</option>
            </select>
          </div>
          <div className="stu-actions">
            <button
              type="button"
              className="stu-btn"
              disabled={snap.recording || !pickedGrooveClip}
              onClick={() => controller.captureGrooveFromClip(pickedGrooveClip, grooveGrid)}
              data-testid="studio-groove-capture"
            >
              <Activity size={13} />
              TOMAR GROOVE
            </button>
          </div>
        </>
      )}
      {groove ? (
        <>
          <p className="stu-help" data-testid="studio-groove-summary">
            {describeGroove(groove)}
          </p>
          <label className="stu-param">
            <span className="stu-param-head">
              <span className="stu-label">Ajuste al groove (tiempo)</span>
              <span className="stu-param-val">{Math.round(grooveStrength * 100)}%</span>
            </span>
            <input
              type="range"
              className="stu-range"
              min={0}
              max={100}
              step={5}
              value={Math.round(grooveStrength * 100)}
              onChange={(e) => setGrooveStrength(Number(e.target.value) / 100)}
            />
          </label>
          <label className="stu-param">
            <span className="stu-param-head">
              <span className="stu-label">Dinámica del groove (velocidad)</span>
              <span className="stu-param-val">{Math.round(grooveVelocity * 100)}%</span>
            </span>
            <input
              type="range"
              className="stu-range"
              min={0}
              max={100}
              step={5}
              value={Math.round(grooveVelocity * 100)}
              onChange={(e) => setGrooveVelocity(Number(e.target.value) / 100)}
            />
          </label>
          <div className="stu-actions">
            <button
              type="button"
              className="stu-btn"
              data-tone="primary"
              disabled={snap.recording}
              onClick={() => controller.applyGroove({ strength: grooveStrength, velocityStrength: grooveVelocity })}
              data-testid="studio-groove-apply"
            >
              <Sliders size={13} />
              APLICAR GROOVE
            </button>
            <button type="button" className="stu-btn" data-tone="ghost" onClick={() => controller.clearGroove()}>
              OLVIDAR
            </button>
          </div>
        </>
      ) : null}

      <hr className="stu-divider" />

      <strong className="stu-label">Generador Armónico de Acordes MIDI ({snap.session.key || 'Do'})</strong>
      <div className="stu-inst-pick">
        <select className="stu-field" value={progPreset} onChange={(e) => setProgPreset(e.target.value as ChordProgressionPreset)} aria-label="Progresión">
          <option value="pop_1564">Pop / Himno (I - V - vi - IV)</option>
          <option value="emotional_6415">Emotiva (vi - IV - I - V)</option>
          <option value="jazz_251">Jazz Soul (ii7 - V7 - Imaj7)</option>
          <option value="rock_1b74">Rock Mixolidio (I - bVII - IV)</option>
          <option value="from_session">Desde acordes de la canción</option>
        </select>
        <select className="stu-field" value={voicing} onChange={(e) => setVoicing(e.target.value as ChordVoicingStyle)} aria-label="Voicing">
          <option value="triads">Tríadas llenas</option>
          <option value="sevenths">Séptimas ricas</option>
          <option value="arpeggio">Arpegio corcheas</option>
          <option value="bass">Línea de bajo</option>
        </select>
        <select className="stu-field" value={bars} onChange={(e) => setBars(Number(e.target.value))} aria-label="Compases">
          <option value={4}>4 compases</option>
          <option value={8}>8 compases</option>
          <option value={16}>16 compases</option>
        </select>
      </div>
      <div className="stu-actions">
        <button type="button" className="stu-btn" disabled={snap.recording} onClick={applyProgression} data-testid="studio-generate-chords-btn">
          <Music size={13} />
          INSERTAR PROGRESIÓN
        </button>
      </div>
    </div>
  )
}
