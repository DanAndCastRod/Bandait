import React, { useEffect, useRef } from 'react'
import { Circle, Keyboard, Minus, OctagonX, Plus, Square, Usb } from 'lucide-react'
import { COMPUTER_KEYBOARD_MAX_OCTAVE, COMPUTER_KEYBOARD_MIN_OCTAVE } from '../../services/studio/computerKeyboard'
import { STUDIO_INSTRUMENT_TYPE_LABELS } from '../../services/studio/session'
import { pitchName, useStudio, type StudioController } from './studioState'

interface Props {
  controller: StudioController
}

/** Fila A..K del teclado de la computadora: tecla, si es negra, y semitono sobre el Do de la octava. */
const KEYBOARD_MAP: readonly { key: string; black: boolean; semitone: number }[] = [
  { key: 'A', black: false, semitone: 0 },
  { key: 'W', black: true, semitone: 1 },
  { key: 'S', black: false, semitone: 2 },
  { key: 'E', black: true, semitone: 3 },
  { key: 'D', black: false, semitone: 4 },
  { key: 'F', black: false, semitone: 5 },
  { key: 'T', black: true, semitone: 6 },
  { key: 'G', black: false, semitone: 7 },
  { key: 'Y', black: true, semitone: 8 },
  { key: 'H', black: false, semitone: 9 },
  { key: 'U', black: true, semitone: 10 },
  { key: 'J', black: false, semitone: 11 },
  { key: 'K', black: false, semitone: 12 },
]

const ACCESS_TEXT: Readonly<Record<string, string>> = {
  unsupported: 'Este navegador no tiene Web MIDI. Usa Chrome o Edge de escritorio, o el teclado de la computadora.',
  prompt: 'Para usar un teclado MIDI, el navegador tiene que darte permiso.',
  denied: 'El permiso de MIDI está negado. Habilítalo en la configuración del sitio del navegador y vuelve a intentar.',
  granted: '',
}

/**
 * Entrada MIDI del Estudio: dispositivo, canal, pista armada, grabacion sobre el clic (con el
 * conteo del clic, como el audio) y el teclado de la computadora como respaldo, con su octava.
 * Tocar suena en la pista armada o, si no hay, en la pista de instrumento elegida. La ultima nota
 * se muestra escribiendo el texto en el DOM desde el oyente: no hay estado de React por nota.
 */
export const StudioMidiDevicePanel: React.FC<Props> = ({ controller }) => {
  const snap = useStudio(controller)
  const { session, midi, recording } = snap
  const lastNoteRef = useRef<HTMLSpanElement>(null)
  const instrumentTracks = session.tracks.filter((track) => track.kind === 'instrument')
  const armed = midi.armedTrackId ? (instrumentTracks.find((track) => track.id === midi.armedTrackId) ?? null) : null
  const playing = snap.engine.status === 'playing' || snap.engine.status === 'count_in'
  const recordingMidi = recording && armed !== null
  const connected = midi.devices.filter((device) => device.connected)

  // Ultima nota recibida: se escribe directo en el DOM (no repinta el panel por nota).
  useEffect(() => {
    if (midi.access !== 'granted' && !midi.keyboard) return
    return controller.onMidiNote((event) => {
      const el = lastNoteRef.current
      if (!el || event.type !== 'on') return
      el.textContent = `${pitchName(event.pitch)} · vel ${event.velocity}${event.source === 'keyboard' ? ' · teclado' : ` · canal ${event.channel + 1}`}`
    })
  }, [controller, midi.access, midi.keyboard])

  return (
    <section className="stu-section" aria-label="Entrada MIDI" data-testid="studio-midi-panel">
      <div className="stu-param-head">
        <span className="stu-label">Entrada MIDI</span>
        <span className="stu-badge" data-tone={midi.deviceId ? 'ok' : midi.keyboard ? 'sel' : undefined}>
          {midi.deviceId ? 'DISPOSITIVO' : midi.keyboard ? 'TECLADO PC' : 'SIN ENTRADA'}
        </span>
      </div>

      {midi.access !== 'granted' ? (
        <>
          <p className="stu-help">{ACCESS_TEXT[midi.access]}</p>
          {midi.access !== 'unsupported' && (
            <button type="button" className="stu-btn" onClick={() => void controller.midiRequestAccess()} data-testid="studio-midi-access">
              <Usb size={13} />
              {midi.access === 'denied' ? 'VOLVER A PEDIR PERMISO' : 'PERMITIR MIDI'}
            </button>
          )}
        </>
      ) : (
        <div className="stu-midi-grid">
          <label className="stu-param">
            <span className="stu-label">Dispositivo</span>
            <select
              className="stu-field"
              value={midi.deviceId ?? ''}
              disabled={recording || connected.length === 0}
              onChange={(event) => {
                if (event.target.value) controller.midiSelectDevice(event.target.value)
              }}
              data-testid="studio-midi-device"
            >
              {midi.deviceId === null && <option value="">{connected.length === 0 ? 'Conecta un teclado MIDI USB' : 'Elige un dispositivo'}</option>}
              {connected.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.manufacturer ? `${device.name} (${device.manufacturer})` : device.name}
                </option>
              ))}
            </select>
          </label>
          <label className="stu-param">
            <span className="stu-label">Canal</span>
            <select
              className="stu-field"
              value={midi.channel === 'all' ? 'all' : String(midi.channel)}
              disabled={recording}
              onChange={(event) => controller.midiSetChannel(event.target.value === 'all' ? 'all' : Number(event.target.value))}
              data-testid="studio-midi-channel"
            >
              <option value="all">Todos</option>
              {Array.from({ length: 16 }, (_v, channel) => (
                <option key={channel} value={channel}>
                  {channel + 1}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <label className="stu-param">
        <span className="stu-label">Pista armada para MIDI</span>
        <select
          className="stu-field"
          value={midi.armedTrackId ?? ''}
          disabled={recording || instrumentTracks.length === 0}
          onChange={(event) => controller.armMidiTrack(event.target.value || null)}
          data-testid="studio-midi-arm"
        >
          <option value="">{instrumentTracks.length === 0 ? 'No hay pistas de instrumento' : 'Ninguna (suena la pista elegida)'}</option>
          {instrumentTracks.map((track) => (
            <option key={track.id} value={track.id}>
              {track.name} · {track.instrument ? STUDIO_INSTRUMENT_TYPE_LABELS[track.instrument.type] : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="stu-check">
        <input type="checkbox" checked={midi.quantizeOnStop} disabled={recording} onChange={(event) => controller.setMidiQuantizeOnStop(event.target.checked)} data-testid="studio-midi-quantize" />
        <span>Cuantizar la toma al terminar (rejilla del piano roll: {snap.piano.grid}{snap.piano.triplets ? ' tresillo' : ''}).</span>
      </label>

      <div className="stu-actions">
        <button
          type="button"
          className="stu-btn"
          data-tone={recordingMidi ? undefined : 'danger'}
          data-on={recordingMidi}
          data-accent="rec"
          aria-pressed={recordingMidi}
          disabled={!armed || !snap.ready || (recording && !recordingMidi)}
          onClick={() => controller.toggleRecord()}
          title={armed ? 'Graba MIDI sobre el clic, con el conteo del clic (R)' : 'Arma una pista de instrumento para grabar MIDI'}
          data-testid="studio-midi-record"
        >
          {recordingMidi ? <Square size={12} /> : <Circle size={12} />}
          {recordingMidi ? 'PARAR' : 'GRABAR MIDI'}
        </button>
        <button type="button" className="stu-btn" data-tone="ghost" onClick={() => controller.midiPanic()} title="Cortar todas las notas que suenan (nota colgada)" data-testid="studio-midi-panic">
          <OctagonX size={13} />
          PÁNICO
        </button>
      </div>
      {armed && !playing && <p className="stu-help">Graba en {armed.name}. Si hay pistas de audio armadas, graban a la vez.</p>}

      <div className="stu-param">
        <div className="stu-param-head">
          <span className="stu-label">Teclado de la computadora</span>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            data-on={midi.keyboard}
            aria-pressed={midi.keyboard}
            onClick={() => controller.toggleComputerKeyboard()}
            title="Fila A..K como teclado musical; Z y X bajan y suben la octava"
            data-testid="studio-midi-keyboard"
          >
            <Keyboard size={13} />
            {midi.keyboard ? 'ACTIVO' : 'ACTIVAR'}
          </button>
        </div>
        <div className="stu-pc-keys" aria-hidden={!midi.keyboard} data-on={midi.keyboard}>
          {KEYBOARD_MAP.map((item) => (
            <span key={item.key} className="stu-pc-key" data-black={item.black} title={pitchName((midi.octave + 1) * 12 + item.semitone)}>
              {item.key}
            </span>
          ))}
        </div>
        <div className="stu-octave" role="group" aria-label="Octava del teclado de la computadora">
          <button type="button" className="stu-btn" data-size="mini" disabled={midi.octave <= COMPUTER_KEYBOARD_MIN_OCTAVE} onClick={() => controller.setKeyboardOctave(midi.octave - 1)} aria-label="Bajar una octava (Z)" title="Bajar una octava (Z)">
            <Minus size={12} />
          </button>
          <span className="stu-octave-val" aria-live="polite" data-testid="studio-midi-octave">
            OCTAVA {midi.octave} · A = {pitchName((midi.octave + 1) * 12)}
          </span>
          <button type="button" className="stu-btn" data-size="mini" disabled={midi.octave >= COMPUTER_KEYBOARD_MAX_OCTAVE} onClick={() => controller.setKeyboardOctave(midi.octave + 1)} aria-label="Subir una octava (X)" title="Subir una octava (X)">
            <Plus size={12} />
          </button>
        </div>
        <p className="stu-help">Con el teclado activo, las letras de la fila A..K tocan notas en vez de disparar atajos. No toca mientras escribes en un campo.</p>
      </div>

      <dl className="stu-kv">
        <dt>Última nota</dt>
        <dd>
          <span ref={lastNoteRef} data-testid="studio-midi-last">
            -
          </span>
        </dd>
      </dl>
    </section>
  )
}
