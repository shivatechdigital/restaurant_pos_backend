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
            const phoneDigits = String(phone || '').replace(/\D/g, '');
            const normalizedPhone = phoneDigits.length === 12 && phoneDigits.startsWith('91')
                ? phoneDigits.slice(2)
                : phoneDigits;
            if (!name || !validRoles.includes(role)) {
                return res.status(400).json({ success: false, message: 'name, phone and a valid role are required' });
            }
            if (normalizedPhone.length !== 10) {
                return res.status(400).json({ success: false, message: 'Phone number must contain 10 digits, with an optional +91 country code' });
            }
            const result = await query(
                `INSERT INTO users (name, phone, role, restaurant_id)
                 VALUES ($1, $2, $3, $4) RETURNING id, name, phone, role, is_active, created_at`,
                [name.trim(), normalizedPhone, role, req.user.restaurant_id]
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
            const { name, phone, role, is_active } = req.body;
            const validRoles = ['admin', 'waiter', 'kitchen', 'reception'];
            if (name !== undefined && !String(name).trim()) {
                return res.status(400).json({ success: false, message: 'Name is required' });
            }
            if (role !== undefined && !validRoles.includes(role)) {
                return res.status(400).json({ success: false, message: 'Invalid role' });
            }
            let normalizedPhone = null;
            if (phone !== undefined) {
                const phoneDigits = String(phone).replace(/\D/g, '');
                normalizedPhone = phoneDigits.length === 12 && phoneDigits.startsWith('91')
                    ? phoneDigits.slice(2)
                    : phoneDigits;
                if (normalizedPhone.length !== 10) {
                    return res.status(400).json({ success: false, message: 'Phone number must contain 10 digits, with an optional +91 country code' });
                }
            }
            const result = await query(
                `UPDATE users
                 SET name = COALESCE($1, name), phone = COALESCE($2, phone),
                     role = COALESCE($3, role), is_active = COALESCE($4, is_active)
                 WHERE id = $5 AND restaurant_id = $6
                 RETURNING id, name, phone, role, is_active, created_at`,
                [name === undefined ? null : String(name).trim(), normalizedPhone, role || null,
                    typeof is_active === 'boolean' ? is_active : null, req.params.id, req.user.restaurant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Staff member not found' });
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'staff_updated', entityType: 'user', entityId: req.params.id, details: { name, phone: normalizedPhone, role, is_active } });
            return res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            const message = error.code === '23505' ? 'Phone number is already registered' : 'Failed to update staff';
            return res.status(error.code === '23505' ? 409 : 500).json({ success: false, message });
        }
    }

    static async deleteStaff(req, res) {
        try {
            const staffId = Number(req.params.id);
            if (!Number.isInteger(staffId) || staffId <= 0) {
                return res.status(400).json({ success: false, message: 'Invalid staff member ID' });
            }
            if (staffId === req.user.id) {
                return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
            }
            const result = await query(
                `DELETE FROM users
                 WHERE id = $1 AND restaurant_id = $2
                 RETURNING id, name, phone, role`,
                [staffId, req.user.restaurant_id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Staff member not found' });
            }
            await AuditService.log({
                restaurantId: req.user.restaurant_id,
                actor: req.user,
                action: 'staff_deleted',
                entityType: 'user',
                entityId: staffId,
                details: result.rows[0]
            });
            return res.status(200).json({ success: true, message: 'Staff member deleted' });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to delete staff member' });
        }
    }
}

module.exports = StaffController;