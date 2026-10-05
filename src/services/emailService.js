const nodemailer = require('nodemailer');

/**
 * Email delivery for AuditIQ.
 *
 * The report email is built with tables + inline styles on purpose: Gmail,
 * Outlook and Apple Mail ignore <style> blocks and flexbox/grid, so anything
 * else falls apart in real inboxes. Layout is a single 600px column that
 * shrinks cleanly on phones. A plain-text version is sent too (better spam
 * scores, and readable in clients that block HTML).
 */

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

const C = {
  ink: '#1a1a2e', soft: '#6b6b80', violet: '#5b4bdb', bg: '#f3f3f8', line: '#e6e6ef',
  good: '#1a7a4a', okay: '#b8860b', poor: '#a1121a',
};
const band = (n) => (typeof n !== 'number' ? C.soft : n >= 80 ? C.good : n >= 50 ? C.okay : C.poor);
const bandLabel = (n) => (typeof n !== 'number' ? 'Not available' : n >= 80 ? 'Good' : n >= 50 ? 'Okay' : 'Needs work');
const sevColor = (s) => ({ high: C.poor, med: C.okay, low: C.soft }[s] || C.soft);
const sevLabel = (s) => ({ high: 'HIGH', med: 'MEDIUM', low: 'LOW' }[s] || 'LOW');

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function baseUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
}

const LABELS = { speed: 'Speed', uiux: 'UI/UX', technology: 'Technology', seo: 'SEO', security: 'Security', social: 'Social media' };

function button(href, text, filled = true) {
  const style = filled
    ? `background:${C.violet};color:#ffffff;border:1px solid ${C.violet};`
    : `background:#ffffff;color:${C.violet};border:1px solid ${C.violet};`;
  return `<a href="${esc(href)}" style="${style}display:inline-block;padding:13px 26px;border-radius:8px;font:600 15px/1 Arial,Helvetica,sans-serif;text-decoration:none;">${esc(text)}</a>`;
}

function wrapEmail({ preheader, body }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${C.line};">
    <tr><td style="background:${C.violet};padding:22px 32px;font:700 20px Arial,Helvetica,sans-serif;color:#ffffff;">AuditIQ</td></tr>
    ${body}
    <tr><td style="padding:22px 32px;background:${C.bg};font:12px/1.6 Arial,Helvetica,sans-serif;color:${C.soft};">
      You're getting this because you requested a website audit on AuditIQ. Speed data comes from Google PageSpeed Insights; the design review is an AI assessment of page screenshots and is advisory.
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function scoreBar(score) {
  if (typeof score !== 'number') {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.line};border-radius:4px;"><tr><td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr></table>`;
  }
  const w = Math.max(4, Math.min(100, score));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.line};border-radius:4px;"><tr>
    <td width="${w}%" style="background:${band(score)};height:8px;line-height:8px;font-size:0;border-radius:4px;">&nbsp;</td>
    <td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/**
 * @param {object} p { name, url, formatted, jobId, hasAttachment }
 * @returns {{ subject, html, text }}
 */
function buildReportEmail({ name, url, formatted, jobId, hasAttachment }) {
  const overall = formatted.overallScore;
  const host = String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const app = baseUrl();
  const reportLink = `${app}/audit-result.html?jobId=${encodeURIComponent(jobId || '')}&site=${encodeURIComponent(host)}`;
  const pdfLink = `${app}/api/audit/${encodeURIComponent(jobId || '')}/report.pdf`;
  const consultLink = `${app}/consult.html`;

  const all = [...(formatted.findings || []), ...(formatted.lockedFindings || [])];
  const order = { high: 0, med: 1, low: 2 };
  const top = all.slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)).slice(0, 5);
  const highCount = all.filter((f) => f.severity === 'high').length;

  const rows = Object.entries(formatted.categories || {}).map(([key, cat]) => `
    <tr>
      <td style="padding:9px 0;font:600 14px Arial,Helvetica,sans-serif;color:${C.ink};width:115px;">${esc(LABELS[key] || key)}</td>
      <td style="padding:9px 12px;">${scoreBar(cat.score)}</td>
      <td align="right" style="padding:9px 0;font:700 14px Arial,Helvetica,sans-serif;color:${band(cat.score)};width:64px;white-space:nowrap;">${typeof cat.score === 'number' ? cat.score : '—'}</td>
    </tr>`).join('');

  const issues = top.map((f) => `
    <tr><td style="padding:12px 0;border-top:1px solid ${C.line};">
      <span style="display:inline-block;font:700 10px Arial,Helvetica,sans-serif;letter-spacing:.06em;color:#ffffff;background:${sevColor(f.severity)};padding:3px 7px;border-radius:4px;">${sevLabel(f.severity)}</span>
      <span style="font:700 11px Arial,Helvetica,sans-serif;color:${C.soft};letter-spacing:.04em;text-transform:uppercase;padding-left:6px;">${esc(f.category)}</span>
      <div style="font:14px/1.55 Arial,Helvetica,sans-serif;color:${C.ink};padding-top:6px;">${esc(f.text.split(' Fix: ')[0])}</div>${f.text.includes(' Fix: ') ? `<div style="font:14px/1.55 Arial,Helvetica,sans-serif;color:${C.good};padding-top:4px;"><strong>How to fix:</strong> ${esc(f.text.split(' Fix: ').slice(1).join(' Fix: '))}</div>` : ''}
    </td></tr>`).join('');

  const uiux = formatted.categories?.uiux;
  const verdict = uiux?.verdict
    ? `<tr><td style="padding:0 32px 8px;">
        <div style="background:${C.bg};border-left:4px solid ${C.violet};border-radius:6px;padding:14px 16px;font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.ink};">
          <strong>What a visitor sees first:</strong> ${esc(uiux.verdict)}
        </div></td></tr>` : '';

  const body = `
    <tr><td style="padding:32px 32px 8px;">
      <div style="font:700 24px/1.3 Arial,Helvetica,sans-serif;color:${C.ink};">Hi${name ? ' ' + esc(String(name).split(' ')[0]) : ''}, your report is ready</div>
      <div style="font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.soft};padding-top:6px;">Full audit for <strong style="color:${C.violet};">${esc(host)}</strong></div>
    </td></tr>

    <tr><td style="padding:16px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};border-radius:12px;"><tr>
        <td width="120" align="center" style="padding:22px 0 22px 22px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" width="92" height="92" style="width:92px;height:92px;border-radius:46px;border:6px solid ${band(overall)};background:#ffffff;font:700 32px Arial,Helvetica,sans-serif;color:${band(overall)};">${typeof overall === 'number' ? overall : '—'}</td></tr></table>
        </td>
        <td style="padding:22px;font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.ink};">
          <div style="font:700 17px Arial,Helvetica,sans-serif;color:${band(overall)};">${bandLabel(overall)}</div>
          <div style="color:${C.soft};">Overall score out of 100. We found <strong style="color:${C.ink};">${all.length} issue${all.length === 1 ? '' : 's'}</strong>${highCount ? `, <strong style="color:${C.poor};">${highCount} high priority</strong>` : ''}.</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:8px 32px 4px;font:700 16px Arial,Helvetica,sans-serif;color:${C.ink};">Score by area</td></tr>
    <tr><td style="padding:0 32px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>

    ${verdict}

    <tr><td style="padding:16px 32px 4px;font:700 16px Arial,Helvetica,sans-serif;color:${C.ink};">Fix these first</td></tr>
    <tr><td style="padding:0 32px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${issues || `<tr><td style="font:14px Arial;color:${C.good};padding:8px 0;">No issues detected.</td></tr>`}</table></td></tr>

    <tr><td align="center" style="padding:24px 32px 6px;">${button(reportLink, 'View full report online')}</td></tr>
    <tr><td align="center" style="padding:10px 32px 6px;font:13px/1.5 Arial,Helvetica,sans-serif;color:${C.soft};">
      ${hasAttachment ? 'The complete PDF report, with your site screenshots marked up, is attached. ' : ''}<a href="${esc(pdfLink)}" style="color:${C.violet};">Download the PDF</a>
    </td></tr>

    <tr><td style="padding:22px 32px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:12px;"><tr><td style="padding:20px;">
        <div style="font:700 16px Arial,Helvetica,sans-serif;color:${C.ink};">Want us to fix these for you?</div>
        <div style="font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.soft};padding:6px 0 14px;">Book a free 20-minute call and we'll walk through the report and what to do first.</div>
        ${button(consultLink, 'Book a free consultation', false)}
      </td></tr></table>
    </td></tr>`;

  const text = [
    `Hi${name ? ' ' + String(name).split(' ')[0] : ''}, your AuditIQ report for ${host} is ready.`,
    '',
    `Overall score: ${typeof overall === 'number' ? overall : 'n/a'}/100 (${bandLabel(overall)}) - ${all.length} issue(s) found.`,
    '',
    ...Object.entries(formatted.categories || {}).map(([k, c]) => `  ${LABELS[k] || k}: ${typeof c.score === 'number' ? c.score + '/100' : 'n/a'}`),
    '',
    'Fix these first:',
    ...top.map((f, i) => `  ${i + 1}. [${sevLabel(f.severity)}] ${f.category}: ${f.text}`),
    '',
    `Full report: ${reportLink}`,
    `PDF: ${pdfLink}`,
    `Free consultation: ${consultLink}`,
  ].join('\n');

  return {
    subject: `Your website audit for ${host}: ${typeof overall === 'number' ? overall + '/100' : 'report ready'}`,
    html: wrapEmail({ preheader: `Overall ${typeof overall === 'number' ? overall : '—'}/100 · ${all.length} issues found · full PDF inside`, body }),
    text,
  };
}

function buildNewsletterEmail() {
  const body = `<tr><td style="padding:32px;">
    <div style="font:700 22px/1.3 Arial,Helvetica,sans-serif;color:${C.ink};">You're on the list</div>
    <div style="font:14px/1.7 Arial,Helvetica,sans-serif;color:${C.soft};padding:10px 0 18px;">Once a month we'll email you your score trend and the single most valuable fix to make next.</div>
    ${button(baseUrl(), 'Run a new audit')}
  </td></tr>`;
  return {
    subject: "You're on the AuditIQ monthly re-audit list",
    html: wrapEmail({ preheader: 'One email a month: your score trend and top fix.', body }),
    text: "Thanks for subscribing. Once a month you'll get your score trend and the top fix.",
  };
}

async function sendMail({ to, subject, html, text, attachments }) {
  return getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"AuditIQ" <${process.env.SMTP_USER}>`,
    to, subject, html, text, attachments,
  });
}

module.exports = { sendMail, buildReportEmail, buildNewsletterEmail };
