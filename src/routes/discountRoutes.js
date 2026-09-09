const express = require('express');
const router = express.Router();
const DiscountController = require('../controllers/discountController');
const { authenticate, authorize } = require('../middleware/auth');
router.use(authenticate, authorize('admin'));
router.get('/coupons', DiscountController.getCoupons);
router.post('/coupons', DiscountController.createCoupon);
router.patch('/coupons/:id', DiscountController.toggleCoupon);
module.exports = router;