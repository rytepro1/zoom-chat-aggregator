import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const SessionContext = createContext(null);

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

/**
 * Tracks the current session and exposes the operator-facing session
 * lifecycle actions (rename, end + start new, list past sessions).
 *
 * Sync: on mount we fetch the server's current session. From then on
 * we listen for `sessionStarted` and `sessionRenamed` socket events so
 * multiple operator windows stay in lockstep — if you end the session
 * in one window, the other windows immediately see the new one.
 */
export function SessionProvider({ children, socket }) {
  const [currentSession, setCurrentSession] = useState(null);
  const [pastSessions, setPastSessions] = useState([]);

  // Initial fetch of current session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/sessions/current`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setCurrentSession(data.session);
      } catch (err) {
        console.error('Failed to load current session:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live sync via socket.
  useEffect(() => {
    if (!socket) return;

    const onStarted = (session) => {
      setCurrentSession(session);
      // Push the just-ended session into the past list optimistically;
      // refetch on demand picks up the canonical state.
    };
    const onRenamed = ({ id, name }) => {
      setCurrentSession(prev =>
        prev && prev.id === id ? { ...prev, name } : prev
      );
    };

    socket.on('sessionStarted', onStarted);
    socket.on('sessionRenamed', onRenamed);
    return () => {
      socket.off('sessionStarted', onStarted);
      socket.off('sessionRenamed', onRenamed);
    };
  }, [socket]);

  const renameSession = useCallback(async (name) => {
    const res = await fetch(`${API_URL}/api/sessions/current`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    setCurrentSession(data.session);
    return data.session;
  }, []);

  const endAndStartNew = useCallback(async (newSessionName) => {
    const body = newSessionName ? { newSessionName } : {};
    const res = await fetch(`${API_URL}/api/sessions/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    setCurrentSession(data.session);
    return data.session;
  }, []);

  const refreshPastSessions = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/sessions`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const list = data.sessions || [];
    setPastSessions(list);
    return list;
  }, []);

  const value = {
    currentSession,
    pastSessions,
    renameSession,
    endAndStartNew,
    refreshPastSessions,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
