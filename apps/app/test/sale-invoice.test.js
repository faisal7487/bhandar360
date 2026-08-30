// Every POS sale auto-generates a linked invoice for the same lines and
// customer. Walk-in sales capture a bare name/phone; existing-customer sales
// link by id. Deleting the sale removes its invoice too.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, newTenant, deleteTenant } = require('./helpers');

let tenant;
let productId;
let customerId;

before(async () => {
  await startServer();
  tenant = await newTenant('sale-invoice');
  const { client } = tenant;
  productId = (await client.post('/api/products', { name: 'Widget', stock_qty: 100, sale_price: 20 })).body.item.id;
  customerId = (await client.post('/api/customers', { name: 'Acme Ltd' })).body.item.id;
});

after(async () => {
  await deleteTenant(tenant.businessId);
  await stopServer();
});

function saleLines(qty = 2, price = 20) {
  return [{ product_id: productId, name: 'Widget', qty, price }];
}

test('a completed sale generates a linked, paid invoice with matching lines', async () => {
  const { client } = tenant;
  const sale = await client.post('/api/sales', { lines: saleLines(3, 20), method: 'Cash' });
  assert.equal(sale.status, 201);
  assert.match(sale.body.item.invoice_no, /^INV-\d+$/);
  const saleId = sale.body.item.id;

  const invoices = await client.get('/api/invoices');
  const inv = invoices.body.items.find((v) => v.sale_id === saleId);
  assert.ok(inv, 'an invoice is linked to the sale');
  assert.equal(inv.invoice_no, sale.body.item.invoice_no);
  assert.equal(inv.status, 'paid', 'a cash sale bills as paid');
  assert.equal(inv.total, 60, '3 * 20');
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].name, 'Widget');
  assert.equal(inv.items[0].qty, 3);
});

test('a Credit sale bills the invoice as unpaid (sent)', async () => {
  const { client } = tenant;
  const sale = await client.post('/api/sales', { lines: saleLines(1, 20), method: 'Credit' });
  const inv = (await client.get('/api/invoices')).body.items.find((v) => v.sale_id === sale.body.item.id);
  assert.equal(inv.status, 'sent');
});

test('a walk-in sale captures name + phone on both sale and invoice', async () => {
  const { client } = tenant;
  const sale = await client.post('/api/sales', {
    lines: saleLines(1, 20),
    method: 'Cash',
    customer_name: 'Jamal Uddin',
    customer_phone: '01700000000',
  });
  const saleId = sale.body.item.id;

  const sales = await client.get('/api/sales');
  const s = sales.body.items.find((x) => x.id === saleId);
  assert.equal(s.customer_name, 'Jamal Uddin', 'GET resolves the walk-in name');
  assert.equal(s.customer_id, null);

  const inv = (await client.get('/api/invoices')).body.items.find((v) => v.sale_id === saleId);
  assert.equal(inv.customer_name, 'Jamal Uddin');
  assert.equal(inv.customer_phone, '01700000000');
  assert.equal(inv.customer_id, null);
});

test('an existing-customer sale links the invoice by customer id', async () => {
  const { client } = tenant;
  const sale = await client.post('/api/sales', { lines: saleLines(1, 20), method: 'Cash', customer_id: customerId });
  const inv = (await client.get('/api/invoices')).body.items.find((v) => v.sale_id === sale.body.item.id);
  assert.equal(inv.customer_id, customerId);
  assert.equal(inv.customer_name, 'Acme Ltd', 'name comes from the customers join');
});

test('deleting a sale also deletes the invoice it generated', async () => {
  const { client } = tenant;
  const sale = await client.post('/api/sales', { lines: saleLines(1, 20), method: 'Cash' });
  const saleId = sale.body.item.id;
  assert.ok((await client.get('/api/invoices')).body.items.some((v) => v.sale_id === saleId));

  assert.equal((await client.del(`/api/sales/${saleId}`)).status, 200);
  assert.equal((await client.get('/api/invoices')).body.items.some((v) => v.sale_id === saleId), false);
});
