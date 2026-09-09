const { query } = require('../config/db');

class LoyaltyService {
    static async ensureTables() {
        await query(`CREATE TABLE IF NOT EXISTS customer_profiles (id SERIAL PRIMARY KEY, restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE, phone VARCHAR(15) NOT NULL, name VARCHAR(100), loyalty_points INT NOT NULL DEFAULT 0, total_visits INT NOT NULL DEFAULT 0, total_spend DECIMAL(12,2) NOT NULL DEFAULT 0, birthday DATE, anniversary DATE, last_visit_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(restaurant_id, phone))`);
        await query(`CREATE TABLE IF NOT EXISTS loyalty_ledger (id SERIAL PRIMARY KEY, restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE, customer_id INT REFERENCES customer_profiles(id) ON DELETE CASCADE, session_id INT REFERENCES order_sessions(id) ON DELETE SET NULL, points INT NOT NULL, type VARCHAR(20) NOT NULL CHECK (type IN ('earned', 'redeemed', 'adjustment')), notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(session_id, type))`);
    }

    static async awardForSession(sessionId) {
        await LoyaltyService.ensureTables();
        const sessionResult = await query(`SELECT s.restaurant_id, s.host_phone, COALESCE(MAX(o.ordered_by_name), 'Customer') AS customer_name, COALESCE(SUM(o.final_amount), 0) AS total FROM order_sessions s LEFT JOIN orders o ON o.session_id = s.id AND o.status != 'cancelled' WHERE s.id = $1 GROUP BY s.id`, [sessionId]);
        const session = sessionResult.rows[0];
        if (!session?.host_phone || session.host_phone === 'pos') return;
        const existing = await query(`SELECT id FROM loyalty_ledger WHERE session_id = $1 AND type = 'earned'`, [sessionId]);
        if (existing.rows.length) return;
        const amount = parseFloat(session.total);
        const points = Math.floor(amount / 100);
        const customerResult = await query(`INSERT INTO customer_profiles (restaurant_id, phone, name, loyalty_points, total_visits, total_spend, last_visit_at) VALUES ($1, $2, $3, $4, 1, $5, NOW()) ON CONFLICT (restaurant_id, phone) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, ''), customer_profiles.name), loyalty_points = customer_profiles.loyalty_points + EXCLUDED.loyalty_points, total_visits = customer_profiles.total_visits + 1, total_spend = customer_profiles.total_spend + EXCLUDED.total_spend, last_visit_at = NOW() RETURNING *`, [session.restaurant_id, session.host_phone, session.customer_name, points, amount]);
        await query(`INSERT INTO loyalty_ledger (restaurant_id, customer_id, session_id, points, type, notes) VALUES ($1, $2, $3, $4, 'earned', $5)`, [session.restaurant_id, customerResult.rows[0].id, sessionId, points, `Earned on bill ₹${amount.toFixed(2)}`]);
    }

    static async redeemForOrder(client, restaurantId, phone, requestedPoints, orderId) {
        const points = parseInt(requestedPoints || 0);
        if (points <= 0) return { points: 0, amount: 0 };
        if (!phone) throw new Error('Customer phone is required to redeem loyalty points');
        const customerResult = await client.query(`SELECT * FROM customer_profiles WHERE restaurant_id = $1 AND phone = $2 FOR UPDATE`, [restaurantId, phone]);
        const customer = customerResult.rows[0];
        if (!customer) throw new Error('No loyalty profile found for this customer');
        if (points > customer.loyalty_points) throw new Error(`Only ${customer.loyalty_points} loyalty points are available`);
        await client.query(`UPDATE customer_profiles SET loyalty_points = loyalty_points - $1 WHERE id = $2`, [points, customer.id]);
        await client.query(`INSERT INTO loyalty_ledger (restaurant_id, customer_id, points, type, notes) VALUES ($1, $2, $3, 'redeemed', $4)`, [restaurantId, customer.id, -points, `Redeemed on POS order ${orderId}`]);
        return { points, amount: points };
    }
}

module.exports = LoyaltyService;