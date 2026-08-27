const db = require('../db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Verifies that a row referenced by a client-supplied foreign key (customer_id,
// branch_id, supplier_id, warehouse_id, product_id, ...) actually belongs to the
// caller's business before it's allowed into a new record. Without this check,
// a member of business A can pass an id belonging to business B and have it
// silently accepted — e.g. a sale that references business B's customer, whose
// name/contact then leaks into business A's sale list via the join. Returns
// silently for a null/undefined id (the field is optional).
async function assertOwned(table, id, businessId) {
  if (id === null || id === undefined || id === '') return;
  const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND business_id = ?`).get(id, businessId);
  if (!row) {
    throw new HttpError(400, `Invalid ${table.replace(/s$/, '')} reference`);
  }
}

module.exports = { assertOwned, HttpError };
