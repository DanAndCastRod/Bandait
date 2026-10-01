import React, { useState } from 'react'
import { HubProvider } from './context/HubContext'
import { useHub } from './context/hubContextCore'
import { AuthScreen } from './components/AuthScreen'
import { HubNavbar, type HubTab } from './components/HubNavbar'
import { SyncNoticeBanner } from './components/SyncNoticeBanner'
import { SupabaseConfigModal } from './components/SupabaseConfigModal'
import { PlaylistsHubView } from './views/PlaylistsHubView'
import { StemsHubView } from './views/StemsHubView'
import { BandMembersHubView } from './views/BandMembersHubView'
import { EquipmentHubView } from './views/EquipmentHubView'
import { SongsHubView } from './views/SongsHubView'
import { VoiceHubView } from './views/VoiceHubView'
import './styles/global.css'

const mono = "'IBM Plex Mono', monospace"

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
        background: '#131720',
        border: '1px solid #2a3346',
        borderRadius: '8px',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        fontFamily: mono,
        fontSize: '12px',
        color: '#94a3b8',
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  </div>
)

const HubMainContent: React.FC = () => {
  const { user, cloud, initialSyncBlocking, syncStatus, retrySync, continueOffline, logout } = useHub()
  const [activeTab, setActiveTab] = useState<HubTab>('playlists')
  const [showCloudModal, setShowCloudModal] = useState(false)

  // Cuenta de nube guardada: esperar a que Supabase confirme la sesion antes de mostrar datos.
  if (user?.authProvider === 'supabase' && !cloud.authReady) {
    return (
      <CenteredPanel>
        <strong style={{ color: '#ffffff' }}>RESTAURANDO SESIÓN DE NUBE...</strong>
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
        <strong style={{ color: '#ffffff' }} data-testid="initial-sync">
          DESCARGANDO TU WORKSPACE DE LA NUBE...
        </strong>
        <span>{syncStatus.state === 'synced' ? 'Listo.' : syncStatus.detail}</span>
        {syncStatus.state === 'error' && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={retrySync}
              style={{ background: '#0066ff', border: 'none', color: '#ffffff', borderRadius: '4px', padding: '8px 14px', cursor: 'pointer', fontFamily: mono, fontSize: '11px', fontWeight: 700 }}
            >
              REINTENTAR
            </button>
            <button
              type="button"
              onClick={continueOffline}
              style={{ background: 'transparent', border: '1px solid #2a3346', color: '#94a3b8', borderRadius: '4px', padding: '8px 14px', cursor: 'pointer', fontFamily: mono, fontSize: '11px' }}
            >
              TRABAJAR SIN CONEXIÓN
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              style={{ background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '4px', padding: '8px 14px', cursor: 'pointer', fontFamily: mono, fontSize: '11px' }}
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

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100dvh',
        width: '100%',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        overflowX: 'hidden',
      }}
    >
      {/* TOP HEADER NAVIGATION & MULTI-BAND SWITCHER (INCLUDES MOBILE BOTTOM BAR) */}
      <HubNavbar activeTab={activeTab} onSelectTab={setActiveTab} />

      <SyncNoticeBanner onOpenCloud={() => setShowCloudModal(true)} />

      {/* WORKSPACE CONTENT AREA */}
      <main
        style={{
          flex: 1,
          width: '100%',
          background: 'var(--bg-primary)',
          paddingBottom: '80px', // Prevents content from being covered by mobile bottom bar
          boxSizing: 'border-box',
        }}
      >
        {/*
          StageView, TransportBar, LibraryView y MixerPanel NO se montan a proposito: el Hub se
          sirve por HTTPS (https://bandait.releven.cc/hub/) y una pagina HTTPS no puede abrir
          ws:// hacia un lider en la LAN (el navegador lo bloquea como contenido mixto). El
          control de transporte del director vive en el follower PWA, servido desde la LAN.
        */}
        {activeTab === 'playlists' && <PlaylistsHubView />}
        {activeTab === 'songs' && <SongsHubView />}
        {activeTab === 'voice' && <VoiceHubView />}
        {activeTab === 'stems' && <StemsHubView />}
        {activeTab === 'members' && <BandMembersHubView />}
        {activeTab === 'equipment' && <EquipmentHubView />}
      </main>

      {showCloudModal && <SupabaseConfigModal onClose={() => setShowCloudModal(false)} />}
    </div>
  )
}

export default function App() {
  return (
    <HubProvider>
      <HubMainContent />
    </HubProvider>
  )
}
