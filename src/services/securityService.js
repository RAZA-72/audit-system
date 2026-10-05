const tls = require('tls');
const { httpClient } = require('../utils/httpClient');

/**
 * Security audit - fully custom, no SSL Labs / VirusTotal dependency.
 *
 * PARAMETERS CHECKED:
 *
 *  SSL/TLS certificate
 *    valid                 does the cert verify against a trusted root
 *    issuer                who issued it
 *    subject / altNames    which hostnames it actually covers
 *    hostname match        does it cover the domain we requested
 *    validFrom / validTo   issue and expiry dates
 *    daysRemaining         days until expiry (warn under 30, critical under 14)
 *    protocol              negotiated TLS version (TLS 1.2+ expected)
 *    cipher                negotiated cipher suite
 *
 *  Security headers
 *    Strict-Transport-Security   forces HTTPS on repeat visits
 *    Content-Security-Policy     limits where scripts can load from (XSS defence)
 *    X-Frame-Options             stops your site being framed (clickjacking)
 *    X-Content-Type-Options      stops MIME-type sniffing
 *    Referrer-Policy             controls what URL data leaks to other sites
 *    Permissions-Policy          restricts camera/mic/geolocation access
 *    Cross-Origin-Opener-Policy  isolates your page from other windows
 *
 *  Information disclosure (headers that tell attackers what to target)
 *    Server                      exposes web server and often its version
 *    X-Powered-By                exposes PHP/ASP.NET and often its version
 *    X-AspNet-Version            exposes exact framework version
 *
 *  Transport & cookies
 *    HTTPS in use                is the page served over HTTPS at all
 *    HTTP -> HTTPS redirect      does the insecure version redirect
 *    Mixed content               http:// assets on an https:// page
 *    Cookie flags                Secure, HttpOnly, SameSite on Set-Cookie
 *
 *  Exposed paths (common accidental leaks)
 *    /.env, /.git/config, /wp-config.php.bak, /phpinfo.php, /.DS_Store
 *
 * NOT checked: malware/blacklist reputation. That needs aggregated
 * threat-intel from dozens of vendors (VirusTotal-style) which cannot be
 * self-built. Free feeds (PhishTank/URLhaus) can be added later if wanted.
 */

const SECURITY_HEADERS = {
  'strict-transport-security': { key: 'hsts', label: 'Strict-Transport-Security', severity: 'med' },
  'content-security-policy': { key: 'contentSecurityPolicy', label: 'Content-Security-Policy', severity: 'high' },
  'x-frame-options': { key: 'xFrameOptions', label: 'X-Frame-Options', severity: 'med' },
  'x-content-type-options': { key: 'xContentTypeOptions', label: 'X-Content-Type-Options', severity: 'low' },
  'referrer-policy': { key: 'referrerPolicy', label: 'Referrer-Policy', severity: 'low' },
  'permissions-policy': { key: 'permissionsPolicy', label: 'Permissions-Policy', severity: 'low' },
  'cross-origin-opener-policy': { key: 'crossOriginOpenerPolicy', label: 'Cross-Origin-Opener-Policy', severity: 'low' },
};

const DISCLOSURE_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version'];

const EXPOSED_PATHS = ['/.env', '/.git/config', '/phpinfo.php', '/.DS_Store', '/wp-config.php.bak'];

async function runSecurityAudit(url, options = {}) {
  const { checkExposedPaths = true } = options;
  const parsed = new URL(url);

  const [certificate, http, exposed] = await Promise.all([
    parsed.protocol === 'https:' ? inspectCertificate(parsed.hostname) : Promise.resolve({ tested: false, reason: 'Site is not served over HTTPS' }),
    inspectHttp(url),
    checkExposedPaths ? probeExposedPaths(parsed.origin) : Promise.resolve({ checked: 0, exposed: [] }),
  ]);

  return {
    url,
    https: parsed.protocol === 'https:',
    certificate,
    headers: http.headers,
    missingHeaders: http.missingHeaders,
    informationDisclosure: http.informationDisclosure,
    cookies: http.cookies,
    mixedContent: http.mixedContent,
    httpsRedirect: http.httpsRedirect,
    exposedPaths: exposed,
  };
}

/* ---------------- TLS certificate ---------------- */

function inspectCertificate(hostname, port = 443) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 12000 },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const authError = socket.authorizationError;
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();

        if (!cert || !cert.valid_to) {
          socket.end();
          return done({ tested: true, valid: false, error: 'No certificate presented' });
        }

        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const daysRemaining = Math.floor((validTo - Date.now()) / 86400000);

        const altNames = (cert.subjectaltname || '')
          .split(',')
          .map((s) => s.trim().replace(/^DNS:/, ''))
          .filter(Boolean);

        socket.end();
        done({
          tested: true,
          valid: authorized,
          validationError: authorized ? null : String(authError || 'unknown'),
          issuer: cert.issuer?.O || cert.issuer?.CN || null,
          subject: cert.subject?.CN || null,
          altNames,
          hostnameMatches: matchesHostname(hostname, cert.subject?.CN, altNames),
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysRemaining,
          expiringSoon: daysRemaining < 30,
          expired: daysRemaining < 0,
          protocol,
          modernProtocol: protocol ? /TLSv1\.[23]/.test(protocol) : null,
          cipher: cipher ? cipher.name : null,
        });
      }
    );

    socket.on('error', (err) => done({ tested: true, valid: false, error: err.message }));
    socket.on('timeout', () => { socket.destroy(); done({ tested: true, valid: false, error: 'TLS connection timed out' }); });
  });
}

function matchesHostname(hostname, cn, altNames) {
  const names = [cn, ...altNames].filter(Boolean);
  return names.some((n) => {
    if (n.startsWith('*.')) {
      const base = n.slice(2);
      return hostname === base || hostname.endsWith('.' + base);
    }
    return n === hostname;
  });
}

/* ---------------- HTTP response inspection ---------------- */

async function inspectHttp(url) {
  try {
    const res = await httpClient.get(url, { timeout: 12000, validateStatus: () => true });
    const h = res.headers || {};
    const html = typeof res.data === 'string' ? res.data : '';

    const headers = {};
    const missingHeaders = [];
    Object.entries(SECURITY_HEADERS).forEach(([headerName, meta]) => {
      const present = !!h[headerName];
      headers[meta.key] = present ? String(h[headerName]).slice(0, 200) : false;
      if (!present) missingHeaders.push({ header: meta.label, severity: meta.severity });
    });

    const informationDisclosure = DISCLOSURE_HEADERS
      .filter((name) => h[name])
      .map((name) => ({
        header: name,
        value: String(h[name]).slice(0, 100),
        revealsVersion: /\d+\.\d+/.test(String(h[name])),
      }));

    const setCookie = h['set-cookie'] || [];
    const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
    const cookies = cookieList.filter(Boolean).map((c) => {
      const lower = c.toLowerCase();
      return {
        name: c.split('=')[0],
        secure: lower.includes('secure'),
        httpOnly: lower.includes('httponly'),
        sameSite: /samesite=(\w+)/.exec(lower)?.[1] || null,
      };
    });

    // Mixed content: http:// assets loaded by an https:// page.
    const mixed = [];
    if (url.startsWith('https:') && html) {
      const matches = html.match(/(?:src|href)=["']http:\/\/[^"']+["']/gi) || [];
      matches.slice(0, 10).forEach((m) => {
        const extracted = /http:\/\/[^"']+/.exec(m);
        if (extracted) mixed.push(extracted[0]);
      });
    }

    let httpsRedirect = { tested: false };
    if (url.startsWith('https:')) {
      try {
        const origin = new URL(url).origin.replace(/^https:/, 'http:');
        const r = await httpClient.get(origin, { timeout: 10000, maxRedirects: 0, validateStatus: () => true });
        const location = r.headers?.location || '';
        httpsRedirect = {
          tested: true,
          status: r.status,
          redirectsToHttps: r.status >= 300 && r.status < 400 && /^https:/i.test(location),
        };
      } catch (_) { /* leave untested */ }
    }

    return {
      headers,
      missingHeaders,
      informationDisclosure,
      cookies,
      mixedContent: { count: mixed.length, samples: mixed.slice(0, 5) },
      httpsRedirect,
    };
  } catch (err) {
    return {
      headers: { error: err.message },
      missingHeaders: [],
      informationDisclosure: [],
      cookies: [],
      mixedContent: { count: 0, samples: [] },
      httpsRedirect: { tested: false },
    };
  }
}

/* ---------------- exposed path probing ---------------- */

async function probeExposedPaths(origin) {
  const exposed = [];

  await Promise.all(
    EXPOSED_PATHS.map(async (p) => {
      try {
        const res = await httpClient.get(origin + p, {
          timeout: 7000,
          validateStatus: () => true,
          maxRedirects: 0,
        });
        // 200 with real content = genuinely exposed. Many hosts return a
        // 200 HTML error page, so require it not to look like HTML.
        const body = typeof res.data === 'string' ? res.data : '';
        const looksLikeHtml = /<html|<!doctype/i.test(body.slice(0, 200));
        if (res.status === 200 && body.length > 0 && !looksLikeHtml) {
          exposed.push({ path: p, status: res.status, size: body.length });
        }
      } catch (_) { /* not reachable = good */ }
    })
  );

  return { checked: EXPOSED_PATHS.length, exposed };
}

module.exports = { runSecurityAudit };
