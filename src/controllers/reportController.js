const { query } = require('../config/db');
const AuditService = require('../services/auditService');
const PDFDocument = require('pdfkit');

class ReportController {
    static async ensureDailyClosingTable() {
        await query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'Asia/Kolkata'`);
        await query(`
            CREATE TABLE IF NOT EXISTS daily_closings (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                closing_date DATE NOT NULL,
                total_sales DECIMAL(12,2) NOT NULL DEFAULT 0,
                total_orders INT NOT NULL DEFAULT 0,
                expected_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
                actual_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
                cash_variance DECIMAL(12,2) NOT NULL DEFAULT 0,
                payment_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
                notes TEXT,
                closed_by INT REFERENCES users(id) ON DELETE SET NULL,
                closed_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(restaurant_id, closing_date)
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS cash_shifts (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                business_date DATE NOT NULL,
                shift_name VARCHAR(60) NOT NULL,
                opening_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
                expected_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
                actual_cash DECIMAL(12,2),
                cash_variance DECIMAL(12,2),
                notes TEXT,
                opened_by INT REFERENCES users(id) ON DELETE SET NULL,
                closed_by INT REFERENCES users(id) ON DELETE SET NULL,
                opened_at TIMESTAMPTZ DEFAULT NOW(),
                closed_at TIMESTAMPTZ,
                UNIQUE(restaurant_id, business_date, shift_name)
            )
        `);
    }

    static async getRestaurantTimezone(restaurantId) {
        const result = await query(`SELECT COALESCE(timezone, 'Asia/Kolkata') AS timezone FROM restaurants WHERE id = $1`, [restaurantId]);
        return result.rows[0]?.timezone || 'Asia/Kolkata';
    }

    static async getCurrentBusinessDate(restaurantId) {
        const timezone = await ReportController.getRestaurantTimezone(restaurantId);
        const result = await query(`SELECT TO_CHAR(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS business_date`, [timezone]);
        return result.rows[0].business_date;
    }

    static async getDailySummary(restaurantId, date, timezone) {
        const salesResult = await query(
            `SELECT COUNT(*) AS total_orders, COALESCE(SUM(final_amount), 0) AS total_sales,
                    COALESCE(SUM(subtotal), 0) AS subtotal, COALESCE(SUM(gst_amount), 0) AS gst,
                    COALESCE(SUM(service_charge), 0) AS service_charge
             FROM orders WHERE restaurant_id = $1 AND (placed_at AT TIME ZONE $3)::date = $2::date AND status != 'cancelled'`,
            [restaurantId, date, timezone]
        );
        const paymentsResult = await query(
            `SELECT payment_method, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS payment_count
             FROM payments WHERE restaurant_id = $1 AND (paid_at AT TIME ZONE $3)::date = $2::date AND status = 'success'
             GROUP BY payment_method ORDER BY payment_method`,
            [restaurantId, date, timezone]
        );
        const payments = paymentsResult.rows.map(row => ({
            method: row.payment_method,
            amount: parseFloat(row.amount),
            count: parseInt(row.payment_count)
        }));
        const expectedCash = payments
            .filter(payment => payment.method === 'cash')
            .reduce((total, payment) => total + payment.amount, 0);
        const collected = payments.reduce((total, payment) => total + payment.amount, 0);
        const sales = salesResult.rows[0];
        return {
            date,
            total_orders: parseInt(sales.total_orders),
            total_sales: parseFloat(sales.total_sales),
            subtotal: parseFloat(sales.subtotal),
            gst: parseFloat(sales.gst),
            service_charge: parseFloat(sales.service_charge),
            payment_total: parseFloat(collected.toFixed(2)),
            expected_cash: parseFloat(expectedCash.toFixed(2)),
            payment_breakdown: payments
        };
    }

    static async getUnpaidSessions(restaurantId) {
        const result = await query(
            `SELECT s.id AS session_id, t.table_number, s.host_phone, COALESCE(SUM(o.final_amount), 0) AS bill_amount,
                    COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.session_id = s.id AND p.status = 'success'), 0) AS paid_amount
             FROM order_sessions s JOIN tables t ON s.table_id = t.id
             LEFT JOIN orders o ON o.session_id = s.id AND o.status != 'cancelled'
             WHERE s.restaurant_id = $1 AND s.status = 'active'
             GROUP BY s.id, t.table_number
             HAVING COALESCE(SUM(o.final_amount), 0) > COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.session_id = s.id AND p.status = 'success'), 0)
             ORDER BY t.table_number`,
            [restaurantId]
        );
        return result.rows.map(row => ({ ...row, bill_amount: parseFloat(row.bill_amount), paid_amount: parseFloat(row.paid_amount), outstanding_amount: parseFloat((parseFloat(row.bill_amount) - parseFloat(row.paid_amount)).toFixed(2)) }));
    }

    static async getDailyClosing(req, res) {
        try {
            await ReportController.ensureDailyClosingTable();
            const date = req.query.date || await ReportController.getCurrentBusinessDate(req.user.restaurant_id);
            const timezone = await ReportController.getRestaurantTimezone(req.user.restaurant_id);
            const summary = await ReportController.getDailySummary(req.user.restaurant_id, date, timezone);
            const unpaidSessions = await ReportController.getUnpaidSessions(req.user.restaurant_id);
            const closingResult = await query(
                `SELECT c.*, u.name AS closed_by_name FROM daily_closings c
                 LEFT JOIN users u ON c.closed_by = u.id
                 WHERE c.restaurant_id = $1 AND c.closing_date = $2`,
                [req.user.restaurant_id, date]
            );
            return res.status(200).json({ success: true, data: { summary: { ...summary, timezone }, closing: closingResult.rows[0] || null, unpaid_sessions: unpaidSessions } });
        } catch (error) {
            console.error('Daily closing summary error:', error);
            return res.status(500).json({ success: false, message: 'Failed to load daily closing' });
        }
    }

    static async closeDay(req, res) {
        try {
            await ReportController.ensureDailyClosingTable();
            const date = req.body.closing_date || await ReportController.getCurrentBusinessDate(req.user.restaurant_id);
            const actualCash = parseFloat(req.body.actual_cash);
            if (!Number.isFinite(actualCash) || actualCash < 0) {
                return res.status(400).json({ success: false, message: 'A valid actual_cash amount is required' });
            }
            const timezone = await ReportController.getRestaurantTimezone(req.user.restaurant_id);
            const summary = await ReportController.getDailySummary(req.user.restaurant_id, date, timezone);
            const unpaidSessions = await ReportController.getUnpaidSessions(req.user.restaurant_id);
            if (unpaidSessions.length > 0 && req.body.allow_unpaid !== true) {
                return res.status(409).json({ success: false, message: 'Unpaid sessions must be settled or explicitly approved before closing', data: { unpaid_sessions: unpaidSessions } });
            }
            const variance = parseFloat((actualCash - summary.expected_cash).toFixed(2));
            const result = await query(
                `INSERT INTO daily_closings
                 (restaurant_id, closing_date, total_sales, total_orders, expected_cash, actual_cash, cash_variance, payment_breakdown, notes, closed_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [req.user.restaurant_id, date, summary.total_sales, summary.total_orders, summary.expected_cash,
                    actualCash, variance, JSON.stringify(summary.payment_breakdown), req.body.notes || '', req.user.id]
            );
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'day_closed', entityType: 'daily_closing', entityId: result.rows[0].id, details: { date, actual_cash: actualCash, variance } });
            return res.status(201).json({ success: true, data: { summary, closing: result.rows[0] } });
        } catch (error) {
            if (error.code === '23505') return res.status(409).json({ success: false, message: 'This date has already been closed' });
            console.error('Close day error:', error);
            return res.status(500).json({ success: false, message: 'Failed to close day' });
        }
    }

    static async openShift(req, res) {
        try {
            await ReportController.ensureDailyClosingTable();
            const { shift_name, opening_cash = 0, business_date } = req.body;
            const date = business_date || await ReportController.getCurrentBusinessDate(req.user.restaurant_id);
            const cash = parseFloat(opening_cash);
            if (!shift_name?.trim() || !Number.isFinite(cash) || cash < 0) return res.status(400).json({ success: false, message: 'shift_name and valid opening_cash are required' });
            const result = await query(
                `INSERT INTO cash_shifts (restaurant_id, business_date, shift_name, opening_cash, opened_by)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [req.user.restaurant_id, date, shift_name.trim(), cash, req.user.id]
            );
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'cash_shift_opened', entityType: 'cash_shift', entityId: result.rows[0].id, details: { shift_name, opening_cash: cash } });
            return res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error) {
            return res.status(error.code === '23505' ? 409 : 500).json({ success: false, message: error.code === '23505' ? 'This shift is already open' : 'Failed to open shift' });
        }
    }

    static async closeShift(req, res) {
        try {
            await ReportController.ensureDailyClosingTable();
            const actualCash = parseFloat(req.body.actual_cash);
            if (!Number.isFinite(actualCash) || actualCash < 0) return res.status(400).json({ success: false, message: 'Valid actual_cash is required' });
            const shiftResult = await query(`SELECT * FROM cash_shifts WHERE id = $1 AND restaurant_id = $2 AND closed_at IS NULL`, [req.params.id, req.user.restaurant_id]);
            if (shiftResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Open shift not found' });
            const shift = shiftResult.rows[0];
            const cashResult = await query(
                `SELECT COALESCE(SUM(amount), 0) AS cash_received
                 FROM payments WHERE restaurant_id = $1 AND payment_method = 'cash' AND status = 'success'
                 AND paid_at >= $2 AND paid_at <= NOW()`,
                [req.user.restaurant_id, shift.opened_at]
            );
            const cashReceived = parseFloat(cashResult.rows[0].cash_received);
            const expectedCash = parseFloat((parseFloat(shift.opening_cash) + cashReceived).toFixed(2));
            const variance = parseFloat((actualCash - expectedCash).toFixed(2));
            const result = await query(`UPDATE cash_shifts SET expected_cash = $1, actual_cash = $2, cash_variance = $3, notes = $4, closed_by = $5, closed_at = NOW() WHERE id = $6 RETURNING *`, [expectedCash, actualCash, variance, req.body.notes || '', req.user.id, shift.id]);
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'cash_shift_closed', entityType: 'cash_shift', entityId: shift.id, details: { shift_name: shift.shift_name, variance } });
            return res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to close shift' });
        }
    }

    static async getShifts(req, res) {
        try {
            await ReportController.ensureDailyClosingTable();
            const date = req.query.date || await ReportController.getCurrentBusinessDate(req.user.restaurant_id);
            const result = await query(`SELECT s.*, ou.name AS opened_by_name, cu.name AS closed_by_name FROM cash_shifts s LEFT JOIN users ou ON s.opened_by = ou.id LEFT JOIN users cu ON s.closed_by = cu.id WHERE s.restaurant_id = $1 AND s.business_date = $2 ORDER BY s.opened_at`, [req.user.restaurant_id, date]);
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to load shifts' });
        }
    }

    static async reopenDay(req, res) {
        try {
            await ReportController.ensureDailyClosingTable();
            const { reason } = req.body;
            if (!reason?.trim()) return res.status(400).json({ success: false, message: 'Reopen reason is required' });
            const result = await query(`DELETE FROM daily_closings WHERE restaurant_id = $1 AND closing_date = $2 RETURNING *`, [req.user.restaurant_id, req.params.date]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Closing not found' });
            await AuditService.log({ restaurantId: req.user.restaurant_id, actor: req.user, action: 'day_reopened', entityType: 'daily_closing', entityId: result.rows[0].id, details: { date: req.params.date, reason: reason.trim() } });
            return res.status(200).json({ success: true, message: 'Day reopened for correction' });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to reopen day' });
        }
    }

    static async exportDailyClosing(req, res) {
        try {
            await ReportController.ensureDailyClosingTable();
            const date = req.query.date || await ReportController.getCurrentBusinessDate(req.user.restaurant_id);
            const timezone = await ReportController.getRestaurantTimezone(req.user.restaurant_id);
            const summary = await ReportController.getDailySummary(req.user.restaurant_id, date, timezone);
            const rows = [['Metric', 'Amount'], ['Business Date', date], ['Timezone', timezone], ['Orders', summary.total_orders], ['Sales', summary.total_sales], ['GST', summary.gst], ['Expected Cash', summary.expected_cash], ['Payment Collected', summary.payment_total], ...summary.payment_breakdown.map(payment => [`Payment: ${payment.method}`, payment.amount])];
            const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="daily-closing-${date}.csv"`);
            return res.status(200).send(csv);
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to export daily closing' });
        }
    }

    static async exportReport(req, res) {
        try {
            const restaurantId = req.user.restaurant_id;
            const date = req.query.date || await ReportController.getCurrentBusinessDate(restaurantId);
            const startDate = req.query.start_date || date;
            const endDate = req.query.end_date || date;
            const format = req.query.format === 'pdf' ? 'pdf' : 'csv';
            const rangeEnd = endDate === startDate ? `${endDate} 23:59:59` : endDate;

            const sales = await query(
                `SELECT COUNT(*) AS orders, COALESCE(SUM(final_amount), 0) AS revenue,
                        COALESCE(SUM(gst_amount), 0) AS gst,
                        COALESCE(AVG(final_amount), 0) AS average_order_value
                 FROM orders
                 WHERE restaurant_id = $1 AND placed_at >= $2 AND placed_at <= $3 AND status != 'cancelled'`,
                [restaurantId, startDate, rangeEnd]
            );
            const trend = await query(
                `SELECT TO_CHAR(DATE_TRUNC('day', placed_at), 'YYYY-MM-DD') AS label,
                        COUNT(*) AS orders, COALESCE(SUM(final_amount), 0) AS revenue
                 FROM orders
                 WHERE restaurant_id = $1 AND placed_at >= $2 AND placed_at <= $3 AND status != 'cancelled'
                 GROUP BY DATE_TRUNC('day', placed_at) ORDER BY DATE_TRUNC('day', placed_at)`,
                [restaurantId, startDate, rangeEnd]
            );
            const topItems = await query(
                `SELECT oi.item_name AS name, SUM(oi.quantity) AS quantity, COALESCE(SUM(oi.total_price), 0) AS revenue
                 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                 WHERE o.restaurant_id = $1 AND o.placed_at >= $2 AND o.placed_at <= $3
                   AND o.status != 'cancelled' AND oi.status != 'cancelled'
                 GROUP BY oi.item_name ORDER BY quantity DESC LIMIT 10`,
                [restaurantId, startDate, rangeEnd]
            );
            const payments = await query(
                `SELECT payment_method AS method, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
                 FROM payments WHERE restaurant_id = $1 AND paid_at >= $2 AND paid_at <= $3 AND status = 'success'
                 GROUP BY payment_method ORDER BY payment_method`,
                [restaurantId, startDate, rangeEnd]
            );
            const orderTypes = await query(
                `SELECT order_type AS type, COUNT(*) AS count
                 FROM orders WHERE restaurant_id = $1 AND placed_at >= $2 AND placed_at <= $3 AND status != 'cancelled'
                 GROUP BY order_type ORDER BY order_type`,
                [restaurantId, startDate, rangeEnd]
            );

            const summary = sales.rows[0];
            const rows = [
                ['Report', 'Restaurant Business Report'],
                ['Period', `${startDate} to ${endDate}`],
                [],
                ['KPI', 'Value'],
                ['Total Orders', summary.orders],
                ['Total Revenue', summary.revenue],
                ['GST', summary.gst],
                ['Average Order Value', summary.average_order_value],
                [],
                ['Revenue Trend', 'Orders', 'Revenue'],
                ...trend.rows.map(row => [row.label, row.orders, row.revenue]),
                [],
                ['Top Items', 'Quantity Sold', 'Revenue'],
                ...topItems.rows.map(row => [row.name, row.quantity, row.revenue]),
                [],
                ['Payment Breakdown', 'Transactions', 'Amount'],
                ...payments.rows.map(row => [row.method, row.count, row.amount]),
                [],
                ['Order Distribution', 'Orders'],
                ...orderTypes.rows.map(row => [row.type, row.count])
            ];

            if (format === 'csv') {
                const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="restaurant-report-${date}.csv"`);
                return res.status(200).send(csv);
            }

            const doc = new PDFDocument({ margin: 40 });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="restaurant-report-${date}.pdf"`);
            doc.pipe(res);
            doc.fontSize(20).text('Restaurant Business Report');
            doc.fontSize(10).fillColor('#666666').text(`Period: ${startDate} to ${endDate}`);
            doc.moveDown();
            doc.fillColor('#000000').fontSize(12).text(`Total Orders: ${summary.orders}`);
            doc.text(`Total Revenue: Rs. ${Number(summary.revenue).toFixed(2)}`);
            doc.text(`GST: Rs. ${Number(summary.gst).toFixed(2)}`);
            doc.text(`Average Order Value: Rs. ${Number(summary.average_order_value).toFixed(2)}`);
            const section = (title, data, columns) => {
                doc.moveDown().fontSize(14).text(title);
                doc.fontSize(10).text(columns.join(' | '));
                data.forEach(row => doc.text(row.join(' | ')));
            };
            section('Revenue Trend', trend.rows.map(row => [row.label, row.orders, `Rs. ${row.revenue}`]), ['Date', 'Orders', 'Revenue']);
            section('Top Items', topItems.rows.map(row => [row.name, row.quantity, `Rs. ${row.revenue}`]), ['Item', 'Quantity', 'Revenue']);
            section('Payment Breakdown', payments.rows.map(row => [row.method, row.count, `Rs. ${row.amount}`]), ['Method', 'Transactions', 'Amount']);
            section('Order Distribution', orderTypes.rows.map(row => [row.type, row.count]), ['Type', 'Orders']);
            doc.end();
        } catch (error) {
            console.error('Report export error:', error);
            return res.status(500).json({ success: false, message: 'Failed to export report' });
        }
    }

    // =============================================
    // DASHBOARD — Today's Live Stats
    // Owner app pe yeh dikhega
    // =============================================
    static async getDashboard(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;

            // Aaj ki date
            const today = new Date().toISOString().split('T')[0];

            // 1. Today's Total Revenue
            const revenueResult = await query(
                `SELECT 
                    COALESCE(SUM(o.final_amount), 0) as total_revenue,
                    COUNT(DISTINCT o.id) as total_orders,
                    COALESCE(AVG(o.final_amount), 0) as avg_order_value
                 FROM orders o
                 WHERE o.restaurant_id = $1 
                 AND DATE(o.placed_at) = $2
                 AND o.status != 'cancelled'`,
                [restaurant_id, today]
            );

            // 2. Payment Method Breakdown
            const paymentBreakdown = await query(
                `SELECT 
                    p.payment_method,
                    COUNT(*) as count,
                    SUM(p.amount) as total
                 FROM payments p
                 JOIN order_sessions s ON p.session_id = s.id
                 WHERE s.restaurant_id = $1 
                 AND DATE(p.paid_at) = $2
                 AND p.status = 'success'
                 GROUP BY p.payment_method`,
                [restaurant_id, today]
            );

            // 3. Table Occupancy (Live)
            const tableStats = await query(
                `SELECT 
                    status,
                    COUNT(*) as count
                 FROM tables 
                 WHERE restaurant_id = $1
                 GROUP BY status`,
                [restaurant_id]
            );

            // 4. Active Orders Count
            const activeOrders = await query(
                `SELECT COUNT(*) as count 
                 FROM orders 
                 WHERE restaurant_id = $1 
                 AND status IN ('placed', 'accepted', 'preparing', 'ready')`,
                [restaurant_id]
            );

            // 5. Hourly Sales Graph (Aaj ke har ghante ki sale)
            const hourlySales = await query(
                `SELECT 
                    EXTRACT(HOUR FROM placed_at) as hour,
                    COUNT(*) as orders,
                    SUM(final_amount) as revenue
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND DATE(placed_at) = $2
                 AND status != 'cancelled'
                 GROUP BY EXTRACT(HOUR FROM placed_at)
                 ORDER BY hour ASC`,
                [restaurant_id, today]
            );

            const orderTypes = await query(
                `SELECT order_type, COUNT(*) AS count
                 FROM orders
                 WHERE restaurant_id = $1 AND DATE(placed_at) = $2 AND status != 'cancelled'
                 GROUP BY order_type ORDER BY order_type`,
                [restaurant_id, today]
            );

            return res.status(200).json({
                success: true,
                data: {
                    date: today,
                    revenue: {
                        total: parseFloat(revenueResult.rows[0].total_revenue),
                        total_orders: parseInt(revenueResult.rows[0].total_orders),
                        avg_order_value: parseFloat(parseFloat(revenueResult.rows[0].avg_order_value).toFixed(2))
                    },
                    payment_methods: paymentBreakdown.rows,
                    tables: tableStats.rows,
                    active_orders: parseInt(activeOrders.rows[0].count),
                    order_types: orderTypes.rows.map(row => ({
                        order_type: row.order_type,
                        count: parseInt(row.count)
                    })),
                    hourly_sales: hourlySales.rows.map(row => ({
                        hour: parseInt(row.hour),
                        orders: parseInt(row.orders),
                        revenue: parseFloat(row.revenue)
                    }))
                }
            });

        } catch (error) {
            console.error('Dashboard Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // TOP SELLING ITEMS (Kaunsi dish sabse zyada biki)
    // =============================================
    static async getTopItems(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { days = 7, limit = 10 } = req.query;

            const result = await query(
                `SELECT 
                    oi.item_name,
                    mi.is_veg,
                    mi.image_url,
                    SUM(oi.quantity) as total_quantity,
                    SUM(oi.total_price) as total_revenue,
                    COUNT(DISTINCT oi.order_id) as times_ordered
                 FROM order_items oi
                 JOIN orders o ON oi.order_id = o.id
                 JOIN menu_items mi ON oi.menu_item_id = mi.id
                 WHERE o.restaurant_id = $1 
                 AND o.status != 'cancelled'
                 AND oi.status != 'cancelled'
                 AND o.placed_at >= NOW() - INTERVAL '${parseInt(days)} days'
                 GROUP BY oi.item_name, mi.is_veg, mi.image_url
                 ORDER BY total_quantity DESC
                 LIMIT $2`,
                [restaurant_id, parseInt(limit)]
            );

            return res.status(200).json({
                success: true,
                data: {
                    period: `Last ${days} days`,
                    top_items: result.rows.map(row => ({
                        name: row.item_name,
                        is_veg: row.is_veg,
                        image_url: row.image_url,
                        total_sold: parseInt(row.total_quantity),
                        revenue: parseFloat(row.total_revenue),
                        times_ordered: parseInt(row.times_ordered)
                    }))
                }
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // REVENUE REPORT (Daily / Weekly / Monthly)
    // =============================================
    static async getRevenueReport(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { period = 'daily', start_date, end_date } = req.query;

            let groupBy, dateFormat;

            switch (period) {
                case 'daily':
                    groupBy = 'DATE(o.placed_at)';
                    dateFormat = 'YYYY-MM-DD';
                    break;
                case 'weekly':
                    groupBy = "DATE_TRUNC('week', o.placed_at)";
                    dateFormat = 'YYYY-WW';
                    break;
                case 'monthly':
                    groupBy = "DATE_TRUNC('month', o.placed_at)";
                    dateFormat = 'YYYY-MM';
                    break;
                default:
                    groupBy = 'DATE(o.placed_at)';
            }

            let dateFilter = '';
            const params = [restaurant_id];

            if (start_date && end_date) {
                dateFilter = `AND o.placed_at BETWEEN $2 AND $3`;
                params.push(start_date, end_date);
            } else {
                // Default: Last 30 days
                dateFilter = `AND o.placed_at >= NOW() - INTERVAL '30 days'`;
            }

            const result = await query(
                `SELECT 
                    TO_CHAR(${groupBy}, '${dateFormat}') as period,
                    COUNT(DISTINCT o.id) as total_orders,
                    SUM(o.subtotal) as total_subtotal,
                    SUM(o.gst_amount) as total_gst,
                    SUM(o.service_charge) as total_service_charge,
                    SUM(o.final_amount) as total_revenue,
                    COUNT(DISTINCT o.session_id) as total_sessions
                 FROM orders o
                 WHERE o.restaurant_id = $1 
                 AND o.status != 'cancelled'
                 ${dateFilter}
                 GROUP BY ${groupBy}
                 ORDER BY period DESC`,
                params
            );

            // Grand total calculate karo
            const grandTotal = result.rows.reduce((acc, row) => ({
                orders: acc.orders + parseInt(row.total_orders),
                revenue: acc.revenue + parseFloat(row.total_revenue),
                gst: acc.gst + parseFloat(row.total_gst),
                sessions: acc.sessions + parseInt(row.total_sessions)
            }), { orders: 0, revenue: 0, gst: 0, sessions: 0 });

            return res.status(200).json({
                success: true,
                data: {
                    period_type: period,
                    grand_total: {
                        total_orders: grandTotal.orders,
                        total_revenue: parseFloat(grandTotal.revenue.toFixed(2)),
                        total_gst_collected: parseFloat(grandTotal.gst.toFixed(2)),
                        total_sessions: grandTotal.sessions
                    },
                    breakdown: result.rows.map(row => ({
                        period: row.period,
                        orders: parseInt(row.total_orders),
                        subtotal: parseFloat(row.total_subtotal),
                        gst: parseFloat(row.total_gst),
                        service_charge: parseFloat(row.total_service_charge),
                        revenue: parseFloat(row.total_revenue)
                    }))
                }
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // PEAK HOURS ANALYSIS (Kis time sabse zyada bheed)
    // =============================================
    static async getPeakHours(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { days = 30 } = req.query;

            const result = await query(
                `SELECT 
                    EXTRACT(HOUR FROM placed_at) as hour,
                    EXTRACT(DOW FROM placed_at) as day_of_week,
                    COUNT(*) as order_count,
                    SUM(final_amount) as revenue
                 FROM orders
                 WHERE restaurant_id = $1 
                 AND status != 'cancelled'
                 AND placed_at >= NOW() - INTERVAL '${parseInt(days)} days'
                 GROUP BY EXTRACT(HOUR FROM placed_at), EXTRACT(DOW FROM placed_at)
                 ORDER BY order_count DESC
                 LIMIT 20`,
                [restaurant_id]
            );

            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

            return res.status(200).json({
                success: true,
                data: {
                    peak_hours: result.rows.map(row => ({
                        hour: `${parseInt(row.hour)}:00 - ${parseInt(row.hour) + 1}:00`,
                        day: dayNames[parseInt(row.day_of_week)],
                        orders: parseInt(row.order_count),
                        revenue: parseFloat(row.revenue)
                    }))
                }
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // STAFF PERFORMANCE (Kaunsa waiter best hai)
    // =============================================
    static async getStaffPerformance(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { days = 30 } = req.query;

            const result = await query(
                `SELECT 
                    u.name as waiter_name,
                    u.phone,
                    COUNT(DISTINCT o.id) as orders_handled,
                    SUM(o.final_amount) as total_revenue,
                    AVG(EXTRACT(EPOCH FROM (o.served_at - o.placed_at))/60) as avg_serve_time_minutes
                 FROM orders o
                 JOIN order_sessions s ON o.session_id = s.id
                 JOIN users u ON s.host_phone = u.phone
                 WHERE o.restaurant_id = $1 
                 AND o.status = 'served'
                 AND o.placed_at >= NOW() - INTERVAL '${parseInt(days)} days'
                 AND u.role = 'waiter'
                 GROUP BY u.name, u.phone
                 ORDER BY orders_handled DESC`,
                [restaurant_id]
            );

            return res.status(200).json({
                success: true,
                data: result.rows.map(row => ({
                    name: row.waiter_name,
                    phone: row.phone,
                    orders: parseInt(row.orders_handled),
                    revenue: parseFloat(row.total_revenue || 0),
                    avg_serve_time: row.avg_serve_time_minutes ? parseFloat(parseFloat(row.avg_serve_time_minutes).toFixed(1)) : 'N/A'
                }))
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // GST REPORT (CA ko dene ke liye)
    // =============================================
    static async getGSTReport(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { month, year } = req.query;

            if (!month || !year) {
                return res.status(400).json({
                    success: false,
                    message: 'month and year are required (e.g., ?month=6&year=2024)'
                });
            }

            const result = await query(
                `SELECT 
                    DATE(o.placed_at) as date,
                    COUNT(*) as total_bills,
                    SUM(o.subtotal) as taxable_value,
                    SUM(o.gst_amount) / 2 as cgst,
                    SUM(o.gst_amount) / 2 as sgst,
                    SUM(o.gst_amount) as total_gst,
                    SUM(o.final_amount) as total_invoice_value
                 FROM orders o
                 WHERE o.restaurant_id = $1 
                 AND o.status != 'cancelled'
                 AND EXTRACT(MONTH FROM o.placed_at) = $2
                 AND EXTRACT(YEAR FROM o.placed_at) = $3
                 GROUP BY DATE(o.placed_at)
                 ORDER BY date ASC`,
                [restaurant_id, parseInt(month), parseInt(year)]
            );

            // Totals
            const totals = result.rows.reduce((acc, row) => ({
                bills: acc.bills + parseInt(row.total_bills),
                taxable: acc.taxable + parseFloat(row.taxable_value),
                cgst: acc.cgst + parseFloat(row.cgst),
                sgst: acc.sgst + parseFloat(row.sgst),
                total_gst: acc.total_gst + parseFloat(row.total_gst),
                invoice: acc.invoice + parseFloat(row.total_invoice_value)
            }), { bills: 0, taxable: 0, cgst: 0, sgst: 0, total_gst: 0, invoice: 0 });

            // Restaurant GST Number
            const restaurant = await query(
                'SELECT name, gst_number FROM restaurants WHERE id = $1',
                [restaurant_id]
            );

            return res.status(200).json({
                success: true,
                data: {
                    restaurant: restaurant.rows[0],
                    period: `${month}/${year}`,
                    daily_breakdown: result.rows.map(row => ({
                        date: row.date,
                        bills: parseInt(row.total_bills),
                        taxable_value: parseFloat(row.taxable_value),
                        cgst: parseFloat(row.cgst),
                        sgst: parseFloat(row.sgst),
                        total_gst: parseFloat(row.total_gst),
                        invoice_value: parseFloat(row.total_invoice_value)
                    })),
                    totals: {
                        total_bills: totals.bills,
                        taxable_value: parseFloat(totals.taxable.toFixed(2)),
                        cgst: parseFloat(totals.cgst.toFixed(2)),
                        sgst: parseFloat(totals.sgst.toFixed(2)),
                        total_gst: parseFloat(totals.total_gst.toFixed(2)),
                        total_invoice_value: parseFloat(totals.invoice.toFixed(2))
                    }
                }
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = ReportController;