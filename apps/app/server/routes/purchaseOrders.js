const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned } = require('../utils/tenant');

const router = express.Router();
router.use(requireAuth);

async function withItems(po) {
  const items = await db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id);
  return { ...po, items };
}

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT purchase_orders.*, suppliers.name AS supplier_name FROM purchase_orders
       LEFT JOIN suppliers ON suppliers.id = purchase_orders.supplier_id
       WHERE purchase_orders.business_id = ? ORDER BY purchase_orders.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: await Promise.all(rows.map(withItems)) });
}));

const createPO = db.transaction(async (businessId, supplier_id, warehouse_id, lines) => {
  await assertOwned('suppliers', supplier_id, businessId);
  await assertOwned('warehouses', warehouse_id, businessId);

  const validLines = lines.filter((l) => l.name);
  const total = validLines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE business_id = ?').get(businessId)).n;
  const code = `PO-${1100 + count + 1}`;

  const info = await db
    .prepare(`INSERT INTO purchase_orders (business_id, supplier_id, warehouse_id, code, status, total) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id`)
    .run(businessId, supplier_id || null, warehouse_id || null, code, total);

  const insertItem = db.prepare('INSERT INTO purchase_order_items (po_id, name, qty, cost) VALUES (?, ?, ?, ?)');
  for (const l of validLines) {
    await insertItem.run(info.lastInsertRowid, l.name, Number(l.qty) || 1, Number(l.cost) || 0);
  }
  return info.lastInsertRowid;
});

router.post('/', ah(async (req, res) => {
  const { supplier_id, warehouse_id, lines = [] } = req.body || {};
  const poId = await createPO(req.user.business_id, supplier_id, warehouse_id, lines);
  const po = await db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  res.status(201).json({ item: await withItems(po) });
}));

const VALID_STATUSES = ['pending', 'partial', 'received', 'cancelled'];

// Receiving a PO adds its line-item quantities to stock (matched to line.name,
// since purchase_order_items aren't linked to a product_id in this schema).
// Guarded by the existing status so re-sending the same "received" transition
// twice — a duplicate click, a retried request — cannot double-credit stock.
const receivePO = db.transaction(async (businessId, poId, status) => {
  const po = await db.prepare('SELECT id, status, warehouse_id FROM purchase_orders WHERE id = ? AND business_id = ? FOR UPDATE').get(poId, businessId);
  if (!po) return null;

  const alreadyReceived = po.status === 'received';
  await db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, poId);

  if (status === 'received' && !alreadyReceived) {
    const items = await db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
    for (const item of items) {
      const product = await db
        .prepare('SELECT id FROM products WHERE business_id = ? AND name = ? LIMIT 1')
        .get(businessId, item.name);
      if (!product) continue; // line item doesn't match a known product — nothing to credit
      await db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND business_id = ?').run(
        item.qty, product.id, businessId
      );
      await db.prepare(
        `INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type, ref_id) VALUES (?, ?, 'purchase', ?, 'purchase_order', ?)`
      ).run(businessId, product.id, item.qty, poId);
    }
  }
  return true;
});

router.put('/:id', ah(async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status is required' });
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const updated = await receivePO(req.user.business_id, req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'Not found' });

  const po = await db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  res.json({ item: await withItems(po) });
}));

router.delete('/:id', ah(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM purchase_orders WHERE id = ? AND business_id = ?').get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
