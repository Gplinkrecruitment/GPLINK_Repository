import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

// 2026-11-10: the morning review told the owner that Hazel had rung 6 of the
// week's 12 leads (it was 11) and that 5 of 10 booked calls had no outcome
// (they were no-shows, tests and one call still to come). The causes were in
// how the server READ the rows, so these pin the reads themselves.
const require = createRequire(import.meta.url);
const ctx = require('../lib/ads-context.js');
const metaAds = require('../lib/meta-ads.js');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const reviewSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ads-review.js'), 'utf8');

function fnBody(name) {
  const start = server.indexOf('async function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  const next = server.indexOf('\nasync function ', start + 10);
  return server.slice(start, next === -1 ? start + 6000 : next);
}

describe('the ads review reads every row', () => {
  const gather = fnBody('adsGatherContext');
  const readAll = fnBody('adsReadAllRows');

  it('pages through PostgREST instead of trusting a large limit', () => {
    expect(readAll).toContain('adsContext.readAllPages');
    expect(readAll).toContain("query + '&limit=' + limit + '&offset=' + offset");
  });
  it('reads leads, Hazel\'s calls and the consultations through the pager, each in a stable order', () => {
    ['site_enquiries', 'lead_calls', 'scheduled_calls'].forEach((table) => {
      const m = new RegExp("all\\('" + table + "', ([^\\n]*)\\),?\\n").exec(gather);
      expect(m, table + ' is not read through the pager').toBeTruthy();
      expect(m[1]).toMatch(/&order=created_at\.(asc|desc),id\.asc'$/);
      expect(m[1]).not.toMatch(/limit=|offset=/);
    });
    // No unpaged read of the tables that grow without bound is left behind.
    expect(gather).not.toMatch(/\bq\('(site_enquiries|lead_calls|scheduled_calls)'/);
  });
  it('asks for what the outcome needs: the sweep\'s mark and the Zoom notes', () => {
    const consults = /all\('scheduled_calls', ([^\n]*)\n/.exec(gather)[1];
    ['failed_attempt_count', 'meeting_summary', 'no_show_at', 'scheduled_at', 'status', 'invitee_email'].forEach((col) => expect(consults).toContain(col));
    // The lead's email is how a test fill is recognised and a booking matched.
    expect(/all\('site_enquiries', ([^\n]*)\n/.exec(gather)[1]).toContain('select=id,email,');
    expect(fnBody('adsLeadRows')).toContain("'select=id,email,created_at,status,metadata");
  });
});

describe('the same leads are counted everywhere', () => {
  const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
  const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
  const row = (id, email, consult) => ({ id, email, created_at: iso(2), status: 'new', metadata: { source: 'meta_lead_ad', fb_ad_id: '555', consult: Object.assign({ qualified: true }, consult || {}) } });
  const rows = [
    row('real', 'dr.a@example.test', { call_booked: true, call_booked_at: iso(2) }),
    row('test', 'hello+form@mygplink.com.au', { call_booked: true, call_booked_at: iso(2) }),
    row('ours', 'dr.b@example.test', { call_booked: true, excluded_at: iso(1) })
  ];
  it('the deep funnel (ads-context) leaves our own rows out', () => {
    const facts = ctx.enrichLeads({ leads: rows, calls: [], consults: [], now: NOW });
    expect(facts.map((f) => f.id)).toEqual(['real']);
  });
  it('the card funnel (meta-ads) leaves the same rows out', () => {
    const f = metaAds.funnelByAd(rows, { now: NOW });
    expect(f.totals.d30).toMatchObject({ leads: 1, booked: 1 });
    expect(f.by_ad['555'].d7.leads).toBe(1);
  });
  it('the model is told what upcoming and unverified mean', () => {
    expect(reviewSrc).toContain('HOW TO READ THE BOOKED NUMBERS');
    expect(reviewSrc).toMatch(/upcoming \(the call is booked for a time still ahead/);
    expect(reviewSrc).toMatch(/Never describe upcoming or unverified calls as missing outcomes/);
    expect(reviewSrc).toMatch(/attend_rate_pct is attended out of attended plus no_show only/);
  });
});

describe('check-availability hands Hazel the slots doctors turn up to', () => {
  const tool = fnBody('leadCallToolCheckAvailability');
  it('applies the owner-switchable weekday-afternoon rule from the lead-call config', () => {
    expect(tool).toContain('(await leadCallsConfig()).avoidWeekdayAfternoons');
    expect(tool).toContain('avoidWeekdayAfternoons: avoidAfternoons })');
  });
  it('tells her, as a fact, that afternoons exist when some were held back', () => {
    expect(tool).toContain('picked.heldBack > 0');
    expect(tool).toContain('check again with that time_of_day');
  });
});
