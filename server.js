require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const auditRoutes = require('./src/routes/audit.routes');
const leadRoutes = require('./src/routes/lead.routes');
const calendarRoutes = require('./src/routes/calendar.routes');
const consultRoutes = require('./src/routes/consult.routes');
const subscriptionRoutes = require('./src/routes/subscription.routes');
const errorHandler = require('./src/middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 4000;

// --- Core middleware ---
// helmet's default CSP is relaxed here because the front-end pulls
// Bootstrap + Google Fonts from public CDNs (see public/*.html <head>).
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// --- Serve the AuditIQ front-end (public/index.html, audit-result.html, etc.) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Health check ---
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// --- API routes ---
app.use('/api/audit', auditRoutes);             // Speed, UI/UX, SEO, Technology, Security, Social
app.use('/api/lead', leadRoutes);               // Name, Phone, Email capture (gate-form + footer notify-me)
app.use('/api/calendar', calendarRoutes);       // Free consultation slot booking
app.use('/api/consult', consultRoutes);         // consult.html "Request My Free Consultation" form
app.use('/api/subscription', subscriptionRoutes); // subscription.html "Start Free Trial" form

// --- 404 handler (JSON APIs only; static files are handled above) ---
app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));

// --- Central error handler ---
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Audit System API running on http://localhost:${PORT}`);
});
