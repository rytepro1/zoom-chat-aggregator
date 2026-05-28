import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * UpgradePage — Stripe Checkout entry point.
 *
 * Trial / canceled / new user → big "Upgrade to Solo $49/mo" button
 * that POSTs to /api/billing/checkout and redirects to Stripe-hosted
 * Checkout.
 *
 * Already on Solo → "Manage subscription" button that POSTs to
 * /api/billing/portal (Stripe Customer Portal for cancel / payment
 * method / invoices).
 *
 * Admin → no upgrade UI (you bypass billing).
 *
 * `?canceled=1` appended by Stripe when the user backs out of Checkout
 * — we surface a soft note. `?upgrade=success` appended by our success
 * URL after payment — we show a confirmation and refresh /me.
 */
export default function UpgradePage() {
  const { user, org, refresh } = useAuth();
  const [params] = useSearchParams();
  const canceled = params.get('canceled') === '1';
  const success = params.get('upgrade') === 'success';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // If we just came back from a successful Checkout, refresh /me so the
  // header tier badge flips immediately without a manual reload.
  useEffect(() => {
    if (success) refresh();
  }, [success, refresh]);

  const startCheckout = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Checkout failed');
      window.location.href = data.url;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const openPortal = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Failed to open portal');
      window.location.href = data.url;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const isAdmin = org?.planTier === 'admin';
  const isSolo = org?.planTier === 'solo';

  return (
    <div style={shell}>
      <div style={card}>
        <Link to="/" style={backLink}>← Back to ZoomChat</Link>

        {success ? (
          <>
            <div style={{ fontSize: 48, marginBottom: 6 }}>✓</div>
            <h1 style={{ ...title, color: '#86efac' }}>You're on Solo</h1>
            <p style={subtitle}>
              Subscription active. Your trial limits are lifted — go run your event.
            </p>
            <Link to="/" style={primaryBtn}>Back to the app</Link>
          </>
        ) : isAdmin ? (
          <>
            <h1 style={title}>You're on the Admin tier</h1>
            <p style={subtitle}>
              No billing required — you're the owner. Nothing to upgrade here.
            </p>
            <Link to="/" style={primaryBtn}>Back to the app</Link>
          </>
        ) : isSolo ? (
          <>
            <h1 style={title}>You're on Solo</h1>
            <p style={subtitle}>
              $49/mo, billed monthly. Manage your payment method, view invoices,
              or cancel any time.
            </p>
            <button onClick={openPortal} disabled={busy} style={primaryBtn}>
              {busy ? 'Opening…' : 'Manage subscription'}
            </button>
            {error && <div style={errBox}>{error}</div>}
          </>
        ) : (
          <>
            <h1 style={title}>Upgrade to Solo</h1>
            <p style={subtitle}>
              Unlimited bot-hours, one concurrent meeting bot, full feature set.
              Cancel any time.
            </p>

            <div style={priceBox}>
              <div style={{ fontSize: 13, color: '#60a5fa', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Solo</div>
              <div style={{ fontSize: 44, fontWeight: 700, marginTop: 6 }}>
                $49<span style={{ fontSize: 18, color: '#94a3b8' }}>/mo</span>
              </div>
              <ul style={features}>
                <li>1 concurrent meeting bot</li>
                <li>Unlimited bot-hours</li>
                <li>Saved messages, PNG quote cards</li>
                <li>Rosters + one-click deploy</li>
                <li>Presenter display, custom theming</li>
                <li>Cancel from your account anytime</li>
              </ul>
            </div>

            <button onClick={startCheckout} disabled={busy} style={primaryBtn}>
              {busy ? 'Opening checkout…' : 'Upgrade to Solo — $49/mo'}
            </button>
            {canceled && (
              <div style={noticeNeutral}>
                No charge — you canceled before completing checkout.
              </div>
            )}
            {error && <div style={errBox}>{error}</div>}
            <p style={hint}>
              Payment is processed by Stripe. You'll be redirected to enter your
              card details on their secure page.
            </p>
          </>
        )}

        {user && org && (
          <p style={{ marginTop: 28, fontSize: 12, color: '#64748b', textAlign: 'center' }}>
            Signed in as <b>{user.email}</b> · org: <b>{org.name}</b> · plan: <b>{org.planTier}</b>
          </p>
        )}
      </div>
    </div>
  );
}

const shell = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at top, #1e293b, #0f172a)', color: '#f1f5f9', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', padding: 24 };
const card = { width: '100%', maxWidth: 520, background: '#1f2937', borderRadius: 16, padding: 40, border: '1px solid rgba(255,255,255,0.06)' };
const backLink = { display: 'inline-block', marginBottom: 18, fontSize: 13, color: '#60a5fa', textDecoration: 'none' };
const title = { fontSize: 28, fontWeight: 700, margin: 0 };
const subtitle = { color: '#94a3b8', fontSize: 14, marginTop: 6, lineHeight: 1.5 };
const priceBox = { marginTop: 24, padding: 24, background: '#0f172a', borderRadius: 12, border: '1px solid rgba(59,130,246,0.3)' };
const features = { listStyle: 'none', padding: 0, margin: '14px 0 0', textAlign: 'left', fontSize: 14, color: '#cbd5e1', lineHeight: 2 };
const primaryBtn = { display: 'inline-block', width: '100%', boxSizing: 'border-box', marginTop: 24, padding: '14px 16px', background: '#3b82f6', color: '#fff', textDecoration: 'none', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: 'pointer', textAlign: 'center' };
const hint = { marginTop: 16, fontSize: 13, color: '#94a3b8', lineHeight: 1.6, textAlign: 'center' };
const errBox = { marginTop: 14, padding: '10px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: 8, fontSize: 13 };
const noticeNeutral = { marginTop: 14, padding: '10px 12px', background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)', color: '#cbd5e1', borderRadius: 8, fontSize: 13 };
