import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIResponder } from '../src/services/AIResponder.js';

/**
 * Integration tests for the Smart Auto-Responder engine. No DB and no real
 * Anthropic / Recall calls — the AIClient is stubbed with a deterministic
 * `decide` function and the recallBotManager is faked to capture sends.
 * AIResponder runs fully in-memory when db is null, so these assert the
 * deterministic gating logic end to end.
 */

function makeHarness({ decide } = {}) {
  const emitted = [];
  const sends = [];
  const fed = [];

  const io = {
    to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
  };
  const ma = { addMessage: async (m) => { fed.push(m); return m; } };
  const sm = { current: { id: 'sess-1' } };

  const botsByMeeting = new Map([
    ['mtg-1', { botId: 'bot-1', botName: 'Q&A Bot', roomName: 'Main', roomColor: '#fff', orgId: 'org-1' }],
  ]);
  const recallBotManager = {
    botsByMeeting,
    sendChatToMeeting: async (orgId, meetingId, text) => {
      sends.push({ orgId, meetingId, text });
    },
  };

  const aiClient = {
    isConfigured: () => true,
    classifyBatch: async ({ candidates }) => ({ results: candidates.map((c) => decide(c)) }),
  };

  const r = new AIResponder({
    db: null, io, orgId: 'org-1', ma, sm, recallBotManager, aiClient,
  });
  r.settings.ai_enabled = true;
  r._sessionId = 'sess-1';

  return { r, emitted, sends, fed };
}

// Drive ingest → tick deterministically (bypass the 6s timer).
async function ingestAndTick(r, messages) {
  for (const m of messages) r.ingest(m);
  r._flushTimer();
  await r._tick();
}

function q(id, text, participantId) {
  return { id, content: text, meetingId: 'mtg-1', room: 'Main', roomColor: '#fff', sender: 'Attendee', participantId, type: 'chat' };
}

test('3 distinct askers of the same intent create a pending FAQ', async () => {
  const { r, emitted } = makeHarness({
    decide: (c) => ({
      id: c.id, classification: 'question', normalizedIntent: 'vip session link',
      matchedFaqId: '', matchConfidence: 0, relatesToFaqId: '', complaintConfidence: 0, complaintType: 'none',
    }),
  });

  await ingestAndTick(r, [
    q('m1', 'where is the vip link?', 'p1'),
    q('m2', 'whats the link to the vip session?', 'p2'),
    q('m3', 'vip session link please?', 'p3'),
  ]);

  const pending = r.listFaqs().filter((f) => f.status === 'pending');
  assert.equal(pending.length, 1, 'one pending FAQ created');
  assert.ok(emitted.some((e) => e.event === 'ai:faqPending'), 'ai:faqPending emitted');
});

test('two askers do NOT trigger a pending FAQ (below threshold)', async () => {
  const { r } = makeHarness({
    decide: (c) => ({
      id: c.id, classification: 'question', normalizedIntent: 'wifi password',
      matchedFaqId: '', matchConfidence: 0, relatesToFaqId: '', complaintConfidence: 0, complaintType: 'none',
    }),
  });
  await ingestAndTick(r, [q('a1', 'what is the wifi password?', 'p1'), q('a2', 'wifi password?', 'p2')]);
  assert.equal(r.listFaqs().length, 0, 'no FAQ yet at 2 askers (threshold is 3)');
});

test('approved FAQ auto-replies once, then suppresses within cooldown', async () => {
  const { r, sends, fed, emitted } = makeHarness({ decide: () => ({}) });
  const faq = await r.seedFaq({ question: 'vip session link', answer: 'https://vip.example/join' });

  // Now classify incoming questions as matching that FAQ with high confidence.
  r.aiClient.classifyBatch = async ({ candidates }) => ({
    results: candidates.map((c) => ({
      id: c.id, classification: 'question', normalizedIntent: 'vip session link',
      matchedFaqId: faq.id, matchConfidence: 0.95, relatesToFaqId: '', complaintConfidence: 0, complaintType: 'none',
    })),
  });

  await ingestAndTick(r, [q('m1', 'where is the vip link?', 'p1')]);
  assert.equal(sends.length, 1, 'one auto-reply sent');
  assert.equal(sends[0].text, 'https://vip.example/join');
  assert.ok(fed.some((m) => m.type === 'ai_reply'), 'mirrored into feed as ai_reply');
  assert.ok(emitted.some((e) => e.event === 'ai:autoReplied'), 'ai:autoReplied emitted');

  // A different asker within the cooldown window → suppressed (no 2nd send).
  await ingestAndTick(r, [q('m2', 'link to vip session?', 'p2')]);
  assert.equal(sends.length, 1, 'second send suppressed by cooldown');
});

test('the same asker is never answered twice', async () => {
  const { r, sends } = makeHarness({ decide: () => ({}) });
  const faq = await r.seedFaq({ question: 'recording link', answer: 'https://rec.example' });
  r.settings.ai_cooldown_seconds = 0; // remove cooldown so only per-asker dedup is in play
  r.aiClient.classifyBatch = async ({ candidates }) => ({
    results: candidates.map((c) => ({
      id: c.id, classification: 'question', normalizedIntent: 'recording link',
      matchedFaqId: faq.id, matchConfidence: 0.99, relatesToFaqId: '', complaintConfidence: 0, complaintType: 'none',
    })),
  });
  await ingestAndTick(r, [q('m1', 'recording link?', 'pX')]);
  await ingestAndTick(r, [q('m2', 'where is the recording?', 'pX')]); // same participant
  assert.equal(sends.length, 1, 'same asker answered only once even with cooldown off');
});

test('a credible complaint pauses the FAQ and stops further sends', async () => {
  const { r, sends, emitted } = makeHarness({ decide: () => ({}) });
  const faq = await r.seedFaq({ question: 'vip link', answer: 'https://vip.example/join' });

  r.aiClient.classifyBatch = async ({ candidates }) => ({
    results: candidates.map((c) => ({
      id: c.id, classification: 'complaint', normalizedIntent: '',
      matchedFaqId: '', matchConfidence: 0, relatesToFaqId: faq.id, complaintConfidence: 0.95, complaintType: 'broken',
    })),
  });
  await ingestAndTick(r, [q('m1', 'that vip link is broken', 'p9')]);

  const after = r.listFaqs().find((f) => f.id === faq.id);
  assert.equal(after.status, 'paused', 'FAQ paused by self-healing');
  assert.ok(emitted.some((e) => e.event === 'ai:feedbackAlert'), 'ai:feedbackAlert emitted');

  // Now a matching question must NOT be auto-answered (FAQ is paused).
  r.aiClient.classifyBatch = async ({ candidates }) => ({
    results: candidates.map((c) => ({
      id: c.id, classification: 'question', normalizedIntent: 'vip link',
      matchedFaqId: faq.id, matchConfidence: 0.99, relatesToFaqId: '', complaintConfidence: 0, complaintType: 'none',
    })),
  });
  await ingestAndTick(r, [q('m2', 'vip link?', 'p10')]);
  assert.equal(sends.length, 0, 'no auto-reply while paused');
});

test('low-confidence match does not auto-reply (precision guard)', async () => {
  const { r, sends } = makeHarness({ decide: () => ({}) });
  const faq = await r.seedFaq({ question: 'vip link', answer: 'https://vip.example' });
  r.aiClient.classifyBatch = async ({ candidates }) => ({
    results: candidates.map((c) => ({
      id: c.id, classification: 'question', normalizedIntent: 'some link',
      matchedFaqId: faq.id, matchConfidence: 0.6, relatesToFaqId: '', complaintConfidence: 0, complaintType: 'none',
    })),
  });
  await ingestAndTick(r, [q('m1', 'whats that other link?', 'p1')]);
  assert.equal(sends.length, 0, 'below default 0.85 threshold → no send');
});

test('disabled responder ingests nothing', async () => {
  const { r, sends } = makeHarness({ decide: () => ({ classification: 'question' }) });
  r.settings.ai_enabled = false;
  await ingestAndTick(r, [q('m1', 'where is the link?', 'p1')]);
  assert.equal(r._buffer.length, 0, 'nothing buffered when disabled');
  assert.equal(sends.length, 0);
});
