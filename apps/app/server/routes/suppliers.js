const db = require('../db');
const ah = require('../utils/asyncHandler');
const crudRouter = require('./_crud');

// Standard business-scoped CRUD for suppliers...
const router = crudRouter('suppliers', ['name', 'contact', 'phone', 'email', 'balance']);

// ...plus a "record a payment" action: reduce the supplier's outstanding
// balance and log the cash outflow as an expense, in one transaction so the
// two never drift apart. `FOR UPDATE` serialises concurrent payments to the
// same supplier. requireAuth is already applied by crudRouter on this router.
const paySupplier = db.transaction(async (businessId, id, amount, note) => {
  const sup = await db
    .prepare('SELECT id, name, balance FROM suppliers WHERE id = ? AND business_id = ? FOR UPDATE')
    .get(id, businessId);
  if (!sup) return null;

  const newBalance = Math.max(0, (Number(sup.balance) || 0) - amount);
  await db.prepare('UPDATE suppliers SET balance = ? WHERE id = ?').run(newBalance, sup.id);
  await db
    .prepare('INSERT INTO expenses (business_id, category, amount, note) VALUES (?, ?, ?, ?)')
    .run(businessId, 'Supplier payment', amount, note || `Payment to ${sup.name}`);

  return { ...sup, balance: newBalance };
});

router.post('/:id/pay', ah(async (req, res) => {
  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Enter a payment amount greater than 0' });
  }
  const updated = await paySupplier(req.user.business_id, req.params.id, amount, (req.body || {}).note);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ item: updated });
}));

module.exports = router;
