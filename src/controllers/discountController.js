const { query } = require('../config/db');

class DiscountController {
    static async ensureTable() {
        await query(`
            CREATE TABLE IF NOT EXISTS discount_coupons (
                id SERIAL PRIMARY KEY, restaurant_id INT REFERENCES restaurants(id) ON DELETE CASCADE,
                code VARCHAR(40) NOT NULL, discount_type VARCHAR(12) NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
                discount_value DECIMAL(10,2) NOT NULL, min_order_amount DECIMAL(10,2) DEFAULT 0,
                max_discount_amount DECIMAL(10,2), starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
                usage_limit INT, usage_count INT DEFAULT 0, is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(restaurant_id, code)
            )
        `);
        await query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS manager_discount_pin VARCHAR(100)`);
    }

    static async getCoupons(req, res) {
        try {
            await DiscountController.ensureTable();
            const result = await query(`SELECT * FROM discount_coupons WHERE restaurant_id = $1 ORDER BY created_at DESC`, [req.user.restaurant_id]);
            return res.json({ success: true, data: result.rows });
        } catch { return res.status(500).json({ success: false, message: 'Failed to load coupons' }); }
    }

    static async createCoupon(req, res) {
        try {
            await DiscountController.ensureTable();
            const { code, discount_type, discount_value, min_order_amount = 0, max_discount_amount, usage_limit, starts_at, ends_at } = req.body;
            if (!code?.trim() || !['percent', 'fixed'].includes(discount_type) || !(parseFloat(discount_value) > 0)) return res.status(400).json({ success: false, message: 'Valid code, type and discount value are required' });
            const result = await query(`INSERT INTO discount_coupons (restaurant_id, code, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit, starts_at, ends_at) VALUES ($1, UPPER($2), $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [req.user.restaurant_id, code.trim(), discount_type, discount_value, min_order_amount, max_discount_amount || null, usage_limit || null, starts_at || null, ends_at || null]);
            return res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error) { return res.status(400).json({ success: false, message: error.code === '23505' ? 'Coupon code already exists' : 'Failed to create coupon' }); }
    }

    static async toggleCoupon(req, res) {
        try {
            await DiscountController.ensureTable();
            const result = await query(`UPDATE discount_coupons SET is_active = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *`, [req.body.is_active === true, req.params.id, req.user.restaurant_id]);
            return result.rows.length ? res.json({ success: true, data: result.rows[0] }) : res.status(404).json({ success: false, message: 'Coupon not found' });
        } catch { return res.status(500).json({ success: false, message: 'Failed to update coupon' }); }
    }

    static async resolveDiscount(client, restaurantId, subtotal, { couponCode, managerPin, requestedDiscount = 0 }) {
        if (couponCode) {
            const result = await client.query(`SELECT * FROM discount_coupons WHERE restaurant_id = $1 AND code = UPPER($2) AND is_active = TRUE AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at >= NOW()) FOR UPDATE`, [restaurantId, couponCode]);
            const coupon = result.rows[0];
            if (!coupon) throw new Error('Coupon is invalid or expired');
            if (subtotal < parseFloat(coupon.min_order_amount)) throw new Error('Order does not meet coupon minimum');
            if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) throw new Error('Coupon usage limit reached');
            let amount = coupon.discount_type === 'percent' ? subtotal * parseFloat(coupon.discount_value) / 100 : parseFloat(coupon.discount_value);
            if (coupon.max_discount_amount !== null) amount = Math.min(amount, parseFloat(coupon.max_discount_amount));
            await client.query(`UPDATE discount_coupons SET usage_count = usage_count + 1 WHERE id = $1`, [coupon.id]);
            return { amount: Math.min(subtotal, parseFloat(amount.toFixed(2))), source: 'coupon', reference: coupon.code };
        }
        const amount = parseFloat(requestedDiscount || 0);
        if (amount <= 0) return { amount: 0, source: null, reference: null };
        const pinResult = await client.query(`SELECT manager_discount_pin FROM restaurants WHERE id = $1`, [restaurantId]);
        const pin = pinResult.rows[0]?.manager_discount_pin;
        if (!pin || managerPin !== pin) throw new Error('Manager approval PIN is required for manual discount');
        return { amount: Math.min(subtotal, amount), source: 'manager', reference: 'manual' };
    }
}

module.exports = DiscountController;