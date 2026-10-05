# AuditIQ — Express.js Backend + Front-end

Website audit platform covering Speed, UI/UX, SEO, Technology, Security, and
Social Media audits, plus lead capture, a free-trial subscription flow,
and free consultation booking — built fully on Node.js + Express, mostly
using free/self-hosted open-source engines (Lighthouse plus a custom
signature-based tech detector)
instead of paid third-party APIs.

The `public/` folder contains the actual AuditIQ front-end (the HTML/CSS/JS
you supplied), wired up to call the real API endpoints below instead of the
original fake/simulated behaviour:

| Page                    | What was wired up                                                  |
|--------------------------|---------------------------------------------------------------------|
| `index.html`             | Hero "Run Free Audit" form now calls `POST /api/audit` and redirects with a real `jobId`. Footer "Notify Me" now calls `POST /api/lead`. |
| `audit-progress.html`    | Polls `GET /api/audit/:jobId` every 1.5s; redirects to the result page only once the job is actually `completed`. |
| `audit-result.html`      | Fetches `GET /api/audit/:jobId`, fills the overall + 6 category score rings and the findings list from real data. The gate-form calls `POST /api/lead` before unlocking the full checklist. |
| `consult.html`           | "Request My Free Consultation" form now calls `POST /api/consult`. |
| `subscription.html`      | "Start Free Trial" form now calls `POST /api/subscription/trial`. |

## 1. Prerequisites

- Node.js 18+
- Google Chrome installed on the machine — used for UI/UX screenshots and as the
  Speed fallback. `puppeteer-core` and `chrome-launcher` drive your existing
  Chrome, so nothing is downloaded at install time. If auto-detection fails, set
  `CHROME_PATH` in `.env`.

That's it to get running. Redis and a database are **optional** — see below.

## 2. Setup

```bash
npm install
cp .env.example .env
# fill in the SMTP values if you want the lead/consult emails to actually send
```

## 3. Run

```bash
npm start
```

That's the whole thing — one process. Audits run in an in-memory queue inside
the same process, so no Redis and no separate worker are needed.

The API still responds instantly (`202 Accepted` with a `jobId`) when an audit
is requested; the slow Lighthouse/SEO/security work happens in the background
so the HTTP request never blocks.

### Optional: durable queue with Redis

In production you may want audits to survive a restart. Install Redis, then:

```bash
# in .env
REDIS_ENABLED=true
```

```bash
# Terminal 1
npm start

# Terminal 2
npm run worker
```

### Optional: database with Prisma

`prisma/schema.prisma` defines the Lead / Audit / Subscription / Consultation
models, but no code writes to the database yet (every save is a `TODO` in the
controllers). Prisma is therefore **not installed by default**, to keep
`npm install` fast. When you're ready to persist data:

```bash
npm install prisma --save-dev
npm install @prisma/client
npx prisma migrate dev --name init
```

## 4. API Endpoints

| Method | Endpoint                    | Purpose                                                      |
|--------|------------------------------|----------------------------------------------------------------|
| POST   | `/api/audit`                 | Queue a new audit for a URL — returns `{ jobId }`               |
| GET    | `/api/audit/:jobId`          | Poll job status; once `completed`, returns `formatted` scores + findings + `coverage` |
| GET    | `/api/audit/:jobId/report.pdf` | Download the full PDF report (what the "Download Full Report" button calls) |
| POST   | `/api/lead`                  | Gate-form unlock (`name`, `email`, `phone?`, `jobId`, `type:'gate'`) or newsletter signup (`email`, `type:'newsletter'`) |
| POST   | `/api/consult`                | consult.html request form (`name`, `email`, `phone`, `url`, `scoreFocus`, `budget`, `message`) |
| POST   | `/api/subscription/trial`     | subscription.html trial signup (`name`, `email`, `phone`, `url`, `plan`) - no payment involved |
| POST   | `/api/calendar/book`          | Book a specific confirmed slot (`name`, `email`, `slotIsoDate`) — used once a human has replied to a `/api/consult` request with an agreed time |

## 5. What Each Module Checks

### Speed
Primary source is the **Google PageSpeed Insights API** (free). Beyond the lab
score it returns **real-user field data** from the Chrome UX Report — actual
load times from actual Chrome visitors — which a local Lighthouse run can never
produce. Field data only appears for sites with enough traffic; small sites get
lab metrics only, which is normal. Metrics captured: FCP, LCP, Total Blocking
Time, CLS, Speed Index, Time to Interactive, server response time, plus the top
5 ranked "opportunities" with estimated seconds saved.
Falls back to **self-hosted Lighthouse** if PSI is unreachable.
Set `GOOGLE_API_KEY` in `.env` — it works without one but on a much tighter quota.

### UI/UX
Takes **three viewport screenshots** (not full-page) with `puppeteer-core` driving
your installed Chrome, then sends them to an AI vision model:
1. Mobile first screen (390x844)
2. Desktop first screen (1440x900)
3. Desktop below the fold (1440x900, scrolled down one viewport)

Viewport rather than full-page on purpose: a full-page capture of a long landing
page becomes a tall thin strip, and once downscaled to fit the model's image
limits the text is unreadable and the model starts guessing. Viewport captures
match what a visitor actually sees.

The model returns a 0-100 score, a plain-English verdict, strengths, and issues
with severity + business consequence + a concrete fix. The prompt explicitly
bans design jargon so an owner can act on it. Needs `ANTHROPIC_API_KEY`; without
it, screenshots are still captured but no verdict is produced.

### Technology
Custom signature matcher in `src/services/technologyService.js`. For each of ~35
technologies it holds patterns tested against three evidence sources, strongest
first:
1. **Response headers** — e.g. `server: nginx`, `x-powered-by: PHP/8.1`,
   `cf-ray` (Cloudflare). Headers can't be faked by page content, so a header
   hit scores **100% confidence**.
2. **`<meta name="generator">`** — WordPress, Drupal and Joomla announce
   themselves here. Also **100%**.
3. **HTML body patterns** — e.g. `wp-content/`, `__NEXT_DATA__`,
   `cdn.shopify.com`, `bootstrap.min.css`. Scored **50-90%** depending on how
   many patterns matched, because body text is weaker evidence.

Covers CMS, e-commerce, JS frameworks, CSS frameworks, web servers, languages,
CDNs, hosting, analytics and fonts. Deliberately avoids the `wappalyzer` npm
package, which bundles its own Puppeteer and downloads ~170MB of Chromium at
install time. Extend it by adding entries to the `SIGNATURES` array.

### SEO
**Per page:** title (presence + 30-60 char length), meta description (presence +
70-160 chars), canonical tag (+ self-referencing check), meta robots
(noindex/nofollow detection), H1 count, full H1-H6 structure + skipped-level
detection, image count + missing alt + missing dimensions, JSON-LD structured
data (+ which `@type` schemas), Open Graph tags, `html lang`, viewport meta,
favicon, word count (thin-content flag under 300 words), internal link count,
external link count + nofollow count, broken internal links (samples 8 and
reports 4xx/5xx), HTTPS, URL hygiene (length, underscores, uppercase, query depth).

**Site level (once):** robots.txt presence + whether it allows crawling +
sitemap directive; sitemap.xml presence + URL count + index detection;
http:// → https:// redirect.

**Cross-page:** duplicate titles and duplicate meta descriptions across all
crawled pages — this is only possible because of the multi-page crawl.

**Not checked:** backlinks, keyword rankings, domain authority, competitor gaps.
Those need an internet-scale crawl index and stay a paid add-on.

### Security
**TLS certificate** (raw `tls` socket, not a wrapper): validity against trusted
roots, issuer, subject, subject-alt-names, hostname match, validFrom/validTo,
days remaining (warn <30, critical <14), negotiated TLS version (flags anything
below 1.2), negotiated cipher.

**Security headers:** Strict-Transport-Security, Content-Security-Policy,
X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy,
Cross-Origin-Opener-Policy — each weighted by severity.

**Information disclosure:** `Server`, `X-Powered-By`, `X-AspNet-Version` headers,
flagging any that leak an exact version number.

**Transport & cookies:** HTTPS in use, http→https redirect, mixed content
(http:// assets on an https:// page), and Secure / HttpOnly / SameSite flags on
every `Set-Cookie`.

**Exposed paths:** probes `/.env`, `/.git/config`, `/phpinfo.php`, `/.DS_Store`,
`/wp-config.php.bak` and only reports a hit when the response is 200 with
non-HTML content (avoids false positives from catch-all error pages).

**Not checked:** malware/blacklist reputation — needs aggregated threat-intel
from dozens of vendors, which cannot be self-built.

### Social Media
**This audits your own page's social setup. It does not scrape Facebook,
Instagram, X or LinkedIn** — doing so breaches their Terms of Service and risks
IP/account bans.

Checks: which of 9 platforms you link to and the URLs; whether each profile link
actually resolves (dead-link detection, tolerating LinkedIn's 999 anti-bot
status); which expected platforms are missing; Open Graph tags (og:title,
description, image, url, type, site_name) and whether the og:image URL actually
loads; whether image dimensions are declared; Twitter Card tags; presence of
share buttons; and marketing pixels (Meta, TikTok, LinkedIn, Pinterest).

Follower counts and engagement are **not** included — those need the official
Meta Graph API (free, but the business must connect their own page via OAuth) or
the paid X API.

## 6. Page Coverage

`CRAWL_MAX_PAGES` (default **10**) controls how many pages each audit covers.
Pages are discovered by trying `sitemap.xml` first (most authoritative), then
falling back to following internal links from the entry page. The URL the user
typed is always audited first.

- **Every discovered page** gets: SEO checks, security header checks
- **Entry page only** gets: Speed (PageSpeed Insights), UI/UX (screenshots + AI),
  Technology detection, Social checks, broken-link sampling, exposed-path probing

Speed and UI/UX are entry-page-only because each costs real time and, for UI/UX,
real API spend. The `coverage` object in every response reports exactly what was
crawled and which checks ran where, and the same summary is printed on the PDF.

## 7. Next Steps / TODOs Left in Code

- Wire up Prisma `create` calls in `lead.controller.js`, `consult.controller.js`, `subscription.controller.js`, `calendar.controller.js` (currently marked `TODO`).
- Add Google Calendar API call in `calendar.controller.js` if you want bookings to appear in a real calendar (free API).
- Add a PDF report generator (PDFKit/Puppeteer) that turns a completed `Audit.result` into the "Download Full Report" file shown in the original flow diagram.
- Add authentication (JWT + bcrypt are already installed) for an admin dashboard to view leads/audits.
- Payment is not wired up in this build. If/when you need billing, add a licensed gateway (Razorpay/Stripe) as a separate module — do not build payment processing yourself.
- The scoring formulas in `src/utils/scoreFormatter.js` are a reasonable starting heuristic (not a certified methodology) — tune the weightings once you have real audit data to calibrate against.
#   a u d i t - s y s t e m  
 