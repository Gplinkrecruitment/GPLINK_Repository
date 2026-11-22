import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// WP-21, switch ON: the Australian landing page and the site's positioning,
// asked of the real server (the pages are resolved at serve time, so the file
// on disk is not what a visitor gets).
//
// The acceptance line: an Australian GP can go from the home page to a booked
// call without reading the words "overseas" or "relocate" (or any other word
// in AGENT-RULES section 4). "What the Australian visitor reads" is defined
// here as:
//   1. the shared header, menu and footer of the home page,
//   2. the Australian door on the home hero (the other door, and the hero
//      under it, belong to the doctor moving country and stay as they are),
//   3. everything on /australian-gps (head tags a search result shows, every
//      piece of text, every label, placeholder and alt text),
//   4. the form's Australian branch (js/site-au-lead.js, all of it),
//   5. the booking step: every string the booking script can put on screen.

const require = createRequire(import.meta.url);
const site = require('../lib/site-au-pages.js');
const words = require('./helpers/au-banned-words.js');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://www.mygplink.com.au';

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let port;
const savedSwitch = process.env.AU_PATHWAY_ENABLED;

function get(urlPath, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-wp21-on-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-wp21-on-${RUN_ID}.json`;
  process.env.AU_PATHWAY_ENABLED = 'true';
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (savedSwitch === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = savedSwitch;
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

function gpSessionCookie() {
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const payload = b64(JSON.stringify({ userProfile: { email: 'dr.test.wp21@gplink-test.local' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `gp_session=${encodeURIComponent(payload + '.' + sig)}`;
}

const on = () => { process.env.AU_PATHWAY_ENABLED = 'true'; };

// ── Reading a page the way a person does ──────────────────────────────────

const noComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, ' ');

/** Text between tags, plus the attributes a person reads or hears. */
function visibleText(html) {
  const h = noComments(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const attrs = [];
  h.replace(/\s(?:placeholder|aria-label|alt|title|content|value)="([^"]*)"/g, (all, v) => { attrs.push(v); return all; });
  return words.htmlText(h) + '\n' + attrs.join('\n');
}

function between(html, startRe, endStr) {
  const m = startRe.exec(html);
  if (!m) return '';
  const end = html.indexOf(endStr, m.index);
  return end === -1 ? '' : html.slice(m.index, end + endStr.length);
}
const headerOf = (html) => between(html, /<header class="site-header"/, '</header>');
const footerOf = (html) => between(html, /<footer class="site-footer"/, '</footer>');

/** Every string literal in a script (what it can put on a screen). A `sel:`
 *  value is a CSS selector the script looks elements up by, never shown. */
function stringLiterals(js) {
  const src = words.stripJsComments(js).replace(/\bsel: '[^']*'/g, 'sel: 0');
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}

const SITE_ROUTES = ['/', '/jobs', '/jobs/view', '/employers', '/about', '/faq', '/the-app', '/gp-jobs', '/visa', '/exclusive-placements', '/start'];
const AU_ROUTES = Object.keys(site.AU_ONLY_SITE_ROUTES);
// Pages written for the doctor moving country keep their Visa link.
const MOVING_PAGES = ['/gp-jobs', '/visa', '/start'];

describe('switch on: home page to a booked call, as an Australian GP reads it', () => {
  let home; let landing; let door; let bookingScript;

  beforeAll(async () => {
    on();
    home = (await get('/')).text;
    landing = (await get('/australian-gps')).text;
    door = between(home, /<a class="aud-door" href="\/australian-gps"/, '</a>');
    const scripts = [...landing.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    bookingScript = scripts.find((s) => s.includes('CAL_BASE')) || '';
  });

  it('step 1: the home hero has two doors, and the Australian one leads to /australian-gps', () => {
    const doors = [...home.matchAll(/<a class="aud-door[^"]*" href="([^"]+)" data-aud="([a-z]+)">([\s\S]*?)<\/a>/g)];
    expect(doors.map((d) => [d[2], d[1]])).toEqual([['moving', '#help'], ['au', '/australian-gps']]);
    expect(words.htmlText(doors[0][3])).toContain('Moving to Australia');
    expect(words.htmlText(doors[1][3])).toContain('Already practising in Australia');
    expect(door).toContain('Ahpra');
    // The doors sit inside the hero, above the hero that belongs to the first of them.
    const hero = between(home, /<section class="hero">/, '</section>');
    expect(hero.indexOf('aud-doors')).toBeGreaterThan(-1);
    expect(hero.indexOf('aud-doors')).toBeLessThan(hero.indexOf('Take your GP career to&nbsp;Australia'));
    // The hero for the doctor moving country is kept, word for word.
    expect(hero).toContain('<div class="eyebrow stage d1">Move to Australia as a GP</div>');
    expect(hero).toContain('Expert, end-to-end support with AHPRA registration, visa sponsorship and finding the right practice');
  });

  it('step 2: /australian-gps is served, and carries the form and the booking step itself', () => {
    expect(landing).toContain('<section class="block" id="book" data-lead-segment="au">');
    expect(landing).toContain('<form id="consultForm" novalidate>');
    expect(bookingScript).not.toBe('');
    // The preset: data-lead-segment="au" on #book opens the first question answered Yes.
    expect(bookingScript).toContain("bookSection.getAttribute('data-lead-segment') === 'au'");
    expect(bookingScript).toContain('preset: preset');
    // No hop to another page on the way to the calendar.
    expect(landing).not.toMatch(/href="\/start[#?"]/);
    expect(landing).toContain('<a class="btn primary" href="#book">Book a confidential call');
  });

  it('step 3: the booking script is the /start page\'s own script, not a copy', async () => {
    const start = (await get('/start')).text;
    const startScript = [...start.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('CAL_BASE'));
    expect(bookingScript).toBe(startScript);
    // And every element it reaches for by id exists on the landing page.
    const ids = new Set([...bookingScript.matchAll(/getElementById\('([A-Za-z]+)'\)/g)].map((m) => m[1]));
    const listed = /\['slotPicker'[^\]]*\]/.exec(bookingScript)[0];
    for (const m of listed.matchAll(/'([A-Za-z]+)'/g)) ids.add(m[1]);
    for (const m of /\['bookEmailMatch'[^\]]*\]/.exec(bookingScript)[0].matchAll(/'([A-Za-z]+)'/g)) ids.add(m[1]);
    expect(ids.size).toBeGreaterThan(25);
    for (const id of ids) expect(landing, 'id ' + id).toContain('id="' + id + '"');
    expect(landing).toContain('class="book-panel');
    expect(landing).toContain('<label for="cfCountry">');
    expect(landing).toContain('class="book-consent"');
    // The booking panel's styles came with it.
    expect(landing).toContain('.book-panel.is-booking{max-width:920px;}');
    expect(landing).toContain('#calendlyEmbed{min-width:320px;height:1040px;}');
  });

  it('the form module the page preloads is the version the booking script loads', () => {
    const src = /var AU_LEAD_SRC = '([^']+)'/.exec(bookingScript)[1];
    expect(landing).toContain('<link rel="preload" as="script" href="' + src + '">');
    expect(fs.existsSync(path.join(ROOT, src.split('?')[0].slice(1)))).toBe(true);
  });

  it('THE ACCEPTANCE LINE: nothing on that path uses a word an Australian doctor must never read', () => {
    const pieces = {
      'home: header and menu': visibleText(headerOf(home)),
      'home: footer': visibleText(footerOf(home)),
      'home: the Australian door': visibleText(door),
      '/australian-gps: head (title, description, share tags)': visibleText(between(landing, /<head>/, '</head>')) + '\n' + (/<title>([^<]*)<\/title>/.exec(landing) || [])[1],
      '/australian-gps: the whole page': visibleText(between(landing, /<body/, '</body>')),
      '/australian-gps: FAQ data for search engines': [...landing.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'),
      'the form, Australian branch (js/site-au-lead.js, all of it)': fs.readFileSync(path.join(ROOT, 'js', 'site-au-lead.js'), 'utf8'),
      'the booking step: every string the script can show': stringLiterals(bookingScript).join('\n'),
    };
    for (const [name, text] of Object.entries(pieces)) {
      expect(text.length, name + ' was found').toBeGreaterThan(20);
      expect(words.bannedLines(text), name).toEqual([]);
      // The two words the acceptance line names, checked on their own as well.
      expect(text, name).not.toMatch(/\boverseas\b/i);
      expect(text, name).not.toMatch(/\brelocat/i);
    }
  });

  it('the check has teeth: the same reading of the home hero for the doctor moving country does find the words', () => {
    const hero = between(home, /<section class="hero">/, '</section>');
    expect(words.bannedIn(visibleText(hero))).toContain('visa');
    expect(words.bannedIn(visibleText((between(home, /<head>/, '</head>'))))).toContain('overseas');
  });

  it('the page says "Ahpra", never "AHPRA"', () => {
    expect(landing).toContain('Ahpra');
    expect(noComments(landing).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')).not.toContain('AHPRA');
  });

  it('?src=fb still lands on the booking step on /start (the ad address), and the same step works on the landing page', async () => {
    const start = (await get('/start?src=fb')).text;
    expect(start).toContain('<section class="block" id="book">');
    for (const page of [start, landing]) {
      expect(page).toContain("if (params.get('src') === 'fb') {");
      expect(page).toContain("show('bookEmailMatch');");
      expect(page).toContain('id="bookEmailMatch"');
      // Campaign tags are still read from the address and sent with the enquiry.
      expect(page).toContain("params.forEach(function (v, k) { if (/^utm_/.test(k)) utm[k] = v; });");
      expect(page).toContain('utm: utm');
      // Booking conversions still fire.
      expect(page).toContain("fbq('track', 'Schedule')");
      expect(page).toContain("gtag('event', 'conversion', { 'send_to': 'AW-18582515388/jRZnCJmY7bodELzd6pxF' })");
    }
    // /book still hops to /start, query intact.
    const hop = await get('/book?src=fb');
    expect(hop.status).toBe(302);
    expect(hop.headers.location).toBe('/start?src=fb#book');
  });
});

describe('switch on: the landing page keeps the content rules', () => {
  let landing; let body; let text;
  beforeAll(async () => {
    on();
    landing = (await get('/australian-gps')).text;
    body = noComments(between(landing, /<body/, '</body>')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ' ');
    text = visibleText(body);
  });

  it('no dollar figures, no percentages, no earnings claims', () => {
    expect(text).not.toMatch(/[$%]/);
    expect(text).not.toMatch(/per ?cent|\bearn(s|ing|ings)?\b|\bincome\b|\bsalary\b|\bremuneration\b|\bpackage\b/i);
    // The only numbers on the page: the length of the call, the six steps.
    const numbers = (text.match(/\d+/g) || []);
    for (const n of numbers) expect(['1', '2', '3', '4', '5', '6', '30', '15'], 'number ' + n).toContain(n);
    expect(body).not.toContain('data-count');
  });

  it('no testimonials, logos, statistics or counts', () => {
    expect(body).not.toMatch(/<blockquote|testimonial|class="[^"]*(quote|review|stars|metric|trust-stat|logo-marquee|partner)/i);
    const images = [...body.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    expect(images.every((src) => src.startsWith('/media/images/site/logo.png'))).toBe(true);
    expect(text).not.toMatch(/GPs placed|satisfaction|placement time|locations/i);
  });

  it('the proof slot is there, empty and hidden, with the rule written beside it', () => {
    expect(landing).toContain('<section class="block au-proof" id="proof" data-au-proof-slot hidden></section>');
    expect(landing).toMatch(/PROOF SLOT \(WEB-22\)[\s\S]*nothing may be invented/);
  });

  it('it promises no role in a city: it says where the practices are today, and that more are being added', () => {
    expect(text).toContain('The practices we work with today are in outer-metropolitan and regional areas, and we are adding more.');
    expect(text).toContain('including when the answer is nothing yet');
    expect(text).not.toMatch(/\b(Sydney|Melbourne|Brisbane|Perth|Adelaide|Canberra|Hobart|Darwin|CBD|inner[- ]city)\b/i);
    expect(text).not.toMatch(/roles? in (every|all|any) /i);
    expect(text).not.toMatch(/\bguarantee/i);
  });

  it('it says who it is for today, and is straight with everyone else', () => {
    expect(text).toContain('Today we place GPs who hold Ahpra registration and are vocationally registered (FRACGP or FACRRM).');
    expect(text).toContain('Tell us your situation and we will be straight about what we can do.');
  });

  it('the confidentiality promise is in the agreed wording, and the six steps are in order', () => {
    expect(text).toContain('We never contact your current practice without asking you first.');
    expect(text).not.toMatch(/never contact your current practice(?! without asking you first)/);
    const steps = [...body.matchAll(/<li class="au-step reveal"><span class="num">(\d)<\/span><b>([^<]+)<\/b>/g)].map((m) => m[2]);
    expect(steps).toEqual(['Talk to us', 'We check your registration', 'You choose who we introduce you to', 'Meet the practice', 'The offer', 'Start after your notice period']);
    expect(text).toContain('We confirm your Ahpra registration on the public register.');
  });

  it('the guide page keeps the same rules and says what it is', async () => {
    const guide = (await get('/australian-gps/changing-practices')).text;
    const gText = visibleText(guide);
    expect(words.bannedLines(gText)).toEqual([]);
    expect(gText).not.toMatch(/[$%]/);
    expect(gText).toContain('This is general information, not legal advice.');
    expect(gText).toContain('Your own contract is what counts.');
    expect(gText).toContain('We are not able to answer it.');
    expect(gText).toContain('We never contact your current practice without asking you first.');
    expect(guide).toContain('<link rel="canonical" href="' + BASE + '/australian-gps/changing-practices">');
  });
});

describe('switch on: every page', () => {
  const pages = {};
  beforeAll(async () => {
    on();
    for (const route of [...SITE_ROUTES, ...AU_ROUTES]) pages[route] = (await get(route)).text;
  });

  it('every page is served, with no marker left in it', () => {
    for (const [route, html] of Object.entries(pages)) {
      expect(html.length, route).toBeGreaterThan(2000);
      expect(html, route).not.toMatch(/<!--\/?au:/);
    }
  });

  it('"Australian GPs" is in the header nav and the mobile menu of every page', () => {
    for (const [route, html] of Object.entries(pages)) {
      const header = headerOf(html);
      const desktop = between(header, /<nav class="nav-links">/, '</nav>');
      const mobile = between(header, /<nav class="site-mobile-menu"/, '</nav>');
      for (const [name, nav] of [['header', desktop], ['mobile menu', mobile]]) {
        expect(nav, route + ' ' + name).toMatch(/<a href="\/australian-gps"( aria-current="page")?>Australian GPs<\/a>/);
        expect(nav, route + ' ' + name).toMatch(/<a href="\/gp-jobs"( aria-current="page")?>Moving to Australia<\/a>/);
        expect(nav, route + ' ' + name).not.toContain('>For GPs<');
        // Everything that was there is still there.
        for (const href of ['/jobs', '/the-app', '/employers', '/about', '/faq']) expect(nav, route + ' ' + name + ' ' + href).toContain('<a href="' + href + '"');
      }
    }
  });

  it('the Visa link stays on the pages written for the doctor moving country, and only there', () => {
    for (const [route, html] of Object.entries(pages)) {
      const chrome = headerOf(html) + footerOf(html);
      if (MOVING_PAGES.includes(route)) expect(chrome, route).toContain('<a href="/visa"');
      else expect(chrome, route).not.toContain('href="/visa"');
    }
    // So the visa page is still reachable from the "Moving to Australia" page.
    expect(headerOf(pages['/gp-jobs'])).toContain('<a href="/visa">Visa</a>');
  });

  it('the footer tagline is neutral on every page', () => {
    for (const [route, html] of Object.entries(pages)) {
      const footer = footerOf(html);
      expect(footer, route).toContain('<p>Helping GPs find the right practice in Australia.</p>');
      expect(footer, route).not.toContain('overseas-trained');
      expect(footer, route).toContain('<a href="/australian-gps">Australian GPs</a>');
    }
  });

  it('the header, menu and footer are free of the banned words on every page an Australian GP may land on', () => {
    for (const [route, html] of Object.entries(pages)) {
      if (MOVING_PAGES.includes(route)) continue;
      expect(words.bannedLines(visibleText(headerOf(html) + footerOf(html))), route).toEqual([]);
    }
  });

  it('every page links the Australian stylesheet, pinned to its version; the live stylesheet and script are untouched', () => {
    for (const [route, html] of Object.entries(pages)) {
      expect(html, route).toContain('<link rel="stylesheet" href="/css/site-au.css?v=20261122a">');
      expect(html, route).toContain('/css/site.css?v=20260902a');
      expect(html, route).toContain('/js/site.js?v=20260729b');
    }
    expect(pages['/start']).toContain("var AU_LEAD_SRC = '/js/site-au-lead.js?v=20261121a';");
  });

  it('canonical addresses are on the www host and match the route', () => {
    const want = {
      '/': BASE + '/', '/jobs': BASE + '/jobs', '/employers': BASE + '/employers', '/about': BASE + '/about', '/faq': BASE + '/faq',
      '/the-app': BASE + '/the-app', '/gp-jobs': BASE + '/gp-jobs', '/visa': BASE + '/visa', '/exclusive-placements': BASE + '/exclusive-placements',
      '/start': BASE + '/start', '/australian-gps': BASE + '/australian-gps', '/australian-gps/changing-practices': BASE + '/australian-gps/changing-practices',
    };
    for (const [route, url] of Object.entries(want)) {
      const found = [...pages[route].matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((m) => m[1]);
      expect(found, route).toEqual([url]);
      if (AU_ROUTES.includes(route)) expect(pages[route], route).toContain('<meta property="og:url" content="' + url + '">');
    }
  });

  it('the new pages carry the same Meta pixel and Google tag as every other site page', () => {
    const snippet = (html) => {
      const m = /if \(\/\^\(www\\\.\|app\\\.\)\?mygplink\\\.com\\\.au\$\/\.test\(location\.hostname\)\) \{[\s\S]*?\n\}\n<\/script>/.exec(html);
      return m ? m[0] : '';
    };
    const reference = snippet(pages['/start']);
    expect(reference).toContain("fbq('init', '2269935553370606');");
    expect(reference).toContain('GTM-WNH5QC74');
    for (const route of AU_ROUTES) expect(snippet(pages[route]), route).toBe(reference);
    // And the magic-link token is scrubbed before either loads.
    for (const route of AU_ROUTES) expect(pages[route].indexOf("_cu.searchParams.delete('lead')"), route).toBeLessThan(pages[route].indexOf('fbevents.js'));
  });

  it('About and The app no longer tell an Australian GP the service is for someone else', () => {
    const about = pages['/about'];
    expect(about).toContain('<h1 data-split="0.3">We help GPs find the right practice in Australia</h1>');
    expect(about).not.toContain('We move GP careers to Australia');
    expect(about).toContain('Two kinds of doctor, one team');
    expect(about).toContain('<a class="au-who-card reveal" href="/australian-gps">');
    expect(about).toContain('<div class="sec-eyebrow">If you are moving to Australia</div>');
    expect(visibleText(between(about, /<section class="about-hero">/, '</section>'))).not.toMatch(/overseas/i);
    // The content for the doctor moving country is all still there.
    expect(about).toContain('<h3>Registration &amp; AHPRA</h3>');
    expect(about).toContain('<h3>Visa &amp; migration</h3>');
    expect(about).toContain('<h3>Relocation &amp; settling in</h3>');

    const app = pages['/the-app'];
    expect(app).toContain('<h1 data-split="0.3">Your GP career in Australia, in one&nbsp;app</h1>');
    expect(app).toContain('<section class="block au-appband" id="australian-gps">');
    expect(app).toContain('If you are moving to Australia: your whole move, one place');
    expect(app).toContain('<h3>Pathway tracking</h3>');
    const band = visibleText(between(app, /<section class="block au-appband"/, '</section>'));
    expect(words.bannedLines(band)).toEqual([]);
  });

  it('/exclusive-placements: the one line is softened, the rest is as it was', () => {
    const excl = pages['/exclusive-placements'];
    expect(excl).toContain('that fit your skills, your registration and the way you want to work.');
    expect(excl).not.toContain('visa status');
    expect(words.bannedLines(visibleText(between(excl, /<section class="excl-hero">/, '<footer'))).length).toBe(0);
  });

  it('no role count is stated on the pages this package owns (WEB-21)', () => {
    expect(pages['/']).toContain('<button class="go" type="submit">Search jobs</button>');
    expect(pages['/']).not.toContain('Search 240 jobs');
    expect(pages['/']).not.toContain('id="jobsCount"');
    expect(pages['/']).not.toContain('jobs available right now');
    expect(pages['/about']).not.toContain('id="aboutJobsCount"');
    expect(pages['/about']).not.toContain('live jobs available right now');
    expect(pages['/jobs']).toContain('<title>GP Jobs in Australia: Browse Open Roles | GP Link</title>');
    expect(pages['/jobs']).not.toContain('1,400+');
    for (const route of AU_ROUTES) expect(visibleText(pages[route]), route).not.toMatch(/\b\d[\d,]*\+? (jobs|roles|locations)\b/i);
  });

  it('a direct hit on a new page\'s file goes to its clean address (signed out: to sign-in, like any other /pages/ file)', async () => {
    on();
    for (const [route, file] of Object.entries(site.AU_ONLY_SITE_ROUTES)) {
      const res = await get('/' + file.replace(/\.html$/, ''), { cookie: gpSessionCookie() });
      expect(res.status, file).toBe(302);
      expect(res.headers.location, file).toBe(route);
      const anon = await get('/' + file.replace(/\.html$/, ''));
      expect(anon.status, file).toBe(302);
      expect(anon.headers.location, file).toMatch(/^\/pages\/signin\?next=/);
    }
  });

  it('only the real site host may be indexed: the new pages follow the same rule as the rest', async () => {
    on();
    const real = await get('/australian-gps', { host: 'www.mygplink.com.au' });
    expect(real.status).toBe(200);
    expect(real.headers['x-robots-tag']).toBeUndefined();
    const app = await get('/australian-gps', { host: 'app.mygplink.com.au' });
    expect(app.status).toBe(200);
    expect(app.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});

describe('switch on: structured data and head tags (WEB-20)', () => {
  const ld = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const clean = (fragment) => words.htmlText(fragment).replace(/\s+/g, ' ').trim();
  function visibleFaq(html) {
    return [...noComments(html).matchAll(/<button class="faq-q">([\s\S]*?)<\/button>\s*<div class="faq-a"><div>([\s\S]*?)<\/div><\/div>/g)]
      .map((m) => ({ q: clean(m[1]), a: clean(m[2]) }));
  }

  it('Organization schema is in one place: the home page', async () => {
    on();
    const found = {};
    for (const route of [...SITE_ROUTES, ...AU_ROUTES]) {
      found[route] = ld((await get(route)).text).filter((d) => d['@type'] === 'Organization').length;
    }
    expect(found['/']).toBe(1);
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(1);
    const org = ld((await get('/')).text).find((d) => d['@type'] === 'Organization');
    expect(org['@context']).toBe('https://schema.org');
    expect(org.name).toBe('GP Link');
    expect(org.url).toBe(BASE + '/');
    expect(org.logo).toBe(BASE + '/media/images/site/logo.png');
    expect(fs.existsSync(path.join(ROOT, 'media/images/site/logo.png'))).toBe(true);
    expect(org.email).toBe('hello@mygplink.com.au');
    expect(words.bannedLines(words.allStrings(org))).toEqual([]);
    // Nothing unverifiable: no rating, no review, no counts.
    expect(Object.keys(org).sort()).toEqual(['@context', '@type', 'areaServed', 'description', 'email', 'logo', 'name', 'sameAs', 'url']);
  });

  for (const route of ['/faq', '/australian-gps']) {
    it(`${route}: FAQPage schema says exactly what the visible questions and answers say`, async () => {
      on();
      const html = (await get(route)).text;
      const pagesLd = ld(html).filter((d) => d['@type'] === 'FAQPage');
      expect(pagesLd.length).toBe(1);
      const fromLd = pagesLd[0].mainEntity.map((e) => {
        expect(e['@type']).toBe('Question');
        expect(e.acceptedAnswer['@type']).toBe('Answer');
        return { q: e.name, a: e.acceptedAnswer.text };
      });
      const shown = visibleFaq(html);
      expect(shown.length).toBeGreaterThanOrEqual(7);
      expect(fromLd).toEqual(shown);
    });
  }

  it('pages with no visible FAQ carry no FAQPage schema', async () => {
    on();
    for (const route of ['/', '/about', '/the-app', '/start', '/australian-gps/changing-practices']) {
      const html = (await get(route)).text;
      expect(ld(html).filter((d) => d['@type'] === 'FAQPage').length, route).toBe(0);
    }
  });

  it('the blog gets a specific title, a canonical for the address asked for, and the pixel', async () => {
    on();
    const slugs = [...fs.readFileSync(path.join(ROOT, 'pages', 'blog.html'), 'utf8').matchAll(/slug:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(0);
    const index = (await get('/blog')).text;
    expect(index).toContain('<title>GP Link Blog: Guidance for GPs on Working in Australia | GP Link</title>');
    expect(index).not.toContain('<title>GP Link Blog</title>');
    expect(index).toContain('<link rel="canonical" href="' + BASE + '/blog" />');
    expect(index).toContain("fbq('init', '2269935553370606');");
    expect(index).toContain('GTM-WNH5QC74');
    const post = (await get('/blog/' + slugs[0])).text;
    expect(post).toContain('<link rel="canonical" href="' + BASE + '/blog/' + slugs[0] + '" />');
    expect(post).toContain('<meta property="og:url" content="' + BASE + '/blog/' + slugs[0] + '" />');
    // An address that is not a post never becomes a canonical of its own.
    const junk = (await get('/blog/not-a-post"><script>')).text;
    expect(junk).toContain('<link rel="canonical" href="' + BASE + '/blog" />');
    const viaPages = (await get('/pages/blog')).text;
    expect(viaPages).toContain('<link rel="canonical" href="' + BASE + '/blog" />');
  });

  it('the sitemap lists the new pages, on the www host, after the existing routes', async () => {
    on();
    const xml = (await get('/sitemap.xml')).text;
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const route of AU_ROUTES) expect(locs).toContain(BASE + route);
    for (const route of SITE_ROUTES) expect(locs).toContain(BASE + route);
    expect(locs.indexOf(BASE + '/australian-gps')).toBe(SITE_ROUTES.length);
    expect(new Set(locs).size).toBe(locs.length);
  });
});
