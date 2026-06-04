import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import webhookRoutes from '../routes/webhook.js';
import authRouter from '../routes/auth.js';
import billingRouter from '../routes/billing.js';
import invitationsRouter from '../routes/invitations.js';
import presenterNotesRouter from '../routes/presenterNotes.js';
import aiRouter from '../routes/ai.js';
import { StripeService } from '../services/StripeService.js';
import { AIClient } from '../services/AIClient.js';
import { setupSocketHandlers } from './socketHandler.js';
import { RosterManager } from '../services/RosterManager.js';
import { ZoomCredentialsService } from '../services/ZoomCredentialsService.js';
import { OrgState } from '../services/OrgState.js';
import { TrialEnforcer } from '../services/TrialEnforcer.js';
import { RTMSManager } from '../rtms/RTMSManager.js';
import { RecallBotManager } from '../recall/RecallBotManager.js';
import { initDatabase } from '../db/index.js';
import { attachUser, requireAuth, requireAdmin } from '../auth/middleware.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? true
      : ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Singletons that aren't per-org:
//   - rosterManager (CRUD layer; orgId passed per-call)
//   - recallBotManager (one Recall workspace, bot records carry orgId)
//   - rtmsManager (legacy fallback; kept alive for the unused Zoom webhook path)
//   - orgState (lazy per-org MessageAggregator + SessionManager)
const rosterManager = new RosterManager();
const zoomCreds = new ZoomCredentialsService();
const rtmsManager = new RTMSManager();
const recallBotManager = new RecallBotManager({
  apiKey: process.env.RECALL_API_KEY,
  apiBase: process.env.RECALL_API_BASE,
  publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL,
});
const useRecall = recallBotManager.isConfigured();
// Shared Anthropic client for the AI auto-responder. Inert (feature
// disabled) when ANTHROPIC_API_KEY is unset. Handed to OrgState so each
// per-org AIResponder can classify chat + send auto-replies via Recall.
const aiClient = new AIClient({ apiKey: process.env.ANTHROPIC_API_KEY });
const orgState = new OrgState({ io, recallBotManager, aiClient });
// TrialEnforcer is constructed without db here; start() is called from
// start() once db is initialized.
const trialEnforcer = new TrialEnforcer({ db: null, io, recallBotManager, orgState });
const stripeService = new StripeService({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
});

app.set('rosterManager', rosterManager);
app.set('zoomCreds', zoomCreds);
app.set('rtmsManager', rtmsManager);
app.set('recallBotManager', recallBotManager);
app.set('orgState', orgState);
app.set('trialEnforcer', trialEnforcer);
app.set('stripeService', stripeService);
app.set('aiClient', aiClient);
app.set('io', io);

// ---- Middleware ----
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? true
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Soft-attach req.user / req.org if a valid session cookie is present.
app.use((req, res, next) => {
  const db = app.get('db');
  if (!db) return next();
  return attachUser(db)(req, res, next);
});

// ---- Public routes (no auth) ----

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  res.json({
    botPath: useRecall ? 'recall' : 'rtms-mock',
    recall: {
      configured: recallBotManager.isConfigured(),
      apiBase: recallBotManager.apiBase,
      publicWebhookUrl: recallBotManager.publicWebhookUrl,
      webhookSignatureEnforced: Boolean(process.env.RECALL_WEBHOOK_SECRET),
      activeBots: recallBotManager.getActiveConnections().length,
    },
    rtms: {
      mockMode: rtmsManager.useMockMode,
      activeConnections: rtmsManager.getActiveConnections().length,
    },
    ai: {
      configured: aiClient.isConfigured(),
    },
  });
});

// Webhook routes (HMAC-verified, never user-authenticated)
app.use('/webhook', webhookRoutes);

// Auth routes (signup, login, logout, /me, verify-email, password-reset)
app.use('/api/auth', authRouter());

// Billing routes (Stripe Checkout + Customer Portal). Mounted under
// /api so the requireAuth middleware below catches both.
app.use('/api/billing', billingRouter());

// Invitations routes — admin ops require auth (applied per-route),
// /accept/:token + POST /accept are public. Mounted BEFORE the global
// requireAuth gate so the public routes stay public.
app.use('/api/invitations', invitationsRouter());

// ---- Authenticated /api/* routes ----
//
// Everything below this line requires a valid session AND uses req.org.id
// for org isolation. Per-org runtime state comes from
// `await orgState.get(req.org.id)`.

app.use('/api', requireAuth);

// Presenter notes — mounted under /api so requireAuth applies above.
// Any signed-in role can send/dismiss; org isolation via req.org.id.
app.use('/api/presenter-notes', presenterNotesRouter());

// AI auto-responder — settings + FAQ CRUD. requireAuth applies (above);
// settings PATCH is admin-gated inside the router.
app.use('/api/ai', aiRouter());

// Helper to grab the requesting user's org state on demand.
async function org(req) {
  return orgState.get(req.org.id);
}

// ---- Meetings ----

app.get('/api/meetings', async (req, res) => {
  const connections = useRecall
    ? recallBotManager.getActiveConnections(req.org.id)
    : rtmsManager.getActiveConnections();
  res.json({
    meetings: connections.map(conn => ({
      id: conn.meetingId,
      meetingId: conn.meetingId,
      roomName: conn.roomName,
      status: conn.scheduledFor ? 'scheduled' : 'connected',
      scheduledFor: conn.scheduledFor || null,
      isMock: conn.isMock,
      connectedAt: conn.connectedAt,
    })),
  });
});

app.post('/api/meetings/connect', async (req, res) => {
  const { meetingId, passcode, roomName, roomColor, botName, scheduledFor, meetingUrl } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'Meeting ID is required' });
  if (useRecall && (!botName || !String(botName).trim())) {
    return res.status(400).json({
      error: 'Bot Display Name is required — this is how the bot will appear to participants.',
    });
  }

  // Phase 3 gate: concurrent-bot cap + trial-minutes check.
  const check = await trialEnforcer.checkCanDispatch(req.org);
  if (!check.allowed) {
    return res.status(check.code || 402).json({
      error: check.reason,
      upgradeUrl: check.upgradeUrl,
    });
  }

  const cleanMeetingId = meetingId.replace(/[\s-]/g, '');
  const finalRoomName = roomName || `Meeting ${cleanMeetingId}`;
  const finalRoomColor = roomColor || '#ef4444';

  try {
    const { ma } = await org(req);
    if (useRecall) {
      // RecallBotManager needs orgState wired so handleChatEvent can
      // route inbound webhooks to the right org's MA.
      recallBotManager.orgState = orgState;
      recallBotManager.db = app.get('db');
      await recallBotManager.connect(req.org.id, cleanMeetingId, passcode, finalRoomName, finalRoomColor, botName, scheduledFor || null, meetingUrl || null);
    } else {
      await rtmsManager.connect(cleanMeetingId, null, finalRoomName, finalRoomColor);
    }

    ma.addRoom({
      id: cleanMeetingId,
      name: finalRoomName,
      color: finalRoomColor,
      participantCount: 0,
    });

    const isMock = useRecall ? false : rtmsManager.useMockMode;
    io.to(`org:${req.org.id}`).emit('meetingConnected', {
      id: cleanMeetingId,
      meetingId: cleanMeetingId,
      roomName: finalRoomName,
      roomColor: finalRoomColor,
      status: 'connected',
      isMock,
    });

    const message = useRecall
      ? 'Bot dispatched to meeting via Recall.ai'
      : (rtmsManager.useMockMode ? 'Connected in mock mode' : 'Connected to meeting stream');
    res.json({ success: true, id: cleanMeetingId, message, isMock });
  } catch (error) {
    console.error('Failed to connect to meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to connect to meeting' });
  }
});

app.post('/api/meetings/:id/disconnect', async (req, res) => {
  const { id } = req.params;
  try {
    const { ma } = await org(req);
    if (useRecall) {
      await recallBotManager.disconnect(req.org.id, id);
    } else {
      rtmsManager.disconnect(id);
    }
    ma.removeRoom(id);
    io.to(`org:${req.org.id}`).emit('meetingDisconnected', { id });
    res.json({ success: true, message: 'Disconnected from meeting' });
  } catch (error) {
    console.error('Failed to disconnect from meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to disconnect' });
  }
});

// ---- Sessions ----

app.get('/api/sessions/current', async (req, res) => {
  const { sm } = await org(req);
  res.json({ session: sm.getCurrent() });
});

app.patch('/api/sessions/current', async (req, res) => {
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const { sm } = await org(req);
    const session = await sm.rename(name);
    res.json({ session });
  } catch (err) {
    console.error('PATCH /api/sessions/current failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const { sm } = await org(req);
    const sessions = await sm.list({ limit: 100 });
    res.json({ sessions });
  } catch (err) {
    console.error('GET /api/sessions failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/end', async (req, res) => {
  try {
    const { sm, ma } = await org(req);
    const newSession = await sm.end({ newSessionName: req.body?.newSessionName });
    ma.clearMessages();
    res.json({ session: newSession });
  } catch (err) {
    console.error('POST /api/sessions/end failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Saved messages ----

app.post('/api/messages/:id/save', async (req, res) => {
  const { id } = req.params;
  const note = req.body?.note ?? null;
  try {
    const { ma } = await org(req);
    const message = await ma.setSaved(id, true, note);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message });
  } catch (err) {
    console.error(`POST /api/messages/${id}/save failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:id/save', async (req, res) => {
  const { id } = req.params;
  try {
    const { ma } = await org(req);
    const message = await ma.setSaved(id, false, null);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message });
  } catch (err) {
    console.error(`DELETE /api/messages/${id}/save failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/saved', async (req, res) => {
  const sessionId = req.query.session_id || undefined;
  try {
    const { ma } = await org(req);
    const messages = await ma.getSavedMessages({ sessionId });
    res.json({ messages });
  } catch (err) {
    console.error('GET /api/saved failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/saved/export.csv', async (req, res) => {
  const sessionId = req.query.session_id || undefined;
  try {
    const { ma } = await org(req);
    const messages = await ma.getSavedMessages({ sessionId });
    const rows = [
      ['timestamp', 'room', 'sender', 'content', 'note'],
      ...messages.map(m => [m.timestamp, m.room, m.sender, m.content, m.note || '']),
    ];
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="zoomchat-saved.csv"');
    res.send(csv);
  } catch (err) {
    console.error('GET /api/saved/export.csv failed:', err);
    res.status(500).json({ error: err.message });
  }
});

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ---- Outbound chat ----

app.post('/api/meetings/:meetingId/reply', async (req, res) => {
  if (!useRecall) {
    return res.status(503).json({ error: 'Sending chat requires the Recall path (currently in mock mode).' });
  }
  const { meetingId } = req.params;
  const text = req.body?.text;
  try {
    const { ma } = await org(req);
    const result = await recallBotManager.sendChatToMeeting(req.org.id, meetingId, text);
    const botInfo = recallBotManager.botsByMeeting.get(meetingId);
    if (botInfo) {
      await ma.addMessage({
        sender: botInfo.botName,
        content: text,
        room: botInfo.roomName,
        roomColor: botInfo.roomColor,
        meetingId,
        timestamp: new Date().toISOString(),
        type: 'reply',
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`POST /api/meetings/${meetingId}/reply failed:`, err.message);
    const status = /rate limit/i.test(err.message)
      ? 429
      : /no active bot|does not belong|required/i.test(err.message)
        ? 400
        : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  if (!useRecall) {
    return res.status(503).json({ error: 'Broadcast requires the Recall path (currently in mock mode).' });
  }
  const text = req.body?.text;
  try {
    const { ma } = await org(req);
    const results = await recallBotManager.broadcastChat(req.org.id, text);
    for (const r of results) {
      if (!r.ok) continue;
      const botInfo = recallBotManager.botsByMeeting.get(r.meetingId);
      if (!botInfo) continue;
      await ma.addMessage({
        sender: botInfo.botName,
        content: text,
        room: botInfo.roomName,
        roomColor: botInfo.roomColor,
        meetingId: r.meetingId,
        timestamp: new Date().toISOString(),
        type: 'broadcast',
      });
    }
    res.json({
      success: true,
      sent: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err) {
    console.error('POST /api/broadcast failed:', err.message);
    res.status(/no active bots|required/i.test(err.message) ? 400 : 500)
       .json({ error: err.message });
  }
});

// Alias building blocks. panelistToken is a tiny FNV-1a hash → 4 base36
// chars; it is replicated verbatim in client/src/components/RostersPanel.jsx
// so the editor preview matches what gets registered. Keep them in sync.
function panelistSlug(s, max = 16) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, max);
}
function panelistToken(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, '0');
}

// Derive a unique panelist alias: base "zoomchat@ryte.com" + org
// "UgenticAI" + room "Zoom 5" + webinar id → "zoomchat+ugenticai-zoom5-7f3a@ryte.com".
// The token is a deterministic hash of the webinar id, so the alias is
// globally unique (even across clients sharing the base mailbox) yet
// stable across re-registrations. De-dupes within a roster via `used`.
// Returns null if no/invalid base email.
function derivePanelistAlias(base, orgName, roomName, meetingId, used) {
  const at = String(base || '').indexOf('@');
  if (at <= 0) return null;
  const local = base.slice(0, at);
  const domain = base.slice(at + 1);
  if (!domain.includes('.')) return null;
  const org = panelistSlug(orgName);
  const room = panelistSlug(roomName) || panelistSlug(meetingId) || 'room';
  const suffix = [org, room, panelistToken(meetingId)].filter(Boolean).join('-');
  let candidate = `${local}+${suffix}@${domain}`.toLowerCase();
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${local}+${suffix}-${n}@${domain}`.toLowerCase();
    n++;
  }
  used.add(candidate);
  return candidate;
}

// ---- Rosters ----

app.get('/api/rosters', async (req, res) => {
  if (!rosterManager.isAvailable()) return res.json({ rosters: [] });
  try {
    res.json({ rosters: await rosterManager.list(req.org.id) });
  } catch (err) {
    console.error('GET /api/rosters failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rosters/:id', async (req, res) => {
  try {
    const roster = await rosterManager.get(req.org.id, req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    res.json({ roster });
  } catch (err) {
    console.error(`GET /api/rosters/${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rosters', async (req, res) => {
  if (!rosterManager.isAvailable()) {
    return res.status(503).json({ error: 'Roster storage requires the database.' });
  }
  const { name, entries = [], scheduledFor = null } = req.body || {};
  try {
    rosterManager.validateEntries(entries);
    const roster = await rosterManager.create(req.org.id, { name, entries, scheduledFor });
    res.status(201).json({ roster });
  } catch (err) {
    console.error('POST /api/rosters failed:', err);
    res.status(/required|empty|invalid/i.test(err.message) ? 400 : 500)
       .json({ error: err.message });
  }
});

app.patch('/api/rosters/:id', async (req, res) => {
  if (!rosterManager.isAvailable()) {
    return res.status(503).json({ error: 'Roster storage requires the database.' });
  }
  const { name, entries, scheduledFor } = req.body || {};
  try {
    if (Array.isArray(entries)) rosterManager.validateEntries(entries);
    const roster = await rosterManager.update(req.org.id, req.params.id, { name, entries, scheduledFor });
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    res.json({ roster });
  } catch (err) {
    console.error(`PATCH /api/rosters/${req.params.id} failed:`, err);
    res.status(/required|empty|invalid/i.test(err.message) ? 400 : 500)
       .json({ error: err.message });
  }
});

app.delete('/api/rosters/:id', async (req, res) => {
  if (!rosterManager.isAvailable()) {
    return res.status(503).json({ error: 'Roster storage requires the database.' });
  }
  try {
    const removed = await rosterManager.delete(req.org.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Roster not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(`DELETE /api/rosters/${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rosters/:id/deploy', async (req, res) => {
  if (!useRecall) {
    return res.status(503).json({ error: 'Deploy requires the Recall path (currently in mock mode).' });
  }
  try {
    const { ma } = await org(req);
    const roster = await rosterManager.get(req.org.id, req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    if (roster.entries.length === 0) {
      return res.status(400).json({ error: 'Roster has no meetings to deploy' });
    }

    // Phase 3 gate: trial users can't deploy a roster larger than their
    // concurrent cap. Pre-flight check so we don't dispatch some and reject
    // the rest mid-deploy.
    const check = await trialEnforcer.checkCanDispatch(req.org);
    if (!check.allowed) {
      return res.status(check.code || 402).json({
        error: check.reason,
        upgradeUrl: check.upgradeUrl,
      });
    }
    const activeBots = recallBotManager.getActiveConnections(req.org.id).length;
    if (activeBots + roster.entries.length > req.org.concurrentBotLimit) {
      return res.status(402).json({
        error: `This roster has ${roster.entries.length} meetings but your plan allows only ${req.org.concurrentBotLimit} concurrent bot(s) (currently ${activeBots} active). Upgrade to deploy larger rosters.`,
        upgradeUrl: trialEnforcer._upgradeUrl(),
      });
    }

    recallBotManager.orgState = orgState;
    recallBotManager.db = app.get('db');

    const results = await Promise.allSettled(
      roster.entries.map(async (entry) => {
        await recallBotManager.connect(
          req.org.id,
          entry.meeting_id,
          entry.passcode,
          entry.room_name,
          entry.room_color,
          entry.bot_name,
          roster.scheduled_for || null,
          entry.meeting_url || null,
        );
        ma.addRoom({
          id: entry.meeting_id,
          name: entry.room_name,
          color: entry.room_color,
          participantCount: 0,
        });
        io.to(`org:${req.org.id}`).emit('meetingConnected', {
          id: entry.meeting_id,
          meetingId: entry.meeting_id,
          roomName: entry.room_name,
          roomColor: entry.room_color,
          status: 'connected',
          isMock: false,
        });
        return { meetingId: entry.meeting_id, roomName: entry.room_name };
      })
    );

    const detailed = results.map((r, i) => ({
      meetingId: roster.entries[i].meeting_id,
      roomName: roster.entries[i].room_name,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : null,
    }));
    res.json({
      total: roster.entries.length,
      succeeded: detailed.filter(d => d.ok).length,
      failed: detailed.filter(d => !d.ok).length,
      results: detailed,
    });
  } catch (err) {
    console.error(`POST /api/rosters/${req.params.id}/deploy failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Zoom integration (per-org S2S creds → webinar panelist auto-registration) ----

// Status for the Settings UI. Never returns the client secret. Any
// signed-in org member can read whether Zoom is connected.
app.get('/api/zoom/credentials', async (req, res) => {
  try {
    const status = await zoomCreds.getStatus(req.org.id);
    // System-wide default base (e.g. zoomchat@ryteproductions.com) is used
    // for alias derivation when an org hasn't set its own base. effective
    // is what the UI previews + what registration will actually use.
    const systemEmailBase = process.env.PANELIST_EMAIL_BASE || null;
    res.json({
      ...status,
      systemEmailBase,
      effectiveEmailBase: status.panelistEmailBase || systemEmailBase,
      orgSlug: panelistSlug(req.org.name),
    });
  } catch (err) {
    console.error('GET /api/zoom/credentials failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save / update creds — admin only. clientSecret may be omitted to keep
// the stored one (the UI never reads it back).
app.put('/api/zoom/credentials', requireAdmin, async (req, res) => {
  const { accountId, clientId, clientSecret } = req.body || {};
  try {
    res.json(await zoomCreds.save(req.org.id, { accountId, clientId, clientSecret }));
  } catch (err) {
    console.error('PUT /api/zoom/credentials failed:', err);
    res.status(/required|missing|CRED_ENCRYPTION/i.test(err.message) ? 400 : 500)
       .json({ error: err.message });
  }
});

app.delete('/api/zoom/credentials', requireAdmin, async (req, res) => {
  try {
    await zoomCreds.remove(req.org.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/zoom/credentials failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify saved creds against Zoom. Mints a token (proves account/client
// creds) and, if a webinarId is supplied, lists its panelists (proves
// the scopes + Webinar add-on). Returns ok:false with a plain-English
// message rather than an error status so the UI can render it directly.
app.post('/api/zoom/credentials/test', requireAdmin, async (req, res) => {
  try {
    const client = await zoomCreds.clientForOrg(req.org.id);
    if (!client) {
      return res.json({ ok: false, error: 'No Zoom credentials saved yet — save them first, then test.' });
    }
    const webinarId = req.body?.webinarId ? String(req.body.webinarId).replace(/[\s-]/g, '') : null;
    const result = await client.verifyAccess(webinarId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Register every webinar entry's panelist email as a Zoom panelist, and
// store the returned join_url back on the entry's meeting_url so a
// subsequent Deploy joins the bot AS a panelist. Idempotent per entry.
app.post('/api/rosters/:id/register-panelists', async (req, res) => {
  if (!rosterManager.isAvailable()) {
    return res.status(503).json({ error: 'Roster storage requires the database.' });
  }
  try {
    const roster = await rosterManager.get(req.org.id, req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });

    const client = await zoomCreds.clientForOrg(req.org.id);
    if (!client) {
      return res.status(400).json({ error: 'Connect your Zoom account in Settings → Zoom Integration first.' });
    }

    // An entry is in scope if the operator opted it in (register_panelist)
    // or set an explicit email (back-compat). Meetings (neither) are skipped.
    const targets = roster.entries.filter(
      (e) => e.register_panelist || (e.panelist_email && String(e.panelist_email).trim())
    );
    if (targets.length === 0) {
      return res.status(400).json({
        error: 'No webinar entries to register. Tick "auto-register bot as panelist" on your webinar entries (or set an explicit email).',
      });
    }

    const status = await zoomCreds.getStatus(req.org.id);
    // Org override first, then the system-wide default base.
    const base = status?.panelistEmailBase || process.env.PANELIST_EMAIL_BASE || null;
    // Seed the de-dupe set with any explicit emails already in use.
    const used = new Set(
      targets
        .filter((e) => e.panelist_email && String(e.panelist_email).trim())
        .map((e) => String(e.panelist_email).trim().toLowerCase())
    );

    // Sequential on purpose: webinar management APIs have stricter rate
    // limits than meeting APIs, and a roster is only a handful of rooms.
    const results = [];
    for (const entry of targets) {
      const explicit = entry.panelist_email && String(entry.panelist_email).trim()
        ? String(entry.panelist_email).trim().toLowerCase()
        : null;
      const email = explicit || derivePanelistAlias(base, req.org.name, entry.room_name, entry.meeting_id, used);
      const row = { meetingId: entry.meeting_id, roomName: entry.room_name, email };
      if (!email) {
        results.push({ ...row, ok: false, error: 'No panelist email — set a base email in Settings → Zoom Integration, or enter one on this entry.' });
        continue;
      }
      try {
        const { join_url, added } = await client.ensurePanelistJoinUrl(entry.meeting_id, {
          name: entry.bot_name,
          email,
        });
        await rosterManager.updateEntryRegistration(entry.id, join_url, email);
        results.push({ ...row, ok: true, added });
      } catch (err) {
        results.push({ ...row, ok: false, error: err.message });
      }
    }

    res.json({
      total: targets.length,
      registered: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      skipped: roster.entries.length - targets.length,
      results,
    });
  } catch (err) {
    console.error(`POST /api/rosters/${req.params.id}/register-panelists failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Org settings (per-org runtime toggles) ----

// Read org settings for the Settings UI. Any signed-in member can read.
app.get('/api/org/settings', async (req, res) => {
  try {
    const db = app.get('db');
    const { rows } = await db.query(
      `SELECT notetaker_filter_enabled FROM organizations WHERE id = $1`,
      [req.org.id]
    );
    res.json({ notetakerFilterEnabled: rows[0]?.notetaker_filter_enabled !== false });
  } catch (err) {
    console.error('GET /api/org/settings failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update org settings — admin only. Persists to the org row AND live-
// updates the running MessageAggregator so the change takes effect
// immediately (no restart). (The NOTETAKER_FILTER_DISABLED env var still
// hard-overrides globally on top of this.)
app.patch('/api/org/settings', requireAdmin, async (req, res) => {
  try {
    const db = app.get('db');
    if (typeof req.body?.notetakerFilterEnabled === 'boolean') {
      await db.query(
        `UPDATE organizations SET notetaker_filter_enabled = $2 WHERE id = $1`,
        [req.org.id, req.body.notetakerFilterEnabled]
      );
      const entry = orgState.peek(req.org.id);
      if (entry?.ma) entry.ma.notetakerFilterEnabled = req.body.notetakerFilterEnabled;
    }
    const { rows } = await db.query(
      `SELECT notetaker_filter_enabled FROM organizations WHERE id = $1`,
      [req.org.id]
    );
    res.json({ notetakerFilterEnabled: rows[0]?.notetaker_filter_enabled !== false });
  } catch (err) {
    console.error('PATCH /api/org/settings failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Static client ----

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(__dirname, '../../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '../../client/dist/index.html'));
  });
}

const PORT = process.env.PORT || 3001;

async function start() {
  const db = await initDatabase({ databaseUrl: process.env.DATABASE_URL });
  app.set('db', db);
  orgState.db = db;
  rosterManager.db = db;
  zoomCreds.db = db;
  recallBotManager.db = db;
  recallBotManager.orgState = orgState;
  trialEnforcer.db = db;
  stripeService.db = db;

  // Register Socket.io handlers now that `db` is available (the auth
  // middleware needs it on every handshake).
  setupSocketHandlers(io, { db, orgState });

  // Start the trial enforcer tick loop (every 30s). No-op when db is null.
  trialEnforcer.start();

  httpServer.listen(PORT, () => {
    const botPath = useRecall ? 'Recall.ai' : `RTMS (${rtmsManager.useMockMode ? 'mock' : 'live'})`;
    const persistence = db ? 'Postgres' : 'in-memory only';
    console.log(`
╔════════════════════════════════════════════════════════════╗
║         Zoom Chat Aggregator — Phase 2                     ║
╠════════════════════════════════════════════════════════════╣
║  Server:        http://localhost:${PORT}                       ║
║  Health:        http://localhost:${PORT}/health                ║
║  Bot path:      ${botPath.padEnd(44)}║
║  Persistence:   ${persistence.padEnd(44)}║
║  Auth:          required on /api/* (except /api/auth/*)    ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

export { app, io };
