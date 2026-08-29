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
      `SELECT production_runs.*, products.name AS product_name FROM production_runs
       LEFT JOIN products ON products.id = production_runs.product_id
       WHERE production_runs.business_id = ? ORDER BY production_runs.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

router.post('/', ah(async (req, res) => {
  const { product_id, qty, status } = req.body || {};
  if (!qty) return res.status(400).json({ error: 'qty is required' });
  await assertOwned('products', product_id, req.user.business_id);
  const info = await db
    .prepare(`INSERT INTO production_runs (business_id, product_id, qty, status) VALUES (?, ?, ?, ?) RETURNING id`)
    .run(req.user.business_id, product_id || null, Number(qty), status || 'draft');
  const row = await db.prepare('SELECT * FROM production_runs WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item: row });
}));

// SELECT ... FOR UPDATE locks the run row for the duration of the transaction,
// so two concurrent "mark completed" requests for the same run can't both
// observe status !== 'completed' and both credit stock — the second request
// blocks until the first commits, then sees the already-'completed' status.
const completeProduction = db.transaction(async (businessId, id, status, qty) => {
  const existing = await db
    .prepare('SELECT * FROM production_runs WHERE id = ? AND business_id = ? FOR UPDATE')
    .get(id, businessId);
  if (!existing) return null;

  const newStatus = status || existing.status;
  const newQty = qty === undefined ? existing.qty : Number(qty);
  await db.prepare('UPDATE production_runs SET status = ?, qty = ? WHERE id = ?').run(newStatus, newQty, existing.id);

  if (existing.status !== 'completed' && newStatus === 'completed' && existing.product_id) {
    await db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND business_id = ?').run(
      newQty, existing.product_id, businessId
    );
    await db.prepare(
      `INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type, ref_id) VALUES (?, ?, 'production', ?, 'production', ?)`
    ).run(businessId, existing.product_id, newQty, existing.id);
  }
  return true;
});

router.put('/:id', ah(async (req, res) => {
  const { status, qty } = req.body || {};
  const updated = await completeProduction(req.user.business_id, req.params.id, status, qty);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  const row = await db.prepare('SELECT * FROM production_runs WHERE id = ?').get(req.params.id);
  res.json({ item: row });
}));

router.delete('/:id', ah(async (req, res) => {
  const existing = await db
    .prepare('SELECT id, status FROM production_runs WHERE id = ? AND business_id = ?')
    .get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status === 'completed') {
    return res.status(400).json({ error: 'Completed production runs can’t be deleted — they have already credited stock.' });
  }
  await db.prepare('DELETE FROM production_runs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
