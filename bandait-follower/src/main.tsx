import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { registerServiceWorkerSafely } from './services/serviceWorker'
import './styles/global.css'

// Only in production, in a secure context (HTTPS/localhost). Served by the leader
// over plain HTTP there is no service worker: skipped silently.
registerServiceWorkerSafely()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
