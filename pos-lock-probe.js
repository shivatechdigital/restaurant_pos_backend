const { query, pool } = require('./src/config/db');

(async () => {
    const result = await query(`
        SELECT pid, state, wait_event_type, wait_event, LEFT(query, 160) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY query_start DESC
    `);
    console.log(JSON.stringify(result.rows));
    await pool.end();
})().catch(async (error) => {
    console.error(error.stack || error.message);
    await pool.end();
    process.exit(1);
});
