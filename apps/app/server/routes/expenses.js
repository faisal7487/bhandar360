const crudRouter = require('./_crud');
module.exports = crudRouter('expenses', ['category', 'amount', 'note']);
