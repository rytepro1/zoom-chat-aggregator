/**
 * ZoomApiClient — thin client for the Zoom REST API v2, scoped to the
 * webinar-panelist management we need for auto-registering bots as
 * panelists (ROADMAP #1).
 *
 * Auth model: Server-to-Server (S2S) OAuth. We authenticate AS a Zoom
 * account using its account_id + client_id + client_secret, mint a
 * 1-hour bearer token, and call the REST API with it. There is no
 * refresh token — you re-mint when it expires.
 *
 * Multi-tenancy (per docs/backend/zoom.md "account model"): each
 * customer org hosts webinars on THEIR OWN Zoom account, so creds are
 * passed in per-org by the caller — this client never reads them from
 * the environment. The standalone test script (scripts/zoom-panelist-test.mjs)
 * is the one exception: it pulls creds from env for local verification.
 *
 * Required Marketplace App scopes: webinar:write:admin + webinar:read:admin.
 * Required on the account: the Zoom Webinar add-on (else /webinars/* → 403).
 *
 * Node 18+ (global fetch). No SDK — Zoom publishes none for Node S2S.
 */

const DEFAULT_API_BASE = 'https://api.zoom.us/v2';
const DEFAULT_TOKEN_URL = 'https://zoom.us/oauth/token';

// Re-mint this many ms before the token's stated expiry, so we never
// hand out a token that dies mid-request. Zoom tokens last 3600s.
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Module-level token cache keyed by account+client, so multiple
// short-lived ZoomApiClient instances for the same org share one token
// (and multiple S2S tokens are valid simultaneously anyway, so this is
// safe even across a re-mint). Value: { token, expiresAtMs }.
const tokenCache = new Map();

export class ZoomApiError extends Error {
  constructor(message, { status = null, code = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'ZoomApiError';
    this.status = status;
    this.code = code; // Zoom's numeric error code, when present
    this.retryAfter = retryAfter; // seconds, from Retry-After on 429
  }
}

export class ZoomApiClient {
  constructor({ accountId, clientId, clientSecret, apiBase, tokenUrl } = {}) {
    if (!accountId) throw new Error('ZoomApiClient: accountId is required');
    if (!clientId) throw new Error('ZoomApiClient: clientId is required');
    if (!clientSecret) throw new Error('ZoomApiClient: clientSecret is required');
    this.accountId = String(accountId).trim();
    this.clientId = String(clientId).trim();
    this.clientSecret = String(clientSecret).trim();
    this.apiBase = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.tokenUrl = tokenUrl || DEFAULT_TOKEN_URL;
    this._cacheKey = `${this.accountId}:${this.clientId}`;
  }

  /**
   * Return a valid bearer token, minting (and caching) a fresh one if
   * the cache is empty or within the expiry buffer.
   */
  async getAccessToken() {
    const cached = tokenCache.get(this._cacheKey);
    if (cached && cached.expiresAtMs - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
      return cached.token;
    }

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'account_credentials',
      account_id: this.accountId,
    });

    let res;
    try {
      res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (err) {
      throw new ZoomApiError(`Network error minting Zoom S2S token: ${err.message}`);
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }

    if (!res.ok) {
      // OAuth errors come back as { reason, error } or { error, error_description }.
      const reason = json?.reason || json?.error_description || json?.error || text || res.statusText;
      let hint = '';
      if (res.status === 400 && /account/i.test(reason || '')) {
        hint = ' — check ZOOM_ACCOUNT_ID matches the account that owns the S2S app.';
      } else if (res.status === 401) {
        hint = ' — client_id/client_secret rejected; verify the S2S app credentials.';
      }
      throw new ZoomApiError(`Zoom token request failed (${res.status}): ${reason}${hint}`, {
        status: res.status,
      });
    }

    const token = json?.access_token;
    const expiresInSec = Number(json?.expires_in) || 3600;
    if (!token) {
      throw new ZoomApiError(`Zoom token response missing access_token: ${text.slice(0, 200)}`);
    }
    tokenCache.set(this._cacheKey, {
      token,
      expiresAtMs: Date.now() + expiresInSec * 1000,
    });
    return token;
  }

  /**
   * Authenticated REST call against api.zoom.us/v2. Returns parsed JSON
   * (or null for 204). Throws ZoomApiError with a useful message on
   * non-2xx, mapping the common webinar failure modes.
   */
  async _request(method, path, body = null) {
    const token = await this.getAccessToken();
    const url = `${this.apiBase}${path}`;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ZoomApiError(`Network error calling Zoom ${method} ${path}: ${err.message}`);
    }

    if (res.status === 204) return null;

    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }

    if (!res.ok) {
      const code = json?.code ?? null;
      const message = json?.message || text || res.statusText;
      let hint = '';
      if (res.status === 403) {
        hint = ' — likely a missing scope (webinar:write:admin / webinar:read:admin) OR the account lacks the Zoom Webinar add-on.';
      } else if (res.status === 404) {
        hint = ' — webinar not found on this account (wrong ID, or it belongs to a different Zoom account than these S2S creds).';
      } else if (res.status === 429) {
        hint = ' — rate limited; see Retry-After.';
      }
      throw new ZoomApiError(`Zoom ${method} ${path} failed (${res.status}${code != null ? `, code ${code}` : ''}): ${message}${hint}`, {
        status: res.status,
        code,
        retryAfter: res.headers.get('retry-after') ? Number(res.headers.get('retry-after')) : null,
      });
    }

    return json;
  }

  /**
   * GET the panelists for a webinar. Returns the array (possibly empty).
   * Each item: { id, name, email, join_url, virtual_background_id, ... }.
   * This is the endpoint that actually carries join_url — the POST does not.
   */
  async listPanelists(webinarId) {
    const data = await this._request('GET', `/webinars/${encodeURIComponent(webinarId)}/panelists`);
    return Array.isArray(data?.panelists) ? data.panelists : [];
  }

  /**
   * POST one or more panelists. Body: [{ name, email }]. Returns Zoom's
   * { id, updated_at } — NOTE: it does NOT return join_url (documented
   * Zoom quirk), so callers must follow up with listPanelists().
   */
  async addPanelists(webinarId, panelists) {
    if (!Array.isArray(panelists) || panelists.length === 0) {
      throw new Error('addPanelists: panelists must be a non-empty array of { name, email }');
    }
    return this._request('POST', `/webinars/${encodeURIComponent(webinarId)}/panelists`, { panelists });
  }

  async removePanelist(webinarId, panelistId) {
    return this._request('DELETE', `/webinars/${encodeURIComponent(webinarId)}/panelists/${encodeURIComponent(panelistId)}`);
  }

  /**
   * Idempotently ensure { name, email } is a panelist on the webinar and
   * return its join_url. Safe to call repeatedly: if the email is already
   * a panelist we just return the existing join_url (no duplicate add).
   *
   * Guards the known Zoom gotcha where adding a panelist whose email maps
   * to an existing Zoom account can succeed-but-not-add: if the email is
   * still absent after the add, we throw a clear, actionable error rather
   * than returning undefined.
   */
  async ensurePanelistJoinUrl(webinarId, { name, email }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) throw new Error('ensurePanelistJoinUrl: email is required');
    const cleanName = String(name || '').trim() || cleanEmail;

    const existing = (await this.listPanelists(webinarId)).find(
      (p) => String(p.email || '').trim().toLowerCase() === cleanEmail
    );
    if (existing?.join_url) return { join_url: existing.join_url, panelistId: existing.id, added: false };

    await this.addPanelists(webinarId, [{ name: cleanName, email: cleanEmail }]);

    const after = (await this.listPanelists(webinarId)).find(
      (p) => String(p.email || '').trim().toLowerCase() === cleanEmail
    );
    if (!after?.join_url) {
      throw new ZoomApiError(
        `Added panelist ${cleanEmail} to webinar ${webinarId} but Zoom did not return a join_url on re-list. ` +
        `This usually means the email already maps to a Zoom account and the add silently no-ops — try a unique alias address.`
      );
    }
    return { join_url: after.join_url, panelistId: after.id, added: true };
  }

  /**
   * Lightweight credential/permission probe. Minting a token proves the
   * account+client creds; listing panelists on a known webinar proves the
   * webinar scopes AND the Webinar add-on in one shot. Pass a scratch
   * webinarId to fully validate; omit it to only validate the token mint.
   */
  async verifyAccess(webinarId = null) {
    await this.getAccessToken(); // throws on bad account/client creds
    if (!webinarId) return { tokenOk: true, webinarAccessOk: null };
    await this.listPanelists(webinarId); // throws 403 on missing scope/add-on, 404 on wrong account
    return { tokenOk: true, webinarAccessOk: true };
  }
}
