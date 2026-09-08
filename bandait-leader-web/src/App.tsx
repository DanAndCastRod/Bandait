import React, { useState } from 'react'
import { HubProvider, useHub } from './context/HubContext'
import { AuthScreen } from './components/AuthScreen'
import { HubNavbar, type HubTab } from './components/HubNavbar'
import { PlaylistsHubView } from './views/PlaylistsHubView'
import { StemsHubView } from './views/StemsHubView'
import { BandMembersHubView } from './views/BandMembersHubView'
import { EquipmentHubView } from './views/EquipmentHubView'
import './styles/global.css'

const HubMainContent: React.FC = () => {
  const { user } = useHub()
  const [activeTab, setActiveTab] = useState<HubTab>('playlists')

  // If user is not authenticated via Google or Demo, show the Auth Portal
  if (!user) {
    return <AuthScreen />
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
      }}
    >
      {/* TOP HEADER NAVIGATION & MULTI-BAND SWITCHER */}
      <HubNavbar activeTab={activeTab} onSelectTab={setActiveTab} />

      {/* WORKSPACE CONTENT AREA */}
      <main
        style={{
          flex: 1,
          overflowY: 'auto',
          background: 'var(--bg-primary)',
        }}
      >
        {activeTab === 'playlists' && <PlaylistsHubView />}
        {activeTab === 'stems' && <StemsHubView />}
        {activeTab === 'members' && <BandMembersHubView />}
        {activeTab === 'equipment' && <EquipmentHubView />}
      </main>
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
