const { query, pool } = require('../config/db');
const InventoryController = require('./inventoryController');
const SettingsController = require('./settingsController');
const PrinterService = require('../services/printerService');
const AuditService = require('../services/auditService');
const FulfillmentController = require('./fulfillmentController');

class OrderController {

    // =============================================
    // CUSTOMER: ORDER PLACE KARO
    // =============================================
    static async placeOrder(req, res) {
        try {
            const {
                session_id,
                table_id,
                restaurant_id,
                order_type = 'dine-in',
                payment_mode,
                delivery_address,
                delivery_landmark,
                delivery_charge = 0,
                items,        // Array of items
                notes
            } = req.body;

            const customerPhone = req.user?.phone || req.body.phone;
            const customerName = req.user?.name || req.body.name || 'Customer';

            // Validations
            if (!items || !Array.isArray(items) || items.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'At least one item is required'
                });
            }

            if (!restaurant_id || (order_type === 'dine-in' && !table_id)) {
                return res.status(400).json({
                    success: false,
                    message: 'restaurant_id and a table_id for dine-in are required'
                });
            }
            if (!['dine-in', 'takeaway', 'delivery'].includes(order_type)) {
                return res.status(400).json({ success: false, message: 'Invalid order type' });
            }
            if (order_type === 'delivery' && !delivery_address?.trim()) {
                return res.status(400).json({ success: false, message: 'Delivery address is required' });
            }
            if (order_type !== 'dine-in' && !['prepaid', 'cod'].includes(payment_mode)) {
                return res.status(400).json({ success: false, message: 'A valid payment mode is required' });
            }

            // =============================================
            // TRANSACTION START (Sab kuch ek saath hona chahiye)
            // Agar ek bhi fail ho toh poora rollback
            // =============================================
            const client = await require('../config/db').pool.connect();

            try {
                await client.query('BEGIN');

                // Step 1: Session check karo ya naya banao
                let sessionId = session_id;

                if (!sessionId && order_type === 'dine-in') {
                    // Naya session banao
                    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
                    const sessionResult = await client.query(
                        `INSERT INTO order_sessions (table_id, restaurant_id, host_phone, room_code)
                         VALUES ($1, $2, $3, $4)
                         RETURNING id`,
                        [table_id, restaurant_id, customerPhone, roomCode]
                    );
                    sessionId = sessionResult.rows[0].id;

                    await client.query(
                        `UPDATE tables
                         SET status = 'occupied',
                             occupied_by_phone = $1,
                             room_code = $2,
                             occupied_at = NOW()
                         WHERE id = $3 AND status = 'available'`,
                        [customerPhone, roomCode, table_id]
                    );
                } else if (!sessionId) {
                    const sessionResult = await client.query(
                        `INSERT INTO order_sessions (table_id, restaurant_id, host_phone, status)
                         VALUES (NULL, $1, $2, 'active') RETURNING id`,
                        [restaurant_id, customerPhone]
                    );
                    sessionId = sessionResult.rows[0].id;
                }

                // Step 2: Order create karo
                const orderResult = await client.query(
                    `INSERT INTO orders 
                     (session_id, table_id, restaurant_id, ordered_by_phone, ordered_by_name, order_type, notes)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING *`,
                    [sessionId, table_id || null, restaurant_id, customerPhone, customerName, order_type, notes]
                );

                const order = orderResult.rows[0];
                let subtotal = 0;
                const orderItems = [];

                // Step 3: Har item process karo
                for (const item of items) {
                    // Menu se item ki current price fetch karo
                    const menuItemResult = await client.query(
                        'SELECT * FROM menu_items WHERE id = $1 AND is_available = TRUE',
                        [item.menu_item_id]
                    );

                    if (menuItemResult.rows.length === 0) {
                        throw new Error(`Item ID ${item.menu_item_id} is not available`);
                    }

                    const menuItem = menuItemResult.rows[0];
                    const quantity = item.quantity || 1;
                    let itemTotal = menuItem.price * quantity;
                    const modifiersList = [];

                    // Step 4: Modifiers ka price add karo
                    if (item.modifiers && Array.isArray(item.modifiers)) {
                        for (const modId of item.modifiers) {
                            const modResult = await client.query(
                                'SELECT * FROM modifiers WHERE id = $1',
                                [modId]
                            );

                            if (modResult.rows.length > 0) {
                                const mod = modResult.rows[0];
                                itemTotal += mod.price * quantity;
                                modifiersList.push({
                                    name: mod.name,
                                    price: mod.price
                                });
                            }
                        }
                    }

                    subtotal += itemTotal;

                    // Step 5: Order item insert karo
                    const orderItemResult = await client.query(
                        `INSERT INTO order_items 
                         (order_id, menu_item_id, item_name, quantity, unit_price, total_price, special_instructions)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         RETURNING *`,
                        [
                            order.id,
                            menuItem.id,
                            menuItem.name,
                            quantity,
                            menuItem.price,
                            itemTotal,
                            item.special_instructions || null
                        ]
                    );

                    const orderItem = orderItemResult.rows[0];

                    await InventoryController.deductForOrder(
                        client,
                        restaurant_id,
                        menuItem.id,
                        quantity,
                        order.id
                    );

                    // Step 6: Modifiers ko order_item_modifiers mein save karo
                    for (const mod of modifiersList) {
                        await client.query(
                            `INSERT INTO order_item_modifiers (order_item_id, modifier_name, modifier_price)
                             VALUES ($1, $2, $3)`,
                            [orderItem.id, mod.name, mod.price]
                        );
                    }

                    orderItem.modifiers = modifiersList;
                    orderItems.push(orderItem);
                }

                // Step 7: GST aur Service Charge calculate karo
                const gstRate = 0.05; // 5% GST (2.5% CGST + 2.5% SGST)
                const gstAmount = parseFloat((subtotal * gstRate).toFixed(2));

                // Service charge restaurant se fetch karo
                const restaurantResult = await client.query(
                    'SELECT service_charge_percent FROM restaurants WHERE id = $1',
                    [restaurant_id]
                );
                const serviceChargePercent = parseFloat(restaurantResult.rows[0]?.service_charge_percent || 0) / 100;
                const serviceCharge = parseFloat((subtotal * serviceChargePercent).toFixed(2));

                const deliveryCharge = order_type === 'delivery' ? parseFloat(delivery_charge || 0) : 0;
                const finalAmount = parseFloat((subtotal + gstAmount + serviceCharge + deliveryCharge).toFixed(2));
                const pickupToken = order_type === 'takeaway' ? `TK-${String(order.id).padStart(4, '0')}` : null;

                // Step 8: Order total update karo
                await client.query(
                    `UPDATE orders 
                     SET subtotal = $1, gst_amount = $2, service_charge = $3, final_amount = $4,
                         pickup_token = $5, delivery_address = $6, delivery_landmark = $7, delivery_charge = $8,
                         delivery_status = $9
                     WHERE id = $10`,
                    [subtotal, gstAmount, serviceCharge, finalAmount, pickupToken, delivery_address || null,
                        delivery_landmark || null, deliveryCharge, order_type === 'delivery' ? 'new' : null, order.id]
                );

                if (order_type !== 'dine-in' && payment_mode === 'cod') {
                    await client.query(
                        `INSERT INTO payments
                         (session_id, order_id, restaurant_id, amount, payment_method, status, paid_by_phone)
                         VALUES ($1, $2, $3, $4, 'cash', 'pending', $5)`,
                        [sessionId, order.id, restaurant_id, finalAmount, customerPhone]
                    );
                }

                // COMMIT — Sab kuch successful!
                await client.query('COMMIT');

                // =============================================
                // SOCKET.IO — KITCHEN KO NOTIFY KARO! 🔔
                // =============================================
                try {
                    await PrinterService.enqueueOrder(order.id);
                } catch (printError) {
                    console.error('KOT queue error:', printError.message);
                }
                const io = req.app.get('io');
                if (io) {
                    // Kitchen ko naya order bhejo
                    io.to(`restaurant_${restaurant_id}`).emit('new_order', {
                        order_id: order.id,
                        table_id: table_id,
                        items: orderItems.map(item => ({
                            name: item.item_name,
                            quantity: item.quantity,
                            modifiers: item.modifiers.map(m => m.name),
                            instructions: item.special_instructions
                        })),
                        total_amount: finalAmount,
                        placed_at: order.placed_at,
                        message: `🔔 New Order from Table!`
                    });

                    // Customer ko confirmation bhejo
                    if (table_id) io.to(`table_${table_id}`).emit('order_placed', {
                        order_id: order.id,
                        status: 'placed',
                        message: 'Your order has been placed! Kitchen is preparing...'
                    });
                }

                return res.status(201).json({
                    success: true,
                    message: 'Order placed successfully! 🎉',
                    data: {
                        order_id: order.id,
                        session_id: sessionId,
                        table_id: table_id || null,
                        items: orderItems,
                        order_type,
                        pickup_token: pickupToken,
                        delivery_status: order_type === 'delivery' ? 'new' : null,
                        summary: {
                            subtotal,
                            gst: gstAmount,
                            service_charge: serviceCharge,
                            final_amount: finalAmount
                        },
                        status: 'placed',
                        estimated_time: '15-20 minutes'
                    }
                });

            } catch (transactionError) {
                await client.query('ROLLBACK');
                throw transactionError;
            } finally {
                client.release();
            }

        } catch (error) {
            console.error('Place Order Error:', error.message);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to place order'
            });
        }
    }

    // =============================================
    // CUSTOMER: APNE ORDERS DEKHO (Live Tracking)
    // =============================================
    static async getMyOrders(req, res) {
        try {
            const { session_id } = req.query;
            const phone = req.user?.phone;

            if (!session_id) {
                return res.status(400).json({
                    success: false,
                    message: 'session_id is required'
                });
            }

            // Saare orders fetch karo is session ke
            const ordersResult = await query(
                `SELECT * FROM orders 
                 WHERE session_id = $1 
                 ORDER BY placed_at DESC`,
                [session_id]
            );

            const orders = ordersResult.rows;

            // Har order ke items fetch karo
            for (let order of orders) {
                const itemsResult = await query(
                    `SELECT oi.*, 
                            COALESCE(
                                json_agg(
                                    json_build_object(
                                        'name', oim.modifier_name,
                                        'price', oim.modifier_price
                                    )
                                ) FILTER (WHERE oim.id IS NOT NULL), 
                                '[]'
                            ) as modifiers
                     FROM order_items oi
                     LEFT JOIN order_item_modifiers oim ON oi.id = oim.order_item_id
                     WHERE oi.order_id = $1
                     GROUP BY oi.id
                     ORDER BY oi.id ASC`,
                    [order.id]
                );
                order.items = itemsResult.rows;
            }

            return res.status(200).json({
                success: true,
                data: orders
            });

        } catch (error) {
            console.error('Get my orders error:', error.message);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // CUSTOMER: ORDER CANCEL KARO
    // (Sirf tab jab kitchen ne accept nahi kiya)
    // =============================================
    static async cancelOrder(req, res) {
        return OrderController.cancelOrderWithPolicy(req, res, 'customer');
    }

    static async cancelOrderManually(req, res) {
        return OrderController.cancelOrderWithPolicy(req, res, 'staff');
    }

    static async cancelOrderItem(req, res) {
        const source = req.user.role === 'customer' ? 'customer' : 'staff';
        const client = await pool.connect();
        try {
            const { order_id, item_id } = req.params;
            const reason = req.body?.reason?.trim() || 'Item cancellation';
            await client.query('BEGIN');
            const orderResult = await client.query(`SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`, [order_id, req.user.restaurant_id]);
            const order = orderResult.rows[0];
            if (!order) throw new Error('Order not found');
            if (source === 'customer' && order.ordered_by_phone !== req.user.phone) throw new Error('You can only cancel your own order item');
            const settings = await SettingsController.getOrderSettings(order.restaurant_id);
            if (source === 'customer' && !(settings.kitchen_mode === 'kds' && settings.customer_self_cancel)) throw new Error('Customer cancellation is disabled. Please ask the waiter.');
            const allowed = settings.allow_cancel_after_accepted ? ['placed', 'accepted'] : ['placed'];
            if (!allowed.includes(order.status)) throw new Error(`Cancellation is unavailable because order is ${order.status}`);
            const itemResult = await client.query(`SELECT * FROM order_items WHERE id = $1 AND order_id = $2 AND status != 'cancelled' FOR UPDATE`, [item_id, order_id]);
            const item = itemResult.rows[0];
            if (!item) throw new Error('Active order item not found');
            await client.query(`UPDATE order_items SET status = 'cancelled' WHERE id = $1`, [item.id]);
            await InventoryController.restoreForOrder(client, order.restaurant_id, item.menu_item_id, item.quantity, order.id);
            const totalResult = await client.query(`SELECT COALESCE(SUM(total_price), 0) AS subtotal FROM order_items WHERE order_id = $1 AND status != 'cancelled'`, [order.id]);
            const subtotal = parseFloat(totalResult.rows[0].subtotal);
            const restaurantResult = await client.query(`SELECT service_charge_percent FROM restaurants WHERE id = $1`, [order.restaurant_id]);
            const gst = parseFloat((subtotal * 0.05).toFixed(2));
            const service = parseFloat((subtotal * (parseFloat(restaurantResult.rows[0]?.service_charge_percent || 0) / 100)).toFixed(2));
            const discount = Math.min(parseFloat(order.discount_amount || 0), subtotal);
            const finalAmount = parseFloat(Math.max(0, subtotal + gst + service - discount).toFixed(2));
            await client.query(`UPDATE orders SET subtotal = $1, gst_amount = $2, service_charge = $3, discount_amount = $4, final_amount = $5 WHERE id = $6`, [subtotal, gst, service, discount, finalAmount, order.id]);
            await client.query('COMMIT');
            if (settings.kitchen_mode === 'printer_only' && settings.print_cancelled_kot) await PrinterService.enqueueCancellation(order.id, `${item.item_name}: ${reason}`);
            await AuditService.log({ restaurantId: order.restaurant_id, actor: req.user, action: 'order_item_cancelled', entityType: 'order_item', entityId: item.id, details: { order_id: order.id, reason, source } });
            const io = req.app.get('io');
            if (io) io.to(`table_${order.table_id}`).emit('order_item_cancelled', { order_id: order.id, item_id: item.id, message: `${item.item_name} cancelled` });
            return res.json({ success: true, message: 'Item cancelled successfully', data: { order_id: order.id, item_id: item.id, final_amount: finalAmount } });
        } catch (error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: error.message || 'Item cancellation failed' });
        } finally { client.release(); }
    }

    static async cancelOrderWithPolicy(req, res, source) {
        const client = await pool.connect();
        try {
            const { order_id } = req.params;
            const reason = req.body?.reason?.trim() || (source === 'staff' ? 'Cancelled after kitchen confirmation' : 'Customer cancellation');

            await client.query('BEGIN');
            const orderResult = await client.query(
                'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
                [order_id, req.user.restaurant_id]
            );

            if (orderResult.rows.length === 0) {
                throw new Error('Order not found');
            }

            const order = orderResult.rows[0];
            if (source === 'customer' && order.ordered_by_phone !== req.user.phone) {
                throw new Error('You can only cancel your own order');
            }

            const settings = await SettingsController.getOrderSettings(order.restaurant_id);
            const customerCanCancel = settings.kitchen_mode === 'kds' && settings.customer_self_cancel === true;
            const allowedStatuses = settings.allow_cancel_after_accepted ? ['placed', 'accepted'] : ['placed'];

            if (source === 'customer' && !customerCanCancel) {
                throw new Error('Customer cancellation is disabled. Please ask the waiter.');
            }
            if (!allowedStatuses.includes(order.status)) throw new Error(`Cancellation is unavailable because order is ${order.status}`);

            await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order_id]);
            await client.query(`UPDATE order_items SET status = 'cancelled' WHERE order_id = $1`, [order_id]);
            await client.query('COMMIT');

            if (settings.kitchen_mode === 'printer_only' && settings.print_cancelled_kot) {
                try {
                    await PrinterService.enqueueCancellation(order.id, reason);
                } catch (printError) {
                    console.error('Cancelled KOT queue error:', printError.message);
                }
            }
            await AuditService.log({ restaurantId: order.restaurant_id, actor: req.user, action: source === 'staff' ? 'order_cancelled_by_waiter' : 'order_cancelled_by_customer', entityType: 'order', entityId: order.id, details: { reason, prior_status: order.status } });

            // Socket.io notify
            const io = req.app.get('io');
            if (io) {
                io.to(`restaurant_${order.restaurant_id}`).emit('order_cancelled', {
                    order_id: order.id,
                    table_id: order.table_id,
                    message: `Order #${order.id} cancelled`
                });
                io.to(`table_${order.table_id}`).emit('order_status_update', { order_id: order.id, status: 'cancelled', message: 'Order cancelled' });
            }

            return res.status(200).json({
                success: true,
                message: 'Order cancelled successfully',
                data: { order_id: order.id, cancellation_source: source }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: error.message || 'Cancellation failed' });
        } finally {
            client.release();
        }
    }

    // =============================================
    // KITCHEN: SAARE LIVE ORDERS DEKHO (KDS)
    // =============================================
    static async getKitchenOrders(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { status, include_served } = req.query; // Filter by status

            const params = [restaurant_id];
            let statusFilter = include_served === 'true'
                ? `AND o.status IN ('pending', 'placed', 'accepted', 'preparing', 'ready', 'served', 'cancelled')`
                : `AND o.status IN ('pending', 'placed', 'accepted', 'preparing', 'ready', 'cancelled')`;

            if (status) {
                params.push(status);
                statusFilter = `AND o.status = $${params.length}`;
            }

            const ordersResult = await query(
                `SELECT o.id,
                        COALESCE(o.session_id, 0) AS session_id,
                        COALESCE(o.table_id, 0) AS table_id,
                        o.restaurant_id,
                        o.ordered_by_phone,
                        o.ordered_by_name,
                        o.order_type,
                        o.status,
                        COALESCE(o.subtotal, 0) AS subtotal,
                        COALESCE(o.gst_amount, 0) AS gst_amount,
                        COALESCE(o.service_charge, 0) AS service_charge,
                        COALESCE(o.discount_amount, 0) AS discount_amount,
                        COALESCE(o.final_amount, 0) AS final_amount,
                        o.notes,
                        o.placed_at,
                        o.accepted_at,
                        o.served_at,
                        COALESCE(t.table_number, CASE WHEN o.order_type = 'dine-in' THEN 'T?' ELSE UPPER(o.order_type) END) AS table_number,
                        FLOOR(EXTRACT(EPOCH FROM (NOW() - o.placed_at)) / 60)::INT AS minutes_ago
                 FROM orders o
                 LEFT JOIN tables t ON o.table_id = t.id
                 WHERE o.restaurant_id = $1 ${statusFilter}
                 ORDER BY o.placed_at ASC`,
                params
            );

            const orders = ordersResult.rows;

            // Har order ke items
            for (let order of orders) {
                const itemsResult = await query(
                    `SELECT oi.*, c.name AS category_name,
                            COALESCE(
                                json_agg(
                                    json_build_object(
                                        'name', oim.modifier_name,
                                        'price', oim.modifier_price
                                    )
                                ) FILTER (WHERE oim.id IS NOT NULL), 
                                '[]'
                            ) as modifiers
                     FROM order_items oi
                     LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
                     LEFT JOIN categories c ON mi.category_id = c.id
                     LEFT JOIN order_item_modifiers oim ON oi.id = oim.order_item_id
                     WHERE oi.order_id = $1 AND oi.status != 'cancelled'
                     GROUP BY oi.id, c.name`,
                    [order.id]
                );
                order.items = itemsResult.rows;
                order.section = OrderController.getSectionForItems(itemsResult.rows);
            }

            return res.status(200).json({
                success: true,
                data: {
                    total_active: orders.length,
                    orders: orders
                }
            });

        } catch (error) {
            console.error('Get kitchen orders error:', error.message);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static getSectionForItems(items) {
        const categories = items.map(item => item.category_name).filter(Boolean);
        if (categories.some(name => ['Drinks'].includes(name))) return 'Bar';
        if (categories.some(name => ['Breads', 'Starters'].includes(name))) return 'Tandoor';
        if (categories.some(name => ['Rice & Biryani', 'Main Course'].includes(name))) return 'Main Kitchen';
        return 'Main Kitchen';
    }

    // =============================================
    // KITCHEN: ORDER STATUS UPDATE KARO
    // placed → accepted → preparing → ready → served
    // =============================================
    static async updateOrderStatus(req, res) {
        try {
            const { order_id } = req.params;
            const { status } = req.body;

            const validStatuses = ['placed', 'accepted', 'preparing', 'ready', 'served', 'cancelled'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
                });
            }

            // Order fetch karo
            const orderResult = await query(
                'SELECT * FROM orders WHERE id = $1',
                [order_id]
            );

            if (orderResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Order not found' });
            }

            const order = orderResult.rows[0];

            // Status update karo
            const updateFields = { status };
            if (status === 'accepted') updateFields.accepted_at = new Date();
            if (status === 'served') updateFields.served_at = new Date();

            await query(
                `UPDATE orders 
                 SET status = $1, 
                     accepted_at = COALESCE($2, accepted_at),
                     served_at = COALESCE($3, served_at)
                 WHERE id = $4`,
                [status, updateFields.accepted_at || null, updateFields.served_at || null, order_id]
            );

            // Agar "served" hai, toh saare items bhi served mark karo
            if (status === 'served') {
                await query(
                    `UPDATE order_items SET status = 'served' WHERE order_id = $1`,
                    [order_id]
                );
            }

            // =============================================
            // SOCKET.IO — REAL-TIME UPDATE BHEJO!
            // =============================================
            const io = req.app.get('io');
            if (io) {
                const statusMessages = {
                    'accepted': '👨‍🍳 Kitchen ne order accept kar liya!',
                    'preparing': '🔥 Khana ban raha hai...',
                    'ready': '🍽️ Khana ready hai! Waiter laane wala hai.',
                    'served': '✅ Order serve ho gaya! Enjoy your meal!'
                };

                // Customer ko update bhejo
                io.to(`table_${order.table_id}`).emit('order_status_update', {
                    order_id: order.id,
                    status: status,
                    message: statusMessages[status] || `Status: ${status}`
                });

                // Kitchen dashboard ko bhi update bhejo
                io.to(`restaurant_${order.restaurant_id}`).emit('kitchen_order_update', {
                    order_id: order.id,
                    status: status
                });
            }

            return res.status(200).json({
                success: true,
                message: `Order #${order_id} status updated to "${status}"`,
                data: { order_id, status }
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // WAITER: TABLE KA BILL GENERATE KARO
    // =============================================
    static async generateBill(req, res) {
        try {
            const { session_id } = req.params;

            // Session ke saare orders fetch karo
            const ordersResult = await query(
                `SELECT * FROM orders 
                 WHERE session_id = $1 AND status != 'cancelled'
                 ORDER BY placed_at ASC`,
                [session_id]
            );

            if (ordersResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No orders found for this session'
                });
            }

            let totalSubtotal = 0;
            let totalGST = 0;
            let totalServiceCharge = 0;
            let totalFinal = 0;
            const allItems = [];
            const billOrders = [];

            for (let order of ordersResult.rows) {
                const itemsResult = await query(
                    `SELECT oi.id, oi.item_name, oi.quantity, oi.unit_price, oi.total_price,
                            COALESCE(
                                json_agg(oim.modifier_name) FILTER (WHERE oim.id IS NOT NULL),
                                '[]'
                            ) as modifiers
                     FROM order_items oi
                     LEFT JOIN order_item_modifiers oim ON oi.id = oim.order_item_id
                     WHERE oi.order_id = $1 AND oi.status != 'cancelled'
                     GROUP BY oi.id`,
                    [order.id]
                );

                const orderItems = itemsResult.rows.map(item => ({
                    ...item,
                    order_id: order.id,
                    customer_name: order.ordered_by_name || 'Customer',
                    customer_phone: order.ordered_by_phone || ''
                }));
                allItems.push(...orderItems);
                billOrders.push({
                    order_id: order.id,
                    customer_name: order.ordered_by_name || 'Customer',
                    customer_phone: order.ordered_by_phone || '',
                    placed_at: order.placed_at,
                    items: orderItems
                });
                totalSubtotal += parseFloat(order.subtotal);
                totalGST += parseFloat(order.gst_amount);
                totalServiceCharge += parseFloat(order.service_charge);
                totalFinal += parseFloat(order.final_amount);
            }

            // Table info
            const sessionResult = await query(
                `SELECT s.*, t.table_number, r.name AS restaurant_name
                 FROM order_sessions s
                 JOIN tables t ON s.table_id = t.id
                 JOIN restaurants r ON r.id = s.restaurant_id
                 WHERE s.id = $1`,
                [session_id]
            );

            const paidResult = await query(
                `SELECT COALESCE(SUM(amount), 0) AS paid_amount
                 FROM payments WHERE session_id = $1 AND status = 'success'`,
                [session_id]
            );
            const paidAmount = parseFloat(paidResult.rows[0].paid_amount || 0);

            const bill = {
                session_id: parseInt(session_id),
                table_number: sessionResult.rows[0]?.table_number,
                restaurant_name: sessionResult.rows[0]?.restaurant_name,
                host_phone: sessionResult.rows[0]?.host_phone,
                orders: billOrders,
                items: allItems,
                summary: {
                    subtotal: parseFloat(totalSubtotal.toFixed(2)),
                    cgst: parseFloat((totalGST / 2).toFixed(2)),
                    sgst: parseFloat((totalGST / 2).toFixed(2)),
                    total_gst: parseFloat(totalGST.toFixed(2)),
                    service_charge: parseFloat(totalServiceCharge.toFixed(2)),
                    final_amount: parseFloat(totalFinal.toFixed(2)),
                    paid_amount: parseFloat(paidAmount.toFixed(2)),
                    outstanding_amount: parseFloat(Math.max(0, totalFinal - paidAmount).toFixed(2))
                },
                generated_at: new Date().toISOString()
            };

            // Socket.io se customer ko bill bhejo
            const io = req.app.get('io');
            if (io && sessionResult.rows[0]) {
                io.to(`table_${sessionResult.rows[0].table_id}`).emit('bill_generated', {
                    bill: bill,
                    message: '🧾 Your bill is ready! Please proceed to payment.'
                });
            }

            return res.status(200).json({
                success: true,
                data: bill
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // ADMIN: SAARE ORDERS (Reports ke liye)
    // =============================================
    static async getAllOrders(req, res) {
        try {
            const restaurant_id = req.user.restaurant_id;
            const { date, status, order_id, page = 1, limit = 20 } = req.query;

            let whereClause = `WHERE o.restaurant_id = $1`;
            const params = [restaurant_id];
            let paramIndex = 2;

            if (date) {
                whereClause += ` AND DATE(o.placed_at) = $${paramIndex}`;
                params.push(date);
                paramIndex++;
            }

            if (status) {
                whereClause += ` AND o.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (order_id) {
                whereClause += ` AND o.id = $${paramIndex}`;
                params.push(order_id);
                paramIndex++;
            }

            const offset = (page - 1) * limit;

            const countResult = await query(
                `SELECT COUNT(*) FROM orders o ${whereClause}`,
                params
            );

            const ordersResult = await query(
                `SELECT o.*, COALESCE(t.table_number, UPPER(o.order_type)) AS table_number,
                        payment.payment_method, payment.status AS payment_status
                 FROM orders o
                 LEFT JOIN tables t ON o.table_id = t.id
                 LEFT JOIN LATERAL (
                     SELECT p.payment_method, p.status
                     FROM payments p
                     WHERE p.order_id = o.id
                        OR (p.order_id IS NULL AND p.session_id = o.session_id)
                     ORDER BY (p.order_id = o.id) DESC, p.created_at DESC, p.id DESC
                     LIMIT 1
                 ) payment ON TRUE
                 ${whereClause}
                 ORDER BY o.placed_at DESC
                 LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
                [...params, limit, offset]
            );

            return res.status(200).json({
                success: true,
                data: {
                    total: parseInt(countResult.rows[0].count),
                    page: parseInt(page),
                    orders: ordersResult.rows
                }
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = OrderController;