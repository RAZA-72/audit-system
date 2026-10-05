const PDFDocument = require('pdfkit');

/**
 * Builds the downloadable PDF report and streams it straight to the HTTP
 * response - nothing is written to disk.
 *
 * This is what the "Download Full Report" button on audit-result.html calls.
 * Previously that button was a dead link; this is the missing piece.
 */

const INK = '#1a1a2e';
const VIOLET = '#5b4bdb';
const SOFT = '#6b6b80';
const GOOD = '#1a7a4a';
const OKAY = '#b8860b';
const POOR = '#a1121a';

function bandColor(score) {
  if (typeof score !== 'number') return SOFT;
  return score >= 80 ? GOOD : score >= 50 ? OKAY : POOR;
}

function sevColor(sev) {
  return { high: POOR, med: OKAY, low: SOFT }[sev] || SOFT;
}

function safeFileName(url) {
  return String(url).replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_').slice(0, 60);
}

/** Streams the PDF to an HTTP response (Download button). */
function streamAuditPdf(res, data) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="audit-report-${safeFileName(data.url)}.pdf"`);
  renderAuditPdf(res, data);
}

/** Builds the same PDF in memory - used to attach it to the email. */
function buildAuditPdfBuffer(data) {
  const { PassThrough } = require('stream');
  return new Promise((resolve, reject) => {
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', (c) => chunks.push(c));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try { renderAuditPdf(sink, data); } catch (e) { reject(e); }
  });
}

function renderAuditPdf(target, { url, generatedAt, formatted, raw }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  doc.pipe(target);

  /* ---------- cover ---------- */
  doc.fillColor(INK).fontSize(26).font('Helvetica-Bold').text('Website Audit Report', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(13).fillColor(VIOLET).font('Helvetica').text(url);
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor(SOFT).text(`Generated ${new Date(generatedAt).toLocaleString()}`);

  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(VIOLET).lineWidth(2).stroke();
  doc.moveDown(1.2);

  /* ---------- overall score ---------- */
  const overall = formatted.overallScore;
  doc.fontSize(11).fillColor(SOFT).font('Helvetica').text('OVERALL SCORE');
  doc.moveDown(0.2);

  const scoreY = doc.y;
  doc.fontSize(44).fillColor(bandColor(overall)).font('Helvetica-Bold').text(`${overall}`, 50, scoreY, { continued: true });
  doc.fontSize(16).fillColor(SOFT).font('Helvetica').text('  / 100');
  // The big glyph is ~44pt tall; park the cursor clear of it so the coverage
  // paragraph below can't overlap the score.
  doc.y = scoreY + 52;

  /* ---------- coverage ---------- */
  const cov = formatted.coverage;
  if (cov) {
    doc.fontSize(9).fillColor(SOFT).font('Helvetica')
      .text(`Pages audited: ${cov.pagesAudited} (discovered via ${cov.discoveryMethod}). `
        + `Per-page checks: ${(cov.perPageChecks || []).join(', ')}. `
        + `Entry page only: ${(cov.entryPageOnlyChecks || []).join(', ')}.`,
        { width: 495, lineGap: 1.5 });
    doc.moveDown(1);
  }

  /* ---------- category scores ---------- */
  sectionHeader(doc, 'Category Scores');

  const labels = {
    speed: 'Speed', uiux: 'UI/UX', technology: 'Technology',
    seo: 'SEO', security: 'Security', social: 'Social Media',
  };

  Object.entries(formatted.categories).forEach(([key, cat]) => {
    const y = doc.y;
    doc.fontSize(11).fillColor(INK).font('Helvetica-Bold').text(labels[key] || key, 50, y, { width: 150 });

    const scoreText = typeof cat.score === 'number' ? `${cat.score}/100` : 'Not available';
    doc.fillColor(bandColor(cat.score)).font('Helvetica-Bold').text(scoreText, 200, y, { width: 90 });
    doc.fillColor(SOFT).font('Helvetica').fontSize(10).text(cat.band, 295, y, { width: 100 });

    // score bar
    if (typeof cat.score === 'number') {
      const barX = 400; const barW = 145; const barY = y + 3;
      doc.roundedRect(barX, barY, barW, 8, 4).fillColor('#e8e8ef').fill();
      doc.roundedRect(barX, barY, Math.max(4, (barW * cat.score) / 100), 8, 4).fillColor(bandColor(cat.score)).fill();
    }

    doc.y = y + 20;
    if (cat.error) {
      doc.fontSize(8.5).fillColor(POOR).font('Helvetica-Oblique').text(`Could not complete: ${cat.error}`, 50, doc.y, { width: 495 });
      doc.moveDown(0.5);
    }
  });

  /* ---------- UI/UX verdict ---------- */
  const uiux = formatted.categories.uiux;
  if (uiux?.verdict) {
    doc.moveDown(0.8);
    sectionHeader(doc, 'What a visitor sees first');
    doc.fontSize(10.5).fillColor(INK).font('Helvetica').text(uiux.verdict, 50, doc.y, { width: 495, lineGap: 2 });

    if (uiux.strengths?.length) {
      doc.moveDown(0.6);
      doc.fontSize(10).fillColor(GOOD).font('Helvetica-Bold').text('Working well');
      doc.moveDown(0.2);
      uiux.strengths.forEach((s) => {
        doc.fontSize(9.5).fillColor(INK).font('Helvetica').text(`•  ${s}`, { width: 490, indent: 6, lineGap: 1.5 });
      });
    }
  }

  /* ---------- UI/UX: where the problems are ---------- */
  drawAnnotatedScreenshots(doc, raw?.uiux);

  /* ---------- all findings ---------- */
  doc.addPage();
  sectionHeader(doc, `All Issues Found (${formatted.totalFindings})`);
  doc.moveDown(0.2);

  const all = [...formatted.findings, ...formatted.lockedFindings];
  if (!all.length) {
    doc.fontSize(10.5).fillColor(GOOD).font('Helvetica').text('No issues were detected across the checks that completed.');
  }

  all.forEach((f, i) => {
    if (doc.y > 720) doc.addPage();

    const y = doc.y;
    doc.circle(56, y + 5, 3.5).fillColor(sevColor(f.severity)).fill();
    doc.fontSize(8).fillColor(sevColor(f.severity)).font('Helvetica-Bold')
      .text(String(f.severity || '').toUpperCase(), 66, y + 1, { width: 40 });
    doc.fontSize(8).fillColor(SOFT).font('Helvetica-Bold').text(f.category, 108, y + 1, { width: 90 });
    doc.fontSize(10).fillColor(INK).font('Helvetica').text(f.text, 200, y, { width: 345, lineGap: 1.5 });

    doc.y = Math.max(doc.y, y + 18);
    doc.moveDown(0.45);
  });

  /* ---------- technical appendix ---------- */
  doc.addPage();
  sectionHeader(doc, 'Technical Detail');

  const speed = raw?.speed;
  if (speed && !speed.error) {
    subHeader(doc, `Speed — via ${speed.source}`);
    kv(doc, 'Performance score', `${speed.score}/100 (${speed.strategy})`);
    Object.entries(speed.labMetrics || {}).forEach(([k, m]) => {
      if (m?.display) kv(doc, humanize(k), m.display);
    });
    kv(doc, 'Real-user field data', speed.fieldData?.available
      ? `Available — overall ${speed.fieldData.overallCategory}`
      : 'Not available (site needs more Chrome traffic)');
    doc.moveDown(0.6);
  }

  const tech = raw?.technology;
  if (tech?.technologies?.length) {
    subHeader(doc, 'Technology detected');
    tech.technologies.forEach((t) => kv(doc, t.name, `${t.categories.join(', ')} (${t.confidence}% confidence)`));
    doc.moveDown(0.6);
  }

  const sec = raw?.security;
  if (sec && !sec.error) {
    if (doc.y > 620) doc.addPage();
    subHeader(doc, 'Security');
    const c = sec.certificate;
    if (c?.tested) {
      kv(doc, 'Certificate valid', c.valid ? 'Yes' : `No — ${c.validationError || c.error}`);
      if (c.issuer) kv(doc, 'Issued by', c.issuer);
      if (typeof c.daysRemaining === 'number') kv(doc, 'Expires in', `${c.daysRemaining} days`);
      if (c.protocol) kv(doc, 'TLS version', c.protocol);
    }
    kv(doc, 'Missing headers', (sec.missingHeaders || []).map((m) => m.header).join(', ') || 'None');
    kv(doc, 'Mixed content', `${sec.mixedContent?.count || 0} insecure resource(s)`);
    kv(doc, 'Exposed sensitive paths', (sec.exposedPaths?.exposed || []).map((e) => e.path).join(', ') || 'None found');
    doc.moveDown(0.6);
  }

  const social = raw?.social;
  if (social && !social.error) {
    if (doc.y > 620) doc.addPage();
    subHeader(doc, 'Social');
    kv(doc, 'Page analysed', social.scannedPage);
    kv(doc, 'Profiles linked', (social.profiles?.linked || []).map((p) => p.platform).join(', ') || 'None');
    kv(doc, 'Share preview image', social.openGraph?.image ? 'Set' : 'Missing');
    kv(doc, 'Twitter Card', social.twitterCard?.present ? 'Present' : 'Missing');
    doc.fontSize(8).fillColor(SOFT).font('Helvetica-Oblique')
      .text(social.note, 50, doc.y + 4, { width: 495 });
    doc.moveDown(0.8);
  }

  /* ---------- pages audited ---------- */
  if (cov?.pages?.length) {
    if (doc.y > 600) doc.addPage();
    subHeader(doc, `Pages audited (${cov.pages.length})`);
    cov.pages.forEach((p, i) => {
      if (doc.y > 750) doc.addPage();
      doc.fontSize(8.5).fillColor(SOFT).font('Helvetica').text(`${i + 1}.  ${p}`, { width: 495 });
    });
  }

  /* ---------- scope note ---------- */
  doc.moveDown(1);
  if (doc.y > 660) doc.addPage();
  doc.fontSize(8.5).fillColor(SOFT).font('Helvetica-Oblique').text(
    'Scope note: this report covers on-page and server-level checks only. It does not include backlink profiles, '
    + 'keyword rankings, or malware/blacklist reputation — those require third-party data sources at internet scale. '
    + 'Speed metrics come from Google PageSpeed Insights; UI/UX assessment is an AI review of page screenshots and is '
    + 'advisory, not a substitute for a designer.',
    { width: 495, lineGap: 1.5 }
  );

  /* ---------- page numbers ---------- */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor(SOFT).font('Helvetica')
      .text(`Page ${i + 1} of ${range.count}`, 50, 800, { width: 495, align: 'center' });
  }

  doc.end();
}

/* ---------- small layout helpers ---------- */

function sectionHeader(doc, text) {
  doc.x = 50; // earlier column text leaves the cursor at x=295 etc.
  if (doc.y > 700) doc.addPage();
  doc.moveDown(0.3);
  doc.fontSize(14).fillColor(INK).font('Helvetica-Bold').text(text);
  doc.moveDown(0.1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dcdce6').lineWidth(1).stroke();
  doc.moveDown(0.6);
}

function subHeader(doc, text) {
  doc.x = 50;
  if (doc.y > 720) doc.addPage();
  doc.fontSize(11).fillColor(VIOLET).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
}

function kv(doc, key, value) {
  if (doc.y > 760) doc.addPage();
  const y = doc.y;
  doc.fontSize(9).fillColor(SOFT).font('Helvetica').text(key, 58, y, { width: 165 });
  doc.fontSize(9).fillColor(INK).font('Helvetica').text(String(value ?? '—'), 228, y, { width: 317 });
  doc.y = Math.max(doc.y, y + 14);
}

function humanize(k) {
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Draws each screenshot with numbered boxes on the exact problem spots, then
 * the matching numbered list (what / why / fix) under it.
 */
function drawAnnotatedScreenshots(doc, uiux) {
  const fs = require('fs');
  const issues = (uiux?.issues || []);
  const shots = (uiux?.screenshots || []);
  if (!issues.length || !shots.length) return;

  let headerDone = false;
  shots.forEach((shot, idx) => {
    const mine = issues.filter((i) => i.screenshot === (shot.index ?? idx));
    if (!mine.length || !shot.file || !fs.existsSync(shot.file)) return;

    doc.addPage();
    if (!headerDone) {
      sectionHeader(doc, 'UI/UX — where the problems are');
      doc.fontSize(9).fillColor(SOFT).font('Helvetica')
        .text('Numbered boxes mark the spot on your site. Positions are approximate (AI review of screenshots).', { width: 495 });
      doc.moveDown(0.6);
      headerDone = true;
    }

    doc.fontSize(10).fillColor(VIOLET).font('Helvetica-Bold').text(shot.label);
    doc.moveDown(0.3);

    const img = doc.openImage(shot.file);
    const isMobile = /mobile/i.test(shot.label);
    const maxW = isMobile ? 190 : 495;
    const maxH = isMobile ? 400 : 330;
    const scale = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = 50;
    const y = doc.y;

    doc.image(shot.file, x, y, { width: w, height: h });
    doc.rect(x, y, w, h).lineWidth(0.5).strokeColor('#dcdce6').stroke();

    mine.forEach((i) => {
      if (!i.box) return;
      const bx = x + (i.box.x / 100) * w;
      const by = y + (i.box.y / 100) * h;
      const bw = (i.box.w / 100) * w;
      const bh = (i.box.h / 100) * h;
      const col = sevColor(i.severity);
      doc.save().rect(bx, by, bw, bh).lineWidth(1.6).strokeColor(col).stroke().restore();
      const cx = Math.max(x + 7, bx);
      const cy = Math.max(y + 7, by);
      doc.save().circle(cx, cy, 7).fillColor(col).fill().restore();
      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
        .text(String(i.n), cx - 7, cy - 3.5, { width: 14, align: 'center', lineBreak: false });
    });

    // Legend: beside a tall mobile shot, below a wide desktop shot.
    const legendX = isMobile ? x + w + 20 : 50;
    const legendW = isMobile ? 495 - w - 20 : 495;
    let ly = isMobile ? y : y + h + 14;
    mine.forEach((i) => {
      if (ly > 740) { doc.addPage(); ly = 50; }
      doc.circle(legendX + 7, ly + 7, 7).fillColor(sevColor(i.severity)).fill();
      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
        .text(String(i.n), legendX, ly + 3.5, { width: 14, align: 'center', lineBreak: false });
      doc.fontSize(9.5).fillColor(INK).font('Helvetica-Bold')
        .text(i.what, legendX + 20, ly, { width: legendW - 20, lineGap: 1 });
      if (i.why) doc.fontSize(8.5).fillColor(SOFT).font('Helvetica').text(i.why, legendX + 20, doc.y + 1, { width: legendW - 20 });
      if (i.fix) doc.fontSize(8.5).fillColor(GOOD).font('Helvetica-Bold').text('Fix: ', legendX + 20, doc.y + 1, { width: legendW - 20, continued: true })
        .fillColor(INK).font('Helvetica').text(i.fix);
      ly = doc.y + 10;
    });
  });
}

module.exports = { streamAuditPdf, buildAuditPdfBuffer };
