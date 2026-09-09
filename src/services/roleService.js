const { query } = require('../config/db');

class RoleService {
    static async ensureReceptionRole() {
        await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
        await query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'waiter', 'kitchen', 'reception'))`);
    }
}

module.exports = RoleService;