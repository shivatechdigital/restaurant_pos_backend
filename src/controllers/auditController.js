const { query } = require('../config/db');
const AuditService = require('../services/auditService');

class AuditController {
    static async getLogs(req, res) {
        try {
            await AuditService.ensureTable();
            const result = await query(
                `SELECT l.*, COALESCE(u.name, l.actor_phone, 'System') AS actor_name
                 FROM audit_logs l LEFT JOIN users u ON l.actor_id = u.id
                 WHERE l.restaurant_id = $1 ORDER BY l.created_at DESC LIMIT 200`,
                [req.user.restaurant_id]
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to load audit logs' });
        }
    }
}

module.exports = AuditController;