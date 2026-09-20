const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { rateLimit } = require('../middleware/rateLimit');
const { sendPasswordResetEmail } = require('../utils/mailer');

const AVATAR_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'avatars');
const AVATAR_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' };
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB, matches the limit shown in the upload UI

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
    avatarUrl: user.avatar_url,
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

// Creates the user_sessions row a signed-in device is tracked by — its id
// becomes the `sid` claim in that device's auth cookie (see middleware/auth.js).
async function createSession(req, userId) {
  const userAgent = (req.headers['user-agent'] || '').slice(0, 300);
  const info = await db
    .prepare('INSERT INTO user_sessions (user_id, user_agent, ip) VALUES (?, ?, ?) RETURNING id')
    .run(userId, userAgent, req.ip);
  return info.lastInsertRowid;
}

function describeSession(row, currentSessionId) {
  return {
    id: row.id,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    current: row.id === currentSessionId,
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

  const sessionId = await createSession(req, userId);
  setAuthCookie(res, userId, businessId, sessionId);
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

  const sessionId = await createSession(req, user.id);
  setAuthCookie(res, user.id, user.business_id, sessionId);
  const business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(user.business_id);
  res.json({ user: publicUser(user, business) });
}));

router.get('/sessions', requireAuth, ah(async (req, res) => {
  const rows = await db
    .prepare('SELECT * FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC')
    .all(req.user.id);
  res.json({ items: rows.map((r) => describeSession(r, req.sessionId)) });
}));

router.delete('/sessions/:id', requireAuth, ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM user_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  await db
    .prepare(`UPDATE user_sessions SET revoked_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
    .run(row.id);
  res.json({ ok: true });
}));

// Timestamps in this app are stored/compared as plain 'YYYY-MM-DD HH:MM:SS'
// UTC text (see schema.sql) — this mirrors that shape without pulling in a
// date library.
function utcTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

router.post('/forgot-password', authLimiter, ah(async (req, res) => {
  const { email } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  const user = await db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email.toLowerCase());
  // Always return the same response whether or not the account exists, so
  // this endpoint can't be used to check which emails are registered.
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = utcTimestamp(new Date(Date.now() + 60 * 60 * 1000));
    await db
      .prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(user.id, tokenHash, expiresAt);

    const origin = `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${origin}/?reset=${token}`;
    const mailResult = await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl });

    // Outside production, hand the link back directly so local/dev setups
    // (no email provider configured) can still test the flow end-to-end.
    if (process.env.NODE_ENV !== 'production' && !mailResult.delivered) {
      return res.json({ ok: true, message: 'Reset link generated (no email provider configured — see devResetUrl).', devResetUrl: resetUrl });
    }
  }

  res.json({ ok: true, message: "If an account exists for that email, we've sent password reset instructions." });
}));

router.post('/reset-password', authLimiter, ah(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Reset token and new password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash);
  const expired = !row || row.used_at || new Date(`${row.expires_at.replace(' ', 'T')}Z`) < new Date();
  if (expired) return res.status(400).json({ error: 'This reset link is invalid or has expired' });

  const passwordHash = bcrypt.hashSync(password, 10);
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
  await db
    .prepare(`UPDATE password_reset_tokens SET used_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
    .run(row.id);

  res.json({ ok: true });
}));

// Best-effort delete of a previously uploaded avatar file — an upload or
// removal replaces/clears it, and a stale file left behind is just wasted
// disk, never a correctness problem, so failures here are swallowed.
function deleteAvatarFile(avatarUrl) {
  if (!avatarUrl || !avatarUrl.startsWith('/uploads/avatars/')) return;
  const filePath = path.join(AVATAR_DIR, path.basename(avatarUrl));
  fs.unlink(filePath, () => {});
}

router.patch('/avatar', requireAuth, ah(async (req, res) => {
  const { dataUrl } = req.body || {};
  const match = typeof dataUrl === 'string' && /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return res.status(400).json({ error: 'Choose a JPG or PNG image' });

  const ext = AVATAR_MIME_EXT[match[1]];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_AVATAR_BYTES) {
    return res.status(400).json({ error: 'Image must be 2 MB or smaller' });
  }

  await fs.promises.mkdir(AVATAR_DIR, { recursive: true });
  const filename = `user-${req.user.id}-${Date.now()}.${ext}`;
  await fs.promises.writeFile(path.join(AVATAR_DIR, filename), buffer);

  const previousUrl = req.user.avatar_url;
  const avatarUrl = `/uploads/avatars/${filename}`;
  await db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);
  deleteAvatarFile(previousUrl);

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user, req.business) });
}));

router.delete('/avatar', requireAuth, ah(async (req, res) => {
  await db.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').run(req.user.id);
  deleteAvatarFile(req.user.avatar_url);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user, req.business) });
}));

router.post('/signout', ah(async (req, res) => {
  if (req.sessionId) {
    await db
      .prepare(`UPDATE user_sessions SET revoked_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
      .run(req.sessionId);
  }
  clearAuthCookie(res);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user, req.business) });
});

module.exports = router;
