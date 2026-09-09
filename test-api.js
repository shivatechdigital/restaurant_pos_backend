const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const RESTAURANT_ID = 1;

// Test users
const USERS = {
    admin: {
        phone: '9999999991',
        name: 'Test Admin',
        role: 'admin'
    },
    kitchen: {
        phone: '9999999992',
        name: 'Test Kitchen',
        role: 'kitchen'
    },
    waiter: {
        phone: '9999999993',
        name: 'Test Waiter',
        role: 'waiter'
    },
    reception: {
        phone: '9999999994',
        name: 'Test Reception',
        role: 'reception'
    },
    customer: {
        phone: '9876543210',
        name: 'Rahul',
        role: 'customer'
    }
};

// Neon PostgreSQL connection
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,

    ssl: {
        rejectUnauthorized: false
    },

    connectionTimeoutMillis: 10000
});

let adminToken = '';
let kitchenToken = '';
let waiterToken = '';
let customerToken = '';

let orderId = null;
let sessionId = null;
let createdMenuItemId = null;


// ==================================================
// HELPERS
// ==================================================

function logStep(step, message) {
    console.log(`\n[${step}] ${message}`);
}

function pass(message) {
    console.log(`   ✅ ${message}`);
}

function fail(message) {
    console.log(`   ❌ ${message}`);
}


// ==================================================
// API REQUEST HELPER
// ==================================================

async function api(path, options = {}) {

    const response = await fetch(`${BASE_URL}${path}`, {
        ...options,

        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    const text = await response.text();

    let body;

    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = {
            raw: text
        };
    }

    if (!response.ok) {

        const error = new Error(
            body.message || `HTTP ${response.status}`
        );

        error.status = response.status;
        error.body = body;

        throw error;
    }

    return body;
}


// ==================================================
// EXPECT A REQUEST TO FAIL WITH A GIVEN STATUS
// ==================================================

async function expectFailure(path, options, expectedStatus) {

    try {

        await api(path, options);

    } catch (error) {

        if (error.status === expectedStatus) {
            return error;
        }

        throw new Error(
            `Expected HTTP ${expectedStatus}, got ${error.status}: ${error.message}`
        );
    }

    throw new Error(
        `Expected HTTP ${expectedStatus}, but request succeeded`
    );
}


// ==================================================
// PLACE A SIMPLE ORDER (returns new session)
// ==================================================

async function placeSimpleOrder(token, note) {

    const result = await api(
        '/api/orders/place',
        {
            method: 'POST',

            headers: {
                Authorization: `Bearer ${token}`
            },

            body: JSON.stringify({
                table_id: 1,
                restaurant_id: RESTAURANT_ID,
                phone: USERS.customer.phone,
                name: USERS.customer.name,

                items: [
                    {
                        menu_item_id: 7,
                        quantity: 1,
                        modifiers: []
                    }
                ],

                notes: note
            })
        }
    );

    return {
        orderId: result.data?.order_id,
        sessionId: result.data?.session_id,
        amount: result.data?.summary?.final_amount
    };
}


// ==================================================
// ENSURE ADMIN / KITCHEN / WAITER USERS
// ==================================================

async function ensureUsers() {

    for (const key of ['admin', 'kitchen', 'waiter', 'reception']) {

        const user = USERS[key];

        const existing = await pool.query(
            'SELECT id FROM users WHERE phone = $1 LIMIT 1',
            [user.phone]
        );

        if (existing.rows.length === 0) {

            await pool.query(
                `INSERT INTO users
                (phone, name, role, restaurant_id, is_active)
                VALUES ($1, $2, $3, $4, TRUE)`,
                [
                    user.phone,
                    user.name,
                    user.role,
                    RESTAURANT_ID
                ]
            );

            pass(
                `${key} user created: ${user.phone}`
            );

        } else {

            await pool.query(
                `UPDATE users
                 SET name = $1,
                     role = $2,
                     restaurant_id = $3,
                     is_active = TRUE
                 WHERE phone = $4`,
                [
                    user.name,
                    user.role,
                    RESTAURANT_ID,
                    user.phone
                ]
            );

            pass(
                `${key} user already exists: ${user.phone}`
            );
        }
    }
}


// ==================================================
// GET LATEST OTP FROM DATABASE
// ==================================================

async function getLatestOTP(phone, purpose = 'login') {

    const result = await pool.query(
        `SELECT otp
         FROM otp_verifications
         WHERE phone = $1
           AND purpose = $2
           AND is_used = FALSE
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`,
        [
            phone,
            purpose
        ]
    );

    if (result.rows.length === 0) {

        throw new Error(
            `No active OTP found for ${phone}`
        );
    }

    return result.rows[0].otp;
}


// ==================================================
// LOGIN USING OTP
// ==================================================

async function loginWithOTP(user) {

    // Send OTP
    await api(
        '/api/auth/send-otp',
        {
            method: 'POST',

            body: JSON.stringify({
                phone: user.phone
            })
        }
    );

    // Read OTP directly from Neon DB
    const otp = await getLatestOTP(
        user.phone,
        'login'
    );

    console.log(
        `   📱 OTP received from DB: ${otp}`
    );

    // Verify OTP
    const result = await api(
        '/api/auth/verify-otp',
        {
            method: 'POST',

            body: JSON.stringify({
                phone: user.phone,
                otp: otp
            })
        }
    );

    const token = result?.data?.token;

    if (!token) {

        throw new Error(
            'JWT token was not returned'
        );
    }

    return {
        token: token,
        user: result.data.user
    };
}


// ==================================================
// MAIN TEST
// ==================================================

async function main() {

    console.log('');
    console.log('==============================================');
    console.log('       RESTAURANT POS API AUTOMATED TEST');
    console.log('==============================================');

    console.log(
        `Base URL: ${BASE_URL}`
    );

    console.log(
        `Restaurant ID: ${RESTAURANT_ID}`
    );


    // ==================================================
    // 0. DATABASE
    // ==================================================

    logStep(
        '0',
        'Checking Neon PostgreSQL connection...'
    );

    await pool.query('SELECT 1');

    pass(
        'Neon PostgreSQL connection successful'
    );


    // ==================================================
    // 1. HEALTH
    // ==================================================

    logStep(
        '1',
        'Checking API health...'
    );

    const health = await api(
        '/api/health'
    );

    pass(
        health.message || 'API is running'
    );


    // ==================================================
    // 2. USERS
    // ==================================================

    logStep(
        '2',
        'Ensuring Admin / Kitchen / Waiter users...'
    );

    await ensureUsers();


    // ==================================================
    // 3. ADMIN LOGIN
    // ==================================================

    logStep(
        '3',
        'Admin OTP login...'
    );

    const admin = await loginWithOTP(
        USERS.admin
    );

    adminToken = admin.token;

    pass(
        `Admin JWT captured - role: ${admin.user.role}`
    );


    // ==================================================
    // 4. GET FULL MENU
    // ==================================================

    logStep(
        '4',
        'GET full menu...'
    );

    const menu = await api(
        `/api/menu?restaurant_id=${RESTAURANT_ID}`
    );

    pass(
        `Menu loaded: ${menu.data?.total_categories ?? 0} categories, ` +
        `${menu.data?.total_items ?? 0} items`
    );


    // ==================================================
    // 5. SEARCH MENU
    // ==================================================

    logStep(
        '5',
        'Searching menu for "paneer"...'
    );

    const search = await api(
        `/api/menu/search?restaurant_id=${RESTAURANT_ID}&keyword=paneer`
    );

    pass(
        `Search returned ${search.data?.length ?? 0} item(s)`
    );


    // ==================================================
    // 6. ADMIN TABLES
    // ==================================================

    logStep(
        '6',
        'Admin GET all tables...'
    );

    const tables = await api(
        '/api/tables/all',
        {
            headers: {
                Authorization:
                    `Bearer ${adminToken}`
            }
        }
    );

    pass(
        `Tables returned: ${tables.data?.length ?? 0}`
    );


    // ==================================================
    // 7. CREATE MENU ITEM
    // ==================================================

    logStep(
        '7',
        'Admin creates test menu item...'
    );

    const newItem = await api(
        '/api/menu/items',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${adminToken}`
            },

            body: JSON.stringify({

                category_id: 1,

                name:
                    `Automation Test Item ${Date.now()}`,

                description:
                    'Created by automated API test',

                price: 240,

                is_veg: true,

                prep_time_minutes: 15,

                modifiers: [

                    {
                        name: 'Extra Gravy',
                        price: 30
                    },

                    {
                        name: 'No Cream',
                        price: 0
                    }

                ]
            })
        }
    );

    createdMenuItemId =
        newItem.data?.id;

    pass(
        `Menu item created: ID ${createdMenuItemId}`
    );


    // ==================================================
    // 8. TOGGLE MENU ITEM
    // ==================================================

    logStep(
        '8',
        'Admin toggles menu item OFF...'
    );

    const toggled = await api(
        `/api/menu/items/${createdMenuItemId}/toggle`,
        {
            method: 'PATCH',

            headers: {
                Authorization:
                    `Bearer ${adminToken}`
            },

            body: JSON.stringify({
                is_available: false
            })
        }
    );

    pass(
        `Item availability: ${toggled.data?.is_available}`
    );


    // Turn it back ON
    await api(
        `/api/menu/items/${createdMenuItemId}/toggle`,
        {
            method: 'PATCH',

            headers: {
                Authorization:
                    `Bearer ${adminToken}`
            },

            body: JSON.stringify({
                is_available: true
            })
        }
    );

    pass(
        'Test menu item restored to available'
    );


    // ==================================================
    // 9. ADMIN ALL ORDERS
    // ==================================================

    logStep(
        '9',
        'Admin GET all orders...'
    );

    const allOrders = await api(
        '/api/orders/all',
        {
            headers: {
                Authorization:
                    `Bearer ${adminToken}`
            }
        }
    );

    pass(
        `Total orders: ${allOrders.data?.total ?? 0}`
    );


    // ==================================================
    // 10. CUSTOMER LOGIN
    // ==================================================

    logStep(
        '10',
        'Customer OTP login...'
    );

    const customer = await loginWithOTP(
        USERS.customer
    );

    customerToken =
        customer.token;

    pass(
        `Customer JWT captured - role: ${customer.user.role}`
    );


    // ==================================================
    // 11. PLACE ORDER
    // ==================================================

    logStep(
        '11',
        'Customer places order...'
    );

    const order = await api(
        '/api/orders/place',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${customerToken}`
            },

            body: JSON.stringify({

                table_id: 1,

                restaurant_id:
                    RESTAURANT_ID,

                phone:
                    USERS.customer.phone,

                name:
                    USERS.customer.name,

                items: [

                    {
                        menu_item_id: 1,
                        quantity: 2,
                        modifiers: [1],

                        special_instructions:
                            'Less spicy please'
                    },

                    {
                        menu_item_id: 7,
                        quantity: 1,
                        modifiers: []
                    }

                ],

                notes:
                    'Automated API test order'
            })
        }
    );

    orderId =
        order.data?.order_id;

    sessionId =
        order.data?.session_id;

    pass(
        `Order created: ${orderId}`
    );

    pass(
        `Session created: ${sessionId}`
    );

    pass(
        `Final amount: ${order.data?.summary?.final_amount}`
    );


    // ==================================================
    // 12. CUSTOMER MY ORDERS
    // ==================================================

    logStep(
        '12',
        'Customer GET my orders...'
    );

    const myOrders = await api(
        `/api/orders/my-orders?session_id=${sessionId}`,
        {
            headers: {
                Authorization:
                    `Bearer ${customerToken}`
            }
        }
    );

    pass(
        `My orders returned: ${myOrders.data?.length ?? 0}`
    );


    // ==================================================
    // 13. KITCHEN LOGIN
    // ==================================================

    logStep(
        '13',
        'Kitchen OTP login...'
    );

    const kitchen = await loginWithOTP(
        USERS.kitchen
    );

    kitchenToken =
        kitchen.token;

    pass(
        `Kitchen JWT captured - role: ${kitchen.user.role}`
    );


    // ==================================================
    // 14. KITCHEN ORDERS
    // ==================================================

    logStep(
        '14',
        'Kitchen GET active orders...'
    );

    const kitchenOrders = await api(
        '/api/orders/kitchen',
        {
            headers: {
                Authorization:
                    `Bearer ${kitchenToken}`
            }
        }
    );

    const kitchenList =
        kitchenOrders.data?.orders ?? [];

    const placedOrder = kitchenList.find(
        (o) => o.id === orderId
    );

    if (!placedOrder) {

        throw new Error(
            `Order ${orderId} not found in kitchen queue`
        );
    }

    pass(
        `Kitchen orders returned: ${kitchenOrders.data?.total_active ?? kitchenList.length}`
    );

    pass(
        `Test order visible in KDS - ${placedOrder.minutes_ago} min ago, ` +
        `${placedOrder.items?.length ?? 0} item(s)`
    );


    // ==================================================
    // 15. ACCEPT ORDER
    // ==================================================

    logStep(
        '15',
        'Kitchen accepts test order...'
    );

    const status = await api(
        `/api/orders/${orderId}/status`,
        {
            method: 'PATCH',

            headers: {
                Authorization:
                    `Bearer ${kitchenToken}`
            },

            body: JSON.stringify({
                status: 'accepted'
            })
        }
    );

    pass(
        `Order status: ${status.data?.status}`
    );


    // ==================================================
    // 16. WAITER LOGIN
    // ==================================================

    logStep(
        '16',
        'Waiter OTP login...'
    );

    const waiter = await loginWithOTP(
        USERS.waiter
    );

    waiterToken =
        waiter.token;

    pass(
        `Waiter JWT captured - role: ${waiter.user.role}`
    );


    // ==================================================
    // 17. WAITER TABLES
    // ==================================================

    logStep(
        '17',
        'Waiter GET all tables...'
    );

    const waiterTables = await api(
        '/api/tables/all',
        {
            headers: {
                Authorization:
                    `Bearer ${waiterToken}`
            }
        }
    );

    pass(
        `Waiter tables returned: ${waiterTables.data?.length ?? 0}`
    );


    // ==================================================
    // 18. BILL
    // ==================================================

    logStep(
        '18',
        `Waiter GET bill for session ${sessionId}...`
    );

    const bill = await api(
        `/api/orders/bill/${sessionId}`,
        {
            headers: {
                Authorization:
                    `Bearer ${waiterToken}`
            }
        }
    );

    pass(
        `Subtotal: ${bill.data?.summary?.subtotal}`
    );

    pass(
        `CGST: ${bill.data?.summary?.cgst}`
    );

    pass(
        `SGST: ${bill.data?.summary?.sgst}`
    );

    pass(
        `Service Charge: ${bill.data?.summary?.service_charge}`
    );

    pass(
        `Final Amount: ${bill.data?.summary?.final_amount}`
    );


    // ==================================================
    // 19. RAZORPAY ORDER CREATE
    // ==================================================

    logStep(
        '19',
        'Customer creates Razorpay payment order...'
    );

    const payAmount =
        bill.data?.summary?.final_amount;

    const paymentOrder = await api(
        '/api/payments/create',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${customerToken}`
            },

            body: JSON.stringify({
                session_id: sessionId,
                amount: payAmount,
                payment_method: 'upi'
            })
        }
    );

    const razorpayOrderId =
        paymentOrder.data?.razorpay_order_id;

    if (!razorpayOrderId) {

        throw new Error(
            'razorpay_order_id was not returned'
        );
    }

    pass(
        `Razorpay order created: ${razorpayOrderId}`
    );

    pass(
        `Amount in paisa: ${paymentOrder.data?.amount_in_paisa}`
    );


    // ==================================================
    // 20. REJECT FAKE SIGNATURE
    // ==================================================

    logStep(
        '20',
        'Payment verify with FAKE signature (must fail)...'
    );

    await expectFailure(
        '/api/payments/verify',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${customerToken}`
            },

            body: JSON.stringify({
                razorpay_order_id: razorpayOrderId,
                razorpay_payment_id: 'pay_fake_signature',
                razorpay_signature: 'deadbeef',
                session_id: sessionId
            })
        },
        400
    );

    pass(
        'Fake signature rejected (fraud protection working)'
    );


    // ==================================================
    // 21. VERIFY PAYMENT (valid signature)
    // ==================================================

    logStep(
        '21',
        'Payment verify with VALID signature...'
    );

    // Fake payment record left the row in "failed" state, reset it
    await pool.query(
        `UPDATE payments SET status = 'pending'
         WHERE razorpay_order_id = $1`,
        [razorpayOrderId]
    );

    const fakePaymentId =
        `pay_test_${Date.now()}`;

    // Razorpay jaisa hi signature banao: HMAC-SHA256(order_id|payment_id, key_secret)
    const validSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${fakePaymentId}`)
        .digest('hex');

    const verified = await api(
        '/api/payments/verify',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${customerToken}`
            },

            body: JSON.stringify({
                razorpay_order_id: razorpayOrderId,
                razorpay_payment_id: fakePaymentId,
                razorpay_signature: validSignature,
                session_id: sessionId
            })
        }
    );

    pass(
        `Payment verified: ${verified.data?.payment_id}`
    );

    pass(
        `Status: ${verified.data?.status}, amount: ${verified.data?.amount}`
    );


    // ==================================================
    // 22. PAYMENT STATUS
    // ==================================================

    logStep(
        '22',
        'Customer checks payment status...'
    );

    const payStatus = await api(
        `/api/payments/status/${sessionId}`,
        {
            headers: {
                Authorization:
                    `Bearer ${customerToken}`
            }
        }
    );

    const successPayment =
        (payStatus.data || []).find(
            (p) => p.status === 'success'
        );

    if (!successPayment) {

        throw new Error(
            'No successful payment found for session'
        );
    }

    pass(
        `Payment records: ${payStatus.data.length}, ` +
        `success via ${successPayment.payment_method}`
    );


    // ==================================================
    // 23. WEBHOOK (payment.captured)
    // ==================================================

    logStep(
        '23',
        'Razorpay webhook simulation...'
    );

    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {

        console.log(
            '   ⏭️  RAZORPAY_WEBHOOK_SECRET not set - skipping webhook test'
        );

    } else {

        const webhookOrder =
            await placeSimpleOrder(
                customerToken,
                'Webhook test order'
            );

        const webhookPayment = await api(
            '/api/payments/create',
            {
                method: 'POST',

                headers: {
                    Authorization:
                        `Bearer ${customerToken}`
                },

                body: JSON.stringify({
                    session_id: webhookOrder.sessionId,
                    amount: webhookOrder.amount,
                    payment_method: 'upi'
                })
            }
        );

        const webhookRzpOrderId =
            webhookPayment.data?.razorpay_order_id;

        const webhookBody = JSON.stringify({
            event: 'payment.captured',

            payload: {
                payment: {
                    entity: {
                        id: `pay_webhook_${Date.now()}`,
                        order_id: webhookRzpOrderId,
                        amount: Math.round(webhookOrder.amount * 100)
                    }
                }
            }
        });

        const webhookSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
            .update(webhookBody)
            .digest('hex');

        // Galat signature reject hona chahiye
        await expectFailure(
            '/api/payments/webhook',
            {
                method: 'POST',

                headers: {
                    'x-razorpay-signature': 'invalid'
                },

                body: webhookBody
            },
            400
        );

        pass(
            'Webhook with invalid signature rejected'
        );

        await api(
            '/api/payments/webhook',
            {
                method: 'POST',

                headers: {
                    'x-razorpay-signature': webhookSignature
                },

                body: webhookBody
            }
        );

        const webhookSession = await pool.query(
            'SELECT status FROM order_sessions WHERE id = $1',
            [webhookOrder.sessionId]
        );

        if (webhookSession.rows[0]?.status !== 'paid') {

            throw new Error(
                `Webhook did not mark session paid (status: ${webhookSession.rows[0]?.status})`
            );
        }

        pass(
            `Webhook processed - session ${webhookOrder.sessionId} marked paid`
        );
    }


    // ==================================================
    // 24. CASH PAYMENT
    // ==================================================

    logStep(
        '24',
        'Waiter records cash payment...'
    );

    const cashOrder =
        await placeSimpleOrder(
            customerToken,
            'Cash payment test order'
        );

    await api(
        '/api/payments/cash',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${waiterToken}`
            },

            body: JSON.stringify({
                session_id: cashOrder.sessionId,
                amount: cashOrder.amount
            })
        }
    );

    const cashSession = await pool.query(
        'SELECT status FROM order_sessions WHERE id = $1',
        [cashOrder.sessionId]
    );

    if (cashSession.rows[0]?.status !== 'paid') {

        throw new Error(
            'Cash payment did not mark session as paid'
        );
    }

    pass(
        `Cash payment recorded - session ${cashOrder.sessionId} paid`
    );


    // ==================================================
    // 25. CUSTOMER CANNOT RECORD CASH PAYMENT
    // ==================================================

    logStep(
        '25',
        'Customer tries cash payment (must be forbidden)...'
    );

    await expectFailure(
        '/api/payments/cash',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${customerToken}`
            },

            body: JSON.stringify({
                session_id: cashOrder.sessionId,
                amount: 1
            })
        },
        403
    );

    pass(
        'Role check working - customer blocked from cash payment'
    );


    // ==================================================
    // 26. ADMIN REPORTS
    // ==================================================

    logStep(
        '26',
        'Admin fetches all reports...'
    );

    const adminHeaders = {
        Authorization: `Bearer ${adminToken}`
    };

    const dashboard = await api(
        '/api/reports/dashboard',
        { headers: adminHeaders }
    );

    pass(
        `Dashboard loaded: ${Object.keys(dashboard.data || {}).length} section(s)`
    );

    const topItems = await api(
        '/api/reports/top-items',
        { headers: adminHeaders }
    );

    pass(
        `Top items report loaded`
    );

    const revenue = await api(
        '/api/reports/revenue',
        { headers: adminHeaders }
    );

    pass(
        'Revenue report loaded'
    );

    const peakHours = await api(
        '/api/reports/peak-hours',
        { headers: adminHeaders }
    );

    pass(
        'Peak hours report loaded'
    );

    const staffReport = await api(
        '/api/reports/staff',
        { headers: adminHeaders }
    );

    pass(
        `Staff report loaded: ${staffReport.data?.length ?? 0} row(s)`
    );

    const now = new Date();

    const gstReport = await api(
        `/api/reports/gst?month=${now.getMonth() + 1}&year=${now.getFullYear()}`,
        { headers: adminHeaders }
    );

    pass(
        'GST report loaded'
    );


    // ==================================================
    // 27. REPORTS ARE ADMIN-ONLY
    // ==================================================

    logStep(
        '27',
        'Waiter tries admin report (must be forbidden)...'
    );

    await expectFailure(
        '/api/reports/revenue',
        {
            headers: {
                Authorization:
                    `Bearer ${waiterToken}`
            }
        },
        403
    );

    pass(
        'Reports correctly restricted to admin'
    );


    // ==================================================
    // SUCCESS
    // ==================================================

    console.log('');
    console.log('==============================================');
    console.log('             ALL TESTS PASSED ✅');
    console.log('==============================================');

    console.log(
        `Order ID  : ${orderId}`
    );

    console.log(
        `Session ID: ${sessionId}`
    );

    console.log(
        'Admin     : JWT captured ✅'
    );

    console.log(
        'Customer  : JWT captured ✅'
    );

    console.log(
        'Kitchen   : JWT captured ✅'
    );

    console.log(
        'Waiter    : JWT captured ✅'
    );

    console.log('==============================================');
    console.log('');
}


// ==================================================
// RUN
// ==================================================

main()

    .catch((error) => {

        console.log('');
        console.log('==============================================');
        console.log('              TEST FAILED ❌');
        console.log('==============================================');

        console.error(
            `Message: ${error.message}`
        );

        if (error.status) {
            console.error(
                `HTTP Status: ${error.status}`
            );
        }

        if (error.body) {

            console.error(
                'Response:',
                JSON.stringify(
                    error.body,
                    null,
                    2
                )
            );
        }

        console.log(
            '=============================================='
        );

        process.exitCode = 1;
    })

    .finally(async () => {

        await pool.end();

    });