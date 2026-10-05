const express = require('express');
const { requestConsultation } = require('../controllers/consult.controller');

const router = express.Router();

router.post('/', requestConsultation);

module.exports = router;
