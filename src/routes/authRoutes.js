const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');

// POST /api/auth/send-otp
router.post('/send-otp', AuthController.sendOTP);

// POST /api/auth/verify-otp
router.post('/verify-otp', AuthController.verifyOTP);

module.exports = router;