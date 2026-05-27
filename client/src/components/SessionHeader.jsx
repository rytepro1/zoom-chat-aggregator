import React, { useState, useRef, useEffect } from 'react';
import { useSession } from '../contexts/SessionContext';
import BroadcastModal from './BroadcastModal';

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

/**
 * Center-of-header surface for the current session. Click the name to
 * rename inline. The chevron opens a menu with End & Start New + Past
 * Sessions actions. Past sessions display in a modal launched from
 * that menu.
 */
function SessionHeader() {
  const { currentSession, renameSession, endAndStartNew, refreshPastSessions, pastSessions } = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  const [pastLoading, setPastLoading] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const inputRef = useRef(null);
  const menuRef = useRef(null);

  // Close menu when clicking outside.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select();
    }
  }, [editing]);

  if (!currentSession) return null;

  const beginEdit = () => {
    setDraft(currentSession.name);
    setEditing(true);
  };

  const commitEdit = async () => {
    const next = draft.trim();
    if (!next || next === currentSession.name) {
      setEditing(false);
      return;
    }
    try {
      await renameSession(next);
    } catch (err) {
      alert('Rename failed: ' + err.message);
    } finally {
      setEditing(false);
    }
  };

  const handleEndAndStart = async () => {
    setMenuOpen(false);
    const defaultName = `Session ${new Date().toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })}`;
    const name = window.prompt(
      `End "${currentSession.name}" and start a new session?\n\nName for the new session:`,
      defaultName
    );
    if (name == null) return; // cancelled
    try {
      await endAndStartNew(name.trim() || undefined);
    } catch (err) {
      alert('Failed to start new session: ' + err.message);
    }
  };

  const openPastSessions = async () => {
    setMenuOpen(false);
    setPastOpen(true);
    setPastLoading(true);
    try {
      await refreshPastSessions();
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setPastLoading(false);
    }
  };

  return (
    <div className="relative flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
      <span className="text-xs uppercase tracking-wide opacity-50" style={{ color: 'var(--text-color)' }}>
        Session
      </span>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            else if (e.key === 'Escape') { setEditing(false); setDraft(''); }
          }}
          className="px-2 py-0.5 rounded text-sm font-medium bg-white/10 outline-none focus:bg-white/20 min-w-[200px]"
          style={{ color: 'var(--text-color)' }}
        />
      ) : (
        <button
          onClick={beginEdit}
          className="text-sm font-medium hover:underline"
          style={{ color: 'var(--text-color)' }}
          title="Click to rename"
        >
          {currentSession.name}
        </button>
      )}

      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(o => !o)}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: 'var(--secondary-text-color)' }}
          title="Session actions"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
          </svg>
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-1 w-56 rounded-lg shadow-2xl border border-white/10 z-50"
            style={{ backgroundColor: 'var(--header-color)' }}
          >
            <button
              onClick={() => { setMenuOpen(false); beginEdit(); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-white/10 transition-colors rounded-t-lg"
              style={{ color: 'var(--text-color)' }}
            >
              Rename Current Session
            </button>
            <button
              onClick={handleEndAndStart}
              className="w-full text-left px-3 py-2 text-sm hover:bg-white/10 transition-colors"
              style={{ color: 'var(--text-color)' }}
            >
              End &amp; Start New Session…
            </button>
            <div className="border-t border-white/10" />
            <button
              onClick={() => { setMenuOpen(false); setBroadcastOpen(true); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-white/10 transition-colors"
              style={{ color: 'var(--text-color)' }}
            >
              Broadcast to All Rooms…
            </button>
            <div className="border-t border-white/10" />
            <button
              onClick={openPastSessions}
              className="w-full text-left px-3 py-2 text-sm hover:bg-white/10 transition-colors rounded-b-lg"
              style={{ color: 'var(--text-color)' }}
            >
              View Past Sessions…
            </button>
          </div>
        )}
      </div>

      {pastOpen && (
        <PastSessionsModal
          sessions={pastSessions}
          loading={pastLoading}
          currentId={currentSession.id}
          onClose={() => setPastOpen(false)}
        />
      )}

      {broadcastOpen && (
        <BroadcastModal onClose={() => setBroadcastOpen(false)} />
      )}
    </div>
  );
}

function PastSessionsModal({ sessions, loading, currentId, onClose }) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[80vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{ backgroundColor: 'var(--header-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-color)' }}>
            Past Sessions
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
            style={{ color: 'var(--text-color)' }}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center opacity-60" style={{ color: 'var(--text-color)' }}>
              Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-8 text-center opacity-60" style={{ color: 'var(--text-color)' }}>
              No past sessions yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left opacity-60 border-b border-white/10">
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Messages</th>
                  <th className="px-4 py-2 text-right">Saved</th>
                  <th className="px-4 py-2 text-right">Export</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-white/5 hover:bg-white/5"
                    style={{ color: 'var(--text-color)' }}
                  >
                    <td className="px-4 py-2">
                      {s.name}
                      {s.id === currentId && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                          current
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 opacity-70">{formatDateTime(s.started_at)}</td>
                    <td className="px-4 py-2 opacity-70">
                      {s.ended_at ? formatDateTime(s.ended_at) : 'Active'}
                    </td>
                    <td className="px-4 py-2 text-right opacity-70">{s.message_count}</td>
                    <td className="px-4 py-2 text-right opacity-70">{s.saved_count}</td>
                    <td className="px-4 py-2 text-right">
                      <a
                        href={`${API_URL}/api/saved/export.csv?session_id=${encodeURIComponent(s.id)}`}
                        className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
                        style={{ color: 'var(--accent-color)' }}
                        title="Download saved messages from this session"
                      >
                        CSV
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default SessionHeader;
