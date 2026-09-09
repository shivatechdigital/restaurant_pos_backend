const cron = require('node-cron');
const { query } = require('../config/db');

class TableAutoReleaseService {

    // Cron job start karo
    static start() {
        console.log('⏰ Auto Table Release Cron Job Started!');
        console.log('   → Har 2 minute mein expired tables check hongi');

        // Har 2 minute mein run karo
        cron.schedule('*/2 * * * *', async () => {
            await this.releaseExpiredTables();
        });

        // Ek extra job: Har 30 minute mein "cleaning" tables ko auto-free karo
        // (Agar waiter bhool jaye "Mark Clean" karna)
        cron.schedule('*/30 * * * *', async () => {
            await this.releaseCleaningTables();
        });
    }

    // Expired occupied tables ko free karo
    static async releaseExpiredTables() {
        try {
            // Woh tables dhoondo jinka auto_release_at time nikal gaya
            const expiredTables = await query(
                `SELECT id, table_number, restaurant_id, occupied_by_phone, occupied_at
                 FROM tables 
                 WHERE status = 'occupied' 
                 AND auto_release_at IS NOT NULL 
                 AND auto_release_at < NOW()`
            );

            if (expiredTables.rows.length === 0) {
                return; // Koi expired table nahi — kuch mat karo
            }

            for (const table of expiredTables.rows) {
                // Check karo ki koi active order toh nahi hai is table par
                const activeOrders = await query(
                    `SELECT COUNT(*) as count 
                     FROM orders o
                     JOIN order_sessions s ON o.session_id = s.id
                     WHERE s.table_id = $1 
                     AND o.status IN ('placed', 'accepted', 'preparing', 'ready')`,
                    [table.id]
                );

                const activeCount = parseInt(activeOrders.rows[0].count);

                if (activeCount > 0) {
                    // Active orders hain — table mat chhodo!
                    // Balki auto_release time extend karo 15 minute aur
                    await query(
                        `UPDATE tables 
                         SET auto_release_at = NOW() + INTERVAL '15 minutes' 
                         WHERE id = $1`,
                        [table.id]
                    );
                    console.log(`⏳ Table ${table.table_number}: Extended 15 min (${activeCount} active orders)`);
                } else {
                    // Koi active order nahi — table free karo
                    await query(
                        `UPDATE tables 
                         SET status = 'available', 
                             occupied_by_phone = NULL, 
                             room_code = NULL, 
                             auto_release_at = NULL 
                         WHERE id = $1`,
                        [table.id]
                    );

                    // Session bhi close karo
                    await query(
                        `UPDATE order_sessions 
                         SET status = 'closed', closed_at = NOW() 
                         WHERE table_id = $1 AND status = 'active'`,
                        [table.id]
                    );

                    console.log(`🔓 Table ${table.table_number}: Auto-released (no active orders, timeout)`);
                }
            }

        } catch (error) {
            console.error('❌ Auto Release Error:', error.message);
        }
    }

    // Bahut der se "cleaning" status mein padi tables ko free karo
    static async releaseCleaningTables() {
        try {
            // 30 minute se zyada cleaning mein hai toh auto-available karo
            const result = await query(
                `UPDATE tables 
                 SET status = 'available' 
                 WHERE status = 'cleaning' 
                 AND occupied_at < NOW() - INTERVAL '30 minutes'
                 RETURNING table_number`
            );

            if (result.rows.length > 0) {
                console.log(`🧹 Auto-cleaned ${result.rows.length} tables: ${result.rows.map(r => r.table_number).join(', ')}`);
            }

        } catch (error) {
            console.error('❌ Cleaning Release Error:', error.message);
        }
    }
}

module.exports = TableAutoReleaseService;