import React, { useState } from 'react'
import { Music, Sliders, X } from 'lucide-react'
import { STUDIO_HUMANIZE_PRESETS } from '../../services/studio/midiOps'
import type { ChordProgressionPreset, ChordVoicingStyle } from '../../services/studio/productionTools'
import type { HumanizePresetId } from '../../services/studio/types'
import { useStudio, type StudioController } from './studioState'

interface Props {
  controller: StudioController
  onClose: () => void
}

export const StudioHumanizePopover: React.FC<Props> = ({ controller, onClose }) => {
  const snap = useStudio(controller)
  const [preset, setPreset] = useState<HumanizePresetId>('pocket')
  const [amount, setAmount] = useState<number>(snap.piano.humanizeAmount || 0.5)
  const [swingPct, setSwingPct] = useState<number>(56)
  const [strumBeats, setStrumBeats] = useState<number>(0)
  const [accentStrength, setAccentStrength] = useState<number>(0.35)

  const [progPreset, setProgPreset] = useState<ChordProgressionPreset>('pop_1564')
  const [voicing, setVoicing] = useState<ChordVoicingStyle>('sevenths')
  const [bars, setBars] = useState<number>(4)

  const selectPreset = (id: HumanizePresetId) => {
    setPreset(id)
    const spec = STUDIO_HUMANIZE_PRESETS.find((p) => p.id === id) ?? STUDIO_HUMANIZE_PRESETS[0]
    setSwingPct(Math.round(50 + spec.swing * 50))
    setStrumBeats(spec.strumBeats)
    setAccentStrength(spec.accentStrength)
  }

  const applyHumanize = () => {
    const swing = Math.max(0, Math.min(0.5, (swingPct - 50) / 50))
    controller.setPiano({ humanizeAmount: amount })
    controller.humanizeNotes({
      preset,
      amount,
      swing,
      strumBeats,
      accentStrength,
      beatsPerBar: snap.session.beatsPerBar,
    })
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
            data-testid={`studio-humanize-preset-${spec.id}`}
          >
            {spec.label}
          </button>
        ))}
      </div>

      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Intensidad global (micro-timing y fraseo)</span>
          <span className="stu-param-val">{Math.round(amount * 100)}%</span>
        </span>
        <input
          type="range"
          className="stu-range"
          min={5}
          max={100}
          step={5}
          value={Math.round(amount * 100)}
          onChange={(e) => setAmount(Number(e.target.value) / 100)}
        />
      </label>

      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Groove / Swing</span>
          <span className="stu-param-val">{swingPct}%</span>
        </span>
        <input
          type="range"
          className="stu-range"
          min={50}
          max={75}
          step={1}
          value={swingPct}
          onChange={(e) => setSwingPct(Number(e.target.value))}
        />
      </label>

      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Rasgueo de acordes (Strum)</span>
          <span className="stu-param-val">
            {strumBeats === 0 ? 'Recto' : `${strumBeats > 0 ? 'Abajo ' : 'Arriba '}${Math.round(Math.abs(strumBeats) * 1000)} mB`}
          </span>
        </span>
        <input
          type="range"
          className="stu-range"
          min={-0.12}
          max={0.12}
          step={0.01}
          value={strumBeats}
          onChange={(e) => setStrumBeats(Number(e.target.value))}
        />
      </label>

      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Acento métrico del compás</span>
          <span className="stu-param-val">{Math.round(accentStrength * 100)}%</span>
        </span>
        <input
          type="range"
          className="stu-range"
          min={0}
          max={100}
          step={5}
          value={Math.round(accentStrength * 100)}
          onChange={(e) => setAccentStrength(Number(e.target.value) / 100)}
        />
      </label>

      <div className="stu-actions">
        <button type="button" className="stu-btn" data-tone="primary" disabled={snap.recording} onClick={applyHumanize} data-testid="studio-humanize-apply">
          <Sliders size={13} />
          APLICAR HUMANIZACIÓN
        </button>
      </div>

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
