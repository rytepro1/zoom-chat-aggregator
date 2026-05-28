import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * AcceptInvitePage — recipient lands here from an invite email link.
 *
 * Flow:
 *   1. On mount: GET /api/invitations/accept/:token to fetch invite
 *      metadata (email, role, org name). Shows a friendly card with
 *      org context.
 *   2. Recipient enters a password. Submit → POST /api/invitations/accept
 *      which creates the user, sets the session cookie, and redirects
 *      into the app.
 *
 * No email field — the invite is bound to a specific email. Email is
 * shown read-only for confirmation.
 */
export default function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const [state, setState] = useState('loading');
  const [invitation, setInvitation] = useState(null);
  const [error, setError] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      setError('Missing token in URL.');
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/invitations/accept/${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) {
          setState('invalid');
          setError(data.error || 'Invitation is invalid or expired.');
        } else {
          setInvitation(data.invitation);
          setState('ready');
        }
      } catch (e) {
        setState('invalid');
        setError(e.message);
      }
    })();
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to accept invitation');
        setBusy(false);
        return;
      }
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div style={shell}>
      <div style={card}>
        <h1 style={title}>You've been invited</h1>

        {state === 'loading' && <p style={msg}>Checking your invitation…</p>}

        {state === 'invalid' && (
          <>
            <p style={{ ...msg, color: '#fca5a5' }}>{error}</p>
            <a href="/signin" style={btn}>Back to sign-in</a>
          </>
        )}

        {state === 'ready' && invitation && (
          <>
            <p style={subtitle}>
              <b>{invitation.orgName}</b> has invited <b>{invitation.email}</b> to join as a {invitation.role}.
            </p>
            <form onSubmit={submit}>
              <label style={{ display: 'block', marginTop: 20 }}>
                <span style={lbl}>Email</span>
                <input type="email" value={invitation.email} disabled style={{ ...input, opacity: 0.7 }} />
              </label>
              <label style={{ display: 'block', marginTop: 14 }}>
                <span style={lbl}>Set a password</span>
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
                {busy ? '…' : `Accept invitation & sign in`}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const shell = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at top, #1e293b, #0f172a)', color: '#f1f5f9', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', padding: 24 };
const card = { width: '100%', maxWidth: 460, background: '#1f2937', borderRadius: 16, padding: 36, border: '1px solid rgba(255,255,255,0.06)' };
const title = { fontSize: 24, fontWeight: 700, margin: 0, color: '#3b82f6' };
const subtitle = { marginTop: 10, fontSize: 14, color: '#cbd5e1', lineHeight: 1.5 };
const msg = { marginTop: 20, fontSize: 15, textAlign: 'center', lineHeight: 1.5 };
const lbl = { display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 };
const input = { width: '100%', padding: '10px 12px', background: '#0f172a', color: '#f1f5f9', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 15, outline: 'none', boxSizing: 'border-box' };
const btn = { display: 'inline-block', width: '100%', boxSizing: 'border-box', marginTop: 18, padding: '12px 16px', background: '#3b82f6', color: '#fff', textDecoration: 'none', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 15, cursor: 'pointer', textAlign: 'center' };
const errBox = { marginTop: 12, padding: '10px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: 8, fontSize: 13 };
