const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * UI/UX audit.
 *
 * Approach (as specified): take a few VIEWPORT screenshots - not full-page
 * ones - and hand them to a vision model, which returns a verdict in plain
 * language a non-designer can act on.
 *
 * Why viewport and not full-page: a full-page screenshot of a long landing
 * page becomes a tall, thin strip. Downscaled to fit a model's image limits,
 * text turns to mush and the model starts guessing. Viewport captures match
 * what a real visitor actually sees, and stay legible.
 *
 * What we capture (3 shots):
 *   1. Mobile hero      (390x844)  - first impression on the dominant device
 *   2. Desktop hero     (1440x900) - first impression on desktop
 *   3. Desktop mid-page (1440x900, scrolled one viewport down) - does the
 *      design hold up past the fold, or does it fall apart
 *
 * Chrome: uses puppeteer-core against the Chrome already installed on the
 * machine. puppeteer-core does NOT download its own ~170MB Chromium, which
 * keeps `npm install` fast.
 *
 * Degrades gracefully: no ANTHROPIC_API_KEY means screenshots are still
 * captured and returned, just without the AI verdict.
 */

const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-6';

async function runUiUxAudit(url) {
  let shots;
  try {
    shots = await captureScreenshots(url);
  } catch (err) {
    return { url, error: `Screenshot capture failed: ${err.message}` };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      url,
      screenshots: shots.map((s) => ({ index: s.index, label: s.label, file: s.file, viewport: s.viewport })),
      verdict: null,
      note: 'Screenshots captured. Set ANTHROPIC_API_KEY in .env to get the AI design verdict.',
    };
  }

  try {
    const verdict = await analyseWithVision(shots, url);
    return {
      url,
      screenshots: shots.map((s) => ({ index: s.index, label: s.label, file: s.file, viewport: s.viewport })),
      ...verdict,
    };
  } catch (err) {
    return {
      url,
      screenshots: shots.map((s) => ({ index: s.index, label: s.label, file: s.file, viewport: s.viewport })),
      verdict: null,
      error: `Vision analysis failed: ${err.message}`,
    };
  }
}

/* ---------------- screenshot capture ---------------- */

async function captureScreenshots(url) {
  const puppeteer = require('puppeteer-core');
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error(
      'Could not find an installed Chrome. Set CHROME_PATH in .env to your chrome.exe / Chrome binary.'
    );
  }

  const outDir = path.join(os.tmpdir(), 'auditiq-shots');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  const stamp = Date.now();

  // Two browser tabs in parallel (mobile + desktop). The "below the fold"
  // shot reuses the desktop tab - just scroll, no second page load. This
  // replaces 3 sequential full page loads and cuts capture time roughly in half.
  async function openPage(viewport) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (_) {
      // Some sites never go network-idle (chat widgets, analytics). If the
      // DOM is there, screenshot what we have instead of failing the audit.
    }
    await new Promise((r) => setTimeout(r, 1000));
    return page;
  }

  async function snap(page, label, viewport, scrollBy) {
    if (scrollBy) {
      await page.evaluate((y) => window.scrollTo(0, y), scrollBy);
      await new Promise((r) => setTimeout(r, 600));
    }
    const file = path.join(outDir, `${stamp}-${slug(label)}.png`);
    await page.screenshot({ path: file, type: 'png' }); // viewport only, see top comment
    const base64 = fs.readFileSync(file).toString('base64');
    return { label, viewport: `${viewport.width}x${viewport.height}`, file, base64 };
  }

  const mobileVp = { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 };
  const desktopVp = { width: 1440, height: 900, isMobile: false, deviceScaleFactor: 1 };

  let shots;
  try {
    shots = await Promise.all([
      (async () => {
        const page = await openPage(mobileVp);
        return [await snap(page, 'Mobile — first screen', mobileVp, 0)];
      })(),
      (async () => {
        const page = await openPage(desktopVp);
        const first = await snap(page, 'Desktop — first screen', desktopVp, 0);
        const below = await snap(page, 'Desktop — below the fold', desktopVp, 900);
        return [first, below];
      })(),
    ]);
  } finally {
    await browser.close();
  }

  // Keep the order the AI prompt and the report expect: mobile, desktop, below-fold.
  shots = shots.flat().map((sh, index) => ({ ...sh, index }));

  return shots;
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const candidates = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  return candidates.find((p) => fs.existsSync(p)) || null;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ---------------- AI vision analysis ---------------- */

const SYSTEM_PROMPT = `You are a UI/UX reviewer writing for a small-business owner who is NOT a designer and does not know design jargon.

You will receive screenshots of one website: a mobile first screen, a desktop first screen, and a desktop view below the fold.

Judge only what you can actually see. Do not speculate about code, performance, or pages you were not shown. If something is unclear from the screenshots, leave it out rather than guessing.

Assess:
- Is it immediately obvious what this business does and who it is for?
- Is there a clear, findable primary action (the thing they want a visitor to do)?
- Readability: text size, contrast against its background, line length, crowding
- Visual hierarchy: does the eye land on the most important thing first
- Mobile experience: cramped elements, text too small, buttons too close together
- Trust and polish: consistent spacing and alignment, image quality, anything that looks broken, unfinished, or dated
- Below-the-fold: does the page keep its structure or become a wall of text

Respond with ONLY a JSON object, no markdown fences and no preamble:
{
  "score": <integer 0-100, your honest overall UI/UX judgement>,
  "verdict": "<2-3 sentences in plain English - what a visitor's first impression is and whether the site is working for them>",
  "strengths": ["<specific thing that works, in plain language>", ...],
  "issues": [
    {
      "severity": "high" | "med" | "low",
      "screenshot": <0, 1 or 2 - which screenshot shows this problem, in the order given: 0 = mobile first screen, 1 = desktop first screen, 2 = desktop below the fold>,
      "box": { "x": <0-100>, "y": <0-100>, "w": <0-100>, "h": <0-100> },
      "what": "<what is wrong, described so a non-designer can see it themselves>",
      "why": "<the business consequence, e.g. visitors leave before finding your phone number>",
      "fix": "<one concrete change they or their developer can make>"
    }
  ]
}

Rules for "box": it marks WHERE on that screenshot the problem is, so the owner can see it. x and y are the top-left corner and w and h the size, all as percentages (0-100) of the screenshot's width and height. Draw a tight box around the specific element (a button, a block of hard-to-read text, a crowded menu), not the whole screen. Only report an issue if you can point at it in one of the screenshots. Give 3 to 7 issues, most serious first.

Rules for tone: no jargon (no "above the fold", "whitespace", "CTA", "visual weight", "affordance"). Write like you are explaining it to the owner over the phone. Be direct about real problems but never insulting - it is their business.`;

async function analyseWithVision(shots, url) {
  const content = [];

  shots.forEach((s) => {
    content.push({ type: 'text', text: `Screenshot: ${s.label} (${s.viewport})` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: s.base64 },
    });
  });

  content.push({
    type: 'text',
    text: `These are screenshots of ${url}. Review the UI/UX and respond with the JSON object only.`,
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .replace(/```json|```/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // Model returned prose instead of JSON - keep it rather than losing it.
    return { score: null, verdict: text.slice(0, 1000), strengths: [], issues: [] };
  }

  return {
    score: typeof parsed.score === 'number' ? parsed.score : null,
    verdict: parsed.verdict || null,
    strengths: parsed.strengths || [],
    issues: cleanIssues(parsed.issues, shots.length),
    model: VISION_MODEL,
  };
}

/**
 * Model-supplied boxes are untrusted: clamp everything into 0-100 and drop
 * degenerate or full-screen boxes (those point at nothing). Issues without a
 * usable box are kept - they just show in the list without a marker.
 */
function cleanIssues(issues, shotCount) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return (Array.isArray(issues) ? issues : []).slice(0, 8).map((i, n) => {
    const shot = Number.isInteger(i.screenshot) && i.screenshot >= 0 && i.screenshot < shotCount ? i.screenshot : null;
    let box = null;
    if (shot !== null && i.box) {
      let x = num(i.box.x), y = num(i.box.y), w = num(i.box.w), h = num(i.box.h);
      if ([x, y, w, h].every((v) => v !== null)) {
        x = Math.min(100, Math.max(0, x));
        y = Math.min(100, Math.max(0, y));
        w = Math.min(100 - x, Math.max(0, w));
        h = Math.min(100 - y, Math.max(0, h));
        if (w >= 2 && h >= 2 && !(w > 95 && h > 95)) box = { x, y, w, h };
      }
    }
    return {
      n: n + 1,
      severity: ['high', 'med', 'low'].includes(i.severity) ? i.severity : 'med',
      what: String(i.what || '').trim(),
      why: String(i.why || '').trim(),
      fix: String(i.fix || '').trim(),
      screenshot: shot,
      box,
    };
  }).filter((i) => i.what);
}

module.exports = { runUiUxAudit };
