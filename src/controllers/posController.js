const { pool, query } = require('../config/db');
const InventoryController = require('./inventoryController');
const DiscountController = require('./discountController');
const AuditService = require('../services/auditService');
const LoyaltyService = require('../services/loyaltyService');
const PrinterService = require('../services/printerService');
const FulfillmentController = require('./fulfillmentController');

class POSController {
    static async createOrder(req, res) {
        const client = await pool.connect();

        try {
            const restaurant_id = req.user.restaurant_id;
            const {
                table_id,
                order_type = 'dine-in',
                customer_phone,
                customer_name,
                notes,
                discount_amount = 0,
                coupon_code,
                manager_pin,
                loyalty_points_to_redeem = 0,
                delivery_address,
                delivery_landmark,
                delivery_charge = 0,
                items
            } = req.body;

            if (!items || !Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ success: false, message: 'At least one item is required' });
            }

            if (order_type === 'dine-in' && !table_id) {
                return res.status(400).json({ success: false, message: 'table_id is required for dine-in POS order' });
            }
            if (order_type === 'delivery' && !delivery_address?.trim()) {
                return res.status(400).json({ success: false, message: 'Delivery address is required' });
            }

            await client.query('BEGIN');

            let sessionId = null;
            let tableNumber = order_type === 'takeaway' ? 'TAKEAWAY' : null;

            if (table_id) {
                const tableResult = await client.query(
                    'SELECT * FROM tables WHERE id = $1 AND restaurant_id = $2',
                    [table_id, restaurant_id]
                );

                if (tableResult.rows.length === 0) {
                    throw new Error('Table not found');
                }

                const table = tableResult.rows[0];
                tableNumber = table.table_number;

                const existingSession = await client.query(
                    `SELECT id FROM order_sessions
                     WHERE table_id = $1 AND restaurant_id = $2 AND status = 'active'
                     ORDER BY started_at DESC LIMIT 1`,
                    [table_id, restaurant_id]
                );

                if (existingSession.rows.length > 0) {
                    sessionId = existingSession.rows[0].id;
                } else {
                    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
                    const sessionResult = await client.query(
                        `INSERT INTO order_sessions (table_id, restaurant_id, host_phone, room_code)
                         VALUES ($1, $2, $3, $4)
                         RETURNING id`,
                        [table_id, restaurant_id, customer_phone || req.user.phone || 'pos', roomCode]
                    );
                    sessionId = sessionResult.rows[0].id;

                    await client.query(
                        `UPDATE tables
                         SET status = 'occupied', occupied_by_phone = $1, room_code = $2, occupied_at = NOW()
                         WHERE id = $3`,
                        [customer_phone || req.user.phone || 'pos', roomCode, table_id]
                    );
                }
            } else {
                const sessionResult = await client.query(
                    `INSERT INTO order_sessions (table_id, restaurant_id, host_phone, status)
                     VALUES (NULL, $1, $2, 'active')
                     RETURNING id`,
                    [restaurant_id, customer_phone || req.user.phone || 'pos']
                );
                sessionId = sessionResult.rows[0].id;
            }

            const orderResult = await client.query(
                `INSERT INTO orders
                 (session_id, table_id, restaurant_id, waiter_id, ordered_by_phone, ordered_by_name, order_type, notes, discount_amount)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [
                    sessionId,
                    table_id || null,
                    restaurant_id,
                    req.user?.role === 'waiter' ? req.user.id : null,
                    customer_phone || req.user.phone || 'pos',
                    customer_name || 'Counter Customer',
                    order_type,
                    notes || null,
                    discount_amount || 0
                ]
            );

            const order = orderResult.rows[0];
            let subtotal = 0;
            const orderItems = [];

            for (const item of items) {
                const menuItemResult = await client.query(
                    'SELECT * FROM menu_items WHERE id = $1 AND restaurant_id = $2 AND is_available = TRUE',
                    [item.menu_item_id, restaurant_id]
                );

                if (menuItemResult.rows.length === 0) {
                    throw new Error(`Item ID ${item.menu_item_id} is not available`);
                }

                const menuItem = menuItemResult.rows[0];
                const quantity = item.quantity || 1;
                const itemTotal = parseFloat(menuItem.price) * quantity;
                subtotal += itemTotal;

                const orderItemResult = await client.query(
                    `INSERT INTO order_items
                     (order_id, menu_item_id, item_name, quantity, unit_price, total_price, special_instructions)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING *`,
                    [order.id, menuItem.id, menuItem.name, quantity, menuItem.price, itemTotal, item.special_instructions || null]
                );
                await InventoryController.deductForOrder(
                    client,
                    restaurant_id,
                    menuItem.id,
                    quantity,
                    order.id
                );
                orderItems.push(orderItemResult.rows[0]);
            }

            const restaurantResult = await client.query(
                'SELECT service_charge_percent FROM restaurants WHERE id = $1',
                [restaurant_id]
            );
            const gstAmount = parseFloat((subtotal * 0.05).toFixed(2));
            const serviceChargePercent = parseFloat(restaurantResult.rows[0]?.service_charge_percent || 0) / 100;
            const serviceCharge = parseFloat((subtotal * serviceChargePercent).toFixed(2));
            const resolvedDiscount = await DiscountController.resolveDiscount(client, restaurant_id, subtotal, { couponCode: coupon_code, managerPin: manager_pin, requestedDiscount: discount_amount });
            const redemption = await LoyaltyService.redeemForOrder(client, restaurant_id, customer_phone, loyalty_points_to_redeem, order.id);
            const discount = Math.min(subtotal, resolvedDiscount.amount + redemption.amount);
            const deliveryCharge = order_type === 'delivery' ? parseFloat(delivery_charge || 0) : 0;
            const finalAmount = parseFloat((subtotal + gstAmount + serviceCharge + deliveryCharge - discount).toFixed(2));
            const pickupToken = order_type === 'takeaway' ? `TK-${String(order.id).padStart(4, '0')}` : null;

            await client.query(
                `UPDATE orders
                 SET subtotal = $1, gst_amount = $2, service_charge = $3, discount_amount = $4, final_amount = $5,
                     pickup_token = $6, delivery_address = $7, delivery_landmark = $8, delivery_charge = $9,
                     delivery_status = $10
                 WHERE id = $11`,
                [subtotal, gstAmount, serviceCharge, discount, finalAmount, pickupToken, delivery_address || null,
                    delivery_landmark || null, deliveryCharge, order_type === 'delivery' ? 'new' : null, order.id]
            );

            await client.query('COMMIT');

            try {
                await PrinterService.enqueueOrder(order.id);
            } catch (printError) {
                console.error('KOT queue error:', printError.message);
            }

            if (resolvedDiscount.amount > 0) {
                await AuditService.log({ restaurantId: restaurant_id, actor: req.user, action: 'discount_applied', entityType: 'order', entityId: order.id, details: { amount: resolvedDiscount.amount, source: resolvedDiscount.source, reference: resolvedDiscount.reference } });
            }
            if (redemption.points > 0) {
                await AuditService.log({ restaurantId: restaurant_id, actor: req.user, action: 'loyalty_points_redeemed', entityType: 'order', entityId: order.id, details: { points: redemption.points, amount: redemption.amount, customer_phone } });
            }

            const io = req.app.get('io');
            if (io) {
                io.to(`restaurant_${restaurant_id}`).emit('new_order', {
                    order_id: order.id,
                    table_id: table_id || null,
                    table_number: tableNumber,
                    total_amount: finalAmount,
                    placed_at: order.placed_at,
                    message: `🔔 New POS Order ${tableNumber ? `from ${tableNumber}` : ''}`
                });
                if (table_id) {
                    io.to(`restaurant_${restaurant_id}`).emit('table_status_changed', {
                        table_id,
                        status: 'occupied'
                    });
                }
            }

            return res.status(201).json({
                success: true,
                message: 'POS order placed successfully',
                data: {
                    order_id: order.id,
                    session_id: sessionId,
                    table_id: table_id || null,
                    table_number: tableNumber,
                    items: orderItems,
                    summary: {
                        subtotal,
                        gst: gstAmount,
                        service_charge: serviceCharge,
                        discount,
                        final_amount: finalAmount
                    }
                }
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('POS order error:', error);
            return res.status(500).json({ success: false, message: error.message || 'Server error' });
        } finally {
            client.release();
        }
    }

    static async getKot(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { order_id } = req.params;
            const data = await POSController.getPrintableOrder(order_id, restaurant_id);
            return res.status(200).json({ success: true, data: { type: 'KOT', ...data } });
        } catch (error) {
            console.error('KOT error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getBill(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { order_id } = req.params;
            const data = await POSController.getPrintableOrder(order_id, restaurant_id);
            const sessionId = data.order.session_id;
            if (sessionId) {
                const [itemsResult, summaryResult] = await Promise.all([
                    query(
                        `SELECT oi.item_name, SUM(oi.quantity)::int AS quantity, oi.unit_price,
                                SUM(oi.total_price) AS total_price
                         FROM order_items oi
                         JOIN orders o ON o.id = oi.order_id
                         WHERE o.session_id = $1 AND o.restaurant_id = $2
                           AND o.status != 'cancelled' AND oi.status != 'cancelled'
                         GROUP BY oi.item_name, oi.unit_price
                         ORDER BY MIN(oi.id)`,
                        [sessionId, restaurant_id]
                    ),
                    query(
                        `SELECT MIN(placed_at) AS placed_at,
                                COALESCE(SUM(subtotal), 0) AS subtotal,
                                COALESCE(SUM(gst_amount), 0) AS gst,
                                COALESCE(SUM(service_charge), 0) AS service_charge,
                                COALESCE(SUM(discount_amount), 0) AS discount,
                                COALESCE(SUM(final_amount), 0) AS final_amount
                         FROM orders
                         WHERE session_id = $1 AND restaurant_id = $2 AND status != 'cancelled'`,
                        [sessionId, restaurant_id]
                    )
                ]);
                const sessionSummary = summaryResult.rows[0];
                data.items = itemsResult.rows;
                data.order.placed_at = sessionSummary.placed_at;
                data.summary = Object.fromEntries(
                    Object.entries(sessionSummary).map(([key, value]) => [
                        key,
                        key === 'placed_at' ? value : parseFloat(value)
                    ])
                );
            }
            return res.status(200).json({ success: true, data: { type: 'BILL', ...data } });
        } catch (error) {
            console.error('POS bill error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getPrintableOrder(orderId, restaurantId) {
        const orderResult = await query(
            `SELECT o.*, r.name AS restaurant_name, r.address, r.phone AS restaurant_phone, r.gst_number, t.table_number
             FROM orders o
             JOIN restaurants r ON o.restaurant_id = r.id
             LEFT JOIN tables t ON o.table_id = t.id
             WHERE o.id = $1 AND o.restaurant_id = $2`,
            [orderId, restaurantId]
        );

        if (orderResult.rows.length === 0) {
            throw new Error('Order not found');
        }

        const order = orderResult.rows[0];
        const itemsResult = await query(
            `SELECT item_name, quantity, unit_price, total_price, special_instructions
             FROM order_items
             WHERE order_id = $1 AND status != 'cancelled'
             ORDER BY id ASC`,
            [orderId]
        );

        return {
            order: {
                id: order.id,
                session_id: order.session_id,
                order_type: order.order_type,
                status: order.status,
                table_number: order.table_number || 'TAKEAWAY',
                customer_name: order.ordered_by_name,
                customer_phone: order.ordered_by_phone,
                placed_at: order.placed_at,
                notes: order.notes
            },
            restaurant: {
                name: order.restaurant_name,
                address: order.address,
                phone: order.restaurant_phone,
                gst_number: order.gst_number
            },
            items: itemsResult.rows,
            summary: {
                subtotal: parseFloat(order.subtotal),
                gst: parseFloat(order.gst_amount),
                service_charge: parseFloat(order.service_charge),
                discount: parseFloat(order.discount_amount),
                final_amount: parseFloat(order.final_amount)
            }
        };
    }
}

module.exports = POSController;
