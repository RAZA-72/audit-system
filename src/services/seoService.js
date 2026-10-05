const cheerio = require('cheerio');
const xml2js = require('xml2js');
const robotsParser = require('robots-parser');
const { httpClient } = require('../utils/httpClient');

/**
 * On-page SEO audit - fully custom, no SEMrush/Ahrefs dependency.
 *
 * PARAMETERS CHECKED (per page):
 *
 *  Title tag            present, length (30-60 optimal), duplicate across pages
 *  Meta description     present, length (70-160 optimal), duplicate across pages
 *  Canonical tag        present, self-referencing or pointing elsewhere
 *  Meta robots          noindex / nofollow directives that block ranking
 *  H1                   present, count (exactly 1 expected)
 *  Heading structure    H1-H6 counts, and whether levels are skipped
 *  Images               total, missing alt text, missing width/height
 *  Structured data      JSON-LD present, and which @type schemas
 *  Open Graph           og:title, og:description, og:image (link previews)
 *  Language             html lang attribute
 *  Viewport meta        mobile-friendliness prerequisite
 *  Favicon              present
 *  Word count           thin-content detection (<300 words)
 *  Internal links       count
 *  External links       count, and how many are nofollow
 *  Broken links         samples internal links and reports 4xx/5xx
 *  HTTPS                whether the page is served over HTTPS
 *  URL hygiene          length, underscores, uppercase, query-string depth
 *
 * SITE-LEVEL (checked once, not per page):
 *  robots.txt           present, whether it allows crawling, sitemap directive
 *  sitemap.xml          present, URL count
 *  HTTP -> HTTPS        does the http:// version redirect to https://
 *
 * NOT checked (deliberately): backlinks, keyword rankings, domain authority,
 * competitor gaps. Those need an internet-scale crawl index - see the
 * feasibility notes. They stay a paid add-on (SEMrush/Ahrefs) if you want them.
 */

async function runSeoAudit(url, options = {}) {
  const { checkBrokenLinks = true } = options;

  const res = await httpClient.get(url, { timeout: 15000, validateStatus: () => true });
  const html = typeof res.data === 'string' ? res.data : '';
  const $ = cheerio.load(html);
  const parsedUrl = new URL(url);

  /* --- title --- */
  const title = $('title').first().text().trim();

  /* --- meta description --- */
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;

  /* --- canonical --- */
  const canonicalHref = $('link[rel="canonical"]').attr('href') || null;
  let canonicalSelf = null;
  if (canonicalHref) {
    try {
      canonicalSelf = new URL(canonicalHref, url).href.replace(/\/$/, '') === url.replace(/\/$/, '');
    } catch (_) { /* malformed canonical */ }
  }

  /* --- meta robots --- */
  const metaRobots = $('meta[name="robots"]').attr('content')?.toLowerCase() || null;

  /* --- headings --- */
  const headings = {};
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag) => { headings[tag] = $(tag).length; });
  const skippedLevels = detectSkippedHeadingLevels(headings);

  /* --- images --- */
  const images = $('img');
  let missingAlt = 0;
  let missingDimensions = 0;
  images.each((_, el) => {
    if (!$(el).attr('alt')) missingAlt += 1;
    if (!$(el).attr('width') || !$(el).attr('height')) missingDimensions += 1;
  });

  /* --- structured data --- */
  const schemaTypes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).contents().text());
      collectSchemaTypes(json, schemaTypes);
    } catch (_) { /* invalid JSON-LD */ }
  });

  /* --- open graph --- */
  const openGraph = {
    title: $('meta[property="og:title"]').attr('content') || null,
    description: $('meta[property="og:description"]').attr('content') || null,
    image: $('meta[property="og:image"]').attr('content') || null,
  };

  /* --- content --- */
  const bodyText = $('body').clone().find('script, style, noscript').remove().end().text();
  const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length;

  /* --- links --- */
  const internalLinks = [];
  const externalLinks = [];
  let nofollowExternal = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const rel = ($(el).attr('rel') || '').toLowerCase();
    try {
      const resolved = new URL(href, url);
      if (!/^https?:$/.test(resolved.protocol)) return;
      if (resolved.host === parsedUrl.host) {
        resolved.hash = '';
        internalLinks.push(resolved.href);
      } else {
        externalLinks.push(resolved.href);
        if (rel.includes('nofollow')) nofollowExternal += 1;
      }
    } catch (_) { /* skip */ }
  });

  const brokenLinks = checkBrokenLinks ? await sampleBrokenLinks(internalLinks) : { checked: 0, broken: [] };

  return {
    url,
    httpStatus: res.status,
    https: parsedUrl.protocol === 'https:',

    title: {
      value: title,
      length: title.length,
      present: title.length > 0,
      ok: title.length >= 30 && title.length <= 60,
    },
    metaDescription: {
      value: metaDescription,
      length: metaDescription ? metaDescription.length : 0,
      present: !!metaDescription,
      ok: !!metaDescription && metaDescription.length >= 70 && metaDescription.length <= 160,
    },
    canonical: { href: canonicalHref, present: !!canonicalHref, selfReferencing: canonicalSelf },
    metaRobots: {
      value: metaRobots,
      noindex: metaRobots ? metaRobots.includes('noindex') : false,
      nofollow: metaRobots ? metaRobots.includes('nofollow') : false,
    },
    headings: { counts: headings, h1Count: headings.h1, skippedLevels },
    images: { total: images.length, missingAlt, missingDimensions },
    structuredData: { present: schemaTypes.length > 0, types: [...new Set(schemaTypes)] },
    openGraph: {
      ...openGraph,
      complete: !!(openGraph.title && openGraph.description && openGraph.image),
    },
    language: $('html').attr('lang') || null,
    viewportMeta: !!$('meta[name="viewport"]').attr('content'),
    favicon: $('link[rel*="icon"]').length > 0,
    content: { wordCount, thin: wordCount < 300 },
    links: {
      internal: internalLinks.length,
      external: externalLinks.length,
      nofollowExternal,
    },
    brokenLinks,
    urlHygiene: assessUrl(parsedUrl),
  };
}

/**
 * Site-level checks - run once per audit, not per page.
 */
async function runSiteLevelSeo(startUrl) {
  const origin = new URL(startUrl).origin;
  const [robots, sitemap, httpsRedirect] = await Promise.all([
    checkRobotsTxt(origin, startUrl),
    checkSitemap(origin),
    checkHttpsRedirect(origin),
  ]);
  return { robotsTxt: robots, sitemap, httpsRedirect };
}

async function checkRobotsTxt(origin, testUrl) {
  try {
    const robotsUrl = origin + '/robots.txt';
    const { data } = await httpClient.get(robotsUrl, { timeout: 8000 });
    const robots = robotsParser(robotsUrl, data);
    return {
      found: true,
      allowsCrawling: robots.isAllowed(testUrl, '*'),
      declaresSitemap: /sitemap:/i.test(String(data)),
    };
  } catch (_) {
    return { found: false, allowsCrawling: null, declaresSitemap: false };
  }
}

async function checkSitemap(origin) {
  for (const p of ['/sitemap.xml', '/sitemap_index.xml']) {
    try {
      const { data } = await httpClient.get(origin + p, { timeout: 8000 });
      const parsed = await xml2js.parseStringPromise(data);
      const urlCount = parsed?.urlset?.url?.length || 0;
      const indexCount = parsed?.sitemapindex?.sitemap?.length || 0;
      return { found: true, path: p, urlCount, isIndex: indexCount > 0, childSitemaps: indexCount };
    } catch (_) { /* try next */ }
  }
  return { found: false, urlCount: 0 };
}

async function checkHttpsRedirect(origin) {
  if (!origin.startsWith('https:')) return { tested: false };
  try {
    const httpOrigin = origin.replace(/^https:/, 'http:');
    const res = await httpClient.get(httpOrigin, {
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    const location = res.headers?.location || '';
    return {
      tested: true,
      status: res.status,
      redirectsToHttps: res.status >= 300 && res.status < 400 && /^https:/i.test(location),
    };
  } catch (_) {
    return { tested: false };
  }
}

/* ---------- helpers ---------- */

async function sampleBrokenLinks(internalLinks, sampleSize = 8) {
  const unique = [...new Set(internalLinks)].slice(0, sampleSize);
  const broken = [];

  await Promise.all(
    unique.map(async (link) => {
      try {
        const res = await httpClient.get(link, {
          timeout: 8000,
          validateStatus: () => true,
          maxRedirects: 3,
        });
        if (res.status >= 400) broken.push({ url: link, status: res.status });
      } catch (err) {
        broken.push({ url: link, status: 'unreachable' });
      }
    })
  );

  return { checked: unique.length, broken };
}

function detectSkippedHeadingLevels(headings) {
  const order = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const skipped = [];
  for (let i = 1; i < order.length; i += 1) {
    if (headings[order[i]] > 0 && headings[order[i - 1]] === 0) {
      skipped.push(`${order[i]} used without ${order[i - 1]}`);
    }
  }
  return skipped;
}

function collectSchemaTypes(node, out) {
  if (!node) return;
  if (Array.isArray(node)) return node.forEach((n) => collectSchemaTypes(n, out));
  if (typeof node === 'object') {
    if (node['@type']) {
      const t = node['@type'];
      Array.isArray(t) ? out.push(...t) : out.push(t);
    }
    if (node['@graph']) collectSchemaTypes(node['@graph'], out);
  }
}

function assessUrl(parsedUrl) {
  const p = parsedUrl.pathname;
  return {
    length: parsedUrl.href.length,
    tooLong: parsedUrl.href.length > 100,
    hasUnderscores: p.includes('_'),
    hasUppercase: /[A-Z]/.test(p),
    queryParams: [...parsedUrl.searchParams.keys()].length,
  };
}

module.exports = { runSeoAudit, runSiteLevelSeo };
