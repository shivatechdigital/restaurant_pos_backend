const { query } = require('../config/db');
const PrinterService = require('../services/printerService');
const AuditService = require('../services/auditService');

class FulfillmentController {
    static async ensureTables() {
        await query(`CREATE TABLE IF NOT EXISTS delivery_partners (id SERIAL PRIMARY KEY, restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE, name VARCHAR(100) NOT NULL, phone VARCHAR(15), is_active BOOLEAN DEFAULT TRUE)`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_token VARCHAR(30)`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_landmark VARCHAR(200)`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_charge DECIMAL(10,2) DEFAULT 0`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(30)`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_partner_id INT REFERENCES delivery_partners(id)`);
        await query(`CREATE TABLE IF NOT EXISTS table_reservations (id SERIAL PRIMARY KEY, restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE, table_id INT REFERENCES tables(id), customer_name VARCHAR(100) NOT NULL, phone VARCHAR(15) NOT NULL, guest_count INT NOT NULL, reservation_at TIMESTAMPTZ NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'booked', notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    }

    static async assignDelivery(req, res) {
        try {
            await FulfillmentController.ensureTables();
            const { partner_id } = req.body;
            const partner = await query(`SELECT id FROM delivery_partners WHERE id = $1 AND restaurant_id = $2 AND is_active = TRUE`, [partner_id, req.user.restaurant_id]);
            if (!partner.rows.length) return res.status(404).json({ success: false, message: 'Delivery partner not found' });
            const result = await query(`UPDATE orders SET delivery_partner_id = $1, delivery_status = 'assigned' WHERE id = $2 AND restaurant_id = $3 AND order_type = 'delivery' RETURNING *`, [partner_id, req.params.id, req.user.restaurant_id]);
            if (!result.rows.length) return res.status(404).json({ success: false, message: 'Delivery order not found' });
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'delivery_partner_assigned', entityType: 'order', entityId: req.params.id, details: { partner_id } });
            return res.json({ success: true, data: result.rows[0] });
        } catch { return res.status(500).json({ success: false, message: 'Failed to assign delivery' }); }
    }

    static async getPartners(req, res) {
        try { await FulfillmentController.ensureTables(); const result = await query(`SELECT * FROM delivery_partners WHERE restaurant_id = $1 ORDER BY name`, [req.user.restaurant_id]); return res.json({ success: true, data: result.rows }); }
        catch { return res.status(500).json({ success: false, message: 'Failed to load delivery partners' }); }
    }

    static async createPartner(req, res) {
        try {
            await FulfillmentController.ensureTables();
            const { name, phone } = req.body;
            if (!name?.trim()) return res.status(400).json({ success: false, message: 'Partner name is required' });
            const result = await query(`INSERT INTO delivery_partners (restaurant_id, name, phone) VALUES ($1, $2, $3) RETURNING *`, [req.user.restaurant_id, name.trim(), phone?.trim() || null]);
            return res.status(201).json({ success: true, data: result.rows[0] });
        } catch { return res.status(500).json({ success: false, message: 'Failed to create delivery partner' }); }
    }

    static async updateDeliveryStatus(req, res) {
        try {
            const status = req.body.status;
            const valid = ['assigned', 'out_for_delivery', 'delivered', 'failed'];
            if (!valid.includes(status)) return res.status(400).json({ success: false, message: 'Invalid delivery status' });
            const result = await query(`UPDATE orders SET delivery_status = $1 WHERE id = $2 AND restaurant_id = $3 AND order_type = 'delivery' RETURNING *`, [status, req.params.id, req.user.restaurant_id]);
            return result.rows.length ? res.json({ success: true, data: result.rows[0] }) : res.status(404).json({ success: false, message: 'Delivery order not found' });
        } catch { return res.status(500).json({ success: false, message: 'Failed to update delivery' }); }
    }

    static async createReservation(req, res) {
        try {
            await FulfillmentController.ensureTables();
            const { table_id, customer_name, phone, guest_count, reservation_at, notes } = req.body;
            if (!customer_name || !phone || !guest_count || !reservation_at) return res.status(400).json({ success: false, message: 'Customer, phone, guests and reservation time are required' });
            const result = await query(`INSERT INTO table_reservations (restaurant_id, table_id, customer_name, phone, guest_count, reservation_at, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [req.user.restaurant_id, table_id || null, customer_name, phone, guest_count, reservation_at, notes || '']);
            if (table_id) {
                await query(`UPDATE tables SET status = 'reserved' WHERE id = $1 AND restaurant_id = $2 AND status = 'available'`, [table_id, req.user.restaurant_id]);
                const io = req.app.get('io');
                if (io) io.to(`restaurant_${req.user.restaurant_id}`).emit('table_status_changed', { table_id, status: 'reserved' });
            }
            return res.status(201).json({ success: true, data: result.rows[0] });
        } catch { return res.status(500).json({ success: false, message: 'Failed to create reservation' }); }
    }

    static async getReservations(req, res) {
        try {
            await FulfillmentController.ensureTables();
            const result = await query(`SELECT r.*, t.table_number FROM table_reservations r LEFT JOIN tables t ON r.table_id = t.id WHERE r.restaurant_id = $1 ORDER BY r.reservation_at DESC LIMIT 100`, [req.user.restaurant_id]);
            return res.json({ success: true, data: result.rows });
        } catch { return res.status(500).json({ success: false, message: 'Failed to load reservations' }); }
    }

    static async checkInReservation(req, res) {
        try {
            const result = await query(`UPDATE table_reservations SET status = 'checked_in' WHERE id = $1 AND restaurant_id = $2 AND status = 'booked' RETURNING *`, [req.params.id, req.user.restaurant_id]);
            if (!result.rows.length) return res.status(404).json({ success: false, message: 'Open reservation not found' });
            if (result.rows[0].table_id) {
                await query(`UPDATE tables SET status = 'occupied' WHERE id = $1 AND restaurant_id = $2`, [result.rows[0].table_id, req.user.restaurant_id]);
                const io = req.app.get('io');
                if (io) io.to(`restaurant_${req.user.restaurant_id}`).emit('table_status_changed', { table_id: result.rows[0].table_id, status: 'occupied' });
            }
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'reservation_checked_in', entityType: 'reservation', entityId: req.params.id });
            return res.json({ success: true, data: result.rows[0] });
        } catch { return res.status(500).json({ success: false, message: 'Failed to check in reservation' }); }
    }
}
module.exports = FulfillmentController;