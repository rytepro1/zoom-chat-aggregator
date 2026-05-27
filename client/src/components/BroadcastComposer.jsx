import React, { useState, useEffect } from 'react';
import { useSocketContext } from '../contexts/SocketContext';

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

/**
 * Inline composer that lives at the top of the chat feed (always
 * visible, never scrolls away). Sends one message to every active bot.
 * Per-room outgoing copies land back in the feed as type='broadcast'
 * messages with a "📢 Broadcast" pill for visual confirmation.
 *
 * Collapses to a single-line "click to broadcast" affordance when not
 * focused so it doesn't dominate the visual space; expands to a
 * textarea with Send/Cancel + per-room result feedback when active.
 */
function BroadcastComposer() {
  const { rooms } = useSocketContext();
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // Clear transient result after a few seconds so the composer goes
  // back to a clean state.
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 6000);
    return () => clearTimeout(t);
  }, [result]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/api/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      setText('');
      setExpanded(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const cancel = () => {
    setExpanded(false);
    setText('');
    setError('');
  };

  const roomCount = rooms.length;
  const noRooms = roomCount === 0;

  // Collapsed state: thin one-line affordance.
  if (!expanded) {
    return (
      <div
        className="border-b border-white/10 px-4 py-2"
        style={{ backgroundColor: 'var(--header-color)' }}
      >
        <button
          onClick={() => !noRooms && setExpanded(true)}
          disabled={noRooms}
          className="w-full text-left px-3 py-1.5 rounded text-sm flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
          style={{ color: 'var(--secondary-text-color)' }}
          title={noRooms ? 'Connect to at least one meeting to broadcast' : 'Broadcast a message to every active room'}
        >
          <span style={{ color: 'var(--accent-color)' }}>📢</span>
          <span>
            {noRooms
              ? 'No active rooms — connect a meeting to broadcast'
              : `Broadcast to all ${roomCount} active room${roomCount === 1 ? '' : 's'}…`}
          </span>
        </button>
        {result && (
          <div className="text-xs mt-1 px-3" style={{ color: 'var(--secondary-text-color)' }}>
            Sent to {result.sent} {result.sent === 1 ? 'room' : 'rooms'}
            {result.failed > 0 ? `, ${result.failed} failed` : ''}.
          </div>
        )}
      </div>
    );
  }

  // Expanded state: textarea + actions.
  return (
    <div
      className="border-b border-white/10 px-4 py-3 flex flex-col gap-2"
      style={{ backgroundColor: 'var(--header-color)' }}
    >
      <div className="flex items-center gap-2 text-xs opacity-70" style={{ color: 'var(--text-color)' }}>
        <span style={{ color: 'var(--accent-color)' }}>📢</span>
        <span>Broadcasting to {roomCount} active {roomCount === 1 ? 'room' : 'rooms'}</span>
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            cancel();
          }
        }}
        rows={2}
        placeholder="Type your broadcast message (⌘↩ to send, esc to cancel)"
        className="w-full px-3 py-2 rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none text-sm resize-none"
        style={{ color: 'var(--text-color)' }}
      />
      {error && (
        <div className="text-xs text-red-400">{error}</div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          onClick={cancel}
          disabled={sending}
          className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
          style={{ color: 'var(--text-color)' }}
        >
          Cancel
        </button>
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          className="text-xs px-3 py-1.5 rounded font-medium disabled:opacity-50 hover:opacity-90"
          style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
        >
          {sending ? 'Sending…' : `Broadcast to ${roomCount} ${roomCount === 1 ? 'room' : 'rooms'}`}
        </button>
      </div>
    </div>
  );
}

export default BroadcastComposer;
