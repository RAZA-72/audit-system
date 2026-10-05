const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

/**
 * POST /api/subscription/trial
 * Matches subscription.html's "Start your 7-day free trial" form:
 * name, email, phone, url (website to monitor), plan (Starter/Growth/Agency).
 * Payment is intentionally not wired up here - this just captures the lead
 * and starts a free trial record. Add billing later if/when needed.
 */
async function startTrial(req, res, next) {
  try {
    const { name, email, phone, url, plan } = req.body;

    if (!name || !email || !phone || !url) {
      return res.status(400).json({ error: 'name, email, phone and url are required' });
    }

    // TODO: persist to DB via Prisma, e.g.
    // prisma.subscription.create({ data: { email, plan, status: 'trial', trialEndsAt: addDays(new Date(), 7) } })

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject: 'Your AuditIQ Monitoring free trial has started',
      text: `Hi ${name}, your 7-day free trial for ${url} (${plan} plan) has started. We'll remind you 3 days before it ends.`,
    });

    return res.status(201).json({ message: 'Trial started', plan, url });
  } catch (err) {
    next(err);
  }
}

module.exports = { startTrial };
