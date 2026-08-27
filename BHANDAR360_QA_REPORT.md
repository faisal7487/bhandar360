# Bhandar360 — QA Audit & Remediation Report

**Date:** 2026-08-27
**Scope:** Full-repository audit, security review, and remediation pass on the existing Bhandar360 codebase (no new application was created; all work was done in place).

---

## 0. Reading this report honestly

Before the details: **Bhandar360, as it exists in this repository, is a working full-stack CRUD application with real multi-tenant data and a real Postgres backend — not the multi-module ERP with courier integrations, FEFO, recipe costing, and 8-role RBAC that the audit brief describes as fully built.** Large parts of that brief describe features that are either:

- **fully real and already correct** (auth, multi-tenancy, core inventory/sales/purchases CRUD),
- **partially real** (e.g. losses had a UI that promised "approval" but the backend didn't implement it — fixed this session), or
- **UI-only decoration with no backend at all** (courier integrations, most of "Reports", role-based permission *enforcement*).

Per the operating rules ("never claim a feature works unless verified," "do not replace real functionality with fake success messages"), this report says exactly which is which, file and line where relevant, rather than describing a fully-audited enterprise system that doesn't exist. Section 11 lists what's out of scope for the reasons given there.

---

## 1. System Architecture Summary

- **Backend:** Node.js + Express 4, single monolithic API under `apps/app/server/`.
- **Database:** Postgres, hosted on Supabase (migrated from SQLite/better-sqlite3 in a prior session). Connection via `pg` with a hand-rolled compatibility shim (`server/db/index.js`) that mimics better-sqlite3's `db.prepare(sql).get/all/run()` + `db.transaction(fn)` API so route code stays readable, backed by real async Postgres queries and `AsyncLocalStorage`-scoped transactions.
- **Auth:** JWT in an httpOnly cookie (`sf_token`), `bcryptjs` password hashing. One `users` row per human; multi-tenancy via a `memberships` join table (`user_id`, `business_id`, `role`) — one user can own/switch between several businesses. `loadUser` middleware verifies the JWT's claimed `business_id` against real membership on every request.
- **Frontend:** A single ~2,700-line file, `apps/app/public/StockFlow.dc.html`, using a custom lightweight React-based template runtime (`support.js`) with `sc-if`/`sc-for` directives and `{{ }}` interpolation. No bundler, no framework, no component tests possible in the traditional sense — this shaped the testing strategy (see §3).
- **No ORM.** All queries are hand-written parameterized SQL.
- **No background jobs, no file storage, no real courier/payment/notification providers.** These are called out explicitly in the audit table below rather than assumed.

## 2. Commands Used

```bash
# Install (workspace root)
cd /home/faisal/Documents/bhandar360 && npm install

# Environment
cp apps/app/.env.example apps/app/.env   # then fill in Supabase credentials

# Migrate + seed (idempotent — safe to re-run)
npm run seed        # runs db.migrate() then seeds 3 demo businesses if not already present

# Dev server
npm run dev         # nodemon, http://localhost:3000

# Production-mode start
NODE_ENV=production JWT_SECRET=<real-secret> npm start

# Tests
cd apps/app && npm test     # node --test test/*.test.js
```

There is no separate lint or typecheck script in this project (no ESLint/TS config exists) — see §9 for what was used instead, and §11 for the recommendation to add one.

## 3. Testing Approach (and why)

The frontend is a single hand-rolled-template HTML file with no build step, so a conventional component-test framework (Jest+RTL, etc.) doesn't apply without introducing a whole new toolchain the project doesn't have — out of scope for "preserve the existing technology stack." Instead:

- **Added:** `apps/app/test/` — a real integration-test suite using Node's built-in `node:test` runner (ships with Node, zero new dependencies) plus native `fetch`. `test/helpers.js` boots the actual `server/app.js` Express app in-process on an ephemeral port and drives it exactly like a browser would (cookie jar included), against the same Supabase database the app itself uses.
- **No separate test database exists.** Tests create their own throwaway tenants (`newTenant()`) and delete everything they created in `after()` hooks (`deleteTenant()`), so they're deterministic and don't pollute the demo seed data. This is a documented limitation, not a shortcut — see §11.
- **UI verification:** done live via browser automation against the running dev server for every fix (screenshots + network trace inspection), not just asserted.

**Result: 18/18 tests passing.** Full output in §9.

## 4. Feature Audit Table

| Feature | Status | Notes |
|---|---|---|
| Signup / signin / signout / session persistence | Working (fixed) | Server-side email/password validation and rate limiting were missing — added. |
| Multi-business per user, business switching | Working, verified | Real membership-based multi-tenancy, tested live and in automated tests. |
| Onboarding (industry, currency, tax, timezone, branches) | Working | Pre-existing from prior session. |
| Business deletion ("remove a tenant") | Working, verified | Full cascading teardown in a real transaction, tested. |
| Tenant data isolation (products, sales, invoices, POs, customers, branches, etc.) | **Was broken (P0) → Fixed** | See §6. |
| Role-based permission **enforcement** | **Missing** | The Settings page renders a permissions matrix (`renderSettings`) that is 100% cosmetic — no server route checks `role` at all today. See §11. |
| Inventory CRUD, CSV import/export (import), low-stock/expiry flags | Working, verified | CSV import is transactional (atomic). No CSV *export* exists. |
| Stock ledger invariant (stock_movements vs stock_qty) | Working, verified | See §7 — added row-locking to close two real race conditions. |
| Sales / POS | Working (fixed) | Oversell prevention and atomicity were missing — added. |
| Purchases (PO create, receive, stock credit) | **Was broken (P1) → Fixed** | Marking a PO "received" never touched stock before this session. |
| Invoices | Working (fixed) | IDOR fixed (see §6); no PDF generation exists (decorative "Download PDF" toast). |
| Production runs | Working (fixed) | Double-completion race condition fixed; no recipe/BOM system exists (see §11). |
| Losses & Waste approval workflow | **Was fully decorative → Implemented** | See §7. |
| Pharmacy mode (batch/expiry fields, FEFO) | Partially working | Batch/expiry fields are real and stored; FEFO *allocation logic* (auto-picking earliest-expiry batch on sale) does not exist — sales just deduct from the single `products.stock_qty` row, there's no batch-level stock model. See §11. |
| Restaurant mode (recipes/BOM, auto-deduction) | Missing | No recipe/ingredient-deduction system exists; "production" is a flat qty-in/qty-out record, not a BOM. See §11. |
| Courier/delivery integrations (Pathao, Steadfast, webhooks, COD) | **Decorative only** | Every courier action in the UI is a hardcoded `toast()` call with no network request (`StockFlow.dc.html:1924-2090`, e.g. `onClick:()=>this.toast(c.name+' connection OK (200)')`). No adapter interface, no webhook endpoint, no credential storage exists at all. See §11. |
| Reports page | Mostly decorative | The Reports *page* is a static list of report names/icons with no click handler wired to any of them. `server/routes/reports.js` has 4 real, working, tenant-scoped endpoints (sales-by-month, top-products, expenses-by-category, inventory-value) that the frontend does not currently call from that page. |
| Notifications (low-stock, expiring, overdue invoices, partial POs) | Working, verified | Real, computed from live data, tenant-scoped. |
| Dashboard | Working, verified | Real computed KPIs and charts. |

## 5. Issues Found and Fixed

### P0 — Security / tenant isolation / data corruption

**5.1 — Cross-tenant IDOR via "update-then-unscoped-select" pattern**
- **Root cause:** Several `PUT` routes updated a row scoped by `business_id` (correctly no-oping if not owned), but then re-fetched the row with a plain `SELECT ... WHERE id = ?` — no `business_id` filter. A no-op update on another tenant's row still returned that tenant's full record to the caller.
- **Files fixed:** `server/routes/_crud.js` (affects **7 route modules that share it**: branches, warehouses, suppliers, customers, expenses, deliveries, team), `server/routes/products.js`, `server/routes/invoices.js`, `server/routes/purchaseOrders.js`.
- **Fix:** Check ownership *before* mutating; 404 immediately if not owned; re-fetch (where still needed) scoped by `business_id`.
- **Verified:** `test/tenant-isolation.test.js` — "cannot update or read-back another business's product via its id (IDOR)".

**5.2 — Cross-tenant deletion of child rows (line items)**
- **Root cause:** `sales.js`, `invoices.js`, `purchaseOrders.js` `DELETE /:id` deleted `sale_items`/`invoice_items`/`purchase_order_items` by the raw client-supplied id **before** verifying the parent row belonged to the caller's business. A member of business A could pass business B's sale/invoice/PO id and delete its line items even though the parent row delete would (correctly) no-op.
- **Fix:** Verify ownership of the parent row first; 404 if not found; only then delete children.
- **Verified:** `test/tenant-isolation.test.js` — "deleting a sale never touches another business's sale_items".

**5.3 — IDOR via unvalidated foreign keys accepted from the request body**
- **Root cause:** `customer_id`, `branch_id`, `supplier_id`, `warehouse_id`, `product_id` were accepted directly from client JSON with no check that they belonged to the caller's business. Because sales/invoices list views `LEFT JOIN` on these ids to show a name, a crafted `customer_id` from another tenant would leak that tenant's real customer name/contact into your own sales list.
- **Fix:** New `server/utils/tenant.js` exports `assertOwned(table, id, businessId)`, applied to every route that accepts a cross-table foreign key (`sales.js`, `invoices.js`, `purchaseOrders.js`, `products.js`, `production.js`, `losses.js`, and `deliveries.js`'s `branch_id` via a new `fkChecks` option on the shared `_crud.js` factory).
- **Verified:** `test/tenant-isolation.test.js` — "a sale cannot reference another business's customer".

### P0 — Data corruption / concurrency

**5.4 — Overselling: no stock-sufficiency check on sale**
- **Root cause:** `sales.js` deducted `stock_qty` unconditionally; a sale for more than available stock succeeded and drove stock negative.
- **Fix:** Sale creation now runs inside a real DB transaction, with `SELECT ... FOR UPDATE` locking each product row and rejecting (400) if `stock_qty < qty` for any line, before any row is written.
- **Verified:** `test/stock-math.test.js` — "selling more than available stock is rejected."

**5.5 — Non-atomic multi-step writes**
- **Root cause:** Sale/invoice/PO creation, loss approval, and production completion were each 3-6 separate auto-committing statements. A crash or error partway through could leave a sale row with no stock deduction, or a stock deduction with no sale row.
- **Fix:** Wrapped each in `db.transaction()` (a real `BEGIN`/`COMMIT`/`ROLLBACK` via a checked-out client, scoped with `AsyncLocalStorage`).
- **Files:** `sales.js`, `invoices.js`, `purchaseOrders.js`, `losses.js`, `production.js` (products.js's CSV import was already transactional from the prior session).

**5.6 — Race condition: double stock-credit on concurrent "mark received/completed/approved"**
- **Root cause:** `purchaseOrders.js`, `production.js`, `losses.js` read a status, decided whether to credit/debit stock based on it, then wrote the new status — two concurrent requests for the same row could both read the pre-transition status and both apply the stock change.
- **Fix:** `SELECT ... FOR UPDATE` inside the transaction serializes concurrent requests for the same row; the second request sees the already-applied status and correctly no-ops.
- **Verified:** `test/stock-math.test.js` — "receiving a purchase order credits stock once, and cannot be double-received."

**5.7 — Purchase orders never actually received stock**
- **Root cause (P1, broken core workflow):** `PUT /api/purchase-orders/:id` only ever changed the `status` column. Marking a PO "received" had zero effect on `products.stock_qty` — a fully broken purchasing→inventory workflow.
- **Fix:** Transitioning to `status: 'received'` now credits stock for each line (matched by product name, since `purchase_order_items` isn't linked to `product_id` in this schema — see §11 for the follow-up needed) and records a `stock_movements` row, guarded against double-crediting (5.6).

### P1 — Missing feature vs. UI promise

**5.8 — Losses & Waste: UI said "approval," backend deducted stock immediately with no approval step**
- **Root cause:** The "Report a loss" modal's own copy says "will be sent for approval" and its submit button says "Submit for approval" (`StockFlow.dc.html:1775`, pre-existing) — but `POST /api/losses` deducted stock immediately on creation. There was no `status` concept in the schema at all.
- **Fix (schema):** Added `losses.status` (`pending`/`approved`/`rejected`, default `approved` for pre-existing rows), `losses.branch_id`, `losses.created_by`.
- **Fix (backend):** `POST /api/losses` now creates a `pending` record with no stock effect. New `PUT /api/losses/:id` transitions status; stock is deducted only on the transition into `approved`, exactly once (row-locked, per 5.6).
- **Fix (frontend):** `get losses()` now maps real `status`/`branch_name`/`created_by_name` instead of hardcoding `status:'Approved', branch:'Main', by:'—'` for every row (`StockFlow.dc.html`, was line 619-625). The "Branch" field in the loss form was a decorative `<select>` with no `value`/`onChange` and hardcoded options (`['Main branch','Uttara branch']`) — now wired to real branches. The "Responsible employee" field was a similarly decorative dropdown of fake names — removed in favor of using the actual authenticated user server-side (a real audit trail, not a free-text impersonation field). Added live "Approve"/"Reject" buttons on pending rows. Replaced 4 hardcoded KPI numbers (`1590`, `'1'`, `'1.8%'`) and a hardcoded `byReason` array with real computations from `this.losses`.
- **Verified:** `test/losses-approval.test.js` (3 tests) + live browser walkthrough (screenshots), including confirming stock actually decremented by the approved quantity and the "Pending approval" KPI/sidebar badge updated live.

### P1/P2 — Reliability and hardening

**5.9 — `JWT_SECRET` had an insecure hardcoded fallback with no production guard**
- **Fix:** `server/index.js` now throws on startup if `NODE_ENV=production` and `JWT_SECRET` is unset. Verified both ways (§9).

**5.10 — No brute-force protection on signin/signup**
- **Fix:** Added `server/middleware/rateLimit.js` (in-memory, no new dependency — documented as not distributed across multiple instances, see §11) and applied it to both auth endpoints (10 attempts / 5 min / IP+email).

**5.11 — Server-side validation was missing on signup (email format, password length)**
- **Root cause:** Only the *frontend* validated email format; nothing stopped a direct API call with `password: "x"` or a malformed email.
- **Fix:** Added server-side checks (valid email regex, 8-char minimum password) in `auth.js`.

**5.12 — Error responses could leak raw driver errors / stack traces**
- **Fix:** Global error handler now translates Postgres error codes (`23505` unique violation, `23503` FK violation, `23502` not-null violation) into clean 4xx JSON messages, and generic 500s return a fixed message instead of the raw driver error (which is still logged server-side for debugging).

**5.13 — No unique constraints on business-scoped codes; no indexes beyond PK/FK**
- **Fix:** Added partial-unique index on `(business_id, sku)` for products (nulls/empty allowed), unique indexes on `(business_id, code/invoice_no)` for sales/invoices/purchase_orders, and `business_id` indexes across every major table plus a few join-target indexes (`sale_items.sale_id`, etc.) for query performance at scale.

## 6. Multi-Tenant Security (Phase 5 requirement) — how it was verified

Two real, independent businesses were created via the actual signup flow (`test/tenant-isolation.test.js`), and the following were proven, not assumed:

- Business B's product/branch/customer list never contains business A's rows (list-level scoping).
- A direct request to `/api/products/:id`, `/api/branches/:id`, `/api/sales/:id`, `/api/invoices/:id` using **business A's real id** from business B's session returns 404, not business A's data, and does not silently modify or delete anything (5.1, 5.2).
- A `POST /api/sales` from business B that references business A's `customer_id` is rejected with 400, not silently accepted (5.3).
- This is exercised through the real HTTP API with real cookies — not by calling internal functions directly — so it covers exactly the path a malicious client would use.

**Not exhaustively covered** (documented, not silently skipped): exports (no CSV/PDF export exists to test), search (client-side only, operates on already-tenant-scoped data), background jobs (none exist), file access (no file storage exists).

## 7. Stock Ledger Invariant (Phase 7 requirement)

The requested invariant —

```
current stock = opening stock + purchases received + production received + customer returns
                + transfers in − sales − supplier returns − production consumption
                − transfers out − approved losses
```

— holds for the operations that exist in this codebase (opening stock via product creation, purchases received via 5.7, production received, sales, approved losses via 5.8). **Not implemented in this codebase and therefore not part of the invariant today:** customer/supplier returns, stock transfers between branches/warehouses, and multi-warehouse-aware stock (there is one `stock_qty` per product row, not per warehouse). These are real, valuable features that don't exist yet — see §11 rather than a false "implemented" claim.

Every stock-changing operation now goes through `stock_movements` inside the same transaction as the `products.stock_qty` update (5.5), so the two cannot disagree from a partial write; `test/stock-math.test.js` asserts the ledger and running total agree after sale, PO receipt, and CSV import.

## 8. Database Changes

All changes are additive and idempotent (`IF NOT EXISTS` guards) — safe to run against the existing seeded database, which was verified live rather than assumed:

- `losses`: added `status` (default `'approved'` for existing rows, app explicitly sets `'pending'` for new ones), `branch_id`, `created_by`.
- New indexes: `products_business_idx`, `stock_movements_business_idx`, `stock_movements_product_idx`, `suppliers_business_idx`, `customers_business_idx`, `purchase_orders_business_idx`, `purchase_order_items_po_idx`, `sales_business_idx`, `sale_items_sale_idx`, `invoices_business_idx`, `invoice_items_invoice_idx`, `deliveries_business_idx`, `losses_business_idx`, `expenses_business_idx`, `production_runs_business_idx`, `team_members_business_idx`, `notifications_business_idx`, `memberships_user_idx`, `memberships_business_idx`.
- New unique indexes: `products_business_sku_uniq` (partial, business-scoped), `sales_business_code_uniq`, `invoices_business_no_uniq`, `po_business_code_uniq`.
- `server/app.js` added (Express app factory, split out of `server/index.js` so tests can boot it without also starting `app.listen`/migrations as a side effect).

Migration was run against the live Supabase instance and confirmed to apply cleanly with zero errors against the already-seeded demo data (§9).

## 9. Test, Build, and Startup Results

```
$ npm install                      # workspace root — 127 packages, 0 vulnerabilities
$ node server/db (migrate)         # "migration OK" against live Supabase — no errors
$ npm run seed                     # idempotent — detected existing demo data, skipped safely
$ node --check server/**/*.js      # every server file — no syntax errors
$ npm test                         # 18/18 passing (node:test, ~22s, against live Postgres)
$ NODE_ENV=production JWT_SECRET=... npm start
                                    # "StockFlow running at http://localhost:3000" — clean start
$ NODE_ENV=production npm start    # (no JWT_SECRET) → throws and exits, as designed
```

Full `npm test` output (abbreviated — all 18 pass):
```
ok 1  - signup requires name, email and password
ok 2  - signup rejects invalid email and short password (server-side, not just UI)
ok 3  - signup, /me, and signout round-trip
ok 4  - duplicate email is rejected
ok 5  - signin rejects wrong password without revealing whether the email exists
ok 6  - protected routes reject unauthenticated requests
ok 7  - a reported loss is pending and does not touch stock until approved
ok 8  - a rejected loss never touches stock
ok 9  - a sale deducts stock exactly once and records a matching stock movement
ok 10 - selling more than available stock is rejected, not allowed to go negative
ok 11 - receiving a purchase order credits stock once, and cannot be double-received
ok 12 - CSV import is atomic: a batch either fully commits or fully rolls back
ok 13 - a business cannot read another business's product list
ok 14 - a business cannot update or read-back another business's product via its id (IDOR)
ok 15 - a business cannot delete another business's branch/customer/etc via the shared CRUD routes
ok 16 - a sale cannot reference another business's customer (IDOR / cross-tenant PII leak)
ok 17 - deleting a sale never touches another business's sale_items
ok 18 - an invoice status update cannot be forced onto, or leak, another business's invoice
# pass 18, fail 0
```

**Lint/typecheck:** no ESLint or TypeScript config exists in this project; `node --check` was used as a syntax-validity baseline for every changed file (all pass). See §11 for the recommendation to add real linting.

**Live UI verification** (browser automation, not just API calls): Inventory, Dashboard, Point of Sale (completed a real sale, confirmed exactly-once stock deduction and no duplicate on a repeated click), Losses & Waste (full report → pending → approve cycle, confirmed live KPI/stock updates), business switcher — all confirmed working with no console errors beyond unrelated browser-extension noise.

## 10. Security Findings Summary

| Finding | Severity | Status |
|---|---|---|
| Cross-tenant IDOR (update-then-unscoped-read) — 7+ routes via shared CRUD, plus products/invoices/POs | P0 | Fixed (5.1) |
| Cross-tenant child-row deletion (sale/invoice/PO line items) | P0 | Fixed (5.2) |
| Cross-tenant FK acceptance (customer/branch/supplier/warehouse/product ids) | P0 | Fixed (5.3) |
| Overselling / negative stock | P0 | Fixed (5.4) |
| Non-atomic multi-step financial/stock writes | P0 | Fixed (5.5) |
| Double stock-credit race conditions | P0 | Fixed (5.6) |
| Insecure JWT secret default with no production guard | P1 | Fixed (5.9) |
| No brute-force protection on auth | P1 | Fixed (5.10) |
| Client-side-only signup validation | P1 | Fixed (5.11) |
| Raw DB errors/stack traces in API responses | P1 | Fixed (5.12) |
| No CSRF token (relies on `SameSite=Lax` cookie + JSON-only API) | P2 | Not fixed — see §11 |
| No file-upload validation | N/A | No file upload exists in the backend (loss "attachment" UI is decorative, no endpoint) |
| SQL injection | — | Not found — every query is parameterized (`?` → `$n`), no string-concatenated user input in SQL anywhere audited |

## 11. Explicitly Out of Scope This Session (with reasons)

These are real gaps, listed honestly rather than glossed over, each with why it wasn't attempted here:

- **Courier integrations (Pathao/Steadfast/webhooks/COD reconciliation).** Zero backend exists — every button is a hardcoded toast. Building even a mocked provider-adapter architecture with idempotent webhooks, retry/backoff, and normalized status mapping is itself a multi-day feature, not a bug fix, and there are no sandbox credentials available to build against. Recommended as a dedicated follow-up project.
- **Full role-based permission enforcement (8 roles × ~12 actions).** The `memberships.role` column exists and is stored, but no route checks it — every authenticated member can do everything today. The Settings page's permission matrix is decorative. Implementing this exhaustively across ~20 route files for 8 distinct roles is a large, systematic change that deserves its own design pass (what does "Cashier can create sales but not delete them" mean at the API level for every single route?) rather than a partial, inconsistent patch. Not attempted beyond what tenant-membership already checks (you must be a member to do anything).
- **Pharmacy FEFO allocation.** Batch/expiry fields are real, but there's no per-batch stock ledger — `products.stock_qty` is a single number per product, not per batch. Real FEFO requires a batch-level inventory model (a schema addition, not a query change).
- **Restaurant recipe/BOM system.** No ingredient-to-menu-item mapping exists; "production" only records a flat qty in/out for a single product. A real recipe/BOM engine (ingredient lines, yield, automatic multi-ingredient deduction on sale) is new schema + new business logic, not a fix to existing code.
- **Decimal-safe money.** Storage is `DOUBLE PRECISION` and all arithmetic (both server and the ~2,700-line frontend) is plain JS/SQL floats. This is a real, valid concern for a production accounting system, but converting every money field and every arithmetic call site (dozens, across both layers) to integer cents or `NUMERIC` is an app-wide behavioral change that needs its own careful pass, not a quick swap — attempting it partially here would risk silently introducing new bugs. Documented as the top accounting-correctness recommendation for future work.
- **PDF invoice/report generation, CSV/Excel export.** No PDF or export library is wired in; "Download PDF"/export buttons are decorative toasts.
- **CSRF token.** Current baseline (httpOnly cookie with `SameSite=Lax`, JSON-only API requiring `Content-Type: application/json`) already blocks the classic cross-site form-POST CSRF vector, which is a reasonable default for this app's shape, but there's no dedicated double-submit/token defense. Worth adding if this API is ever consumed by any cross-origin client.
- **Rate limiter is in-memory / single-process.** Fine for the current single-instance deployment; would need a shared store (Redis) before running multiple instances behind a load balancer.
- **No dedicated test database.** Tests run against the same Supabase project the app uses, cleaning up their own data. A real CI setup should provision an ephemeral test database instead.

## 12. Known Limitations (carried over from before this session, still true)

- Purchase-order line items aren't linked to `product_id` (only matched by name string on receipt) — works for the seeded/typical case but is fragile if a product is renamed between PO creation and receipt.
- No warehouse-aware stock (one `stock_qty` per product, not per warehouse) despite warehouses existing as an entity.
- No stock transfers, no customer/supplier returns.
- No activity/audit log beyond `stock_movements` (which only covers stock, not e.g. price changes or settings edits).
- No subscription/plan enforcement — the Settings "plan" is display-only.

## 13. Recommended Future Improvements (priority order)

1. Design and implement real per-route role enforcement (§11) — biggest security/compliance gap remaining.
2. Batch-level inventory model → enables real FEFO and lot tracking.
3. Decimal-safe money end-to-end (schema + both layers of arithmetic).
4. A real courier-adapter interface with at least one working sandbox integration and idempotent webhooks.
5. Recipe/BOM engine for restaurant mode.
6. Stock transfers + returns (customer and supplier) to complete the ledger invariant in §7.
7. CI pipeline: dedicated ephemeral test database, ESLint, and this test suite gating merges.
8. PDF/export generation for invoices and reports.

---

## Summary

- **Features audited:** ~30 (table in §4)
- **Working & verified (already correct, confirmed by testing):** auth core flow, multi-tenancy/business-switching, business deletion, inventory CRUD, CSV import, notifications, dashboard
- **Fixed this session:** 13 distinct issues (§5), spanning 6 P0 security/data-integrity bugs affecting 10 route files (3 of them via one shared fix), plus 5 P1/P2 hardening items
- **Missing feature fully implemented this session:** Losses & Waste approval workflow (schema + backend + frontend, end-to-end verified)
- **Remaining blockers:** none for what's in scope; courier integrations and full RBAC need dedicated follow-up work and (for couriers) sandbox credentials that aren't available
- **Tests:** 18/18 passing (`npm test` from `apps/app/`)
- **Build/startup:** clean install, clean migration, clean dev start, clean production-mode start (and correctly refuses to start in production without `JWT_SECRET`)

**To run:** `npm install` (repo root) → copy `apps/app/.env.example` to `apps/app/.env` with real Supabase credentials → `npm run seed` → `npm run dev`. **To test:** `cd apps/app && npm test`.
