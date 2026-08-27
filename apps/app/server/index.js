const app = require('./app');
const db = require('./db');

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production — refusing to start with the insecure default dev secret.');
}

const PORT = process.env.PORT || 3000;

db.migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`StockFlow running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to run database migrations:', err);
    process.exit(1);
  });
