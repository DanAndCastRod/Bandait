import { useState } from 'react';
import { Volume2, VolumeX, Headphones } from 'lucide-react';
import { socketService } from '../services/socketService';

interface Track {
  id: number;
  name: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  level: number;
}

export default function MixerPanel() {
  const [tracks] = useState<Track[]>([
    { id: 0, name: 'Click General', volume: 0.8, pan: 0, mute: false, solo: false, level: 0 },
    { id: 1, name: 'Batería', volume: 0.7, pan: 0, mute: false, solo: false, level: 0 },
    { id: 2, name: 'Backing', volume: 0.6, pan: 0, mute: false, solo: false, level: 0 },
    { id: 3, name: 'Voz Guía', volume: 0.5, pan: 0, mute: false, solo: false, level: 0 },
  ]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-subtle)',
        minWidth: '280px',
        maxWidth: '320px',
        height: '100%',
        overflow: 'auto',
      }}
    >
      <h3
        style={{
          fontSize: '12px',
          textTransform: 'uppercase',
          letterSpacing: '2px',
          color: 'var(--text-secondary)',
          marginBottom: '8px',
        }}
      >
        Mezcladora
      </h3>

      {tracks.map((track) => (
        <div
          key={track.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '12px',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {/* Nombre */}
          <div
            style={{
              fontSize: '13px',
              fontWeight: '600',
              color: track.mute ? 'var(--text-disabled)' : 'var(--text-primary)',
            }}
          >
            {track.name}
          </div>

          {/* VU Meter */}
          <div
            style={{
              height: '6px',
              background: 'var(--bg-primary)',
              borderRadius: '3px',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: `${track.level * 100}%`,
                height: '100%',
                background: track.level > 0.9
                  ? 'var(--accent-danger)'
                  : track.level > 0.7
                    ? 'var(--accent-warning)'
                    : 'var(--accent-success)',
                transition: 'width 0.05s ease',
                borderRadius: '3px',
              }}
            />
          </div>

          {/* Fader */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="range"
              min="0"
              max="100"
              value={track.volume * 100}
              onChange={(e) => {
                const vol = parseInt(e.target.value) / 100;
                socketService.sendControl('SET_TRACK_VOLUME', { trackId: track.id, volume: vol });
              }}
              style={{
                flex: 1,
                accentColor: 'var(--accent-active)',
              }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                minWidth: '36px',
                textAlign: 'right',
              }}
            >
              {Math.round(track.volume * 100)}
            </span>
          </div>

          {/* Botones Mute/Solo */}
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              style={{
                flex: 1,
                padding: '6px',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                background: track.mute ? 'var(--accent-danger)' : 'var(--bg-primary)',
                color: track.mute ? 'var(--bg-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
              }}
              title="Silenciar"
            >
              {track.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
              MUTE
            </button>
            <button
              style={{
                flex: 1,
                padding: '6px',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                background: track.solo ? 'var(--accent-active)' : 'var(--bg-primary)',
                color: track.solo ? 'var(--bg-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
              }}
              title="Solo"
            >
              <Headphones size={12} />
              SOLO
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
