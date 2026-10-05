const express = require('express');
const { bookConsultation } = require('../controllers/calendar.controller');

const router = express.Router();

router.post('/book', bookConsultation);

module.exports = router;
