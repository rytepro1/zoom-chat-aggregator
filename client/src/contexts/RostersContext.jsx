import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const RostersContext = createContext(null);

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

/**
 * State + CRUD for saved meeting rosters. Lists are fetched on mount
 * and after any mutation. Deploy returns per-entry results so the
 * panel can show partial-success feedback.
 */
export function RostersProvider({ children }) {
  const [rosters, setRosters] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/rosters`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRosters(data.rosters || []);
    } catch (err) {
      console.error('Failed to load rosters:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const fetchOne = useCallback(async (id) => {
    const res = await fetch(`${API_URL}/api/rosters/${id}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.roster;
  }, []);

  const createRoster = useCallback(async ({ name, entries, scheduledFor = null }) => {
    const res = await fetch(`${API_URL}/api/rosters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, entries, scheduledFor }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await refresh();
    const data = await res.json();
    return data.roster;
  }, [refresh]);

  const updateRoster = useCallback(async (id, { name, entries, scheduledFor }) => {
    const body = { name, entries };
    // Only send scheduledFor when the caller explicitly passes it
    // (including null to clear). undefined → don't touch the field.
    if (scheduledFor !== undefined) body.scheduledFor = scheduledFor;
    const res = await fetch(`${API_URL}/api/rosters/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await refresh();
    const data = await res.json();
    return data.roster;
  }, [refresh]);

  const deleteRoster = useCallback(async (id) => {
    const res = await fetch(`${API_URL}/api/rosters/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await refresh();
  }, [refresh]);

  const deployRoster = useCallback(async (id) => {
    const res = await fetch(`${API_URL}/api/rosters/${id}/deploy`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }, []);

  return (
    <RostersContext.Provider value={{
      rosters,
      loading,
      refresh,
      fetchOne,
      createRoster,
      updateRoster,
      deleteRoster,
      deployRoster,
    }}>
      {children}
    </RostersContext.Provider>
  );
}

export function useRosters() {
  const ctx = useContext(RostersContext);
  if (!ctx) throw new Error('useRosters must be used within RostersProvider');
  return ctx;
}
