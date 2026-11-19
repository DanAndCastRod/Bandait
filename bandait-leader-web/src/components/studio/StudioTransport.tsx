import React, { useEffect, useRef } from 'react'
import { Metronome, Pause, Play, Repeat, SkipBack, Square } from 'lucide-react'
import { STUDIO_BEATS_PER_BAR_MAX, STUDIO_BEATS_PER_BAR_MIN, STUDIO_BPM_MAX, STUDIO_BPM_MIN, STUDIO_MAX_KEY } from '../../services/studio/session'
import { barBeatAt, formatTimecode, useStudio, type StudioPanelProps } from './studioState'

interface Props extends StudioPanelProps {
  /** false en navegadores sin grabacion o en pantallas angostas: el boton de grabar queda apagado. */
  recordAllowed: boolean
  /** Por que no se puede grabar (texto del `title` del boton). */
  recordHint: string | null
}

const COUNT_IN_OPTIONS = [0, 1, 2, 4]

/** Compases que toma la repeticion cuando se enciende sin secciones de cancion. */
const DEFAULT_LOOP_BARS = 4

/**
 * Transporte del Estudio: reproducir, detener, grabar, repeticion, clic, conteo, tempo y posicion.
 * La posicion se escribe en el DOM desde requestAnimationFrame (controller.onFrame): no hay estado
 * de React que avance con el cabezal.
 */
export const StudioTransport: React.FC<Props> = ({ controller, recordAllowed, recordHint }) => {
  const snap = useStudio(controller)
  const { session, engine, recording, ready } = snap
  const barRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let lastBar = ''
    let lastTime = ''
    return controller.onFrame(() => {
      const position = controller.engine.position()
      const { bpm, beatsPerBar } = controller.snapshot().session
      const at = barBeatAt(position, bpm, beatsPerBar)
      const bar = `${String(at.bar).padStart(3, '0')}.${at.beat}`
      const time = formatTimecode(position)
      if (bar !== lastBar && barRef.current) {
        barRef.current.textContent = bar
        lastBar = bar
      }
      if (time !== lastTime && timeRef.current) {
        timeRef.current.textContent = time
        lastTime = time
      }
    })
  }, [controller])

  const rolling = engine.status === 'playing' || engine.status === 'count_in'
  const readoutState = recording ? 'recording' : engine.status
  const statusText = recording
    ? engine.status === 'count_in'
      ? 'CONTEO'
      : 'GRABANDO'
    : engine.status === 'count_in'
      ? 'CONTEO'
      : engine.status === 'playing'
        ? 'REPRODUCIENDO'
        : engine.status === 'loading' || !ready
          ? 'CARGANDO'
          : 'DETENIDO'

  const toggleLoop = () => {
    if (engine.loop) {
      controller.setLoop(null)
      return
    }
    const position = controller.engine.position()
    const section = snap.sections.find((s) => position >= s.startSec && position < s.endSec)
    if (section) {
      controller.setLoop({ startS: section.startSec, endS: section.endSec })
      return
    }
    const barS = (60 / session.bpm) * session.beatsPerBar
    const startS = Math.floor(position / barS + 1e-6) * barS
    controller.setLoop({ startS, endS: startS + barS * DEFAULT_LOOP_BARS })
  }

  const commitNumber = (raw: string, current: number, apply: (value: number) => void) => {
    const value = Number(raw.replace(',', '.'))
    if (Number.isFinite(value) && value !== current) apply(value)
  }

  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }

  return (
    <section className="stu-transport" aria-label="Transporte" data-testid="studio-transport">
      <div className="stu-readout" data-state={readoutState} role="group" aria-label="Posición">
        <span className="stu-readout-main" ref={barRef} aria-label="Compás y tiempo" data-testid="studio-position-bar">
          001.1
        </span>
        <span className="stu-readout-sub" ref={timeRef} aria-label="Minutos y segundos" data-testid="studio-position-time">
          0:00.000
        </span>
        <span className="stu-label" aria-live="polite" data-testid="studio-status">
          {statusText}
        </span>
        <span className="stu-label" style={{ textAlign: 'right' }}>
          {engine.loop ? `REPITE ${formatTimecode(engine.loop.startS)} - ${formatTimecode(engine.loop.endS)}` : 'COMPÁS . TIEMPO'}
        </span>
      </div>

      <div className="stu-keys" role="group" aria-label="Controles de transporte">
        <button
          type="button"
          className="stu-btn stu-key"
          onClick={() => controller.stop()}
          disabled={!ready}
          aria-label={rolling || recording ? 'Detener' : 'Volver al inicio'}
          title={rolling || recording ? 'Detener' : 'Volver al inicio'}
          data-testid="studio-stop"
        >
          {rolling || recording ? <Square size={16} /> : <SkipBack size={16} />}
        </button>
        <button
          type="button"
          className="stu-btn stu-key"
          data-kind="play"
          data-on={rolling && !recording}
          aria-pressed={rolling}
          onClick={() => controller.togglePlay()}
          disabled={!ready || recording}
          aria-label={rolling ? 'Pausar (espacio)' : 'Reproducir (espacio)'}
          title={rolling ? 'Pausar (espacio)' : 'Reproducir (espacio)'}
          data-testid="studio-play"
        >
          {rolling ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          type="button"
          className="stu-btn stu-key"
          data-kind="rec"
          data-on={recording}
          data-accent="rec"
          aria-pressed={recording}
          onClick={() => controller.toggleRecord()}
          disabled={!ready || !recordAllowed}
          aria-label={recording ? 'Detener la grabación (R)' : 'Grabar en las pistas armadas (R)'}
          title={recordHint ?? (recording ? 'Detener la grabación (R)' : 'Grabar en las pistas armadas (R)')}
          data-testid="studio-record"
        >
          <span className="stu-rec-dot" aria-hidden="true" />
        </button>
      </div>

      <div className="stu-divider" aria-hidden="true" />

      <div className="stu-group" role="group" aria-label="Repetición y clic">
        <button
          type="button"
          className="stu-btn"
          data-size="icon"
          data-on={engine.loop !== null}
          data-accent="play"
          aria-pressed={engine.loop !== null}
          onClick={toggleLoop}
          disabled={!ready || recording}
          aria-label="Repetición"
          title={engine.loop ? 'Quitar la repetición' : 'Repetir la sección (o 4 compases) desde el cabezal. También se marca arrastrando sobre la regla.'}
          data-testid="studio-loop"
        >
          <Repeat size={15} />
        </button>
        <button
          type="button"
          className="stu-btn"
          data-size="icon"
          data-on={engine.click.enabled}
          data-accent="warn"
          aria-pressed={engine.click.enabled}
          onClick={() => controller.setClick({ enabled: !engine.click.enabled })}
          aria-label="Clic"
          title="Clic del Estudio (no entra en la mezcla)"
          data-testid="studio-click"
        >
          <Metronome size={15} />
        </button>
        <input
          type="range"
          className="stu-range"
          style={{ width: '72px' }}
          min={-36}
          max={6}
          step={1}
          value={engine.click.volumeDb}
          onChange={(event) => controller.setClick({ volumeDb: Number(event.target.value) })}
          aria-label="Volumen del clic en dB"
          title={`Volumen del clic: ${engine.click.volumeDb} dB`}
        />
        <label className="stu-meta">
          <span className="stu-label">Conteo</span>
          <select
            className="stu-field"
            data-size="mini"
            value={engine.click.countInBars}
            onChange={(event) => controller.setClick({ countInBars: Number(event.target.value) })}
            aria-label="Compases de conteo antes de grabar"
            data-testid="studio-count-in"
          >
            {COUNT_IN_OPTIONS.map((bars) => (
              <option key={bars} value={bars}>
                {bars === 0 ? 'Sin conteo' : bars === 1 ? '1 compás' : `${bars} compases`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stu-divider" aria-hidden="true" />

      <div className="stu-group" role="group" aria-label="Tempo de la sesión">
        <label className="stu-meta">
          <span className="stu-label">BPM</span>
          <input
            key={`bpm-${session.bpm}`}
            className="stu-field stu-mono"
            style={{ width: '68px' }}
            inputMode="decimal"
            defaultValue={String(session.bpm)}
            disabled={recording}
            onKeyDown={blurOnEnter}
            onBlur={(event) => commitNumber(event.target.value, session.bpm, (bpm) => controller.updateMeta({ bpm: Math.min(STUDIO_BPM_MAX, Math.max(STUDIO_BPM_MIN, bpm)) }, 'Cambiar tempo'))}
            aria-label={`Tempo en BPM, de ${STUDIO_BPM_MIN} a ${STUDIO_BPM_MAX}`}
            data-testid="studio-bpm"
          />
        </label>
        <label className="stu-meta">
          <span className="stu-label">Compás</span>
          <input
            key={`bar-${session.beatsPerBar}`}
            className="stu-field stu-mono"
            style={{ width: '46px' }}
            inputMode="numeric"
            defaultValue={String(session.beatsPerBar)}
            disabled={recording}
            onKeyDown={blurOnEnter}
            onBlur={(event) =>
              commitNumber(event.target.value, session.beatsPerBar, (beats) =>
                controller.updateMeta({ beatsPerBar: Math.min(STUDIO_BEATS_PER_BAR_MAX, Math.max(STUDIO_BEATS_PER_BAR_MIN, Math.round(beats))) }, 'Cambiar compás')
              )
            }
            aria-label="Tiempos por compás"
          />
        </label>
        <label className="stu-meta">
          <span className="stu-label">Tono</span>
          <input
            key={`key-${session.key ?? ''}`}
            className="stu-field stu-mono"
            style={{ width: '58px' }}
            maxLength={STUDIO_MAX_KEY}
            defaultValue={session.key ?? ''}
            placeholder="-"
            disabled={recording}
            onKeyDown={blurOnEnter}
            onBlur={(event) => {
              const key = event.target.value.trim()
              if (key !== (session.key ?? '')) controller.updateMeta({ key: key || null }, 'Cambiar tonalidad')
            }}
            aria-label="Tonalidad"
          />
        </label>
        <div className="stu-meta">
          <span className="stu-label">Frecuencia</span>
          <strong>{(session.sampleRate / 1000).toFixed(1)} kHz</strong>
        </div>
      </div>
    </section>
  )
}
