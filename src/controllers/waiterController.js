const { query } = require('../config/db');

class WaiterController {
    static async getTableSessions(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { table_id } = req.params;

            const result = await query(
                `SELECT id, table_id, restaurant_id, host_phone, room_code, status, started_at
                 FROM order_sessions
                 WHERE table_id = $1 AND restaurant_id = $2 AND status = 'active'
                 ORDER BY started_at DESC
                 LIMIT 1`,
                [table_id, restaurant_id]
            );

            return res.status(200).json({
                success: true,
                data: result.rows[0] || null
            });
        } catch (error) {
            console.error('Waiter table session error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = WaiterController;
