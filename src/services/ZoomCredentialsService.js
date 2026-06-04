import { ZoomApiClient } from './ZoomApiClient.js';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from './secretBox.js';

/**
 * ZoomCredentialsService — per-org storage of Zoom Server-to-Server OAuth
 * credentials, plus a ZoomApiClient factory.
 *
 * Each customer hosts webinars on their OWN Zoom account, so creds are
 * stored per-org in org_zoom_credentials. The client secret is encrypted
 * at rest (secretBox / AES-256-GCM) and never returned to the UI.
 */
export class ZoomCredentialsService {
  constructor({ db } = {}) {
    this.db = db || null;
  }

  isAvailable() {
    return Boolean(this.db);
  }

  /** Non-secret status for the Settings UI (never returns the secret). */
  async getStatus(orgId) {
    if (!this.db) return { configured: false };
    const { rows } = await this.db.query(
      `SELECT account_id, client_id, panelist_email_base, updated_at
         FROM org_zoom_credentials WHERE org_id = $1`,
      [orgId]
    );
    if (rows.length === 0) return { configured: false, panelistEmailBase: null };
    const r = rows[0];
    return {
      configured: true,
      accountId: r.account_id,
      clientId: r.client_id,
      hasSecret: true,
      panelistEmailBase: r.panelist_email_base || null,
      updatedAt: r.updated_at,
    };
  }

  /** Full decrypted creds, or null. Server-side use only. */
  async get(orgId) {
    if (!this.db) return null;
    const { rows } = await this.db.query(
      `SELECT account_id, client_id, client_secret_enc
         FROM org_zoom_credentials WHERE org_id = $1`,
      [orgId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      accountId: r.account_id,
      clientId: r.client_id,
      clientSecret: decryptSecret(r.client_secret_enc),
    };
  }

  /**
   * Upsert creds. clientSecret is optional on update: if blank/omitted
   * and a row already exists, the stored secret is preserved — so an
   * admin can correct the account_id/client_id without re-entering the
   * secret (which the UI never reads back).
   */
  async save(orgId, { accountId, clientId, clientSecret, panelistEmailBase }) {
    if (!this.db) throw new Error('Persistence is not configured');
    if (!isEncryptionConfigured()) {
      throw new Error(
        'Server is missing CRED_ENCRYPTION_KEY — cannot store Zoom credentials securely. Set it in the environment and redeploy.'
      );
    }
    const acct = String(accountId || '').trim();
    const cid = String(clientId || '').trim();
    const secret = clientSecret == null ? '' : String(clientSecret).trim();
    if (!acct || !cid) throw new Error('accountId and clientId are required');

    const existing = await this.db.query(
      `SELECT client_secret_enc, panelist_email_base FROM org_zoom_credentials WHERE org_id = $1`,
      [orgId]
    );
    let secretEnc;
    if (secret) {
      secretEnc = encryptSecret(secret);
    } else if (existing.rows.length > 0) {
      secretEnc = existing.rows[0].client_secret_enc; // keep the stored secret
    } else {
      throw new Error('clientSecret is required');
    }

    // Base email: undefined → keep existing; otherwise set (validating
    // shape) or clear when blank.
    let base;
    if (panelistEmailBase === undefined) {
      base = existing.rows[0]?.panelist_email_base ?? null;
    } else {
      const trimmed = String(panelistEmailBase || '').trim();
      if (trimmed && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
        throw new Error('Panelist email base must be a valid email address (e.g. chatbot@yourdomain.com).');
      }
      base = trimmed || null;
    }

    await this.db.query(
      `INSERT INTO org_zoom_credentials (org_id, account_id, client_id, client_secret_enc, panelist_email_base, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (org_id) DO UPDATE
         SET account_id          = EXCLUDED.account_id,
             client_id           = EXCLUDED.client_id,
             client_secret_enc   = EXCLUDED.client_secret_enc,
             panelist_email_base = EXCLUDED.panelist_email_base,
             updated_at          = NOW()`,
      [orgId, acct, cid, secretEnc, base]
    );
    return this.getStatus(orgId);
  }

  async remove(orgId) {
    if (!this.db) return false;
    const { rowCount } = await this.db.query(
      `DELETE FROM org_zoom_credentials WHERE org_id = $1`,
      [orgId]
    );
    return rowCount > 0;
  }

  /** Build a ZoomApiClient for an org's saved creds, or null if none. */
  async clientForOrg(orgId) {
    const creds = await this.get(orgId);
    if (!creds) return null;
    return new ZoomApiClient(creds);
  }
}
