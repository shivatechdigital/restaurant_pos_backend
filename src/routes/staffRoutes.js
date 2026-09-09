const express = require('express');
const router = express.Router();
const StaffController = require('../controllers/staffController');
const AuditController = require('../controllers/auditController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin'));
router.get('/', StaffController.getStaff);
router.post('/', StaffController.createStaff);
router.patch('/:id', StaffController.updateStaff);
router.get('/audit/logs', AuditController.getLogs);

module.exports = router;