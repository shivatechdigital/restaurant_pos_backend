const { query } = require('../config/db');
const OTPService = require('../services/otpService');
const jwt = require('jsonwebtoken');

// Table lock/verify se hi customer ko JWT de do (orders API ke liye chahiye)
const issueCustomerToken = (phone, restaurantId) => jwt.sign(
    { id: null, phone, role: 'customer', restaurant_id: restaurantId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
);

class TableController {

    // Purane installs mein is_active column nahi hoga, isliye lazily add karo
    static async ensureColumns() {
        await query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
    }

    // QR Scan karne par table info + OTP bhejo
    static async scanTable(req, res) {
        try {
            const { table_number, restaurant_id } = req.query;

            // Table dhoondo
            const tableResult = await query(
                `SELECT * FROM tables 
                 WHERE table_number = $1 AND restaurant_id = $2`,
                [table_number, restaurant_id]
            );

            if (tableResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Table not found'
                });
            }

            const table = tableResult.rows[0];
            const phone = req.user?.phone || req.body?.phone || req.query.phone;

            // Agar table already occupied hai
            if (table.status === 'occupied') {
                // Host khud hi dobara scan kar raha hai — room code na maango, seedha OTP bhej do
                if (phone && table.occupied_by_phone === phone) {
                    const otpResult = await OTPService.sendOTP(phone, 'table_lock');
                    return res.status(200).json({
                        success: true,
                        data: {
                            table_id: table.id,
                            table_number: table.table_number,
                            status: 'occupied',
                            is_host: true,
                            requires_otp: true,
                            otp: otpResult.otp,
                            message: 'Welcome back! OTP verify karke apni table par wapas jao.'
                        }
                    });
                }

                return res.status(200).json({
                    success: true,
                    data: {
                        table_id: table.id,
                        table_number: table.table_number,
                        status: 'occupied',
                        requires_room_code: true,
                        message: 'Table is occupied. Enter room code to join.'
                    }
                });
            }

            // Table available hai → OTP bhejo (Aapka Feature #2)
            if (!phone) {
                return res.status(400).json({
                    success: false,
                    message: 'Phone number required to lock table'
                });
            }

            const otpResult = await OTPService.sendOTP(phone, 'table_lock');

            return res.status(200).json({
                success: true,
                data: {
                    table_id: table.id,
                    table_number: table.table_number,
                    status: 'available',
                    requires_otp: true,
                    otp: otpResult.otp,
                    message: 'OTP sent to your phone to lock this table'
                }
            });

        } catch (error) {
            console.error('Scan Table Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // OTP verify karke table LOCK karo
    static async lockTable(req, res) {
        try {
            const { table_id, phone, otp } = req.body;

            // OTP verify
            const otpResult = await OTPService.verifyOTP(phone, otp, 'table_lock');
            if (!otpResult.success) {
                return res.status(401).json(otpResult);
            }

            // Host pehle se hi is table ka malik hai (dobara scan karke wapas aaya) —
            // naya lock/session banane ke bajaye purana session hi wapas de do
            const existingTable = await query('SELECT * FROM tables WHERE id = $1', [table_id]);
            const currentTable = existingTable.rows[0];

            if (currentTable && currentTable.status === 'occupied' && currentTable.occupied_by_phone === phone) {
                const existingSession = await query(
                    `SELECT * FROM order_sessions WHERE table_id = $1 AND room_code = $2 ORDER BY started_at DESC LIMIT 1`,
                    [table_id, currentTable.room_code]
                );

                return res.status(200).json({
                    success: true,
                    message: 'Welcome back!',
                    data: {
                        table_id: currentTable.id,
                        table_number: currentTable.table_number,
                        session_id: existingSession.rows[0]?.id,
                        room_code: currentTable.room_code,
                        token: issueCustomerToken(phone, currentTable.restaurant_id),
                        message: `Wapas swagat hai! Room code: ${currentTable.room_code}`
                    }
                });
            }

            // Room code generate karo (4-digit) — Group ordering ke liye
            const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
            const autoReleaseMinutes = parseInt(process.env.TABLE_AUTO_RELEASE_MINUTES) || 10;

            // Table ko occupied mark karo
            const result = await query(
                `UPDATE tables 
                 SET status = 'occupied',
                     occupied_by_phone = $1,
                     room_code = $2,
                     occupied_at = NOW(),
                     auto_release_at = NOW() + INTERVAL '${autoReleaseMinutes} minutes'
                 WHERE id = $3 AND status = 'available'
                 RETURNING *`,
                [phone, roomCode, table_id]
            );

            if (result.rows.length === 0) {
                return res.status(409).json({
                    success: false,
                    message: 'Table is no longer available'
                });
            }

            // Order session start karo
            const sessionResult = await query(
                `INSERT INTO order_sessions (table_id, restaurant_id, host_phone, room_code)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [table_id, result.rows[0].restaurant_id, phone, roomCode]
            );

            // Socket.io se sabko notify karo (baad mein add hoga)
            // io.to(`restaurant_${restaurant_id}`).emit('table_status_changed', {...});

            return res.status(200).json({
                success: true,
                message: 'Table locked successfully!',
                data: {
                    table_id: result.rows[0].id,
                    table_number: result.rows[0].table_number,
                    session_id: sessionResult.rows[0].id,
                    room_code: roomCode,
                    token: issueCustomerToken(phone, result.rows[0].restaurant_id),
                    message: `Share room code "${roomCode}" with your friends to let them order too!`
                }
            });

        } catch (error) {
            console.error('Lock Table Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Saari tables ka status (Admin/Waiter ke liye)
    static async getAllTables(req, res) {
        try {            await TableController.ensureColumns();            let restaurant_id = req.user.restaurant_id;
            if (!restaurant_id && req.user.role === 'reception') {
                const restaurantResult = await query('SELECT id FROM restaurants ORDER BY id LIMIT 1');
                restaurant_id = restaurantResult.rows[0]?.id;
            }
            if (!restaurant_id) {
                return res.status(400).json({ success: false, message: 'Reception user is not linked to a restaurant' });
            }

            const result = await query(
                `SELECT t.*, s.id AS active_session_id, s.started_at AS session_started_at,
                        COALESCE((
                            SELECT SUM(o.final_amount) FROM orders o
                            WHERE o.session_id = s.id AND o.status != 'cancelled'
                        ), 0) AS running_amount,
                        EXISTS(
                            SELECT 1 FROM orders o
                            WHERE o.session_id = s.id
                              AND o.status IN ('placed', 'accepted', 'preparing', 'ready')
                        ) AS has_running_kot
                 FROM tables t
                 LEFT JOIN LATERAL (
                    SELECT id, started_at FROM order_sessions
                    WHERE table_id = t.id AND restaurant_id = t.restaurant_id AND status = 'active'
                    ORDER BY started_at DESC LIMIT 1
                 ) s ON TRUE
                 WHERE t.restaurant_id = $1 AND (t.is_active IS NULL OR t.is_active = TRUE)
                 ORDER BY regexp_replace(table_number, '[0-9]+$', ''),
                          CASE
                              WHEN table_number ~ '[0-9]+$'
                              THEN substring(table_number FROM '[0-9]+$')::INT
                          END NULLS LAST,
                          table_number`,
                [restaurant_id]
            );

            return res.status(200).json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Table ko clean/available/out-of-service mark karo (Admin/Waiter/Reception)
    // Agar table par active session ka unpaid bill hai to pehle wo settle karna zaroori hai
    static async updateStatus(req, res) {
        try {
            const { status } = req.body;
            const allowed = ['available', 'cleaning', 'out_of_service'];
            if (!allowed.includes(status)) {
                return res.status(400).json({ success: false, message: 'Invalid status' });
            }

            const restaurant_id = req.user.restaurant_id;
            const tableResult = await query(
                'SELECT * FROM tables WHERE id = $1 AND restaurant_id = $2',
                [req.params.id, restaurant_id]
            );
            if (tableResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Table not found' });
            }
            const table = tableResult.rows[0];

            const activeSession = await query(
                `SELECT id FROM order_sessions WHERE table_id = $1 AND restaurant_id = $2 AND status = 'active'`,
                [req.params.id, restaurant_id]
            );

            if (activeSession.rows.length > 0) {
                const sessionId = activeSession.rows[0].id;
                const totalResult = await query(
                    `SELECT COALESCE(SUM(final_amount), 0) AS total FROM orders WHERE session_id = $1 AND status != 'cancelled'`,
                    [sessionId]
                );
                const paidResult = await query(
                    `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE session_id = $1 AND status = 'success'`,
                    [sessionId]
                );
                const due = parseFloat(totalResult.rows[0].total) - parseFloat(paidResult.rows[0].paid);
                if (due > 0.01) {
                    return res.status(400).json({
                        success: false,
                        message: `Outstanding bill of \u20b9${due.toFixed(2)} must be settled first`
                    });
                }
                await query(`UPDATE order_sessions SET status = 'paid', closed_at = NOW() WHERE id = $1`, [sessionId]);
            }

            const result = await query(
                `UPDATE tables
                 SET status = $1, occupied_by_phone = NULL, room_code = NULL, occupied_at = NULL, auto_release_at = NULL
                 WHERE id = $2
                 RETURNING *`,
                [status, table.id]
            );

            const io = req.app.get('io');
            if (io) {
                io.to(`restaurant_${restaurant_id}`).emit('table_status_changed', { table_id: table.id, status });
            }

            return res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Table hatao (soft delete — order history safe rehti hai, sirf listing se hide hoti hai)
    static async deleteTable(req, res) {
        try {
            await TableController.ensureColumns();
            const restaurant_id = req.user.restaurant_id;
            const tableResult = await query(
                'SELECT * FROM tables WHERE id = $1 AND restaurant_id = $2',
                [req.params.id, restaurant_id]
            );
            if (tableResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Table not found' });
            }
            const table = tableResult.rows[0];

            if (table.status !== 'available') {
                return res.status(400).json({
                    success: false,
                    message: 'Sirf available table delete ki ja sakti hai. Pehle bill settle/clean karo.'
                });
            }

            const activeSession = await query(
                `SELECT id FROM order_sessions WHERE table_id = $1 AND status = 'active'`,
                [req.params.id]
            );
            if (activeSession.rows.length > 0) {
                return res.status(400).json({ success: false, message: 'Is table par active session hai' });
            }

            await query('UPDATE tables SET is_active = FALSE WHERE id = $1', [req.params.id]);

            return res.status(200).json({ success: true, message: 'Table deleted' });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = TableController;