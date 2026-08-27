// P0: two businesses must not be able to read, modify, or delete each
// other's data — via direct object reference (someone else's id in a URL or
// body field) or via joined fields leaking through list views.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, newTenant, deleteTenant } = require('./helpers');

let tenantA, tenantB;

before(async () => {
  await startServer();
  tenantA = await newTenant('tenantA');
  tenantB = await newTenant('tenantB');
});

after(async () => {
  await deleteTenant(tenantA.businessId);
  await deleteTenant(tenantB.businessId);
  await stopServer();
});

test('a business cannot read another business\'s product list', async () => {
  const created = await tenantA.client.post('/api/products', { name: 'A-only product', stock_qty: 10 });
  assert.equal(created.status, 201);

  const bList = await tenantB.client.get('/api/products');
  assert.equal(bList.status, 200);
  assert.ok(!bList.body.items.some((p) => p.name === 'A-only product'), 'B must not see A\'s product');
});

test('a business cannot update or read-back another business\'s product via its id (IDOR)', async () => {
  const created = await tenantA.client.post('/api/products', { name: 'A secret product', cost_price: 999, sku: 'IDOR-1' });
  const productId = created.body.item.id;

  const crossUpdate = await tenantB.client.put(`/api/products/${productId}`, { name: 'hijacked' });
  assert.equal(crossUpdate.status, 404, 'cross-tenant update must 404, not silently no-op and leak the row');

  const stillIntact = await tenantA.client.get('/api/products');
  const stillThere = stillIntact.body.items.find((p) => p.id === productId);
  assert.equal(stillThere.name, 'A secret product', 'A\'s product must be unchanged');
});

test('a business cannot delete another business\'s branch/customer/etc via the shared CRUD routes', async () => {
  const branch = await tenantA.client.post('/api/branches', { name: 'A Branch' });
  const branchId = branch.body.item.id;

  const crossDelete = await tenantB.client.del(`/api/branches/${branchId}`);
  assert.equal(crossDelete.status, 404);

  const stillExists = await tenantA.client.get('/api/branches');
  assert.ok(stillExists.body.items.some((b) => b.id === branchId), 'A\'s branch must survive B\'s delete attempt');
});

test('a sale cannot reference another business\'s customer (IDOR / cross-tenant PII leak)', async () => {
  const customer = await tenantA.client.post('/api/customers', { name: 'A Corp Customer', email: 'a-corp@example.com' });
  const customerId = customer.body.item.id;

  const crossSale = await tenantB.client.post('/api/sales', {
    customer_id: customerId,
    lines: [{ name: 'Some item', qty: 1, price: 10 }],
  });
  assert.equal(crossSale.status, 400, 'creating a sale against another tenant\'s customer id must be rejected');

  const bSales = await tenantB.client.get('/api/sales');
  assert.ok(!bSales.body.items.some((s) => s.customer_name === 'A Corp Customer'), 'B\'s sales list must never show A\'s customer name');
});

test('deleting a sale never touches another business\'s sale_items', async () => {
  const productA = await tenantA.client.post('/api/products', { name: 'A stock item', stock_qty: 5 });
  const saleA = await tenantA.client.post('/api/sales', {
    lines: [{ product_id: productA.body.item.id, name: 'A stock item', qty: 1, price: 10 }],
  });
  assert.equal(saleA.status, 201);
  assert.equal(saleA.body.item.items.length, 1);

  // B guesses A's sale id and tries to delete it.
  const crossDelete = await tenantB.client.del(`/api/sales/${saleA.body.item.id}`);
  assert.equal(crossDelete.status, 404);

  const aSales = await tenantA.client.get('/api/sales');
  const stillThere = aSales.body.items.find((s) => s.id === saleA.body.item.id);
  assert.ok(stillThere, 'A\'s sale must still exist');
  assert.equal(stillThere.items.length, 1, 'A\'s sale_items must be untouched by B\'s delete attempt');
});

test('an invoice status update cannot be forced onto, or leak, another business\'s invoice', async () => {
  const invA = await tenantA.client.post('/api/invoices', { lines: [{ name: 'Consulting', qty: 1, price: 500 }] });
  const invoiceId = invA.body.item.id;

  const crossUpdate = await tenantB.client.put(`/api/invoices/${invoiceId}`, { status: 'paid' });
  assert.equal(crossUpdate.status, 404, 'must not update, and must not return, another tenant\'s invoice');

  const aInvoices = await tenantA.client.get('/api/invoices');
  const stillThere = aInvoices.body.items.find((i) => i.id === invoiceId);
  assert.equal(stillThere.status, 'sent', 'A\'s invoice status must be unaffected by B\'s attempt');
});
