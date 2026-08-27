const crudRouter = require('./_crud');
module.exports = crudRouter('suppliers', ['name', 'contact', 'phone', 'email', 'balance']);
