require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// COUNT(*) and other aggregates come back as BIGINT, which node-postgres
// parses as a string by default (to avoid precision loss on huge values).
// This app's counts always fit safely in a JS number, and several routes do
// arithmetic/string-building on them (e.g. `'SL-' + (3000 + count + 1)`),
// so parse bigint as a number to match better-sqlite3's old behavior.
types.setTypeParser(20, (val) => parseInt(val, 10));

const ssl = process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };

// Prefer discrete PGHOST/PGUSER/PGPASSWORD/... fields over a single
// DATABASE_URL: Supabase passwords often contain characters (%, +, etc.)
// that aren't valid unescaped in a URI, and get mis-parsed or throw when
// decoded from a connection string. Discrete fields sidestep that — the
// password is used as a literal string, never URI-decoded.
let poolConfig;
if (process.env.PGHOST) {
  poolConfig = {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'postgres',
    ssl,
  };
} else if (process.env.DATABASE_URL) {
  poolConfig = { connectionString: process.env.DATABASE_URL, ssl };
} else {
  throw new Error(
    'No database connection configured. Copy .env.example to .env and fill in your Supabase Postgres credentials (PGHOST/PGUSER/PGPASSWORD/PGDATABASE, or DATABASE_URL).'
  );
}

const pool = new Pool(poolConfig);

// Scopes queries issued inside `transaction()` to the same checked-out client,
// so nested `db.prepare(...)` calls participate in the surrounding transaction
// without every call site having to thread a client/connection through.
const als = new AsyncLocalStorage();

function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  const client = als.getStore() || pool;
  return client.query(toPgParams(sql), params);
}

function prepare(sql) {
  return {
    all: async (...params) => (await query(sql, params)).rows,
    get: async (...params) => (await query(sql, params)).rows[0],
    run: async (...params) => {
      const result = await query(sql, params);
      return {
        lastInsertRowid: result.rows[0] && result.rows[0].id,
        changes: result.rowCount,
      };
    },
  };
}

// Mirrors better-sqlite3's `db.transaction(fn)`: returns a function that,
// when called, runs `fn` inside BEGIN/COMMIT (ROLLBACK on throw).
function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await als.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };
}

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

module.exports = { prepare, transaction, query, migrate, pool };
