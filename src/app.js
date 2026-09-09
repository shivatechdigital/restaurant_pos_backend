const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

// Routes import
const authRoutes = require('./routes/authRoutes');
const tableRoutes = require('./routes/tableRoutes');
const menuRoutes = require('./routes/menuRoutes');
const orderRoutes = require('./routes/orderRoutes');
const paymentRoutes = require('./routes/paymentRoutes');      // ← NAYA
const reportRoutes = require('./routes/reportRoutes');         // ← NAYA
const kitchenRoutes = require('./routes/kitchenRoutes');
const waiterRoutes = require('./routes/waiterRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const posRoutes = require('./routes/posRoutes');
const staffRoutes = require('./routes/staffRoutes');
const discountRoutes = require('./routes/discountRoutes');
const customerRoutes = require('./routes/customerRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const printerRoutes = require('./routes/printerRoutes');
const fulfillmentRoutes = require('./routes/fulfillmentRoutes');
const InventoryController = require('./controllers/inventoryController');
const DiscountController = require('./controllers/discountController');
const FulfillmentController = require('./controllers/fulfillmentController');
const SettingsController = require('./controllers/settingsController');
const PrinterService = require('./services/printerService');
const LoyaltyService = require('./services/loyaltyService');
const AuditService = require('./services/auditService');
const RoleService = require('./services/roleService');

// Services import
const TableAutoReleaseService = require('./services/tableAutoRelease');  // ← NAYA

const app = express();
const server = http.createServer(app);

// =============================================
// SOCKET.IO SETUP
// =============================================
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);

    socket.on('join_restaurant', (restaurant_id) => {
        socket.join(`restaurant_${restaurant_id}`);
    });

    socket.on('join_table', (table_id) => {
        socket.join(`table_${table_id}`);
    });

    socket.on('leave_table', (table_id) => {
        socket.leave(`table_${table_id}`);
    });

    socket.on('accept_order', (data) => {
        io.to(`restaurant_${data.restaurant_id}`).emit('order_status_update', {
            order_id: data.order_id, status: 'accepted'
        });
    });

    socket.on('mark_ready', (data) => {
        io.to(`restaurant_${data.restaurant_id}`).emit('order_status_update', {
            order_id: data.order_id, status: 'ready'
        });
    });

    socket.on('mark_served', (data) => {
        io.to(`restaurant_${data.restaurant_id}`).emit('order_status_update', {
            order_id: data.order_id, status: 'served'
        });
    });

    socket.on('call_waiter', (data) => {
        io.to(`restaurant_${data.restaurant_id}`).emit('waiter_called', {
            table_number: data.table_number
        });
    });

    // Waiter table clean kare
    socket.on('mark_table_clean', async (data) => {
        try {
            const { query } = require('./config/db');
            await query(
                `UPDATE tables SET status = 'available', occupied_at = NULL WHERE id = $1`,
                [data.table_id]
            );
            io.to(`restaurant_${data.restaurant_id}`).emit('table_status_changed', {
                table_id: data.table_id, status: 'available'
            });
        } catch (err) {
            console.error('Clean table error:', err);
        }
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Disconnected: ${socket.id}`);
    });
});

app.set('io', io);

// GET requests par 304 Not Modified (empty body) na aaye, isliye ETag off
app.disable('etag');

// =============================================
// MIDDLEWARE
// =============================================
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

// ⚠️ IMPORTANT: Webhook ke liye raw body chahiye (Razorpay signature verify)
// Isliye webhook route ko express.json() se PEHLE rako
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Uploaded menu item images publicly serve karo (cross-origin taaki Flutter web app load kar sake)
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), {
    setHeaders: (res) => res.set('Cross-Origin-Resource-Policy', 'cross-origin')
}));

// Browser bhi API responses ko cache na kare (304/stale data se bachne ke liye)
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// =============================================
// ROUTES
// =============================================
app.use('/api/auth', authRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);     // ← NAYA
app.use('/api/reports', reportRoutes);       // ← NAYA
app.use('/api/kitchen', kitchenRoutes);
app.use('/api/waiter', waiterRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/discounts', discountRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/printer', printerRoutes);
app.use('/api/fulfillment', fulfillmentRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: '🚀 Restaurant POS API is running!',
        timestamp: new Date().toISOString(),
        features: ['Auth', 'Tables', 'Menu', 'Orders', 'Payments', 'Reports', 'Socket.io', 'Auto-Release']
    });
});

app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
    console.error('❌ Error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
});

// =============================================
// START SERVER + CRON JOBS
// =============================================
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await InventoryController.ensureTable();
        await DiscountController.ensureTable();
        await FulfillmentController.ensureTables();
        await SettingsController.ensureTable();
        await PrinterService.ensureTable();
        await LoyaltyService.ensureTables();
        await AuditService.ensureTable();
        await RoleService.ensureReceptionRole();
    } catch (error) {
        console.error('❌ Database extension setup failed:', error.message);
        process.exit(1);
    }

    server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Socket.io ready`);
    console.log(`💳 Razorpay ${process.env.RAZORPAY_KEY_ID ? 'configured ✅' : 'NOT configured ❌'}`);
    console.log(`🏥 Health: http://localhost:${PORT}/api/health\n`);

    // Cron Jobs start karo
    TableAutoReleaseService.start();
    });
}

startServer();