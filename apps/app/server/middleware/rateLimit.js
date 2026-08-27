// Minimal in-memory rate limiter — no extra dependency needed for a
// single-process deployment. Not distributed: a multi-instance deployment
// would need a shared store (e.g. Redis) instead, since each process would
// otherwise track its own counters.
function rateLimit({ windowMs, max, keyFn }) {
  const hits = new Map();

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);
    if (timestamps.length >= max) {
      return res.status(429).json({ error: 'Too many attempts — please wait a moment and try again.' });
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}

module.exports = { rateLimit };
