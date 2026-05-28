import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSocketContext } from '../contexts/SocketContext';

/**
 * AccountMenu — small dropdown in the header showing the signed-in
 * user's email + org, with a Sign out button. Also flags
 * unverified-email state so the user knows to check their inbox.
 *
 * Plan-tier badge gives an at-a-glance "are you on trial or paid?"
 * indicator. Trial users see remaining minutes; admins see "Admin".
 */
export default function AccountMenu() {
  const { user, org, logout } = useAuth();
  const { trialState } = useSocketContext();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!user || !org) return null;

  const tierLabel = (() => {
    if (org.planTier === 'admin') return 'Admin';
    if (org.planTier === 'trial') {
      // Live socket value when present, else the /me snapshot.
      const mins = trialState?.remainingMinutes ?? org.trialMinutesRemaining ?? 30;
      return `Trial · ${Math.max(0, Math.ceil(mins))}m left`;
    }
    return org.planTier?.charAt(0).toUpperCase() + org.planTier?.slice(1);
  })();

  const tierColor = org.planTier === 'admin'
    ? '#22c55e'
    : org.planTier === 'trial'
      ? '#f59e0b'
      : '#3b82f6';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={`${user.email} · ${org.name}`}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-colors"
        style={{ color: 'var(--text-color)' }}
      >
        <div
          style={{
            width: 28, height: 28, borderRadius: '50%',
            background: tierColor, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700,
          }}
        >
          {(user.email[0] || '?').toUpperCase()}
        </div>
        <span style={{ fontSize: 12, opacity: 0.75 }}>{tierLabel}</span>
      </button>

      {open && (
        <div style={dropdown}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{user.email}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{org.name}</div>
            <div style={{ marginTop: 8, display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: tierColor + '22', color: tierColor, fontSize: 11, fontWeight: 600 }}>
              {tierLabel}
            </div>
            {!user.emailVerified && (
              <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, fontSize: 12, color: '#fcd34d' }}>
                Verify your email — check your inbox for the link.
              </div>
            )}
          </div>
          {(org.planTier === 'trial' || org.planTier === 'canceled') && (
            <a
              href="/upgrade"
              style={{ ...menuItem, color: '#60a5fa', textDecoration: 'none' }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(59,130,246,0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              ⬆  Upgrade — view plans
            </a>
          )}
          {['solo', 'pro', 'studio'].includes(org.planTier) && (
            <a
              href="/upgrade"
              style={{ ...menuItem, color: '#cbd5e1', textDecoration: 'none' }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              Manage billing
            </a>
          )}
          <button
            onClick={async () => { await logout(); window.location.href = '/signin'; }}
            style={menuItem}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239,68,68,0.1)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const dropdown = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  width: 260,
  background: '#1f2937',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  zIndex: 50,
  overflow: 'hidden',
};
const menuItem = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  color: '#fca5a5',
  border: 'none',
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
