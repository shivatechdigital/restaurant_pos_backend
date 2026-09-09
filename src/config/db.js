const { Pool, neonConfig } = require('@neondatabase/serverless');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ override: true });

const zscalerRootCa = fs.readFileSync(
    path.join(__dirname, '../../.certs/zscaler-root-ca.pem'),
    'utf8'
);

class TrustedWebSocket extends WebSocket {
    constructor(address, protocols, options) {
        super(address, protocols, {
            ...options,
            ca: zscalerRootCa,
            rejectUnauthorized: process.env.NODE_ENV === 'production'
        });
    }
}

neonConfig.webSocketConstructor = TrustedWebSocket;

const databaseUrl = process.env.DATABASE_URL ||
    `postgresql://${encodeURIComponent(process.env.DB_USER || '')}:${encodeURIComponent(process.env.DB_PASSWORD || '')}` +
    `@${process.env.DB_HOST || ''}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || ''}` +
    '?sslmode=require&channel_binding=require';

const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    // Local networks with SSL inspection (for example Zscaler) replace the
    // database certificate. Keep strict verification enabled in production.
    ssl: {
        rejectUnauthorized: process.env.NODE_ENV === 'production'
    },
});

pool.on('connect', () => {
    console.log('✅ PostgreSQL Database Connected Successfully!');
});

pool.on('error', (err) => {
    // Idle clients can be dropped by the DB host; don't crash the server for that
    console.error('❌ Database Pool Error:', err.message);
});

const query = async (text, params) => {
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (process.env.NODE_ENV === 'development') {
        console.log(`⚡ Query executed in ${duration}ms | Rows: ${result.rowCount}`);
    }

    return result;
};

module.exports = { pool, query };