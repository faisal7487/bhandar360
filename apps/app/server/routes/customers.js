const crudRouter = require('./_crud');
module.exports = crudRouter('customers', ['name', 'contact', 'phone', 'email', 'balance', 'credit_limit']);
