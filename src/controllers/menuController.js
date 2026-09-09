const { query } = require('../config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../../uploads/menu');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`)
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (req, file, cb) => {
        if (!/^image\/(jpeg|png|jpg|webp)$/.test(file.mimetype)) return cb(new Error('Only JPG/PNG/WEBP images allowed'));
        cb(null, true);
    }
});

class MenuController {

    static uploadMiddleware = upload.single('image');

    // Menu item image upload karo, public URL wapas bhejo
    static async uploadImage(req, res) {
        if (!req.file) return res.status(400).json({ success: false, message: 'Image file is required' });
        return res.status(201).json({
            success: true,
            data: { url: `/uploads/menu/${req.file.filename}` }
        });
    }

    // =============================================
    // CUSTOMER KE LIYE (Public - No Auth Needed)
    // =============================================

    // Poora menu fetch karo (Categories + Items + Modifiers)
    // Customer QR scan karke yeh dekhega
    static async getFullMenu(req, res) {
        try {
            const { restaurant_id } = req.query;

            if (!restaurant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'restaurant_id is required'
                });
            }

            // Step 1: Saari active categories fetch karo
            const categoriesResult = await query(
                `SELECT id, name, display_order 
                 FROM categories 
                 WHERE restaurant_id = $1 AND is_active = TRUE 
                 ORDER BY display_order ASC`,
                [restaurant_id]
            );

            const categories = categoriesResult.rows;

            // Step 2: Saare items ek hi query mein fetch karo (N+1 se bachne ke liye)
            const itemsResult = await query(
                `SELECT id, category_id, name, description, price, image_url, 
                        is_veg, is_available, prep_time_minutes
                 FROM menu_items 
                 WHERE restaurant_id = $1 
                 ORDER BY name ASC`,
                [restaurant_id]
            );

            // Step 3: Saare modifiers ek hi query mein fetch karo
            const itemIds = itemsResult.rows.map((item) => item.id);
            const modifiersResult = itemIds.length
                ? await query(
                    `SELECT id, menu_item_id, name, price, is_default 
                     FROM modifiers 
                     WHERE menu_item_id = ANY($1::int[]) 
                     ORDER BY price ASC`,
                    [itemIds]
                )
                : { rows: [] };

            // In-memory grouping (modifiers -> items -> categories)
            const modifiersByItem = new Map();
            for (const mod of modifiersResult.rows) {
                if (!modifiersByItem.has(mod.menu_item_id)) {
                    modifiersByItem.set(mod.menu_item_id, []);
                }
                modifiersByItem.get(mod.menu_item_id).push(mod);
            }

            const itemsByCategory = new Map();
            for (const item of itemsResult.rows) {
                item.modifiers = modifiersByItem.get(item.id) || [];
                if (!itemsByCategory.has(item.category_id)) {
                    itemsByCategory.set(item.category_id, []);
                }
                itemsByCategory.get(item.category_id).push(item);
            }

            for (const category of categories) {
                category.items = itemsByCategory.get(category.id) || [];
            }

            return res.status(200).json({
                success: true,
                data: {
                    restaurant_id: parseInt(restaurant_id),
                    total_categories: categories.length,
                    total_items: categories.reduce((sum, cat) => sum + cat.items.length, 0),
                    menu: categories
                }
            });

        } catch (error) {
            console.error('Get Menu Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Sirf available items dhoondo (Search ke liye)
    static async searchMenu(req, res) {
        try {
            const { restaurant_id, keyword } = req.query;

            if (!restaurant_id || !keyword) {
                return res.status(400).json({
                    success: false,
                    message: 'restaurant_id and keyword are required'
                });
            }

            const result = await query(
                `SELECT mi.id, mi.name, mi.description, mi.price, 
                        mi.image_url, mi.is_veg, mi.is_available,
                        c.name as category_name
                 FROM menu_items mi
                 JOIN categories c ON mi.category_id = c.id
                 WHERE mi.restaurant_id = $1 
                 AND mi.is_available = TRUE
                 AND (LOWER(mi.name) LIKE LOWER($2) 
                      OR LOWER(mi.description) LIKE LOWER($2))
                 ORDER BY mi.name ASC
                 LIMIT 20`,
                [restaurant_id, `%${keyword}%`]
            );

            return res.status(200).json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // =============================================
    // ADMIN KE LIYE (Auth Required)
    // =============================================

    // --- CATEGORIES ---

    // Nayi category banao
    static async createCategory(req, res) {
        try {
            const { name, display_order } = req.body;
            const restaurant_id = req.user.restaurant_id;

            if (!name) {
                return res.status(400).json({
                    success: false,
                    message: 'Category name is required'
                });
            }

            const result = await query(
                `INSERT INTO categories (restaurant_id, name, display_order)
                 VALUES ($1, $2, $3)
                 RETURNING *`,
                [restaurant_id, name, display_order || 0]
            );

            return res.status(201).json({
                success: true,
                message: 'Category created successfully',
                data: result.rows[0]
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Category update karo
    static async updateCategory(req, res) {
        try {
            const { id } = req.params;
            const { name, display_order, is_active } = req.body;
            const restaurant_id = req.user.restaurant_id;

            const result = await query(
                `UPDATE categories 
                 SET name = COALESCE($1, name),
                     display_order = COALESCE($2, display_order),
                     is_active = COALESCE($3, is_active)
                 WHERE id = $4 AND restaurant_id = $5
                 RETURNING *`,
                [name, display_order, is_active, id, restaurant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Category not found'
                });
            }

            return res.status(200).json({
                success: true,
                message: 'Category updated',
                data: result.rows[0]
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Category delete karo
    static async deleteCategory(req, res) {
        try {
            const { id } = req.params;
            const restaurant_id = req.user.restaurant_id;

            // Check karo ki is category mein koi item toh nahi hai
            const itemsCheck = await query(
                'SELECT COUNT(*) as count FROM menu_items WHERE category_id = $1',
                [id]
            );

            if (parseInt(itemsCheck.rows[0].count) > 0) {
                return res.status(400).json({
                    success: false,
                    message: `Cannot delete! ${itemsCheck.rows[0].count} items exist in this category. Move or delete them first.`
                });
            }

            const result = await query(
                'DELETE FROM categories WHERE id = $1 AND restaurant_id = $2 RETURNING *',
                [id, restaurant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Category not found' });
            }

            return res.status(200).json({
                success: true,
                message: 'Category deleted'
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // --- MENU ITEMS ---

    // Naya menu item add karo
    static async createMenuItem(req, res) {
        try {
            const {
                category_id, name, description, price,
                image_url, is_veg, prep_time_minutes, modifiers
            } = req.body;
            const restaurant_id = req.user.restaurant_id;

            if (!name || !price || !category_id) {
                return res.status(400).json({
                    success: false,
                    message: 'name, price, and category_id are required'
                });
            }

            // Item insert karo
            const itemResult = await query(
                `INSERT INTO menu_items 
                 (restaurant_id, category_id, name, description, price, image_url, is_veg, prep_time_minutes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [restaurant_id, category_id, name, description, price, image_url, is_veg !== false, prep_time_minutes || 10]
            );

            const newItem = itemResult.rows[0];

            // Agar modifiers bhi bheje hain, toh woh bhi insert karo
            if (modifiers && Array.isArray(modifiers) && modifiers.length > 0) {
                for (const mod of modifiers) {
                    await query(
                        `INSERT INTO modifiers (menu_item_id, name, price, is_default)
                         VALUES ($1, $2, $3, $4)`,
                        [newItem.id, mod.name, mod.price || 0, mod.is_default || false]
                    );
                }

                // Modifiers ke saath item wapas bhejo
                const modsResult = await query(
                    'SELECT * FROM modifiers WHERE menu_item_id = $1',
                    [newItem.id]
                );
                newItem.modifiers = modsResult.rows;
            } else {
                newItem.modifiers = [];
            }

            return res.status(201).json({
                success: true,
                message: 'Menu item created successfully',
                data: newItem
            });

        } catch (error) {
            console.error('Create Menu Item Error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Menu item update karo
    static async updateMenuItem(req, res) {
        try {
            const { id } = req.params;
            const {
                category_id, name, description, price,
                image_url, is_veg, is_available, prep_time_minutes
            } = req.body;
            const restaurant_id = req.user.restaurant_id;

            const result = await query(
                `UPDATE menu_items 
                 SET category_id = COALESCE($1, category_id),
                     name = COALESCE($2, name),
                     description = COALESCE($3, description),
                     price = COALESCE($4, price),
                     image_url = COALESCE($5, image_url),
                     is_veg = COALESCE($6, is_veg),
                     is_available = COALESCE($7, is_available),
                     prep_time_minutes = COALESCE($8, prep_time_minutes)
                 WHERE id = $9 AND restaurant_id = $10
                 RETURNING *`,
                [category_id, name, description, price, image_url, is_veg, is_available, prep_time_minutes, id, restaurant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Menu item not found' });
            }

            return res.status(200).json({
                success: true,
                message: 'Menu item updated',
                data: result.rows[0]
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Menu item delete karo
    static async deleteMenuItem(req, res) {
        try {
            const { id } = req.params;
            const restaurant_id = req.user.restaurant_id;

            const result = await query(
                'DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2 RETURNING *',
                [id, restaurant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Menu item not found' });
            }

            return res.status(200).json({
                success: true,
                message: 'Menu item deleted'
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Item ko available/unavailable karo (Quick toggle)
    static async toggleAvailability(req, res) {
        try {
            const { id } = req.params;
            const { is_available } = req.body;
            const restaurant_id = req.user.restaurant_id;

            const result = await query(
                `UPDATE menu_items 
                 SET is_available = $1 
                 WHERE id = $2 AND restaurant_id = $3 
                 RETURNING id, name, is_available`,
                [is_available, id, restaurant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Item not found' });
            }

            // Socket.io se sab customers ko notify karo
            const io = req.app.get('io');
            if (io) {
                io.to(`restaurant_${restaurant_id}`).emit('menu_item_updated', {
                    item_id: result.rows[0].id,
                    is_available: result.rows[0].is_available,
                    message: `${result.rows[0].name} is now ${is_available ? 'available' : 'out of stock'}`
                });
            }

            return res.status(200).json({
                success: true,
                message: `${result.rows[0].name} is now ${is_available ? 'available ✅' : 'out of stock ❌'}`,
                data: result.rows[0]
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // --- MODIFIERS ---

    // Modifier add karo
    static async addModifier(req, res) {
        try {
            const { menu_item_id, name, price, is_default } = req.body;

            if (!menu_item_id || !name) {
                return res.status(400).json({
                    success: false,
                    message: 'menu_item_id and name are required'
                });
            }

            const result = await query(
                `INSERT INTO modifiers (menu_item_id, name, price, is_default)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [menu_item_id, name, price || 0, is_default || false]
            );

            return res.status(201).json({
                success: true,
                message: 'Modifier added',
                data: result.rows[0]
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }

    // Modifier delete karo
    static async deleteModifier(req, res) {
        try {
            const { id } = req.params;

            await query('DELETE FROM modifiers WHERE id = $1', [id]);

            return res.status(200).json({
                success: true,
                message: 'Modifier deleted'
            });

        } catch (error) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
}

module.exports = MenuController;