import { useState } from 'react'
import StageView from './views/StageView'
import ConnectView from './views/ConnectView'
import LibraryView from './views/LibraryView'

export type AppView = 'connect' | 'stage' | 'library'

function App() {
  const [view, setView] = useState<AppView>('connect')
  const [sessionId, setSessionId] = useState('')

  const handleConnect = (sid: string) => {
    setSessionId(sid)
    setView('stage')
  }

  const handleToLibrary = () => setView('library')
  const handleToStage = () => setView('stage')
  const handleBackToConnect = () => {
    setSessionId('')
    setView('connect')
  }

  return (
    <div className="app-container">
      {view === 'connect' && <ConnectView onConnect={handleConnect} />}
      {view === 'stage' && (
        <StageView
          sessionId={sessionId}
          onLibrary={handleToLibrary}
          onDisconnect={handleBackToConnect}
        />
      )}
      {view === 'library' && (
        <LibraryView
          onSelectSetlist={handleToStage}
          onBack={handleToStage}
        />
      )}
    </div>
  )
}

export default App
