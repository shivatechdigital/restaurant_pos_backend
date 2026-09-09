const { pool } = require('../config/db');
const AuditService = require('../services/auditService');

class TableOperationsController {
    static async transferSession(req, res) {
        const { session_id, target_table_id } = req.body;
        const restaurantId = req.user.restaurant_id;

        if (!session_id || !target_table_id) {
            return res.status(400).json({ success: false, message: 'session_id and target_table_id are required' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const sessionResult = await client.query(
                `SELECT * FROM order_sessions WHERE id = $1 AND restaurant_id = $2 AND status = 'active' FOR UPDATE`,
                [session_id, restaurantId]
            );
            const targetResult = await client.query(
                `SELECT * FROM tables WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
                [target_table_id, restaurantId]
            );
            if (sessionResult.rows.length === 0 || targetResult.rows.length === 0) {
                throw new Error('Active session or target table not found');
            }

            const session = sessionResult.rows[0];
            const target = targetResult.rows[0];
            if (session.table_id === target.id) throw new Error('Select a different table');
            if (target.status !== 'available') throw new Error('Target table must be available');

            await client.query('UPDATE order_sessions SET table_id = $1 WHERE id = $2', [target.id, session.id]);
            await client.query('UPDATE orders SET table_id = $1 WHERE session_id = $2', [target.id, session.id]);
            await client.query(
                `UPDATE tables SET status = 'occupied', occupied_by_phone = $1, room_code = $2,
                    occupied_at = $3, auto_release_at = $4 WHERE id = $5`,
                [session.host_phone, session.room_code, session.started_at, null, target.id]
            );
            await client.query(
                `UPDATE tables SET status = 'available', occupied_by_phone = NULL, room_code = NULL,
                    occupied_at = NULL, auto_release_at = NULL WHERE id = $1`,
                [session.table_id]
            );
            await client.query('COMMIT');

            await AuditService.log({ restaurantId, actor: req.user, action: 'table_transferred', entityType: 'session', entityId: session.id, details: { from_table_id: session.table_id, to_table_id: target.id } });
            TableOperationsController.emitTableChange(req, restaurantId, [session.table_id, target.id]);
            return res.status(200).json({ success: true, message: 'Table transferred', data: { session_id: session.id, table_id: target.id } });
        } catch (error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: error.message });
        } finally {
            client.release();
        }
    }

    static async mergeSessions(req, res) {
        const { source_session_id, target_session_id } = req.body;
        const restaurantId = req.user.restaurant_id;

        if (!source_session_id || !target_session_id || source_session_id === target_session_id) {
            return res.status(400).json({ success: false, message: 'Two different active sessions are required' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const sessionsResult = await client.query(
                `SELECT * FROM order_sessions
                 WHERE id = ANY($1::int[]) AND restaurant_id = $2 AND status = 'active'
                 ORDER BY id FOR UPDATE`,
                [[source_session_id, target_session_id], restaurantId]
            );
            if (sessionsResult.rows.length !== 2) throw new Error('Both active sessions are required');

            const source = sessionsResult.rows.find(row => row.id === Number(source_session_id));
            const target = sessionsResult.rows.find(row => row.id === Number(target_session_id));
            await client.query(
                'UPDATE orders SET session_id = $1, table_id = $2 WHERE session_id = $3',
                [target.id, target.table_id, source.id]
            );
            await client.query(`UPDATE order_sessions SET status = 'closed', closed_at = NOW() WHERE id = $1`, [source.id]);
            await client.query(
                `UPDATE tables SET status = 'available', occupied_by_phone = NULL, room_code = NULL,
                    occupied_at = NULL, auto_release_at = NULL WHERE id = $1`,
                [source.table_id]
            );
            await client.query('COMMIT');

            await AuditService.log({ restaurantId, actor: req.user, action: 'tables_merged', entityType: 'session', entityId: target.id, details: { source_session_id: source.id, source_table_id: source.table_id, target_table_id: target.table_id } });
            TableOperationsController.emitTableChange(req, restaurantId, [source.table_id, target.table_id]);
            return res.status(200).json({ success: true, message: 'Tables merged', data: { session_id: target.id, table_id: target.table_id } });
        } catch (error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: error.message });
        } finally {
            client.release();
        }
    }

    static emitTableChange(req, restaurantId, tableIds) {
        const io = req.app.get('io');
        if (!io) return;
        for (const tableId of tableIds) {
            io.to(`restaurant_${restaurantId}`).emit('table_status_changed', { table_id: tableId });
        }
    }
}

module.exports = TableOperationsController;