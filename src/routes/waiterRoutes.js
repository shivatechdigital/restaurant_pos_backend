const express = require('express');
const router = express.Router();
const WaiterController = require('../controllers/waiterController');
const TableOperationsController = require('../controllers/tableOperationsController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin', 'waiter', 'reception'));

router.get('/table/:table_id/sessions', WaiterController.getTableSessions);
router.post('/table/transfer', TableOperationsController.transferSession);
router.post('/table/merge', TableOperationsController.mergeSessions);

module.exports = router;
