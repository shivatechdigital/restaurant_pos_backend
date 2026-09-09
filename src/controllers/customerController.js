const { query } = require('../config/db');
const LoyaltyService = require('../services/loyaltyService');

class CustomerController {
    static async getCustomers(req, res) {
        try {
            await LoyaltyService.ensureTables();
            const search = req.query.search?.trim();
            const segment = req.query.segment;
            const params = [req.user.restaurant_id];
            let filter = 'WHERE restaurant_id = $1';
            if (search) { params.push(`%${search}%`); filter += ` AND (name ILIKE $2 OR phone ILIKE $2)`; }
            if (segment === 'vip') filter += ' AND total_spend >= 5000';
            if (segment === 'repeat') filter += ' AND total_visits >= 3';
            if (segment === 'at_risk') filter += ` AND last_visit_at < NOW() - INTERVAL '30 days'`;
            if (segment === 'birthday_month') filter += ' AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM NOW())';
            const result = await query(`SELECT * FROM customer_profiles ${filter} ORDER BY total_spend DESC LIMIT 200`, params);
            return res.json({ success: true, data: result.rows });
        } catch { return res.status(500).json({ success: false, message: 'Failed to load customers' }); }
    }

    static async getCustomer(req, res) {
        try {
            await LoyaltyService.ensureTables();
            const customer = await query(`SELECT * FROM customer_profiles WHERE id = $1 AND restaurant_id = $2`, [req.params.id, req.user.restaurant_id]);
            if (!customer.rows.length) return res.status(404).json({ success: false, message: 'Customer not found' });
            const ledger = await query(`SELECT * FROM loyalty_ledger WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.params.id]);
            return res.json({ success: true, data: { customer: customer.rows[0], loyalty_history: ledger.rows } });
        } catch { return res.status(500).json({ success: false, message: 'Failed to load customer' }); }
    }

    static async updateCustomer(req, res) {
        try {
            await LoyaltyService.ensureTables();
            const { name, birthday, anniversary } = req.body;
            const result = await query(
                `UPDATE customer_profiles SET name = COALESCE($1, name), birthday = $2, anniversary = $3
                 WHERE id = $4 AND restaurant_id = $5 RETURNING *`,
                [name?.trim() || null, birthday || null, anniversary || null, req.params.id, req.user.restaurant_id]
            );
            return result.rows.length ? res.json({ success: true, data: result.rows[0] }) : res.status(404).json({ success: false, message: 'Customer not found' });
        } catch { return res.status(500).json({ success: false, message: 'Failed to update customer' }); }
    }
}

module.exports = CustomerController;