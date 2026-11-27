import React from 'react'
import { Circle, GitCommit, Headphones, Mic, Music, Pause, Play, Share2, Sliders, Square, Wand2 } from 'lucide-react'
import { dbToFader, faderToDb } from '../../services/studio/faderScale'
import { transposeChord, transposeKey } from '../../services/chordpro'
import { transpose } from '../../services/studio/midiOps'
import { setChords, updateMidiClip, updateSessionMeta } from '../../services/studio/sessionOps'
import { studioTrackColor } from '../../services/studioCanvasPalette'
import { formatDb, trackColor, useStudio, type StudioController } from './studioState'
import { useStudioCanvasPalette } from './useStudioCanvasPalette'

interface Props {
  controller: StudioController
  recordAllowed: boolean
  onOpenExport: () => void
  onSyncToSong?: () => void
}

const FADER_STEPS = 1000

/**
 * Superficie Movil `RAPIDO` (< 768px): controles tactiles grandes (>= 44px) pensados para el
 * escenario, camerino o ensayo urgente con una sola mano (GEMINI.md: manos ocupadas, poca luz).
 */
export const StudioMobileQuickSurface: React.FC<Props> = ({ controller, recordAllowed, onOpenExport, onSyncToSong }) => {
  const snap = useStudio(controller)
  const palette = useStudioCanvasPalette()
  const { session, engine, recording, abState } = snap
  const playing = engine.status === 'playing' || engine.status === 'count_in'

  const adjustBpm = (delta: number) => {
    const nextBpm = Math.max(40, Math.min(260, Math.round((session.bpm + delta) * 10) / 10))
    controller.updateMeta({ bpm: nextBpm }, `Tempo ${nextBpm} BPM`)
  }

  const transposeSessionKey = (semitones: number) => {
    const baseKey = session.key?.trim() || 'C'
    const nextKey = transposeKey(baseKey, semitones) ?? baseKey
    controller.run(`Transponer sesión (${semitones > 0 ? '+' : ''}${semitones})`, (cur) => {
      let next = updateSessionMeta(cur, { patch: { key: nextKey } })
      const curChords = next.chords ?? []
      if (curChords.length > 0) {
        next = setChords(next, {
          chords: curChords.map((ch) => ({ ...ch, name: transposeChord(ch.name, semitones) })),
        })
      }
      for (const track of next.tracks) {
        if (track.kind === 'instrument' && track.instrument?.type !== 'drums') {
          for (const clip of track.midiClips) {
            if (clip.notes.length > 0) {
              const res = transpose(clip.notes, null, semitones, clip.lengthBeats)
              next = updateMidiClip(next, { clipId: clip.id, patch: { notes: res.notes } })
            }
          }
        }
      }
      return next
    })
  }

  const quickRecordIdea = async () => {
    if (recording) {
      await controller.stopRecording()
      return
    }
    if (!recordAllowed) {
      controller.notify('warn', snap.recordBlockReason ?? 'Grabación no disponible en este navegador.')
      return
    }
    // Si ninguna pista de audio esta armada, crear o armar la primera pista de audio automaticamente.
    let targetAudioTrack = session.tracks.find((t) => t.kind === 'audio' && snap.arms[t.id] !== undefined)
    if (!targetAudioTrack) {
      targetAudioTrack = session.tracks.find((t) => t.kind === 'audio')
      if (!targetAudioTrack) {
        controller.addEmptyTrack()
        targetAudioTrack = controller.snapshot().session.tracks.find((t) => t.kind === 'audio')
      }
      if (targetAudioTrack) {
        controller.setArm(targetAudioTrack.id, 0)
      }
    }
    await controller.startRecording()
  }

  return (
    <div className="stu-mobile-quick" data-testid="studio-mobile-quick">
      {/* Transporte y toma rapida de 1 pista */}
      <div className="stu-mq-card">
        <div className="stu-mq-transport">
          <button
            type="button"
            className="stu-btn stu-mq-bigbtn b-transport"
            data-tone="primary"
            onClick={() => controller.togglePlay()}
            data-testid="studio-mq-play"
          >
            {playing ? <Pause size={20} /> : <Play size={20} />}
            {playing ? 'PAUSAR' : 'REPRODUCIR'}
          </button>
          <button
            type="button"
            className="stu-btn stu-mq-bigbtn b-transport"
            onClick={() => controller.stop()}
          >
            <Square size={18} />
            INICIO
          </button>
          <button
            type="button"
            className="stu-btn stu-mq-bigbtn b-transport"
            data-tone={recording ? 'danger' : undefined}
            data-on={recording}
            onClick={() => void quickRecordIdea()}
            data-testid="studio-mq-record"
          >
            {recording ? <Square size={18} /> : <Circle size={18} />}
            {recording ? 'DETENER TOMA' : 'GRABAR IDEA (3M)'}
          </button>
        </div>
      </div>

      {/* Ajustes urgentes de escenario: BPM y Tonalidad */}
      <div className="stu-mq-grid2">
        <div className="stu-mq-card">
          <span className="stu-label">Tempo urgente</span>
          <strong className="stu-mq-readout">{session.bpm} BPM</strong>
          <div className="stu-mq-row">
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => adjustBpm(-2)}>
              -2
            </button>
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => adjustBpm(-1)}>
              -1
            </button>
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => controller.tapTempo()}>
              TAP
            </button>
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => adjustBpm(1)}>
              +1
            </button>
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => adjustBpm(2)}>
              +2
            </button>
          </div>
        </div>

        <div className="stu-mq-card">
          <span className="stu-label">Tono y Acordes</span>
          <strong className="stu-mq-readout">{session.key || 'Sin tono'}</strong>
          <div className="stu-mq-row">
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => transposeSessionKey(-1)}>
              -1 ST
            </button>
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => transposeSessionKey(1)}>
              +1 ST
            </button>
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => controller.detectLocalMusicalAnalysis()} title="Detectar BPM y Tono">
              <Mic size={14} />
              AUTO
            </button>
          </div>
        </div>
      </div>

      {/* Faders horizontales grandes por pista */}
      <div className="stu-mq-card">
        <div className="stu-param-head">
          <span className="stu-label">Mezcla rápida ({session.tracks.length} pistas)</span>
          <span className="stu-label">Master {formatDb(session.master.volumeDb)} dB</span>
        </div>

        {session.tracks.length === 0 ? (
          <p className="stu-help">Toca GRABAR IDEA para capturar voz/instrumento con el micrófono o cambia a ARREGLO para importar pistas.</p>
        ) : (
          <div className="stu-mq-faders">
            {session.tracks.map((track, idx) => {
              const color = studioTrackColor(palette, trackColor(idx, track.role))
              return (
                <div key={track.id} className="stu-mq-track" style={{ ['--stu-track' as string]: color }}>
                  <div className="stu-mq-track-top">
                    <span className="stu-mq-track-dot" />
                    <strong className="stu-mq-track-name">{track.name}</strong>
                    <span className="stu-mono stu-label">{formatDb(track.volumeDb)} dB</span>
                    <button
                      type="button"
                      className="stu-btn stu-mq-ms"
                      data-on={track.mute}
                      data-accent="warn"
                      onClick={() => controller.updateTrack(track.id, { mute: !track.mute }, 'Mute')}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className="stu-btn stu-mq-ms"
                      data-on={track.solo}
                      data-accent="play"
                      onClick={() => controller.updateTrack(track.id, { solo: !track.solo }, 'Solo')}
                    >
                      S
                    </button>
                  </div>
                  <input
                    type="range"
                    className="stu-range stu-mq-slider"
                    min={0}
                    max={FADER_STEPS}
                    step={5}
                    value={Math.round(dbToFader(track.volumeDb) * FADER_STEPS)}
                    onChange={(e) => controller.updateTrackLive(track.id, { volumeDb: faderToDb(Number(e.target.value) / FADER_STEPS) })}
                    onPointerUp={() => controller.commitLive(`Volumen de ${track.name}`)}
                    aria-label={`Volumen de ${track.name}`}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Acciones de 1 toque: Produccion, Versiones y Show */}
      <div className="stu-mq-card">
        <span className="stu-label">Acciones instantáneas (0 cuota IA)</span>
        <div className="stu-mq-actions">
          <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => controller.applyAutoMaster('live_stage', 'balanced')}>
            <Wand2 size={15} />
            MASTER VIVO (-9 LUFS)
          </button>
          <button type="button" className="stu-btn stu-mq-touch" disabled={recording || session.tracks.length < 2} onClick={() => controller.unmaskMixBark(0.75)}>
            <Sliders size={15} />
            DESENMASCARAR BARK
          </button>
          <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => void controller.generateClickGuideTrack()}>
            <Music size={15} />
            GENERAR CLIC
          </button>
          <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={() => void controller.commitVcsSnapshot('Ajuste móvil rápido')}>
            <GitCommit size={15} />
            GUARDAR SNAPSHOT
          </button>
          <button
            type="button"
            className="stu-btn stu-mq-touch"
            data-on={abState?.active === 'B'}
            disabled={recording}
            onClick={() => void controller.toggleAbListening()}
          >
            <Headphones size={15} />
            {abState?.active === 'B' ? 'ESCUCHANDO B' : 'COMPARAR A/B'}
          </button>
          {onSyncToSong && (
            <button type="button" className="stu-btn stu-mq-touch" disabled={recording} onClick={onSyncToSong}>
              <Share2 size={15} />
              PASAR A CANCIÓN
            </button>
          )}
          <button type="button" className="stu-btn stu-mq-touch" data-tone="primary" disabled={recording} onClick={onOpenExport}>
            PUBLICAR STEMS
          </button>
        </div>
      </div>
    </div>
  )
}
