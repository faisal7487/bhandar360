const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned, HttpError } = require('../utils/tenant');

const router = express.Router();
router.use(requireAuth);

const round = (n) => Math.round(n * 100) / 100;

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT production_runs.*,
              products.name AS product_name,
              recipes.name  AS recipe_name
       FROM production_runs
       LEFT JOIN products ON products.id = production_runs.product_id
       LEFT JOIN recipes  ON recipes.id  = production_runs.recipe_id
       WHERE production_runs.business_id = ? ORDER BY production_runs.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: rows });
}));

// Marks a draft run 'completed': deducts every recipe component from stock,
// credits the finished product, and rolls the batch cost (materials + scaled
// labour) into the finished product's weighted-average unit cost. The whole
// thing runs in one transaction with `SELECT ... FOR UPDATE` on the run row,
// so a duplicate "complete" click can't deduct materials or credit output
// twice — the second call blocks, then sees status === 'completed' and no-ops.
const completeRun = db.transaction(async (businessId, runId) => {
  const run = await db
    .prepare('SELECT * FROM production_runs WHERE id = ? AND business_id = ? FOR UPDATE')
    .get(runId, businessId);
  if (!run) return { notFound: true };
  if (run.status === 'completed') return { run }; // already done — idempotent

  if (!run.recipe_id) throw new HttpError(400, 'Attach a recipe before completing this run');
  const recipe = await db.prepare('SELECT * FROM recipes WHERE id = ? AND business_id = ?').get(run.recipe_id, businessId);
  if (!recipe) throw new HttpError(400, 'This run’s recipe no longer exists');
  if (!recipe.product_id) throw new HttpError(400, 'This run’s recipe has no finished product');
  if (!(recipe.yield_qty > 0)) throw new HttpError(400, 'This run’s recipe has an invalid batch yield');
  const producedQty = Number(run.qty);
  if (!(producedQty > 0)) throw new HttpError(400, 'Production quantity must be greater than zero');

  const declared = await db
    .prepare('SELECT product_id, qty FROM recipe_components WHERE recipe_id = ?')
    .all(recipe.id);
  if (!declared.length) throw new HttpError(400, 'This run’s recipe has no raw materials');

  // Lock every component product row too, so a concurrent sale/production of
  // the same material can't slip between the availability check and the
  // deduction.
  const ids = declared.map((c) => c.product_id);
  const placeholders = ids.map(() => '?').join(', ');
  const products = await db
    .prepare(`SELECT id, name, unit, stock_qty, cost_price FROM products WHERE business_id = ? AND id IN (${placeholders}) FOR UPDATE`)
    .all(businessId, ...ids);
  const byId = new Map(products.map((p) => [p.id, p]));
  if (byId.size !== declared.length) throw new HttpError(400, 'A raw material in this recipe no longer exists');

  const factor = producedQty / Number(recipe.yield_qty);

  // Check availability across all components first — never a partial deduction.
  const shortfalls = [];
  const consume = declared.map((c) => {
    const p = byId.get(c.product_id);
    const need = Number(c.qty) * factor;
    if (p.stock_qty < need - 1e-9) {
      shortfalls.push(`${p.name} (need ${round(need)} ${p.unit || ''}`.trim() + `, have ${round(p.stock_qty)})`);
    }
    return { p, need };
  });
  if (shortfalls.length) {
    throw new HttpError(400, `Not enough raw material — ${shortfalls.join('; ')}`);
  }

  let materialCost = 0;
  for (const { p, need } of consume) {
    materialCost += need * Number(p.cost_price || 0);
    await db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND business_id = ?').run(need, p.id, businessId);
    await db
      .prepare(`INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type, ref_id) VALUES (?, ?, 'production', ?, 'production_material', ?)`)
      .run(businessId, p.id, -need, run.id);
  }

  const labourCost = Number(recipe.labour_cost || 0) * factor;
  const unitCost = (materialCost + labourCost) / producedQty;

  // Credit the finished product and blend the batch cost into its
  // weighted-average unit cost.
  const finished = await db
    .prepare('SELECT stock_qty, cost_price FROM products WHERE id = ? AND business_id = ? FOR UPDATE')
    .get(recipe.product_id, businessId);
  if (!finished) throw new HttpError(400, 'The finished product for this recipe no longer exists');
  const base = Math.max(0, Number(finished.stock_qty));
  const newStock = Number(finished.stock_qty) + producedQty;
  const newCost = base + producedQty > 0
    ? (base * Number(finished.cost_price || 0) + producedQty * unitCost) / (base + producedQty)
    : unitCost;
  await db
    .prepare('UPDATE products SET stock_qty = ?, cost_price = ? WHERE id = ? AND business_id = ?')
    .run(newStock, newCost, recipe.product_id, businessId);
  await db
    .prepare(`INSERT INTO stock_movements (business_id, product_id, type, qty, ref_type, ref_id) VALUES (?, ?, 'production', ?, 'production', ?)`)
    .run(businessId, recipe.product_id, producedQty, run.id);

  await db
    .prepare(`UPDATE production_runs SET status = 'completed', material_cost = ?, labour_cost = ?,
              completed_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
    .run(materialCost, labourCost, run.id);

  const updated = await db.prepare('SELECT * FROM production_runs WHERE id = ?').get(run.id);
  return { run: updated };
});

router.post('/', ah(async (req, res) => {
  const body = req.body || {};
  const recipe_id = Number(body.recipe_id) || null;
  const qty = Number(body.qty) || 0;
  if (!recipe_id) return res.status(400).json({ error: 'Select a recipe for this production run' });
  if (!(qty > 0)) return res.status(400).json({ error: 'Planned quantity must be greater than zero' });

  const recipe = await db.prepare('SELECT id, product_id FROM recipes WHERE id = ? AND business_id = ?').get(recipe_id, req.user.business_id);
  if (!recipe) return res.status(400).json({ error: 'Invalid recipe reference' });

  const info = await db
    .prepare(`INSERT INTO production_runs (business_id, product_id, recipe_id, qty, status) VALUES (?, ?, ?, ?, 'draft') RETURNING id`)
    .run(req.user.business_id, recipe.product_id || null, recipe_id, qty);

  // `status: 'completed'` on create = build the draft and run it in one go.
  if (body.status === 'completed') {
    const result = await completeRun(req.user.business_id, info.lastInsertRowid);
    return res.status(201).json({ item: result.run });
  }
  const row = await db.prepare('SELECT * FROM production_runs WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item: row });
}));

router.put('/:id', ah(async (req, res) => {
  const body = req.body || {};

  if (body.qty !== undefined) {
    const qty = Number(body.qty) || 0;
    if (!(qty > 0)) return res.status(400).json({ error: 'Planned quantity must be greater than zero' });
    const draft = await db
      .prepare("SELECT id FROM production_runs WHERE id = ? AND business_id = ? AND status <> 'completed'")
      .get(req.params.id, req.user.business_id);
    if (!draft) return res.status(404).json({ error: 'Not found' });
    await db.prepare('UPDATE production_runs SET qty = ? WHERE id = ?').run(qty, req.params.id);
  }

  if (body.status === 'completed') {
    const result = await completeRun(req.user.business_id, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Not found' });
    return res.json({ item: result.run });
  }

  const row = await db.prepare('SELECT * FROM production_runs WHERE id = ? AND business_id = ?').get(req.params.id, req.user.business_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ item: row });
}));

router.delete('/:id', ah(async (req, res) => {
  const existing = await db
    .prepare('SELECT id, status FROM production_runs WHERE id = ? AND business_id = ?')
    .get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status === 'completed') {
    return res.status(400).json({ error: 'Completed production runs can’t be deleted — they have already moved stock.' });
  }
  await db.prepare('DELETE FROM production_runs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
