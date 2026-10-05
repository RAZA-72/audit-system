const express = require('express');
const { startTrial } = require('../controllers/subscription.controller');

const router = express.Router();

router.post('/trial', startTrial);

module.exports = router;
