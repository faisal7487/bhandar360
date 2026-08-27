const express = require('express');
const db = require('../db');
const { requireAuth, setAuthCookie } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

function publicBusiness(business) {
  return {
    id: business.id,
    name: business.name,
    industry: business.industry,
    currency: business.currency,
    taxRate: business.tax_rate,
    timezone: business.timezone,
    address: business.address,
    plan: business.plan,
    onboarded: !!business.onboarded,
  };
}

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT businesses.* FROM businesses
       JOIN memberships ON memberships.business_id = businesses.id
       WHERE memberships.user_id = ?
       ORDER BY businesses.id ASC`
    )
    .all(req.user.id);
  res.json({ items: rows.map(publicBusiness), activeId: req.business.id });
}));

router.post('/', ah(async (req, res) => {
  const { name, industry } = req.body || {};
  const info = await db
    .prepare(`INSERT INTO businesses (name, industry, onboarded) VALUES (?, ?, 0) RETURNING id`)
    .run(name || 'New Business', industry || 'pharmacy');
  await db.prepare(`INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, 'owner')`).run(
    req.user.id,
    info.lastInsertRowid
  );
  setAuthCookie(res, req.user.id, info.lastInsertRowid);
  const business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ business: publicBusiness(business) });
}));

router.post('/:id/switch', ah(async (req, res) => {
  const membership = await db
    .prepare('SELECT 1 FROM memberships WHERE user_id = ? AND business_id = ?')
    .get(req.user.id, req.params.id);
  if (!membership) return res.status(403).json({ error: 'Not a member of this business' });
  setAuthCookie(res, req.user.id, req.params.id);
  const business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  res.json({ business: publicBusiness(business) });
}));

const TEARDOWN_TABLES = [
  'stock_movements', 'losses', 'expenses', 'production_runs', 'deliveries',
  'team_members', 'notifications', 'products', 'customers', 'suppliers',
  'categories', 'branches', 'warehouses', 'sales', 'invoices', 'purchase_orders',
];

const teardownBusiness = db.transaction(async (id, fallbackBusinessId) => {
  await db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE business_id = ?)').run(id);
  await db.prepare('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE business_id = ?)').run(id);
  await db.prepare('DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE business_id = ?)').run(id);
  for (const table of TEARDOWN_TABLES) {
    await db.prepare(`DELETE FROM ${table} WHERE business_id = ?`).run(id);
  }
  // Reassign any user whose default business is the one being deleted.
  await db.prepare('UPDATE users SET business_id = ? WHERE business_id = ?').run(fallbackBusinessId, id);
  await db.prepare('DELETE FROM memberships WHERE business_id = ?').run(id);
  await db.prepare('DELETE FROM businesses WHERE id = ?').run(id);
});

router.delete('/:id', ah(async (req, res) => {
  const { id } = req.params;
  const membership = await db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND business_id = ?')
    .get(req.user.id, id);
  if (!membership) return res.status(403).json({ error: 'Not a member of this business' });

  const memberCount = (await db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE business_id = ?').get(id)).n;

  if (memberCount > 1) {
    // Other people share this business — just leave it, don't destroy their data.
    await db.prepare('DELETE FROM memberships WHERE user_id = ? AND business_id = ?').run(req.user.id, id);
  } else {
    const fallback = await db
      .prepare('SELECT business_id FROM memberships WHERE user_id = ? AND business_id != ? LIMIT 1')
      .get(req.user.id, id);
    if (!fallback) {
      return res.status(400).json({ error: 'You must have at least one business. Create another business before removing this one.' });
    }
    await teardownBusiness(id, fallback.business_id);
  }

  if (String(req.business.id) === String(id)) {
    const fallback = await db
      .prepare('SELECT business_id FROM memberships WHERE user_id = ? LIMIT 1')
      .get(req.user.id);
    if (fallback) setAuthCookie(res, req.user.id, fallback.business_id);
  }
  res.json({ ok: true });
}));

module.exports = router;
