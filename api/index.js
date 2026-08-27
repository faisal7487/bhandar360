// Root-level Vercel serverless entry point — a duplicate of apps/app/api/index.js
// so this works regardless of whether the Vercel project's Root Directory is
// set to the repo root or to apps/app (we can't confirm which from here).
// See apps/app/api/index.js for the real logic; this just points at it.
module.exports = require('../apps/app/api/index.js');
