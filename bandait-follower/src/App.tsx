import { useState } from 'react'
import StageView from './views/StageView'
import ConnectView from './views/ConnectView'

export type AppView = 'connect' | 'stage'

function App() {
  const [view, setView] = useState<AppView>('connect')
  const [sessionId, setSessionId] = useState('')

  const handleConnect = (sid: string) => {
    setSessionId(sid)
    setView('stage')
  }

  return (
    <div className="app-container">
      {view === 'connect' && <ConnectView onConnect={handleConnect} />}
      {view === 'stage' && <StageView sessionId={sessionId} />}
    </div>
  )
}

export default App
