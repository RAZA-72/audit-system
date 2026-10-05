const { httpClient } = require('../utils/httpClient');

/**
 * Speed audit.
 *
 * Primary: Google PageSpeed Insights API (free, no per-request charge).
 *   - Returns the same Lighthouse lab metrics you'd get locally, PLUS real
 *     Chrome UX Report (CrUX) field data from actual Chrome users, which a
 *     local Lighthouse run can never give you. That field data is what makes
 *     the result trustworthy rather than "one run on our server".
 *   - Needs GOOGLE_API_KEY in .env. Works without a key too but the quota is
 *     much tighter, so set one.
 *
 * Fallback: local Lighthouse (self-hosted) if PSI fails or is unreachable.
 */

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

async function runSpeedAudit(url, strategy = 'mobile') {
  try {
    return await viaPageSpeedInsights(url, strategy);
  } catch (psiErr) {
    try {
      const local = await viaLocalLighthouse(url);
      local.notes = `PageSpeed Insights unavailable (${psiErr.message}); used local Lighthouse instead.`;
      return local;
    } catch (lhErr) {
      return { url, error: `PSI failed (${psiErr.message}); local Lighthouse failed (${lhErr.message})` };
    }
  }
}

async function viaPageSpeedInsights(url, strategy) {
  const params = new URLSearchParams({ url, strategy });
  params.append('category', 'performance');
  if (process.env.GOOGLE_API_KEY) params.append('key', process.env.GOOGLE_API_KEY);

  const data = await callPsi(`${PSI_ENDPOINT}?${params.toString()}`);

  const lh = data.lighthouseResult || {};
  const audits = lh.audits || {};
  const score = Math.round((lh.categories?.performance?.score || 0) * 100);

  const metric = (id) => ({
    value: audits[id]?.numericValue ?? null,
    display: audits[id]?.displayValue ?? null,
    score: audits[id]?.score ?? null,
  });

  // Field data = real users, from the Chrome UX Report. Only present for
  // sites with enough traffic; absent for small/new sites, which is normal.
  const field = data.loadingExperience?.metrics || {};
  const fieldMetric = (key) =>
    field[key] ? { p75: field[key].percentile, category: field[key].category } : null;

  // Biggest, most actionable wins - what actually costs the user seconds.
  const opportunities = Object.values(audits)
    .filter((a) => a.details?.type === 'opportunity' && a.numericValue > 100)
    .sort((a, b) => b.numericValue - a.numericValue)
    .slice(0, 5)
    .map((a) => ({ title: a.title, savingsMs: Math.round(a.numericValue), display: a.displayValue }));

  return {
    url,
    source: 'Google PageSpeed Insights API',
    strategy,
    score,
    labMetrics: {
      firstContentfulPaint: metric('first-contentful-paint'),
      largestContentfulPaint: metric('largest-contentful-paint'),
      totalBlockingTime: metric('total-blocking-time'),
      cumulativeLayoutShift: metric('cumulative-layout-shift'),
      speedIndex: metric('speed-index'),
      timeToInteractive: metric('interactive'),
      serverResponseTime: metric('server-response-time'),
    },
    fieldData: {
      available: Object.keys(field).length > 0,
      overallCategory: data.loadingExperience?.overall_category || null,
      largestContentfulPaint: fieldMetric('LARGEST_CONTENTFUL_PAINT_MS'),
      firstContentfulPaint: fieldMetric('FIRST_CONTENTFUL_PAINT_MS'),
      cumulativeLayoutShift: fieldMetric('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
      interactionToNextPaint: fieldMetric('INTERACTION_TO_NEXT_PAINT'),
    },
    opportunities,
  };
}

/**
 * PSI runs a real Lighthouse test on Google's side, so 20-60s is normal.
 * - 90s timeout (was 60s, which cut off slower sites and triggered the much
 *   slower local-Lighthouse fallback)
 * - one retry on 429 / 5xx / timeout
 * - Google's own error message is surfaced (e.g. "API key not valid",
 *   "PageSpeed Insights API has not been used in project ...") instead of
 *   axios's useless "Request failed with status code 400".
 */
async function callPsi(fullUrl) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { data } = await httpClient.get(fullUrl, { timeout: 90000 });
      return data;
    } catch (err) {
      const status = err.response?.status;
      const googleMsg = err.response?.data?.error?.message;
      lastErr = new Error(googleMsg ? `Google API ${status}: ${googleMsg}` : err.message);
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

async function viaLocalLighthouse(url) {
  const chromeLauncher = require('chrome-launcher');
  const lighthouse = require('lighthouse');

  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox'] });
  try {
    const runnerResult = await lighthouse(url, {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance'],
      port: chrome.port,
    });

    const lh = runnerResult.lhr;
    const audits = lh.audits || {};
    const metric = (id) => ({
      value: audits[id]?.numericValue ?? null,
      display: audits[id]?.displayValue ?? null,
      score: audits[id]?.score ?? null,
    });

    return {
      url,
      source: 'Local Lighthouse (self-hosted)',
      strategy: 'desktop',
      score: Math.round((lh.categories?.performance?.score || 0) * 100),
      labMetrics: {
        firstContentfulPaint: metric('first-contentful-paint'),
        largestContentfulPaint: metric('largest-contentful-paint'),
        totalBlockingTime: metric('total-blocking-time'),
        cumulativeLayoutShift: metric('cumulative-layout-shift'),
        speedIndex: metric('speed-index'),
        timeToInteractive: metric('interactive'),
        serverResponseTime: metric('server-response-time'),
      },
      fieldData: { available: false },
      opportunities: [],
    };
  } finally {
    await chrome.kill();
  }
}

module.exports = { runSpeedAudit };
