import React, { lazy, Suspense, useState } from 'react'
import { HubProvider } from './context/HubContext'
import { GlobalAudioProvider } from './context/GlobalAudioContext'
import { useHub } from './context/hubContextCore'
import { AuthScreen } from './components/AuthScreen'
import { HubShell } from './components/shell/HubShell'
import type { HubView, SongsSegment } from './components/shell/hubViews'
import { MiniPlayer } from './components/MiniPlayer'
import { useGlobalAudio, type AudioView } from './context/globalAudioContextCore'
import { PlaylistsHubView } from './views/PlaylistsHubView'
import { BandMembersHubView } from './views/BandMembersHubView'
import { SongsStemsHubView } from './views/SongsStemsHubView'
import { RehearsalHubView } from './views/RehearsalHubView'
import { SettingsHubView } from './views/SettingsHubView'
import { studioEnabled } from './services/studio/flag'
import { colors, ghostButton, mono, primaryButton, radius } from './components/hubStyles'
import './styles/global.css'

const STUDIO_ENABLED = studioEnabled()
/** El Estudio se carga aparte: sin el interruptor, su codigo no entra en el arranque del Hub. */
const StudioHubView = lazy(() => import('./views/StudioHubView').then((module) => ({ default: module.StudioHubView })))

const CenteredPanel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      minHeight: '100dvh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      padding: '24px 16px',
      boxSizing: 'border-box',
    }}
  >
    <div
      style={{
        width: '100%',
        maxWidth: '460px',
        background: colors.card,
        borderRadius: radius.card,
        boxShadow: 'var(--b-shadow)',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        fontFamily: mono,
        fontSize: '12px',
        color: colors.muted,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  </div>
)

/** Vista del audio global que corresponde a la vista del shell (null si no tiene transporte propio). */
function viewOfSource(view: HubView, segment: SongsSegment): AudioView | null {
  if (view === 'songs') return segment === 'stems' ? 'tracks' : null
  if (view === 'rehearsal' || view === 'studio') return view
  return null
}

const HubMainContent: React.FC = () => {
  const { user, cloud, initialSyncBlocking, syncStatus, retrySync, continueOffline, logout } = useHub()
  /** Motor de audio global: lo que suena sigue sonando al cambiar de vista (mini reproductor). */
  const globalAudio = useGlobalAudio()
  const [view, setView] = useState<HubView>('setlists')
  /** Segmento de Canciones y Stems; se recuerda mientras dure la sesion. */
  const [songsSegment, setSongsSegment] = useState<SongsSegment>('library')
  /** Cancion a abrir en el editor de la LIBRERIA (pedido desde ENSAYO); se olvida al cambiar de vista. */
  const [editSongRequest, setEditSongRequest] = useState<string | null>(null)
  const selectView = (next: HubView) => {
    setEditSongRequest(null)
    setView(next)
  }
  /** "Abrir pistas" de Ensayo y la CTA "+ Subir o separar audio": Canciones y Stems > STEMS Y PISTAS. */
  const openStems = () => {
    setEditSongRequest(null)
    setSongsSegment('stems')
    setView('songs')
  }

  // Cuenta de nube guardada: esperar a que Supabase confirme la sesion antes de mostrar datos.
  if (user?.authProvider === 'supabase' && !cloud.authReady) {
    return (
      <CenteredPanel>
        <strong style={{ color: colors.text }}>RESTAURANDO SESIÓN DE NUBE...</strong>
        <span>Verificando tu sesión de Supabase.</span>
      </CenteredPanel>
    )
  }

  if (!user) {
    return <AuthScreen />
  }

  // Cuenta de nube sin copia local en este navegador: no se muestra (ni se edita) nada hasta
  // tener la version de la nube, para no partir de un workspace vacio que luego compita con ella.
  if (initialSyncBlocking) {
    return (
      <CenteredPanel>
        <strong style={{ color: colors.text }} data-testid="initial-sync">
          DESCARGANDO TU WORKSPACE DE LA NUBE...
        </strong>
        <span>{syncStatus.state === 'synced' ? 'Listo.' : syncStatus.detail}</span>
        {syncStatus.state === 'error' && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={retrySync}
              className="stx-btn"
              style={primaryButton()}
            >
              REINTENTAR
            </button>
            <button
              type="button"
              onClick={continueOffline}
              className="stx-btn"
              style={ghostButton}
            >
              TRABAJAR SIN CONEXIÓN
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="stx-btn"
              style={{ ...ghostButton, background: 'transparent', color: 'var(--b-danger-text)' }}
            >
              SALIR
            </button>
          </div>
        )}
        {syncStatus.state === 'error' && (
          <span>
            Sin conexión: si trabajas sin conexión y tus cambios terminan siendo más recientes que los de la nube, la versión
            de la nube se guardará como respaldo local antes de reemplazarla.
          </span>
        )}
      </CenteredPanel>
    )
  }

  // Mini reproductor alimentado por el GlobalAudioProvider. No se muestra en la vista de origen de
  // lo que suena (alli ya esta su propio transporte) ni en el Estudio.
  const nowPlaying = globalAudio.nowPlaying
  const showMiniPlayer = nowPlaying !== null && view !== 'studio' && nowPlaying.view !== viewOfSource(view, songsSegment)

  return (
    <HubShell
      view={view}
      onSelectView={selectView}
      onUploadAudio={openStems}
      hasMiniPlayer={showMiniPlayer}
      overlay={
        showMiniPlayer && (
          <MiniPlayer
            nowPlaying={nowPlaying}
            onToggle={globalAudio.toggle}
            onOpenStudio={STUDIO_ENABLED ? () => selectView('studio') : undefined}
          />
        )
      }
    >
      {/*
        Sin Escenario a proposito: el Hub se sirve por HTTPS (https://bandait.releven.cc/hub/) y una
        pagina HTTPS no puede abrir ws:// hacia un lider en la LAN (el navegador lo bloquea como
        contenido mixto). El control de transporte del director vive en la PWA servida desde la LAN.
      */}
      {view === 'setlists' && <PlaylistsHubView />}
      {view === 'songs' && <SongsStemsHubView segment={songsSegment} onSegmentChange={setSongsSegment} openSongId={editSongRequest} />}
      {view === 'rehearsal' && (
        <RehearsalHubView
          onOpenTracks={openStems}
          onEditSong={(songId) => {
            setEditSongRequest(songId)
            setSongsSegment('library')
            setView('songs')
          }}
        />
      )}
      {/* Estudio Bandait: solo con el interruptor (services/studio/flag.ts). */}
      {view === 'studio' && STUDIO_ENABLED && (
        <Suspense fallback={<p style={{ padding: '24px', fontFamily: mono, fontSize: '12px', color: colors.muted }}>Cargando el Estudio...</p>}>
          <StudioHubView />
        </Suspense>
      )}
      {view === 'band' && <BandMembersHubView />}
      {view === 'settings' && <SettingsHubView />}
    </HubShell>
  )
}

export default function App() {
  return (
    <HubProvider>
      <GlobalAudioProvider>
        <HubMainContent />
      </GlobalAudioProvider>
    </HubProvider>
  )
}
