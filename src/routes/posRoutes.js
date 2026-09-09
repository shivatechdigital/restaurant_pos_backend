const express = require('express');
const router = express.Router();
const POSController = require('../controllers/posController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin', 'waiter', 'reception'));

router.post('/orders', POSController.createOrder);
router.get('/kot/:order_id', POSController.getKot);
router.get('/bill/:order_id', POSController.getBill);

module.exports = router;
