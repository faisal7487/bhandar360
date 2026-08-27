const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned } = require('../utils/tenant');

const router = express.Router();
router.use(requireAuth);

const COLUMNS = [
  'category', 'warehouse_id', 'name', 'generic', 'brand', 'mfr', 'form', 'strength', 'supplier',
  'sku', 'unit', 'cost_price', 'sale_price', 'wholesale_price',
  'stock_qty', 'reorder_level', 'batch_no', 'mfg_date', 'expiry_date',
  'restricted', 'variants', 'status',
];

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT products.*, warehouses.name AS warehouse_name FROM products
       LEFT JOIN warehouses ON warehouses.id = products.warehouse_id
       WHERE products.business_id = ? ORDER BY products.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

router.post('/', ah(async (req, res) => {
  const body = req.body || {};
  await assertOwned('warehouses', body.warehouse_id, req.user.business_id);

  const cols = COLUMNS.filter((c) => body[c] !== undefined);
  const placeholders = cols.map(() => '?').join(', ');
  const colList = ['business_id', ...cols].join(', ');
  const values = [req.user.business_id, ...cols.map((c) => body[c])];
  const info = await db
    .prepare(`INSERT INTO products (${colList}) VALUES (?, ${placeholders}) RETURNING id`)
    .run(...values);

  const initialQty = Number(body.stock_qty || 0);
  if (initialQty) {
    await db.prepare(
      `INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type) VALUES (?, ?, 'adjustment', ?, 'initial_stock')`
    ).run(req.user.business_id, info.lastInsertRowid, initialQty);
  }

  const row = await db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item: row });
}));

const COLUMN_DEFAULTS = {
  unit: 'pcs',
  cost_price: 0,
  sale_price: 0,
  stock_qty: 0,
  reorder_level: 0,
  restricted: 0,
  status: 'active',
};

const insertProduct = db.prepare(
  `INSERT INTO products (${['business_id', ...COLUMNS].join(', ')}) VALUES (${['?', ...COLUMNS.map(() => '?')].join(', ')}) RETURNING id`
);
const insertMovement = db.prepare(
  `INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type) VALUES (?, ?, 'adjustment', ?, 'csv_import')`
);
const importAll = db.transaction(async (businessId, rows) => {
  let count = 0;
  for (const row of rows) {
    if (!row.name) continue;
    const values = COLUMNS.map((c) => {
      if (row[c] !== undefined && row[c] !== '') return row[c];
      return COLUMN_DEFAULTS[c] !== undefined ? COLUMN_DEFAULTS[c] : null;
    });
    const info = await insertProduct.run(businessId, ...values);
    const qty = Number(row.stock_qty || 0);
    if (qty) await insertMovement.run(businessId, info.lastInsertRowid, qty);
    count++;
  }
  return count;
});

router.post('/import', ah(async (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  try {
    const created = await importAll(req.user.business_id, items);
    res.status(201).json({ created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.put('/:id', ah(async (req, res) => {
  const body = req.body || {};
  const cols = COLUMNS.filter((c) => body[c] !== undefined);
  if (cols.length === 0) return res.status(400).json({ error: 'No fields to update' });

  const existing = await db.prepare('SELECT id FROM products WHERE id = ? AND business_id = ?').get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  if (body.warehouse_id !== undefined) await assertOwned('warehouses', body.warehouse_id, req.user.business_id);

  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const values = [...cols.map((c) => body[c]), req.params.id];
  await db.prepare(`UPDATE products SET ${setClause} WHERE id = ?`).run(...values);
  const row = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ item: row });
}));

router.delete('/:id', ah(async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT id FROM products WHERE id = ? AND business_id = ?').get(id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const [saleItems, losses, production] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?').get(id),
    db.prepare('SELECT COUNT(*) AS n FROM losses WHERE product_id = ?').get(id),
    db.prepare('SELECT COUNT(*) AS n FROM production_runs WHERE product_id = ?').get(id),
  ]);
  const usedIn = saleItems.n + losses.n + production.n;
  if (usedIn > 0) {
    return res.status(400).json({
      error: 'This item has sales, loss, or production history and can’t be deleted. Mark it inactive instead.',
    });
  }
  await db.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(id);
  await db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
}));

router.get('/:id/movements', ah(async (req, res) => {
  const rows = await db
    .prepare('SELECT * FROM stock_movements WHERE product_id = ? AND business_id = ? ORDER BY id DESC')
    .all(req.params.id, req.user.business_id);
  res.json({ items: rows });
}));

module.exports = router;
