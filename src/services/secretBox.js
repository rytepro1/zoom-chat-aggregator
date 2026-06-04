import crypto from 'node:crypto';

/**
 * secretBox — symmetric encryption for secrets at rest (today: per-org
 * Zoom S2S client secrets). AES-256-GCM (authenticated, so tampering is
 * detected on decrypt).
 *
 * Key: CRED_ENCRYPTION_KEY env var — 32 bytes, supplied as base64 (44
 * chars) or hex (64 chars). Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Stored blob format: "v1:<iv_b64>:<tag_b64>:<ciphertext_b64>".
 */

const ALGO = 'aes-256-gcm';

function loadKey() {
  const raw = process.env.CRED_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('CRED_ENCRYPTION_KEY must decode to 32 bytes (base64 or hex).');
  }
  return buf;
}

export function isEncryptionConfigured() {
  try {
    return Boolean(loadKey());
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext) {
  const key = loadKey();
  if (!key) throw new Error('CRED_ENCRYPTION_KEY is not set — cannot store secrets.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(blob) {
  const key = loadKey();
  if (!key) throw new Error('CRED_ENCRYPTION_KEY is not set — cannot read secrets.');
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted secret blob.');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
