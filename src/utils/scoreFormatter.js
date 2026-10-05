/**
 * Converts the raw multi-page audit into the shape the front-end renders:
 *   { overallScore, categories: {speed, uiux, technology, seo, security, social},
 *     findings, lockedFindings, lockedCount, coverage }
 *
 * The scoring weights here are a documented heuristic, not a certified
 * methodology. Tune them once you have real audits to calibrate against.
 */

function formatAuditResult(raw) {
  const speed = scoreSpeed(raw.speed);
  const uiux = scoreUiUx(raw.uiux);
  const technology = scoreTechnology(raw.technology);
  const seo = scoreSeo(raw.seo, raw.pages);
  const security = scoreSecurity(raw.security, raw.pages);
  const social = scoreSocial(raw.social);

  const categories = { speed, uiux, technology, seo, security, social };

  // Only average the categories that actually produced a score, so one
  // failed module doesn't drag the overall score down misleadingly.
  const scored = Object.values(categories).filter((c) => typeof c.score === 'number');
  const overallScore = scored.length
    ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length)
    : 0;

  const allFindings = Object.values(categories)
    .flatMap((c) => c.findings || [])
    .sort((a, b) => weight(b.severity) - weight(a.severity));

  return {
    overallScore,
    categories,
    findings: allFindings.slice(0, 4),
    lockedFindings: allFindings.slice(4),
    lockedCount: Math.max(allFindings.length - 4, 0),
    totalFindings: allFindings.length,
    coverage: raw.coverage || null,
  };
}

const weight = (s) => ({ high: 3, med: 2, low: 1 }[s] || 0);
const band = (s) => (s >= 80 ? 'Good' : s >= 50 ? 'Okay' : 'Needs work');
const wrap = (score, findings, extra = {}) => ({
  score: score === null ? null : Math.max(0, Math.min(100, Math.round(score))),
  band: score === null ? 'Not available' : band(score),
  findings,
  ...extra,
});

/* ---------------- Speed ---------------- */
function scoreSpeed(speed) {
  if (!speed || speed.error) return wrap(null, [], { error: speed?.error });

  const findings = [];
  const score = speed.score;

  if (score < 70) {
    findings.push({
      category: 'Speed',
      severity: score < 50 ? 'high' : 'med',
      text: `Performance score is ${score}/100 on mobile. Slow pages lose visitors before they see anything.`,
    });
  }

  const lcp = speed.labMetrics?.largestContentfulPaint;
  if (lcp?.value > 2500) {
    findings.push({
      category: 'Speed',
      severity: lcp.value > 4000 ? 'high' : 'med',
      text: `Your main content takes ${(lcp.value / 1000).toFixed(1)}s to appear (${lcp.display}). Google considers anything over 2.5s slow.`,
    });
  }

  const cls = speed.labMetrics?.cumulativeLayoutShift;
  if (cls?.value > 0.1) {
    findings.push({
      category: 'Speed',
      severity: 'med',
      text: `Page content jumps around as it loads (layout shift ${cls.value.toFixed(2)}). This makes people mis-tap buttons.`,
    });
  }

  (speed.opportunities || []).slice(0, 2).forEach((o) => {
    findings.push({
      category: 'Speed',
      severity: o.savingsMs > 1000 ? 'med' : 'low',
      text: `${o.title} — could save about ${(o.savingsMs / 1000).toFixed(1)}s.`,
    });
  });

  return wrap(score, findings, {
    source: speed.source,
    fieldDataAvailable: speed.fieldData?.available || false,
  });
}

/* ---------------- UI/UX ---------------- */
function scoreUiUx(uiux) {
  if (!uiux || uiux.error) return wrap(null, [], { error: uiux?.error });

  // The vision model returns its own 0-100 judgement plus described issues.
  const findings = (uiux.issues || []).map((i) => ({
    category: 'UI/UX',
    severity: i.severity || 'med',
    text: `${i.what} ${i.why ? `— ${i.why}` : ''}${i.fix ? ` Fix: ${i.fix}` : ''}`.trim(),
  }));
  const shotList = (uiux.screenshots || []).map((s, index) => ({ index: s.index ?? index, label: s.label, viewport: s.viewport }));

  if (uiux.score === null && !uiux.verdict) {
    return wrap(null, findings, { note: uiux.note || 'AI verdict unavailable.' });
  }

  return wrap(uiux.score, findings, {
    verdict: uiux.verdict,
    strengths: uiux.strengths || [],
    screenshots: shotList,
    issues: uiux.issues || [],
  });
}

/* ---------------- Technology ---------------- */
function scoreTechnology(tech) {
  if (!tech || tech.error) return wrap(null, [], { error: tech?.error });

  const list = tech.technologies || [];
  const findings = [];

  if (list.length === 0) {
    findings.push({
      category: 'Technology',
      severity: 'low',
      text: 'We could not identify the technology behind this site — it may be fully custom-built, or blocking automated checks.',
    });
  }

  const hasAnalytics = list.some((t) => t.categories.includes('Analytics'));
  if (!hasAnalytics) {
    findings.push({
      category: 'Technology',
      severity: 'med',
      text: 'No website analytics detected. Without it you have no idea how many people visit or where they drop off.',
    });
  }

  const hasCdn = list.some((t) => t.categories.includes('CDN'));
  if (!hasCdn) {
    findings.push({
      category: 'Technology',
      severity: 'low',
      text: 'No content delivery network detected. A CDN would make your site load faster for visitors far from your server.',
    });
  }

  // Detection breadth is a proxy for confidence, not site quality, so keep
  // this score conservative and let the findings carry the real message.
  const score = list.length === 0 ? 40 : Math.min(100, 55 + list.length * 5);
  return wrap(score, findings, { detected: list.map((t) => t.name) });
}

/* ---------------- SEO ---------------- */
function scoreSeo(seo, pages = []) {
  const entry = seo?.entryPage;
  const site = seo?.siteLevel;
  if (!entry || entry.error) return wrap(null, [], { error: entry?.error });

  const findings = [];
  let score = 100;

  if (!entry.title.present) {
    score -= 20;
    findings.push({ category: 'SEO', severity: 'high', text: 'This page has no title tag. Google shows the title as your headline in search results.' });
  } else if (!entry.title.ok) {
    score -= 8;
    findings.push({ category: 'SEO', severity: 'low', text: `Page title is ${entry.title.length} characters. Aim for 30-60 so Google doesn't cut it off.` });
  }

  if (!entry.metaDescription.present) {
    score -= 12;
    findings.push({ category: 'SEO', severity: 'med', text: 'No meta description. Google will invent one from your page text, which usually reads badly in search results.' });
  } else if (!entry.metaDescription.ok) {
    score -= 5;
    findings.push({ category: 'SEO', severity: 'low', text: `Meta description is ${entry.metaDescription.length} characters. Aim for 70-160.` });
  }

  if (entry.metaRobots?.noindex) {
    score -= 40;
    findings.push({ category: 'SEO', severity: 'high', text: 'This page tells Google not to index it (noindex). It will never appear in search results.' });
  }

  if (entry.headings.h1Count === 0) {
    score -= 10;
    findings.push({ category: 'SEO', severity: 'med', text: 'No main heading (H1) on the page. Search engines use it to understand what the page is about.' });
  } else if (entry.headings.h1Count > 1) {
    score -= 5;
    findings.push({ category: 'SEO', severity: 'low', text: `Page has ${entry.headings.h1Count} main headings (H1). There should be exactly one.` });
  }

  if (entry.images.missingAlt > 0) {
    score -= Math.min(12, entry.images.missingAlt * 2);
    findings.push({ category: 'SEO', severity: 'low', text: `${entry.images.missingAlt} of ${entry.images.total} images have no alt text. Alt text helps image search and screen readers.` });
  }

  if (!entry.structuredData.present) {
    score -= 8;
    findings.push({ category: 'SEO', severity: 'low', text: 'No structured data found. Adding it can get you star ratings, FAQs and other rich results in Google.' });
  }

  if (!entry.canonical.present) {
    score -= 5;
    findings.push({ category: 'SEO', severity: 'low', text: 'No canonical tag. This can cause Google to treat duplicate versions of a page as separate pages.' });
  }

  if (entry.content.thin) {
    score -= 10;
    findings.push({ category: 'SEO', severity: 'med', text: `Only ${entry.content.wordCount} words of content on this page. Thin pages rarely rank for anything competitive.` });
  }

  if (!entry.viewportMeta) {
    score -= 10;
    findings.push({ category: 'SEO', severity: 'high', text: 'No mobile viewport tag. Your site will render at desktop width on phones, and Google ranks mobile-first.' });
  }

  if (entry.brokenLinks?.broken?.length) {
    score -= Math.min(12, entry.brokenLinks.broken.length * 4);
    findings.push({
      category: 'SEO',
      severity: 'med',
      text: `${entry.brokenLinks.broken.length} broken internal link(s) found (checked ${entry.brokenLinks.checked}). Broken links waste crawl budget and frustrate visitors.`,
    });
  }

  if (site && !site.sitemap?.found) {
    score -= 10;
    findings.push({ category: 'SEO', severity: 'med', text: 'No sitemap.xml found. A sitemap tells Google every page you want indexed.' });
  }

  if (site && !site.robotsTxt?.found) {
    score -= 5;
    findings.push({ category: 'SEO', severity: 'low', text: 'No robots.txt found at your site root.' });
  } else if (site && site.robotsTxt?.allowsCrawling === false) {
    score -= 40;
    findings.push({ category: 'SEO', severity: 'high', text: 'Your robots.txt is blocking search engines from crawling this page.' });
  }

  /* --- cross-page duplicate detection (needs the multi-page sweep) --- */
  const duplicates = findDuplicates(pages);
  if (duplicates.titles.length) {
    score -= 8;
    findings.push({
      category: 'SEO',
      severity: 'med',
      text: `${duplicates.titles.length} set(s) of pages share the same title tag. Google struggles to tell those pages apart.`,
    });
  }
  if (duplicates.descriptions.length) {
    score -= 5;
    findings.push({
      category: 'SEO',
      severity: 'low',
      text: `${duplicates.descriptions.length} set(s) of pages share the same meta description.`,
    });
  }

  return wrap(score, findings, {
    pagesChecked: pages.filter((p) => p.seo && !p.seo.error).length,
    duplicateTitles: duplicates.titles.length,
    duplicateDescriptions: duplicates.descriptions.length,
  });
}

function findDuplicates(pages) {
  const titleMap = new Map();
  const descMap = new Map();

  pages.forEach((p) => {
    const t = p.seo?.title?.value;
    const d = p.seo?.metaDescription?.value;
    if (t) titleMap.set(t, (titleMap.get(t) || 0) + 1);
    if (d) descMap.set(d, (descMap.get(d) || 0) + 1);
  });

  return {
    titles: [...titleMap.entries()].filter(([, n]) => n > 1).map(([v]) => v),
    descriptions: [...descMap.entries()].filter(([, n]) => n > 1).map(([v]) => v),
  };
}

/* ---------------- Security ---------------- */
function scoreSecurity(security, pages = []) {
  if (!security || security.error) return wrap(null, [], { error: security?.error });

  const findings = [];
  let score = 100;

  if (!security.https) {
    score -= 45;
    findings.push({ category: 'Security', severity: 'high', text: 'Your site is not served over HTTPS. Browsers show a "Not secure" warning, and Google ranks HTTP sites lower.' });
  }

  const cert = security.certificate;
  if (cert?.tested) {
    if (cert.expired) {
      score -= 45;
      findings.push({ category: 'Security', severity: 'high', text: 'Your SSL certificate has expired. Visitors will see a full-page security warning.' });
    } else if (!cert.valid) {
      score -= 35;
      findings.push({ category: 'Security', severity: 'high', text: `SSL certificate does not validate (${cert.validationError || cert.error}). Visitors may see a security warning.` });
    } else if (cert.expiringSoon) {
      score -= 12;
      findings.push({ category: 'Security', severity: 'high', text: `SSL certificate expires in ${cert.daysRemaining} days. Confirm auto-renewal is switched on.` });
    }

    if (cert.hostnameMatches === false) {
      score -= 20;
      findings.push({ category: 'Security', severity: 'high', text: 'Your SSL certificate does not cover this domain name, which triggers a browser warning.' });
    }
    if (cert.modernProtocol === false) {
      score -= 10;
      findings.push({ category: 'Security', severity: 'med', text: `Your server negotiated ${cert.protocol}, an outdated encryption version. TLS 1.2 or 1.3 is expected.` });
    }
  }

  const missing = security.missingHeaders || [];
  missing.forEach((m) => { score -= m.severity === 'high' ? 10 : m.severity === 'med' ? 6 : 3; });
  if (missing.length) {
    const high = missing.filter((m) => m.severity === 'high').map((m) => m.header);
    findings.push({
      category: 'Security',
      severity: high.length ? 'high' : 'med',
      text: `${missing.length} security header(s) missing: ${missing.map((m) => m.header).join(', ')}. These are one-line server settings that block common attacks.`,
    });
  }

  if (security.mixedContent?.count > 0) {
    score -= 15;
    findings.push({ category: 'Security', severity: 'high', text: `${security.mixedContent.count} insecure (http://) resource(s) loaded on a secure page. Browsers may block them and show a broken padlock.` });
  }

  if (security.exposedPaths?.exposed?.length) {
    score -= 30;
    findings.push({
      category: 'Security',
      severity: 'high',
      text: `Sensitive file(s) publicly accessible: ${security.exposedPaths.exposed.map((e) => e.path).join(', ')}. These can leak passwords or source code — remove them immediately.`,
    });
  }

  const disclosure = security.informationDisclosure || [];
  const versionLeaks = disclosure.filter((d) => d.revealsVersion);
  if (versionLeaks.length) {
    score -= 6;
    findings.push({
      category: 'Security',
      severity: 'low',
      text: `Your server publicly reports its exact software version (${versionLeaks.map((d) => d.value).join(', ')}). This tells attackers which known exploits to try.`,
    });
  }

  const badCookies = (security.cookies || []).filter((c) => !c.secure || !c.httpOnly);
  if (badCookies.length) {
    score -= 8;
    findings.push({
      category: 'Security',
      severity: 'med',
      text: `${badCookies.length} cookie(s) missing Secure or HttpOnly flags, which makes session hijacking easier.`,
    });
  }

  if (security.httpsRedirect?.tested && !security.httpsRedirect.redirectsToHttps) {
    score -= 10;
    findings.push({ category: 'Security', severity: 'med', text: 'The http:// version of your site does not redirect to https://, so visitors can land on the insecure version.' });
  }

  return wrap(score, findings, {
    pagesChecked: pages.filter((p) => p.security && !p.security.error).length,
  });
}

/* ---------------- Social ---------------- */
function scoreSocial(social) {
  if (!social || social.error) return wrap(null, [], { error: social?.error });

  const findings = [];
  let score = 100;

  const linked = social.profiles?.count || 0;
  if (linked === 0) {
    score -= 30;
    findings.push({ category: 'Social Media', severity: 'med', text: 'No social media profiles are linked anywhere on your page. Visitors have no way to follow or verify you.' });
  } else if (social.profiles.missingExpected?.length) {
    score -= social.profiles.missingExpected.length * 5;
    findings.push({
      category: 'Social Media',
      severity: 'low',
      text: `No link to ${social.profiles.missingExpected.join(', ')}. If you have those accounts, link them.`,
    });
  }

  if (social.profiles?.deadLinks?.length) {
    score -= social.profiles.deadLinks.length * 10;
    findings.push({
      category: 'Social Media',
      severity: 'med',
      text: `${social.profiles.deadLinks.length} social link(s) are broken: ${social.profiles.deadLinks.map((d) => d.platform).join(', ')}. They lead visitors to a dead end.`,
    });
  }

  const og = social.openGraph;
  if (!og?.image) {
    score -= 25;
    findings.push({ category: 'Social Media', severity: 'high', text: 'No preview image set (og:image). When anyone shares your link on WhatsApp, Facebook or LinkedIn, it appears as a plain grey box.' });
  } else if (og.imageReachable && !og.imageReachable.ok) {
    score -= 20;
    findings.push({ category: 'Social Media', severity: 'high', text: 'Your share preview image is set but does not load. Shared links will show a broken preview.' });
  }

  if (!og?.title || !og?.description) {
    score -= 12;
    const missing = (og?.missing || []).join(', ');
    findings.push({ category: 'Social Media', severity: 'med', text: `Share preview text is incomplete (missing ${missing}). Shared links will show whatever the platform guesses.` });
  }

  if (!social.twitterCard?.present) {
    score -= 8;
    findings.push({ category: 'Social Media', severity: 'low', text: 'No Twitter Card tags. Links shared on X will show a smaller, plainer preview.' });
  }

  if (!social.shareButtons?.present) {
    score -= 5;
    findings.push({ category: 'Social Media', severity: 'low', text: 'No share buttons on the page, so visitors who want to pass your page on have to copy the URL manually.' });
  }

  return wrap(score, findings, {
    linkedPlatforms: (social.profiles?.linked || []).map((p) => p.platform),
    scannedPage: social.scannedPage,
  });
}

module.exports = { formatAuditResult };
