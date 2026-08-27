const bcrypt = require('bcryptjs');
const db = require('./index');

const PASSWORD = 'demo1234';

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function datetimeDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function seedBusiness(cfg, ownerUserId) {
  const business = await db
    .prepare(
      `INSERT INTO businesses (name, industry, currency, tax_rate, timezone, address, onboarded)
       VALUES (?, ?, 'BDT', 5, 'Asia/Dhaka', ?, 1) RETURNING id`
    )
    .run(cfg.businessName, cfg.industry, cfg.address);
  const businessId = business.lastInsertRowid;

  let userId = ownerUserId;
  if (!userId) {
    userId = (
      await db
        .prepare(`INSERT INTO users (business_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner') RETURNING id`)
        .run(businessId, cfg.ownerName, cfg.email, bcrypt.hashSync(PASSWORD, 10))
    ).lastInsertRowid;
  }
  await db.prepare(`INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, 'owner')`).run(userId, businessId);

  const branchIds = [];
  for (const b of cfg.branches) {
    const info = await db
      .prepare(`INSERT INTO branches (business_id, name, type, address) VALUES (?, ?, ?, ?) RETURNING id`)
      .run(businessId, b.name, b.type, b.address);
    branchIds.push(info.lastInsertRowid);
  }

  const warehouseIds = [];
  for (const w of cfg.warehouses) {
    const info = await db
      .prepare(`INSERT INTO warehouses (business_id, name, type, address) VALUES (?, ?, ?, ?) RETURNING id`)
      .run(businessId, w.name, w.type, w.address);
    warehouseIds.push(info.lastInsertRowid);
  }

  const insertProduct = db.prepare(
    `INSERT INTO products (business_id, category, warehouse_id, name, generic, brand, mfr, form, strength, supplier, sku, unit, cost_price, sale_price, stock_qty, reorder_level, batch_no, expiry_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active') RETURNING id`
  );
  const productIds = [];
  for (const p of cfg.products) {
    const info = await insertProduct.run(
      businessId,
      p.category,
      warehouseIds[p.warehouse],
      p.name,
      p.generic || '',
      p.brand || '',
      p.mfr || '',
      p.form || '',
      p.strength || '',
      p.supplier || '',
      p.sku,
      p.unit,
      p.cost,
      p.sale,
      p.stock,
      p.reorder,
      p.batch || '',
      p.expiry || null
    );
    productIds.push(info.lastInsertRowid);
  }
  const productByName = {};
  cfg.products.forEach((p, i) => (productByName[p.name] = productIds[i]));

  const supplierIds = [];
  for (const s of cfg.suppliers) {
    const info = await db
      .prepare(`INSERT INTO suppliers (business_id, name, contact, phone, email, balance) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(businessId, s.name, s.contact, s.phone, s.email, s.balance);
    supplierIds.push(info.lastInsertRowid);
  }

  const customerIds = [];
  for (const c of cfg.customers) {
    const info = await db
      .prepare(
        `INSERT INTO customers (business_id, name, contact, phone, email, balance, credit_limit) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(businessId, c.name, c.contact, c.phone, c.email, c.balance, c.creditLimit);
    customerIds.push(info.lastInsertRowid);
  }

  for (const po of cfg.purchaseOrders) {
    const rec = await db
      .prepare(
        `INSERT INTO purchase_orders (business_id, supplier_id, warehouse_id, code, status, total) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(
        businessId,
        supplierIds[po.supplier],
        warehouseIds[po.warehouse],
        po.code,
        po.status,
        po.items.reduce((s, l) => s + l.qty * l.cost, 0)
      );
    for (const l of po.items) {
      await db
        .prepare(`INSERT INTO purchase_order_items (po_id, name, qty, cost) VALUES (?, ?, ?, ?)`)
        .run(rec.lastInsertRowid, l.name, l.qty, l.cost);
    }
  }

  for (const s of cfg.sales) {
    const total = s.items.reduce((sum, l) => sum + l.qty * l.price, 0);
    const rec = await db
      .prepare(
        `INSERT INTO sales (business_id, customer_id, branch_id, code, total, paid_amount, method, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed') RETURNING id`
      )
      .run(
        businessId,
        s.customer === null ? null : customerIds[s.customer],
        branchIds[s.branch],
        s.code,
        total,
        total,
        s.method
      );
    for (const l of s.items) {
      await db
        .prepare(`INSERT INTO sale_items (sale_id, product_id, name, qty, price) VALUES (?, ?, ?, ?, ?)`)
        .run(rec.lastInsertRowid, productByName[l.name] || null, l.name, l.qty, l.price);
    }
    if (s.daysAgo) {
      await db.prepare(`UPDATE sales SET created_at = ? WHERE id = ?`).run(
        datetimeDaysAgo(s.daysAgo),
        rec.lastInsertRowid
      );
    }
  }

  for (const inv of cfg.invoices) {
    const total = inv.items.reduce((sum, l) => sum + l.qty * l.price, 0);
    const rec = await db
      .prepare(
        `INSERT INTO invoices (business_id, customer_id, branch_id, invoice_no, total, status, due_date) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(businessId, customerIds[inv.customer], branchIds[inv.branch], inv.code, total, inv.status, inv.dueDate);
    for (const l of inv.items) {
      await db
        .prepare(`INSERT INTO invoice_items (invoice_id, name, qty, price) VALUES (?, ?, ?, ?)`)
        .run(rec.lastInsertRowid, l.name, l.qty, l.price);
    }
  }

  for (const d of cfg.deliveries) {
    await db
      .prepare(
        `INSERT INTO deliveries (business_id, branch_id, order_ref, provider, status, zone, tracking_no, address, customer_name, phone, city, cod_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        businessId,
        branchIds[d.branch],
        d.orderRef,
        d.provider,
        d.status,
        d.zone,
        d.trackingNo,
        d.address,
        d.customerName,
        d.phone,
        d.city,
        d.cod
      );
  }

  for (const l of cfg.losses) {
    await db
      .prepare(`INSERT INTO losses (business_id, product_id, qty, reason, notes) VALUES (?, ?, ?, ?, ?)`)
      .run(businessId, productByName[l.product], l.qty, l.reason, l.notes);
  }

  for (const e of cfg.expenses) {
    await db
      .prepare(`INSERT INTO expenses (business_id, category, amount, note) VALUES (?, ?, ?, ?)`)
      .run(businessId, e.category, e.amount, e.note);
  }

  for (const p of cfg.production) {
    await db
      .prepare(`INSERT INTO production_runs (business_id, product_id, qty, status) VALUES (?, ?, ?, ?)`)
      .run(businessId, productByName[p.product] || null, p.qty, p.status);
  }

  for (const t of cfg.team) {
    await db
      .prepare(`INSERT INTO team_members (business_id, user_id, name, email, role, status) VALUES (?, NULL, ?, ?, ?, ?)`)
      .run(businessId, t.name, t.email, t.role, t.status);
  }

  console.log(`Seeded ${cfg.businessName} (${cfg.industry})`);
  return { userId, businessId };
}

async function run() {
  await db.migrate();

  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get('demo@bhandar360.com');
  if (existing) {
    console.log('Demo data already exists (demo@bhandar360.com found). Skipping seed.');
    console.log('To reseed from scratch, drop the tables in Supabase and run again.');
    return;
  }

  // ---------------- Pharmacy (creates the shared demo user) ----------------
  const { userId } = await seedBusiness({
    businessName: 'Demo Pharmacy',
    industry: 'pharmacy',
    address: 'Dhanmondi, Dhaka',
    ownerName: 'Demo Owner',
    email: 'demo@bhandar360.com',
    branches: [
      { name: 'Main branch', type: 'Retail outlet', address: 'Dhanmondi, Dhaka' },
      { name: 'Uttara branch', type: 'Retail outlet', address: 'Sector 7, Uttara, Dhaka' },
      { name: 'Chittagong branch', type: 'Retail outlet', address: 'GEC Circle, Chittagong' },
    ],
    warehouses: [
      { name: 'Central store', type: 'Storage', address: 'Dhanmondi, Dhaka' },
      { name: 'Cold storage', type: 'Cold storage', address: 'Dhanmondi, Dhaka' },
    ],
    products: [
      { name: 'Napa Extra', category: 'Analgesics', generic: 'Paracetamol + Caffeine', brand: 'Beximco', mfr: 'Beximco Pharma', form: 'Tablet', strength: '500mg', supplier: 'Beximco Ltd', sku: 'MED-1001', unit: 'Strip', cost: 12, sale: 18, stock: 340, reorder: 50, batch: 'B2405', expiry: daysFromNow(300), warehouse: 0 },
      { name: 'Seclo 20mg', category: 'Antacids', generic: 'Omeprazole', brand: 'Square', mfr: 'Square Pharma', form: 'Capsule', strength: '20mg', supplier: 'Square Ltd', sku: 'MED-1002', unit: 'Strip', cost: 22, sale: 30, stock: 150, reorder: 30, batch: 'B2402', expiry: daysFromNow(220), warehouse: 0 },
      { name: 'Losectil 20mg', category: 'Antacids', generic: 'Omeprazole', brand: 'Eskayef', mfr: 'Eskayef', form: 'Capsule', strength: '20mg', supplier: 'Square Ltd', sku: 'MED-1003', unit: 'Strip', cost: 40, sale: 55, stock: 0, reorder: 20, batch: 'B2401', expiry: daysFromNow(65), warehouse: 0 },
      { name: 'Insulin Novomix 30', category: 'Insulin', generic: 'Insulin Aspart', brand: 'Novo', mfr: 'Novo Nordisk', form: 'Injection', strength: '100IU/ml', supplier: 'Square Ltd', sku: 'MED-1004', unit: 'Vial', cost: 380, sale: 450, stock: 24, reorder: 10, batch: 'B2312', expiry: daysFromNow(400), warehouse: 1 },
      { name: 'Amoxil 500mg', category: 'Antibiotics', generic: 'Amoxicillin', brand: 'ACI', mfr: 'ACI Limited', form: 'Capsule', strength: '500mg', supplier: 'Beximco Ltd', sku: 'MED-1005', unit: 'Strip', cost: 15, sale: 22, stock: 8, reorder: 40, batch: 'B2410', expiry: daysFromNow(500), warehouse: 0 },
      { name: 'Vitamin C 250mg', category: 'Vitamins', generic: 'Ascorbic Acid', brand: 'Square', mfr: 'Square Pharma', form: 'Tablet', strength: '250mg', supplier: 'Square Ltd', sku: 'MED-1006', unit: 'Strip', cost: 9, sale: 15, stock: 500, reorder: 60, batch: 'B2411', expiry: daysFromNow(600), warehouse: 0 },
    ],
    suppliers: [
      { name: 'Square Ltd', contact: 'Rafiq Ahmed', phone: '01711000000', email: 'sales@square.example', balance: 8800 },
      { name: 'Beximco Ltd', contact: 'Karim Chowdhury', phone: '01722000000', email: 'sales@beximco.example', balance: 0 },
    ],
    customers: [
      { name: 'City Clinic', contact: 'Dr. Nusrat', phone: '01822000000', email: 'accounts@cityclinic.example', balance: 640, creditLimit: 20000 },
      { name: 'Sunrise Clinic', contact: 'Dr. Karim', phone: '01833000000', email: 'billing@sunrise.example', balance: 0, creditLimit: 15000 },
    ],
    purchaseOrders: [
      { supplier: 0, warehouse: 0, code: 'PO-1179', status: 'partial', items: [{ name: 'Seclo 20mg', qty: 500, cost: 22 }, { name: 'Losectil 20mg', qty: 300, cost: 40 }] },
      { supplier: 1, warehouse: 0, code: 'PO-1180', status: 'received', items: [{ name: 'Amoxil 500mg', qty: 400, cost: 15 }] },
    ],
    sales: [
      { branch: 0, customer: null, code: 'SL-3001', method: 'Cash', items: [{ name: 'Napa Extra', qty: 5, price: 18 }] },
      { branch: 1, customer: null, code: 'SL-3002', method: 'bKash', daysAgo: 1, items: [{ name: 'Seclo 20mg', qty: 2, price: 30 }] },
      { branch: 2, customer: null, code: 'SL-3003', method: 'Card', daysAgo: 3, items: [{ name: 'Vitamin C 250mg', qty: 10, price: 15 }] },
      { branch: 0, customer: 0, code: 'SL-3004', method: 'Credit', daysAgo: 15, items: [{ name: 'Insulin Novomix 30', qty: 1, price: 450 }] },
    ],
    invoices: [
      { customer: 0, branch: 0, code: 'INV-2036', status: 'sent', dueDate: daysFromNow(-3), items: [{ name: 'Insulin Novomix 30', qty: 1, price: 640 }] },
      { customer: 1, branch: 1, code: 'INV-2037', status: 'paid', dueDate: daysFromNow(10), items: [{ name: 'Napa Extra', qty: 50, price: 18 }] },
    ],
    deliveries: [
      { branch: 0, orderRef: 'INV-2036', provider: 'Pathao Courier', status: 'in_transit', zone: 'Dhanmondi', trackingNo: 'TRK-99213', address: 'City Clinic, Dhanmondi', customerName: 'City Clinic', phone: '01822000000', city: 'Dhaka', cod: 640 },
      { branch: 1, orderRef: 'SL-3002', provider: 'Steadfast', status: 'delivered', zone: 'Uttara', trackingNo: 'TRK-88120', address: 'Sector 7, Uttara', customerName: 'Walk-in', phone: '', city: 'Dhaka', cod: 0 },
    ],
    losses: [{ product: 'Losectil 20mg', qty: 20, reason: 'Expired', notes: 'Batch nearing expiry, written off' }],
    expenses: [
      { category: 'Rent', amount: 25000, note: 'Monthly shop rent' },
      { category: 'Utilities', amount: 4200, note: 'Electricity bill' },
      { category: 'Payroll', amount: 48000, note: 'Staff salaries' },
    ],
    production: [{ product: 'Napa Extra', qty: 500, status: 'completed' }],
    team: [
      { name: 'Nusrat Jahan', email: 'nusrat@demo.bhandar360.com', role: 'Manager', status: 'active' },
      { name: 'Sohel Rana', email: 'sohel@demo.bhandar360.com', role: 'Inventory Officer', status: 'pending' },
    ],
  });

  // ---------------- Restaurant ----------------
  await seedBusiness({
    businessName: 'Demo Restaurant',
    industry: 'restaurant',
    address: 'Gulshan Avenue, Dhaka',
    ownerName: 'Demo Owner',
    email: 'demo.restaurant@bhandar360.com',
    branches: [
      { name: 'Gulshan branch', type: 'Retail outlet', address: 'Gulshan Avenue, Dhaka' },
      { name: 'Banani branch', type: 'Retail outlet', address: 'Road 11, Banani, Dhaka' },
    ],
    warehouses: [
      { name: 'Kitchen store', type: 'Storage', address: 'Gulshan Avenue, Dhaka' },
      { name: 'Cold room', type: 'Cold storage', address: 'Gulshan Avenue, Dhaka' },
    ],
    products: [
      { name: 'Beef Mince', category: 'Meat', generic: 'Fresh ground beef', brand: 'Bengal Meat', supplier: 'Bengal Meat', sku: 'ING-101', unit: 'Kg', cost: 620, sale: 0, stock: 24, reorder: 40, batch: 'BM-0812', expiry: daysFromNow(4), warehouse: 1 },
      { name: 'Burger Buns', category: 'Grains', generic: 'Sesame brioche', brand: 'Cooper’s', supplier: "Cooper's Bakery", sku: 'ING-204', unit: 'Piece', cost: 12, sale: 0, stock: 38, reorder: 200, batch: 'CP-1190', expiry: daysFromNow(6), warehouse: 0 },
      { name: 'Cheddar Cheese', category: 'Dairy', generic: 'Aged cheddar slice', brand: 'Aarong', supplier: "Cooper's Bakery", sku: 'ING-330', unit: 'Slice', cost: 9, sale: 0, stock: 120, reorder: 250, batch: 'AR-5521', expiry: daysFromNow(40), warehouse: 1 },
      { name: 'Tomatoes', category: 'Vegetables', generic: 'Fresh tomato', brand: 'Local Farm', supplier: 'Bengal Meat', sku: 'ING-410', unit: 'Kg', cost: 60, sale: 0, stock: 5, reorder: 20, batch: 'LF-0088', expiry: daysFromNow(2), warehouse: 0 },
      { name: 'Special Sauce', category: 'Sauces', generic: 'House mayo blend', brand: 'In-house', supplier: 'Bengal Meat', sku: 'ING-512', unit: 'Litre', cost: 180, sale: 0, stock: 0, reorder: 10, batch: 'IH-2210', expiry: daysFromNow(8), warehouse: 1 },
      { name: 'Takeaway Boxes', category: 'Packaging', generic: 'Kraft burger box', brand: 'EcoPack', supplier: "Cooper's Bakery", sku: 'ING-620', unit: 'Piece', cost: 8, sale: 0, stock: 340, reorder: 600, batch: 'EP-7712', expiry: null, warehouse: 0 },
    ],
    suppliers: [
      { name: 'Bengal Meat', contact: 'Hasan Mia', phone: '01744000000', email: 'orders@bengalmeat.example', balance: 12500 },
      { name: "Cooper's Bakery", contact: 'Farida Yasmin', phone: '01755000000', email: 'sales@coopers.example', balance: 0 },
    ],
    customers: [
      { name: 'Walk-in Customers', contact: '—', phone: '', email: '', balance: 0, creditLimit: 0 },
      { name: 'Corporate Catering Ltd', contact: 'Imran Hossain', phone: '01766000000', email: 'events@corpcatering.example', balance: 8200, creditLimit: 30000 },
    ],
    purchaseOrders: [
      { supplier: 0, warehouse: 1, code: 'PO-2201', status: 'partial', items: [{ name: 'Beef Mince', qty: 60, cost: 620 }, { name: 'Tomatoes', qty: 40, cost: 60 }] },
      { supplier: 1, warehouse: 0, code: 'PO-2202', status: 'received', items: [{ name: 'Burger Buns', qty: 500, cost: 12 }, { name: 'Takeaway Boxes', qty: 1000, cost: 8 }] },
    ],
    sales: [
      { branch: 0, customer: null, code: 'SL-4001', method: 'Cash', items: [{ name: 'Burger Buns', qty: 20, price: 20 }, { name: 'Beef Mince', qty: 3, price: 700 }] },
      { branch: 1, customer: null, code: 'SL-4002', method: 'bKash', daysAgo: 1, items: [{ name: 'Cheddar Cheese', qty: 15, price: 15 }] },
      { branch: 0, customer: 1, code: 'SL-4003', method: 'Bank', daysAgo: 5, items: [{ name: 'Takeaway Boxes', qty: 100, price: 12 }] },
    ],
    invoices: [
      { customer: 1, branch: 0, code: 'INV-3010', status: 'sent', dueDate: daysFromNow(-1), items: [{ name: 'Catering package (50 pax)', qty: 1, price: 35000 }] },
      { customer: 0, branch: 1, code: 'INV-3011', status: 'paid', dueDate: daysFromNow(14), items: [{ name: 'Weekly ingredient supply', qty: 1, price: 6200 }] },
    ],
    deliveries: [
      { branch: 0, orderRef: 'SL-4003', provider: 'In-house Delivery', status: 'delivered', zone: 'Gulshan', trackingNo: '', address: 'Gulshan 2, Dhaka', customerName: 'Corporate Catering Ltd', phone: '01766000000', city: 'Dhaka', cod: 0 },
      { branch: 1, orderRef: 'INV-3010', provider: 'Pathao Courier', status: 'pending', zone: 'Banani', trackingNo: '', address: 'Road 11, Banani', customerName: 'Corporate Catering Ltd', phone: '01766000000', city: 'Dhaka', cod: 35000 },
    ],
    losses: [{ product: 'Tomatoes', qty: 8, reason: 'Kitchen waste', notes: 'Spoiled before use' }],
    expenses: [
      { category: 'Rent', amount: 60000, note: 'Gulshan branch rent' },
      { category: 'Utilities', amount: 15000, note: 'Gas & electricity' },
      { category: 'Payroll', amount: 120000, note: 'Kitchen & floor staff' },
    ],
    production: [{ product: 'Burger Buns', qty: 200, status: 'completed' }],
    team: [
      { name: 'Rina Akhter', email: 'rina@demo-restaurant.bhandar360.com', role: 'Manager', status: 'active' },
      { name: 'Tanvir Hasan', email: 'tanvir@demo-restaurant.bhandar360.com', role: 'Cashier', status: 'pending' },
    ],
  }, userId);

  // ---------------- Retail ----------------
  await seedBusiness({
    businessName: 'Demo Retail Shop',
    industry: 'retail',
    address: 'Mirpur 10, Dhaka',
    ownerName: 'Demo Owner',
    email: 'demo.retail@bhandar360.com',
    branches: [
      { name: 'Mirpur outlet', type: 'Retail outlet', address: 'Mirpur 10, Dhaka' },
      { name: 'Dhanmondi outlet', type: 'Retail outlet', address: 'Dhanmondi 27, Dhaka' },
    ],
    warehouses: [
      { name: 'Main warehouse', type: 'Storage', address: 'Mirpur 10, Dhaka' },
      { name: 'Returns store', type: 'Storage', address: 'Mirpur 10, Dhaka' },
    ],
    products: [
      { name: 'USB-C Cable 1m', category: 'Electronics', generic: 'Fast charge braided', brand: 'Anker', supplier: 'Anker BD', sku: 'ELC-901', unit: 'Piece', cost: 180, sale: 320, stock: 145, reorder: 40, batch: 'AK-1120', expiry: null, warehouse: 0 },
      { name: 'Cotton T-Shirt (M)', category: 'Clothing', generic: 'Round neck, black', brand: 'Yellow', supplier: 'Yellow Wholesale', sku: 'CLO-220', unit: 'Piece', cost: 220, sale: 450, stock: 6, reorder: 25, batch: 'YL-0912', expiry: null, warehouse: 0 },
      { name: 'Basmati Rice 5kg', category: 'Groceries', generic: 'Premium aged', brand: 'Pran', supplier: 'Yellow Wholesale', sku: 'GRO-140', unit: 'Bag', cost: 640, sale: 820, stock: 62, reorder: 20, batch: 'PR-3301', expiry: daysFromNow(300), warehouse: 0 },
      { name: 'LED Bulb 12W', category: 'Home', generic: 'Warm white E27', brand: 'Philips', supplier: 'Anker BD', sku: 'HOM-505', unit: 'Piece', cost: 120, sale: 230, stock: 0, reorder: 30, batch: 'PH-8820', expiry: null, warehouse: 1 },
      { name: 'Face Wash 100ml', category: 'Beauty', generic: 'Neem & tulsi', brand: 'Himalaya', supplier: 'Yellow Wholesale', sku: 'BEA-611', unit: 'Piece', cost: 145, sale: 260, stock: 73, reorder: 20, batch: 'HM-4410', expiry: daysFromNow(500), warehouse: 0 },
      { name: 'Cola 500ml', category: 'Beverages', generic: 'Carbonated drink', brand: 'Coca-Cola', supplier: 'Anker BD', sku: 'BEV-720', unit: 'Bottle', cost: 28, sale: 45, stock: 9, reorder: 48, batch: 'CC-9901', expiry: daysFromNow(90), warehouse: 0 },
    ],
    suppliers: [
      { name: 'Anker BD', contact: 'Shakil Ahmed', phone: '01777000000', email: 'b2b@ankerbd.example', balance: 0 },
      { name: 'Yellow Wholesale', contact: 'Meherun Nesa', phone: '01788000000', email: 'wholesale@yellow.example', balance: 15400 },
    ],
    customers: [
      { name: 'Walk-in Customers', contact: '—', phone: '', email: '', balance: 0, creditLimit: 0 },
      { name: 'Rahman General Store', contact: 'Abdur Rahman', phone: '01799000000', email: 'rahman.store@example.com', balance: 4200, creditLimit: 25000 },
    ],
    purchaseOrders: [
      { supplier: 1, warehouse: 0, code: 'PO-5301', status: 'partial', items: [{ name: 'Cotton T-Shirt (M)', qty: 100, cost: 220 }, { name: 'Basmati Rice 5kg', qty: 50, cost: 640 }] },
      { supplier: 0, warehouse: 1, code: 'PO-5302', status: 'pending', items: [{ name: 'LED Bulb 12W', qty: 200, cost: 120 }] },
    ],
    sales: [
      { branch: 0, customer: null, code: 'SL-6001', method: 'Cash', items: [{ name: 'USB-C Cable 1m', qty: 4, price: 320 }] },
      { branch: 1, customer: null, code: 'SL-6002', method: 'Card', daysAgo: 2, items: [{ name: 'Cola 500ml', qty: 12, price: 45 }] },
      { branch: 0, customer: 1, code: 'SL-6003', method: 'Credit', daysAgo: 20, items: [{ name: 'Basmati Rice 5kg', qty: 10, price: 820 }] },
    ],
    invoices: [
      { customer: 1, branch: 0, code: 'INV-7050', status: 'sent', dueDate: daysFromNow(-5), items: [{ name: 'Basmati Rice 5kg', qty: 10, price: 820 }] },
      { customer: 0, branch: 1, code: 'INV-7051', status: 'paid', dueDate: daysFromNow(7), items: [{ name: 'Face Wash 100ml', qty: 5, price: 260 }] },
    ],
    deliveries: [
      { branch: 0, orderRef: 'INV-7050', provider: 'RedX', status: 'in_transit', zone: 'Mirpur', trackingNo: 'RX-44120', address: 'Rahman General Store, Mirpur', customerName: 'Rahman General Store', phone: '01799000000', city: 'Dhaka', cod: 8200 },
      { branch: 1, orderRef: 'SL-6002', provider: 'In-house Delivery', status: 'delivered', zone: 'Dhanmondi', trackingNo: '', address: 'Dhanmondi 27, Dhaka', customerName: 'Walk-in', phone: '', city: 'Dhaka', cod: 0 },
    ],
    losses: [{ product: 'Cotton T-Shirt (M)', qty: 3, reason: 'Damaged', notes: 'Water damage in storage' }],
    expenses: [
      { category: 'Rent', amount: 40000, note: 'Mirpur outlet rent' },
      { category: 'Utilities', amount: 5200, note: 'Electricity bill' },
      { category: 'Marketing', amount: 8000, note: 'Facebook ads' },
    ],
    production: [{ product: 'Basmati Rice 5kg', qty: 50, status: 'completed' }],
    team: [
      { name: 'Ayesha Karim', email: 'ayesha@demo-retail.bhandar360.com', role: 'Cashier', status: 'active' },
      { name: 'Rahim Uddin', email: 'rahim@demo-retail.bhandar360.com', role: 'Inventory Officer', status: 'pending' },
    ],
  }, userId);

  console.log('\nOne demo account, three businesses — switch between them from the topbar:');
  console.log('  email:   ', 'demo@bhandar360.com');
  console.log('  password:', PASSWORD);
}

run()
  .then(() => db.pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
