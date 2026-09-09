const { query } = require('../config/db');
const PrinterService = require('../services/printerService');

class PrinterController {
    static async getNextJob(req, res) {
        try {
            await PrinterService.ensureTable();
            const result = await query(
                `UPDATE print_jobs SET status = 'printing'
                 WHERE id = (
                    SELECT id FROM print_jobs
                    WHERE restaurant_id = $1 AND status = 'pending'
                    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
                 )
                 RETURNING *`,
                [req.user.restaurant_id]
            );
            return res.json({ success: true, data: result.rows[0] || null });
        } catch { return res.status(500).json({ success: false, message: 'Failed to load print job' }); }
    }
    static async completeJob(req, res) {
        try {
            const result = await query(`UPDATE print_jobs SET status = 'printed', printed_at = NOW() WHERE id = $1 AND restaurant_id = $2 AND status = 'printing' RETURNING *`, [req.params.id, req.user.restaurant_id]);
            return result.rows.length ? res.json({ success: true, data: result.rows[0] }) : res.status(404).json({ success: false, message: 'Claimed print job not found' });
        } catch { return res.status(500).json({ success: false, message: 'Failed to complete print job' }); }
    }
}

module.exports = PrinterController;