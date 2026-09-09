const { query } = require('../config/db');

class InventoryController {
    static async ensureTable() {
        await query(`
            CREATE TABLE IF NOT EXISTS inventory_materials (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                name VARCHAR(200) NOT NULL,
                unit VARCHAR(30) DEFAULT 'kg',
                current_stock DECIMAL(12,3) DEFAULT 0,
                min_stock DECIMAL(12,3) DEFAULT 0,
                cost_per_unit DECIMAL(12,2) DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(restaurant_id, name)
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS inventory_vendors (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                name VARCHAR(200) NOT NULL,
                phone VARCHAR(20),
                address TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS inventory_purchases (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                material_id INT REFERENCES inventory_materials(id),
                vendor_id INT REFERENCES inventory_vendors(id),
                quantity DECIMAL(12,3) NOT NULL,
                unit_cost DECIMAL(12,2) DEFAULT 0,
                total_cost DECIMAL(12,2) DEFAULT 0,
                invoice_number VARCHAR(100),
                notes TEXT,
                purchased_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS inventory_ledger (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                material_id INT REFERENCES inventory_materials(id),
                change_qty DECIMAL(12,3) NOT NULL,
                type VARCHAR(30) NOT NULL CHECK (type IN ('opening', 'purchase', 'sale_deduction', 'wastage', 'adjustment')),
                ref_type VARCHAR(50),
                ref_id INT,
                notes TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS menu_item_recipes (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                menu_item_id INT REFERENCES menu_items(id) ON DELETE CASCADE,
                material_id INT REFERENCES inventory_materials(id),
                quantity_per_item DECIMAL(12,3) NOT NULL,
                unit VARCHAR(30),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(menu_item_id, material_id)
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS inventory_requests (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                item_name VARCHAR(200) NOT NULL,
                quantity VARCHAR(100),
                urgency VARCHAR(20) DEFAULT 'normal' CHECK (urgency IN ('normal', 'urgent')),
                notes TEXT,
                requested_by_phone VARCHAR(15),
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'ordered', 'received', 'cancelled')),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    }

    static async ensureTablesWithClient(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS inventory_materials (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                name VARCHAR(200) NOT NULL,
                unit VARCHAR(30) DEFAULT 'kg',
                current_stock DECIMAL(12,3) DEFAULT 0,
                min_stock DECIMAL(12,3) DEFAULT 0,
                cost_per_unit DECIMAL(12,2) DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(restaurant_id, name)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS inventory_ledger (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                material_id INT REFERENCES inventory_materials(id),
                change_qty DECIMAL(12,3) NOT NULL,
                type VARCHAR(30) NOT NULL CHECK (type IN ('opening', 'purchase', 'sale_deduction', 'wastage', 'adjustment')),
                ref_type VARCHAR(50),
                ref_id INT,
                notes TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS menu_item_recipes (
                id SERIAL PRIMARY KEY,
                restaurant_id INT REFERENCES restaurants(id),
                menu_item_id INT REFERENCES menu_items(id) ON DELETE CASCADE,
                material_id INT REFERENCES inventory_materials(id),
                quantity_per_item DECIMAL(12,3) NOT NULL,
                unit VARCHAR(30),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(menu_item_id, material_id)
            )
        `);
    }

    static async deductForOrder(client, restaurantId, menuItemId, quantity, orderId) {
        const recipeResult = await client.query(
            `SELECT r.*, m.name, m.current_stock
             FROM menu_item_recipes r
             JOIN inventory_materials m ON r.material_id = m.id
             WHERE r.restaurant_id = $1 AND r.menu_item_id = $2 AND m.is_active = TRUE`,
            [restaurantId, menuItemId]
        );

        if (recipeResult.rows.length === 0) return;

        for (const row of recipeResult.rows) {
            const requiredQty = parseFloat(row.quantity_per_item) * quantity;
            const currentStock = parseFloat(row.current_stock || 0);
            if (currentStock < requiredQty) {
                throw new Error(`Insufficient stock: ${row.name}. Required ${requiredQty}, available ${currentStock}`);
            }
        }

        for (const row of recipeResult.rows) {
            const requiredQty = parseFloat(row.quantity_per_item) * quantity;
            await client.query(
                `UPDATE inventory_materials
                 SET current_stock = current_stock - $1, updated_at = NOW()
                 WHERE id = $2`,
                [requiredQty, row.material_id]
            );
            await client.query(
                `INSERT INTO inventory_ledger (restaurant_id, material_id, change_qty, type, ref_type, ref_id, notes)
                 VALUES ($1, $2, $3, 'sale_deduction', 'order', $4, $5)`,
                [restaurantId, row.material_id, -requiredQty, orderId, `Recipe deduction for menu_item ${menuItemId}`]
            );
        }
    }

    static async restoreForOrder(client, restaurantId, menuItemId, quantity, orderId) {
        const recipeResult = await client.query(
            `SELECT r.material_id, r.quantity_per_item FROM menu_item_recipes r
             WHERE r.restaurant_id = $1 AND r.menu_item_id = $2`,
            [restaurantId, menuItemId]
        );
        for (const row of recipeResult.rows) {
            const quantityToRestore = parseFloat(row.quantity_per_item) * quantity;
            await client.query(`UPDATE inventory_materials SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3`, [quantityToRestore, row.material_id, restaurantId]);
            await client.query(`INSERT INTO inventory_ledger (restaurant_id, material_id, change_qty, type, ref_type, ref_id, notes) VALUES ($1, $2, $3, 'adjustment', 'order_item_cancel', $4, $5)`, [restaurantId, row.material_id, quantityToRestore, orderId, `Restored for cancelled menu item ${menuItemId}`]);
        }
    }

    static async createRequest(req, res) {
        try {
            await InventoryController.ensureTable();
            const restaurant_id = req.user.restaurant_id;
            const { item_name, quantity, urgency, notes } = req.body;

            if (!item_name) {
                return res.status(400).json({ success: false, message: 'item_name is required' });
            }

            const result = await query(
                `INSERT INTO inventory_requests
                 (restaurant_id, item_name, quantity, urgency, notes, requested_by_phone)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [restaurant_id, item_name, quantity || '', urgency === 'urgent' ? 'urgent' : 'normal', notes || '', req.user.phone]
            );

            const io = req.app.get('io');
            if (io) {
                io.to(`restaurant_${restaurant_id}`).emit('inventory_request_created', {
                    request: result.rows[0],
                    message: `Stock request: ${item_name} ${quantity || ''}`.trim()
                });
            }

            return res.status(201).json({ success: true, message: 'Inventory request created', data: result.rows[0] });
        } catch (error) {
            console.error('Create inventory request error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getRequests(req, res) {
        try {
            await InventoryController.ensureTable();
            const restaurant_id = req.user.restaurant_id;
            const { status } = req.query;

            const params = [restaurant_id];
            let where = 'WHERE restaurant_id = $1';
            if (status) {
                params.push(status);
                where += ` AND status = $${params.length}`;
            }

            const result = await query(
                `SELECT * FROM inventory_requests ${where} ORDER BY created_at DESC LIMIT 100`,
                params
            );

            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Get inventory requests error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async updateRequestStatus(req, res) {
        try {
            await InventoryController.ensureTable();
            const restaurant_id = req.user.restaurant_id;
            const { id } = req.params;
            const { status } = req.body;
            const valid = ['pending', 'ordered', 'received', 'cancelled'];

            if (!valid.includes(status)) {
                return res.status(400).json({ success: false, message: `status must be one of ${valid.join(', ')}` });
            }

            const result = await query(
                `UPDATE inventory_requests
                 SET status = $1, updated_at = NOW()
                 WHERE id = $2 AND restaurant_id = $3
                 RETURNING *`,
                [status, id, restaurant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Inventory request not found' });
            }

            const io = req.app.get('io');
            if (io) {
                io.to(`restaurant_${restaurant_id}`).emit('inventory_request_updated', {
                    request: result.rows[0]
                });
            }

            return res.status(200).json({ success: true, message: 'Inventory request updated', data: result.rows[0] });
        } catch (error) {
            console.error('Update inventory request error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getMaterials(req, res) {
        try {
            await InventoryController.ensureTable();
            const result = await query(
                `SELECT *, current_stock <= min_stock AS is_low_stock
                 FROM inventory_materials
                 WHERE restaurant_id = $1 AND is_active = TRUE
                 ORDER BY name`,
                [req.user.restaurant_id]
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Get materials error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async upsertMaterial(req, res) {
        try {
            await InventoryController.ensureTable();
            const restaurant_id = req.user.restaurant_id;
            const { id, name, unit, current_stock = 0, min_stock = 0, cost_per_unit = 0 } = req.body;

            if (!name) {
                return res.status(400).json({ success: false, message: 'Material name is required' });
            }

            let result;
            if (id) {
                result = await query(
                    `UPDATE inventory_materials
                     SET name = $1, unit = $2, min_stock = $3, cost_per_unit = $4, updated_at = NOW()
                     WHERE id = $5 AND restaurant_id = $6
                     RETURNING *`,
                    [name, unit || 'kg', min_stock, cost_per_unit, id, restaurant_id]
                );
            } else {
                result = await query(
                    `INSERT INTO inventory_materials (restaurant_id, name, unit, current_stock, min_stock, cost_per_unit)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (restaurant_id, name)
                     DO UPDATE SET unit = EXCLUDED.unit, min_stock = EXCLUDED.min_stock, cost_per_unit = EXCLUDED.cost_per_unit, updated_at = NOW()
                     RETURNING *`,
                    [restaurant_id, name, unit || 'kg', current_stock, min_stock, cost_per_unit]
                );

                if (parseFloat(current_stock || 0) > 0) {
                    await query(
                        `INSERT INTO inventory_ledger (restaurant_id, material_id, change_qty, type, notes)
                         VALUES ($1, $2, $3, 'opening', 'Opening stock')`,
                        [restaurant_id, result.rows[0].id, current_stock]
                    );
                }
            }

            return res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('Upsert material error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async adjustMaterial(req, res) {
        try {
            await InventoryController.ensureTable();
            const restaurant_id = req.user.restaurant_id;
            const { id } = req.params;
            const { change_qty, type = 'adjustment', notes } = req.body;
            const valid = ['wastage', 'adjustment'];

            if (!valid.includes(type)) {
                return res.status(400).json({ success: false, message: 'type must be wastage or adjustment' });
            }

            const qty = parseFloat(change_qty || 0);
            const result = await query(
                `UPDATE inventory_materials
                 SET current_stock = current_stock + $1, updated_at = NOW()
                 WHERE id = $2 AND restaurant_id = $3
                 RETURNING *`,
                [qty, id, restaurant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Material not found' });
            }

            await query(
                `INSERT INTO inventory_ledger (restaurant_id, material_id, change_qty, type, notes)
                 VALUES ($1, $2, $3, $4, $5)`,
                [restaurant_id, id, qty, type, notes || 'Manual stock update']
            );

            return res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('Adjust material error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getVendors(req, res) {
        try {
            await InventoryController.ensureTable();
            const result = await query(
                `SELECT * FROM inventory_vendors WHERE restaurant_id = $1 AND is_active = TRUE ORDER BY name`,
                [req.user.restaurant_id]
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Get vendors error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async createVendor(req, res) {
        try {
            await InventoryController.ensureTable();
            const { name, phone, address } = req.body;
            if (!name) return res.status(400).json({ success: false, message: 'Vendor name is required' });

            const result = await query(
                `INSERT INTO inventory_vendors (restaurant_id, name, phone, address)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [req.user.restaurant_id, name, phone || '', address || '']
            );
            return res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('Create vendor error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async createPurchase(req, res) {
        try {
            await InventoryController.ensureTable();
            const restaurant_id = req.user.restaurant_id;
            const { material_id, vendor_id, quantity, unit_cost = 0, invoice_number, notes } = req.body;

            if (!material_id || !quantity) {
                return res.status(400).json({ success: false, message: 'material_id and quantity are required' });
            }

            const qty = parseFloat(quantity);
            const unitCost = parseFloat(unit_cost || 0);
            const totalCost = parseFloat((qty * unitCost).toFixed(2));

            const materialResult = await query(
                `SELECT id FROM inventory_materials
                 WHERE id = $1 AND restaurant_id = $2 AND is_active = TRUE`,
                [material_id, restaurant_id]
            );
            if (materialResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Material not found' });
            }

            if (vendor_id) {
                const vendorResult = await query(
                    `SELECT id FROM inventory_vendors
                     WHERE id = $1 AND restaurant_id = $2 AND is_active = TRUE`,
                    [vendor_id, restaurant_id]
                );
                if (vendorResult.rows.length === 0) {
                    return res.status(404).json({ success: false, message: 'Vendor not found' });
                }
            }

            const purchaseResult = await query(
                `INSERT INTO inventory_purchases
                 (restaurant_id, material_id, vendor_id, quantity, unit_cost, total_cost, invoice_number, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [restaurant_id, material_id, vendor_id || null, qty, unitCost, totalCost, invoice_number || '', notes || '']
            );

            await query(
                `UPDATE inventory_materials
                 SET current_stock = current_stock + $1, cost_per_unit = $2, updated_at = NOW()
                 WHERE id = $3 AND restaurant_id = $4`,
                [qty, unitCost, material_id, restaurant_id]
            );

            await query(
                `INSERT INTO inventory_ledger (restaurant_id, material_id, change_qty, type, ref_type, ref_id, notes)
                 VALUES ($1, $2, $3, 'purchase', 'purchase', $4, $5)`,
                [restaurant_id, material_id, qty, purchaseResult.rows[0].id, notes || 'Purchase entry']
            );

            return res.status(201).json({ success: true, data: purchaseResult.rows[0] });
        } catch (error) {
            console.error('Create purchase error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getPurchases(req, res) {
        try {
            await InventoryController.ensureTable();
            const result = await query(
                `SELECT p.*, m.name AS material_name, v.name AS vendor_name
                 FROM inventory_purchases p
                 JOIN inventory_materials m ON p.material_id = m.id
                 LEFT JOIN inventory_vendors v ON p.vendor_id = v.id
                 WHERE p.restaurant_id = $1
                 ORDER BY p.purchased_at DESC LIMIT 100`,
                [req.user.restaurant_id]
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Get purchases error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getLedger(req, res) {
        try {
            await InventoryController.ensureTable();
            const { material_id } = req.query;
            const params = [req.user.restaurant_id];
            let where = 'WHERE l.restaurant_id = $1';
            if (material_id) {
                params.push(material_id);
                where += ` AND l.material_id = $${params.length}`;
            }

            const result = await query(
                `SELECT l.*, m.name AS material_name, m.unit
                 FROM inventory_ledger l
                 JOIN inventory_materials m ON l.material_id = m.id
                 ${where}
                 ORDER BY l.created_at DESC LIMIT 200`,
                params
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Get ledger error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getLowStock(req, res) {
        try {
            await InventoryController.ensureTable();
            const result = await query(
                `SELECT * FROM inventory_materials
                 WHERE restaurant_id = $1 AND is_active = TRUE AND current_stock <= min_stock
                 ORDER BY current_stock ASC`,
                [req.user.restaurant_id]
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Low stock error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async getRecipe(req, res) {
        try {
            await InventoryController.ensureTable();
            const result = await query(
                `SELECT r.*, m.name AS material_name, m.unit AS material_unit
                 FROM menu_item_recipes r
                 JOIN inventory_materials m ON r.material_id = m.id
                 WHERE r.restaurant_id = $1 AND r.menu_item_id = $2
                 ORDER BY m.name`,
                [req.user.restaurant_id, req.params.menu_item_id]
            );
            return res.status(200).json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Get recipe error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    static async saveRecipe(req, res) {
        try {
            await InventoryController.ensureTable();
            const restaurant_id = req.user.restaurant_id;
            const { menu_item_id } = req.params;
            const { materials } = req.body;

            if (!Array.isArray(materials)) {
                return res.status(400).json({ success: false, message: 'materials array is required' });
            }

            const materialIds = materials.map(item => item.material_id).filter(Boolean);
            if (materialIds.length > 0) {
                const ownedMaterials = await query(
                    `SELECT id FROM inventory_materials
                     WHERE restaurant_id = $1 AND is_active = TRUE AND id = ANY($2::int[])`,
                    [restaurant_id, materialIds]
                );
                if (ownedMaterials.rows.length !== new Set(materialIds).size) {
                    return res.status(400).json({ success: false, message: 'Invalid recipe material selected' });
                }
            }

            await query(
                'DELETE FROM menu_item_recipes WHERE restaurant_id = $1 AND menu_item_id = $2',
                [restaurant_id, menu_item_id]
            );

            for (const item of materials) {
                if (!item.material_id || !item.quantity_per_item) continue;
                await query(
                    `INSERT INTO menu_item_recipes (restaurant_id, menu_item_id, material_id, quantity_per_item, unit)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [restaurant_id, menu_item_id, item.material_id, item.quantity_per_item, item.unit || null]
                );
            }

            return res.status(200).json({ success: true, message: 'Recipe saved' });
        } catch (error) {
            console.error('Save recipe error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = InventoryController;
