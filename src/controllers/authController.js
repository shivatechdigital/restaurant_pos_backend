const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const OTPService = require('../services/otpService');

class AuthController {

    // Step 1: OTP bhejo
    static async sendOTP(req, res) {
        try {
            const { phone } = req.body;

            if (!phone || phone.length < 10) {
                return res.status(400).json({
                    success: false,
                    message: 'Valid phone number is required'
                });
            }

            const result = await OTPService.sendOTP(phone, 'login');
            // otp sirf testing ke liye data mein bheja jata hai (frontend flag se control hota hai)
            return res.status(200).json({
                success: result.success,
                message: result.message,
                data: { otp: result.otp }
            });

        } catch (error) {
            console.error('Send OTP Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Step 2: OTP verify karo + JWT token do
    static async verifyOTP(req, res) {
        try {
            const { phone, otp } = req.body;

            if (!phone || !otp) {
                return res.status(400).json({
                    success: false,
                    message: 'Phone and OTP are required'
                });
            }

            // OTP verify
            const otpResult = await OTPService.verifyOTP(phone, otp, 'login');
            if (!otpResult.success) {
                return res.status(401).json(otpResult);
            }

            // Check karo user database mein hai ya nahi
            let userResult = await query(
                'SELECT * FROM users WHERE phone = $1 AND is_active = TRUE',
                [phone]
            );

            // Agar user nahi mila, toh customer ke roop mein allow karo
            // (Customer ko database mein save nahi karna, sirf token dena hai)
            let user;
            if (userResult.rows.length > 0) {
                user = userResult.rows[0];
            } else {
                // Temporary customer token (no DB entry needed)
                user = {
                    id: null,
                    phone: phone,
                    role: 'customer',
                    restaurant_id: null
                };
            }

            // JWT Token generate karo
            const token = jwt.sign(
                {
                    id: user.id,
                    phone: user.phone,
                    role: user.role,
                    restaurant_id: user.restaurant_id
                },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
            );

            return res.status(200).json({
                success: true,
                message: 'Login successful',
                data: {
                    token,
                    user: {
                        id: user.id,
                        phone: user.phone,
                        name: user.name || 'Customer',
                        role: user.role
                    }
                }
            });

        } catch (error) {
            console.error('Verify OTP Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = AuthController;