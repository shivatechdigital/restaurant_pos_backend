const crypto = require('crypto');
const { query, pool } = require('../config/db');
const razorpay = require('../config/razorpay');
const AuditService = require('../services/auditService');
const LoyaltyService = require('../services/loyaltyService');

// Length-safe HMAC comparison (timingSafeEqual alag length par throw karta hai)
function signaturesMatch(expected, received) {
    if (typeof received !== 'string' || expected.length !== received.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(expected, 'utf8'),
        Buffer.from(received, 'utf8')
    );
}

class PaymentController {
    static async settleSessionIfComplete(sessionId) {
        const balanceResult = await query(
            `SELECT
                COALESCE((SELECT SUM(final_amount) FROM orders WHERE session_id = $1 AND status != 'cancelled'), 0) AS total,
                COALESCE((SELECT SUM(amount) FROM payments WHERE session_id = $1 AND status = 'success'), 0) AS paid`,
            [sessionId]
        );
        const { total, paid } = balanceResult.rows[0];
        const outstanding = Math.max(0, parseFloat(total) - parseFloat(paid));
        const sessionResult = await query(
            'SELECT table_id, restaurant_id FROM order_sessions WHERE id = $1',
            [sessionId]
        );
        const session = sessionResult.rows[0];

        if (session && outstanding <= 0.01) {
            await query(`UPDATE order_sessions SET status = 'paid', closed_at = NOW() WHERE id = $1 AND status = 'active'`, [sessionId]);
            await query(
                `UPDATE tables SET status = 'available', occupied_by_phone = NULL, room_code = NULL,
                 occupied_at = NULL, auto_release_at = NULL WHERE id = $1`,
                [session.table_id]
            );
            await LoyaltyService.awardForSession(sessionId);
        }

        return { outstanding, settled: Boolean(session) && outstanding <= 0.01, session };
    }

    // =============================================
    // STEP 1: RAZORPAY ORDER CREATE KARO
    // Customer "Pay Now" karega toh pehle yeh call hoga
    // =============================================
    static async createPaymentOrder(req, res) {
        try {
            const { session_id, amount, payment_method } = req.body;
            const customerPhone = req.user?.phone;

            const amountValue = parseFloat(amount);
            if (!session_id || !Number.isFinite(amountValue) || amountValue <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'session_id and amount are required'
                });
            }

            // Verify karo ki session exist karta hai aur paid nahi hai
            const sessionResult = await query(
                `SELECT s.*, t.table_number, r.name as restaurant_name,
                    COALESCE((SELECT o.order_type FROM orders o WHERE o.session_id = s.id ORDER BY o.placed_at DESC LIMIT 1), 'dine-in') AS order_type
                 FROM order_sessions s
                 LEFT JOIN tables t ON s.table_id = t.id
                 JOIN restaurants r ON s.restaurant_id = r.id
                 WHERE s.id = $1 AND s.status = 'active'
                 AND (s.table_id IS NOT NULL OR s.host_phone = $2)`,
                [session_id, customerPhone]
            );

            if (sessionResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Session not found or already paid'
                });
            }

            const session = sessionResult.rows[0];
            const balance = await PaymentController.settleSessionIfComplete(session_id);
            if (amountValue > balance.outstanding + 0.01) {
                return res.status(400).json({ success: false, message: `Payment exceeds outstanding amount of ₹${balance.outstanding.toFixed(2)}` });
            }

            // Razorpay order create karo
            // Amount paisa mein bhejna hota hai (₹100 = 10000 paisa)
            const amountInPaisa = Math.round(amountValue * 100);

            const razorpayOrder = await razorpay.orders.create({
                amount: amountInPaisa,
                currency: 'INR',
                receipt: `receipt_${session_id}_${Date.now()}`,
                notes: {
                    session_id: session_id.toString(),
                    table_number: session.table_number || session.order_type.toUpperCase(),
                    restaurant: session.restaurant_name,
                    customer_phone: customerPhone
                }
            });

            // Payment record database mein save karo (pending status)
            await query(
                `INSERT INTO payments 
                 (session_id, order_id, restaurant_id, razorpay_order_id, amount, payment_method, status, paid_by_phone)
                 VALUES ($1, (SELECT id FROM orders WHERE session_id = $1 ORDER BY placed_at DESC LIMIT 1), $2, $3, $4, $5, 'pending', $6)`,
                [
                    session_id,
                    session.restaurant_id,
                    razorpayOrder.id,
                    amountValue,
                    payment_method || 'upi',
                    customerPhone
                ]
            );

            return res.status(200).json({
                success: true,
                message: 'Payment order created',
                data: {
                    razorpay_order_id: razorpayOrder.id,
                    amount: amountValue,
                    amount_in_paisa: amountInPaisa,
                    currency: 'INR',
                    key_id: process.env.RAZORPAY_KEY_ID,
                    // Flutter/Customer app ko yeh sab chahiye Razorpay SDK open karne ke liye
                    prefill: {
                        contact: customerPhone,
                        name: 'Customer'
                    },
                    notes: {
                        session_id: session_id,
                        table_number: session.table_number || session.order_type.toUpperCase()
                    }
                }
            });

        } catch (error) {
            console.error('Create Payment Order Error:', error);
            return res.status(500).json({
                success: false,
                message: 'Failed to create payment order'
            });
        }
    }

    // =============================================
    // STEP 2: PAYMENT VERIFY KARO
    // Razorpay SDK se payment hone ke baad yeh call hoga
    // =============================================
    static async verifyPayment(req, res) {
        try {
            const {
                razorpay_order_id,
                razorpay_payment_id,
                razorpay_signature,
                session_id
            } = req.body;

            if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
                return res.status(400).json({
                    success: false,
                    message: 'All Razorpay fields are required'
                });
            }

            // =============================================
            // SIGNATURE VERIFICATION (Bahut Zaroori — Fraud Prevention)
            // Razorpay ne jo signature bheja hai, woh hum khud generate
            // karke match karenge. Agar match nahi hua = FAKE PAYMENT
            // =============================================
            const generatedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                .update(`${razorpay_order_id}|${razorpay_payment_id}`)
                .digest('hex');

            if (!signaturesMatch(generatedSignature, razorpay_signature)) {
                // FRAUD DETECTED!
                console.error(`🚨 FRAUD ALERT: Invalid payment signature for order ${razorpay_order_id}`);

                await query(
                    `UPDATE payments SET status = 'failed' 
                     WHERE razorpay_order_id = $1`,
                    [razorpay_order_id]
                );

                return res.status(400).json({
                    success: false,
                    message: 'Payment verification failed! Invalid signature.'
                });
            }

            // Signature match! Payment genuine hai ✅
            // Database mein payment update karo
            const paymentResult = await query(
                `UPDATE payments 
                 SET razorpay_payment_id = $1,
                     status = 'success',
                     paid_at = NOW()
                 WHERE razorpay_order_id = $2
                 RETURNING *`,
                [razorpay_payment_id, razorpay_order_id]
            );

            if (paymentResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Payment record not found'
                });
            }

            const payment = paymentResult.rows[0];

            const settlement = await PaymentController.settleSessionIfComplete(payment.session_id);
            const io = req.app.get('io');
            if (io && settlement.settled && settlement.session.table_id) {
                io.to(`table_${settlement.session.table_id}`).emit('payment_success', { payment_id: razorpay_payment_id, amount: payment.amount });
                io.to(`restaurant_${settlement.session.restaurant_id}`).emit('table_status_changed', { table_id: settlement.session.table_id, status: 'available' });
            }

            await AuditService.log({ restaurantId: payment.restaurant_id, actor: req.user, action: 'upi_payment_verified', entityType: 'payment', entityId: payment.id, details: { session_id: payment.session_id, amount: payment.amount, settled: settlement.settled } });

            return res.status(200).json({
                success: true,
                message: 'Payment verified successfully! ✅',
                data: {
                    payment_id: razorpay_payment_id,
                    order_id: razorpay_order_id,
                    amount: payment.amount,
                    status: 'success',
                    paid_at: payment.paid_at,
                    outstanding_amount: settlement.outstanding,
                    settled: settlement.settled
                }
            });

        } catch (error) {
            console.error('Verify Payment Error:', error);
            return res.status(500).json({
                success: false,
                message: 'Payment verification failed'
            });
        }
    }

    // =============================================
    // STEP 3: RAZORPAY WEBHOOK (Server-to-Server)
    // Razorpay khud aapke server ko batayega payment hua
    // Yeh backup verification hai — agar app crash ho jaye
    // =============================================
    static async handleWebhook(req, res) {
        try {
            const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
            const signature = req.headers['x-razorpay-signature'];

            if (!webhookSecret) {
                console.error('🚨 RAZORPAY_WEBHOOK_SECRET is not configured');
                return res.status(500).json({ success: false, message: 'Webhook not configured' });
            }

            // express.raw() ki wajah se req.body Buffer hai — signature raw bytes par banta hai
            const rawBody = Buffer.isBuffer(req.body)
                ? req.body
                : Buffer.from(JSON.stringify(req.body), 'utf8');

            // Webhook signature verify karo
            const expectedSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(rawBody)
                .digest('hex');

            if (!signaturesMatch(expectedSignature, signature)) {
                console.error('🚨 Invalid webhook signature!');
                return res.status(400).json({ success: false, message: 'Invalid signature' });
            }

            let parsedBody;

            try {
                parsedBody = JSON.parse(rawBody.toString('utf8'));
            } catch {
                return res.status(400).json({ success: false, message: 'Invalid JSON payload' });
            }

            const event = parsedBody.event;
            const payload = parsedBody.payload;

            // Sirf payment captured event handle karo
            if (event === 'payment.captured') {
                const paymentData = payload.payment.entity;

                console.log(`💰 Webhook: Payment captured - ₹${paymentData.amount / 100}`);

                // Payment update karo
                await query(
                    `UPDATE payments 
                     SET razorpay_payment_id = $1,
                         status = 'success',
                         paid_at = NOW()
                     WHERE razorpay_order_id = $2`,
                    [paymentData.id, paymentData.order_id]
                );

                const paymentRecord = await query(
                    'SELECT session_id FROM payments WHERE razorpay_order_id = $1',
                    [paymentData.order_id]
                );

                if (paymentRecord.rows.length > 0) {
                    await PaymentController.settleSessionIfComplete(paymentRecord.rows[0].session_id);
                }
            }

            // Razorpay ko 200 bhejna zaroori hai warna retry karega
            return res.status(200).json({ success: true });

        } catch (error) {
            console.error('Webhook Error:', error);
            return res.status(500).json({ success: false });
        }
    }

    // =============================================
    // CASH PAYMENT (Waiter cash le toh)
    // =============================================
    static async cashPayment(req, res) {
        let client;
        try {
            const { session_id, amount, payment_method } = req.body;
            const amountValue = parseFloat(amount);
            const method = ['cash', 'upi', 'card'].includes(payment_method) ? payment_method : 'cash';

            if (!session_id || !Number.isFinite(amountValue) || amountValue <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'A valid session_id and amount are required'
                });
            }

            client = await pool.connect();
            await client.query('BEGIN');
            const sessionResult = await client.query(
                `SELECT * FROM order_sessions
                 WHERE id = $1 AND restaurant_id = $2 AND status = 'active'
                 FOR UPDATE`,
                [session_id, req.user.restaurant_id]
            );
            if (sessionResult.rows.length === 0) throw new Error('Active session not found');

            const totalResult = await client.query(
                `SELECT COALESCE(SUM(final_amount), 0) AS total
                 FROM orders WHERE session_id = $1 AND status != 'cancelled'`,
                [session_id]
            );
            const paidResult = await client.query(
                `SELECT COALESCE(SUM(amount), 0) AS paid
                 FROM payments WHERE session_id = $1 AND status = 'success'`,
                [session_id]
            );
            const outstanding = parseFloat(totalResult.rows[0].total) - parseFloat(paidResult.rows[0].paid);
            if (amountValue > outstanding + 0.01) {
                throw new Error(`Payment exceeds outstanding amount of ₹${outstanding.toFixed(2)}`);
            }

            await client.query(
                `INSERT INTO payments
                 (session_id, restaurant_id, amount, payment_method, status, paid_at, paid_by_phone)
                 VALUES ($1, $2, $3, $4, 'success', NOW(), $5)`,
                [session_id, req.user.restaurant_id, amountValue, method, req.user?.phone]
            );

            const remaining = Math.max(0, parseFloat((outstanding - amountValue).toFixed(2)));
            const session = sessionResult.rows[0];
            if (remaining === 0) {
                await client.query(`UPDATE order_sessions SET status = 'paid', closed_at = NOW() WHERE id = $1`, [session_id]);
                await client.query(
                    `UPDATE tables SET status = 'available', occupied_by_phone = NULL, room_code = NULL,
                     occupied_at = NULL, auto_release_at = NULL WHERE id = $1`,
                    [session.table_id]
                );
            }
            await client.query('COMMIT');

            if (remaining === 0) {
                await LoyaltyService.awardForSession(session_id);
            }

            const io = req.app.get('io');
            if (io && remaining === 0) {
                io.to(`table_${session.table_id}`).emit('payment_success', { amount: amountValue });
                io.to(`restaurant_${session.restaurant_id}`).emit('table_status_changed', {
                    table_id: session.table_id,
                    status: 'available'
                });
            }

            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'cash_payment_recorded', entityType: 'session', entityId: session_id, details: { amount: amountValue, outstanding_amount: remaining, settled: remaining === 0 } });

            return res.status(200).json({
                success: true,
                message: remaining === 0 ? 'Payment recorded' : 'Partial payment recorded',
                data: { paid_amount: amountValue, outstanding_amount: remaining, settled: remaining === 0, payment_method: method }
            });

        } catch (error) {
            if (client) await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: error.message || 'Cash payment failed' });
        } finally {
            client?.release();
        }
    }

    // =============================================
    // PAYMENT STATUS CHECK
    // =============================================
    static async getPaymentStatus(req, res) {
        try {
            const { session_id } = req.params;

            const result = await query(
                `SELECT * FROM payments 
                 WHERE session_id = $1 
                 ORDER BY created_at DESC`,
                [session_id]
            );

            return res.status(200).json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = PaymentController;