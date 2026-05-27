import React, { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

/**
 * VerifyEmailPage — landing page for the link in the verification email.
 * Reads ?token=… from the URL, POSTs to /api/auth/verify-email, shows
 * success / failure. The user is already signed in when they click (we
 * set the session cookie at signup time), so no separate login step.
 */
export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState('verifying');
  const [errorMessage, setErrorMessage] = useState(null);

  useEffect(() => {
    if (!token) {
      setState('error');
      setErrorMessage('Missing token in URL.');
      return;
    }
    (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (!res.ok) {
          setState('error');
          setErrorMessage(data.error || 'Verification failed');
        } else {
          setState('ok');
        }
      } catch (e) {
        setState('error');
        setErrorMessage(e.message);
      }
    })();
  }, [token]);

  return (
    <div style={shell}>
      <div style={card}>
        <h1 style={title}>Email verification</h1>
        {state === 'verifying' && <p style={msg}>Verifying…</p>}
        {state === 'ok' && (
          <>
            <p style={{ ...msg, color: '#86efac' }}>Your email is verified. ✓</p>
            <Link to="/" style={btn}>Continue to ZoomChat</Link>
          </>
        )}
        {state === 'error' && (
          <>
            <p style={{ ...msg, color: '#fca5a5' }}>{errorMessage}</p>
            <Link to="/" style={btn}>Back to app</Link>
          </>
        )}
      </div>
    </div>
  );
}

const shell = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at top, #1e293b, #0f172a)', color: '#f1f5f9', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', padding: 24 };
const card = { width: '100%', maxWidth: 420, background: '#1f2937', borderRadius: 16, padding: 36, textAlign: 'center', border: '1px solid rgba(255,255,255,0.06)' };
const title = { fontSize: 24, fontWeight: 700, margin: 0, color: '#3b82f6' };
const msg = { marginTop: 24, fontSize: 15, lineHeight: 1.5 };
const btn = { display: 'inline-block', marginTop: 24, padding: '10px 18px', background: '#3b82f6', color: '#fff', textDecoration: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14 };
