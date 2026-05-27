import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const SavedContext = createContext(null);

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

/**
 * Tracks which messages the operator has bookmarked for export. Backed
 * by the server's /api/saved endpoints (which write through to Postgres,
 * so saved highlights survive a server restart and can be browsed for
 * past sessions).
 *
 * Sync model: on mount we fetch the current session's saved list; from
 * then on we listen for `messageSaved` / `messageUnsaved` socket events
 * so multiple operator windows (and the pop-out display, eventually)
 * stay in lockstep.
 */
export function SavedProvider({ children, socket }) {
  const [savedMessages, setSavedMessages] = useState([]);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/saved`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setSavedMessages(data.messages || []);
      } catch (err) {
        console.error('Failed to load saved messages:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live sync via socket
  useEffect(() => {
    if (!socket) return;

    const onSaved = (message) => {
      setSavedMessages(prev => {
        if (prev.find(m => m.id === message.id)) {
          return prev.map(m => m.id === message.id ? message : m);
        }
        return [message, ...prev];
      });
    };
    const onUnsaved = (message) => {
      setSavedMessages(prev => prev.filter(m => m.id !== message.id));
    };

    socket.on('messageSaved', onSaved);
    socket.on('messageUnsaved', onUnsaved);
    return () => {
      socket.off('messageSaved', onSaved);
      socket.off('messageUnsaved', onUnsaved);
    };
  }, [socket]);

  const saveMessage = useCallback(async (messageId, note = null) => {
    const res = await fetch(`${API_URL}/api/messages/${messageId}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    // Socket event will update state; we don't need to do it here.
    return res.json();
  }, []);

  const unsaveMessage = useCallback(async (messageId) => {
    const res = await fetch(`${API_URL}/api/messages/${messageId}/save`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, []);

  const isSaved = useCallback(
    (messageId) => savedMessages.some(m => m.id === messageId),
    [savedMessages]
  );

  const value = {
    savedMessages,
    saveMessage,
    unsaveMessage,
    isSaved,
  };

  return (
    <SavedContext.Provider value={value}>
      {children}
    </SavedContext.Provider>
  );
}

export function useSaved() {
  const context = useContext(SavedContext);
  if (!context) {
    throw new Error('useSaved must be used within a SavedProvider');
  }
  return context;
}
