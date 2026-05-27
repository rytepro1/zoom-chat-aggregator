import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * AuthPage — shared shell for the login + signup + forgot-password flows.
 * Defaults to login; mode is picked via `?mode=signup` query param or
 * the in-page toggle.
 *
 * Designed to be the FIRST screen a brand-new user (or a client who just
 * opened the .app on their machine) sees. Minimal copy, clear primary
 * action, signup link.
 */
export default function AuthPage() {
  const [searchParams] = useSearchParams();
  const initialMode = searchParams.get('mode') === 'signup' ? 'signup' : 'login';
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [resetSent, setResetSent] = useState(false);
  const { login, signup, requestPasswordReset } = useAuth();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setLocalError(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        await signup({ email, password, orgName: orgName || undefined });
      } else {
        await login({ email, password });
      }
      navigate('/', { replace: true });
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onForgot = async () => {
    setLocalError(null);
    if (!email) {
      setLocalError('Enter your email above first.');
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset(email);
      setResetSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={shell}>
      <div style={card}>
        <h1 style={title}>ZoomChat</h1>
        <p style={subtitle}>
          {mode === 'signup' ? 'Create your account' : 'Sign in to your account'}
        </p>

        <form onSubmit={submit} style={{ marginTop: 24 }}>
          {mode === 'signup' && (
            <Field
              label="Organization name (optional)"
              type="text"
              value={orgName}
              onChange={setOrgName}
              placeholder="My Production Co."
              autoComplete="organization"
            />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder={mode === 'signup' ? 'at least 8 characters' : ''}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'signup' ? 8 : undefined}
          />

          {(localError || resetSent) && (
            <div style={resetSent ? noticeOk : noticeErr}>
              {resetSent
                ? "If that email exists, we've sent a reset link. Check your inbox."
                : localError}
            </div>
          )}

          <button type="submit" disabled={busy} style={primaryBtn}>
            {busy ? '…' : (mode === 'signup' ? 'Create account' : 'Sign in')}
          </button>

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <button
              type="button"
              onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setLocalError(null); setResetSent(false); }}
              style={linkBtn}
            >
              {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
            </button>
            {mode === 'login' && (
              <button type="button" onClick={onForgot} style={linkBtn}>
                Forgot password?
              </button>
            )}
          </div>
        </form>

        {mode === 'signup' && (
          <p style={hint}>
            New accounts start with a 30-minute free trial (1 concurrent bot).
            Upgrade to Solo ($49/mo) to keep going.
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, type, value, onChange, placeholder, required, minLength, autoComplete }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={fieldLabel}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        style={fieldInput}
      />
    </label>
  );
}

// --- styles ---

const shell = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'radial-gradient(circle at top, #1e293b, #0f172a)',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
  color: '#f1f5f9',
  padding: 24,
};
const card = {
  width: '100%',
  maxWidth: 420,
  background: '#1f2937',
  borderRadius: 16,
  padding: 36,
  boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
  border: '1px solid rgba(255,255,255,0.06)',
};
const title = { fontSize: 28, fontWeight: 700, margin: 0, color: '#3b82f6' };
const subtitle = { fontSize: 14, color: '#94a3b8', margin: '6px 0 0' };
const fieldLabel = { display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 };
const fieldInput = {
  width: '100%',
  padding: '10px 12px',
  background: '#0f172a',
  color: '#f1f5f9',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  fontSize: 15,
  outline: 'none',
  boxSizing: 'border-box',
};
const primaryBtn = {
  width: '100%',
  marginTop: 8,
  padding: '12px 16px',
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};
const linkBtn = {
  background: 'transparent',
  border: 'none',
  color: '#60a5fa',
  cursor: 'pointer',
  padding: 0,
  fontSize: 13,
  textAlign: 'left',
};
const noticeErr = {
  marginTop: 12,
  padding: '10px 12px',
  background: 'rgba(239,68,68,0.1)',
  border: '1px solid rgba(239,68,68,0.3)',
  color: '#fca5a5',
  borderRadius: 8,
  fontSize: 13,
};
const noticeOk = {
  marginTop: 12,
  padding: '10px 12px',
  background: 'rgba(34,197,94,0.1)',
  border: '1px solid rgba(34,197,94,0.3)',
  color: '#86efac',
  borderRadius: 8,
  fontSize: 13,
};
const hint = {
  marginTop: 24,
  paddingTop: 18,
  borderTop: '1px solid rgba(255,255,255,0.08)',
  fontSize: 12,
  color: '#94a3b8',
  lineHeight: 1.5,
};
