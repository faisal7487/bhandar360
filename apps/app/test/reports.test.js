// The Stock movement report downloads the business-wide ledger from
// /api/reports/stock-movements — verifies it records stock in and out with
// the product joined in, and never leaks another business's movements.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, newTenant, deleteTenant } = require('./helpers');

let tenantA, tenantB;

before(async () => {
  await startServer();
  tenantA = await newTenant('reportsA');
  tenantB = await newTenant('reportsB');
});

after(async () => {
  await deleteTenant(tenantA.businessId);
  await deleteTenant(tenantB.businessId);
  await stopServer();
});

test('stock movement ledger lists opening stock and sales for the business', async () => {
  const { client } = tenantA;
  const product = await client.post('/api/products', { name: 'Ledger Widget', sku: 'LW-1', stock_qty: 20 });
  const productId = product.body.item.id;
  const sale = await client.post('/api/sales', { lines: [{ product_id: productId, name: 'Ledger Widget', qty: 3, price: 10 }], method: 'Cash' });
  assert.equal(sale.status, 201);

  const res = await client.get('/api/reports/stock-movements');
  assert.equal(res.status, 200);
  const mine = res.body.items.filter((m) => m.product_name === 'Ledger Widget');
  assert.equal(mine.length, 2);
  const opening = mine.find((m) => m.ref_type === 'initial_stock');
  const sold = mine.find((m) => m.type === 'sale');
  assert.equal(opening.qty, 20);
  assert.equal(sold.qty, -3);
  assert.equal(sold.ref_id, sale.body.item.id);
  assert.equal(sold.sku, 'LW-1');
});

test('a business cannot see another business\'s stock movements', async () => {
  const res = await tenantB.client.get('/api/reports/stock-movements');
  assert.equal(res.status, 200);
  assert.ok(!res.body.items.some((m) => m.product_name === 'Ledger Widget'), 'B must not see A\'s ledger');
});
