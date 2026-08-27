// The UI promises write-offs are "sent for approval" — verifies that's now
// actually true: stock is untouched until a manager approves, approving twice
// doesn't double-deduct, and rejecting never touches stock.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, newTenant, deleteTenant } = require('./helpers');

let tenant;

before(async () => {
  await startServer();
  tenant = await newTenant('lossflow');
});

after(async () => {
  await deleteTenant(tenant.businessId);
  await stopServer();
});

test('a reported loss is pending and does not touch stock until approved', async () => {
  const { client } = tenant;
  const product = await client.post('/api/products', { name: 'Perishable', stock_qty: 50 });
  const productId = product.body.item.id;

  const loss = await client.post('/api/losses', { product_id: productId, qty: 10, reason: 'Expired' });
  assert.equal(loss.status, 201);
  assert.equal(loss.body.item.status, 'pending');

  const productsAfterReport = await client.get('/api/products');
  assert.equal(productsAfterReport.body.items.find((p) => p.id === productId).stock_qty, 50, 'pending loss must not deduct stock');

  const approve = await client.put(`/api/losses/${loss.body.item.id}`, { status: 'approved' });
  assert.equal(approve.status, 200);

  const productsAfterApproval = await client.get('/api/products');
  assert.equal(productsAfterApproval.body.items.find((p) => p.id === productId).stock_qty, 40, '50 - 10 approved loss = 40');

  // Approving again (duplicate click) must not deduct a second time.
  const approveAgain = await client.put(`/api/losses/${loss.body.item.id}`, { status: 'approved' });
  assert.equal(approveAgain.status, 200);
  const productsAfterSecondApproval = await client.get('/api/products');
  assert.equal(productsAfterSecondApproval.body.items.find((p) => p.id === productId).stock_qty, 40, 'stock must not double-deduct');
});

test('a rejected loss never touches stock', async () => {
  const { client } = tenant;
  const product = await client.post('/api/products', { name: 'Rejected Case Item', stock_qty: 25 });
  const productId = product.body.item.id;

  const loss = await client.post('/api/losses', { product_id: productId, qty: 5, reason: 'Damaged' });
  const reject = await client.put(`/api/losses/${loss.body.item.id}`, { status: 'rejected' });
  assert.equal(reject.status, 200);

  const products = await client.get('/api/products');
  assert.equal(products.body.items.find((p) => p.id === productId).stock_qty, 25, 'rejected loss must not deduct stock');
});
