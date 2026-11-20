import React, { useEffect, useRef } from 'react'
import { Snowflake, X } from 'lucide-react'
import { KNOWN_STEM_ROLES, STEM_ROLE_CODES, stemRoleLabel, type StemRole } from '../../services/stemNames'
import { instrumentAvailability } from '../../services/studio/instruments/index'
import {
  STUDIO_DRUMS_PRESETS,
  STUDIO_INSTRUMENT_TYPE_LABELS,
  STUDIO_MAX_TRACK_NAME,
  STUDIO_SYNTH_PRESETS,
  STUDIO_VOLUME_DB_MAX,
  STUDIO_VOLUME_DB_MIN,
  type StudioInstrument,
  type StudioTrack,
} from '../../services/studio/session'
import { formatDb, formatPan, trackColor, type ArmChannel, type StudioController } from './studioState'

interface Props {
  controller: StudioController
  track: StudioTrack
  index: number
  /** Alto de la fila en px (carril principal mas carriles de tomas): lo fija layoutTracks. */
  height: number
  /** Canal que graba en esta pista, o null si no esta armada. */
  armed: ArmChannel | null
  /** Pista de instrumento armada para MIDI. */
  midiArmed: boolean
  /** Pista elegida (mute, solo e instrumento actuan sobre ella). */
  selected: boolean
  /** false en modo de solo reproduccion y mezcla: no se muestran armar ni entrada. */
  recordAllowed: boolean
  /** Hay una toma en curso: no se cambia el arme ni se quita la pista. */
  recording: boolean
  /** Canales que entrega la entrada abierta (0 si no hay entrada). */
  inputChannels: number
}

const METER_FLOOR_DB = -60
const METER_TOP_DB = 6

function meterFraction(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB)))
}

/** Texto corto del instrumento para la cabecera: tipo y preset. */
function instrumentSummary(instrument: StudioInstrument): string {
  if (instrument.type === 'synth') return STUDIO_SYNTH_PRESETS.find((p) => p.id === instrument.preset)?.label ?? 'Personalizado'
  if (instrument.type === 'drums') return STUDIO_DRUMS_PRESETS.find((p) => p.id === instrument.preset)?.label ?? 'Personalizada'
  if (instrument.type === 'sampler') return instrument.zones.length === 1 ? '1 zona' : `${instrument.zones.length} zonas`
  return instrument.pluginId
}

/**
 * Cabecera de una pista: nombre, rol, armar, entrada, mute, solo, fader, paneo y medidor.
 * El medidor se pinta en un canvas desde requestAnimationFrame; fader y paneo cambian el motor
 * en caliente y dejan un solo paso de deshacer al soltar. En una pista de instrumento, la fila
 * de la entrada muestra el instrumento y R arma la pista para MIDI (no necesita entrada de audio).
 */
export const StudioTrackHeader: React.FC<Props> = ({ controller, track, index, height, armed, midiArmed, selected, recordAllowed, recording, inputChannels }) => {
  const meterRef = useRef<HTMLCanvasElement>(null)
  const color = trackColor(index)
  const instrument = track.kind === 'instrument' ? track.instrument : null
  const availability = instrument ? instrumentAvailability(instrument) : null
  const clipCount = track.clips.length + track.midiClips.length

  useEffect(() => {
    const canvas = meterRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let hold = 0
    let holdUntil = 0
    let lastPeak = -1
    let lastRms = -1
    let lastHold = -1
    return controller.onFrame(() => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (w === 0 || h === 0) return
      let resized = false
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        resized = true
      }
      const reading = controller.engine.readTrackMeter(track.id)
      const peak = meterFraction(reading.peakDb)
      const rms = meterFraction(reading.rmsDb)
      const now = performance.now()
      if (peak >= hold || now > holdUntil) {
        if (peak >= hold) holdUntil = now + 900
        hold = peak >= hold ? peak : Math.max(peak, hold - 0.02)
      }
      // Sin cambios no se repinta: una pista en silencio no gasta nada.
      if (!resized && Math.abs(peak - lastPeak) < 0.004 && Math.abs(rms - lastRms) < 0.004 && Math.abs(hold - lastHold) < 0.004) return
      lastPeak = peak
      lastRms = rms
      lastHold = hold
      ctx.clearRect(0, 0, w, h)
      const zero = meterFraction(0)
      ctx.fillStyle = reading.peakDb > 0 ? '#D96459' : '#3C6E6B'
      ctx.fillRect(0, h - peak * h, w, peak * h)
      ctx.fillStyle = reading.peakDb > 0 ? '#D96459' : '#5CC8C2'
      ctx.fillRect(0, h - rms * h, w, rms * h)
      if (hold > 0.01) {
        ctx.fillStyle = hold > zero ? '#D96459' : '#D5DAE0'
        ctx.fillRect(0, Math.max(0, h - hold * h - dpr), w, Math.max(1, dpr))
      }
      ctx.fillStyle = '#2E343D'
      ctx.fillRect(0, h - zero * h, w, Math.max(1, dpr))
    })
  }, [controller, track.id])

  const commitName = (raw: string) => {
    const name = raw.trim().slice(0, STUDIO_MAX_TRACK_NAME)
    if (name && name !== track.name) controller.updateTrack(track.id, { name }, 'Renombrar pista')
  }

  const armLabel = armed === null ? 'Armar la pista para grabar' : 'Desarmar la pista'

  return (
    <div
      className="stu-head"
      style={{ height: `${height}px`, ['--stu-track' as string]: color }}
      data-armed={armed !== null || midiArmed}
      data-selected={selected}
      data-kind={track.kind}
      data-testid={`studio-track-${track.id}`}
      role="group"
      aria-label={`Pista ${index + 1}: ${track.name}${instrument ? ` (${STUDIO_INSTRUMENT_TYPE_LABELS[instrument.type]})` : ''}`}
      // Tocar la cabecera elige la pista (mute, solo, instrumento y MIDI actuan sobre ella).
      onPointerDown={() => controller.selectTrack(track.id)}
    >
      <div className="stu-head-cols">
        <div className="stu-head-row">
          <input
            key={`name-${track.name}`}
            className="stu-field stu-head-name"
            data-size="mini"
            data-plain="true"
            defaultValue={track.name}
            maxLength={STUDIO_MAX_TRACK_NAME}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.currentTarget.value = track.name
                event.currentTarget.blur()
              }
            }}
            onBlur={(event) => commitName(event.target.value)}
            aria-label="Nombre de la pista"
          />
          <select
            className="stu-field"
            data-size="mini"
            style={{ width: '58px' }}
            value={track.role}
            onChange={(event) => controller.updateTrack(track.id, { role: event.target.value as StemRole }, 'Cambiar rol de pista')}
            aria-label="Rol de la pista"
            title={`Rol: ${stemRoleLabel(track.role)}`}
          >
            {[...KNOWN_STEM_ROLES, 'unknown' as const].map((role) => (
              <option key={role} value={role} title={stemRoleLabel(role)}>
                {STEM_ROLE_CODES[role]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="stu-btn"
            data-size="mini"
            data-tone="ghost"
            disabled={recording}
            onClick={() => {
              if (clipCount === 0 || window.confirm(`¿Quitar la pista "${track.name}" con sus ${clipCount} clips? Se puede deshacer.`)) controller.removeTrack(track.id)
            }}
            aria-label={`Quitar la pista ${track.name}`}
            title="Quitar la pista"
          >
            <X size={12} />
          </button>
        </div>

        <div className="stu-head-row">
          {instrument && (
            <>
              <button
                type="button"
                className="stu-btn"
                data-size="mini"
                data-on={midiArmed}
                data-accent="rec"
                aria-pressed={midiArmed}
                disabled={recording}
                onClick={() => controller.armMidiTrack(midiArmed ? null : track.id)}
                aria-label={midiArmed ? 'Desarmar la pista para MIDI' : 'Armar la pista para grabar y tocar MIDI'}
                title={midiArmed ? 'Desarmar la pista para MIDI' : 'Armar para grabar y tocar MIDI (teclado MIDI o de la computadora)'}
                data-testid={`studio-midi-arm-${track.id}`}
              >
                R
              </button>
              <button
                type="button"
                className="stu-head-inst"
                onClick={() => controller.selectTrack(track.id)}
                title={availability?.available === false ? `${availability.reason ?? 'No disponible'}${track.frozenAssetId ? ' Suena el congelado.' : ' No suena.'}` : 'Ver el instrumento en el inspector'}
                aria-label={`Instrumento: ${STUDIO_INSTRUMENT_TYPE_LABELS[instrument.type]}, ${instrumentSummary(instrument)}`}
                data-testid={`studio-track-instrument-${track.id}`}
              >
                <span className="stu-head-inst-type">{STUDIO_INSTRUMENT_TYPE_LABELS[instrument.type].toUpperCase()}</span>
                <span className="stu-head-inst-preset">{instrumentSummary(instrument)}</span>
              </button>
              {track.frozenAssetId && (
                <span className="stu-badge" data-tone="sel" title="Tiene audio congelado: suena donde el instrumento no esté disponible">
                  <Snowflake size={10} aria-hidden="true" />
                </span>
              )}
              {availability?.available === false && (
                <span className="stu-badge" data-tone="warn" title={availability.reason ?? 'No disponible'}>
                  N/D
                </span>
              )}
            </>
          )}
          {!instrument && recordAllowed && (
            <>
              <button
                type="button"
                className="stu-btn"
                data-size="mini"
                data-on={armed !== null}
                data-accent="rec"
                aria-pressed={armed !== null}
                disabled={recording}
                onClick={() => controller.setArm(track.id, armed === null ? 0 : null)}
                aria-label={armLabel}
                title={armLabel}
                data-testid={`studio-arm-${track.id}`}
              >
                R
              </button>
              <select
                className="stu-field"
                data-size="mini"
                style={{ flex: '1 1 auto', width: 0 }}
                value={armed === null ? '' : String(armed)}
                disabled={recording}
                onChange={(event) => {
                  const value = event.target.value
                  controller.setArm(track.id, value === '' ? null : value === 'stereo' ? 'stereo' : value === '1' ? 1 : 0)
                }}
                aria-label="Entrada que graba en esta pista"
              >
                <option value="">Sin entrada</option>
                <option value="0">Entrada 1</option>
                <option value="1" disabled={inputChannels > 0 && inputChannels < 2}>
                  Entrada 2
                </option>
                <option value="stereo" disabled={inputChannels > 0 && inputChannels < 2}>
                  Estéreo 1-2
                </option>
              </select>
            </>
          )}
          {!instrument && !recordAllowed && <span style={{ flex: '1 1 auto' }} />}
          <button
            type="button"
            className="stu-btn"
            data-size="mini"
            data-on={track.mute}
            data-accent="warn"
            aria-pressed={track.mute}
            onClick={() => controller.updateTrack(track.id, { mute: !track.mute }, track.mute ? 'Quitar mute' : 'Mute')}
            aria-label="Mute"
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
            aria-label="Solo"
            title="Solo"
          >
            S
          </button>
        </div>

        <div className="stu-head-row">
          <input
            type="range"
            className="stu-range"
            min={STUDIO_VOLUME_DB_MIN}
            max={STUDIO_VOLUME_DB_MAX}
            step={0.5}
            value={track.volumeDb}
            onChange={(event) => controller.updateTrackLive(track.id, { volumeDb: Number(event.target.value) })}
            onPointerUp={() => controller.commitLive('Volumen de pista')}
            onKeyUp={() => controller.commitLive('Volumen de pista')}
            onBlur={() => controller.commitLive('Volumen de pista')}
            onDoubleClick={() => controller.updateTrack(track.id, { volumeDb: 0 }, 'Volumen de pista')}
            aria-label="Volumen en dB"
            aria-valuetext={`${formatDb(track.volumeDb)} dB`}
            title="Volumen. Doble clic: 0 dB"
          />
          <span className="stu-head-val" aria-hidden="true">
            {formatDb(track.volumeDb)}
          </span>
        </div>

        <div className="stu-head-row">
          <input
            type="range"
            className="stu-range"
            min={-1}
            max={1}
            step={0.02}
            value={track.pan}
            onChange={(event) => controller.updateTrackLive(track.id, { pan: Number(event.target.value) })}
            onPointerUp={() => controller.commitLive('Paneo de pista')}
            onKeyUp={() => controller.commitLive('Paneo de pista')}
            onBlur={() => controller.commitLive('Paneo de pista')}
            onDoubleClick={() => controller.updateTrack(track.id, { pan: 0 }, 'Paneo de pista')}
            aria-label="Paneo"
            aria-valuetext={formatPan(track.pan)}
            title="Paneo. Doble clic: centro"
          />
          <span className="stu-head-val" aria-hidden="true">
            {formatPan(track.pan)}
          </span>
        </div>
      </div>
      <canvas ref={meterRef} className="stu-meter" aria-hidden="true" />
    </div>
  )
}
