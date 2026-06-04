/**
 * Notetaker-bot filter — drops chat from third-party AI notetaker bots
 * (Otter, Fireflies, Fathom, …) so they don't clutter the aggregated
 * feed.
 *
 * We CAN'T remove these bots from the Zoom room (our bot is a panelist,
 * not the host — there's no kick power/API). This only keeps their
 * automated chatter out of OUR feed, DB, and AI pipeline. The bots
 * remain in Zoom.
 *
 * Two signals, because notetaker spam shows up two ways:
 *   1. SENDER — the bot posts under its own name, e.g.
 *      "<Name>'s Notetaker (Otter.ai)".
 *   2. CONTENT — the notice is attributed to a real attendee's name but
 *      the body is the automated upsell, e.g. Nicole posting
 *      "…Basic Otter plan… upgrade to Pro: https://otter.ai/pricing…".
 *      A sender-only filter misses these, so we also match distinctive
 *      content signatures (vendor pricing URLs + the recording-notice
 *      phrasing) — kept specific to avoid filtering a human who merely
 *      mentions a vendor.
 *
 * Tune at runtime via env (read once at module load):
 *   NOTETAKER_FILTER_EXTRA=comma,names        (extra sender patterns)
 *   NOTETAKER_CONTENT_EXTRA=comma,phrases     (extra content patterns)
 *   NOTETAKER_FILTER_DISABLED=true            (kill switch)
 */

export const DEFAULT_NOTETAKER_PATTERNS = [
  'otter.ai',
  'otterpilot',
  'fireflies',
  'fathom',
  'read.ai',
  'readai',
  'tl;dv',
  'tldv',
  'avoma',
  'sembly',
  'tactiq',
  'fellow.app',
  'grain.com',
  'notetaker',
  'note taker',
];

// Distinctive of automated notetaker notices — safe to match anywhere in
// the message body. Vendor pricing/upgrade URLs + the recording-notice
// phrasing Otter et al. post on join.
export const DEFAULT_NOTETAKER_CONTENT_PATTERNS = [
  'otter.ai/pricing',
  'fireflies.ai/pricing',
  'fathom.video',
  'read.ai/pricing',
  'tldv.io/pricing',
  'basic otter plan',
  'to record longer meetings, upgrade',
];

const DISABLED = process.env.NOTETAKER_FILTER_DISABLED === 'true';

const envList = (name) =>
  (process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const SENDER_PATTERNS = [...DEFAULT_NOTETAKER_PATTERNS, ...envList('NOTETAKER_FILTER_EXTRA')];
const CONTENT_PATTERNS = [...DEFAULT_NOTETAKER_CONTENT_PATTERNS, ...envList('NOTETAKER_CONTENT_EXTRA')];

/** True if `sender` looks like a third-party notetaker bot. */
export function isNotetakerSender(sender) {
  if (DISABLED) return false;
  const name = String(sender || '').toLowerCase();
  if (!name) return false;
  for (const p of SENDER_PATTERNS) {
    if (name.includes(p)) return true;
  }
  return false;
}

/** True if `content` carries a notetaker's automated-notice signature. */
export function isNotetakerContent(content) {
  if (DISABLED) return false;
  const body = String(content || '').toLowerCase();
  if (!body) return false;
  for (const p of CONTENT_PATTERNS) {
    if (body.includes(p)) return true;
  }
  return false;
}

/**
 * True if a message (by sender OR content) is notetaker chatter. This is
 * what the ingestion path should call.
 */
export function isNotetakerMessage({ sender, content } = {}) {
  return isNotetakerSender(sender) || isNotetakerContent(content);
}
