const crudRouter = require('./_crud');
module.exports = crudRouter('deliveries', [
  'branch_id', 'order_ref', 'provider', 'status', 'zone', 'tracking_no', 'address',
  'customer_name', 'phone', 'city', 'postcode', 'weight', 'cod_amount', 'notes',
], { branch_id: 'branches' });
