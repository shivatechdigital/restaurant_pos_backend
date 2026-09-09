const express = require('express');
const router = express.Router();
const MenuController = require('../controllers/menuController');
const { authenticate, authorize } = require('../middleware/auth');

// =============================================
// PUBLIC ROUTES (Customer ke liye - No Auth)
// =============================================

// GET /api/menu?restaurant_id=1
// QR scan karne par customer yeh call karega
router.get('/', MenuController.getFullMenu);

// GET /api/menu/search?restaurant_id=1&keyword=paneer
router.get('/search', MenuController.searchMenu);

// =============================================
// ADMIN ROUTES (Auth + Admin Role Required)
// =============================================

// --- Categories ---
router.post('/categories', authenticate, authorize('admin'), MenuController.createCategory);
router.put('/categories/:id', authenticate, authorize('admin'), MenuController.updateCategory);
router.delete('/categories/:id', authenticate, authorize('admin'), MenuController.deleteCategory);

// --- Menu Items ---
router.post('/items', authenticate, authorize('admin'), MenuController.createMenuItem);
router.put('/items/:id', authenticate, authorize('admin'), MenuController.updateMenuItem);
router.delete('/items/:id', authenticate, authorize('admin'), MenuController.deleteMenuItem);

// Image upload (multipart form field: "image")
router.post('/upload-image', authenticate, authorize('admin'), MenuController.uploadMiddleware, MenuController.uploadImage);

// Quick toggle: Item available / out of stock
router.patch('/items/:id/toggle', authenticate, authorize('admin'), MenuController.toggleAvailability);

// --- Modifiers ---
router.post('/modifiers', authenticate, authorize('admin'), MenuController.addModifier);
router.delete('/modifiers/:id', authenticate, authorize('admin'), MenuController.deleteModifier);

module.exports = router;