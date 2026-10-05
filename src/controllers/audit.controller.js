const { auditQueue } = require('../jobs/auditQueue');
const { discoverPages } = require('../utils/crawler');
const { runSpeedAudit } = require('../services/speedService');
const { runUiUxAudit } = require('../services/uiuxService');
const { runTechnologyAudit } = require('../services/technologyService');
const { runSeoAudit, runSiteLevelSeo } = require('../services/seoService');
const { runSecurityAudit } = require('../services/securityService');
const { runSocialAudit } = require('../services/socialService');
const { formatAuditResult } = require('../utils/scoreFormatter');

/**
 * POST /api/audit   Body: { url, maxPages? }
 * Queues a background job so the API responds instantly instead of blocking
 * for the 1-3 minutes a multi-page audit takes.
 */
async function requestAudit(req, res, next) {
  try {
    const { url, maxPages } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    let normalized;
    try {
      normalized = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).href;
    } catch (_) {
      return res.status(400).json({ error: 'url is not valid' });
    }

    const job = await auditQueue.add('full-audit', { url: normalized, maxPages });
    return res.status(202).json({ jobId: job.id, status: 'queued', url: normalized });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/audit/:jobId
 * Polled by audit-progress.html, then read by audit-result.html.
 */
async function getAuditStatus(req, res, next) {
  try {
    const job = await auditQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const state = await job.getState();
    const result = state === 'completed' ? stripServerPaths(job.returnvalue) : null;
    const formatted = result ? formatAuditResult(result) : null;

    return res.json({
      jobId: job.id,
      state,
      url: job.data.url,
      progress: job.progress ?? null,
      result,
      formatted,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/audit/:jobId/report.pdf
 * Streams the downloadable PDF report. This is what the "Download Full
 * Report" button on audit-result.html points at.
 */
async function downloadReport(req, res, next) {
  try {
    const job = await auditQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const state = await job.getState();
    if (state !== 'completed') {
      return res.status(409).json({ error: `Audit is still ${state}. The report is only available once it completes.` });
    }

    const raw = job.returnvalue;
    const formatted = formatAuditResult(raw);

    const { streamAuditPdf } = require('../services/reportService');
    streamAuditPdf(res, {
      url: raw.url,
      generatedAt: raw.generatedAt,
      formatted,
      raw,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Runs the whole audit. Called by the queue worker, never directly by a route.
 *
 * Page coverage: the crawler discovers up to `maxPages` internal pages
 * (sitemap.xml first, then internal links). Per-page checks (SEO, security
 * headers, technology) run on every discovered page. Expensive checks (Speed
 * via PageSpeed Insights, UI/UX via screenshots + AI) run on the entry page
 * only, because each costs real time and, for UI/UX, real API spend.
 */
async function runFullAudit(url, opts = {}) {
  const startedAt = Date.now();

  // ---- Real progress tracking ------------------------------------------
  // Every unit of work has a weight; when it finishes, the percentage goes
  // up by that weight. The browser polls this, so the ring reflects what is
  // actually done instead of a fake animation. Weights add up to 100.
  const W = { discovery: 5, sweep: 30, speed: 30, uiux: 30, siteSeo: 5 };
  const steps = { speed: 'running', uiux: 'running', technology: 'pending', seo: 'pending', security: 'pending', social: 'pending' };
  let pct = 0;
  let message = 'Finding the pages on your site…';
  const report = () => {
    if (typeof opts.onProgress === 'function') {
      // Never claim 100% from inside the run - the job state does that.
      opts.onProgress({ pct: Math.min(99, Math.round(pct)), message, steps: { ...steps } });
    }
  };
  const bump = (amount, msg) => { pct += amount; if (msg) message = msg; report(); };
  report();

  const { pages, source } = await discoverPages(url, opts.maxPages);
  steps.technology = 'running'; steps.seo = 'running'; steps.security = 'running'; steps.social = 'running';
  bump(W.discovery, `Found ${pages.length} page${pages.length === 1 ? '' : 's'}. Running checks…`);

  // Expensive, entry-page-only checks - run in parallel with the page sweep.
  const tracked = (key, weight, msg, promise) =>
    promise.finally(() => { steps[key] = 'done'; bump(weight, msg); });

  const entryChecks = Promise.allSettled([
    tracked('speed', W.speed, 'Speed test finished.', runSpeedAudit(url, 'mobile')),
    tracked('uiux', W.uiux, 'Design review finished.', runUiUxAudit(url)),
    runSiteLevelSeo(url).finally(() => bump(W.siteSeo)),
  ]);

  // Cheap per-page checks across every discovered page.
  const pageResults = [];
  const perPage = W.sweep / Math.max(1, pages.length);
  for (const pageUrl of pages) {
    const isEntry = pageUrl === url;
    const [seo, security, technology, social] = await Promise.allSettled([
      runSeoAudit(pageUrl, { checkBrokenLinks: isEntry }),
      runSecurityAudit(pageUrl, { checkExposedPaths: isEntry }),
      isEntry ? runTechnologyAudit(pageUrl) : Promise.resolve(null),
      isEntry ? runSocialAudit(pageUrl) : Promise.resolve(null),
    ]);

    pageResults.push({
      url: pageUrl,
      isEntryPage: isEntry,
      seo: unwrap(seo),
      security: unwrap(security),
      technology: unwrap(technology),
      social: unwrap(social),
    });

    if (isEntry) { steps.technology = 'done'; steps.social = 'done'; }
    bump(perPage, `Checked ${pageResults.length} of ${pages.length} pages…`);
  }
  steps.seo = 'done'; steps.security = 'done';
  message = 'Waiting for Google PageSpeed and the design review (these take the longest)…';
  report();

  const [speed, uiux, siteSeo] = await entryChecks;
  message = 'Building your report…';
  report();
  const entry = pageResults.find((p) => p.isEntryPage) || pageResults[0] || {};

  return {
    url,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,

    coverage: {
      pagesDiscovered: pages.length,
      pagesAudited: pageResults.length,
      discoveryMethod: source,
      perPageChecks: ['SEO', 'Security headers'],
      entryPageOnlyChecks: ['Speed (PageSpeed Insights)', 'UI/UX (screenshots + AI)', 'Technology', 'Social', 'Broken links', 'Exposed paths'],
      pages: pages,
    },

    speed: unwrap(speed),
    uiux: unwrap(uiux),
    technology: entry.technology,
    social: entry.social,
    seo: { entryPage: entry.seo, siteLevel: unwrap(siteSeo) },
    security: entry.security,

    pages: pageResults,
  };
}

// Screenshot files live in the server's temp dir - the browser only needs
// the label/viewport and fetches the image via /screenshot/:index.
function stripServerPaths(raw) {
  if (!raw || !raw.uiux || !Array.isArray(raw.uiux.screenshots)) return raw;
  return {
    ...raw,
    uiux: { ...raw.uiux, screenshots: raw.uiux.screenshots.map(({ file, ...rest }) => rest) },
  };
}

function unwrap(settled) {
  if (!settled) return null;
  if (settled.status === 'fulfilled') return settled.value;
  return { error: settled.reason?.message || String(settled.reason) };
}

/**
 * GET /api/audit/:jobId/screenshot/:index
 * Serves the captured screenshot so the result page can draw the
 * "problem is here" boxes on top of it.
 */
async function getScreenshot(req, res, next) {
  try {
    const job = await auditQueue.getJob(req.params.jobId);
    if (!job || !job.returnvalue) return res.status(404).json({ error: 'Not found' });
    const shots = job.returnvalue.uiux?.screenshots || [];
    const shot = shots[Number(req.params.index)];
    if (!shot || !shot.file || !require('fs').existsSync(shot.file)) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(shot.file);
  } catch (err) {
    next(err);
  }
}

module.exports = { requestAudit, getAuditStatus, downloadReport, getScreenshot, runFullAudit };
