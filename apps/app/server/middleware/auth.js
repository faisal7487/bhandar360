const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'stockflow-dev-secret-change-me';
const COOKIE_NAME = 'sf_token';

function signToken(userId, businessId, sessionId) {
  return jwt.sign({ uid: userId, bid: businessId, sid: sessionId }, JWT_SECRET, { expiresIn: '30d' });
}

// sessionId identifies the user_sessions row for this device (see schema.sql)
// — the same session carries over across a business switch, so callers that
// are just reissuing the cookie for a new active business (not a fresh
// login) must pass along the existing req.sessionId rather than omit it.
function setAuthCookie(res, userId, businessId, sessionId) {
  res.cookie(COOKIE_NAME, signToken(userId, businessId, sessionId), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

async function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
      // Tokens signed before session tracking existed have no `sid` — treat
      // them as unauthenticated so every signed-in device gets a real session
      // row instead of silently working without one.
      const session = payload.sid
        ? await db.prepare('SELECT * FROM user_sessions WHERE id = ? AND user_id = ?').get(payload.sid, payload.uid)
        : null;
      if (user && session && !session.revoked_at) {
        // Verify the claimed active business is one this user is actually a member of;
        // fall back to their default business otherwise (e.g. stale/older token).
        let businessId = payload.bid;
        const membership = businessId
          ? await db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND business_id = ?').get(user.id, businessId)
          : null;
        if (!membership) businessId = user.business_id;

        req.user = { ...user, business_id: businessId };
        req.business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
        req.sessionId = session.id;
        // Fire-and-forget — a device's "last active" time is advisory, not
        // worth making every request wait on.
        db.prepare('UPDATE user_sessions SET last_seen_at = to_char(NOW() AT TIME ZONE \'UTC\', \'YYYY-MM-DD HH24:MI:SS\') WHERE id = ?')
          .run(session.id)
          .catch(() => {});
      }
    } catch (e) {
      // invalid/expired token: leave req.user unset
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, loadUser, requireAuth, COOKIE_NAME };
