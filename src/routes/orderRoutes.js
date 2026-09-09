const express = require('express');
const router = express.Router();
const OrderController = require('../controllers/orderController');
const { authenticate, authorize } = require('../middleware/auth');

// =============================================
// CUSTOMER ROUTES
// =============================================

// Order place karo
router.post('/place', authenticate, OrderController.placeOrder);

// Apne orders dekho (Live tracking)
router.get('/my-orders', authenticate, OrderController.getMyOrders);

// Order cancel karo
router.post('/:order_id/cancel', authenticate, OrderController.cancelOrder);
router.post('/:order_id/cancel/manual', authenticate, authorize('admin', 'waiter'), OrderController.cancelOrderManually);
router.post('/:order_id/items/:item_id/cancel', authenticate, authorize('admin', 'waiter', 'customer'), OrderController.cancelOrderItem);

// =============================================
// KITCHEN ROUTES
// =============================================

// Kitchen ke live orders (KDS)
router.get('/kitchen', authenticate, authorize('admin', 'kitchen', 'waiter'), OrderController.getKitchenOrders);

// Order status update (Kitchen/Waiter)
router.patch('/:order_id/status', authenticate, authorize('admin', 'kitchen', 'waiter'), OrderController.updateOrderStatus);

// =============================================
// WAITER ROUTES
// =============================================

// Bill generate karo (customer apna bill dekh sakta hai, waiter/admin bhi)
router.get('/bill/:session_id', authenticate, authorize('admin', 'waiter', 'customer', 'reception'), OrderController.generateBill);

// =============================================
// ADMIN ROUTES
// =============================================

// Saare orders (Reports)
router.get('/all', authenticate, authorize('admin'), OrderController.getAllOrders);

module.exports = router;