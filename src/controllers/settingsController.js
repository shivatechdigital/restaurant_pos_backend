const { query } = require('../config/db');

class SettingsController {
    static async ensureTable() {
        await query(`CREATE TABLE IF NOT EXISTS restaurant_order_settings (
            restaurant_id INT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
            kitchen_mode VARCHAR(20) NOT NULL DEFAULT 'printer_only' CHECK (kitchen_mode IN ('printer_only', 'kds')),
            customer_self_cancel BOOLEAN NOT NULL DEFAULT FALSE,
            allow_cancel_after_accepted BOOLEAN NOT NULL DEFAULT FALSE,
            print_cancelled_kot BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )`);
    }

    static async getOrderSettings(restaurantId) {
        await SettingsController.ensureTable();
        await query(`INSERT INTO restaurant_order_settings (restaurant_id) VALUES ($1) ON CONFLICT (restaurant_id) DO NOTHING`, [restaurantId]);
        const result = await query(`SELECT * FROM restaurant_order_settings WHERE restaurant_id = $1`, [restaurantId]);
        return result.rows[0];
    }

    static async getSettings(req, res) {
        try { return res.json({ success: true, data: await SettingsController.getOrderSettings(req.user.restaurant_id) }); }
        catch { return res.status(500).json({ success: false, message: 'Failed to load settings' }); }
    }

    static async updateSettings(req, res) {
        try {
            const { kitchen_mode, customer_self_cancel, allow_cancel_after_accepted, print_cancelled_kot } = req.body;
            if (!['printer_only', 'kds'].includes(kitchen_mode)) return res.status(400).json({ success: false, message: 'Invalid kitchen mode' });
            await SettingsController.ensureTable();
            const result = await query(`INSERT INTO restaurant_order_settings (restaurant_id, kitchen_mode, customer_self_cancel, allow_cancel_after_accepted, print_cancelled_kot) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (restaurant_id) DO UPDATE SET kitchen_mode = EXCLUDED.kitchen_mode, customer_self_cancel = EXCLUDED.customer_self_cancel, allow_cancel_after_accepted = EXCLUDED.allow_cancel_after_accepted, print_cancelled_kot = EXCLUDED.print_cancelled_kot, updated_at = NOW() RETURNING *`, [req.user.restaurant_id, kitchen_mode, kitchen_mode === 'kds' && customer_self_cancel === true, allow_cancel_after_accepted === true, print_cancelled_kot !== false]);
            return res.json({ success: true, data: result.rows[0] });
        } catch { return res.status(500).json({ success: false, message: 'Failed to update settings' }); }
    }
}

module.exports = SettingsController;