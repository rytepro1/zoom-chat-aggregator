import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * UpgradePage — landing page for the in-app "Upgrade" CTA. In Phase 3
 * this is a placeholder; Phase 4 wires the button to a Stripe Checkout
 * Session. The route exists now so the trial CTA links work end-to-end
 * (the bot's "trial limit reached" message links here too).
 */
export default function UpgradePage() {
  const { user, org } = useAuth();

  return (
    <div style={shell}>
      <div style={card}>
        <Link to="/" style={backLink}>← Back to ZoomChat</Link>
        <h1 style={title}>Upgrade to Solo</h1>
        <p style={subtitle}>
          Unlimited bot-hours, one concurrent meeting bot, full feature set.
          Cancel anytime.
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

        <button disabled style={primaryBtn}>
          Stripe checkout — coming soon
        </button>
        <p style={hint}>
          Stripe billing wires up in the next phase. If you need to upgrade
          right now to keep using ZoomChat for an event today, email{' '}
          <a href="mailto:theo@ryteproductions.com" style={{ color: '#60a5fa' }}>
            theo@ryteproductions.com
          </a>
          {' '}and Theo will activate your account manually.
        </p>

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
const primaryBtn = { width: '100%', marginTop: 24, padding: '14px 16px', background: '#475569', color: '#cbd5e1', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: 'not-allowed' };
const hint = { marginTop: 16, fontSize: 13, color: '#94a3b8', lineHeight: 1.6 };
