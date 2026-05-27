import React, { useState } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';

/**
 * ResetPasswordPage — landing page for the link in the password-reset
 * email. Takes ?token=…, asks for a new password, POSTs to
 * /api/auth/password-reset/confirm. On success, all existing sessions
 * for the user are invalidated server-side, so they have to sign in
 * fresh with the new password.
 */
export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!token) return setError('Missing token.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Reset failed.');
      } else {
        setDone(true);
        setTimeout(() => navigate('/?mode=login', { replace: true }), 1800);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={shell}>
      <div style={card}>
        <h1 style={title}>Reset your password</h1>

        {done ? (
          <>
            <p style={{ ...msg, color: '#86efac' }}>Password updated. Redirecting to sign-in…</p>
          </>
        ) : (
          <form onSubmit={submit}>
            <label style={{ display: 'block', marginTop: 18 }}>
              <span style={lbl}>New password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="at least 8 characters"
                minLength={8}
                required
                autoFocus
                style={input}
              />
            </label>
            {error && <div style={errBox}>{error}</div>}
            <button type="submit" disabled={busy} style={btn}>
              {busy ? '…' : 'Set new password'}
            </button>
            <p style={msg}>
              <Link to="/" style={{ color: '#60a5fa' }}>Back to sign-in</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

const shell = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at top, #1e293b, #0f172a)', color: '#f1f5f9', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', padding: 24 };
const card = { width: '100%', maxWidth: 420, background: '#1f2937', borderRadius: 16, padding: 36, border: '1px solid rgba(255,255,255,0.06)' };
const title = { fontSize: 24, fontWeight: 700, margin: 0, color: '#3b82f6' };
const lbl = { display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 };
const input = { width: '100%', padding: '10px 12px', background: '#0f172a', color: '#f1f5f9', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 15, outline: 'none', boxSizing: 'border-box' };
const btn = { width: '100%', marginTop: 14, padding: '12px 16px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' };
const msg = { marginTop: 16, fontSize: 14, textAlign: 'center' };
const errBox = { marginTop: 12, padding: '10px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: 8, fontSize: 13 };
