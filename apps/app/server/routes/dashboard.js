const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.get('/summary', ah(async (req, res) => {
  const businessId = req.user.business_id;

  const [
    revenueRow, pendingInvoiceRow, productCountRow, lowStockRow,
    pendingPOsRow, inTransitRow, expensesRow, recentInvoices, recentSales,
  ] = await Promise.all([
    db.prepare(`SELECT COALESCE(SUM(total), 0) AS total FROM invoices WHERE business_id = ? AND status = 'paid'`).get(businessId),
    db.prepare(`SELECT COALESCE(SUM(total), 0) AS total FROM invoices WHERE business_id = ? AND status != 'paid'`).get(businessId),
    db.prepare('SELECT COUNT(*) AS n FROM products WHERE business_id = ?').get(businessId),
    db.prepare('SELECT COUNT(*) AS n FROM products WHERE business_id = ? AND stock_qty <= reorder_level').get(businessId),
    db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE business_id = ? AND status IN ('pending','partial')`).get(businessId),
    db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE business_id = ? AND status IN ('picked_up','in_transit')`).get(businessId),
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE business_id = ?').get(businessId),
    db.prepare('SELECT * FROM invoices WHERE business_id = ? ORDER BY id DESC LIMIT 5').all(businessId),
    db.prepare('SELECT * FROM sales WHERE business_id = ? ORDER BY id DESC LIMIT 5').all(businessId),
  ]);

  res.json({
    revenue: revenueRow.total,
    pendingInvoiceTotal: pendingInvoiceRow.total,
    productCount: productCountRow.n,
    lowStockCount: lowStockRow.n,
    pendingPOs: pendingPOsRow.n,
    inTransitDeliveries: inTransitRow.n,
    expensesTotal: expensesRow.total,
    recentInvoices,
    recentSales,
  });
}));

module.exports = router;
