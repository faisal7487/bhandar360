const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned } = require('../utils/tenant');

const router = express.Router();
router.use(requireAuth);

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT losses.*, products.name AS product_name, products.cost_price AS product_cost,
              branches.name AS branch_name, users.name AS created_by_name
       FROM losses
       LEFT JOIN products ON products.id = losses.product_id
       LEFT JOIN branches ON branches.id = losses.branch_id
       LEFT JOIN users ON users.id = losses.created_by
       WHERE losses.business_id = ? ORDER BY losses.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

router.post('/', ah(async (req, res) => {
  const { product_id, branch_id, qty, reason, notes } = req.body || {};
  if (!qty) return res.status(400).json({ error: 'qty is required' });

  await assertOwned('products', product_id, req.user.business_id);
  await assertOwned('branches', branch_id, req.user.business_id);

  // Loss/waste write-offs require approval before stock is touched — the UI
  // itself says "will be sent for approval", so nothing is deducted here.
  const info = await db
    .prepare(
      `INSERT INTO losses (business_id, product_id, branch_id, created_by, qty, reason, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id`
    )
    .run(req.user.business_id, product_id || null, branch_id || null, req.user.id, Number(qty), reason || null, notes || null);

  const row = await db.prepare('SELECT * FROM losses WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item: row });
}));

const VALID_STATUSES = ['pending', 'approved', 'rejected'];

// Stock is deducted only on the transition into 'approved', and only once —
// re-approving an already-approved loss (double click, retried request) is a
// no-op rather than a second deduction.
const decideLoss = db.transaction(async (businessId, lossId, status) => {
  const loss = await db.prepare('SELECT * FROM losses WHERE id = ? AND business_id = ? FOR UPDATE').get(lossId, businessId);
  if (!loss) return null;

  const alreadyApproved = loss.status === 'approved';
  await db.prepare('UPDATE losses SET status = ? WHERE id = ?').run(status, lossId);

  if (status === 'approved' && !alreadyApproved && loss.product_id) {
    await db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND business_id = ?').run(
      loss.qty, loss.product_id, businessId
    );
    await db.prepare(
      `INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type, ref_id) VALUES (?, ?, 'loss', ?, 'loss', ?)`
    ).run(businessId, loss.product_id, -loss.qty, lossId);
  }
  return true;
});

router.put('/:id', ah(async (req, res) => {
  const { status } = req.body || {};
  if (!status || !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const updated = await decideLoss(req.user.business_id, req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  const row = await db.prepare('SELECT * FROM losses WHERE id = ?').get(req.params.id);
  res.json({ item: row });
}));

router.delete('/:id', ah(async (req, res) => {
  const existing = await db.prepare('SELECT id, status FROM losses WHERE id = ? AND business_id = ?').get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status === 'approved') {
    return res.status(400).json({ error: 'An approved loss already affected stock — reverse it with a stock adjustment instead of deleting the record.' });
  }
  await db.prepare('DELETE FROM losses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
