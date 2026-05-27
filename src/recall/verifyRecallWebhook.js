import crypto from 'crypto';

/**
 * Verify a Recall.ai realtime/webhook request signed with the modern
 * Svix-style headers (workspaces created after 2025-12-15).
 *
 *   webhook-id:        msg_xxx
 *   webhook-timestamp: <unix seconds>
 *   webhook-signature: "v1,<base64sig> v1,<base64sig2> ..."
 *
 * The HMAC is SHA-256 over `${id}.${timestamp}.${rawBody}` using the
 * workspace secret (which is provided as "whsec_<base64>").
 *
 * Returns { ok, reason } so callers can log the failure mode.
 *
 * Docs: https://docs.recall.ai/docs/authenticating-requests-from-recallai
 */
export function verifyRecallWebhook(headers, rawBody, secret, { toleranceSeconds = 300 } = {}) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!rawBody) return { ok: false, reason: 'no_raw_body' };

  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !timestamp || !sigHeader) return { ok: false, reason: 'missing_headers' };

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return { ok: false, reason: 'timestamp_drift' };

  const secretBytes = decodeSvixSecret(secret);
  if (!secretBytes) return { ok: false, reason: 'bad_secret_format' };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedContent = `${id}.${timestamp}.${body}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // Header is space-separated "v1,<sig>" entries; any matching v1 entry is valid.
  const presented = sigHeader.split(' ').map(part => {
    const [version, sig] = part.split(',');
    return { version, sig };
  });

  const match = presented.some(p => p.version === 'v1' && timingSafeStringEqual(p.sig, expected));
  return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

function decodeSvixSecret(secret) {
  try {
    const stripped = secret.replace(/^whsec_/, '');
    return Buffer.from(stripped, 'base64');
  } catch {
    return null;
  }
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
