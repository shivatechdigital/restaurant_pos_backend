const express = require('express');
const router = express.Router();
const TableController = require('../controllers/tableController');
const { authenticate, authorize } = require('../middleware/auth');

// Customer QR Scan karega
router.get('/scan', TableController.scanTable);

// Customer OTP se table lock karega
router.post('/lock', TableController.lockTable);

// Waiter/Admin saari tables dekhega
router.get('/all', authenticate, authorize('admin', 'waiter', 'reception'), TableController.getAllTables);

// Admin/Waiter table ko clean/available/out-of-service mark karega (unpaid bill hone par block hoga)
router.patch('/:id/status', authenticate, authorize('admin', 'waiter', 'reception'), TableController.updateStatus);

// Sirf Admin table delete kar sakta hai (soft delete, sirf available tables)
router.delete('/:id', authenticate, authorize('admin'), TableController.deleteTable);

module.exports = router;