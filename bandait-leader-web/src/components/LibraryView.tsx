import { useState } from 'react';
import { Music, Clock, KeyRound, Loader } from 'lucide-react';
import { socketService } from '../services/socketService';

interface Song {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  key: string;
  duration: number;
  segments: Array<{ label: string; bars: number }>;
}

interface LibraryViewProps {
  songs: Song[];
  currentSongId: string | null;
  onSelectSong: (song: Song) => void;
}

export default function LibraryView({ songs, currentSongId, onSelectSong }: LibraryViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterKey, setFilterKey] = useState<string | null>(null);

  const filteredSongs = songs.filter((song) => {
    const matchesSearch = song.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      song.artist.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesKey = filterKey ? song.key === filterKey : true;
    return matchesSearch && matchesKey;
  });

  const uniqueKeys = [...new Set(songs.map((s) => s.key))];

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '20px',
        gap: '16px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h2
          style={{
            fontSize: '20px',
            fontWeight: 'bold',
            color: 'var(--text-primary)',
          }}
        >
          Biblioteca
        </h2>
        <span
          style={{
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          {filteredSongs.length} canciones
        </span>
      </div>

      {/* Search */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
        }}
      >
        <input
          type="text"
          placeholder="Buscar canción o artista..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            flex: 1,
            padding: '10px 14px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
            fontSize: '14px',
            outline: 'none',
          }}
        />
      </div>

      {/* Key filters */}
      <div
        style={{
          display: 'flex',
          gap: '6px',
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={() => setFilterKey(null)}
          style={{
            padding: '4px 10px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
            background: filterKey === null ? 'var(--accent-active)' : 'var(--bg-elevated)',
            color: filterKey === null ? 'var(--bg-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '600',
          }}
        >
          Todas
        </button>
        {uniqueKeys.map((key) => (
          <button
            key={key}
            onClick={() => setFilterKey(key === filterKey ? null : key)}
            style={{
              padding: '4px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              background: filterKey === key ? 'var(--accent-active)' : 'var(--bg-elevated)',
              color: filterKey === key ? 'var(--bg-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: '600',
            }}
          >
            {key}
          </button>
        ))}
      </div>

      {/* Song list */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        {filteredSongs.map((song) => (
          <button
            key={song.id}
            onClick={() => {
              onSelectSong(song);
              socketService.sendControl('LOAD_SONG', { songId: song.id });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '12px 16px',
              background: currentSongId === song.id
                ? 'rgba(0, 255, 255, 0.1)'
                : 'var(--bg-elevated)',
              border: `1px solid ${currentSongId === song.id
                ? 'var(--accent-active)'
                : 'var(--border-subtle)'}`,
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all 0.15s ease',
              width: '100%',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: 'var(--radius-sm)',
                background: currentSongId === song.id
                  ? 'var(--accent-active)'
                  : 'var(--bg-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: currentSongId === song.id
                  ? 'var(--bg-primary)'
                  : 'var(--text-secondary)',
                flexShrink: 0,
              }}
            >
              <Music size={18} />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: '600',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {song.title}
              </div>
              <div
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '12px',
                  marginTop: '2px',
                }}
              >
                {song.artist}
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <KeyRound size={12} />
                {song.key}
              </span>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <Clock size={12} />
                {formatDuration(song.duration)}
              </span>
              <span
                style={{
                  fontSize: '12px',
                  color: 'var(--accent-active)',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 'bold',
                }}
              >
                {song.bpm} BPM
              </span>
            </div>
          </button>
        ))}

        {filteredSongs.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: '40px',
              color: 'var(--text-secondary)',
            }}
          >
            <Loader size={32} style={{ marginBottom: '12px', opacity: 0.5 }} />
            <div>No se encontraron canciones</div>
          </div>
        )}
      </div>
    </div>
  );
}
