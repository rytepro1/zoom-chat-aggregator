import { MessageAggregator } from './MessageAggregator.js';
import { SessionManager } from './SessionManager.js';
import { AIResponder } from './AIResponder.js';

/**
 * Per-org runtime state container. Lazy-creates a SessionManager +
 * MessageAggregator per org on first use, so two customers signed in
 * to the same server have fully isolated session state, in-memory ring
 * buffers, and Socket.io broadcast rooms.
 *
 * Construct once at server startup and stash it on `app.set('orgState')`.
 * Route handlers call `await orgState.get(req.org.id)` to retrieve their
 * org's `{ sm, ma }` pair.
 *
 * No eviction policy yet — a long-running server accumulates one
 * state-pair per org that's ever connected. At our scale (handfuls of
 * active orgs) this is fine; we can add LRU eviction when it matters.
 */
export class OrgState {
  constructor({ db, io, recallBotManager, aiClient } = {}) {
    this.db = db || null;
    this.io = io || null;
    // Shared (not per-org) singletons the per-org AIResponder needs:
    // recallBotManager to send auto-replies, aiClient for classification.
    this.recallBotManager = recallBotManager || null;
    this.aiClient = aiClient || null;
    this.byOrg = new Map(); // orgId -> { sm, ma, ai }
    this.initializing = new Map(); // orgId -> Promise<{ sm, ma, ai }>
  }

  /**
   * Return `{ sm, ma, ai }` for the given org, lazy-initializing if needed.
   * Two concurrent requests for the same org share the in-flight init
   * promise so we don't double-create state.
   */
  async get(orgId) {
    if (!orgId) throw new Error('OrgState.get requires an orgId');
    if (this.byOrg.has(orgId)) return this.byOrg.get(orgId);
    if (this.initializing.has(orgId)) return this.initializing.get(orgId);

    const initPromise = (async () => {
      const sm = new SessionManager({ db: this.db, io: this.io, orgId });
      await sm.init();
      const ma = new MessageAggregator(this.io, { db: this.db, sessionManager: sm, orgId });
      await ma.hydrate();
      const ai = new AIResponder({
        db: this.db,
        io: this.io,
        orgId,
        ma,
        sm,
        recallBotManager: this.recallBotManager,
        aiClient: this.aiClient,
      });
      await ai.hydrate();
      ma.aiResponder = ai;
      const entry = { sm, ma, ai };
      this.byOrg.set(orgId, entry);
      this.initializing.delete(orgId);
      return entry;
    })().catch((err) => {
      this.initializing.delete(orgId);
      throw err;
    });

    this.initializing.set(orgId, initPromise);
    return initPromise;
  }

  /** Synchronous read — returns null if not yet initialized. */
  peek(orgId) {
    return this.byOrg.get(orgId) || null;
  }

  /** Iterate all active orgs (for stats / cleanup). */
  active() {
    return Array.from(this.byOrg.entries()).map(([orgId, entry]) => ({ orgId, ...entry }));
  }
}
