const crudRouter = require('./_crud');
module.exports = crudRouter('warehouses', ['name', 'type', 'address']);
