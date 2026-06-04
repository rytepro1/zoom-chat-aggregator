import Anthropic from '@anthropic-ai/sdk';

/**
 * AIClient — thin wrapper around the Anthropic Messages API for the
 * Smart Auto-Responder (docs/backend/ai.md).
 *
 * One shared instance is constructed in server/index.js and handed to
 * every per-org AIResponder. It does exactly one job: take a batch of
 * pre-filtered chat-message candidates plus the org's current FAQ list,
 * and return a structured classification for each candidate (is this a
 * question? a complaint? does it match a known FAQ, and how confidently?).
 *
 * Design choices:
 *   - Model: claude-haiku-4-5. Cheap + fast, which matters because this
 *     runs against live high-volume event chat. The heuristic pre-filter
 *     in AIResponder keeps the bulk of traffic (reactions, statements)
 *     away from here entirely.
 *   - Forced tool use (tool_choice: {type:'tool'}) for structured output.
 *     The model is required to call record_classification, so we get a
 *     pre-parsed, schema-shaped object back with no brittle JSON parsing.
 *   - Prompt caching: cache_control on the stable system instructions and
 *     on the (semi-stable) FAQ-list block. Tools render before system, so
 *     a breakpoint there caches the whole tools+system prefix; the
 *     per-batch candidates live in the user turn (volatile, uncached).
 *   - Fail-safe: any error (timeout, rate limit, API outage) returns an
 *     empty result set. The caller treats "no classification" as "take no
 *     action" — the bot never sends a reply off a failed inference.
 *
 * The model only ADVISES. Every consequential decision (auto-reply,
 * pause, create a pending FAQ) is made by deterministic code in
 * AIResponder using these results plus the org's thresholds.
 */

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 12_000;

// Sentinel the model uses for "no FAQ matched" — avoids nullable schema
// fields, which keeps the tool input schema simple and robust.
const NO_FAQ = '';

const SYSTEM_INSTRUCTIONS = `You are a precision classifier for a LIVE EVENT chat auto-responder. \
A moderator runs a webinar/meeting; attendees type questions in chat. Your job is to look at a \
batch of attendee messages and, for each one, decide three things with HIGH PRECISION:

1. classification — one of:
   - "question": the attendee is asking for information or help (often "where is the link", \
"what's the password", "how do I access X", "is there a recording").
   - "complaint": the attendee is reporting that a previously-given answer or link is wrong, \
broken, expired, or didn't work (e.g. "that link is broken", "the bot gave me the wrong link", \
"404", "that didn't work", "wrong password").
   - "other": reactions, statements, greetings, small talk, agreement ("yes", "1", "thanks", \
"great session") — anything that is neither a question nor a complaint.

2. normalizedIntent — for questions only, a short canonical phrasing of what they're asking \
(e.g. "link to VIP session", "link to educational material", "session recording"). For \
non-questions, use an empty string.

3. matching against the KNOWN FAQS provided below.
   - For a "question": if it clearly asks the SAME thing as a known FAQ, set matchedFaqId to \
that FAQ's id and matchConfidence between 0 and 1. Otherwise set matchedFaqId to "" and \
matchConfidence to 0.
   - For a "complaint": if it's clearly about a known FAQ's answer/link, set relatesToFaqId to \
that FAQ's id, complaintConfidence 0..1, and complaintType ("wrong" | "broken" | "other"). \
Otherwise relatesToFaqId "", complaintConfidence 0, complaintType "none".

CRITICAL PRECISION RULES — the bot will auto-send the matched answer to real attendees, so a \
wrong match sends the wrong link:
- Only set a high matchConfidence when the intent is genuinely the SAME. Two questions that \
mention "link" are NOT a match unless they ask for the SAME link. "Link to the VIP session" and \
"link to the educational material" are DIFFERENT — do not conflate them.
- When unsure, prefer matchedFaqId "" with low confidence over a risky match. Missing a match is \
recoverable; a wrong auto-reply is not.
- Echo back each candidate's id exactly so results can be correlated.`;

export class AIClient {
  constructor({ apiKey, model } = {}) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.model = model || MODEL;
    this._client = this.apiKey
      ? new Anthropic({ apiKey: this.apiKey, maxRetries: 1 })
      : null;
  }

  /** Feature is inert unless an API key is present. */
  isConfigured() {
    return Boolean(this._client);
  }

  /**
   * Classify a batch of candidate messages against the org's FAQ list.
   *
   * @param {Object} params
   * @param {Array<{id:string, room?:string, text:string}>} params.candidates
   * @param {Array<{id:string, question:string, answer?:string, status?:string}>} params.faqs
   * @returns {Promise<{results: Array<{
   *   id:string, classification:'question'|'complaint'|'other',
   *   normalizedIntent:string, matchedFaqId:string, matchConfidence:number,
   *   relatesToFaqId:string, complaintConfidence:number,
   *   complaintType:'wrong'|'broken'|'other'|'none'
   * }>}>}  Always resolves; returns { results: [] } on any error.
   */
  async classifyBatch({ candidates = [], faqs = [] } = {}) {
    if (!this._client || candidates.length === 0) return { results: [] };

    // Serialize the FAQ list deterministically so the cached prefix stays
    // byte-stable across a burst of ticks (key order matters for caching).
    const faqBlock = faqs.length
      ? faqs
          .map(
            (f) =>
              `- id=${f.id} | status=${f.status || 'active'} | question=${JSON.stringify(
                f.question
              )}${f.answer ? ` | answer=${JSON.stringify(f.answer)}` : ''}`
          )
          .join('\n')
      : '(no known FAQs yet)';

    const candidateBlock = candidates
      .map((c) => `id=${c.id}${c.room ? ` | room=${JSON.stringify(c.room)}` : ''} | text=${JSON.stringify(c.text)}`)
      .join('\n');

    try {
      const message = await this._client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          system: [
            {
              type: 'text',
              text: SYSTEM_INSTRUCTIONS,
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `KNOWN FAQS:\n${faqBlock}`,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: [CLASSIFICATION_TOOL],
          tool_choice: { type: 'tool', name: CLASSIFICATION_TOOL.name },
          messages: [
            {
              role: 'user',
              content:
                `Classify each of these attendee messages. Return one result per id.\n\n` +
                candidateBlock,
            },
          ],
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );

      const toolUse = message.content.find(
        (b) => b.type === 'tool_use' && b.name === CLASSIFICATION_TOOL.name
      );
      const raw = toolUse?.input?.results;
      if (!Array.isArray(raw)) return { results: [] };

      return { results: raw.map(normalizeResult).filter(Boolean) };
    } catch (err) {
      // Fail-safe: no classification → AIResponder takes no action. Never
      // let an inference failure turn into a bad send.
      console.error('[AIClient] classifyBatch failed (taking no action):', err.message);
      return { results: [] };
    }
  }
}

// Clamp + coerce the model's output into the shape AIResponder expects, so
// downstream gating code can trust the fields without re-validating.
function normalizeResult(r) {
  if (!r || typeof r.id !== 'string') return null;
  const classification =
    r.classification === 'question' || r.classification === 'complaint'
      ? r.classification
      : 'other';
  return {
    id: r.id,
    classification,
    normalizedIntent: typeof r.normalizedIntent === 'string' ? r.normalizedIntent.trim() : '',
    matchedFaqId: typeof r.matchedFaqId === 'string' ? r.matchedFaqId : NO_FAQ,
    matchConfidence: clamp01(r.matchConfidence),
    relatesToFaqId: typeof r.relatesToFaqId === 'string' ? r.relatesToFaqId : NO_FAQ,
    complaintConfidence: clamp01(r.complaintConfidence),
    complaintType: ['wrong', 'broken', 'other'].includes(r.complaintType)
      ? r.complaintType
      : 'none',
  };
}

function clamp01(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Forced-tool schema. Structured-output JSON Schema constraints: every
// object sets additionalProperties:false; no numeric min/max (we clamp in
// JS); enums are fine. matchedFaqId/relatesToFaqId use "" for "no match"
// rather than null to keep the schema free of nullable unions.
const CLASSIFICATION_TOOL = {
  name: 'record_classification',
  description:
    'Record the classification for every attendee message in the batch. Return exactly one entry per input id.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        description: 'One classification per input message id.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'The candidate id, echoed back exactly.' },
            classification: {
              type: 'string',
              enum: ['question', 'complaint', 'other'],
            },
            normalizedIntent: {
              type: 'string',
              description: 'Short canonical phrasing of a question; "" for non-questions.',
            },
            matchedFaqId: {
              type: 'string',
              description: 'Known FAQ id this question matches, or "" if none.',
            },
            matchConfidence: {
              type: 'number',
              description: '0..1 confidence that the question matches matchedFaqId.',
            },
            relatesToFaqId: {
              type: 'string',
              description: 'Known FAQ id a complaint is about, or "" if none.',
            },
            complaintConfidence: {
              type: 'number',
              description: '0..1 confidence that a complaint is about relatesToFaqId.',
            },
            complaintType: {
              type: 'string',
              enum: ['wrong', 'broken', 'other', 'none'],
            },
          },
          required: [
            'id',
            'classification',
            'normalizedIntent',
            'matchedFaqId',
            'matchConfidence',
            'relatesToFaqId',
            'complaintConfidence',
            'complaintType',
          ],
        },
      },
    },
    required: ['results'],
  },
};
