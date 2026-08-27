const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

async function buildNotifications(businessId) {
  const notifications = [];

  const lowStock = await db
    .prepare('SELECT * FROM products WHERE business_id = ? AND stock_qty <= reorder_level AND status = ?')
    .all(businessId, 'active');
  lowStock.forEach((p) => {
    notifications.push({
      title: `${p.name} is ${p.stock_qty <= 0 ? 'out of stock' : 'low on stock'}`,
      type: 'stock',
      severity: p.stock_qty <= 0 ? 'critical' : 'warning',
      created_at: p.created_at,
    });
  });

  const expiringSoon = await db
    .prepare(
      `SELECT * FROM products WHERE business_id = ? AND expiry_date IS NOT NULL
       AND expiry_date::date <= (CURRENT_DATE + INTERVAL '120 day') AND expiry_date::date >= CURRENT_DATE`
    )
    .all(businessId);
  expiringSoon.forEach((p) => {
    notifications.push({
      title: `${p.name} expires on ${p.expiry_date}`,
      type: 'expiry',
      severity: 'warning',
      created_at: p.created_at,
    });
  });

  const overdueInvoices = await db
    .prepare(`SELECT * FROM invoices WHERE business_id = ? AND status != 'paid' AND due_date IS NOT NULL AND due_date::date < CURRENT_DATE`)
    .all(businessId);
  overdueInvoices.forEach((inv) => {
    notifications.push({
      title: `Invoice ${inv.invoice_no} is overdue (৳${inv.total})`,
      type: 'invoice',
      severity: 'critical',
      created_at: inv.created_at,
    });
  });

  const partialPOs = await db
    .prepare(`SELECT * FROM purchase_orders WHERE business_id = ? AND status = 'partial'`)
    .all(businessId);
  partialPOs.forEach((po) => {
    notifications.push({
      title: `${po.code} was partially delivered`,
      type: 'purchase',
      severity: 'info',
      created_at: po.created_at,
    });
  });

  notifications.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return notifications;
}

router.get('/', ah(async (req, res) => {
  res.json({ items: await buildNotifications(req.user.business_id) });
}));

module.exports = router;
