const { query } = require('../config/db');
const AuditService = require('../services/auditService');

class StaffController {
    static async getStaff(req, res) {
        try {
            const result = await query(
                `SELECT id, name, phone, role, is_active, created_at
                 FROM users WHERE restaurant_id = $1 ORDER BY name`,
                [req.user.restaurant_id]
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to load staff' });
        }
    }

    static async createStaff(req, res) {
        try {
            const { name, phone, role } = req.body;
            const validRoles = ['admin', 'waiter', 'kitchen', 'reception'];
            if (!name || !phone || !validRoles.includes(role)) {
                return res.status(400).json({ success: false, message: 'name, phone and a valid role are required' });
            }
            const result = await query(
                `INSERT INTO users (name, phone, role, restaurant_id)
                 VALUES ($1, $2, $3, $4) RETURNING id, name, phone, role, is_active, created_at`,
                [name.trim(), phone.trim(), role, req.user.restaurant_id]
            );
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'staff_created', entityType: 'user', entityId: result.rows[0].id, details: { role } });
            return res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error) {
            const message = error.code === '23505' ? 'Phone number is already registered' : 'Failed to create staff';
            return res.status(400).json({ success: false, message });
        }
    }

    static async updateStaff(req, res) {
        try {
            const { role, is_active } = req.body;
            const validRoles = ['admin', 'waiter', 'kitchen', 'reception'];
            if (role !== undefined && !validRoles.includes(role)) {
                return res.status(400).json({ success: false, message: 'Invalid role' });
            }
            const result = await query(
                `UPDATE users SET role = COALESCE($1, role), is_active = COALESCE($2, is_active)
                 WHERE id = $3 AND restaurant_id = $4
                 RETURNING id, name, phone, role, is_active, created_at`,
                [role || null, typeof is_active === 'boolean' ? is_active : null, req.params.id, req.user.restaurant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Staff member not found' });
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'staff_updated', entityType: 'user', entityId: req.params.id, details: { role, is_active } });
            return res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to update staff' });
        }
    }
}

module.exports = StaffController;