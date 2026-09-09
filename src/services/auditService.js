const { query } = require('../config/db');

class AuditService {
    static async ensureTable() {
        await query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                actor_id INT REFERENCES users(id) ON DELETE SET NULL,
                actor_phone VARCHAR(15),
                action VARCHAR(80) NOT NULL,
                entity_type VARCHAR(50) NOT NULL,
                entity_id VARCHAR(50),
                details JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    }

    static async log({ restaurantId, actor, action, entityType, entityId, details = {} }) {
        try {
            await AuditService.ensureTable();
            await query(
                `INSERT INTO audit_logs (restaurant_id, actor_id, actor_phone, action, entity_type, entity_id, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [restaurantId, actor?.id || null, actor?.phone || null, action, entityType, String(entityId || ''), JSON.stringify(details)]
            );
        } catch (error) {
            console.error('Audit log error:', error.message);
        }
    }
}

module.exports = AuditService;