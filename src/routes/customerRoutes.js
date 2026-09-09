const express = require('express');
const router = express.Router();
const CustomerController = require('../controllers/customerController');
const { authenticate, authorize } = require('../middleware/auth');
router.use(authenticate, authorize('admin'));
router.get('/', CustomerController.getCustomers);
router.get('/:id', CustomerController.getCustomer);
router.patch('/:id', CustomerController.updateCustomer);
module.exports = router;