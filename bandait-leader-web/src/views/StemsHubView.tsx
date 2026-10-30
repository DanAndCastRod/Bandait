import React, { useState } from 'react'
import { useHub } from '../context/hubContextCore'
import {
  Sliders,
  Upload,
  Play,
  Square,
  ShieldCheck,
  Cpu,
  FileAudio,
} from 'lucide-react'

export const StemsHubView: React.FC = () => {
  const { songStems, updateStemTrackVolume } = useHub()
  const [isPlaying, setIsPlaying] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<number | null>(null)

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* HEADER BAR */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          borderBottom: '1px solid #2E343D',
          paddingBottom: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sliders size={22} style={{ color: '#7AA5D6' }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              Gestión de Pistas & Stems Multicanal
            </h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#8E97A3' }}>
            Parametriza la matriz fija de 6 canales, ganancias de referencia y separación IA con Demucs GPU.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: isPlaying ? '#D96459' : '#B8CF7A',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 18px',
              color: '#15181C',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {isPlaying ? <Square size={14} /> : <Play size={14} />}
            <span>{isPlaying ? 'DETENER PRE-ESCUCHA' : 'PRE-ESCUCHA STEMS'}</span>
          </button>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: '#7AA5D6',
              borderRadius: '4px',
              padding: '8px 16px',
              color: '#15181C',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            <Upload size={14} />
            <span>SUBIR STEM .WAV</span>
            <input type="file" accept="audio/*" style={{ display: 'none' }} />
          </label>
        </div>
      </div>

      {/* SONG ACTIVE BANNER */}
      <div
        style={{
          background: '#1B1F24',
          border: '1px solid #2E343D',
          borderRadius: '6px',
          padding: '14px 18px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <FileAudio size={24} style={{ color: '#7AA5D6' }} />
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800 }}>{songStems?.songTitle || 'Tema 01'}</div>
            <div style={{ fontSize: '11px', color: '#8E97A3', fontFamily: "'IBM Plex Mono', monospace" }}>
              FORMATO: WAV PCM 24-bit / 48 kHz • TEMPO: {songStems?.bpm} BPM
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '11px',
              color: '#B8CF7A',
              background: 'rgba(184, 207, 122, 0.1)',
              border: '1px solid var(--accent-success, #B8CF7A)',
              padding: '4px 10px',
              borderRadius: '4px',
            }}
          >
            <Cpu size={14} />
            <span>DEMUCS GPU: 4 STEMS SEPARADOS</span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '11px',
              color: '#B8CF7A',
              border: '1px solid #B8CF7A',
              padding: '4px 10px',
              borderRadius: '4px',
            }}
          >
            <ShieldCheck size={14} />
            <span>LIMITADOR -0.5 dBFS ACTIVADO</span>
          </div>
        </div>
      </div>

      {/* 6-CHANNEL STRIPS MATRIX */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '12px',
        }}
      >
        {songStems?.tracks.map((track) => {
          const isSelected = selectedChannel === track.channel
          return (
            <div
              key={track.id}
              onClick={() => setSelectedChannel(track.channel)}
              style={{
                background: isSelected ? '#232830' : '#1B1F24',
                border: isSelected ? '2px solid #7AA5D6' : '1px solid #2E343D',
                borderRadius: '6px',
                padding: '16px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {/* CHANNEL BADGE & CODE */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '10px',
                    color: '#8E97A3',
                    fontWeight: 700,
                  }}
                >
                  CH 0{track.channel}
                </span>
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '11px',
                    fontWeight: 800,
                    color: '#D5DAE0',
                    background: '#2B313A',
                    padding: '2px 6px',
                    borderRadius: '3px',
                  }}
                >
                  {track.code}
                </span>
              </div>

              {/* TRACK NAME */}
              <div>
                <div style={{ fontSize: '14px', fontWeight: 800, color: '#D5DAE0' }}>{track.name}</div>
                <div
                  style={{
                    fontSize: '10px',
                    color: '#8E97A3',
                    fontFamily: "'IBM Plex Mono', monospace",
                    marginTop: '2px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {track.filename}
                </div>
              </div>

              {/* FADER SIMULATION & GAIN READOUT */}
              <div
                style={{
                  background: '#181B20',
                  border: '1px solid #2E343D',
                  borderRadius: '4px',
                  padding: '12px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <div
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '13px',
                    fontWeight: 700,
                    color: track.volumeDb > 0 ? '#5CC8C2' : '#7AA5D6',
                  }}
                >
                  {track.volumeDb >= 0 ? `+${track.volumeDb.toFixed(1)}` : track.volumeDb.toFixed(1)} dB
                </div>

                <input
                  type="range"
                  min="-24"
                  max="6"
                  step="0.5"
                  value={track.volumeDb}
                  onChange={(e) => updateStemTrackVolume(track.channel, parseFloat(e.target.value))}
                  style={{
                    writingMode: 'vertical-lr',
                    direction: 'rtl',
                    height: '110px',
                    width: '28px',
                    cursor: 'pointer',
                    accentColor: '#7AA5D6',
                  }}
                />

                <span style={{ fontSize: '9px', fontFamily: "'IBM Plex Mono', monospace", color: '#7C8591' }}>
                  UNITY 0dB
                </span>
              </div>

              {/* ROUTING INFO */}
              <div
                style={{
                  fontSize: '10px',
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: '#8E97A3',
                  lineHeight: 1.4,
                  borderTop: '1px dashed #2E343D',
                  paddingTop: '8px',
                }}
              >
                <div>RUTEO: {track.channel <= 2 ? 'PA Main 1-2' : track.channel === 3 ? 'PA Aux' : track.channel === 5 ? 'Salida 3 Cable' : 'In-Ear Bus'}</div>
                <div style={{ color: '#B8CF7A', marginTop: '2px' }}>LIM: -0.5 dBFS OK</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* RACK HARDWARE SPEC NOTE */}
      <div
        style={{
          background: '#1B1F24',
          border: '1px solid #2E343D',
          borderRadius: '6px',
          padding: '14px 18px',
          fontSize: '12px',
          color: '#8E97A3',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: '#D5DAE0' }}>ESPECIFICACIÓN DE INGENIERÍA EN VIVO:</strong> La pista de clic (Canal 5) es sintetizada u optimizada con un transiente de ataque de 5ms para que el baterista la reciba a través de la Salida 3 física por cable directo en la laptop FOH sin jitter de paquetes de red.
      </div>
    </div>
  )
}
