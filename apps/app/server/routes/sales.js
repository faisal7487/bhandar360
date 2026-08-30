const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned, HttpError } = require('../utils/tenant');

const router = express.Router();
router.use(requireAuth);

async function withItems(sale) {
  const items = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  return { ...sale, items };
}

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT sales.*,
              COALESCE(customers.name, sales.customer_name) AS customer_name,
              branches.name AS branch_name
       FROM sales
       LEFT JOIN customers ON customers.id = sales.customer_id
       LEFT JOIN branches ON branches.id = sales.branch_id
       WHERE sales.business_id = ? ORDER BY sales.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: await Promise.all(rows.map(withItems)) });
}));

// A completed sale also generates an invoice for the same lines and customer,
// linked back via invoices.sale_id. The invoice is 'paid' for an on-the-spot
// sale and 'sent' (unpaid) when the payment method is Credit. The customer is
// either an existing customers row (customer_id) or a walk-in captured as a
// bare name/phone on both the sale and the invoice.
const createSale = db.transaction(async (businessId, customer_id, branch_id, lines, method, walkinName, walkinPhone) => {
  await assertOwned('customers', customer_id, businessId);
  await assertOwned('branches', branch_id, businessId);

  const validLines = lines.filter((l) => l.name);
  for (const l of validLines) {
    await assertOwned('products', l.product_id, businessId);
  }

  // Lock and verify stock is sufficient for every line before writing anything.
  // Without this, two concurrent sales (or one sale over-selling) can drive
  // stock negative, and the failure would otherwise be discovered only after
  // the sale row and stock_movements were already committed.
  for (const l of validLines) {
    if (!l.product_id) continue;
    const qty = Number(l.qty) || 1;
    const product = await db
      .prepare('SELECT id, name, stock_qty FROM products WHERE id = ? AND business_id = ? FOR UPDATE')
      .get(l.product_id, businessId);
    if (product && product.stock_qty < qty) {
      throw new HttpError(400, `Not enough stock for "${product.name}" — ${product.stock_qty} available, ${qty} requested`);
    }
  }

  const total = validLines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const custName = customer_id ? null : (walkinName || null);
  const custPhone = customer_id ? null : (walkinPhone || null);

  const saleCount = (await db.prepare('SELECT COUNT(*) AS n FROM sales WHERE business_id = ?').get(businessId)).n;
  const code = `SL-${3000 + saleCount + 1}`;

  const saleInfo = await db
    .prepare(
      `INSERT INTO sales (business_id, customer_id, branch_id, code, total, paid_amount, method, status, customer_name, customer_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?) RETURNING id`
    )
    .run(businessId, customer_id || null, branch_id || null, code, total, total, method || 'Cash', custName, custPhone);
  const saleId = saleInfo.lastInsertRowid;

  const insertSaleItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price) VALUES (?, ?, ?, ?, ?)');
  for (const l of validLines) {
    await insertSaleItem.run(saleId, l.product_id || null, l.name, Number(l.qty) || 1, Number(l.price) || 0);
    if (l.product_id) {
      await db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND business_id = ?').run(
        Number(l.qty) || 1,
        l.product_id,
        businessId
      );
      await db.prepare(
        `INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type, ref_id) VALUES (?, ?, 'sale', ?, 'sale', ?)`
      ).run(businessId, l.product_id, -(Number(l.qty) || 1), saleId);
    }
  }

  // Auto-generate the invoice for this sale.
  const invCount = (await db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE business_id = ?').get(businessId)).n;
  const invoiceNo = `INV-${2000 + invCount + 1}`;
  const invStatus = (method || 'Cash') === 'Credit' ? 'sent' : 'paid';

  const invInfo = await db
    .prepare(
      `INSERT INTO invoices (business_id, customer_id, branch_id, invoice_no, total, status, sale_id, customer_name, customer_phone, method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .run(businessId, customer_id || null, branch_id || null, invoiceNo, total, invStatus, saleId, custName, custPhone, method || 'Cash');

  const insertInvItem = db.prepare('INSERT INTO invoice_items (invoice_id, name, qty, price) VALUES (?, ?, ?, ?)');
  for (const l of validLines) {
    await insertInvItem.run(invInfo.lastInsertRowid, l.name, Number(l.qty) || 1, Number(l.price) || 0);
  }

  return { saleId, invoiceNo };
});

router.post('/', ah(async (req, res) => {
  const { customer_id, branch_id, lines = [], method, customer_name, customer_phone } = req.body || {};
  const { saleId, invoiceNo } = await createSale(
    req.user.business_id,
    customer_id,
    branch_id,
    lines,
    method,
    (customer_name || '').trim(),
    (customer_phone || '').trim()
  );
  const sale = await db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  res.status(201).json({ item: { ...(await withItems(sale)), invoice_no: invoiceNo } });
}));

// Deleting a sale also removes the invoice it generated, so the two never
// drift apart.
const deleteSale = db.transaction(async (businessId, id) => {
  const sale = await db.prepare('SELECT id FROM sales WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!sale) return false;
  const inv = await db.prepare('SELECT id FROM invoices WHERE sale_id = ? AND business_id = ?').get(id, businessId);
  if (inv) {
    await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(inv.id);
    await db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
  }
  await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
  await db.prepare('DELETE FROM sales WHERE id = ?').run(id);
  return true;
});

router.delete('/:id', ah(async (req, res) => {
  const ok = await deleteSale(req.user.business_id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

module.exports = router;
