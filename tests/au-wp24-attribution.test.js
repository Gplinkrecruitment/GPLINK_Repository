import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

// WP-24 (WEB-13): the first-party attribution cookie, hop by hop.
//   browser (js/site-attribution.js)  -> cookie `gp_attr`
//   server  (lib/au-attribution.js)   -> re-validated, on the lead and the account
// and the rule that turns a lead into "which campaign" without ever guessing.
const require = createRequire(import.meta.url);
const site = require('../js/site-attribution.js');
const attr = require('../lib/au-attribution.js');
const campaignsLib = require('../lib/ads-campaigns.js');
const siteAuPages = require('../lib/site-au-pages.js');
const parity = require('./helpers/au-wp24-parity.js');
const ROOT = path.resolve(__dirname, '..');
const NOW = 1795140000;

const CAMPAIGNS = campaignsLib.adsCampaigns({ FB_AU_GP_LEAD_FORM_IDS: '999' }, { auOn: true });

describe('the browser: what one page view notes', () => {
  it('reads only the listed parameters; an email, a sign-in link or any other parameter is never looked at', () => {
    const seen = site.touchFromLocation(
      'https://www.mygplink.com.au/australian-gps?utm_source=test&utm_campaign=au_test&fbclid=FAKE&email=dr.someone%40example.com&lead=SECRETTOKEN&token=abc#access_token=zzz',
      'https://www.google.com/search?q=private+words', NOW);
    expect(seen.touch).toEqual({ s: 'test', c: 'au_test', fb: 'FAKE', p: '/australian-gps', r: 'www.google.com', t: NOW });
    const everything = JSON.stringify(seen);
    for (const leak of ['example.com', 'someone', 'SECRETTOKEN', 'abc', 'zzz', 'private']) expect(everything).not.toContain(leak);
    expect(seen.tagged).toBe(true);
    expect(seen.referred).toBe(true);
  });

  it('cleans and caps every value; an address inside a tag is dropped whole', () => {
    const long = 'x'.repeat(500);
    const seen = site.touchFromLocation('https://www.mygplink.com.au/start?utm_source=' + long + '&utm_campaign=<script>alert(1)</script>&utm_content=me%40example.com&gclid=ab$c;d', '', NOW);
    expect(seen.touch.s.length).toBe(80);
    expect(seen.touch.c).toBe('script alert 1 script');
    expect(seen.touch.n).toBeUndefined();
    expect(seen.touch.g).toBe('abcd');
    expect(JSON.stringify(seen.touch)).not.toMatch(/[<>$;@]/);
  });

  it('first touch is set once; last touch follows a tagged or referred visit; a plain page view changes nothing', () => {
    const first = site.touchFromLocation('https://www.mygplink.com.au/australian-gps?utm_campaign=au_test&utm_medium=paid', '', NOW);
    let rec = site.nextRecord(null, first);
    expect(rec.f).toEqual(first.touch);
    expect(rec.l).toEqual(first.touch);
    // An ordinary click to another page of the site.
    const inside = site.touchFromLocation('https://www.mygplink.com.au/faq', 'https://www.mygplink.com.au/australian-gps', NOW + 60);
    expect(inside.referred).toBe(false);
    expect(site.nextRecord(rec, inside)).toBeNull();
    // A later visit from another campaign.
    const later = site.touchFromLocation('https://www.mygplink.com.au/start?utm_campaign=uk_test&gclid=G1', '', NOW + 86400);
    rec = site.nextRecord(rec, later);
    expect(rec.f.c).toBe('au_test');
    expect(rec.l.c).toBe('uk_test');
    // A first visit with nothing on the address still notes where they landed.
    const plain = site.nextRecord(null, site.touchFromLocation('https://www.mygplink.com.au/', '', NOW));
    expect(plain.f).toEqual({ p: '/', t: NOW });
    expect(plain.l).toBeNull();
  });

  it('the cookie: 90 days, SameSite=Lax, Secure on https, shared between www. and app. on the real domain only', () => {
    const real = site.cookieString('VALUE', 'www.mygplink.com.au', true);
    expect(real).toBe('gp_attr=VALUE; Path=/; Max-Age=7776000; SameSite=Lax; Domain=.mygplink.com.au; Secure');
    expect(site.cookieString('V', 'app.mygplink.com.au', true)).toContain('Domain=.mygplink.com.au');
    const local = site.cookieString('V', 'site.localhost', false);
    expect(local).toBe('gp_attr=V; Path=/; Max-Age=7776000; SameSite=Lax');
    expect(site.cookieString('V', 'evil-mygplink.com.au.example.com', true)).not.toContain('Domain=');
    expect(site.MAX_AGE_SEC).toBe(90 * 24 * 60 * 60);
    expect(attr.MAX_AGE_SEC).toBe(site.MAX_AGE_SEC);
    expect(attr.COOKIE_NAME).toBe(site.COOKIE_NAME);
  });

  it('run() writes the cookie from the page address and never anything else', () => {
    let written = '';
    const win = {
      document: { referrer: '', get cookie() { return ''; }, set cookie(v) { written = v; } },
      location: { href: 'https://www.mygplink.com.au/australian-gps?utm_source=test&utm_campaign=au_test&fbclid=FAKE&email=x%40y.z', hostname: 'www.mygplink.com.au', protocol: 'https:' }
    };
    expect(site.run(win)).toBe(true);
    const value = written.split(';')[0].split('=')[1];
    const rec = attr.decodeCookie(value);
    expect(rec.first).toMatchObject({ utm_source: 'test', utm_campaign: 'au_test', fbclid: 'FAKE', landing_page: '/australian-gps' });
    expect(Buffer.from(value, 'base64').toString('utf8')).not.toContain('x@y.z');
  });
});

describe('the server never trusts the cookie', () => {
  it('what the browser wrote is what the server reads', () => {
    const seen = site.touchFromLocation('https://www.mygplink.com.au/australian-gps?utm_source=test&utm_campaign=au_test&fbclid=FAKE', 'https://l.facebook.com/x', NOW);
    const rec = attr.recordFromCookie(site.encode(site.nextRecord(null, seen)), '2026-11-20T02:00:00.000Z');
    expect(rec).toEqual({
      v: 1,
      first: { utm_source: 'test', utm_campaign: 'au_test', fbclid: 'FAKE', landing_page: '/australian-gps', referrer: 'l.facebook.com', at: '2026-11-20T02:00:00.000Z' },
      last: { utm_source: 'test', utm_campaign: 'au_test', fbclid: 'FAKE', landing_page: '/australian-gps', referrer: 'l.facebook.com', at: '2026-11-20T02:00:00.000Z' },
      attached_at: '2026-11-20T02:00:00.000Z'
    });
  });

  it('a forged cookie is cleaned field by field, capped, or refused', () => {
    const forge = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const rec = attr.recordFromCookie(forge({ f: {
      s: '<img src=x onerror=alert(1)>', m: 'paid', c: 'dr.jane@example.com', n: 'y'.repeat(900), fb: 'ok"; DROP', g: { nested: true },
      p: 'https://evil.example/steal?x=1', r: 'HTTPS://Evil.Example/path?q=1', t: 'tomorrow', extra: 'kept?', ahpra: 'MED0001234567'
    } }), '2026-11-20T02:00:00.000Z');
    expect(rec.first.utm_source).toBe('img src x onerror alert 1');
    expect(rec.first.utm_campaign).toBeUndefined();       // an email address is never stored
    expect(rec.first.utm_content.length).toBe(80);
    expect(rec.first.fbclid).toBe('okDROP');
    expect(rec.first.gclid).toBe('objectObject');
    expect(rec.first.landing_page).toBeUndefined();       // not a site path
    expect(rec.first.referrer).toBe('evil.example');      // host only
    expect(rec.first.at).toBeUndefined();
    expect(Object.keys(rec.first).sort()).toEqual(['fbclid', 'gclid', 'referrer', 'utm_content', 'utm_medium', 'utm_source']);
    expect(JSON.stringify(rec)).not.toContain('MED0001234567');
    // Not base64url, too long, not JSON, an array, nothing useful: all refused.
    for (const bad of ['', 'not base64 !!', 'x'.repeat(4000), forge([1, 2]), forge({ f: {}, l: {} }), forge('hello'), Buffer.from('{broken').toString('base64')]) {
      expect(attr.recordFromCookie(bad, 'x')).toBeNull();
    }
  });

  it('a returning lead keeps the first touch on file and takes the newer last touch', () => {
    const a = { first: { utm_campaign: 'au_test', landing_page: '/australian-gps' }, last: { utm_campaign: 'au_test' }, attached_at: '2026-11-01T00:00:00.000Z' };
    const b = { first: { utm_campaign: 'other' }, last: { utm_campaign: 'uk_test', gclid: 'G1' }, attached_at: '2026-11-20T00:00:00.000Z' };
    const merged = attr.mergeRecords(a, b);
    expect(merged.first.utm_campaign).toBe('au_test');
    expect(merged.last).toEqual({ utm_campaign: 'uk_test', gclid: 'G1' });
    expect(merged.attached_at).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('which campaign a lead came from: evidence, or "direct / unknown"', () => {
  const lead = (metadata) => ({ metadata });
  it('a Meta lead form names its campaign; an unlisted form is the existing campaign\'s', () => {
    expect(attr.attributionForLead(lead({ source: 'meta_lead_ad', fb_form_id: '999' }), CAMPAIGNS)).toMatchObject({ campaign: 'au_gp', channel: 'meta_lead_form' });
    expect(attr.attributionForLead(lead({ source: 'meta_lead_ad', fb_form_id: '123' }), CAMPAIGNS)).toMatchObject({ campaign: 'overseas_uk', channel: 'meta_lead_form' });
    expect(attr.attributionForLead(lead({ source: 'meta_lead_ad' }), CAMPAIGNS)).toMatchObject({ campaign: 'overseas_uk' });
  });
  it('a paid visit is the campaign whose page it landed on, or whose tag it carries', () => {
    expect(attr.attributionForLead(lead({ source: 'site_start_form', attribution: { last: { fbclid: 'F', landing_page: '/australian-gps' } } }), CAMPAIGNS)).toMatchObject({ campaign: 'au_gp', channel: 'paid', platform: 'meta' });
    expect(attr.attributionForLead(lead({ source: 'site_start_form', attribution: { last: { utm_medium: 'cpc', gclid: 'G', landing_page: '/start' } } }), CAMPAIGNS)).toMatchObject({ campaign: 'overseas_uk', channel: 'paid', platform: 'google' });
    expect(attr.attributionForLead(lead({ source: 'site_start_form', attribution: { last: { utm_medium: 'paid', utm_campaign: 'au_perth_vr', landing_page: '/jobs' } } }), CAMPAIGNS)).toMatchObject({ campaign: 'au_gp' });
  });
  it('a paid visit that names neither is "paid, campaign not known": never guessed', () => {
    const got = attr.attributionForLead(lead({ source: 'site_start_form', attribution: { last: { utm_medium: 'paid', utm_campaign: 'spring', landing_page: '/faq' } } }), CAMPAIGNS);
    expect(got.campaign).toBeNull();
    expect(got.channel).toBe('paid');
  });
  it('no tags and no click id is direct / unknown, even on the Australian page, even for an Australian doctor', () => {
    const organic = attr.attributionForLead(lead({ source: 'site_start_form', consult: { segment: 'au_vr' }, attribution: { first: { landing_page: '/australian-gps' } } }), CAMPAIGNS);
    expect(organic).toMatchObject({ campaign: null, channel: 'direct', label: 'Direct / unknown' });
    expect(attr.attributionForLead(lead({ source: 'site_start_form' }), CAMPAIGNS)).toMatchObject({ campaign: null, channel: 'direct' });
    expect(attr.attributionForLead(lead({ source: 'site_start_form', attribution: { last: { utm_source: 'newsletter', landing_page: '/australian-gps' } } }), CAMPAIGNS)).toMatchObject({ campaign: null, channel: 'referral' });
    expect(attr.attributionForLead(null, CAMPAIGNS)).toMatchObject({ campaign: null, channel: 'direct' });
  });
  it('one lead, one bucket: an Australian lead is never in the UK numbers, and the reverse', () => {
    const b = campaignsLib.bucketForLead;
    expect(b(true, { campaign: 'au_gp' })).toBe('au_gp');
    expect(b(true, { campaign: null })).toBe('au_other');
    expect(b(true, { campaign: 'overseas_uk' })).toBe('au_other');
    expect(b(false, { campaign: 'overseas_uk' })).toBe('overseas_uk');
    expect(b(false, { campaign: null })).toBe('overseas_uk');
    expect(b(false, { campaign: 'au_gp' })).toBe('au_campaign_other');
  });
});

describe('the site pages load the script only with the switch on', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => /^(site-[a-z0-9-]+|blog)\.html$/.test(f));
  it('every site page, switch on: once; switch off: not at all', () => {
    expect(pages.length).toBe(14);
    for (const f of pages) {
      const on = siteAuPages.renderPageFile('/pages/' + f, { on: true, vars: { canonical: 'https://www.mygplink.com.au/blog' } });
      expect(on.html.split('/js/site-attribution.js?v=20261123a').length - 1, f).toBe(1);
      if (!siteAuPages.isAuOnlyPagePath('/pages/' + f)) {
        const off = siteAuPages.renderPageFile('/pages/' + f, { on: false });
        expect(off.html, f).not.toContain('site-attribution');
        expect(off.html, f).not.toContain('wp24');
      }
    }
  });
  it('the booking script sends every Meta and Google call through the gate (both pages that have the form)', () => {
    for (const f of ['site-start.html', 'site-australian-gps.html']) {
      const html = siteAuPages.renderPageFile('/pages/' + f, { on: true }).html;
      expect(html, f).toContain("function fbq() { wp24Send('fbq', arguments); }");
      expect(html, f).toContain("function gtag() { wp24Send('gtag', arguments); }");
      expect(html, f).toContain('wp24Tracking = (j && j.tracking) || null;');
    }
  });
});

describe('the conversion gate on the booking step', () => {
  const none = { auPixelId: null, auGoogleSendTo: null };
  const set = { auPixelId: '777000111222333', auGoogleSendTo: 'AW-18582515388/AuLabel_1' };
  it('a doctor who is not Australian-segment sends exactly what the page asked for', () => {
    expect(site.routeConversion('fbq', ['track', 'Lead'], { isAu: false, tracking: set })).toEqual([{ tool: 'fbq', args: ['track', 'Lead'] }]);
    expect(site.routeConversion('gtag', ['event', 'conversion', { send_to: 'AW-18582515388/jRZnCJmY7bodELzd6pxF' }], { isAu: false, tracking: none }))
      .toEqual([{ tool: 'gtag', args: ['event', 'conversion', { send_to: 'AW-18582515388/jRZnCJmY7bodELzd6pxF' }] }]);
  });
  it('an Australian-segment doctor sends NOTHING until the Australian events are configured', () => {
    expect(site.routeConversion('fbq', ['track', 'Lead'], { isAu: true, tracking: none })).toEqual([]);
    expect(site.routeConversion('fbq', ['track', 'Schedule'], { isAu: true, tracking: null })).toEqual([]);
    expect(site.routeConversion('gtag', ['event', 'conversion', { send_to: 'AW-18582515388/jRZnCJmY7bodELzd6pxF' }], { isAu: true, tracking: none })).toEqual([]);
    expect(site.routeConversion('gtag', ['event', 'conversion', {}], { isAu: true, tracking: { auGoogleSendTo: 'javascript:alert(1)' } })).toEqual([]);
  });
  it('once configured they send different events from a UK doctor, carrying the segment and nothing else', () => {
    const meta = site.routeConversion('fbq', ['track', 'Schedule'], { isAu: true, tracking: set });
    expect(meta).toEqual([
      { tool: 'fbq', args: ['init', '777000111222333'] },
      { tool: 'fbq', args: ['trackSingle', '777000111222333', 'Schedule', { segment: 'australian' }] }
    ]);
    const google = site.routeConversion('gtag', ['event', 'conversion', { send_to: 'AW-18582515388/jRZnCJmY7bodELzd6pxF' }], { isAu: true, tracking: set });
    expect(google).toEqual([{ tool: 'gtag', args: ['event', 'conversion', { send_to: 'AW-18582515388/AuLabel_1' }] }]);
    expect(JSON.stringify(google)).not.toContain('jRZnCJmY7bodELzd6pxF');
  });
});

describe('through the server: the public features answer and the account', () => {
  let rig;
  beforeAll(async () => { rig = await parity.bootWp24Rig(vi, { switchOn: true, fixedClock: false }); });
  afterAll(async () => { if (rig) await rig.close(); });

  it('switch on: the tracking block is there and empty until configured; switch off: the answer is today\'s', async () => {
    let res = await rig.req('GET', '/api/public/features', { host: 'localhost' });
    expect(res.json).toEqual({ ok: true, auPathwayEnabled: true, tracking: { auPixelId: null, auGoogleSendTo: null } });
    process.env.META_AU_PIXEL_ID = '777000111222333';
    process.env.GOOGLE_ADS_AU_CONVERSION_SEND_TO = 'AW-18582515388/AuLabel_1';
    res = await rig.req('GET', '/api/public/features', { host: 'localhost' });
    expect(res.json.tracking).toEqual({ auPixelId: '777000111222333', auGoogleSendTo: 'AW-18582515388/AuLabel_1' });
    process.env.GOOGLE_ADS_AU_CONVERSION_SEND_TO = '"><script>';
    res = await rig.req('GET', '/api/public/features', { host: 'localhost' });
    expect(res.json.tracking.auGoogleSendTo).toBeNull();
    delete process.env.META_AU_PIXEL_ID; delete process.env.GOOGLE_ADS_AU_CONVERSION_SEND_TO;
    rig.setSwitch(false);
    res = await rig.req('GET', '/api/public/features', { host: 'localhost' });
    expect(res.json).toEqual({ ok: true, auPathwayEnabled: false });
    rig.setSwitch(true);
  });

  it('creating an account moves the cookie onto the account (first and last touch) and leaves a one-word flag', async () => {
    const cookie = attr.COOKIE_NAME + '=' + attr.encodeCookie({
      first: { utm_source: 'test', utm_campaign: 'au_test', fbclid: 'FAKE', landing_page: '/australian-gps', at: '2026-11-20T01:00:00.000Z' },
      last: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'au_retarget', landing_page: '/australian-gps/changing-practices', at: '2026-11-21T01:00:00.000Z' }
    });
    const who = { email: 'au.signup.test@gplink-test.local' };
    const got = await rig.testUtils.wp24AttachSignupAttributionForTest(who, { source: 'signup' }, cookie);
    expect(got.result).toEqual({ attached: true, segment: 'australian' });
    expect(got.stored.first).toMatchObject({ utm_campaign: 'au_test', fbclid: 'FAKE', landing_page: '/australian-gps' });
    expect(got.stored.last).toMatchObject({ utm_campaign: 'au_retarget', landing_page: '/australian-gps/changing-practices' });
    expect(got.stored).toMatchObject({ source: 'signup', campaign: 'au_gp', channel: 'paid', segment: 'australian' });
    // Nothing about the person is in the record or the flag.
    expect(JSON.stringify(got.stored)).not.toContain('au.signup.test');
    expect(got.cookies.length).toBe(1);
    expect(got.cookies[0]).toMatch(/^gp_signup_evt=australian; Path=\/; SameSite=Lax; Max-Age=1800$/);
    expect(got.cookies[0]).not.toContain('HttpOnly');

    // A later sign-in with a different cookie never rewrites how the account began.
    const again = await rig.testUtils.wp24AttachSignupAttributionForTest(who, { source: 'signup' },
      attr.COOKIE_NAME + '=' + attr.encodeCookie({ first: { utm_campaign: 'uk_test', utm_medium: 'paid', landing_page: '/start' } }));
    expect(again.result.attached).toBe(false);
    expect(again.stored.first.utm_campaign).toBe('au_test');

    // The owner can read it back.
    const read = await rig.req('GET', '/api/ceo/ads/account-attribution?email=au.signup.test%40gplink-test.local', rig.ceo());
    expect(read.status).toBe(200);
    expect(read.json.attribution.campaign).toBe('au_gp');
  });

  it('no cookie: nothing is stored, and the flag says overseas (the default for a doctor with nothing recorded)', async () => {
    const got = await rig.testUtils.wp24AttachSignupAttributionForTest({ email: 'plain.signup.test@gplink-test.local' }, { source: 'signup' }, '');
    expect(got.result).toEqual({ attached: false, segment: 'overseas' });
    expect(got.stored).toBeNull();
    expect(got.cookies[0]).toContain('gp_signup_evt=overseas');
  });

  it('switch off: nothing is read, stored or set, and the staff read is a 404', async () => {
    rig.setSwitch(false);
    try {
      const cookie = attr.COOKIE_NAME + '=' + attr.encodeCookie({ first: { utm_campaign: 'au_test', utm_medium: 'paid', landing_page: '/australian-gps' } });
      const got = await rig.testUtils.wp24AttachSignupAttributionForTest({ email: 'off.signup.test@gplink-test.local' }, { source: 'signup' }, cookie);
      expect(got.result).toEqual({ attached: false, segment: 'overseas' });
      expect(got.cookies).toEqual([]);
      expect(got.stored).toBeNull();
      const read = await rig.req('GET', '/api/ceo/ads/account-attribution?email=off.signup.test%40gplink-test.local', rig.ceo());
      expect(read.status).toBe(404);
      // A lead stored with the switch off carries no attribution even when the cookie is sent.
      const res = await rig.req('POST', '/api/public/consult-lead', {
        host: 'localhost', cookie, headers: { 'x-forwarded-for': '10.24.9.9', 'x-real-ip': '10.24.9.9' },
        body: { name: 'Dr Test Offlead', email: 'off.lead.test@gplink-test.local', phone: '+447700900999', country: 'uk', question: '', website: '', utm: { utm_campaign: 'uk_test' } }
      });
      expect(res.status).toBe(200);
      const row = (rig.readDb().siteEnquiries || []).find((r) => r.email === 'off.lead.test@gplink-test.local');
      expect(row.metadata.attribution).toBeUndefined();
      expect(row.metadata.utm).toEqual({ utm_campaign: 'uk_test' });
    } finally { rig.setSwitch(true); }
  });
});
