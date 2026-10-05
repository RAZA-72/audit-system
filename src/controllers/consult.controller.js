const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

/**
 * POST /api/consult
 * Matches consult.html's "Request My Free Consultation" form exactly:
 * name, email, phone, url, scoreFocus (select), budget (select), message (textarea).
 * This is a *request* (no slot chosen yet) - a human replies within one
 * business day, per the form's own copy. Actual slot booking (with a
 * specific date/time) goes through /api/calendar/book once a time is agreed.
 */
async function requestConsultation(req, res, next) {
  try {
    const { name, email, phone, url, scoreFocus, budget, message } = req.body;

    if (!name || !email || !phone || !url) {
      return res.status(400).json({ error: 'name, email, phone and url are required' });
    }

    // TODO: persist to DB via Prisma, e.g.
    // prisma.consultation.create({ data: { name, email, phone, url, scoreFocus, budget, message, status: 'requested' } })

    // Notify the internal team
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.SMTP_USER, // internal inbox - replace with sales/team address
      subject: `New consultation request: ${url}`,
      text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nURL: ${url}\nFocus: ${scoreFocus}\nBudget: ${budget}\nMessage: ${message || '(none)'}`,
    });

    // Confirm to the requester
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject: 'We got your AuditIQ consultation request',
      text: `Hi ${name}, thanks for reaching out about ${url}. A Milleniance Softnet specialist will email you a time slot within one business day.`,
    });

    return res.status(201).json({ message: 'Consultation request received' });
  } catch (err) {
    next(err);
  }
}

module.exports = { requestConsultation };
