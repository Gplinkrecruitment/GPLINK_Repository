import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

// The Google tag (container GTM-WNH5QC74, Google Ads account 534-261-0544) is
// installed on the public marketing pages next to the Meta Pixel. Three things
// must stay true and none of them is visible by looking at the live page:
//   1. every marketing page carries it, exactly once;
//   2. it sits BELOW the ?lead= scrub — the magic-link token is a live bearer
//      credential and the tag reports the full page URL to Google;
//   3. the CSP lets the tag load and report, otherwise it fails silently.

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SITE_PAGES = fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => /^site-.*\.html$/.test(f));
const TAG_SRC = "https://www.googletagmanager.com/gtm.js?id=GTM-WNH5QC74";

describe('Google tag on the marketing pages', () => {
  // WP-21 (Australian GP build): 11 pages on the live site, plus the two that
  // exist only with the Australian switch on (/australian-gps and its guide).
  // The same checks below run on all 13.
  it('covers all 13 marketing pages (11 live, 2 Australian-only)', () => {
    expect(SITE_PAGES.length).toBe(13);
  });

  for (const page of SITE_PAGES) {
    it(`${page} loads the tag once, inside the hostname guard, after the lead-token scrub`, () => {
      const html = read('pages/' + page);
      expect(html.split(TAG_SRC).length - 1).toBe(1);

      const head = html.slice(0, html.indexOf('</head>'));
      const scrub = head.indexOf("searchParams.delete('lead')");
      const guard = head.indexOf('mygplink\\.com\\.au$/.test(location.hostname)');
      const tag = head.indexOf(TAG_SRC);
      expect(scrub).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(scrub);
      expect(tag).toBeGreaterThan(guard);

      // Loaded by script injection so it stays inside the guard — a static
      // <script src> tag would run on preview hosts and before the scrub.
      expect(html).not.toMatch(/<script[^>]+src=["']https:\/\/www\.googletagmanager\.com/);
      expect(head).toContain('window.dataLayer = window.dataLayer || [];');
      expect(head).toContain("gtag('js', new Date());");
    });
  }

  it('is not installed on signed-in app pages', () => {
    for (const page of ['index.html', 'app-shell.html', 'career.html', 'admin.html']) {
      expect(read('pages/' + page)).not.toContain('googletagmanager.com');
    }
  });

  it('is disclosed in the privacy policy', () => {
    const privacy = read('pages/privacy.html');
    expect(privacy).toContain('Google tag');
    expect(privacy).toContain('myadcenter.google.com');
  });
});

describe("Google Ads 'Book appointment' conversion on /start", () => {
  const start = read('pages/site-start.html');
  const SEND_TO = "AW-18582515388/jRZnCJmY7bodELzd6pxF";

  it('is sent to the right conversion action, from one place', () => {
    expect(start.split(SEND_TO).length - 1).toBe(1);
    expect(start).toContain("gtag('event', 'conversion', { 'send_to': '" + SEND_TO + "' });");
  });

  it('fires on BOTH booking paths, next to the Meta Schedule event', () => {
    // Slot picker (onSlotBooked) and the Calendly embed fallback (event_scheduled).
    const pairs = start.split("fbq('track', 'Schedule'); }\n    reportGoogleBooking();").length - 1;
    expect(pairs).toBe(2);
    expect(start.split("fbq('track', 'Schedule')").length - 1).toBe(2);
  });

  it('is guarded and reports once per page view', () => {
    const fn = start.slice(start.indexOf('function reportGoogleBooking()'), start.indexOf('function onSlotBooked('));
    expect(fn).toContain("if (googleBookingReported || typeof gtag !== 'function') return;");
    expect(fn).toContain('googleBookingReported = true;');
  });

  it('is not fired on page load or from any other marketing page', () => {
    for (const page of SITE_PAGES.filter((p) => p !== 'site-start.html')) {
      expect(read('pages/' + page)).not.toContain('AW-18582515388');
    }
    const head = start.slice(0, start.indexOf('</head>'));
    expect(head).not.toContain('AW-18582515388');
  });
});

describe('/start books through the Calendly embed only (slot picker paused)', () => {
  const start = read('pages/site-start.html');

  it('has the picker switched off', () => {
    expect(start).toContain('var SLOT_PICKER_ENABLED = false;');
  });

  it('only opens the picker behind the switch, and falls through to the embed', () => {
    expect(start).toContain('if (SLOT_PICKER_ENABLED && lead.token) { loadSlotPicker(); return; }\n    mountCalendlyEmbed();');
    expect(start).not.toContain('if (lead.token) { loadSlotPicker(); return; }');
  });

  it('still records the booking against the lead and reports it to Google from the embed', () => {
    const listener = start.slice(start.indexOf("e.data.event !== 'calendly.event_scheduled'"));
    expect(listener).toContain('reportGoogleBooking();');
    expect(listener).toContain("post('/api/public/consult-lead/booked'");
  });
});

describe('CSP allows the Google tag', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  let server;
  let port;
  let csp;

  const directive = (name) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ')) || '';

  beforeAll(async () => {
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'test-google-tag-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = 'https://login.mygplink.com.au';
    process.env.SUPABASE_PUBLISHABLE_KEY = '';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = `/tmp/gplink-google-tag-${RUN_ID}.json`;

    const { createServer } = await import('../server.js');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
    csp = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(String(res.headers['content-security-policy'] || '')));
      });
      req.on('error', reject);
      req.end();
    });
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('lets the tag script load', () => {
    expect(directive('script-src')).toContain('https://www.googletagmanager.com');
    expect(directive('script-src')).toContain('https://www.googleadservices.com');
  });

  it('lets the tag report page views and conversions', () => {
    for (const name of ['img-src', 'connect-src']) {
      expect(directive(name)).toContain('https://www.googletagmanager.com');
      expect(directive(name)).toContain('https://*.doubleclick.net');
      expect(directive(name)).toContain('https://www.google.co.uk');
    }
  });

  it('lets the tag open its helper frames', () => {
    expect(directive('frame-src')).toContain('https://www.googletagmanager.com');
    expect(directive('frame-src')).toContain('https://td.doubleclick.net');
  });

  it('keeps the Meta pixel sources', () => {
    expect(directive('script-src')).toContain('https://connect.facebook.net');
    expect(directive('img-src')).toContain('https://www.facebook.com');
  });
});
