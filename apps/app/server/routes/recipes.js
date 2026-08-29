const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned } = require('../utils/tenant');

const router = express.Router();
router.use(requireAuth);

// Returns the recipe with its component lines already joined to the current
// product name / cost / stock, so the frontend can render availability and a
// cost estimate without cross-referencing the product list itself.
async function withComponents(recipe) {
  const components = await db
    .prepare(
      `SELECT recipe_components.id, recipe_components.product_id, recipe_components.qty,
              products.name AS product_name, products.unit,
              products.cost_price, products.stock_qty
       FROM recipe_components
       JOIN products ON products.id = recipe_components.product_id
       WHERE recipe_components.recipe_id = ?
       ORDER BY recipe_components.id`
    )
    .all(recipe.id);
  return { ...recipe, components };
}

router.get('/', ah(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT recipes.*, products.name AS product_name FROM recipes
       LEFT JOIN products ON products.id = recipes.product_id
       WHERE recipes.business_id = ? ORDER BY recipes.id DESC`
    )
    .all(req.user.business_id);
  res.json({ items: await Promise.all(rows.map(withComponents)) });
}));

// Normalises the request body into a clean recipe + component list, rejecting
// anything unusable (no finished product, no components, non-positive yield or
// component quantities) so a run built on it can't later divide by zero or
// deduct a meaningless amount.
function parseBody(body) {
  const product_id = Number(body.product_id) || null;
  const name = (body.name || '').trim();
  const yield_qty = Number(body.yield_qty) || 0;
  const labour_cost = Number(body.labour_cost) || 0;
  const components = (Array.isArray(body.components) ? body.components : [])
    .map((c) => ({ product_id: Number(c.product_id) || null, qty: Number(c.qty) || 0 }))
    .filter((c) => c.product_id && c.qty > 0);
  return { product_id, name, yield_qty, labour_cost, components };
}

function validate({ product_id, name, yield_qty, components }) {
  if (!name) return 'Recipe name is required';
  if (!product_id) return 'Select the finished product this recipe produces';
  if (!(yield_qty > 0)) return 'Batch yield must be greater than zero';
  if (!components.length) return 'Add at least one raw material with a quantity';
  return null;
}

const createRecipe = db.transaction(async (businessId, data) => {
  await assertOwned('products', data.product_id, businessId);
  for (const c of data.components) await assertOwned('products', c.product_id, businessId);

  const info = await db
    .prepare(
      `INSERT INTO recipes (business_id, product_id, name, yield_qty, labour_cost)
       VALUES (?, ?, ?, ?, ?) RETURNING id`
    )
    .run(businessId, data.product_id, data.name, data.yield_qty, data.labour_cost);

  const insertComponent = db.prepare('INSERT INTO recipe_components (recipe_id, product_id, qty) VALUES (?, ?, ?)');
  for (const c of data.components) await insertComponent.run(info.lastInsertRowid, c.product_id, c.qty);
  return info.lastInsertRowid;
});

router.post('/', ah(async (req, res) => {
  const data = parseBody(req.body || {});
  const err = validate(data);
  if (err) return res.status(400).json({ error: err });

  const id = await createRecipe(req.user.business_id, data);
  const recipe = await db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  res.status(201).json({ item: await withComponents(recipe) });
}));

const updateRecipe = db.transaction(async (businessId, id, data) => {
  const existing = await db.prepare('SELECT id FROM recipes WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!existing) return null;
  await assertOwned('products', data.product_id, businessId);
  for (const c of data.components) await assertOwned('products', c.product_id, businessId);

  await db
    .prepare('UPDATE recipes SET product_id = ?, name = ?, yield_qty = ?, labour_cost = ? WHERE id = ?')
    .run(data.product_id, data.name, data.yield_qty, data.labour_cost, id);

  // Replace the component set wholesale — simpler and safe since nothing
  // references recipe_components rows by id.
  await db.prepare('DELETE FROM recipe_components WHERE recipe_id = ?').run(id);
  const insertComponent = db.prepare('INSERT INTO recipe_components (recipe_id, product_id, qty) VALUES (?, ?, ?)');
  for (const c of data.components) await insertComponent.run(id, c.product_id, c.qty);
  return true;
});

router.put('/:id', ah(async (req, res) => {
  const data = parseBody(req.body || {});
  const err = validate(data);
  if (err) return res.status(400).json({ error: err });

  const updated = await updateRecipe(req.user.business_id, req.params.id, data);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  const recipe = await db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  res.json({ item: await withComponents(recipe) });
}));

router.delete('/:id', ah(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM recipes WHERE id = ? AND business_id = ?').get(req.params.id, req.user.business_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const usedBy = await db.prepare("SELECT id FROM production_runs WHERE recipe_id = ? LIMIT 1").get(req.params.id);
  if (usedBy) {
    return res.status(400).json({ error: "This recipe has production runs against it — it can't be deleted." });
  }
  await db.prepare('DELETE FROM recipe_components WHERE recipe_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM recipes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
