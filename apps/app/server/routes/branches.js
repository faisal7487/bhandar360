const crudRouter = require('./_crud');
module.exports = crudRouter('branches', ['name', 'type', 'address']);
