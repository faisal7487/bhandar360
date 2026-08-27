const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'stockflow-dev-secret-change-me';
const COOKIE_NAME = 'sf_token';

function signToken(userId, businessId) {
  return jwt.sign({ uid: userId, bid: businessId }, JWT_SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, userId, businessId) {
  res.cookie(COOKIE_NAME, signToken(userId, businessId), {
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
      if (user) {
        // Verify the claimed active business is one this user is actually a member of;
        // fall back to their default business otherwise (e.g. stale/older token).
        let businessId = payload.bid;
        const membership = businessId
          ? await db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND business_id = ?').get(user.id, businessId)
          : null;
        if (!membership) businessId = user.business_id;

        req.user = { ...user, business_id: businessId };
        req.business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
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
