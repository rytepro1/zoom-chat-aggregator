import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSocketContext } from '../contexts/SocketContext';

/**
 * TrialBanner — slim header strip that appears for trial-tier orgs to
 * show remaining minutes and a one-click Upgrade CTA. Hidden for admin
 * and paid (solo) tiers.
 *
 * Visibility rules:
 *   - plan_tier === 'trial' AND remainingMinutes <= 5  → show banner
 *   - plan_tier === 'trial' AND warningShown          → show banner
 * Once `exhausted` flips true, the modal takes over and the banner
 * stays visible behind it as reinforcement.
 */
export default function TrialBanner() {
  const { org } = useAuth();
  const { trialState } = useSocketContext();
  if (!org || org.planTier !== 'trial') return null;

  // Prefer live socket value; fall back to /me snapshot.
  const remaining = trialState.remainingMinutes ?? org.trialMinutesRemaining ?? 30;
  const showBanner = remaining <= 5 || trialState.warningShown || trialState.exhausted;
  if (!showBanner) return null;

  const tone = trialState.exhausted ? 'danger' : (remaining <= 2 ? 'danger' : 'warning');
  const bg = tone === 'danger' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)';
  const border = tone === 'danger' ? 'rgba(239,68,68,0.4)' : 'rgba(245,158,11,0.4)';
  const fg = tone === 'danger' ? '#fca5a5' : '#fcd34d';

  return (
    <div style={{
      padding: '10px 16px',
      background: bg,
      borderBottom: `1px solid ${border}`,
      color: fg,
      fontSize: 13,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
    }}>
      <span>
        {trialState.exhausted
          ? <>🔓 Your 30-minute free trial is up. Upgrade to keep monitoring.</>
          : <>⏱  Free trial: <b>{Math.max(0, Math.ceil(remaining))} minute{Math.ceil(remaining) === 1 ? '' : 's'}</b> remaining.</>}
      </span>
      <a
        href="/upgrade"
        style={{
          padding: '5px 12px',
          background: tone === 'danger' ? '#ef4444' : '#f59e0b',
          color: '#fff',
          textDecoration: 'none',
          borderRadius: 6,
          fontWeight: 600,
          fontSize: 12,
        }}
      >
        Upgrade — $49/mo
      </a>
    </div>
  );
}
