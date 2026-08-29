// Verifies the production/BOM invariant: completing a run deducts every recipe
// component from stock exactly once, credits the finished product exactly once,
// rolls the batch cost (materials + scaled labour) into the finished product's
// weighted-average unit cost, refuses to run when a component is short (with no
// partial deduction), and can't be completed or deleted twice.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, newTenant, deleteTenant, db } = require('./helpers');

let tenant;

before(async () => {
  await startServer();
  tenant = await newTenant('production');
  // Production is restaurant + retail only; signup always creates a pharmacy.
  await db.prepare("UPDATE businesses SET industry = 'retail' WHERE id = ?").run(tenant.businessId);
});

after(async () => {
  await deleteTenant(tenant.businessId);
  await stopServer();
});

async function makeProduct(client, name, stock_qty, cost_price) {
  const res = await client.post('/api/products', { name, stock_qty, cost_price, unit: 'Kg' });
  assert.equal(res.status, 201, `create ${name}`);
  return res.body.item.id;
}

test('completing a run consumes materials once, credits output once, and blends cost in', async () => {
  const { client } = tenant;
  const flour = await makeProduct(client, 'Flour', 100, 2);
  const sugar = await makeProduct(client, 'Sugar', 50, 4);
  const cake = await makeProduct(client, 'Cake', 0, 0);

  // One batch (yield 10) uses 5 Flour + 2 Sugar, plus 30 labour.
  const recipe = await client.post('/api/recipes', {
    product_id: cake,
    name: 'Cake batch',
    yield_qty: 10,
    labour_cost: 30,
    components: [
      { product_id: flour, qty: 5 },
      { product_id: sugar, qty: 2 },
    ],
  });
  assert.equal(recipe.status, 201);

  // Run 20 finished units => factor 2 => 10 Flour + 4 Sugar consumed.
  const run = await client.post('/api/production', {
    recipe_id: recipe.body.item.id,
    qty: 20,
    status: 'completed',
  });
  assert.equal(run.status, 201);
  assert.equal(run.body.item.status, 'completed');

  const products = await client.get('/api/products');
  const byId = (id) => products.body.items.find((p) => p.id === id);
  assert.equal(byId(flour).stock_qty, 90, 'Flour: 100 - 10');
  assert.equal(byId(sugar).stock_qty, 46, 'Sugar: 50 - 4');
  assert.equal(byId(cake).stock_qty, 20, 'Cake: 0 + 20');

  // materials 10*2 + 4*4 = 36; labour 30*2 = 60; unit cost 96/20 = 4.8
  assert.ok(Math.abs(byId(cake).cost_price - 4.8) < 1e-6, `Cake unit cost ~4.8, got ${byId(cake).cost_price}`);

  const flourMoves = await client.get(`/api/products/${flour}/movements`);
  const consumed = flourMoves.body.items.filter((m) => m.ref_type === 'production_material');
  assert.equal(consumed.length, 1, 'exactly one consumption movement for Flour');
  assert.equal(consumed[0].qty, -10);

  const cakeMoves = await client.get(`/api/products/${cake}/movements`);
  const credited = cakeMoves.body.items.filter((m) => m.ref_type === 'production');
  assert.equal(credited.length, 1, 'exactly one credit movement for Cake');
  assert.equal(credited[0].qty, 20);
});

test('a run short on any material is rejected with no partial deduction', async () => {
  const { client } = tenant;
  const scarce = await makeProduct(client, 'Scarce Resin', 3, 1);
  const widget = await makeProduct(client, 'Resin Widget', 0, 0);

  const recipe = await client.post('/api/recipes', {
    product_id: widget,
    name: 'Widget batch',
    yield_qty: 10,
    labour_cost: 0,
    components: [{ product_id: scarce, qty: 5 }],
  });
  assert.equal(recipe.status, 201);

  // 100 units => needs 50 Resin, only 3 on hand.
  const run = await client.post('/api/production', {
    recipe_id: recipe.body.item.id,
    qty: 100,
    status: 'completed',
  });
  assert.equal(run.status, 400);
  assert.match(run.body.error, /Not enough raw material/);

  const products = await client.get('/api/products');
  const byId = (id) => products.body.items.find((p) => p.id === id);
  assert.equal(byId(scarce).stock_qty, 3, 'a rejected run must not touch component stock');
  assert.equal(byId(widget).stock_qty, 0, 'a rejected run must not credit output');

  const moves = await client.get(`/api/products/${scarce}/movements`);
  assert.equal(moves.body.items.filter((m) => m.ref_type === 'production_material').length, 0);
});

test('a completed run cannot be completed again or deleted', async () => {
  const { client } = tenant;
  const mat = await makeProduct(client, 'Steel', 100, 1);
  const part = await makeProduct(client, 'Bracket', 0, 0);
  const recipe = await client.post('/api/recipes', {
    product_id: part,
    name: 'Bracket batch',
    yield_qty: 1,
    labour_cost: 0,
    components: [{ product_id: mat, qty: 2 }],
  });
  const run = await client.post('/api/production', { recipe_id: recipe.body.item.id, qty: 5 });
  assert.equal(run.status, 201);
  assert.equal(run.body.item.status, 'draft');
  const runId = run.body.item.id;

  const c1 = await client.put(`/api/production/${runId}`, { status: 'completed' });
  assert.equal(c1.status, 200);

  const afterFirst = await client.get('/api/products');
  const steelAfterFirst = afterFirst.body.items.find((p) => p.id === mat).stock_qty;
  assert.equal(steelAfterFirst, 90, 'Steel: 100 - (2 * 5)');

  // Re-send complete — idempotent, must not deduct again.
  const c2 = await client.put(`/api/production/${runId}`, { status: 'completed' });
  assert.equal(c2.status, 200);
  const afterSecond = await client.get('/api/products');
  assert.equal(
    afterSecond.body.items.find((p) => p.id === mat).stock_qty,
    90,
    'a re-completed run must not deduct materials twice'
  );

  const del = await client.del(`/api/production/${runId}`);
  assert.equal(del.status, 400);
});

test('a recipe can be deleted after use; completed runs survive, detached', async () => {
  const { client } = tenant;
  const mat = await makeProduct(client, 'Cocoa', 100, 3);
  const bar = await makeProduct(client, 'Choc Bar', 0, 0);
  const recipe = await client.post('/api/recipes', {
    product_id: bar,
    name: 'Choc batch',
    yield_qty: 5,
    labour_cost: 10,
    components: [{ product_id: mat, qty: 2 }],
  });
  const run = await client.post('/api/production', { recipe_id: recipe.body.item.id, qty: 5, status: 'completed' });
  assert.equal(run.status, 201);
  const runId = run.body.item.id;

  const del = await client.del(`/api/recipes/${recipe.body.item.id}`);
  assert.equal(del.status, 200);
  assert.equal((await client.get('/api/recipes')).body.items.find((r) => r.id === recipe.body.item.id), undefined);

  const runs = await client.get('/api/production');
  const kept = runs.body.items.find((r) => r.id === runId);
  assert.ok(kept, 'the completed run is not deleted with the recipe');
  assert.equal(kept.recipe_id, null, 'the run is detached from the deleted recipe');
  assert.equal(kept.product_id, bar, 'the run keeps its finished product');
  assert.ok(Number(kept.material_cost) > 0, 'frozen batch cost survives');
});

test('a recipe with an unfinished run cannot be deleted', async () => {
  const { client } = tenant;
  const mat = await makeProduct(client, 'Malt', 50, 1);
  const drink = await makeProduct(client, 'Malt Drink', 0, 0);
  const recipe = await client.post('/api/recipes', {
    product_id: drink,
    name: 'Malt batch',
    yield_qty: 1,
    labour_cost: 0,
    components: [{ product_id: mat, qty: 1 }],
  });
  const draft = await client.post('/api/production', { recipe_id: recipe.body.item.id, qty: 3 });
  assert.equal(draft.body.item.status, 'draft');

  const blocked = await client.del(`/api/recipes/${recipe.body.item.id}`);
  assert.equal(blocked.status, 400);

  // Remove the draft, then the recipe deletes cleanly.
  assert.equal((await client.del(`/api/production/${draft.body.item.id}`)).status, 200);
  assert.equal((await client.del(`/api/recipes/${recipe.body.item.id}`)).status, 200);
});

test('production and recipes are 403 for a non-manufacturing industry', async () => {
  const other = await newTenant('production-pharma');
  try {
    await db.prepare("UPDATE businesses SET industry = 'pharmacy' WHERE id = ?").run(other.businessId);
    assert.equal((await other.client.get('/api/recipes')).status, 403);
    assert.equal((await other.client.get('/api/production')).status, 403);
    assert.equal((await other.client.post('/api/recipes', { name: 'x' })).status, 403);
  } finally {
    await deleteTenant(other.businessId);
  }
});
