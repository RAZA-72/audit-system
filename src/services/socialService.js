const cheerio = require('cheerio');
const { httpClient } = require('../utils/httpClient');

/**
 * Social media audit.
 *
 * IMPORTANT - what this does and does NOT do:
 *
 * This audits YOUR OWN PAGE's social setup. It does NOT log into or scrape
 * Facebook, Instagram, X or LinkedIn. Scraping those platforms violates their
 * Terms of Service (IP bans, account bans, occasional legal notices), so we
 * stay on the right side of that line by only reading your own HTML plus
 * checking that the profile links you publish actually resolve.
 *
 * PARAMETERS CHECKED:
 *
 *  Linked profiles       which platforms you link to (Facebook, Instagram,
 *                        X/Twitter, LinkedIn, YouTube, WhatsApp, Pinterest,
 *                        TikTok, Telegram), and their URLs
 *  Link reachability     does each profile URL actually load, or is it dead
 *  Missing platforms     which of the common set you have no link for
 *  Open Graph tags       og:title, og:description, og:image, og:url, og:type,
 *                        og:site_name - these control how your link looks when
 *                        shared on WhatsApp, Facebook and LinkedIn
 *  og:image validity     does the image URL actually load, and its dimensions
 *                        if declared (1200x630 recommended)
 *  Twitter Card tags     twitter:card, twitter:title, twitter:description,
 *                        twitter:image - controls the X/Twitter preview
 *  Share buttons         whether the page offers any share/follow affordance
 *  Pixels / tracking     Meta Pixel, TikTok Pixel, LinkedIn Insight Tag
 *
 * FOLLOWER COUNTS AND ENGAGEMENT are not included. Those require the official
 * Meta Graph API (free, but needs the business to connect their own page via
 * OAuth) or the paid X API. Add them as an authenticated feature later.
 */

const PLATFORMS = {
  facebook: { label: 'Facebook', pattern: /(?:^|\/\/|\.)facebook\.com\// },
  instagram: { label: 'Instagram', pattern: /(?:^|\/\/|\.)instagram\.com\// },
  twitter: { label: 'X (Twitter)', pattern: /(?:^|\/\/|\.)(?:twitter\.com|x\.com)\// },
  linkedin: { label: 'LinkedIn', pattern: /(?:^|\/\/|\.)linkedin\.com\// },
  youtube: { label: 'YouTube', pattern: /(?:^|\/\/|\.)(?:youtube\.com|youtu\.be)\// },
  whatsapp: { label: 'WhatsApp', pattern: /(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\// },
  pinterest: { label: 'Pinterest', pattern: /(?:^|\/\/|\.)pinterest\.(?:com|[a-z]{2})\// },
  tiktok: { label: 'TikTok', pattern: /(?:^|\/\/|\.)tiktok\.com\// },
  telegram: { label: 'Telegram', pattern: /(?:^|\/\/|\.)t\.me\// },
};

// The platforms most small businesses are expected to have; used for the
// "missing" list so we don't flag TikTok/Telegram as mandatory.
const EXPECTED = ['facebook', 'instagram', 'linkedin', 'youtube'];

const TRACKERS = {
  metaPixel: /connect\.facebook\.net\/[^/]+\/fbevents\.js/i,
  tiktokPixel: /analytics\.tiktok\.com/i,
  linkedinInsight: /snap\.licdn\.com/i,
  pinterestTag: /s\.pinimg\.com\/ct\//i,
};

async function runSocialAudit(url, options = {}) {
  const { verifyLinks = true } = options;

  const res = await httpClient.get(url, { timeout: 15000, validateStatus: () => true });
  const html = typeof res.data === 'string' ? res.data : '';
  const $ = cheerio.load(html);

  /* --- linked profiles --- */
  const profiles = {};
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    Object.entries(PLATFORMS).forEach(([key, { pattern }]) => {
      if (pattern.test(href) && !profiles[key]) {
        try {
          profiles[key] = new URL(href, url).href;
        } catch (_) { /* skip malformed */ }
      }
    });
  });

  const linkedPlatforms = Object.keys(profiles);
  const missingPlatforms = EXPECTED.filter((p) => !profiles[p]).map((p) => PLATFORMS[p].label);

  /* --- verify the profile links actually work --- */
  let deadLinks = [];
  if (verifyLinks && linkedPlatforms.length) {
    deadLinks = await verifyProfileLinks(profiles);
  }

  /* --- open graph --- */
  const og = {
    title: $('meta[property="og:title"]').attr('content') || null,
    description: $('meta[property="og:description"]').attr('content') || null,
    image: $('meta[property="og:image"]').attr('content') || null,
    url: $('meta[property="og:url"]').attr('content') || null,
    type: $('meta[property="og:type"]').attr('content') || null,
    siteName: $('meta[property="og:site_name"]').attr('content') || null,
    imageWidth: $('meta[property="og:image:width"]').attr('content') || null,
    imageHeight: $('meta[property="og:image:height"]').attr('content') || null,
  };

  const ogMissing = ['title', 'description', 'image']
    .filter((k) => !og[k])
    .map((k) => `og:${k}`);

  let ogImageStatus = null;
  if (og.image) {
    ogImageStatus = await checkImageReachable(og.image, url);
  }

  /* --- twitter card --- */
  const twitter = {
    card: $('meta[name="twitter:card"]').attr('content') || null,
    title: $('meta[name="twitter:title"]').attr('content') || null,
    description: $('meta[name="twitter:description"]').attr('content') || null,
    image: $('meta[name="twitter:image"]').attr('content') || null,
    site: $('meta[name="twitter:site"]').attr('content') || null,
  };

  /* --- share buttons --- */
  const shareIntentPattern = /(sharer\.php|share\?url=|intent\/tweet|wa\.me\/\?text=|linkedin\.com\/shareArticle|pinterest\.com\/pin\/create)/i;
  let shareButtons = 0;
  $('a[href]').each((_, el) => {
    if (shareIntentPattern.test($(el).attr('href') || '')) shareButtons += 1;
  });

  /* --- trackers --- */
  const trackers = Object.entries(TRACKERS)
    .filter(([, pattern]) => pattern.test(html))
    .map(([name]) => name);

  return {
    url,
    scannedPage: url,
    note: 'Only your own page was analysed. No social platform was scraped (that would breach their Terms of Service).',

    profiles: {
      linked: Object.entries(profiles).map(([key, href]) => ({
        platform: PLATFORMS[key].label,
        url: href,
      })),
      count: linkedPlatforms.length,
      missingExpected: missingPlatforms,
      deadLinks,
    },

    openGraph: {
      ...og,
      complete: ogMissing.length === 0,
      missing: ogMissing,
      imageReachable: ogImageStatus,
      imageDimensionsDeclared: !!(og.imageWidth && og.imageHeight),
    },

    twitterCard: {
      ...twitter,
      present: !!twitter.card,
      complete: !!(twitter.card && twitter.title && twitter.image),
    },

    shareButtons: { count: shareButtons, present: shareButtons > 0 },
    trackers,

    followerData: {
      available: false,
      reason: 'Follower and engagement counts need the official Meta Graph API (business must connect their page) or the paid X API.',
    },
  };
}

async function verifyProfileLinks(profiles) {
  const dead = [];
  await Promise.all(
    Object.entries(profiles).map(async ([key, href]) => {
      try {
        const res = await httpClient.get(href, {
          timeout: 10000,
          validateStatus: () => true,
          maxRedirects: 3,
        });
        // 999 is LinkedIn's anti-bot response - the profile may be fine, so
        // don't report it as dead. 401/403 from social platforms is likewise
        // usually bot-blocking rather than a broken link.
        if (res.status >= 400 && ![401, 403, 429, 999].includes(res.status)) {
          dead.push({ platform: PLATFORMS[key].label, url: href, status: res.status });
        }
      } catch (err) {
        dead.push({ platform: PLATFORMS[key].label, url: href, status: 'unreachable' });
      }
    })
  );
  return dead;
}

async function checkImageReachable(imageUrl, baseUrl) {
  try {
    const abs = new URL(imageUrl, baseUrl).href;
    const res = await httpClient.get(abs, { timeout: 10000, validateStatus: () => true, maxRedirects: 3 });
    return { ok: res.status < 400, status: res.status };
  } catch (err) {
    return { ok: false, status: 'unreachable' };
  }
}

module.exports = { runSocialAudit };
