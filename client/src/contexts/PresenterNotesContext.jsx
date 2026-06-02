import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useSettings } from './SettingsContext';

const PresenterNotesContext = createContext(null);

/**
 * Org-wide "production notes" that show only on the presenter pop-out.
 * Moderators send via POST /api/presenter-notes; server fans out via
 * socket events. State here mirrors what's currently considered
 * "active" for this org (not yet dismissed, within auto-dismiss window).
 *
 * Both the moderator UI (composer + "currently on screen" indicator)
 * and the presenter overlay subscribe to this context.
 */
export function PresenterNotesProvider({ children, socket }) {
  const [notes, setNotes] = useState([]); // newest-first
  // Client-side override of the server's suggested dismissSeconds —
  // each browser (moderator OR presenter window) can pick its own
  // auto-clear behavior via Settings → Display.
  // `0` from the setting = manual-clear-only (no auto-dismiss).
  const { settings } = useSettings();
  const localOverride = settings?.presenterNoteAutoDismissSeconds;
  const dismissSeconds = localOverride === 0 ? null
    : (localOverride !== undefined ? localOverride : 60);

  useEffect(() => {
    if (!socket) return;

    const onInitial = (payload) => {
      setNotes(payload.notes || []);
      // Ignore payload.dismissSeconds — client setting wins.
    };
    const onNew = (note) => {
      setNotes(prev => {
        // Newest first, dedup by id.
        const filtered = prev.filter(n => n.id !== note.id);
        // Cap at 5 visible; older ones drop.
        return [note, ...filtered].slice(0, 5);
      });
    };
    const onDismissed = ({ id }) => {
      setNotes(prev => prev.filter(n => n.id !== id));
    };

    socket.on('presenterNotesInitial', onInitial);
    socket.on('presenterNote', onNew);
    socket.on('presenterNoteDismissed', onDismissed);
    return () => {
      socket.off('presenterNotesInitial', onInitial);
      socket.off('presenterNote', onNew);
      socket.off('presenterNoteDismissed', onDismissed);
    };
  }, [socket]);

  // Client-side auto-dismiss timers. dismissSeconds=null → manual only.
  useEffect(() => {
    if (dismissSeconds == null) return;
    const timers = notes.map(note => {
      const sentMs = new Date(note.sentAt).getTime();
      const remaining = sentMs + dismissSeconds * 1000 - Date.now();
      if (remaining <= 0) {
        // Already past — remove on next tick.
        return setTimeout(() => {
          setNotes(prev => prev.filter(n => n.id !== note.id));
        }, 0);
      }
      return setTimeout(() => {
        setNotes(prev => prev.filter(n => n.id !== note.id));
      }, remaining);
    });
    return () => timers.forEach(clearTimeout);
  }, [notes, dismissSeconds]);

  const send = useCallback(async ({ body, senderDisplay }) => {
    const res = await fetch('/api/presenter-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ body, senderDisplay }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    // Local optimistic insert — the socket event will arrive almost
    // immediately and dedup by id.
    if (data.note) {
      setNotes(prev => {
        const filtered = prev.filter(n => n.id !== data.note.id);
        return [data.note, ...filtered].slice(0, 5);
      });
    }
    return data.note;
  }, []);

  const dismiss = useCallback(async (id) => {
    setNotes(prev => prev.filter(n => n.id !== id)); // optimistic
    try {
      await fetch(`/api/presenter-notes/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch (e) {
      // Swallow — server will eventually reconcile on next refresh.
      console.warn('[presenter-notes] dismiss failed:', e.message);
    }
  }, []);

  return (
    <PresenterNotesContext.Provider value={{ notes, dismissSeconds, send, dismiss }}>
      {children}
    </PresenterNotesContext.Provider>
  );
}

export function usePresenterNotes() {
  const ctx = useContext(PresenterNotesContext);
  if (!ctx) {
    throw new Error('usePresenterNotes must be used within PresenterNotesProvider');
  }
  return ctx;
}
