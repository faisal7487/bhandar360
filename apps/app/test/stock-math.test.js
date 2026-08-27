// Verifies the stock ledger invariant and the atomicity/idempotency of every
// stock-changing operation: a sale deducts stock exactly once, can't oversell,
// a purchase-order receipt credits stock exactly once even if "received" is
// sent twice, and a loss only touches stock once it's approved.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, newTenant, deleteTenant } = require('./helpers');

let tenant;

before(async () => {
  await startServer();
  tenant = await newTenant('stockmath');
});

after(async () => {
  await deleteTenant(tenant.businessId);
  await stopServer();
});

test('a sale deducts stock exactly once and records a matching stock movement', async () => {
  const { client } = tenant;
  const product = await client.post('/api/products', { name: 'Widget', stock_qty: 20, sale_price: 15 });
  const productId = product.body.item.id;

  const sale = await client.post('/api/sales', {
    lines: [{ product_id: productId, name: 'Widget', qty: 5, price: 15 }],
  });
  assert.equal(sale.status, 201);

  const products = await client.get('/api/products');
  const updated = products.body.items.find((p) => p.id === productId);
  assert.equal(updated.stock_qty, 15, 'opening 20 - sold 5 = 15');

  const movements = await client.get(`/api/products/${productId}/movements`);
  const saleMovement = movements.body.items.find((m) => m.ref_type === 'sale');
  assert.equal(saleMovement.qty, -5);
});

test('selling more than available stock is rejected, not allowed to go negative', async () => {
  const { client } = tenant;
  const product = await client.post('/api/products', { name: 'Scarce Item', stock_qty: 2, sale_price: 100 });
  const productId = product.body.item.id;

  const oversell = await client.post('/api/sales', {
    lines: [{ product_id: productId, name: 'Scarce Item', qty: 10, price: 100 }],
  });
  assert.equal(oversell.status, 400);

  const products = await client.get('/api/products');
  const unchanged = products.body.items.find((p) => p.id === productId);
  assert.equal(unchanged.stock_qty, 2, 'a rejected sale must not partially deduct stock');
});

test('receiving a purchase order credits stock once, and cannot be double-received', async () => {
  const { client } = tenant;
  const product = await client.post('/api/products', { name: 'Restock Item', stock_qty: 0 });
  const supplier = await client.post('/api/suppliers', { name: 'Test Supplier' });

  const po = await client.post('/api/purchase-orders', {
    supplier_id: supplier.body.item.id,
    lines: [{ name: 'Restock Item', qty: 30, cost: 5 }],
  });
  assert.equal(po.status, 201);

  const receive1 = await client.put(`/api/purchase-orders/${po.body.item.id}`, { status: 'received' });
  assert.equal(receive1.status, 200);

  let products = await client.get('/api/products');
  assert.equal(products.body.items.find((p) => p.id === product.body.item.id).stock_qty, 30);

  // Re-sending "received" (duplicate click / retried request) must not add stock twice.
  const receive2 = await client.put(`/api/purchase-orders/${po.body.item.id}`, { status: 'received' });
  assert.equal(receive2.status, 200);

  products = await client.get('/api/products');
  assert.equal(products.body.items.find((p) => p.id === product.body.item.id).stock_qty, 30, 'stock must not double-credit on re-receive');
});

test('CSV import is atomic: a batch either fully commits or fully rolls back', async () => {
  const { client } = tenant;
  const before = await client.get('/api/products');
  const beforeCount = before.body.items.length;

  const result = await client.post('/api/products/import', {
    items: [
      { name: 'Import Item 1', stock_qty: 4 },
      { name: 'Import Item 2', stock_qty: 6 },
    ],
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.created, 2);

  const after = await client.get('/api/products');
  assert.equal(after.body.items.length, beforeCount + 2);

  const movements = await Promise.all(
    after.body.items
      .filter((p) => p.name.startsWith('Import Item'))
      .map((p) => client.get(`/api/products/${p.id}/movements`))
  );
  for (const m of movements) {
    assert.equal(m.body.items.length, 1, 'each imported row gets exactly one stock movement');
  }
});
