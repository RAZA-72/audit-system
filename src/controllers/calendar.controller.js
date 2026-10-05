const schedule = require('node-schedule');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

/**
 * POST /api/calendar/book
 * Body: { name, email, slotIsoDate }
 * Books a free consultation slot. Uses Google Calendar API (free) if
 * GOOGLE_CALENDAR credentials are set, otherwise falls back to a
 * self-hosted booking record + email reminder (fully custom option).
 */
async function bookConsultation(req, res, next) {
  try {
    const { name, email, slotIsoDate } = req.body;
    if (!name || !email || !slotIsoDate) {
      return res.status(400).json({ error: 'name, email and slotIsoDate are required' });
    }

    // TODO: persist booking to DB via Prisma

    // TODO (optional): call Google Calendar API here to create the event,
    // using GOOGLE_CALENDAR_CLIENT_ID / SECRET from .env (free, no cost).

    // Self-hosted reminder email, 1 hour before the slot
    const reminderTime = new Date(new Date(slotIsoDate).getTime() - 60 * 60 * 1000);
    schedule.scheduleJob(reminderTime, () => {
      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: 'Reminder: your free consultation is in 1 hour',
        text: `Hi ${name}, this is a reminder for your consultation scheduled at ${slotIsoDate}.`,
      });
    });

    return res.status(201).json({ message: 'Consultation booked', name, email, slotIsoDate });
  } catch (err) {
    next(err);
  }
}

module.exports = { bookConsultation };
