const cheerio = require('cheerio');
const { httpClient } = require('../utils/httpClient');

/**
 * Lightweight, fully-custom technology detection.
 *
 * Deliberately does NOT use the `wappalyzer` npm package: that package pulls
 * in its own bundled Puppeteer and downloads a ~170MB Chromium build at
 * install time, which made `npm install` very slow. This version fingerprints
 * the stack from the HTML + response headers we already fetch, so it adds
 * zero install weight and runs in milliseconds.
 *
 * To extend it, just add entries to SIGNATURES below.
 */

const SIGNATURES = [
  // --- CMS ---
  { name: 'WordPress', category: 'CMS', html: [/wp-content\//i, /wp-includes\//i], meta: [/WordPress/i] },
  { name: 'Shopify', category: 'E-commerce', html: [/cdn\.shopify\.com/i], headers: { 'x-shopify-stage': /.*/ } },
  { name: 'Wix', category: 'CMS', html: [/static\.wixstatic\.com/i, /_wixCssStates/i] },
  { name: 'Squarespace', category: 'CMS', html: [/squarespace\.com/i, /static1\.squarespace/i] },
  { name: 'Drupal', category: 'CMS', html: [/sites\/all\/(themes|modules)/i, /drupal\.js/i], meta: [/Drupal/i] },
  { name: 'Joomla', category: 'CMS', html: [/\/media\/jui\//i], meta: [/Joomla/i] },
  { name: 'Webflow', category: 'CMS', html: [/webflow\.com/i], meta: [/Webflow/i] },

  // --- JS frameworks ---
  { name: 'React', category: 'JavaScript framework', html: [/__REACT_DEVTOOLS/i, /data-reactroot/i, /_next\/static/i] },
  { name: 'Next.js', category: 'JavaScript framework', html: [/\/_next\/static/i, /__NEXT_DATA__/i] },
  { name: 'Vue.js', category: 'JavaScript framework', html: [/data-v-[0-9a-f]{8}/i, /vue(\.min)?\.js/i] },
  { name: 'Nuxt.js', category: 'JavaScript framework', html: [/__NUXT__/i, /\/_nuxt\//i] },
  { name: 'Angular', category: 'JavaScript framework', html: [/ng-version=/i, /angular(\.min)?\.js/i] },
  { name: 'Svelte', category: 'JavaScript framework', html: [/svelte-[0-9a-z]{6}/i] },
  { name: 'jQuery', category: 'JavaScript library', html: [/jquery[.-][0-9.]*(\.min)?\.js/i] },

  // --- CSS frameworks ---
  { name: 'Bootstrap', category: 'UI framework', html: [/bootstrap(\.min)?\.(css|js)/i, /class="[^"]*\b(container-fluid|navbar-toggler)\b/i] },
  { name: 'Tailwind CSS', category: 'UI framework', html: [/tailwind(css)?(\.min)?\.css/i, /class="[^"]*\b(flex|grid)\b[^"]*\b(px-\d|py-\d|text-\w+-\d{3})\b/i] },

  // --- Servers / languages ---
  { name: 'Nginx', category: 'Web server', headers: { server: /nginx/i } },
  { name: 'Apache', category: 'Web server', headers: { server: /apache/i } },
  { name: 'Microsoft IIS', category: 'Web server', headers: { server: /iis/i } },
  { name: 'PHP', category: 'Programming language', headers: { 'x-powered-by': /php/i } },
  { name: 'ASP.NET', category: 'Web framework', headers: { 'x-powered-by': /asp\.net/i, 'x-aspnet-version': /.*/ } },
  { name: 'Express', category: 'Web framework', headers: { 'x-powered-by': /express/i } },

  // --- CDN / hosting ---
  { name: 'Cloudflare', category: 'CDN', headers: { server: /cloudflare/i, 'cf-ray': /.*/ } },
  { name: 'Vercel', category: 'Hosting', headers: { server: /vercel/i, 'x-vercel-id': /.*/ } },
  { name: 'Netlify', category: 'Hosting', headers: { server: /netlify/i, 'x-nf-request-id': /.*/ } },
  { name: 'Amazon CloudFront', category: 'CDN', headers: { via: /cloudfront/i, 'x-amz-cf-id': /.*/ } },
  { name: 'Fastly', category: 'CDN', headers: { 'x-served-by': /cache-/i, 'x-fastly-request-id': /.*/ } },

  // --- Analytics / marketing ---
  { name: 'Google Analytics', category: 'Analytics', html: [/google-analytics\.com\/analytics\.js/i, /gtag\/js\?id=(UA|G)-/i] },
  { name: 'Google Tag Manager', category: 'Tag manager', html: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]+/] },
  { name: 'Meta Pixel', category: 'Analytics', html: [/connect\.facebook\.net\/[^/]+\/fbevents\.js/i] },
  { name: 'Hotjar', category: 'Analytics', html: [/static\.hotjar\.com/i] },
  { name: 'HubSpot', category: 'Marketing', html: [/js\.hs-scripts\.com/i] },

  // --- Fonts / misc ---
  { name: 'Google Fonts', category: 'Font script', html: [/fonts\.googleapis\.com/i] },
  { name: 'Font Awesome', category: 'Font script', html: [/font-?awesome/i] },
];

async function runTechnologyAudit(url) {
  const res = await httpClient.get(url, { validateStatus: () => true });
  const html = typeof res.data === 'string' ? res.data : '';
  const headers = res.headers || {};

  const $ = cheerio.load(html);
  const generator = $('meta[name="generator"]').attr('content') || '';

  const technologies = [];

  for (const sig of SIGNATURES) {
    let confidence = 0;

    if (sig.headers) {
      for (const [key, pattern] of Object.entries(sig.headers)) {
        const value = headers[key.toLowerCase()];
        if (value && pattern.test(String(value))) {
          confidence = 100; // header evidence is strong
          break;
        }
      }
    }

    if (confidence < 100 && sig.meta && generator) {
      if (sig.meta.some((p) => p.test(generator))) confidence = 100;
    }

    if (confidence < 100 && sig.html && html) {
      const hits = sig.html.filter((p) => p.test(html)).length;
      if (hits > 0) confidence = Math.min(90, 50 + hits * 20);
    }

    if (confidence > 0) {
      technologies.push({ name: sig.name, categories: [sig.category], confidence, version: null });
    }
  }

  return { url, technologies };
}

module.exports = { runTechnologyAudit };
