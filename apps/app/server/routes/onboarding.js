const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();

router.post('/', requireAuth, ah(async (req, res) => {
  const { businessName, industry, currency, taxRate, timezone, address, branchName, branchType, branchAddress } =
    req.body || {};
  const wasOnboarded = !!req.business.onboarded;

  await db.prepare(
    `UPDATE businesses SET
       name = COALESCE(?, name),
       industry = COALESCE(?, industry),
       currency = COALESCE(?, currency),
       tax_rate = COALESCE(?, tax_rate),
       timezone = COALESCE(?, timezone),
       address = COALESCE(?, address),
       onboarded = 1
     WHERE id = ?`
  ).run(
    businessName || null,
    industry || null,
    currency || null,
    taxRate === undefined ? null : Number(taxRate),
    timezone || null,
    address || null,
    req.user.business_id
  );

  if (!wasOnboarded) {
    if (branchName) {
      await db.prepare('INSERT INTO branches (business_id, name, type, address) VALUES (?, ?, ?, ?)').run(
        req.user.business_id,
        branchName,
        branchType || 'Retail outlet',
        branchAddress || null
      );
    }
    await db.prepare(`INSERT INTO warehouses (business_id, name, type) VALUES (?, 'Central store', 'Storage')`).run(
      req.user.business_id
    );
  }

  const business = await db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.user.business_id);
  res.json({
    business: {
      id: business.id,
      name: business.name,
      industry: business.industry,
      currency: business.currency,
      taxRate: business.tax_rate,
      timezone: business.timezone,
      address: business.address,
      plan: business.plan,
      onboarded: !!business.onboarded,
    },
  });
}));

module.exports = router;
