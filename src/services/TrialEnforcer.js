/**
 * TrialEnforcer — watches bot_usage for trial-tier orgs and gates them
 * against the 30-min / 1-bot cap.
 *
 * Two responsibilities:
 *   1. **Live tracking**: on a 30-second tick, computes each trial org's
 *      used bot-minutes by summing completed bot durations + the live
 *      duration of any in-flight bots. Updates
 *      `organizations.trial_minutes_remaining` and emits a `trialUpdate`
 *      socket event to the org's room so the client can show a live
 *      countdown badge.
 *   2. **Grace + cutoff**: at the warning threshold (25 min used) emit
 *      `trialWarning` once. At the exhaustion threshold (30 min) post a
 *      CTA message into each active meeting via the bot, then disconnect
 *      all of the org's active bots and emit `trialExhausted`.
 *
 * Admin and paid tiers (`plan_tier in ('admin','solo')`) are skipped
 * entirely — they have no trial cap.
 */

const TRIAL_QUOTA_MINUTES = 30;
const TRIAL_WARNING_MINUTES = 25; // first warn at 5 minutes remaining
const TICK_MS = 30_000; // 30 seconds

export class TrialEnforcer {
  constructor({ db, io, recallBotManager, orgState }) {
    this.db = db;
    this.io = io;
    this.recallBotManager = recallBotManager;
    this.orgState = orgState;
    // Tracks which orgs we've already nudged this trial cycle so we
    // don't spam `trialWarning` every tick. Cleared if the user upgrades
    // (plan_tier changes) — handled lazily by checking plan_tier each tick.
    this.warnedOrgs = new Set();
    this.exhaustedOrgs = new Set();
    this.intervalHandle = null;
  }

  start() {
    if (this.intervalHandle) return;
    if (!this.db) {
      console.log('[Trial] no db — enforcement disabled');
      return;
    }
    // First tick immediately so a freshly-booted server doesn't wait
    // 30s before noticing an over-trial org.
    this.tick().catch(err => console.error('[Trial] first tick error:', err));
    this.intervalHandle = setInterval(() => {
      this.tick().catch(err => console.error('[Trial] tick error:', err));
    }, TICK_MS);
    console.log(`[Trial] enforcer started (tick every ${TICK_MS / 1000}s)`);
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * One pass: compute used minutes per trial org, update DB, emit
   * client events, take action at thresholds.
   */
  async tick() {
    const { rows: orgs } = await this.db.query(
      `SELECT id, plan_tier, trial_minutes_remaining
         FROM organizations
        WHERE plan_tier = 'trial'`
    );
    for (const org of orgs) {
      try {
        await this._tickOrg(org);
      } catch (err) {
        console.error(`[Trial] org ${org.id} tick error:`, err);
      }
    }
  }

  async _tickOrg(org) {
    const usedMinutes = await this._computeUsedMinutes(org.id);
    const remaining = Math.max(0, TRIAL_QUOTA_MINUTES - usedMinutes);

    // Persist the remaining countdown so /api/auth/me reflects it for
    // page loads (the socket event keeps live clients in sync).
    if (remaining !== org.trial_minutes_remaining) {
      await this.db.query(
        `UPDATE organizations SET trial_minutes_remaining = $2 WHERE id = $1`,
        [org.id, remaining]
      );
    }

    this.io.to(`org:${org.id}`).emit('trialUpdate', {
      usedMinutes: Math.floor(usedMinutes * 10) / 10,
      remainingMinutes: remaining,
      quotaMinutes: TRIAL_QUOTA_MINUTES,
    });

    // Warning (once per cycle, not every tick)
    if (usedMinutes >= TRIAL_WARNING_MINUTES && usedMinutes < TRIAL_QUOTA_MINUTES && !this.warnedOrgs.has(org.id)) {
      this.warnedOrgs.add(org.id);
      this.io.to(`org:${org.id}`).emit('trialWarning', {
        remainingMinutes: remaining,
      });
      console.log(`[Trial] ${org.id} warned at ${usedMinutes.toFixed(1)} min used`);
    }

    // Exhaustion: post CTA + disconnect all active bots + emit event (once)
    if (usedMinutes >= TRIAL_QUOTA_MINUTES && !this.exhaustedOrgs.has(org.id)) {
      this.exhaustedOrgs.add(org.id);
      await this._handleExhaustion(org.id);
    }
  }

  /**
   * Sum bot-usage for the org over its current trial cycle.
   * Completed bots: duration_seconds (set on done/disconnect).
   * In-flight bots: NOW() - joined_at.
   *
   * We do NOT scope to a particular billing period — the trial is a
   * single one-shot 30-minute quota per org. For paid tiers (Phase 4)
   * we'll add a `trial_started_at` / billing-period scoping.
   */
  async _computeUsedMinutes(orgId) {
    const { rows } = await this.db.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN left_at IS NULL THEN EXTRACT(EPOCH FROM (NOW() - joined_at))
           ELSE duration_seconds
         END
       ), 0) AS used_seconds
       FROM bot_usage
       WHERE org_id = $1`,
      [orgId]
    );
    return Number(rows[0].used_seconds) / 60;
  }

  async _handleExhaustion(orgId) {
    console.log(`[Trial] ${orgId} exhausted — posting CTA + disconnecting all bots`);

    const upgradeUrl = (process.env.APP_URL || 'https://zoomchat.ryteproductions.com').replace(/\/$/, '') + '/upgrade';
    const ctaMessage = `🔓 ZoomChat trial limit reached. Upgrade to keep monitoring this room: ${upgradeUrl}`;

    const bots = this.recallBotManager.getActiveConnections(orgId);
    for (const conn of bots) {
      // Post the CTA, then disconnect. Both are best-effort — failures
      // don't block enforcement (the bot still has to leave).
      try {
        await this.recallBotManager.sendChatToMeeting(orgId, conn.meetingId, ctaMessage);
      } catch (err) {
        console.error(`[Trial] CTA send failed for ${conn.meetingId}:`, err.message);
      }
      try {
        await this.recallBotManager.disconnect(orgId, conn.meetingId);
      } catch (err) {
        console.error(`[Trial] disconnect failed for ${conn.meetingId}:`, err.message);
      }
      // Reflect the disconnect in the org's MessageAggregator so the
      // operator UI matches reality.
      const entry = this.orgState.peek(orgId);
      if (entry) entry.ma.removeRoom(conn.meetingId);
      this.io.to(`org:${orgId}`).emit('meetingDisconnected', { id: conn.meetingId });
    }

    this.io.to(`org:${orgId}`).emit('trialExhausted', {
      upgradeUrl,
      message: 'Your 30-minute free trial is up. Upgrade to keep using ZoomChat.',
    });
  }

  /**
   * Called from /api/meetings/connect and /api/rosters/:id/deploy to
   * pre-check whether a new bot dispatch is allowed.
   *
   * Returns { allowed: true } or { allowed: false, reason, code, upgradeUrl }.
   * Code 402 ("Payment Required") is what the route uses to send the
   * client into the upgrade flow.
   */
  async checkCanDispatch(org) {
    // Admin and paid tiers always pass.
    if (org.planTier === 'admin' || org.planTier === 'solo') {
      const activeBots = this.recallBotManager.getActiveConnections(org.id).length;
      if (activeBots >= org.concurrentBotLimit) {
        return {
          allowed: false,
          code: 402,
          reason: `You've reached your concurrent-bot limit (${org.concurrentBotLimit}). Disconnect a meeting before adding another.`,
        };
      }
      return { allowed: true };
    }

    // Trial: check both concurrent cap AND minutes-remaining.
    const activeBots = this.recallBotManager.getActiveConnections(org.id).length;
    if (activeBots >= org.concurrentBotLimit) {
      return {
        allowed: false,
        code: 402,
        reason: `Trial accounts are limited to ${org.concurrentBotLimit} concurrent bot. Upgrade to monitor more rooms.`,
        upgradeUrl: this._upgradeUrl(),
      };
    }
    if (!this.db) return { allowed: true };
    const used = await this._computeUsedMinutes(org.id);
    if (used >= TRIAL_QUOTA_MINUTES) {
      return {
        allowed: false,
        code: 402,
        reason: 'Your 30-minute trial is exhausted. Upgrade to keep using ZoomChat.',
        upgradeUrl: this._upgradeUrl(),
      };
    }
    return { allowed: true };
  }

  _upgradeUrl() {
    return (process.env.APP_URL || 'https://zoomchat.ryteproductions.com').replace(/\/$/, '') + '/upgrade';
  }
}

export const TRIAL_CONSTANTS = {
  QUOTA_MINUTES: TRIAL_QUOTA_MINUTES,
  WARNING_MINUTES: TRIAL_WARNING_MINUTES,
  TICK_MS,
};
