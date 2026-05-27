import React, { useState, useEffect } from 'react';
import { useSocketContext } from '../contexts/SocketContext';

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

/**
 * Modal composer for sending a single message to every active bot
 * (broadcast to all rooms). Surfaced from the SessionHeader's menu —
 * deliberate-action UX so it's not confused with the inline per-room
 * Reply button on each chat message.
 */
function BroadcastModal({ onClose }) {
  const { rooms } = useSocketContext();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // { sent, failed, results }
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const activeRoomCount = rooms.length;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{ backgroundColor: 'var(--header-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div>
            <h2 className="text-xl font-bold" style={{ color: 'var(--text-color)' }}>
              Broadcast to all rooms
            </h2>
            <p className="text-xs opacity-60 mt-1" style={{ color: 'var(--text-color)' }}>
              Posts the same message in every meeting you're currently connected to.
              {' '}
              {activeRoomCount === 0
                ? 'No active rooms — connect to a meeting first.'
                : `${activeRoomCount} active room${activeRoomCount === 1 ? '' : 's'}.`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
            style={{ color: 'var(--text-color)' }}
          >
            ✕
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={4}
            placeholder="e.g. 'Welcome everyone — Q&A starts in 5 minutes!'  (⌘↩ to send)"
            className="w-full px-3 py-2 rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none resize-none"
            style={{ color: 'var(--text-color)' }}
          />

          {error && (
            <div className="text-sm text-red-400 px-3 py-2 bg-red-500/10 rounded">
              {error}
            </div>
          )}

          {result && (
            <div className="text-sm px-3 py-2 rounded bg-white/5 border border-white/10" style={{ color: 'var(--text-color)' }}>
              <div className="font-medium mb-1">
                Sent to {result.sent} {result.sent === 1 ? 'room' : 'rooms'}
                {result.failed > 0 ? `, ${result.failed} failed` : ''}.
              </div>
              {result.failed > 0 && (
                <ul className="text-xs opacity-70 list-disc list-inside space-y-0.5">
                  {result.results.filter(r => !r.ok).map(r => (
                    <li key={r.meetingId}>
                      {r.roomName}: {r.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm rounded bg-white/10 hover:bg-white/20"
              style={{ color: 'var(--text-color)' }}
            >
              Close
            </button>
            <button
              onClick={send}
              disabled={sending || !text.trim() || activeRoomCount === 0}
              className="px-4 py-2 text-sm font-medium rounded disabled:opacity-50 hover:opacity-90"
              style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
            >
              {sending
                ? 'Sending…'
                : `Broadcast to ${activeRoomCount} ${activeRoomCount === 1 ? 'room' : 'rooms'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BroadcastModal;
