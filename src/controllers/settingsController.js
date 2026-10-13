const { query } = require('../config/db');

class SettingsController {
    static async ensureTable() {
        await query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS tagline VARCHAR(200) DEFAULT 'Good Food, Good Mood'`);
        await query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS address TEXT DEFAULT ''`);
        await query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS phone VARCHAR(25) DEFAULT ''`);
        await query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS gst_number VARCHAR(25) DEFAULT ''`);

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

    // =============================================
    // RESTAURANT PROFILE (Admin & Multi-Restaurant)
    // =============================================
    static async getRestaurantProfile(req, res) {
        try {
            await SettingsController.ensureTable();
            const targetId = parseInt(req.query.restaurant_id) || req.user?.restaurant_id || 1;

            const allRestaurants = await query(
                `SELECT id, name, COALESCE(tagline, '') AS tagline, COALESCE(address, '') AS address, COALESCE(phone, '') AS phone, COALESCE(gst_number, '') AS gst_number 
                 FROM restaurants ORDER BY id ASC`
            );

            let currentRestaurant = allRestaurants.rows.find(r => r.id === targetId);

            if (!currentRestaurant) {
                if (allRestaurants.rows.length > 0) {
                    currentRestaurant = allRestaurants.rows[0];
                } else {
                    const inserted = await query(
                        `INSERT INTO restaurants (name, tagline, address, phone) 
                         VALUES ('Food Plaza', 'Good Food, Good Mood', '123 Food Street, Noida, UP - 201309', '+91 98765 43210') 
                         RETURNING id, name, tagline, address, phone, gst_number`
                    );
                    currentRestaurant = inserted.rows[0];
                }
            }

            return res.json({
                success: true,
                data: currentRestaurant,
                all_restaurants: allRestaurants.rows,
                current_id: currentRestaurant.id
            });
        } catch (error) {
            console.error('getRestaurantProfile error:', error);
            return res.status(500).json({ success: false, message: 'Failed to load restaurant profile' });
        }
    }

    static async updateRestaurantProfile(req, res) {
        try {
            await SettingsController.ensureTable();
            const restaurantId = parseInt(req.body.restaurant_id) || req.user?.restaurant_id || 1;
            const { name, tagline, address, phone, gst_number } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({ success: false, message: 'Restaurant name is required' });
            }

            const result = await query(
                `UPDATE restaurants 
                 SET name = $1,
                     tagline = COALESCE($2, tagline),
                     address = COALESCE($3, address),
                     phone = COALESCE($4, phone),
                     gst_number = COALESCE($5, gst_number),
                     updated_at = NOW()
                 WHERE id = $6
                 RETURNING id, name, tagline, address, phone, gst_number`,
                [name.trim(), tagline?.trim() ?? '', address?.trim() ?? '', phone?.trim() ?? '', gst_number?.trim() ?? '', restaurantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Restaurant not found' });
            }

            return res.json({
                success: true,
                message: 'Restaurant details updated successfully',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('updateRestaurantProfile error:', error);
            return res.status(500).json({ success: false, message: 'Failed to update restaurant profile' });
        }
    }

    // Public endpoint for customer web app without auth
    static async getPublicRestaurantInfo(req, res) {
        try {
            await SettingsController.ensureTable();
            const restaurantId = parseInt(req.params.id || req.query.restaurant_id) || 1;
            const result = await query(
                `SELECT id, name, COALESCE(tagline, '') AS tagline, COALESCE(address, '') AS address, COALESCE(phone, '') AS phone, COALESCE(gst_number, '') AS gst_number 
                 FROM restaurants WHERE id = $1`,
                [restaurantId]
            );

            if (result.rows.length === 0) {
                return res.json({
                    success: true,
                    data: {
                        id: restaurantId,
                        name: 'Food Plaza',
                        tagline: 'Good Food, Good Mood',
                        address: '123 Food Street, Noida, UP - 201309',
                        phone: '+91 98765 43210',
                        gst_number: ''
                    }
                });
            }

            return res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('getPublicRestaurantInfo error:', error);
            return res.status(500).json({ success: false, message: 'Failed to fetch restaurant info' });
        }
    }
}

module.exports = SettingsController;