const express = require('express');
const { body } = require('express-validator');
const { captureLead } = require('../controllers/lead.controller');

const router = express.Router();

router.post(
  '/',
  [
    // Only email is always required - the footer "Notify Me" form sends
    // email alone; the gate-form on audit-result.html also sends name,
    // and an optional phone.
    body('email').trim().isEmail().withMessage('Valid email is required'),
    body('name').optional({ checkFalsy: true }).trim().notEmpty(),
    body('phone').optional({ checkFalsy: true }).trim(),
    body('url').optional({ checkFalsy: true }).trim(),
    body('jobId').optional({ checkFalsy: true }).trim(),
  ],
  captureLead
);

module.exports = router;
