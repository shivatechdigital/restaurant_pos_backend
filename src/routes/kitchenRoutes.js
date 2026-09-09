const express = require('express');
const router = express.Router();
const KitchenController = require('../controllers/kitchenController');
const { authenticate, authorize } = require('../middleware/auth');

// Saare routes kitchen/admin ke liye
router.use(authenticate, authorize('admin', 'kitchen', 'waiter'));

// Stats
router.get('/stats', KitchenController.getStats);

// History
router.get('/history', KitchenController.getHistory);

// Sections
router.get('/sections', KitchenController.getKitchenSections);

// Recall order
router.post('/recall/:order_id', KitchenController.recallOrder);

// Trend report
router.get('/trends', KitchenController.getTrendReport);

module.exports = router;
