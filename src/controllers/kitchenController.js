const { query } = require('../config/db');

class KitchenController {

    // =============================================
    // KITCHEN STATS (Aaj ka poora data)
    // =============================================
    static async getStats(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const today = new Date().toISOString().split('T')[0];

            // 1. Today's Order Counts by Status
            const statusCounts = await query(
                `SELECT status, COUNT(*) as count
                 FROM orders
                 WHERE restaurant_id = $1 AND DATE(placed_at) = $2
                 GROUP BY status`,
                [restaurant_id, today]
            );

            // 2. Average Prep Time (placed -> served)
            const avgPrepTime = await query(
                `SELECT 
                    AVG(EXTRACT(EPOCH FROM (served_at - placed_at)) / 60) as avg_minutes,
                    MIN(EXTRACT(EPOCH FROM (served_at - placed_at)) / 60) as fastest,
                    MAX(EXTRACT(EPOCH FROM (served_at - placed_at)) / 60) as slowest
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND DATE(placed_at) = $2
                 AND status = 'served'
                 AND served_at IS NOT NULL`,
                [restaurant_id, today]
            );

            // 3. Hourly Order Distribution (Peak hours)
            const hourlyOrders = await query(
                `SELECT 
                    EXTRACT(HOUR FROM placed_at) as hour,
                    COUNT(*) as orders
                 FROM orders
                 WHERE restaurant_id = $1 AND DATE(placed_at) = $2
                 GROUP BY EXTRACT(HOUR FROM placed_at)
                 ORDER BY hour ASC`,
                [restaurant_id, today]
            );

            // 4. Most Ordered Items Today
            const topItems = await query(
                `SELECT 
                    oi.item_name,
                    SUM(oi.quantity) as total_qty
                 FROM order_items oi
                 JOIN orders o ON oi.order_id = o.id
                 WHERE o.restaurant_id = $1 
                 AND DATE(o.placed_at) = $2
                 AND oi.status != 'cancelled'
                 GROUP BY oi.item_name
                 ORDER BY total_qty DESC
                 LIMIT 5`,
                [restaurant_id, today]
            );

            // 5. Late Orders Count (>15 min)
            const lateOrders = await query(
                `SELECT COUNT(*) as count
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND DATE(placed_at) = $2
                 AND status IN ('placed', 'accepted', 'preparing')
                 AND placed_at < NOW() - INTERVAL '15 minutes'`,
                [restaurant_id, today]
            );

            // 6. Total Revenue Today
            const revenue = await query(
                `SELECT COALESCE(SUM(final_amount), 0) as total
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND DATE(placed_at) = $2
                 AND status != 'cancelled'`,
                [restaurant_id, today]
            );

            return res.status(200).json({
                success: true,
                data: {
                    date: today,
                    status_counts: statusCounts.rows,
                    avg_prep_time: {
                        avg_minutes: parseFloat(parseFloat(avgPrepTime.rows[0]?.avg_minutes || 0).toFixed(1)),
                        fastest: parseFloat(parseFloat(avgPrepTime.rows[0]?.fastest || 0).toFixed(1)),
                        slowest: parseFloat(parseFloat(avgPrepTime.rows[0]?.slowest || 0).toFixed(1)),
                    },
                    hourly_orders: hourlyOrders.rows.map(r => ({
                        hour: parseInt(r.hour),
                        orders: parseInt(r.orders)
                    })),
                    top_items: topItems.rows.map(r => ({
                        name: r.item_name,
                        quantity: parseInt(r.total_qty)
                    })),
                    late_orders: parseInt(lateOrders.rows[0].count),
                    total_revenue: parseFloat(revenue.rows[0].total)
                }
            });

        } catch (error) {
            console.error('Kitchen Stats Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // ORDER HISTORY (Completed + Cancelled)
    // =============================================
    static async getHistory(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { date, status, limit = 20, page = 1 } = req.query;

            const targetDate = date || new Date().toISOString().split('T')[0];
            const offset = (parseInt(page) - 1) * parseInt(limit);
            const params = [restaurant_id, targetDate];

            let statusFilter = "AND o.status IN ('served', 'cancelled')";
            if (status) {
                params.push(status);
                statusFilter = `AND o.status = $${params.length}`;
            }

            const limitParam = params.length + 1;
            const offsetParam = params.length + 2;

            const result = await query(
                `SELECT 
                    o.id, o.status, o.final_amount, o.placed_at, o.served_at,
                    o.ordered_by_name, t.table_number,
                    EXTRACT(EPOCH FROM (o.served_at - o.placed_at)) / 60 as prep_time_minutes,
                    (
                        SELECT json_agg(
                            json_build_object('name', oi.item_name, 'qty', oi.quantity)
                        )
                        FROM order_items oi 
                        WHERE oi.order_id = o.id AND oi.status != 'cancelled'
                    ) as items
                 FROM orders o
                 JOIN tables t ON o.table_id = t.id
                 WHERE o.restaurant_id = $1 
                 AND DATE(o.placed_at) = $2
                 ${statusFilter}
                 ORDER BY o.placed_at DESC
                 LIMIT $${limitParam} OFFSET $${offsetParam}`,
                [...params, parseInt(limit), offset]
            );

            const countResult = await query(
                `SELECT COUNT(*) FROM orders o
                 WHERE o.restaurant_id = $1 
                 AND DATE(o.placed_at) = $2
                 ${statusFilter}`,
                params
            );

            return res.status(200).json({
                success: true,
                data: {
                    total: parseInt(countResult.rows[0].count),
                    page: parseInt(page),
                    orders: result.rows.map(r => ({
                        id: r.id,
                        status: r.status,
                        table_number: r.table_number,
                        customer: r.ordered_by_name,
                        amount: parseFloat(r.final_amount),
                        placed_at: r.placed_at,
                        served_at: r.served_at,
                        prep_time: r.prep_time_minutes ? parseFloat(parseFloat(r.prep_time_minutes).toFixed(1)) : null,
                        items: r.items || []
                    }))
                }
            });

        } catch (error) {
            console.error('Kitchen History Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // MULTI-KITCHEN SECTIONS
    // =============================================
    static async getKitchenSections(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;

            // Sections table banao agar nahi hai
            await query(`
                CREATE TABLE IF NOT EXISTS kitchen_sections (
                    id SERIAL PRIMARY KEY,
                    restaurant_id INT REFERENCES restaurants(id),
                    name VARCHAR(100) NOT NULL,
                    description TEXT,
                    category_ids INT[],
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            let sections = await query(
                `SELECT * FROM kitchen_sections 
                 WHERE restaurant_id = $1 AND is_active = TRUE
                 ORDER BY name`,
                [restaurant_id]
            );

            // Agar koi section nahi hai, toh default banao
            if (sections.rows.length === 0) {
                await query(
                    `INSERT INTO kitchen_sections (restaurant_id, name, description) VALUES
                     ($1, 'Main Kitchen', 'All main course items'),
                     ($1, 'Tandoor', 'Naan, Roti, Tikka items'),
                     ($1, 'Bar', 'Drinks, Shakes, Mocktails'),
                     ($1, 'Chinese', 'Noodles, Manchurian, Fried Rice')`,
                    [restaurant_id]
                );

                sections = await query(
                    `SELECT * FROM kitchen_sections 
                     WHERE restaurant_id = $1 AND is_active = TRUE`,
                    [restaurant_id]
                );
            }

            return res.status(200).json({
                success: true,
                data: sections.rows
            });

        } catch (error) {
            console.error('Kitchen Sections Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // ORDER RECALL (Served order wapas kitchen bhejo)
    // =============================================
    static async recallOrder(req, res) {
        try {
            const { order_id } = req.params;
            const { reason } = req.body;

            // Check karo order served hai ya nahi
            const orderResult = await query(
                'SELECT * FROM orders WHERE id = $1',
                [order_id]
            );

            if (orderResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Order not found'
                });
            }

            const order = orderResult.rows[0];

            if (order.status !== 'served') {
                return res.status(400).json({
                    success: false,
                    message: `Cannot recall! Order is "${order.status}", not "served".`
                });
            }

            const recallReason = reason || 'Customer complaint';

            // Order ko wapas "preparing" status mein daalo
            await query(
                `UPDATE orders 
                 SET status = 'preparing', 
                     served_at = NULL,
                     notes = COALESCE(notes, '') || $2
                 WHERE id = $1`,
                [order_id, ` [RECALLED: ${recallReason}]`]
            );

            // Items bhi wapas "preparing" karo
            await query(
                `UPDATE order_items SET status = 'preparing' WHERE order_id = $1`,
                [order_id]
            );

            // Socket.io notify karo
            const io = req.app.get('io');
            if (io) {
                io.to(`restaurant_${order.restaurant_id}`).emit('order_recalled', {
                    order_id: order.id,
                    table_id: order.table_id,
                    reason: reason || 'Recalled by kitchen',
                    message: `🔄 Order #${order.id} recalled! Back to kitchen.`
                });
                io.to(`restaurant_${order.restaurant_id}`).emit('kitchen_order_update', {
                    order_id: order.id,
                    status: 'preparing'
                });
            }

            return res.status(200).json({
                success: true,
                message: `Order #${order_id} recalled to kitchen!`
            });

        } catch (error) {
            console.error('Recall Order Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // WEEKLY / MONTHLY REPORTS
    // =============================================
    static async getTrendReport(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { period = 'weekly' } = req.query; // weekly or monthly

            let interval, groupBy, dateFormat;

            if (period === 'monthly') {
                interval = '30 days';
                groupBy = "DATE_TRUNC('day', placed_at)";
                dateFormat = 'YYYY-MM-DD';
            } else {
                interval = '7 days';
                groupBy = "DATE_TRUNC('day', placed_at)";
                dateFormat = 'Dy DD';
            }

            // Daily order count + revenue
            const dailyTrend = await query(
                `SELECT 
                    TO_CHAR(${groupBy}, '${dateFormat}') as label,
                    COUNT(*) as orders,
                    COALESCE(SUM(final_amount), 0) as revenue,
                    AVG(EXTRACT(EPOCH FROM (served_at - placed_at)) / 60) as avg_prep
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND placed_at >= NOW() - INTERVAL '${interval}'
                 AND status != 'cancelled'
                 GROUP BY ${groupBy}
                 ORDER BY ${groupBy} ASC`,
                [restaurant_id]
            );

            // Status distribution
            const statusDist = await query(
                `SELECT status, COUNT(*) as count
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND placed_at >= NOW() - INTERVAL '${interval}'
                 GROUP BY status`,
                [restaurant_id]
            );

            // Cancellation rate
            const totalOrders = await query(
                `SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND placed_at >= NOW() - INTERVAL '${interval}'`,
                [restaurant_id]
            );

            const total = parseInt(totalOrders.rows[0].total) || 1;
            const cancelled = parseInt(totalOrders.rows[0].cancelled) || 0;
            const cancelRate = ((cancelled / total) * 100).toFixed(1);

            return res.status(200).json({
                success: true,
                data: {
                    period: period,
                    interval: interval,
                    daily_trend: dailyTrend.rows.map(r => ({
                        label: r.label,
                        orders: parseInt(r.orders),
                        revenue: parseFloat(r.revenue),
                        avg_prep: parseFloat(parseFloat(r.avg_prep || 0).toFixed(1))
                    })),
                    status_distribution: statusDist.rows,
                    cancellation_rate: parseFloat(cancelRate),
                    total_orders: total,
                    cancelled_orders: cancelled
                }
            });

        } catch (error) {
            console.error('Trend Report Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = KitchenController;
