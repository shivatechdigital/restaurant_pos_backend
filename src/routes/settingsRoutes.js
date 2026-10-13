const express = require('express');
const router = express.Router();
const SettingsController = require('../controllers/settingsController');
const { authenticate, authorize } = require('../middleware/auth');

// Public route for customer app (dynamic restaurant info by id or query)
router.get('/public-restaurant', SettingsController.getPublicRestaurantInfo);
router.get('/public-restaurant/:id', SettingsController.getPublicRestaurantInfo);

// Kitchen & Cancellation Order Policy
router.get('/order-policy', authenticate, SettingsController.getSettings);
router.patch('/order-policy', authenticate, authorize('admin'), SettingsController.updateSettings);

// Restaurant Profile (Admin / Multiple Restaurants)
router.get('/restaurant', authenticate, authorize('admin', 'reception'), SettingsController.getRestaurantProfile);
router.patch('/restaurant', authenticate, authorize('admin'), SettingsController.updateRestaurantProfile);

module.exports = router;