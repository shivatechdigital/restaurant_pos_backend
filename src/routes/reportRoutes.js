const express = require('express');
const router = express.Router();
const ReportController = require('../controllers/reportController');
const { authenticate, authorize } = require('../middleware/auth');

// Reception ko bhi read-only reports access chahiye; closing mutations remain protected below.
router.use(authenticate);
router.get('/dashboard', authorize('admin', 'reception'), ReportController.getDashboard);
router.get('/top-items', authorize('admin', 'reception'), ReportController.getTopItems);
router.get('/revenue', authorize('admin', 'reception'), ReportController.getRevenueReport);
router.get('/daily-closing/export', authorize('admin', 'reception'), ReportController.exportDailyClosing);
router.get('/export', authorize('admin', 'reception'), ReportController.exportReport);
router.use(authorize('admin'));

// Live Dashboard
// Daily cash reconciliation and closing snapshot
router.get('/daily-closing', ReportController.getDailyClosing);
router.post('/daily-closing', ReportController.closeDay);
router.delete('/daily-closing/:date', ReportController.reopenDay);
router.get('/cash-shifts', ReportController.getShifts);
router.post('/cash-shifts', ReportController.openShift);
router.post('/cash-shifts/:id/close', ReportController.closeShift);

// Top Selling Items
// Revenue Report (daily/weekly/monthly)

// Peak Hours
router.get('/peak-hours', ReportController.getPeakHours);

// Staff Performance
router.get('/staff', ReportController.getStaffPerformance);

// GST Report
router.get('/gst', ReportController.getGSTReport);

module.exports = router;