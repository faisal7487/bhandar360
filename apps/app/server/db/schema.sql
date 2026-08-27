-- Postgres schema (Supabase). Timestamps are stored as plain TEXT in the same
-- 'YYYY-MM-DD HH:MM:SS' (UTC) / 'YYYY-MM-DD' shape the app has always used,
-- rather than native TIMESTAMP/DATE columns — this keeps every date string
-- round-tripping through the API exactly as before, with no timezone
-- conversion surprises in the frontend.

CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT 'pharmacy',
  currency TEXT NOT NULL DEFAULT 'BDT',
  tax_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  address TEXT,
  plan TEXT NOT NULL DEFAULT 'trial',
  onboarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  avatar_color TEXT NOT NULL DEFAULT 'linear-gradient(135deg,#169B62,#0d9488)',
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, business_id)
);

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Retail outlet',
  address TEXT
);

CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Storage',
  address TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  category_id INTEGER REFERENCES categories(id),
  category TEXT,
  warehouse_id INTEGER REFERENCES warehouses(id),
  name TEXT NOT NULL,
  generic TEXT,
  brand TEXT,
  mfr TEXT,
  form TEXT,
  strength TEXT,
  supplier TEXT,
  sku TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  cost_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  sale_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  wholesale_price DOUBLE PRECISION,
  stock_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  reorder_level DOUBLE PRECISION NOT NULL DEFAULT 0,
  batch_no TEXT,
  mfg_date TEXT,
  expiry_date TEXT,
  restricted INTEGER NOT NULL DEFAULT 0,
  variants TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL, -- purchase | sale | adjustment | loss | production
  qty DOUBLE PRECISION NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  credit_limit DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | partial | received | cancelled
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  name TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL DEFAULT 1,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  customer_id INTEGER REFERENCES customers(id),
  branch_id INTEGER REFERENCES branches(id),
  code TEXT NOT NULL,
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  paid_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'Cash',
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL DEFAULT 1,
  price DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  customer_id INTEGER REFERENCES customers(id),
  branch_id INTEGER REFERENCES branches(id),
  invoice_no TEXT NOT NULL,
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | sent | paid | overdue
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  name TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL DEFAULT 1,
  price DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  branch_id INTEGER REFERENCES branches(id),
  order_ref TEXT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | picked_up | in_transit | delivered | failed
  zone TEXT,
  tracking_no TEXT,
  address TEXT,
  customer_name TEXT,
  phone TEXT,
  city TEXT,
  postcode TEXT,
  weight DOUBLE PRECISION,
  cod_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS losses (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  product_id INTEGER REFERENCES products(id),
  branch_id INTEGER REFERENCES branches(id),
  created_by INTEGER REFERENCES users(id),
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'approved', -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
-- Existing databases created before the approval workflow was added.
ALTER TABLE losses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE losses ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE losses ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  category TEXT,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS production_runs (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  product_id INTEGER REFERENCES products(id),
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active
  invited_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  severity TEXT NOT NULL DEFAULT 'info',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ---------------------------------------------------------------------------
-- Constraints and indexes.
-- Uniqueness is scoped per business (a SKU/code only needs to be unique
-- within a tenant, not globally) — a partial index skips null/empty SKUs so
-- multiple products without one don't collide.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS products_business_sku_uniq ON products (business_id, sku) WHERE sku IS NOT NULL AND sku <> '';
CREATE UNIQUE INDEX IF NOT EXISTS sales_business_code_uniq ON sales (business_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_business_no_uniq ON invoices (business_id, invoice_no);
CREATE UNIQUE INDEX IF NOT EXISTS po_business_code_uniq ON purchase_orders (business_id, code);

CREATE INDEX IF NOT EXISTS products_business_idx ON products (business_id);
CREATE INDEX IF NOT EXISTS stock_movements_business_idx ON stock_movements (business_id);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_id);
CREATE INDEX IF NOT EXISTS suppliers_business_idx ON suppliers (business_id);
CREATE INDEX IF NOT EXISTS customers_business_idx ON customers (business_id);
CREATE INDEX IF NOT EXISTS purchase_orders_business_idx ON purchase_orders (business_id);
CREATE INDEX IF NOT EXISTS purchase_order_items_po_idx ON purchase_order_items (po_id);
CREATE INDEX IF NOT EXISTS sales_business_idx ON sales (business_id);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS invoices_business_idx ON invoices (business_id);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS deliveries_business_idx ON deliveries (business_id);
CREATE INDEX IF NOT EXISTS losses_business_idx ON losses (business_id);
CREATE INDEX IF NOT EXISTS expenses_business_idx ON expenses (business_id);
CREATE INDEX IF NOT EXISTS production_runs_business_idx ON production_runs (business_id);
CREATE INDEX IF NOT EXISTS team_members_business_idx ON team_members (business_id);
CREATE INDEX IF NOT EXISTS notifications_business_idx ON notifications (business_id);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
CREATE INDEX IF NOT EXISTS memberships_business_idx ON memberships (business_id);
