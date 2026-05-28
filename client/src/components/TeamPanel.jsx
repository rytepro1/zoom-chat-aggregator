import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * TeamPanel — admin-only Settings section for managing org membership.
 *
 * Shows current members (with role + last login) and pending invitations.
 * Admins can invite new users, change roles, remove members, and revoke
 * pending invites. Operators don't see this panel (gated by parent).
 *
 * State syncs from /api/invitations on mount and after every mutation —
 * cheap enough at team-of-a-few-dozen scale.
 */
export default function TeamPanel() {
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('operator');
  const [inviting, setInviting] = useState(false);
  // Two-click confirm pattern (works in WKWebView, where window.confirm
  // is a no-op by default). Tracks which action is awaiting a 2nd click.
  // Keyed as `${action}:${id}`. Auto-resets after 3s.
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const armConfirm = (key) => {
    setPendingConfirm(key);
    setTimeout(() => {
      setPendingConfirm(prev => (prev === key ? null : prev));
    }, 3000);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/invitations', { credentials: 'include' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Load failed (${res.status})`);
      }
      const data = await res.json();
      setMembers(data.members || []);
      setInvitations(data.invitations || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const invite = async (e) => {
    e.preventDefault();
    setInviting(true);
    setError(null);
    try {
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invite failed');
      setInviteEmail('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setInviting(false);
    }
  };

  const revoke = async (id) => {
    const key = `revoke:${id}`;
    if (pendingConfirm !== key) { armConfirm(key); return; }
    setPendingConfirm(null);
    setError(null);
    try {
      const res = await fetch(`/api/invitations/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Revoke failed');
      }
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const removeMember = async (id) => {
    const key = `remove:${id}`;
    if (pendingConfirm !== key) { armConfirm(key); return; }
    setPendingConfirm(null);
    setError(null);
    try {
      const res = await fetch(`/api/invitations/members/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Remove failed');
      }
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const changeRole = async (id, role) => {
    setError(null);
    try {
      const res = await fetch(`/api/invitations/members/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Role change failed');
      }
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) return <div style={{ fontSize: 13, color: 'var(--secondary-text-color)' }}>Loading team…</div>;

  return (
    <div>
      {error && <div style={errBox}>{error}</div>}

      {/* Invite form */}
      <form onSubmit={invite} style={{ marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="teammate@example.com"
          required
          style={input}
        />
        <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} style={select}>
          <option value="operator">Operator</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" disabled={inviting} style={btnPrimary}>
          {inviting ? '…' : 'Invite'}
        </button>
      </form>

      {/* Members */}
      <SectionLabel>Members ({members.length})</SectionLabel>
      <div style={list}>
        {members.map(m => (
          <div key={m.id} style={row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--text-color)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.email}{m.id === user.id && <span style={youTag}> you</span>}
              </div>
              <div style={sub}>
                {m.last_login_at ? `last seen ${new Date(m.last_login_at).toLocaleDateString()}` : 'never signed in'}
                {!m.email_verified && ' · unverified'}
              </div>
            </div>
            <select
              value={m.role}
              onChange={(e) => changeRole(m.id, e.target.value)}
              disabled={m.id === user.id}
              style={{ ...selectMini, opacity: m.id === user.id ? 0.5 : 1 }}
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={() => removeMember(m.id)}
              disabled={m.id === user.id}
              style={{
                ...btnDanger,
                opacity: m.id === user.id ? 0.3 : 1,
                cursor: m.id === user.id ? 'not-allowed' : 'pointer',
                background: pendingConfirm === `remove:${m.id}` ? 'rgba(239,68,68,0.2)' : 'transparent',
                borderRadius: 4,
                padding: pendingConfirm === `remove:${m.id}` ? '4px 8px' : '4px 8px',
                fontSize: pendingConfirm === `remove:${m.id}` ? 11 : 14,
                fontWeight: pendingConfirm === `remove:${m.id}` ? 600 : 'normal',
              }}
              title={m.id === user.id ? "You can't remove yourself" : 'Remove from org'}
            >
              {pendingConfirm === `remove:${m.id}` ? 'Confirm?' : '✕'}
            </button>
          </div>
        ))}
      </div>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 16 }}>Pending invitations ({invitations.length})</SectionLabel>
          <div style={list}>
            {invitations.map(inv => (
              <div key={inv.id} style={row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-color)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.email}
                  </div>
                  <div style={sub}>
                    {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={() => revoke(inv.id)}
                  style={{
                    ...btnGhost,
                    background: pendingConfirm === `revoke:${inv.id}` ? 'rgba(239,68,68,0.2)' : 'transparent',
                  }}
                >
                  {pendingConfirm === `revoke:${inv.id}` ? 'Confirm?' : 'Revoke'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SectionLabel({ children, style }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--secondary-text-color)', marginBottom: 8, ...style }}>
      {children}
    </div>
  );
}

const input = { flex: 1, minWidth: 180, padding: '8px 10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-color)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: 13, outline: 'none' };
const select = { padding: '8px 10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-color)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: 13, cursor: 'pointer' };
const selectMini = { padding: '4px 6px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-color)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, fontSize: 11, cursor: 'pointer', marginRight: 6 };
const btnPrimary = { padding: '8px 14px', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const btnGhost = { padding: '4px 10px', background: 'transparent', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, fontSize: 11, cursor: 'pointer' };
const btnDanger = { padding: '4px 8px', background: 'transparent', color: '#fca5a5', border: 'none', fontSize: 14, cursor: 'pointer' };
const list = { display: 'flex', flexDirection: 'column', gap: 6 };
const row = { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 };
const sub = { fontSize: 11, color: 'var(--secondary-text-color)', marginTop: 2 };
const youTag = { fontSize: 10, padding: '1px 6px', background: 'rgba(59,130,246,0.2)', color: '#60a5fa', borderRadius: 8, marginLeft: 6, verticalAlign: 'middle' };
const errBox = { marginBottom: 12, padding: '8px 10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: 6, fontSize: 12 };
