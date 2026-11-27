import React, { useState } from 'react'
import { Copy, Music, Piano, RefreshCw, Scissors, Sliders, Sparkles, Trash2 } from 'lucide-react'
import { transcribe } from '../../services/studio/audioToMidi'
import {
  defaultInstrument,
  defaultInstrumentTrack,
  defaultMidiClip,
  findClip,
  findMidiClip,
  newStudioId,
  roundBeat,
  secondsToBeats,
  STUDIO_MAX_TRACK_NAME,
  STUDIO_MAX_TRACKS,
  STUDIO_MIDI_MIN_CLIP_BEATS,
} from '../../services/studio/session'
import { addInstrumentTrack, addMidiClip } from '../../services/studio/sessionOps'
import { quantizeNotesToKey } from '../../services/studio/trackClassifier'
import { errorText, useStudio, type StudioController } from './studioState'

interface Props {
  controller: StudioController
}

/**
 * Barra contextual rapida de 1 clic sobre el clip elegido (audio o MIDI):
 *   - En audio: Normalizar (-14 LUFS), Fase 180°, Alinear Fase (GCC-PHAT), Strip Silence,
 *     Reversa, Detectar BPM/Tono/Acordes local, Audio a MIDI (Basic Pitch + escala), Dividir, Duplicar, Borrar.
 *   - En MIDI: Abrir Piano Roll, Cuantizar, Humanizar, Dividir, Duplicar, Borrar.
 */
export const StudioClipActionBar: React.FC<Props> = ({ controller }) => {
  const snap = useStudio(controller)
  const [transcribing, setTranscribing] = useState(false)

  const clipId = snap.selectedClipId
  if (!clipId || snap.recording) return null

  const audioLoc = findClip(snap.session, clipId)
  const midiLoc = audioLoc ? null : findMidiClip(snap.session, clipId)
  if (!audioLoc && !midiLoc) return null

  const runAudioToMidi = async () => {
    if (!audioLoc || transcribing) return
    const buffer = controller.engine.getBuffer(audioLoc.clip.assetId)
    if (!buffer) {
      controller.notify('warn', 'El audio de este clip todavía se está cargando.')
      return
    }
    setTranscribing(true)
    try {
      const sr = buffer.sampleRate
      const from = Math.max(0, Math.floor(audioLoc.clip.offsetS * sr))
      const to = Math.max(from + 1, Math.min(buffer.length, Math.ceil((audioLoc.clip.offsetS + audioLoc.clip.lengthS) * sr)))
      const length = to - from
      const ctx = controller.engine.getContext()
      const sub = ctx.createBuffer(1, length, sr)
      const dst = sub.getChannelData(0)
      const ch0 = buffer.getChannelData(0)
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null
      for (let i = 0; i < length; i++) {
        dst[i] = ch1 ? (ch0[from + i] + ch1[from + i]) * 0.5 : ch0[from + i]
      }

      const rawNotes = await transcribe(sub, { bpm: snap.session.bpm })
      if (rawNotes.length === 0) {
        controller.notify('warn', 'No se detectaron notas melódicas claras en este clip.')
        return
      }
      const clipBeats = Math.max(
        STUDIO_MIDI_MIN_CLIP_BEATS,
        roundBeat(secondsToBeats(audioLoc.clip.lengthS, snap.session.bpm)),
      )
      const notes = quantizeNotesToKey(rawNotes, snap.session.key, clipBeats)
      const startBeat = roundBeat(secondsToBeats(audioLoc.clip.startS, snap.session.bpm))
      const newClipId = newStudioId('mid')
      const newTrackId = newStudioId('trk')
      const inst = defaultInstrument('synth', 'electric_piano')
      const trackName = `${audioLoc.track.name} (MIDI)`.slice(0, STUDIO_MAX_TRACK_NAME)

      controller.run(
        'Transcribir audio a MIDI',
        (cur) => {
          if (cur.tracks.length >= STUDIO_MAX_TRACKS) throw new Error(`El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas.`)
          let next = addInstrumentTrack(cur, {
            track: defaultInstrumentTrack({ id: newTrackId, name: trackName, instrument: inst, role: 'keys' }),
          })
          next = addMidiClip(next, {
            trackId: newTrackId,
            clip: defaultMidiClip({ id: newClipId, startBeat, lengthBeats: clipBeats, notes }),
          })
          return next
        },
        { selectedClipId: newClipId, selectedTrackId: newTrackId },
      )
      controller.notify('info', `Transcripción local completada: ${notes.length} notas MIDI creadas.`)
    } catch (err) {
      controller.notify('error', errorText(err, 'No se pudo transcribir el clip a MIDI.'))
    } finally {
      setTranscribing(false)
    }
  }

  return (
    <div className="stu-clip-actionbar" role="toolbar" aria-label="Acciones rápidas del clip elegido" data-testid="studio-clip-actionbar">
      {audioLoc && (
        <>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            onClick={() => controller.normalizeSelectedClips('lufs', -14)}
            title="Normalizar sonoridad a -14 LUFS con techo True Peak en -1 dBTP"
          >
            NORM -14
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            data-on={audioLoc.clip.phaseInvert === true}
            aria-pressed={audioLoc.clip.phaseInvert === true}
            onClick={() => controller.invertSelectedClipsPhase()}
            title="Invertir polaridad (180 grados)"
          >
            FASE 180°
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            onClick={() => controller.alignSelectedClipPhase()}
            title="Alinear fase y tiempo automáticamente respecto a otra pista activa (GCC-PHAT)"
          >
            ALINEAR FASE
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            onClick={() => controller.stripSilenceSelectedClip()}
            title="Recortar silencios intermedios (Strip Silence con histéresis)"
          >
            SILENCIOS
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            onClick={() => void controller.reverseSelectedClip()}
            title="Invertir audio en reversa"
          >
            <RefreshCw size={11} />
            REVERSA
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            onClick={() => controller.detectLocalMusicalAnalysis(audioLoc.clip.id)}
            title="Detectar BPM, tonalidad y acordes localmente (0 cuota IA)"
          >
            <Music size={11} />
            DETECTAR
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            disabled={transcribing}
            onClick={() => void runAudioToMidi()}
            title="Transcribir audio a notas MIDI en este navegador (Basic Pitch + escala)"
          >
            <Sparkles size={11} />
            {transcribing ? 'A MIDI...' : 'A MIDI'}
          </button>
        </>
      )}

      {midiLoc && (
        <>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            data-tone="primary"
            onClick={() => controller.openPianoRoll(midiLoc.clip.id)}
            title="Abrir notas en el Piano Roll (E)"
          >
            <Piano size={12} />
            PIANO ROLL
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            onClick={() => controller.quantizeSelection()}
            title="Cuantizar notas a la rejilla (Q)"
          >
            CUANTIZAR
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            onClick={() => controller.humanizeSelection()}
            title="Humanizar tiempo y velocidad (H)"
          >
            <Sliders size={11} />
            HUMANIZAR
          </button>
        </>
      )}

      <button type="button" className="stu-btn" data-size="small" onClick={() => controller.splitSelection()} title="Dividir en el cabezal (S)">
        <Scissors size={11} />
        DIVIDIR
      </button>
      <button type="button" className="stu-btn" data-size="small" onClick={() => controller.duplicateSelection()} title="Duplicar (Ctrl+D)">
        <Copy size={11} />
        DUPLICAR
      </button>
      <button type="button" className="stu-btn" data-size="small" data-tone="danger" onClick={() => controller.deleteSelection()} title="Borrar (Supr)">
        <Trash2 size={11} />
      </button>
    </div>
  )
}
