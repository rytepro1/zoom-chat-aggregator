import { readSessionCookie, validateSession } from './sessions.js';

/**
 * attachUser — soft auth middleware. Always runs; sets req.user / req.org
 * if a valid session cookie is present, otherwise leaves them undefined.
 * Used on every request so downstream handlers can branch on auth state.
 */
export function attachUser(db) {
  return async (req, _res, next) => {
    if (!db) return next();
    try {
      const sessionId = readSessionCookie(req);
      if (!sessionId) return next();
      const session = await validateSession(db, sessionId);
      if (session) {
        req.sessionId = session.sessionId;
        req.user = session.user;
        req.org = session.org;
      }
    } catch (err) {
      console.error('[auth] attachUser error:', err.message);
    }
    next();
  };
}

/**
 * requireAuth — hard auth middleware. Use on routes that need a
 * signed-in user. Returns 401 if no session.
 */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

/**
 * requireAdmin — must be signed in AND have role='admin' in their org.
 * Use on settings-team, billing, etc.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
