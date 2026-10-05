const cheerio = require('cheerio');
const xml2js = require('xml2js');
const { httpClient } = require('./httpClient');

/**
 * Discovers internal pages to audit.
 *
 * Before this existed, the audit only ever looked at the single URL the user
 * typed — every score was based on one page. Now we build a small page list:
 *   1. try sitemap.xml (fastest, most authoritative)
 *   2. fall back to following internal links from the homepage
 *
 * Kept deliberately small (default 10 pages) because each extra page means
 * another full round of Lighthouse/SEO/security checks.
 */

const DEFAULT_MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES || 10);

async function discoverPages(startUrl, maxPages = DEFAULT_MAX_PAGES) {
  const origin = new URL(startUrl).origin;
  const fromSitemap = await fromSitemapXml(origin, maxPages);

  if (fromSitemap.length >= 2) {
    // Always make sure the URL the user actually gave us is audited first.
    const list = [startUrl, ...fromSitemap.filter((u) => u !== startUrl)];
    return { source: 'sitemap.xml', pages: list.slice(0, maxPages) };
  }

  const fromLinks = await fromHomepageLinks(startUrl, maxPages);
  return { source: fromLinks.length > 1 ? 'internal links' : 'single page', pages: fromLinks };
}

async function fromSitemapXml(origin, maxPages) {
  const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

  for (const path of candidates) {
    try {
      const { data } = await httpClient.get(origin + path, { timeout: 8000 });
      const parsed = await xml2js.parseStringPromise(data);

      // A sitemap index points at other sitemaps - follow the first one.
      if (parsed?.sitemapindex?.sitemap?.length) {
        const childUrl = parsed.sitemapindex.sitemap[0]?.loc?.[0];
        if (childUrl) {
          const { data: childData } = await httpClient.get(childUrl, { timeout: 8000 });
          const childParsed = await xml2js.parseStringPromise(childData);
          return extractLocs(childParsed, maxPages);
        }
      }

      const locs = extractLocs(parsed, maxPages);
      if (locs.length) return locs;
    } catch (_) {
      /* try the next candidate */
    }
  }
  return [];
}

function extractLocs(parsed, maxPages) {
  const entries = parsed?.urlset?.url || [];
  return entries
    .map((e) => e?.loc?.[0])
    .filter(Boolean)
    .filter((u) => !/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4)$/i.test(u))
    .slice(0, maxPages);
}

async function fromHomepageLinks(startUrl, maxPages) {
  const pages = [startUrl];
  try {
    const { data: html } = await httpClient.get(startUrl, { timeout: 15000 });
    const $ = cheerio.load(html);
    const baseHost = new URL(startUrl).host;
    const seen = new Set([normalize(startUrl)]);

    $('a[href]').each((_, el) => {
      if (pages.length >= maxPages) return false;
      const href = $(el).attr('href');
      try {
        const resolved = new URL(href, startUrl);
        if (resolved.host !== baseHost) return;
        if (!/^https?:$/.test(resolved.protocol)) return;
        if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4)$/i.test(resolved.pathname)) return;
        resolved.hash = '';
        const key = normalize(resolved.href);
        if (seen.has(key)) return;
        seen.add(key);
        pages.push(resolved.href);
      } catch (_) {
        /* skip malformed href */
      }
    });
  } catch (_) {
    /* homepage unreachable - just audit the given URL */
  }
  return pages.slice(0, maxPages);
}

function normalize(u) {
  return u.replace(/\/$/, '').toLowerCase();
}

module.exports = { discoverPages, DEFAULT_MAX_PAGES };
