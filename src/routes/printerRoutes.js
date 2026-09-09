const express = require('express');
const router = express.Router();
const PrinterController = require('../controllers/printerController');
const { authenticate, authorize } = require('../middleware/auth');
router.use(authenticate, authorize('admin', 'kitchen'));
router.get('/jobs/next', PrinterController.getNextJob);
router.post('/jobs/:id/complete', PrinterController.completeJob);
module.exports = router;