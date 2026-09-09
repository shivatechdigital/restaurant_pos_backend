const express = require('express');
const router = express.Router();
const InventoryController = require('../controllers/inventoryController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin', 'kitchen'));

router.post('/requests', InventoryController.createRequest);
router.get('/requests', InventoryController.getRequests);
router.patch('/requests/:id/status', InventoryController.updateRequestStatus);

router.get('/materials', InventoryController.getMaterials);
router.post('/materials', InventoryController.upsertMaterial);
router.put('/materials/:id/adjust', InventoryController.adjustMaterial);

router.get('/vendors', InventoryController.getVendors);
router.post('/vendors', InventoryController.createVendor);

router.get('/purchases', InventoryController.getPurchases);
router.post('/purchases', InventoryController.createPurchase);

router.get('/ledger', InventoryController.getLedger);
router.get('/low-stock', InventoryController.getLowStock);

router.get('/recipes/:menu_item_id', InventoryController.getRecipe);
router.post('/recipes/:menu_item_id', InventoryController.saveRecipe);

module.exports = router;
