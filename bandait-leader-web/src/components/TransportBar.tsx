import { useState, useCallback } from 'react';
import { Play, Square, Circle, Zap } from 'lucide-react';
import { socketService } from '../services/socketService';

/*
 * NO MONTADO a proposito (ver App.tsx): el Hub se sirve por HTTPS y no puede abrir ws://
 * hacia un lider en la LAN (contenido mixto). El transporte del director vive en el
 * follower PWA. Se mantiene alineado con CONTRACT_V3 para un Hub servido desde la LAN.
 */

interface TransportBarProps {
  bpm: number;
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  currentBeat: number;
  onBpmChange: (bpm: number) => void;
}

export default function TransportBar({
  bpm,
  isPlaying,
  isRecording,
  currentTime,
  currentBeat,
  onBpmChange,
}: TransportBarProps) {
  const [tapTimes, setTapTimes] = useState<number[]>([]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const handlePlay = useCallback(() => {
    socketService.sendCommand(isPlaying ? 'STOP' : 'PLAY').catch((err: unknown) => console.warn('[Transport]', err));
  }, [isPlaying]);

  // La grabacion no existe en CONTRACT_V3: el boton queda deshabilitado (pendiente).

  const sendTempo = useCallback(
    (newBpm: number) => {
      const delta = Math.round(newBpm - bpm);
      if (delta === 0) return;
      socketService.sendCommand('TEMPO_NUDGE', { delta_bpm: delta }).catch((err: unknown) => console.warn('[Transport]', err));
    },
    [bpm]
  );

  const handleTapTempo = useCallback(() => {
    const now = Date.now();
    const newTapTimes = [...tapTimes, now].slice(-8);
    setTapTimes(newTapTimes);

    if (newTapTimes.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < newTapTimes.length; i++) {
        intervals.push(newTapTimes[i] - newTapTimes[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const newBpm = Math.round(60000 / avgInterval);
      if (newBpm >= 40 && newBpm <= 300) {
        onBpmChange(newBpm);
        sendTempo(newBpm);
      }
    }
  }, [tapTimes, onBpmChange, sendTempo]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '12px 20px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-subtle)',
        minHeight: '64px',
      }}
    >
      {/* Tiempo */}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '28px',
          fontWeight: 'bold',
          color: 'var(--text-primary)',
          minWidth: '140px',
          textAlign: 'center',
          letterSpacing: '2px',
        }}
      >
        {formatTime(currentTime)}
      </div>

      {/* Controles principales */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={handlePlay}
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            border: '2px solid var(--accent-active)',
            background: isPlaying ? 'var(--accent-active)' : 'transparent',
            color: isPlaying ? 'var(--bg-primary)' : 'var(--accent-active)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s ease',
          }}
          title={isPlaying ? 'Detener' : 'Reproducir'}
        >
          {isPlaying ? <Square size={20} /> : <Play size={20} fill="currentColor" />}
        </button>

        <button
          disabled
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            border: '2px solid var(--accent-danger)',
            background: isRecording ? 'var(--accent-danger)' : 'transparent',
            color: isRecording ? 'var(--bg-primary)' : 'var(--accent-danger)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s ease',
          }}
          title="Grabación: no existe en el contrato v3 (pendiente)"
        >
          <Circle size={20} fill={isRecording ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* Beat indicator */}
      <div
        style={{
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          padding: '0 16px',
        }}
      >
        {[1, 2, 3, 4].map((beat) => (
          <div
            key={beat}
            style={{
              width: beat === 1 ? '14px' : '10px',
              height: beat === 1 ? '14px' : '10px',
              borderRadius: '50%',
              background: currentBeat === beat
                ? beat === 1
                  ? 'var(--accent-success)'
                  : 'var(--accent-active)'
                : 'var(--bg-elevated)',
              border: currentBeat === beat
                ? `2px solid ${beat === 1 ? 'var(--accent-success)' : 'var(--accent-active)'}`
                : '2px solid var(--border-subtle)',
              transition: 'all 0.1s ease',
              boxShadow: currentBeat === beat
                ? `0 0 10px ${beat === 1 ? 'var(--accent-success)' : 'var(--accent-active)'}`
                : 'none',
            }}
          />
        ))}
      </div>

      {/* BPM */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginLeft: 'auto',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '32px',
            fontWeight: 'bold',
            color: 'var(--accent-active)',
            minWidth: '80px',
            textAlign: 'right',
          }}
        >
          {bpm}
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '1px',
          }}
        >
          BPM
        </div>

        <button
          onClick={handleTapTempo}
          style={{
            padding: '8px 12px',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            transition: 'all 0.15s ease',
          }}
          title="Tap Tempo"
        >
          <Zap size={14} />
        </button>

        <input
          type="range"
          min="40"
          max="300"
          value={bpm}
          onChange={(e) => {
            const newBpm = parseInt(e.target.value);
            onBpmChange(newBpm);
            sendTempo(newBpm);
          }}
          style={{
            width: '100px',
            accentColor: 'var(--accent-active)',
          }}
        />
      </div>
    </div>
  );
}
