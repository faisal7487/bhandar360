// Minimal test harness: boots the real Express app (server/app.js) on an
// ephemeral port and gives each test its own cookie-carrying HTTP client, so
// integration tests exercise real routes + real middleware + the real
// Supabase Postgres database (see README "Testing" section for why there's
// no separate test database).
require('dotenv').config();
const http = require('http');
const app = require('../server/app');
const db = require('../server/db');

let server;
let baseUrl;

async function startServer() {
  await db.migrate();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

function stopServer() {
  return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

// A "client" carries a single Set-Cookie session across requests, mirroring
// what a signed-in browser tab does — needed because auth is an httpOnly
// cookie, not a bearer token.
function makeClient() {
  let cookie = '';
  async function request(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // non-JSON response
    }
    return { status: res.status, body: json };
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
  };
}

let counter = 0;
function uniqueEmail(prefix) {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}@test.bhandar360.invalid`;
}

// Signs up a fresh business+owner and returns a ready-to-use client plus ids.
async function newTenant(prefix) {
  const client = makeClient();
  const email = uniqueEmail(prefix);
  const signup = await client.post('/api/auth/signup', {
    name: `${prefix} Owner`,
    email,
    password: 'testpass123',
  });
  if (signup.status !== 200) {
    throw new Error(`signup failed for ${prefix}: ${JSON.stringify(signup.body)}`);
  }
  return { client, email, userId: signup.body.user.id, businessId: signup.body.user.business.id };
}

// Removes everything a test tenant could have created, so repeated test runs
// don't accumulate junk businesses in the shared database.
async function deleteTenant(businessId) {
  await db.prepare('DELETE FROM stock_movements WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE business_id = ?)').run(businessId);
  await db.prepare('DELETE FROM sales WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE business_id = ?)').run(businessId);
  await db.prepare('DELETE FROM invoices WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE business_id = ?)').run(businessId);
  await db.prepare('DELETE FROM purchase_orders WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM losses WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM production_runs WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM products WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM customers WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM suppliers WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM branches WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM warehouses WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM deliveries WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM memberships WHERE business_id = ?').run(businessId);
  // users.business_id is NOT NULL + FK'd to businesses, so users must go
  // before the business row they point at.
  await db.prepare('DELETE FROM users WHERE business_id = ?').run(businessId);
  await db.prepare('DELETE FROM businesses WHERE id = ?').run(businessId);
}

module.exports = { startServer, stopServer, makeClient, newTenant, deleteTenant, db };
