import { useState, useEffect } from 'react'
import StageView from './views/StageView'
import ConnectView from './views/ConnectView'
import LibraryView from './views/LibraryView'
import SettingsView, { ThemeStyle } from './views/SettingsView'

export type AppView = 'connect' | 'stage' | 'library' | 'settings'

function App() {
  const [view, setView] = useState<AppView>('connect')
  const [previousView, setPreviousView] = useState<AppView>('connect')
  const [sessionId, setSessionId] = useState('')

  // Initialize theme on client (Swiss Bauhaus Lab as default)
  useEffect(() => {
    const savedTheme = (localStorage.getItem('bandait_theme') as ThemeStyle) || 'theme-swiss'
    document.body.className = savedTheme
  }, [])

  const handleConnect = (sid: string) => {
    setSessionId(sid)
    setView('stage')
  }

  const handleToLibrary = () => {
    setPreviousView(view)
    setView('library')
  }

  const handleToSettings = () => {
    setPreviousView(view)
    setView('settings')
  }

  const handleToStage = () => setView('stage')

  const handleBackToConnect = () => {
    setSessionId('')
    setView('connect')
  }

  const handleSettingsBack = () => {
    setView(previousView || 'connect')
  }

  return (
    <div className="app-container">
      {view === 'connect' && (
        <ConnectView
          onConnect={handleConnect}
          onSettings={handleToSettings}
          onLibrary={handleToLibrary}
        />
      )}
      {view === 'stage' && (
        <StageView
          sessionId={sessionId}
          onLibrary={handleToLibrary}
          onSettings={handleToSettings}
          onDisconnect={handleBackToConnect}
        />
      )}
      {view === 'library' && (
        <LibraryView
          onSelectSetlist={handleToStage}
          onBack={handleSettingsBack}
        />
      )}
      {view === 'settings' && (
        <SettingsView
          onBack={handleSettingsBack}
        />
      )}
    </div>
  )
}

export default App
