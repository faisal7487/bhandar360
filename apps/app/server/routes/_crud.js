const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const { assertOwned } = require('../utils/tenant');

// Generic business-scoped CRUD router for simple flat tables.
// columns: array of column names (excluding id, business_id, created_at) accepted on create/update.
// fkChecks: optional { columnName: referencedTable } map — validates that any
// client-supplied foreign key (e.g. branch_id) actually belongs to the
// caller's business before it's accepted, preventing cross-tenant references.
function crudRouter(table, columns, fkChecks = {}) {
  const router = express.Router();
  router.use(requireAuth);

  async function checkForeignKeys(body, businessId) {
    for (const [col, refTable] of Object.entries(fkChecks)) {
      if (body[col] !== undefined) await assertOwned(refTable, body[col], businessId);
    }
  }

  router.get('/', ah(async (req, res) => {
    const rows = await db
      .prepare(`SELECT * FROM ${table} WHERE business_id = ? ORDER BY id DESC`)
      .all(req.user.business_id);
    res.json({ items: rows });
  }));

  router.post('/', ah(async (req, res) => {
    const body = req.body || {};
    await checkForeignKeys(body, req.user.business_id);
    const cols = columns.filter((c) => body[c] !== undefined);
    const placeholders = cols.map(() => '?').join(', ');
    const colList = ['business_id', ...cols].join(', ');
    const values = [req.user.business_id, ...cols.map((c) => body[c])];
    const info = await db
      .prepare(`INSERT INTO ${table} (${colList}) VALUES (?, ${placeholders}) RETURNING id`)
      .run(...values);
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ item: row });
  }));

  router.put('/:id', ah(async (req, res) => {
    const body = req.body || {};
    await checkForeignKeys(body, req.user.business_id);
    const cols = columns.filter((c) => body[c] !== undefined);
    if (cols.length === 0) return res.status(400).json({ error: 'No fields to update' });

    // Check ownership BEFORE updating, and re-fetch scoped by business_id too —
    // otherwise a request for another tenant's row id silently no-ops the
    // UPDATE (business_id mismatch) but the unscoped follow-up SELECT would
    // still return that other tenant's full row back to the caller.
    const existing = await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND business_id = ?`).get(req.params.id, req.user.business_id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    const values = [...cols.map((c) => body[c]), req.params.id];
    await db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...values);
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND business_id = ?`).get(req.params.id, req.user.business_id);
    res.json({ item: row });
  }));

  router.delete('/:id', ah(async (req, res) => {
    const existing = await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND business_id = ?`).get(req.params.id, req.user.business_id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  }));

  return router;
}

module.exports = crudRouter;
