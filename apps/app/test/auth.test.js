const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, makeClient, newTenant, deleteTenant } = require('./helpers');

before(startServer);
after(stopServer);

test('signup requires name, email and password', async () => {
  const client = makeClient();
  const res = await client.post('/api/auth/signup', { name: 'X' });
  assert.equal(res.status, 400);
});

test('signup rejects invalid email and short password (server-side, not just UI)', async () => {
  const client = makeClient();
  const bad1 = await client.post('/api/auth/signup', { name: 'X', email: 'not-an-email', password: 'testpass123' });
  assert.equal(bad1.status, 400);

  const bad2 = await client.post('/api/auth/signup', { name: 'X', email: 'ok@example.com', password: 'short' });
  assert.equal(bad2.status, 400);
});

test('signup, /me, and signout round-trip', async () => {
  const { client, businessId } = await newTenant('authflow');
  try {
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.business.onboarded, false);

    const out = await client.post('/api/auth/signout');
    assert.equal(out.status, 200);

    const afterSignout = await client.get('/api/auth/me');
    assert.equal(afterSignout.status, 401, 'session cookie must be cleared after signout');
  } finally {
    await deleteTenant(businessId);
  }
});

test('duplicate email is rejected', async () => {
  const { client: unused, businessId, email } = await newTenant('dupe');
  try {
    const second = makeClient();
    const res = await second.post('/api/auth/signup', { name: 'Someone else', email, password: 'testpass123' });
    assert.equal(res.status, 409);
  } finally {
    await deleteTenant(businessId);
  }
});

test('signin rejects wrong password without revealing whether the email exists', async () => {
  const { businessId, email } = await newTenant('wrongpw');
  try {
    const client = makeClient();
    const res = await client.post('/api/auth/signin', { email, password: 'totally-wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid email or password');

    const unknown = await client.post('/api/auth/signin', { email: 'nobody@nowhere.invalid', password: 'whatever123' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, 'Invalid email or password', 'same generic message for unknown vs wrong-password');
  } finally {
    await deleteTenant(businessId);
  }
});

test('protected routes reject unauthenticated requests', async () => {
  const client = makeClient();
  const res = await client.get('/api/products');
  assert.equal(res.status, 401);
});
