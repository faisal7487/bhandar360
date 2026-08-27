// Wraps an async Express handler so a rejected promise reaches the error
// middleware instead of leaving the request hanging.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
