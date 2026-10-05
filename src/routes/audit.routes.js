const express = require('express');
const { requestAudit, getAuditStatus, downloadReport, getScreenshot } = require('../controllers/audit.controller');

const router = express.Router();

// Kick off a new audit (returns immediately with a jobId)
router.post('/', requestAudit);

// Download the PDF report - must be declared before the /:jobId route so
// "report.pdf" isn't swallowed as a jobId.
router.get('/:jobId/report.pdf', downloadReport);

router.get('/:jobId/screenshot/:index', getScreenshot);

// Poll for status / result
router.get('/:jobId', getAuditStatus);

module.exports = router;
