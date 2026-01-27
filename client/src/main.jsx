import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App.jsx'
import DisplayView from './pages/DisplayView.jsx'
import { SettingsProvider } from './contexts/SettingsContext.jsx'
import { SocketProvider } from './contexts/SocketContext.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Main control panel */}
        <Route path="/" element={
          <SettingsProvider>
            <SocketProvider>
              <App />
            </SocketProvider>
          </SettingsProvider>
        } />
        {/* Pop-out display view for external screens */}
        <Route path="/display" element={<DisplayView />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
