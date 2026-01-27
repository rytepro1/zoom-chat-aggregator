import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { SettingsProvider } from './contexts/SettingsContext.jsx'
import { SocketProvider } from './contexts/SocketContext.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SettingsProvider>
      <SocketProvider>
        <App />
      </SocketProvider>
    </SettingsProvider>
  </React.StrictMode>,
)
