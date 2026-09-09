const express = require('express');
const router = express.Router();
const PaymentController = require('../controllers/paymentController');
const { authenticate, authorize } = require('../middleware/auth');

// Customer payment initiate karega
router.post('/create', authenticate, PaymentController.createPaymentOrder);

// Customer payment verify karega (Razorpay SDK ke baad)
router.post('/verify', authenticate, PaymentController.verifyPayment);

// Razorpay server-to-server webhook (No Auth — Razorpay bhejta hai)
// IMPORTANT: express.json() se pehle raw body chahiye webhook ke liye
router.post('/webhook', PaymentController.handleWebhook);

// Waiter cash payment record karega
router.post('/cash', authenticate, authorize('admin', 'waiter', 'reception'), PaymentController.cashPayment);

// Payment status check
router.get('/status/:session_id', authenticate, PaymentController.getPaymentStatus);

module.exports = router;