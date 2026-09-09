const { pool } = require('./db');

const createTables = async () => {
    try {
        console.log('🔧 Creating database tables...');

        await pool.query(`
            -- =============================================
            -- 1. RESTAURANTS
            -- =============================================
            CREATE TABLE IF NOT EXISTS restaurants (
                id SERIAL PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                address TEXT,
                phone VARCHAR(15) UNIQUE,
                gst_number VARCHAR(20),
                service_charge_percent DECIMAL(5,2) DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );

            -- =============================================
            -- 2. USERS (Admin, Waiter, Kitchen Staff)
            -- =============================================
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(15) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'waiter', 'kitchen', 'reception')),
                restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            -- =============================================
            -- 3. TABLES (Physical tables in restaurant)
            -- =============================================
            CREATE TABLE IF NOT EXISTS tables (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                table_number VARCHAR(10) NOT NULL,
                qr_code_url VARCHAR(500),
                capacity INT DEFAULT 4,
                status VARCHAR(20) DEFAULT 'available' 
                    CHECK (status IN ('available', 'occupied', 'reserved', 'cleaning')),
                occupied_by_phone VARCHAR(15),
                room_code VARCHAR(6),
                occupied_at TIMESTAMPTZ,
                auto_release_at TIMESTAMPTZ
            );

            -- =============================================
            -- 4. CATEGORIES (Menu categories)
            -- =============================================
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                display_order INT DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE
            );

            -- =============================================
            -- 5. MENU ITEMS
            -- =============================================
            CREATE TABLE IF NOT EXISTS menu_items (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                category_id INT REFERENCES categories(id) ON DELETE SET NULL,
                name VARCHAR(200) NOT NULL,
                description TEXT,
                price DECIMAL(10,2) NOT NULL,
                image_url VARCHAR(500),
                is_veg BOOLEAN DEFAULT TRUE,
                is_available BOOLEAN DEFAULT TRUE,
                prep_time_minutes INT DEFAULT 10,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            -- =============================================
            -- 6. MODIFIERS (Extra Cheese, No Onion, etc.)
            -- =============================================
            CREATE TABLE IF NOT EXISTS modifiers (
                id SERIAL PRIMARY KEY,
                menu_item_id INT REFERENCES menu_items(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                price DECIMAL(10,2) DEFAULT 0,
                is_default BOOLEAN DEFAULT FALSE
            );

            -- =============================================
            -- 7. ORDER SESSIONS (Ek table visit = ek session)
            -- =============================================
            CREATE TABLE IF NOT EXISTS order_sessions (
                id SERIAL PRIMARY KEY,
                table_id INT REFERENCES tables(id),
                restaurant_id INT REFERENCES restaurants(id),
                host_phone VARCHAR(15) NOT NULL,
                room_code VARCHAR(6),
                status VARCHAR(20) DEFAULT 'active'
                    CHECK (status IN ('active', 'closed', 'paid')),
                started_at TIMESTAMPTZ DEFAULT NOW(),
                closed_at TIMESTAMPTZ
            );

            -- =============================================
            -- 8. ORDERS
            -- =============================================
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                session_id INT REFERENCES order_sessions(id),
                table_id INT REFERENCES tables(id),
                restaurant_id INT REFERENCES restaurants(id),
                ordered_by_phone VARCHAR(15),
                ordered_by_name VARCHAR(100),
                order_type VARCHAR(20) DEFAULT 'dine-in'
                    CHECK (order_type IN ('dine-in', 'takeaway', 'delivery')),
                status VARCHAR(20) DEFAULT 'placed'
                    CHECK (status IN ('placed', 'accepted', 'preparing', 'ready', 'served', 'cancelled')),
                subtotal DECIMAL(10,2) DEFAULT 0,
                gst_amount DECIMAL(10,2) DEFAULT 0,
                service_charge DECIMAL(10,2) DEFAULT 0,
                discount_amount DECIMAL(10,2) DEFAULT 0,
                final_amount DECIMAL(10,2) DEFAULT 0,
                notes TEXT,
                placed_at TIMESTAMPTZ DEFAULT NOW(),
                accepted_at TIMESTAMPTZ,
                served_at TIMESTAMPTZ
            );

            -- =============================================
            -- 9. ORDER ITEMS
            -- =============================================
            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id INT REFERENCES orders(id) ON DELETE CASCADE,
                menu_item_id INT REFERENCES menu_items(id),
                item_name VARCHAR(200) NOT NULL,
                quantity INT DEFAULT 1,
                unit_price DECIMAL(10,2) NOT NULL,
                total_price DECIMAL(10,2) NOT NULL,
                special_instructions TEXT,
                status VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending', 'preparing', 'ready', 'served', 'cancelled'))
            );

            -- =============================================
            -- 10. ORDER ITEM MODIFIERS
            -- =============================================
            CREATE TABLE IF NOT EXISTS order_item_modifiers (
                id SERIAL PRIMARY KEY,
                order_item_id INT REFERENCES order_items(id) ON DELETE CASCADE,
                modifier_name VARCHAR(100) NOT NULL,
                modifier_price DECIMAL(10,2) DEFAULT 0
            );

            -- =============================================
            -- 11. PAYMENTS
            -- =============================================
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                session_id INT REFERENCES order_sessions(id),
                order_id INT REFERENCES orders(id),
                restaurant_id INT REFERENCES restaurants(id),
                razorpay_order_id VARCHAR(100),
                razorpay_payment_id VARCHAR(100),
                amount DECIMAL(10,2) NOT NULL,
                payment_method VARCHAR(30)
                    CHECK (payment_method IN ('upi', 'card', 'cash', 'wallet')),
                status VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
                paid_at TIMESTAMPTZ,
                paid_by_phone VARCHAR(15),
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            -- =============================================
            -- 12. INDEXES (Speed ke liye)
            -- =============================================
            CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON tables(restaurant_id);
            CREATE INDEX IF NOT EXISTS idx_tables_status ON tables(status);
            CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
            CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
            CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
            CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
            CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(session_id);

            -- =============================================
            -- 13. OTP TABLE (Temporary OTP storage)
            -- =============================================
            CREATE TABLE IF NOT EXISTS otp_verifications (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(15) NOT NULL,
                otp VARCHAR(6) NOT NULL,
                purpose VARCHAR(30) DEFAULT 'login'
                    CHECK (purpose IN ('login', 'table_lock', 'payment')),
                expires_at TIMESTAMPTZ NOT NULL,
                is_used BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
        `);

        console.log('✅ All tables created successfully!');

        // Purane DBs jinme naive TIMESTAMP columns hain, unhe UTC maan kar TIMESTAMPTZ banao
        console.log('🔧 Migrating timestamp columns to TIMESTAMPTZ...');

        await pool.query(`
            DO $$
            DECLARE
                col RECORD;
            BEGIN
                FOR col IN
                    SELECT table_name, column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND data_type = 'timestamp without time zone'
                LOOP
                    EXECUTE format(
                        'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
                        col.table_name, col.column_name, col.column_name
                    );
                END LOOP;
            END $$;
        `);

        console.log('✅ Timestamp columns migrated!');

        // =============================================
        // SEED DATA — Test ke liye ek restaurant aur kuch tables
        // =============================================
        console.log('🌱 Inserting seed data...');

        // Check karo agar pehle se data hai toh skip karo
        const existing = await pool.query('SELECT id FROM restaurants LIMIT 1');
        
        if (existing.rows.length === 0) {
            // Restaurant insert
            await pool.query(`
                INSERT INTO restaurants (name, address, phone, gst_number, service_charge_percent)
                VALUES ('My Restaurant', 'MG Road, Delhi', '9876543210', '07AAAAA1234A1Z5', 5.00)
            `);

            // 10 Tables insert
            for (let i = 1; i <= 10; i++) {
                await pool.query(`
                    INSERT INTO tables (restaurant_id, table_number, capacity, qr_code_url)
                    VALUES (1, 'T${i}', ${i <= 5 ? 4 : 6}, 'https://yourdomain.com/qr/T${i}')
                `);
            }

            // Categories insert
            await pool.query(`
                INSERT INTO categories (restaurant_id, name, display_order) VALUES
                (1, 'Starters', 1),
                (1, 'Main Course', 2),
                (1, 'Breads', 3),
                (1, 'Rice & Biryani', 4),
                (1, 'Drinks', 5),
                (1, 'Desserts', 6)
            `);

            // Menu Items insert
            await pool.query(`
                INSERT INTO menu_items (restaurant_id, category_id, name, description, price, is_veg, prep_time_minutes) VALUES
                (1, 1, 'Paneer Tikka', 'Grilled cottage cheese with spices', 220, true, 15),
                (1, 1, 'Chicken Tikka', 'Tandoori chicken pieces', 280, false, 15),
                (1, 1, 'Hara Bhara Kebab', 'Spinach and green pea kebabs', 180, true, 12),
                (1, 2, 'Butter Chicken', 'Creamy tomato chicken curry', 320, false, 20),
                (1, 2, 'Paneer Butter Masala', 'Rich creamy paneer curry', 260, true, 18),
                (1, 2, 'Dal Makhani', 'Slow cooked black lentils', 200, true, 15),
                (1, 3, 'Butter Naan', 'Soft tandoori naan with butter', 40, true, 5),
                (1, 3, 'Garlic Naan', 'Naan topped with garlic', 50, true, 5),
                (1, 4, 'Veg Biryani', 'Fragrant rice with vegetables', 220, true, 20),
                (1, 4, 'Chicken Biryani', 'Hyderabadi dum biryani', 300, false, 25),
                (1, 5, 'Masala Lemonade', 'Tangy lemon with spices', 80, true, 3),
                (1, 5, 'Mango Lassi', 'Sweet mango yogurt shake', 100, true, 3),
                (1, 6, 'Gulab Jamun', 'Soft milk dumplings in syrup', 120, true, 5),
                (1, 6, 'Brownie with Ice Cream', 'Hot chocolate brownie', 180, true, 8)
            `);

            // Modifiers insert (Paneer Tikka ke liye)
            await pool.query(`
                INSERT INTO modifiers (menu_item_id, name, price) VALUES
                (1, 'Extra Spicy', 0),
                (1, 'No Onion', 0),
                (1, 'Extra Portion', 80)
            `);

            console.log('✅ Seed data inserted! (1 restaurant, 10 tables, 14 menu items)');
        } else {
            console.log('⏭️ Seed data already exists, skipping...');
        }

        process.exit(0);

    } catch (error) {
        console.error('❌ Database Setup Error:', error.message);
        process.exit(1);
    }
};

createTables();