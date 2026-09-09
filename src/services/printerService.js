const { query } = require('../config/db');

class PrinterService {
    static async ensureTable() {
        await query(`CREATE TABLE IF NOT EXISTS print_jobs (
            id SERIAL PRIMARY KEY, restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
            order_id INT REFERENCES orders(id) ON DELETE CASCADE, job_type VARCHAR(30) NOT NULL,
            payload JSONB NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW(), printed_at TIMESTAMPTZ
        )`);
    }

    static async enqueueOrder(orderId, type = 'KOT') {
        await PrinterService.ensureTable();
        const result = await query(
            `SELECT o.id, o.restaurant_id, o.order_type, o.notes, o.placed_at, o.pickup_token, o.delivery_address, o.delivery_landmark, o.delivery_charge, t.table_number,
                    COALESCE(json_agg(json_build_object('name', oi.item_name, 'quantity', oi.quantity, 'notes', oi.special_instructions)) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
             FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN order_items oi ON oi.order_id = o.id
             WHERE o.id = $1 GROUP BY o.id, t.table_number`, [orderId]
        );
        if (!result.rows.length) return;
        const order = result.rows[0];
        await query(`INSERT INTO print_jobs (restaurant_id, order_id, job_type, payload) VALUES ($1, $2, $3, $4)`, [order.restaurant_id, orderId, type, JSON.stringify({ order_number: order.id, order_type: order.order_type, table_number: order.table_number, pickup_token: order.pickup_token, delivery_address: order.delivery_address, delivery_landmark: order.delivery_landmark, delivery_charge: order.delivery_charge, notes: order.notes, items: order.items })]);
    }

    static async enqueueCancellation(orderId, reason) {
        await PrinterService.ensureTable();
        const result = await query(`SELECT o.id, o.restaurant_id, o.order_type, t.table_number FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = $1`, [orderId]);
        if (!result.rows.length) return;
        const order = result.rows[0];
        await query(`INSERT INTO print_jobs (restaurant_id, order_id, job_type, payload) VALUES ($1, $2, 'CANCELLED_KOT', $3)`, [order.restaurant_id, orderId, JSON.stringify({ order_number: order.id, order_type: order.order_type, table_number: order.table_number, reason })]);
    }
}

module.exports = PrinterService;