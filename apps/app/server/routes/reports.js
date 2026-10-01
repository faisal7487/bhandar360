const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.get('/sales-by-month', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT substr(created_at, 1, 7) AS month, COALESCE(SUM(total), 0) AS total
       FROM sales WHERE business_id = ? GROUP BY month ORDER BY month`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

router.get('/top-products', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT sale_items.name, SUM(sale_items.qty) AS qty, SUM(sale_items.qty * sale_items.price) AS revenue
       FROM sale_items
       JOIN sales ON sales.id = sale_items.sale_id
       WHERE sales.business_id = ?
       GROUP BY sale_items.name
       ORDER BY revenue DESC
       LIMIT 10`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

router.get('/expenses-by-category', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT COALESCE(category, 'Uncategorized') AS category, COALESCE(SUM(amount), 0) AS total
       FROM expenses WHERE business_id = ? GROUP BY category ORDER BY total DESC`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

router.get('/inventory-value', ah(async (req, res) => {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(stock_qty * cost_price), 0) AS costValue, COALESCE(SUM(stock_qty * sale_price), 0) AS saleValue
       FROM products WHERE business_id = ?`
    )
    .get(req.user.business_id);
  res.json(row);
}));

// Business-wide in/out ledger for the Stock movement report. Not part of the
// data the app preloads, so the report fetches it on demand.
router.get('/stock-movements', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT stock_movements.id, stock_movements.created_at, stock_movements.type, stock_movements.qty,
              stock_movements.ref_type, stock_movements.ref_id,
              products.name AS product_name, products.sku AS sku, products.unit AS unit
       FROM stock_movements
       JOIN products ON products.id = stock_movements.product_id
       WHERE stock_movements.business_id = ?
       ORDER BY stock_movements.created_at DESC, stock_movements.id DESC
       LIMIT 10000`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

module.exports = router;
