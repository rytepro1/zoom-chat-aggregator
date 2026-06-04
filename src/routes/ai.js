import { Router } from 'express';
import { requireAdmin } from '../auth/middleware.js';

/**
 * AI auto-responder routes (docs/backend/ai.md). All mounted under
 * /api/ai, so the global requireAuth middleware applies — req.org.id and
 * req.user are populated.
 *
 * The per-org engine lives on OrgState; every handler resolves it via
 * `await orgState.get(req.org.id)` and delegates to the AIResponder. The
 * engine owns all socket emits (`ai:*`), so these routes just return the
 * resulting view object.
 *
 *   GET    /api/ai/state               — settings + all FAQs (panel hydrate)
 *   GET    /api/ai/settings            — settings only
 *   PATCH  /api/ai/settings            — admin: master toggle + tunables
 *   GET    /api/ai/faqs                — list current-session FAQs
 *   POST   /api/ai/faqs                — pre-seed a known FAQ (active)
 *   POST   /api/ai/faqs/:id/approve    — supply answer → pending becomes active
 *   PATCH  /api/ai/faqs/:id            — edit question/answer
 *   POST   /api/ai/faqs/:id/pause      — stop auto-replying
 *   POST   /api/ai/faqs/:id/resume     — resume auto-replying
 *   DELETE /api/ai/faqs/:id            — dismiss
 *   GET    /api/ai/faqs/:id/events     — audit log for one FAQ
 */
export default function aiRouter() {
  const router = Router();

  const ai = async (req) => {
    const orgState = req.app.get('orgState');
    const { ai } = await orgState.get(req.org.id);
    return ai;
  };

  const fail = (res, err, label) => {
    console.error(`[ai routes] ${label} failed:`, err.message);
    res.status(/required|invalid/i.test(err.message) ? 400 : 500).json({ error: err.message });
  };

  router.get('/state', async (req, res) => {
    try {
      res.json((await ai(req)).getStateSnapshot());
    } catch (err) { fail(res, err, 'GET /state'); }
  });

  router.get('/settings', async (req, res) => {
    try {
      res.json({ settings: (await ai(req)).getSettings() });
    } catch (err) { fail(res, err, 'GET /settings'); }
  });

  router.patch('/settings', requireAdmin, async (req, res) => {
    try {
      const settings = await (await ai(req)).updateSettings(req.body || {});
      res.json({ settings });
    } catch (err) { fail(res, err, 'PATCH /settings'); }
  });

  router.get('/faqs', async (req, res) => {
    try {
      res.json({ faqs: (await ai(req)).listFaqs() });
    } catch (err) { fail(res, err, 'GET /faqs'); }
  });

  router.post('/faqs', async (req, res) => {
    try {
      const { question, answer } = req.body || {};
      const faq = await (await ai(req)).seedFaq({ question, answer, userId: req.user?.id ?? null });
      res.status(201).json({ faq });
    } catch (err) { fail(res, err, 'POST /faqs'); }
  });

  router.post('/faqs/:id/approve', async (req, res) => {
    try {
      const { answer } = req.body || {};
      const faq = await (await ai(req)).approveFaq(req.params.id, { answer, userId: req.user?.id ?? null });
      if (!faq) return res.status(404).json({ error: 'FAQ not found' });
      res.json({ faq });
    } catch (err) { fail(res, err, 'POST /faqs/:id/approve'); }
  });

  router.patch('/faqs/:id', async (req, res) => {
    try {
      const { question, answer } = req.body || {};
      const faq = await (await ai(req)).editFaq(req.params.id, { question, answer });
      if (!faq) return res.status(404).json({ error: 'FAQ not found' });
      res.json({ faq });
    } catch (err) { fail(res, err, 'PATCH /faqs/:id'); }
  });

  router.post('/faqs/:id/pause', async (req, res) => {
    try {
      const faq = await (await ai(req)).pauseFaq(req.params.id, req.body?.reason || 'Paused by moderator');
      if (!faq) return res.status(404).json({ error: 'FAQ not found' });
      res.json({ faq });
    } catch (err) { fail(res, err, 'POST /faqs/:id/pause'); }
  });

  router.post('/faqs/:id/resume', async (req, res) => {
    try {
      const faq = await (await ai(req)).resumeFaq(req.params.id);
      if (!faq) return res.status(400).json({ error: 'FAQ not found or has no answer to resume' });
      res.json({ faq });
    } catch (err) { fail(res, err, 'POST /faqs/:id/resume'); }
  });

  router.delete('/faqs/:id', async (req, res) => {
    try {
      const ok = await (await ai(req)).dismissFaq(req.params.id);
      if (!ok) return res.status(404).json({ error: 'FAQ not found' });
      res.json({ success: true });
    } catch (err) { fail(res, err, 'DELETE /faqs/:id'); }
  });

  router.get('/faqs/:id/events', async (req, res) => {
    try {
      res.json({ events: await (await ai(req)).getFaqEvents(req.params.id) });
    } catch (err) { fail(res, err, 'GET /faqs/:id/events'); }
  });

  return router;
}
