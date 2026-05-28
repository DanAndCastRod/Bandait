import { useState, useEffect, useCallback } from 'react';
import { Monitor, BookOpen, Sliders, Settings, Wifi, WifiOff } from 'lucide-react';
import { socketService, type SessionState, type Song } from './services/socketService';
import TransportBar from './components/TransportBar';
import StageView from './components/StageView';
import LibraryView from './components/LibraryView';
import MixerPanel from './components/MixerPanel';
import './styles/global.css';

// Datos de ejemplo para desarrollo
const DEMO_SONGS: Song[] = [
  {
    id: 'song_01',
    title: 'Medianoche en Pereira',
    artist: 'Bandait',
    bpm: 124,
    key: 'Am',
    duration: 245,
    segments: [
      { label: 'Intro', bars: 8 },
      { label: 'Verso A', bars: 16 },
      { label: 'Coro', bars: 16 },
      { label: 'Puente', bars: 8 },
    ],
    lyrics: [
      { time: 0, text: '...' },
      { time: 12.5, text: 'Las luces de la ciudad se apagan' },
      { time: 18.2, text: 'Y solo queda el eco de tu voz' },
      { time: 24.0, text: 'Medianoche en Pereira' },
      { time: 30.5, text: 'Donde el viento nos encontró' },
      { time: 42.0, text: 'Verso 2: Caminamos sin dirección' },
    ],
  },
  {
    id: 'song_02',
    title: 'Ritmo de Calle',
    artist: 'Bandait',
    bpm: 128,
    key: 'Dm',
    duration: 198,
    segments: [
      { label: 'Intro', bars: 4 },
      { label: 'Verso', bars: 16 },
      { label: 'Coro', bars: 16 },
    ],
    lyrics: [
      { time: 0, text: '...' },
      { time: 8.0, text: 'El ritmo de la calle nos llama' },
      { time: 14.5, text: 'Y la noche apenas comienza' },
      { time: 21.0, text: 'Bailamos sin preocupación' },
    ],
  },
  {
    id: 'song_03',
    title: 'Desde Lejos',
    artist: 'Bandait',
    bpm: 95,
    key: 'G',
    duration: 312,
    segments: [
      { label: 'Intro', bars: 8 },
      { label: 'Verso A', bars: 16 },
      { label: 'Verso B', bars: 16 },
      { label: 'Coro', bars: 24 },
      { label: 'Outro', bars: 8 },
    ],
    lyrics: [
      { time: 0, text: '...' },
      { time: 15.0, text: 'Desde lejos te observo' },
      { time: 22.5, text: 'Y siento que estás cerca' },
      { time: 30.0, text: 'Aunque el mundo nos separa' },
    ],
  },
];

type Tab = 'stage' | 'library' | 'mixer' | 'settings';

export default function App() {
  const [connected, setConnected] = useState(false);
  const [currentTab, setCurrentTab] = useState<Tab>('stage');
  const [sessionState, setSessionState] = useState<SessionState>({
    sessionId: 'default',
    leaderIp: 'localhost',
    status: 'IDLE',
    currentSongId: null,
    nextEventTimestamp: 0,
    bpm: 120,
    currentTime: 0,
    currentBeat: 0,
  });
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [songs] = useState<Song[]>(DEMO_SONGS);

  // Conectar al líder
  useEffect(() => {
    const leaderUrl = import.meta.env.VITE_LEADER_URL || 'http://localhost:4040';
    socketService.connect(leaderUrl);

    const unsubState = socketService.onStateUpdate((state) => {
      setSessionState(state);
    });

    const unsubBeat = socketService.onBeat((beat, bpm) => {
      setSessionState((prev) => ({
        ...prev,
        currentBeat: beat,
        bpm,
      }));
    });

    const unsubConnect = socketService.onConnect(() => {
      setConnected(true);
    });

    const unsubDisconnect = socketService.onDisconnect(() => {
      setConnected(false);
    });

    return () => {
      unsubState();
      unsubBeat();
      unsubConnect();
      unsubDisconnect();
      socketService.disconnect();
    };
  }, []);

  // Actualizar canción actual cuando cambia en el estado
  useEffect(() => {
    if (sessionState.currentSongId) {
      const song = songs.find((s) => s.id === sessionState.currentSongId);
      if (song) setCurrentSong(song);
    }
  }, [sessionState.currentSongId, songs]);

  const handleSelectSong = useCallback((song: Song) => {
    setCurrentSong(song);
    setSessionState((prev) => ({
      ...prev,
      currentSongId: song.id,
      bpm: song.bpm,
    }));
  }, []);

  const handleBpmChange = useCallback((bpm: number) => {
    setSessionState((prev) => ({ ...prev, bpm }));
  }, []);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'stage', label: 'Escenario', icon: <Monitor size={18} /> },
    { id: 'library', label: 'Biblioteca', icon: <BookOpen size={18} /> },
    { id: 'mixer', label: 'Mezcladora', icon: <Sliders size={18} /> },
    { id: 'settings', label: 'Configuración', icon: <Settings size={18} /> },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    >
      {/* Transporte */}
      <TransportBar
        bpm={sessionState.bpm}
        isPlaying={sessionState.status === 'PLAYING'}
        isRecording={false}
        currentTime={sessionState.currentTime}
        currentBeat={sessionState.currentBeat}
        onBpmChange={handleBpmChange}
      />

      {/* Main area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <nav
          style={{
            width: '64px',
            background: 'var(--bg-surface)',
            borderRight: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '12px 0',
            gap: '8px',
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              style={{
                width: '48px',
                height: '48px',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                background: currentTab === tab.id ? 'var(--accent-active)' : 'transparent',
                color: currentTab === tab.id ? 'var(--bg-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                transition: 'all 0.15s ease',
                fontSize: '10px',
              }}
              title={tab.label}
            >
              {tab.icon}
              <span style={{ fontSize: '9px', fontWeight: '600' }}>{tab.label.slice(0, 4)}</span>
            </button>
          ))}

          {/* Status indicator */}
          <div style={{ marginTop: 'auto', marginBottom: '12px' }}>
            {connected ? (
              <Wifi size={18} color="var(--accent-success)" />
            ) : (
              <WifiOff size={18} color="var(--accent-danger)" />
            )}
          </div>
        </nav>

        {/* Content */}
        <main style={{ flex: 1, overflow: 'hidden' }}>
          {currentTab === 'stage' && (
            <StageView
              currentSong={currentSong}
              currentBeat={sessionState.currentBeat}
              isPlaying={sessionState.status === 'PLAYING'}
            />
          )}

          {currentTab === 'library' && (
            <LibraryView
              songs={songs}
              currentSongId={sessionState.currentSongId}
              onSelectSong={handleSelectSong}
            />
          )}

          {currentTab === 'mixer' && (
            <div style={{ padding: '20px', height: '100%', overflow: 'auto' }}>
              <MixerPanel />
            </div>
          )}

          {currentTab === 'settings' && (
            <div
              style={{
                padding: '40px',
                maxWidth: '600px',
                margin: '0 auto',
              }}
            >
              <h2
                style={{
                  fontSize: '24px',
                  fontWeight: 'bold',
                  marginBottom: '24px',
                  color: 'var(--text-primary)',
                }}
              >
                Configuración
              </h2>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                }}
              >
                <div
                  style={{
                    padding: '16px',
                    background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <h3 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '8px' }}>
                    Conexión
                  </h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    Estado: {connected ? 'Conectado al líder' : 'Desconectado'}
                  </p>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    URL: {import.meta.env.VITE_LEADER_URL || 'http://localhost:4040'}
                  </p>
                </div>

                <div
                  style={{
                    padding: '16px',
                    background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <h3 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '8px' }}>
                    Sesión
                  </h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    ID: {sessionState.sessionId}
                  </p>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    Estado: {sessionState.status}
                  </p>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* Mixer sidebar (visible en desktop) */}
        <aside
          style={{
            width: '280px',
            borderLeft: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
            overflow: 'auto',
          }}
        >
          <MixerPanel />
        </aside>
      </div>
    </div>
  );
}
