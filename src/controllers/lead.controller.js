const { validationResult } = require('express-validator');
const { auditQueue } = require('../jobs/auditQueue');
const { formatAuditResult } = require('../utils/scoreFormatter');
const { buildAuditPdfBuffer } = require('../services/reportService');
const { sendMail, buildReportEmail, buildNewsletterEmail } = require('../services/emailService');

/**
 * POST /api/lead
 * Handles TWO front-end forms with the same endpoint:
 *   1. audit-result.html gate-form  -> { name, email, phone?, jobId, type: 'gate' }
 *   2. footer "Notify Me" form      -> { email, type: 'newsletter' }
 *
 * For the gate form we email a formatted HTML summary AND attach the full PDF
 * report. Email problems never block the unlock: the lead is still captured,
 * the response just carries emailSent:false so the UI can say so honestly.
 */
async function captureLead(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, phone, email, url, jobId, type } = req.body;
    const leadType = type === 'newsletter' ? 'newsletter' : 'gate';

    // TODO: persist to DB via Prisma, e.g.
    // prisma.lead.create({ data: { name, phone, email, url, jobId, type: leadType } })

    let emailSent = false;
    let emailError = null;

    try {
      if (leadType === 'newsletter') {
        await sendMail({ to: email, ...buildNewsletterEmail() });
        emailSent = true;
      } else {
        const job = jobId ? await auditQueue.getJob(jobId) : null;
        const state = job ? await job.getState() : null;

        if (job && state === 'completed' && job.returnvalue) {
          const raw = job.returnvalue;
          const formatted = formatAuditResult(raw);
          const host = String(raw.url).replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_').slice(0, 60);

          let pdf = null;
          try {
            pdf = await buildAuditPdfBuffer({ url: raw.url, generatedAt: raw.generatedAt, formatted, raw });
          } catch (pdfErr) {
            console.error('[lead] PDF build failed, sending email without attachment:', pdfErr.message);
          }

          const mail = buildReportEmail({ name, url: raw.url, formatted, jobId, hasAttachment: !!pdf });
          await sendMail({
            to: email,
            ...mail,
            attachments: pdf ? [{ filename: `audit-report-${host}.pdf`, content: pdf, contentType: 'application/pdf' }] : [],
          });
          emailSent = true;
        } else {
          emailError = 'Audit not finished or not found';
        }
      }
    } catch (mailErr) {
      emailError = mailErr.message;
      console.error('[lead] Email failed:', mailErr.message);
    }

    return res.status(201).json({ message: 'Lead captured', type: leadType, name, phone, email, url, jobId, emailSent, emailError });
  } catch (err) {
    next(err);
  }
}

module.exports = { captureLead };
