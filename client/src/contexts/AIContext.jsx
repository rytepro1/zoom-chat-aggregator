import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const AIContext = createContext(null);

/**
 * Client state for the Smart Auto-Responder (docs/backend/ai.md). Mirrors
 * the per-org AIResponder: subscribes to the `ai:*` socket events for live
 * state, and exposes REST-backed actions the moderator drives from the AI
 * panel. The server owns the source of truth; socket events keep this in
 * sync, so actions mostly fire-and-forget and let the event reconcile.
 */
export function AIProvider({ children, socket }) {
  const [settings, setSettings] = useState({
    ai_enabled: false,
    ai_match_threshold: 0.85,
    ai_cooldown_seconds: 75,
    ai_recurring_threshold: 3,
    configured: false,
  });
  const [faqs, setFaqs] = useState([]);     // all non-dismissed FAQs
  const [alerts, setAlerts] = useState([]); // self-healing notices (newest-first)
  const [activity, setActivity] = useState([]); // recent auto-replies (newest-first)

  const upsertFaq = useCallback((faq) => {
    if (!faq?.id) return;
    setFaqs((prev) => {
      const rest = prev.filter((f) => f.id !== faq.id);
      return [...rest, faq];
    });
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onState = (payload) => {
      if (payload.settings) setSettings(payload.settings);
      if (Array.isArray(payload.faqs)) setFaqs(payload.faqs);
    };
    const onSettings = (payload) => payload.settings && setSettings(payload.settings);
    const onPending = (payload) => upsertFaq(payload.faq);
    const onUpdated = (payload) => upsertFaq(payload.faq);
    const onDismissed = ({ id }) => setFaqs((prev) => prev.filter((f) => f.id !== id));
    const onAutoReplied = (payload) => {
      if (payload.faq) upsertFaq(payload.faq);
      setActivity((prev) => [{ ...payload, at: Date.now(), key: `${payload.faq?.id}:${Date.now()}` }, ...prev].slice(0, 50));
    };
    const onFeedbackAlert = (payload) => {
      if (payload.faq) upsertFaq(payload.faq);
      setAlerts((prev) => [{ ...payload, at: Date.now(), key: `${payload.faq?.id}:${Date.now()}` }, ...prev].slice(0, 20));
    };

    socket.on('ai:state', onState);
    socket.on('ai:settings', onSettings);
    socket.on('ai:faqPending', onPending);
    socket.on('ai:faqUpdated', onUpdated);
    socket.on('ai:faqDismissed', onDismissed);
    socket.on('ai:autoReplied', onAutoReplied);
    socket.on('ai:feedbackAlert', onFeedbackAlert);
    // Ask for a fresh snapshot on (re)connect — the server also pushes one
    // on connect, but this covers a provider mount after connect.
    fetch('/api/ai/state', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && onState(d))
      .catch(() => {});

    return () => {
      socket.off('ai:state', onState);
      socket.off('ai:settings', onSettings);
      socket.off('ai:faqPending', onPending);
      socket.off('ai:faqUpdated', onUpdated);
      socket.off('ai:faqDismissed', onDismissed);
      socket.off('ai:autoReplied', onAutoReplied);
      socket.off('ai:feedbackAlert', onFeedbackAlert);
    };
  }, [socket, upsertFaq]);

  // ---- REST actions ----
  const api = useCallback(async (path, opts = {}) => {
    const res = await fetch(`/api/ai${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }, []);

  const updateSettings = useCallback(async (patch) => {
    const d = await api('/settings', { method: 'PATCH', body: JSON.stringify(patch) });
    if (d.settings) setSettings(d.settings);
    return d.settings;
  }, [api]);

  const seedFaq = useCallback(async ({ question, answer }) => {
    const d = await api('/faqs', { method: 'POST', body: JSON.stringify({ question, answer }) });
    if (d.faq) upsertFaq(d.faq);
    return d.faq;
  }, [api, upsertFaq]);

  const approveFaq = useCallback(async (id, { answer }) => {
    const d = await api(`/faqs/${id}/approve`, { method: 'POST', body: JSON.stringify({ answer }) });
    if (d.faq) upsertFaq(d.faq);
    return d.faq;
  }, [api, upsertFaq]);

  const editFaq = useCallback(async (id, fields) => {
    const d = await api(`/faqs/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    if (d.faq) upsertFaq(d.faq);
    return d.faq;
  }, [api, upsertFaq]);

  const pauseFaq = useCallback(async (id, reason) => {
    const d = await api(`/faqs/${id}/pause`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (d.faq) upsertFaq(d.faq);
    return d.faq;
  }, [api, upsertFaq]);

  const resumeFaq = useCallback(async (id) => {
    const d = await api(`/faqs/${id}/resume`, { method: 'POST' });
    if (d.faq) upsertFaq(d.faq);
    return d.faq;
  }, [api, upsertFaq]);

  const dismissFaq = useCallback(async (id) => {
    await api(`/faqs/${id}`, { method: 'DELETE' });
    setFaqs((prev) => prev.filter((f) => f.id !== id));
  }, [api]);

  const dismissAlert = useCallback((key) => {
    setAlerts((prev) => prev.filter((a) => a.key !== key));
  }, []);

  const pendingFaqs = faqs.filter((f) => f.status === 'pending');
  const activeFaqs = faqs.filter((f) => f.status === 'active');
  const pausedFaqs = faqs.filter((f) => f.status === 'paused');

  const value = {
    settings, faqs, pendingFaqs, activeFaqs, pausedFaqs, alerts, activity,
    updateSettings, seedFaq, approveFaq, editFaq, pauseFaq, resumeFaq, dismissFaq, dismissAlert,
  };

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

export function useAI() {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error('useAI must be used within an AIProvider');
  return ctx;
}
