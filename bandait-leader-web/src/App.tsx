import React, { lazy, Suspense, useEffect, useState } from 'react'
import { HubProvider } from './context/HubContext'
import { GlobalAudioProvider } from './context/GlobalAudioContext'
import { useHub } from './context/hubContextCore'
import { AuthScreen } from './components/AuthScreen'
import { HubShell } from './components/shell/HubShell'
import type { HubView, SongFocusRequest, SongsSegment } from './components/shell/hubViews'
import { MiniPlayer } from './components/MiniPlayer'
import { SongUniverseBar } from './components/SongUniverseBar'
import { MobileWidgetTray, type MobileWidgetId } from './components/widgets/MobileWidgetTray'
import { useGlobalAudio, type AudioView } from './context/globalAudioContextCore'
import { PlaylistsHubView } from './views/PlaylistsHubView'
import { BandMembersHubView } from './views/BandMembersHubView'
import { SongsStemsHubView } from './views/SongsStemsHubView'
import { RehearsalHubView } from './views/RehearsalHubView'
import { SettingsHubView } from './views/SettingsHubView'
import { syncMediaSession } from './services/mediaSessionSync'
import { studioEnabled } from './services/studio/flag'
import { colors, ghostButton, mono, primaryButton, radius } from './components/hubStyles'
import './styles/global.css'

const STUDIO_ENABLED = studioEnabled()
/** El Estudio se carga aparte: sin el interruptor, su codigo no entra en el arranque del Hub. */
const StudioHubView = lazy(() => import('./views/StudioHubView').then((module) => ({ default: module.StudioHubView })))

function readInitialUrlLaunch(): { view: HubView; widget: MobileWidgetId | null } {
  try {
    const p = new URLSearchParams(window.location.search)
    const rawView = p.get('view')
    const validViews: readonly HubView[] = ['studio', 'rehearsal', 'songs', 'setlists', 'band', 'settings']
    const view: HubView =
      rawView && (validViews as readonly string[]).includes(rawView) && (rawView !== 'studio' || STUDIO_ENABLED)
        ? (rawView as HubView)
        : 'setlists'
    const rawWidget = p.get('widget')
    const validWidgets: readonly MobileWidgetId[] = ['tuner', 'metronome', 'xypad', 'recorder', 'ab']
    let widget: MobileWidgetId | null =
      rawWidget && (validWidgets as readonly string[]).includes(rawWidget) ? (rawWidget as MobileWidgetId) : null
    if (!widget && p.get('quick') === 'record') widget = 'recorder'
    return { view, widget }
  } catch {
    return { view: 'setlists', widget: null }
  }
}

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

/**
 * Quita `view`, `widget` y `quick` de la URL una vez leidos: si se quedaran, recargar la pagina
 * volveria a abrir la vista o el widget del acceso directo aunque el usuario ya se hubiera ido.
 */
function clearLaunchParams(): void {
  try {
    const url = new URL(window.location.href)
    let changed = false
    for (const key of ['view', 'widget', 'quick']) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key)
        changed = true
      }
    }
    if (changed) window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // Sin History API: no pasa nada grave, solo se reabre al recargar.
  }
}

const HubMainContent: React.FC = () => {
  const { user, cloud, initialSyncBlocking, syncStatus, retrySync, continueOffline, logout, activeSongId } = useHub()
  /** Motor de audio global: lo que suena sigue sonando al cambiar de vista (mini reproductor). */
  const globalAudio = useGlobalAudio()
  const [initialLaunch] = useState(readInitialUrlLaunch)
  useEffect(() => {
    clearLaunchParams()
  }, [])
  const [view, setView] = useState<HubView>(initialLaunch.view)
  /** Segmento de Canciones y Stems; se recuerda mientras dure la sesion. */
  const [songsSegment, setSongsSegment] = useState<SongsSegment>('library')
  /** Cancion a abrir en el editor de la LIBRERIA (pedido desde ENSAYO); se olvida al cambiar de vista. */
  const [editSongRequest, setEditSongRequest] = useState<string | null>(null)
  /**
   * Salto explicito de la barra del Universo a ENSAYO o STEMS con la cancion activa. Navegar de
   * otra forma lo olvida: esas vistas retoman entonces lo que suena en el reproductor global.
   */
  const [songFocus, setSongFocus] = useState<SongFocusRequest | null>(null)
  const selectView = (next: HubView) => {
    setEditSongRequest(null)
    setSongFocus(null)
    setView(next)
  }
  const navigateUniverse = (nextView: HubView, nextSeg?: SongsSegment) => {
    setEditSongRequest(null)
    const wantsSong = nextView === 'rehearsal' || (nextView === 'songs' && nextSeg === 'stems')
    setSongFocus(wantsSong && activeSongId ? { songId: activeSongId, nonce: Date.now() } : null)
    if (nextSeg) setSongsSegment(nextSeg)
    setView(nextView)
  }
  const changeSongsSegment = (next: SongsSegment) => {
    setSongFocus(null)
    setSongsSegment(next)
  }
  /** "Abrir pistas" de Ensayo y la CTA "+ Subir o separar audio": Canciones y Stems > STEMS Y PISTAS. */
  const openStems = () => {
    setEditSongRequest(null)
    setSongFocus(null)
    setSongsSegment('stems')
    setView('songs')
  }

  useEffect(() => {
    syncMediaSession(globalAudio.nowPlaying, {
      toggle: globalAudio.toggle,
      stop: globalAudio.stop,
    })
  }, [globalAudio.nowPlaying, globalAudio.toggle, globalAudio.stop])

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
        <>
          {showMiniPlayer && (
            <MiniPlayer
              nowPlaying={nowPlaying}
              onToggle={globalAudio.toggle}
              onOpenStudio={STUDIO_ENABLED ? () => selectView('studio') : undefined}
            />
          )}
          <MobileWidgetTray
            initialWidget={initialLaunch.widget}
            offsetBottomPx={view === 'studio' || showMiniPlayer ? 128 : 68}
            onOpenStudio={() => selectView('studio')}
          />
        </>
      }
    >
      <SongUniverseBar
        currentView={view}
        currentSegment={songsSegment}
        studioEnabled={STUDIO_ENABLED}
        onNavigate={navigateUniverse}
      />
      {/*
        Sin Escenario a proposito: el Hub se sirve por HTTPS (https://bandait.releven.cc/hub/) y una
        pagina HTTPS no puede abrir ws:// hacia un lider en la LAN (el navegador lo bloquea como
        contenido mixto). El control de transporte del director vive en la PWA servida desde la LAN.
      */}
      {view === 'setlists' && <PlaylistsHubView />}
      {view === 'songs' && (
        <SongsStemsHubView segment={songsSegment} onSegmentChange={changeSongsSegment} openSongId={editSongRequest} focusRequest={songFocus} />
      )}
      {view === 'rehearsal' && (
        <RehearsalHubView
          onOpenTracks={openStems}
          focusRequest={songFocus}
          onEditSong={(songId) => {
            setEditSongRequest(songId)
            setSongFocus(null)
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
