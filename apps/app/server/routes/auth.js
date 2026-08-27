const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// 10 attempts per 5 minutes per IP+email — slows down credential stuffing /
// brute force without needing an external store for this single-process app.
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.ip}:${(req.body && req.body.email) || ''}`,
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function publicUser(user, business) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatarColor: user.avatar_color,
    business: business
      ? {
          id: business.id,
          name: business.name,
          industry: business.industry,
          currency: business.currency,
          taxRate: business.tax_rate,
          timezone: business.timezone,
          address: business.address,
          plan: business.plan,
          onboarded: !!business.onboarded,
        }
      : null,
  };
}

const createAccount = db.transaction(async (name, email, passwordHash) => {
  const businessInfo = await db
    .prepare(`INSERT INTO businesses (name, industry, onboarded) VALUES (?, 'pharmacy', 0) RETURNING id`)
    .run(`${name}'s Business`);

  const userInfo = await db
    .prepare(`INSERT INTO users (business_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner') RETURNING id`)
    .run(businessInfo.lastInsertRowid, name, email, passwordHash);

  await db.prepare(`INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, 'owner')`).run(
    userInfo.lastInsertRowid,
    businessInfo.lastInsertRowid
  );

  return { userId: userInfo.lastInsertRowid, businessId: businessInfo.lastInsertRowid };
});

router.post('/signup', authLimiter, ah(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const { userId, businessId } = await createAccount(name, normalizedEmail, passwordHash);

  setAuthCookie(res, userId, businessId);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  res.json({ user: publicUser(user, business) });
}));

router.post('/signin', authLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  setAuthCookie(res, user.id, user.business_id);
  const business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(user.business_id);
  res.json({ user: publicUser(user, business) });
}));

router.post('/signout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user, req.business) });
});

module.exports = router;
