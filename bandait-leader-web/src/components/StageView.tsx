import { useEffect, useState } from 'react';

interface StageViewProps {
  currentSong: {
    title: string;
    artist: string;
    bpm: number;
    lyrics?: Array<{ time: number; text: string }>;
    segments: Array<{ label: string; bars: number }>;
  } | null;
  currentBeat: number;
  isPlaying: boolean;
}

export default function StageView({ currentSong, currentBeat, isPlaying }: StageViewProps) {
  const [currentLyricIndex, setCurrentLyricIndex] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    if (!isPlaying) {
      setElapsedTime(0);
      setCurrentLyricIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 0.1);
    }, 100);

    return () => clearInterval(interval);
  }, [isPlaying]);

  useEffect(() => {
    if (!currentSong || !isPlaying) return;

    const songLyrics = currentSong.lyrics || [];
    const currentLyric = songLyrics.findIndex(
      (lyric, index) => {
        const nextLyric = songLyrics[index + 1];
        return elapsedTime >= lyric.time && (!nextLyric || elapsedTime < nextLyric.time);
      }
    );

    if (currentLyric !== -1 && currentLyric !== currentLyricIndex) {
      setCurrentLyricIndex(currentLyric);
    }
  }, [elapsedTime, currentSong, currentLyricIndex, isPlaying]);

  if (!currentSong) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-secondary)',
          gap: '16px',
        }}
      >
        <div style={{ fontSize: '48px', opacity: 0.3 }}>🎵</div>
        <div style={{ fontSize: '18px' }}>Sin canción cargada</div>
        <div style={{ fontSize: '14px', opacity: 0.5 }}>Selecciona una canción desde la biblioteca</div>
      </div>
    );
  }

  const lyrics = currentSong.lyrics || [];
  const currentLyric = lyrics[currentLyricIndex];
  const nextLyric = lyrics[currentLyricIndex + 1];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '40px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Beat flash overlay */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          border: `4px solid ${currentBeat === 1 ? 'var(--accent-success)' : 'transparent'}`,
          borderRadius: 'var(--radius-lg)',
          pointerEvents: 'none',
          transition: 'border-color 0.1s ease',
          opacity: isPlaying ? 1 : 0,
        }}
      />

      {/* Header: Título y BPM */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '40px',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 'clamp(24px, 4vw, 48px)',
              fontWeight: 'bold',
              color: 'var(--text-primary)',
              marginBottom: '8px',
              lineHeight: 1.2,
            }}
          >
            {currentSong.title}
          </h1>
          <p
            style={{
              fontSize: 'clamp(14px, 2vw, 20px)',
              color: 'var(--text-secondary)',
            }}
          >
            {currentSong.artist}
          </p>
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'clamp(36px, 5vw, 72px)',
            fontWeight: 'bold',
            color: 'var(--accent-active)',
            textAlign: 'right',
          }}
        >
          {currentSong.bpm}
          <span
            style={{
              fontSize: 'clamp(12px, 1.5vw, 18px)',
              color: 'var(--text-secondary)',
              marginLeft: '8px',
            }}
          >
            BPM
          </span>
        </div>
      </div>

      {/* Beat indicators */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          justifyContent: 'center',
          marginBottom: '40px',
        }}
      >
        {[1, 2, 3, 4].map((beat) => (
          <div
            key={beat}
            style={{
              width: beat === 1 ? '20px' : '14px',
              height: beat === 1 ? '20px' : '14px',
              borderRadius: '50%',
              background: currentBeat === beat
                ? beat === 1
                  ? 'var(--accent-success)'
                  : 'var(--accent-active)'
                : 'var(--bg-elevated)',
              border: `3px solid ${currentBeat === beat
                ? beat === 1 ? 'var(--accent-success)' : 'var(--accent-active)'
                : 'var(--border-subtle)'}`,
              transition: 'all 0.1s ease',
              boxShadow: currentBeat === beat
                ? `0 0 20px ${beat === 1 ? 'var(--accent-success)' : 'var(--accent-active)'}`
                : 'none',
            }}
          />
        ))}
      </div>

      {/* Letra actual */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
          gap: '24px',
        }}
      >
        {currentLyric && (
          <p
            style={{
              fontSize: 'clamp(24px, 5vw, 48px)',
              fontWeight: 'bold',
              color: 'var(--text-primary)',
              lineHeight: 1.4,
              transition: 'all 0.3s ease',
              textWrap: 'balance',
            }}
          >
            {currentLyric.text}
          </p>
        )}

        {nextLyric && (
          <p
            style={{
              fontSize: 'clamp(16px, 3vw, 24px)',
              color: 'var(--text-secondary)',
              opacity: 0.5,
              transition: 'all 0.3s ease',
            }}
          >
            {nextLyric.text}
          </p>
        )}
      </div>

      {/* Secciones de la canción */}
      {currentSong.segments.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '8px',
            justifyContent: 'center',
            flexWrap: 'wrap',
            marginTop: '24px',
          }}
        >
          {currentSong.segments.map((segment, index) => (
            <span
              key={index}
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '1px',
              }}
            >
              {segment.label} ({segment.bars}b)
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
