const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { loadUser } = require('./middleware/auth');

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(loadUser);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/businesses', require('./routes/businesses'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/products', require('./routes/products'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/warehouses', require('./routes/warehouses'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/purchase-orders', require('./routes/purchaseOrders'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/deliveries', require('./routes/deliveries'));
app.use('/api/losses', require('./routes/losses'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/production', require('./routes/production'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/team', require('./routes/team'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/reports', require('./routes/reports'));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'StockFlow.dc.html'));
});

// Postgres error codes we translate into clean 4xx responses instead of a raw
// 500 with internal constraint/column names leaking to the client.
const PG_ERROR_STATUS = {
  '23505': [409, 'That value is already in use'], // unique_violation
  '23503': [400, 'Referenced record does not exist'], // foreign_key_violation
  '23502': [400, 'A required field is missing'], // not_null_violation
};

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code && PG_ERROR_STATUS[err.code]) {
    const [status, message] = PG_ERROR_STATUS[err.code];
    return res.status(status).json({ error: message });
  }
  const status = err.status || 500;
  // Only pass the raw error message through for expected 4xx failures (our
  // own validation/HttpError instances). An unexpected 500 could be a raw
  // driver/stack-trace-bearing error, so respond with a generic message and
  // keep the detail server-side in the log above.
  const message = status < 500 ? err.message : 'Something went wrong. Please try again.';
  res.status(status).json({ error: message });
});

module.exports = app;
