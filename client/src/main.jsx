import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App.jsx'
import DisplayView from './pages/DisplayView.jsx'
import AuthPage from './pages/AuthPage.jsx'
import VerifyEmailPage from './pages/VerifyEmailPage.jsx'
import ResetPasswordPage from './pages/ResetPasswordPage.jsx'
import { SettingsProvider } from './contexts/SettingsContext.jsx'
import { SocketProvider } from './contexts/SocketContext.jsx'
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx'
import './index.css'

/**
 * RequireAuth — gate for /  and any future authenticated route.
 * - While the initial /me check is in flight, render nothing (avoids
 *   a flash of the login wall for already-signed-in users).
 * - Once we know there's no user, redirect to /signin.
 * - Otherwise render children.
 */
function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageLoading />;
  if (!user) return <Navigate to="/signin" replace />;
  return children;
}

/**
 * If the user is already signed in, /signin redirects to the app.
 * Avoids the awkward "signed-in user sees the login wall" case.
 */
function RedirectIfAuthed({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageLoading />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function FullPageLoading() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0f172a', color: '#64748b',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      Loading…
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <SettingsProvider>
          <Routes>
            {/* Public auth screens */}
            <Route path="/signin" element={<RedirectIfAuthed><AuthPage /></RedirectIfAuthed>} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />

            {/* Authenticated app */}
            <Route path="/" element={
              <RequireAuth>
                <SocketProvider>
                  <App />
                </SocketProvider>
              </RequireAuth>
            } />
            {/* Pop-out display view also requires auth (same cookie). */}
            <Route path="/display" element={
              <RequireAuth>
                <DisplayView />
              </RequireAuth>
            } />
          </Routes>
        </SettingsProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
