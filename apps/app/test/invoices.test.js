// Invoices: create, then edit — line items (with total recomputed), customer,
// branch, due date, and status — plus the status-only PUT that "Record payment"
// relies on, and delete.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, newTenant, deleteTenant } = require('./helpers');

let tenant;
let customerA;
let customerB;
let branchB;

before(async () => {
  await startServer();
  tenant = await newTenant('invoices');
  const { client } = tenant;
  customerA = (await client.post('/api/customers', { name: 'Acme Clinic' })).body.item.id;
  customerB = (await client.post('/api/customers', { name: 'Beta Hospital' })).body.item.id;
  branchB = (await client.post('/api/branches', { name: 'Uttara branch' })).body.item.id;
});

after(async () => {
  await deleteTenant(tenant.businessId);
  await stopServer();
});

test('create then edit line items — total is recomputed from the new lines', async () => {
  const { client } = tenant;
  const created = await client.post('/api/invoices', {
    customer_id: customerA,
    lines: [{ name: 'Consult', qty: 2, price: 500 }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.total, 1000);
  const id = created.body.item.id;

  const edited = await client.put(`/api/invoices/${id}`, {
    lines: [
      { name: 'Consult', qty: 1, price: 500 },
      { name: 'X-ray', qty: 2, price: 750 },
      { name: '', qty: 9, price: 9 }, // blank name -> dropped
    ],
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.total, 2000, '500 + 1500');
  assert.equal(edited.body.item.items.length, 2, 'blank line is not stored');

  const fetched = (await client.get('/api/invoices')).body.items.find((v) => v.id === id);
  assert.equal(fetched.total, 2000);
});

test('edit customer, branch, due date and status together', async () => {
  const { client } = tenant;
  const id = (await client.post('/api/invoices', { customer_id: customerA, lines: [{ name: 'A', qty: 1, price: 10 }] })).body.item.id;

  const edited = await client.put(`/api/invoices/${id}`, {
    customer_id: customerB,
    branch_id: branchB,
    due_date: '2026-09-30',
    status: 'paid',
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.customer_id, customerB);
  assert.equal(edited.body.item.branch_id, branchB);
  assert.equal(edited.body.item.due_date, '2026-09-30');
  assert.equal(edited.body.item.status, 'paid');
  assert.equal(edited.body.item.total, 10, 'total unchanged when lines are not sent');
});

test('payment method: set on create, edited, and validated', async () => {
  const { client } = tenant;
  const created = await client.post('/api/invoices', {
    customer_id: customerA,
    method: 'bKash',
    lines: [{ name: 'A', qty: 1, price: 10 }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.method, 'bKash');
  const id = created.body.item.id;

  const edited = await client.put(`/api/invoices/${id}`, { method: 'Bank transfer' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.method, 'Bank transfer');

  // Clearing it is allowed.
  assert.equal((await client.put(`/api/invoices/${id}`, { method: '' })).body.item.method, null);

  // Anything off the list is rejected.
  assert.equal((await client.post('/api/invoices', { customer_id: customerA, method: 'Crypto', lines: [{ name: 'A', qty: 1, price: 1 }] })).status, 400);
  assert.equal((await client.put(`/api/invoices/${id}`, { method: 'Crypto' })).status, 400);
});

test('status-only PUT still works (the Record-payment path)', async () => {
  const { client } = tenant;
  const id = (await client.post('/api/invoices', { customer_id: customerA, lines: [{ name: 'A', qty: 1, price: 40 }] })).body.item.id;
  const paid = await client.put(`/api/invoices/${id}`, { status: 'paid' });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.item.status, 'paid');
});

test('invalid status is rejected; foreign keys are tenant-checked', async () => {
  const { client } = tenant;
  const id = (await client.post('/api/invoices', { customer_id: customerA, lines: [{ name: 'A', qty: 1, price: 1 }] })).body.item.id;

  assert.equal((await client.put(`/api/invoices/${id}`, { status: 'bogus' })).status, 400);

  const other = await newTenant('invoices-other');
  try {
    const foreignCustomer = (await other.client.post('/api/customers', { name: 'Not Yours' })).body.item.id;
    const bad = await client.put(`/api/invoices/${id}`, { customer_id: foreignCustomer });
    assert.equal(bad.status, 400, 'cannot attach another tenant’s customer');
  } finally {
    await deleteTenant(other.businessId);
  }
});

test('delete removes the invoice and its line items', async () => {
  const { client } = tenant;
  const id = (await client.post('/api/invoices', { customer_id: customerA, lines: [{ name: 'A', qty: 1, price: 5 }] })).body.item.id;
  assert.equal((await client.del(`/api/invoices/${id}`)).status, 200);
  assert.equal((await client.get('/api/invoices')).body.items.find((v) => v.id === id), undefined);
  assert.equal((await client.del(`/api/invoices/${id}`)).status, 404);
});
