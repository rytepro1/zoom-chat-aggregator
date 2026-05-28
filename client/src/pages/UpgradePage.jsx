import React, { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * UpgradePage — entry point for Stripe Checkout across all paid tiers.
 *
 * Renders dynamically from /api/billing/tiers so adding a new tier on
 * the server (just an env var + Stripe price) shows up without touching
 * this file.
 *
 * States:
 *   - success (?upgrade=success)  → big confirmation, refresh /me
 *   - admin                       → no upgrade UI ("you bypass billing")
 *   - already on a paid tier      → "current plan" badge on that tier,
 *                                    plus "Manage subscription" portal link
 *   - trial / canceled / new      → tier picker, each with its own
 *                                    "Upgrade to {tier}" button
 */
export default function UpgradePage() {
  const { user, org, refresh } = useAuth();
  const [params] = useSearchParams();
  const canceled = params.get('canceled') === '1';
  const success = params.get('upgrade') === 'success';
  const [tiers, setTiers] = useState([]);
  const [loadingTiers, setLoadingTiers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyTier, setBusyTier] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (success) refresh();
  }, [success, refresh]);

  // Load available tiers from the server.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/billing/tiers', { credentials: 'include' });
        const data = await res.json();
        setTiers(data.tiers || []);
      } catch (e) {
        console.error('[upgrade] failed to load tiers:', e);
      } finally {
        setLoadingTiers(false);
      }
    })();
  }, []);

  const startCheckout = useCallback(async (tierKey) => {
    setBusy(true);
    setBusyTier(tierKey);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tier: tierKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Checkout failed');
      window.location.href = data.url;
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setBusyTier(null);
    }
  }, []);

  const openPortal = useCallback(async () => {
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
  }, []);

  const isAdmin = org?.planTier === 'admin';
  const currentTierKey = org?.planTier; // 'trial' | 'solo' | 'pro' | 'studio' | 'canceled' | 'admin'
  const isPaid = ['solo', 'pro', 'studio'].includes(currentTierKey);

  // Layout split: success / admin get their own simple cards; everyone
  // else gets the tier-picker layout.
  if (success) {
    return (
      <Shell>
        <div style={card}>
          <BackLink />
          <div style={{ fontSize: 48, marginBottom: 6 }}>✓</div>
          <h1 style={{ ...title, color: '#86efac' }}>You're upgraded</h1>
          <p style={subtitle}>
            Subscription active. Trial limits lifted. Have at it.
          </p>
          <Link to="/" style={primaryBtn}>Back to the app</Link>
        </div>
      </Shell>
    );
  }

  if (isAdmin) {
    return (
      <Shell>
        <div style={card}>
          <BackLink />
          <h1 style={title}>You're on the Admin tier</h1>
          <p style={subtitle}>
            No billing required — you're the owner. Nothing to upgrade here.
          </p>
          <Link to="/" style={primaryBtn}>Back to the app</Link>
          {accountInfo(user, org)}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ ...card, maxWidth: 980 }}>
        <BackLink />
        <h1 style={title}>{isPaid ? 'Manage your plan' : 'Choose a plan'}</h1>
        <p style={subtitle}>
          {isPaid
            ? 'You can upgrade, downgrade, or cancel from the Stripe Customer Portal.'
            : 'All plans include the full ZoomChat feature set. The difference is how many meetings you monitor at once.'}
        </p>

        {loadingTiers ? (
          <div style={{ marginTop: 28, color: '#94a3b8', textAlign: 'center' }}>Loading…</div>
        ) : tiers.length === 0 ? (
          <div style={{ ...errBox, marginTop: 20 }}>
            No paid plans are configured on this server yet. Contact RYTE Productions
            (theo@ryteproductions.com) to enable billing.
          </div>
        ) : (
          <div style={tierGrid}>
            {tiers.map(t => {
              const isCurrent = t.key === currentTierKey;
              return (
                <div key={t.key} style={{ ...tierCard, ...(isCurrent ? tierCardCurrent : null) }}>
                  {isCurrent && <div style={currentBadge}>Current plan</div>}
                  <div style={tierName}>{t.name}</div>
                  <div style={tierPrice}>{t.priceDisplay.split('/')[0]}<span style={tierPriceSuffix}>/{t.priceDisplay.split('/')[1] || 'mo'}</span></div>
                  <div style={tierTagline}>{t.tagline}</div>
                  <div style={tierBots}>
                    <b>{t.concurrentBotLimit}</b> concurrent {t.concurrentBotLimit === 1 ? 'bot' : 'bots'}
                  </div>
                  <ul style={tierFeatures}>
                    {t.features.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                  {isCurrent ? (
                    <button onClick={openPortal} disabled={busy} style={btnGhost}>
                      {busy ? '…' : 'Manage subscription'}
                    </button>
                  ) : (
                    <button
                      onClick={() => startCheckout(t.key)}
                      disabled={busy}
                      style={isPaid ? btnGhost : btnPrimary}
                    >
                      {busyTier === t.key ? 'Opening checkout…' : (isPaid ? `Switch to ${t.name}` : `Upgrade to ${t.name}`)}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canceled && (
          <div style={{ ...noticeNeutral, marginTop: 18 }}>
            No charge — you canceled before completing checkout.
          </div>
        )}
        {error && <div style={{ ...errBox, marginTop: 18 }}>{error}</div>}

        <p style={hint}>
          Payment is processed by Stripe. You'll be redirected to enter your
          card details on their secure page. Cancel anytime.
        </p>
        {accountInfo(user, org)}
      </div>
    </Shell>
  );
}

// --- helpers ---

function Shell({ children }) {
  return <div style={shell}>{children}</div>;
}
function BackLink() {
  return <Link to="/" style={backLink}>← Back to ZoomChat</Link>;
}
function accountInfo(user, org) {
  if (!user || !org) return null;
  return (
    <p style={{ marginTop: 28, fontSize: 12, color: '#64748b', textAlign: 'center' }}>
      Signed in as <b>{user.email}</b> · org: <b>{org.name}</b> · plan: <b>{org.planTier}</b>
    </p>
  );
}

// --- styles ---

const shell = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at top, #1e293b, #0f172a)', color: '#f1f5f9', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', padding: 24 };
const card = { width: '100%', maxWidth: 520, background: '#1f2937', borderRadius: 16, padding: 40, border: '1px solid rgba(255,255,255,0.06)' };
const backLink = { display: 'inline-block', marginBottom: 18, fontSize: 13, color: '#60a5fa', textDecoration: 'none' };
const title = { fontSize: 28, fontWeight: 700, margin: 0 };
const subtitle = { color: '#94a3b8', fontSize: 14, marginTop: 6, lineHeight: 1.5 };
const tierGrid = { marginTop: 28, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 };
const tierCard = { padding: 20, background: '#0f172a', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', position: 'relative' };
const tierCardCurrent = { borderColor: 'rgba(34,197,94,0.4)', background: 'linear-gradient(180deg, rgba(34,197,94,0.05) 0%, #0f172a 100%)' };
const currentBadge = { position: 'absolute', top: -10, right: 14, fontSize: 11, fontWeight: 700, padding: '3px 10px', background: '#22c55e', color: '#0f172a', borderRadius: 999, letterSpacing: '0.04em', textTransform: 'uppercase' };
const tierName = { fontSize: 13, color: '#60a5fa', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' };
const tierPrice = { fontSize: 36, fontWeight: 700, marginTop: 4, lineHeight: 1 };
const tierPriceSuffix = { fontSize: 16, color: '#94a3b8', fontWeight: 500 };
const tierTagline = { marginTop: 8, fontSize: 12, color: '#cbd5e1', lineHeight: 1.4, minHeight: 32 };
const tierBots = { marginTop: 14, padding: '8px 12px', background: 'rgba(59,130,246,0.1)', borderRadius: 8, fontSize: 13, color: '#bfdbfe' };
const tierFeatures = { listStyle: 'none', padding: 0, margin: '14px 0 18px', fontSize: 13, color: '#cbd5e1', lineHeight: 1.7, flex: 1 };
const btnPrimary = { width: '100%', padding: '11px 14px', background: '#3b82f6', color: '#fff', textDecoration: 'none', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', textAlign: 'center' };
const btnGhost = { width: '100%', padding: '11px 14px', background: 'transparent', color: '#cbd5e1', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer', textAlign: 'center' };
const primaryBtn = { display: 'inline-block', width: '100%', boxSizing: 'border-box', marginTop: 24, padding: '14px 16px', background: '#3b82f6', color: '#fff', textDecoration: 'none', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: 'pointer', textAlign: 'center' };
const hint = { marginTop: 24, fontSize: 12, color: '#94a3b8', lineHeight: 1.5, textAlign: 'center' };
const errBox = { padding: '10px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: 8, fontSize: 13 };
const noticeNeutral = { padding: '10px 12px', background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)', color: '#cbd5e1', borderRadius: 8, fontSize: 13 };
