import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSocketContext } from '../contexts/SocketContext';

/**
 * TrialExhaustedModal — full-screen, non-dismissible overlay shown when
 * the trial hits zero. The active bots have already been disconnected
 * server-side (TrialEnforcer); this is the last thing the operator sees
 * before deciding to upgrade.
 *
 * Renders only for trial-tier orgs with `exhausted === true`.
 * Hidden for admin / paid tiers and for trials with minutes remaining.
 */
export default function TrialExhaustedModal() {
  const { org } = useAuth();
  const { trialState } = useSocketContext();
  // Belt-and-suspenders: hide for any non-trial tier. A stale
  // `trialState.exhausted` flag from before an upgrade should never
  // be enough to show the modal on a paid org.
  if (!org) return null;
  if (org.planTier !== 'trial') return null;
  if (!trialState.exhausted) return null;

  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🔓</div>
        <h2 style={title}>Your free trial is up</h2>
        <p style={subtitle}>
          You've used your 30 minutes of bot runtime. Active bots have been
          disconnected. Pick a plan to keep monitoring rooms.
        </p>

        <div style={pricing}>
          <div style={tierName}>Plans</div>
          <ul style={features}>
            <li><b>Solo</b> — $49.99/mo, 1 concurrent bot</li>
            <li><b>Pro</b> — $199/mo, 5 concurrent bots</li>
            <li><b>Studio</b> — $499/mo, 20 concurrent bots</li>
          </ul>
        </div>

        <a href="/upgrade" style={primaryBtn}>View plans &amp; upgrade</a>
        <p style={{ marginTop: 16, fontSize: 12, color: '#64748b' }}>
          Cancel any time from your account.
        </p>
      </div>
    </div>
  );
}

const overlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.92)',
  backdropFilter: 'blur(6px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
  padding: 24,
};
const modal = {
  width: '100%',
  maxWidth: 460,
  background: '#1f2937',
  borderRadius: 16,
  padding: 36,
  textAlign: 'center',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#f1f5f9',
  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
};
const title = { fontSize: 24, fontWeight: 700, margin: 0 };
const subtitle = { marginTop: 8, color: '#94a3b8', fontSize: 14, lineHeight: 1.5 };
const pricing = {
  marginTop: 24,
  padding: 20,
  background: '#0f172a',
  borderRadius: 12,
  border: '1px solid rgba(59,130,246,0.3)',
};
const tierName = { fontSize: 13, color: '#60a5fa', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' };
const tierPrice = { fontSize: 36, fontWeight: 700, marginTop: 4 };
const features = {
  listStyle: 'none',
  padding: 0,
  margin: '14px 0 0',
  textAlign: 'left',
  fontSize: 14,
  color: '#cbd5e1',
  lineHeight: 1.8,
};
const primaryBtn = {
  display: 'inline-block',
  marginTop: 24,
  width: '100%',
  padding: '14px 16px',
  background: '#3b82f6',
  color: '#fff',
  textDecoration: 'none',
  borderRadius: 10,
  fontWeight: 700,
  fontSize: 15,
  boxSizing: 'border-box',
};
