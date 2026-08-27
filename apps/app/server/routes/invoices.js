const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned } = require('../utils/tenant');

const router = express.Router();
router.use(requireAuth);

async function withItems(inv) {
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
  return { ...inv, items };
}

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT invoices.*, customers.name AS customer_name, branches.name AS branch_name FROM invoices
       LEFT JOIN customers ON customers.id = invoices.customer_id
       LEFT JOIN branches ON branches.id = invoices.branch_id
       WHERE invoices.business_id = ? ORDER BY invoices.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: await Promise.all(rows.map(withItems)) });
}));

const createInvoice = db.transaction(async (businessId, customer_id, branch_id, lines, due_date) => {
  await assertOwned('customers', customer_id, businessId);
  await assertOwned('branches', branch_id, businessId);

  const validLines = lines.filter((l) => l.name);
  const total = validLines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE business_id = ?').get(businessId)).n;
  const invoiceNo = `INV-${2000 + count + 1}`;

  const info = await db
    .prepare(
      `INSERT INTO invoices (business_id, customer_id, branch_id, invoice_no, total, status, due_date) VALUES (?, ?, ?, ?, ?, 'sent', ?) RETURNING id`
    )
    .run(businessId, customer_id || null, branch_id || null, invoiceNo, total, due_date || null);

  const insertItem = db.prepare('INSERT INTO invoice_items (invoice_id, name, qty, price) VALUES (?, ?, ?, ?)');
  for (const l of validLines) {
    await insertItem.run(info.lastInsertRowid, l.name, Number(l.qty) || 1, Number(l.price) || 0);
  }
  return info.lastInsertRowid;
});

router.post('/', ah(async (req, res) => {
  const { customer_id, branch_id, lines = [], due_date } = req.body || {};
  const invoiceId = await createInvoice(req.user.business_id, customer_id, branch_id, lines, due_date);
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  res.status(201).json({ item: await withItems(invoice) });
}));

const VALID_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];

router.put('/:id', ah(async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status is required' });
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const existing = await db.prepare('SELECT id FROM invoices WHERE id = ? AND business_id = ?').get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  await db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, req.params.id);
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  res.json({ item: await withItems(invoice) });
}));

router.delete('/:id', ah(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM invoices WHERE id = ? AND business_id = ?').get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
