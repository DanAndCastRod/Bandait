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
        minHeight: '100dvh',
        width: '100%',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        overflowX: 'hidden',
      }}
    >
      {/* TOP HEADER NAVIGATION & MULTI-BAND SWITCHER (INCLUDES MOBILE BOTTOM BAR) */}
      <HubNavbar activeTab={activeTab} onSelectTab={setActiveTab} />

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
