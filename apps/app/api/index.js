// Vercel serverless entry point. Any file under api/ becomes a function;
// this one wraps the real Express app (server/app.js) so the whole thing —
// API routes and the static frontend — runs behind a single function
// (see vercel.json, which rewrites every path here rather than trying to
// serve public/ separately, matching the single-server behavior the app
// already has locally).
const app = require('../server/app');
const db = require('../server/db');

// Migrations are idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
// EXISTS), but there's no reason to re-run them on every invocation — cache
// the result for the lifetime of this warm function instance.
//
// A migrate failure must NOT take the site down: the schema already exists in
// production, so if a cold-start burst can't get a pooler connection to run
// the (no-op) migration, log it and serve the request anyway. Set
// RUN_MIGRATIONS=false to skip the attempt entirely once the schema is stable.
let migrated = null;

module.exports = async (req, res) => {
  if (!migrated) {
    migrated =
      process.env.RUN_MIGRATIONS === 'false'
        ? Promise.resolve()
        : db.migrate().catch((err) => {
            console.error('migrate skipped (schema assumed present):', err.message);
          });
  }
  await migrated;
  return app(req, res);
};
