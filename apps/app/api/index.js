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
// the promise for the lifetime of this warm function instance.
let migrated = null;

module.exports = async (req, res) => {
  if (!migrated) {
    migrated = db.migrate().catch((err) => {
      migrated = null; // let the next request retry instead of caching a failure forever
      throw err;
    });
  }
  await migrated;
  return app(req, res);
};
