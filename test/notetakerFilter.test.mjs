import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNotetakerSender, isNotetakerContent, isNotetakerMessage } from '../src/services/notetakerFilter.js';

test('flags Otter notetaker formats by sender', () => {
  assert.equal(isNotetakerSender("Shwetha's Notetaker (Otter.ai)"), true);
  assert.equal(isNotetakerSender('Otter.ai'), true);
});

test('flags other common notetaker vendors by sender', () => {
  assert.equal(isNotetakerSender('Fireflies.ai'), true);
  assert.equal(isNotetakerSender('Fathom Notetaker'), true);
  assert.equal(isNotetakerSender('Read.ai'), true);
  assert.equal(isNotetakerSender('tl;dv'), true);
});

test('does NOT flag our own bot or real attendees by sender', () => {
  assert.equal(isNotetakerSender('Support Bot'), false);
  assert.equal(isNotetakerSender('Theo'), false);
  assert.equal(isNotetakerSender('Olga Rosemill'), false);
  assert.equal(isNotetakerSender('Audience Q&A'), false);
});

test('catches the Otter upsell posted under a REAL attendee name (content match)', () => {
  // Sender is a human; the Otter signal is only in the body — the case
  // that a sender-only filter would miss.
  const sender = 'Nicole';
  const content =
    'Nicole is on a Basic Otter plan with 30 minute meetings. To record ' +
    'longer meetings, upgrade to Pro: https://otter.ai/pricing?utm_source=oa-chat-basic';
  assert.equal(isNotetakerSender(sender), false);          // sender alone wouldn't catch it
  assert.equal(isNotetakerContent(content), true);         // content does
  assert.equal(isNotetakerMessage({ sender, content }), true);
});

test('does NOT filter a human casually mentioning otter', () => {
  assert.equal(isNotetakerContent('has anyone tried otter for notes?'), false);
  assert.equal(isNotetakerMessage({ sender: 'Dave', content: 'i love otter.ai honestly' }), false);
});

test('handles empty / missing fields', () => {
  assert.equal(isNotetakerSender(''), false);
  assert.equal(isNotetakerSender(null), false);
  assert.equal(isNotetakerContent(undefined), false);
  assert.equal(isNotetakerMessage({}), false);
});

test('is case-insensitive (sender + content)', () => {
  assert.equal(isNotetakerSender('OTTER.AI BOT'), true);
  assert.equal(isNotetakerContent('UPGRADE: HTTPS://OTTER.AI/PRICING'), true);
});
