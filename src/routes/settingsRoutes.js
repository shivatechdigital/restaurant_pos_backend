const express = require('express');
const router = express.Router();
const SettingsController = require('../controllers/settingsController');
const { authenticate, authorize } = require('../middleware/auth');
router.get('/order-policy', authenticate, SettingsController.getSettings);
router.patch('/order-policy', authenticate, authorize('admin'), SettingsController.updateSettings);
module.exports = router;