const crudRouter = require('./_crud');
module.exports = crudRouter('team_members', ['name', 'email', 'role', 'status']);
