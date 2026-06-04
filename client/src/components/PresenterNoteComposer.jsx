import React, { useState, useEffect } from 'react';
import { usePresenterNotes } from '../contexts/PresenterNotesContext';

/**
 * "Note to presenter" composer — moderator-only feature that pushes a
 * message to the presenter pop-out view only (never into Zoom rooms,
 * never into the moderator chat feed).
 *
 * Operator display name is required and stored in localStorage so it
 * persists across sessions. It's prepended to the note on the
 * presenter screen ("⚡ FROM PRODUCTION · Theo · 2:34 PM").
 */
const DISPLAY_NAME_KEY = 'zoomchat.operatorDisplayName';
const MAX_LEN = 200;

export default function PresenterNoteComposer({ hideHeader = false }) {
  const { notes, send, dismiss } = usePresenterNotes();
  const [body, setBody] = useState('');
  const [displayName, setDisplayName] = useState(() => {
    try { return localStorage.getItem(DISPLAY_NAME_KEY) || ''; } catch { return ''; }
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  // Persist display name whenever it changes so the operator only sets
  // it once per device.
  useEffect(() => {
    try { localStorage.setItem(DISPLAY_NAME_KEY, displayName); } catch {}
  }, [displayName]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!displayName.trim()) {
      setError('Set your display name first so the presenter knows who sent the note.');
      return;
    }
    setSending(true);
    try {
      await send({ body: trimmed, senderDisplay: displayName.trim() });
      setBody('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit(e);
    }
  };

  const remaining = MAX_LEN - body.length;
  const currentNote = notes[0]; // newest first

  return (
    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
      {!hideHeader && (
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
            📺 Note to presenter
          </h3>
          <span className="text-xs opacity-60">
            Org-wide · presenter pop-out only
          </span>
        </div>
      )}

      <input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Your display name (e.g., Theo)"
        className="w-full px-2 py-1.5 text-xs rounded bg-white/5 border border-white/15 focus:border-amber-500/50 focus:outline-none mb-2"
        style={{ color: 'var(--text-color)' }}
      />

      <form onSubmit={onSubmit}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, MAX_LEN))}
          onKeyDown={onKeyDown}
          placeholder="Wrap this section in 5 min..."
          rows={2}
          className="w-full px-2 py-1.5 text-sm rounded bg-white/10 border border-white/20 focus:border-amber-500/50 focus:outline-none resize-none"
          style={{ color: 'var(--text-color)' }}
        />
        <div className="flex items-center justify-between mt-2">
          <span className={`text-xs ${remaining < 20 ? 'text-amber-400' : 'opacity-50'}`}>
            {remaining} left · ⌘+Enter to send
          </span>
          <button
            type="submit"
            disabled={sending || !body.trim()}
            className="px-3 py-1 text-xs font-semibold rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-900"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
        {error && (
          <p className="text-xs text-red-400 mt-2">{error}</p>
        )}
      </form>

      {currentNote && (
        <div className="mt-3 pt-3 border-t border-amber-500/20">
          <div className="text-[10px] uppercase tracking-wide opacity-50 mb-1">
            On screen now {notes.length > 1 && `(+${notes.length - 1} stacked)`}
          </div>
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-amber-300 truncate">
                {currentNote.senderDisplay} · {timeAgo(currentNote.sentAt)}
              </div>
              <div className="text-sm" style={{ color: 'var(--text-color)' }}>
                {currentNote.body}
              </div>
            </div>
            <button
              onClick={() => dismiss(currentNote.id)}
              className="text-xs px-2 py-0.5 rounded text-red-400 hover:bg-red-500/10"
              title="Clear from presenter screen"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}
