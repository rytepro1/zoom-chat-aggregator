import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const AuthContext = createContext(null);

/**
 * AuthProvider — owns the auth state for the whole client.
 *
 * On mount, GETs /api/auth/me to see if there's an active session cookie
 * and hydrates `user` + `org`. Components can call `signup()`, `login()`,
 * `logout()` to mutate the state.
 *
 * `loading` is true until the initial /me check completes — guard
 * conditional renders on `loading` to avoid a flash of the login wall
 * for already-signed-in users.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      const data = await res.json();
      setUser(data.user);
      setOrg(data.org);
    } catch (e) {
      console.error('[auth] /me failed:', e);
      setUser(null);
      setOrg(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-fetch /me when the tab regains focus. Catches the common
  // "operator A upgraded the org in another browser, operator B's
  // tab still shows trial-exhausted modal" stale-state case without
  // requiring a manual refresh.
  useEffect(() => {
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      // visibilitychange's anonymous handler can't easily be removed;
      // unmounting AuthProvider is also app-lifetime so this is fine.
    };
  }, [refresh]);

  const signup = useCallback(async ({ email, password, orgName }) => {
    setError(null);
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password, orgName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || 'Signup failed');
      throw new Error(data.error || 'Signup failed');
    }
    await refresh();
    return data;
  }, [refresh]);

  const login = useCallback(async ({ email, password }) => {
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || 'Login failed');
      throw new Error(data.error || 'Login failed');
    }
    await refresh();
    return data;
  }, [refresh]);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    setOrg(null);
  }, []);

  const requestPasswordReset = useCallback(async (email) => {
    const res = await fetch('/api/auth/password-reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return res.ok;
  }, []);

  return (
    <AuthContext.Provider value={{
      user, org, loading, error,
      signup, login, logout, refresh, requestPasswordReset,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
