// WP-15 (Australian GP build), end to end over HTTP against the real server
// (local-JSON mode): the /start form's first question, screening, the stored
// row, the owner's alert, the Leads tab and the Meta lead webhook.
//
// Acceptance (docs/au-gp/review-report.md, WP-15): an Ahpra-registered doctor
// trained anywhere qualifies and is tagged; the turndown is never shown to
// them. And the decline rule for everyone else is exactly what it was.
//
// Request bodies are what pages/site-start.html + js/site-au-lead.js post.
// Meta payloads use the live form's real field keys (tests/live-form-journey
// .test.js) and, for the Australian form, the proposed wording in
// docs/au-gp/meta-au-lead-form.md slugged the way Meta slugs (no Australian
// form exists in Meta yet, so there is no stored row to copy).
// Nothing real is sent; every identity is fake.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const auLead = require('../lib/au-lead.js');
const leadCalls = require('../lib/lead-calls.js');
const auTimezone = require('../lib/au-timezone.js');

let h;
let seq = 0;
const sent = [];
let harnessFetch;

const AU_YES = { ahpraRegistered: true, state: 'WA', vrStatus: 'yes', restriction19ab: 'no', rightToWork: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' };
const NO = { ahpraRegistered: false, consentVersion: 'overseas_v0' };

function form(over) {
  seq += 1;
  return Object.assign({
    name: 'Dr Test Lead' + seq,
    email: 'lead' + seq + '.wp15@gplink-test.local',
    phone: '+61400' + String(200000 + seq),
    country: 'uk',
    question: '',
    website: '',
    utm: {},
    tz: 'Australia/Perth'
  }, over || {});
}
function ipHeaders() {
  seq += 1;
  const ip = '10.31.' + Math.floor(seq / 250) + '.' + (seq % 250 + 1);
  return { 'x-forwarded-for': ip, 'x-real-ip': ip };
}
async function submit(body, cookie) {
  const headers = ipHeaders();
  return h.post('/api/public/consult-lead', body, cookie ? { headers, cookie } : { headers });
}
const leads = () => (h.readLocalDb().siteEnquiries || []);
const leadByEmail = (email) => leads().find((r) => r.email === email) || null;
const consultOf = (email) => { const r = leadByEmail(email); return r && r.metadata && r.metadata.consult; };
function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map((c) => String(c).split(';')[0]).join('; ');
}
const alertsFor = (email) => sent.filter((m) => m && String(m.html || '').indexOf(email) !== -1);
async function leadsTab(query) {
  const admin = h.superAdmin();
  return h.get('/api/ceo/leads?limit=200' + (query || ''), { cookie: admin.cookie, host: admin.host });
}

beforeAll(async () => {
  h = await bootAuTestServer({
    name: 'wp15-leads', mode: 'local', localDb: {},
    env: {
      RESEND_API_KEY: 're_test_wp15', SITE_ENQUIRY_NOTIFY_EMAIL: 'owner@gplink-test.local',
      FB_LEAD_WEBHOOK_SECRET: 'wp15-secret',
      FB_GP_LEAD_FORM_IDS: 'FORM-OS,FORM-BOTH', FB_AU_GP_LEAD_FORM_IDS: 'FORM-AU,FORM-BOTH'
    }
  });
  harnessFetch = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('api.resend.com') !== -1) {
      let body = null;
      try { body = JSON.parse(String(init && init.body)); } catch (e) { body = null; }
      sent.push(body);
      return Promise.resolve(new Response(JSON.stringify({ id: 'stub' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return harnessFetch(url, init);
  };
}, 60000);
afterAll(async () => {
  if (harnessFetch) globalThis.fetch = harnessFetch;
  if (h) await h.close();
  ['FB_LEAD_WEBHOOK_SECRET', 'FB_GP_LEAD_FORM_IDS', 'FB_AU_GP_LEAD_FORM_IDS', 'SITE_ENQUIRY_NOTIFY_EMAIL', 'RESEND_API_KEY'].forEach((k) => { delete process.env[k]; });
});
beforeEach(() => { h.setSwitch(true); sent.length = 0; });

describe('WEB-08: "Yes, I am registered with Ahpra" qualifies, wherever they trained', () => {
  it.each([
    ['the UK', 'uk', '+447700900301'],
    ['India ("Somewhere else")', 'other', '+919800000301'],
    ['South Africa ("Somewhere else")', 'other', '+27820000301'],
    ['Australia', 'au', '+61400000301'],
    ['Ireland', 'ie', '+353870000301'],
    ['New Zealand', 'nz', '+64210000301'],
    ['nowhere stated (left blank)', '', '+61400000302']
  ])('trained in %s: qualified, tagged Australian-segment, never turned down', async (_label, country, phone) => {
    const body = form(Object.assign({ country, phone }, AU_YES));
    const res = await submit(body);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.qualified).toBe(true);
    expect(typeof res.json.token).toBe('string');

    const row = leadByEmail(body.email);
    const c = row.metadata.consult;
    expect(c.qualified).toBe(true);
    expect(c.screened_out).toBeUndefined();
    expect(c.country_unknown).toBeUndefined();
    expect(c.country_inferred_from_phone).toBeUndefined();
    expect(c).toMatchObject({
      segment: 'au_vr', ahpra_registered: true, location_country: 'au', state: 'WA',
      vr_status: 'yes', restriction_19ab: 'no', visa_status: 'citizen_pr'
    });
    expect(c.consent).toMatchObject({ wording_version: 'au_a1_draft_2026_11', ai_call: 'not_asked' });
    expect(Number.isFinite(Date.parse(c.consent.shown_at))).toBe(true);
    // training is stored as the separate fact it is
    expect(c.country).toBe(country || 'other');
    expect(row.state).toBe(country || null);
    if (!country) expect(c.country_source).toBe('none');
    expect(auLead.isAuSegmentLead(row)).toBe(true);

    // What the page is told on a return visit: qualified (so the calendar),
    // never the state that shows "We're sorry, we can't take this one on".
    const me = await h.get('/api/public/consult-lead/me', { cookie: cookieFrom(res) });
    expect(me.json).toMatchObject({ found: true, qualified: true, undecided: false, auSegment: true });
    expect(me.json.token).toBe(res.json.token);
    const byToken = await h.get('/api/public/consult-lead?token=' + encodeURIComponent(res.json.token));
    expect(byToken.json).toMatchObject({ ok: true, qualified: true, auSegment: true });
  });

  it('the report case: already in Australia, UK-trained, on a +44 number. Australian handling and their own state clock', async () => {
    const body = form(Object.assign({ country: 'uk', phone: '+447700900310', tz: '' }, AU_YES, { state: 'QLD' }));
    await submit(body);
    const row = leadByEmail(body.email);
    expect(row.metadata.consult).toMatchObject({ segment: 'au_vr', country: 'uk', state: 'QLD', location_country: 'au' });
    expect(auTimezone.auLeadZone(row)).toMatchObject({ zone: 'Australia/Brisbane', source: 'state' });
    expect(leadCalls.leadCallDecision({ row, nowMs: Date.now(), cfg: leadCalls.parseLeadCallConfig({ LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'k', RETELL_AGENT_ID: 'a', RETELL_FROM_NUMBER_UK: '+442030000000', RETELL_FROM_NUMBER_AU: '+61280000000' }) }))
      .toEqual({ action: 'skip', reason: 'au_segment' });
  });

  it('every "not sure" is accepted, and outside Australia is a real answer', async () => {
    const body = form({ country: '', ahpraRegistered: true, state: 'outside', vrStatus: 'unsure', restriction19ab: 'unsure', rightToWork: 'unsure', consentVersion: 'au_a1_draft_2026_11', tz: 'Europe/London' });
    const res = await submit(body);
    expect(res.json.qualified).toBe(true);
    const c = consultOf(body.email);
    expect(c).toMatchObject({ segment: 'au_unknown', ahpra_registered: true, location_country: 'other', vr_status: 'unsure', restriction_19ab: 'unsure', visa_status: 'unsure', timezone: 'Europe/London' });
    expect(c.state).toBeUndefined();
  });

  it.each([
    [{ vrStatus: 'registrar' }, 'au_registrar'],
    [{ vrStatus: 'no' }, 'au_non_vr'],
    [{ restriction19ab: 'yes' }, 'au_restricted'],
    [{ rightToWork: 'temporary' }, 'au_restricted']
  ])('%j → %s (still qualified: nothing on this branch declines anyone)', async (over, segment) => {
    const body = form(Object.assign({}, AU_YES, over));
    const res = await submit(body);
    expect(res.json.qualified).toBe(true);
    expect(consultOf(body.email).segment).toBe(segment);
  });

  it('a value the form never offered is refused and nothing is stored', async () => {
    for (const bad of [{ state: 'Texas' }, { vrStatus: 'probably' }, { restriction19ab: '<b>' }, { rightToWork: 'tourist' }, { ahpraRegistered: 'yes' }, { consentVersion: 'invented' }]) {
      const body = form(Object.assign({}, AU_YES, bad));
      const res = await submit(body);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(leadByEmail(body.email)).toBeNull();
    }
  });
});

describe('"No" is today\'s flow, and the decline rule is intact', () => {
  it('COM-15: a +61 number with "No" stays overseas; a +44 number with "Yes" is Australian-segment', async () => {
    const no = form(Object.assign({ country: 'uk', phone: '+61400000320' }, NO));
    const resNo = await submit(no);
    expect(resNo.json.qualified).toBe(true);
    const cNo = consultOf(no.email);
    expect(cNo).toMatchObject({ segment: 'overseas', ahpra_registered: false, country: 'uk' });
    expect(cNo.location_country).toBeUndefined();
    expect(cNo.vr_status).toBeUndefined();
    expect(auLead.isAuSegmentLead(leadByEmail(no.email))).toBe(false);
    const me = await h.get('/api/public/consult-lead/me', { cookie: cookieFrom(resNo) });
    expect(me.json.auSegment).toBeUndefined();

    const yes = form(Object.assign({ country: 'uk', phone: '+447700900320' }, AU_YES));
    await submit(yes);
    expect(consultOf(yes.email)).toMatchObject({ segment: 'au_vr', ahpra_registered: true });
    expect(auLead.isAuSegmentLead(leadByEmail(yes.email))).toBe(true);
  });

  it('"No" and an unserved training country is declined exactly as today, whatever the phone', async () => {
    for (const phone of ['+919800000321', '+61400000321', '+447700900321']) {
      const body = form(Object.assign({ country: 'other', phone }, NO));
      const res = await submit(body);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, qualified: false });
      const c = consultOf(body.email);
      expect(c.qualified).toBe(false);
      expect(c.screened_out).toBe(true);
      expect(c.token).toBeUndefined();
      expect(c.country_inferred_from_phone).toBeUndefined();
      expect(c.segment).toBe('overseas');
      const me = await h.get('/api/public/consult-lead/me', { cookie: cookieFrom(res) });
      // qualified false and not undecided: this is the state the page turns down
      expect(me.json).toMatchObject({ found: true, qualified: false, undecided: false, token: null });
    }
  });

  it('"No" from a UK, Irish or New Zealand doctor qualifies as today; "No" from an Australian-trained doctor is still Australian-segment', async () => {
    for (const country of ['uk', 'ie', 'nz']) {
      const body = form(Object.assign({ country }, NO));
      expect((await submit(body)).json.qualified).toBe(true);
      expect(consultOf(body.email)).toMatchObject({ segment: 'overseas', country });
    }
    const au = form(Object.assign({ country: 'au' }, NO));
    expect((await submit(au)).json.qualified).toBe(true);
    expect(consultOf(au.email)).toMatchObject({ segment: 'au_unknown', ahpra_registered: false, country: 'au' });
    expect(auLead.isAuSegmentLead(leadByEmail(au.email))).toBe(true);
  });

  it('a page that does not ask (an old cached copy): nothing new is recorded, and an old-style Australian lead is still Australian-segment', async () => {
    const uk = form({ country: 'uk' });
    await submit(uk);
    expect(Object.keys(consultOf(uk.email)).sort()).toEqual(['call_booked', 'country', 'is_gp', 'nudges', 'qualified', 'timezone', 'timezone_source', 'token']);
    const au = form({ country: 'au' });
    await submit(au);
    expect(consultOf(au.email).segment).toBeUndefined();
    expect(auLead.isAuSegmentLead(leadByEmail(au.email))).toBe(true);
    expect(auLead.leadSegmentFor(leadByEmail(au.email))).toBe('au_unknown');
    const other = form({ country: 'other' });
    expect((await submit(other)).json).toEqual({ ok: true, qualified: false });
    expect(consultOf(other.email).screened_out).toBe(true);
  });

  it('the same browser re-submitting: "No, somewhere else" (declined) → "Yes" (qualified) → "No, UK" (overseas, Australian answers gone)', async () => {
    const first = form(Object.assign({ country: 'other' }, NO));
    const r1 = await submit(first);
    expect(r1.json.qualified).toBe(false);
    const cookie = cookieFrom(r1);
    const id = leadByEmail(first.email).id;

    const r2 = await submit(Object.assign({}, first, AU_YES, { country: '' }), cookie);
    expect(r2.json).toMatchObject({ ok: true, qualified: true, recognised: true });
    expect(typeof r2.json.token).toBe('string');
    let row = leads().find((r) => r.id === id);
    expect(leads().filter((r) => r.email === first.email)).toHaveLength(1);
    expect(row.metadata.consult.screened_out).toBeUndefined();
    expect(row.metadata.consult).toMatchObject({ qualified: true, segment: 'au_vr', ahpra_registered: true, state: 'WA', country: 'other', country_source: 'none' });
    expect(row.state).toBeNull();

    const r3 = await submit(Object.assign({}, first, NO, { country: 'uk' }), cookie);
    expect(r3.json.qualified).toBe(true);
    row = leads().find((r) => r.id === id);
    expect(row.metadata.consult).toMatchObject({ qualified: true, segment: 'overseas', ahpra_registered: false, country: 'uk' });
    expect(row.metadata.consult.vr_status).toBeUndefined();
    expect(row.metadata.consult.restriction_19ab).toBeUndefined();
    expect(row.metadata.consult.visa_status).toBeUndefined();
    expect(row.metadata.consult.location_country).toBeUndefined();
    expect(row.metadata.consult.country_source).toBeUndefined();
    expect(row.state).toBe('uk');
    expect(auLead.isAuSegmentLead(row)).toBe(false);
  });
});

describe('switch OFF: the new answers do nothing', () => {
  it('a "Yes" body is handled as the old form would: the training country decides, nothing new is stored', async () => {
    h.setSwitch(false);
    const blank = form(Object.assign({ country: '' }, AU_YES));
    const r0 = await submit(blank);
    expect(r0.status).toBe(400);
    expect(r0.json.error).toBe('country must be one of: uk, ie, nz, au, other.');

    const other = form(Object.assign({ country: 'other' }, AU_YES));
    const r1 = await submit(other);
    expect(r1.json).toEqual({ ok: true, qualified: false });
    expect(Object.keys(consultOf(other.email)).sort()).toEqual(['call_booked', 'country', 'is_gp', 'nudges', 'qualified', 'screened_out']);

    const junk = form({ country: 'uk', ahpraRegistered: 'banana', state: 'Texas', vrStatus: 'x', consentVersion: 'y' });
    const r2 = await submit(junk);
    expect(r2.json.qualified).toBe(true);
    expect(Object.keys(consultOf(junk.email)).sort()).toEqual(['call_booked', 'country', 'is_gp', 'nudges', 'qualified', 'token']);
    const me = await h.get('/api/public/consult-lead/me', { cookie: cookieFrom(r2) });
    expect(Object.keys(me.json).sort()).toEqual(['booked', 'displayName', 'email', 'found', 'fullName', 'ok', 'phone', 'qualified', 'token', 'undecided']);
  });

  it('a stored new-style Australian lead: no auSegment flag is sent, and Hazel is still refused', async () => {
    const body = form(Object.assign({ country: 'uk', phone: '+447700900330' }, AU_YES));
    const res = await submit(body);
    h.setSwitch(false);
    const me = await h.get('/api/public/consult-lead/me', { cookie: cookieFrom(res) });
    expect(me.json.auSegment).toBeUndefined();
    expect(me.json.qualified).toBe(true);
    const out = await h.testUtils.placeLeadCall(leadByEmail(body.email), {});
    expect(JSON.stringify(out)).toContain('au_segment');
  });
});

describe('WEB-17: the owner\'s "New gp enquiry" alert', () => {
  it('switch on, Australian-segment: segment, state and VR status are in the email', async () => {
    const body = form(Object.assign({ country: 'other', phone: '+447700900340', question: 'Mixed billing in Perth?' }, AU_YES, { vrStatus: 'registrar', restriction19ab: 'unsure' }));
    await submit(body);
    const mail = alertsFor(body.email);
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toEqual(['owner@gplink-test.local']);
    expect(mail[0].subject).toBe('New gp enquiry, ' + body.name);
    for (const line of [
      'Segment: Australian GP: registrar',
      'Ahpra registered: yes (their answer)',
      'Australian state: WA',
      'VR status: GP registrar',
      '19AB moratorium: Not sure',
      'Right to work: Citizen or permanent resident',
      'Trained in: Somewhere else'
    ]) {
      expect(mail[0].html, line).toContain('<p>' + line + '</p>');
      expect(mail[0].text, line).toContain(line + '\n');
    }
    expect(mail[0].html).toContain('Mixed billing in Perth?');
    // an Australian-segment lead is never described as one we do not place
    expect(mail[0].html).not.toContain('not a country we place');
    expect(mail[0].text).not.toContain('NEEDS A LOOK');
  });

  it('training left blank reads "not asked", and an old-style Australian lead says what is not known', async () => {
    const blank = form(Object.assign({ country: '' }, AU_YES));
    await submit(blank);
    expect(alertsFor(blank.email)[0].text).toContain('Trained in: not asked\n');
    const old = form({ country: 'au' });
    await submit(old);
    const text = alertsFor(old.email)[0].text;
    expect(text).toContain('Segment: Australian GP: details to confirm\n');
    expect(text).toContain('Ahpra registered: not asked\n');
    expect(text).toContain('Australian state: not given\n');
    expect(text).toContain('VR status: not given\n');
  });

  it('an overseas lead\'s alert, and every alert with the switch off, has none of it', async () => {
    const uk = form(Object.assign({ country: 'uk', phone: '+447700900341', question: 'How long?' }, NO));
    await submit(uk);
    const m = alertsFor(uk.email)[0];
    expect(m.html).toBe('<p>New website enquiry (<strong>gp</strong>) from ' + uk.name + ' &lt;' + uk.email + '&gt;.</p><p>Phone: +447700900341</p><p>State: uk</p><p>How long?</p>');
    expect(m.text).toBe('New gp enquiry from ' + uk.name + ' (' + uk.email + ') via website enquiry.\nPhone: +447700900341\nState: uk\n\nHow long?');

    h.setSwitch(false);
    const au = form({ country: 'au', phone: '+61400000342' });
    await submit(au);
    const off = alertsFor(au.email)[0];
    expect(off.html).toBe('<p>New website enquiry (<strong>gp</strong>) from ' + au.name + ' &lt;' + au.email + '&gt;.</p><p>Phone: +61400000342</p><p>State: au</p>');
    expect(off.text).toBe('New gp enquiry from ' + au.name + ' (' + au.email + ') via website enquiry.\nPhone: +61400000342\nState: au\n');
  });
});

describe('ADM-29: the Leads tab payload and the segment filter', () => {
  let wa, ukNo, nzNo, declined, oldAu;
  beforeAll(async () => {
    h.setSwitch(true);
    wa = form(Object.assign({ country: 'uk', phone: '+447700900350', tz: '' }, AU_YES));
    ukNo = form(Object.assign({ country: 'uk', phone: '+447700900351', tz: 'Europe/London' }, NO));
    nzNo = form(Object.assign({ country: 'nz', phone: '+64210000351', tz: 'Pacific/Auckland' }, NO));
    declined = form(Object.assign({ country: 'other', phone: '+919800000351' }, NO));
    oldAu = form({ country: 'au', phone: '+61400000351', tz: '' });
    for (const b of [wa, ukNo, nzNo, declined, oldAu]) await submit(b);
  });

  it('switch on: every row names its segment; an Australian-segment lead shows their own state and clock', async () => {
    const res = await leadsTab();
    expect(res.status).toBe(200);
    const byEmail = (e) => res.json.leads.find((l) => l.email === e);
    expect(byEmail(wa.email)).toMatchObject({ segment: 'au_vr', segment_label: 'AU · VR', au_state: 'WA', vr_status: 'yes', tz: 'Australia/Perth', tz_label: 'Perth', country: 'uk' });
    expect(byEmail(oldAu.email)).toMatchObject({ segment: 'au_unknown', segment_label: 'AU · to confirm', au_state: '', vr_status: '', tz: 'Australia/Sydney', tz_label: 'Sydney' });
    const uk = byEmail(ukNo.email);
    expect(uk).toMatchObject({ segment: 'overseas', segment_label: 'Overseas', tz: 'Europe/London', country: 'uk' });
    expect(uk.au_state).toBeUndefined();
    expect(uk.tz_label).toBeUndefined();
    expect(byEmail(nzNo.email)).toMatchObject({ segment: 'overseas', tz: 'Pacific/Auckland' });
    expect(byEmail(wa.email).hazel.reason).toBe('au_segment');
    expect(byEmail(nzNo.email).hazel.reason).not.toBe('au_segment');
    // counts cover the whole list, whichever chip is on
    const c = res.json.segment_counts;
    expect(Object.keys(c)).toEqual(['all', 'au', 'overseas', 'uk', 'ie', 'nz', 'other']);
    expect(c.all).toBe(res.json.leads.length);
    expect(c.au + c.overseas).toBe(c.all);
    expect(c.uk + c.ie + c.nz + c.other).toBe(c.overseas);
    expect(res.json.seg).toBe('all');
    // nothing private leaves the server
    expect(JSON.stringify(res.json)).not.toContain('user_agent');
    expect(JSON.stringify(res.json)).not.toContain('10.31.');
  });

  it('the filter: Australian GPs, overseas, and overseas by training country', async () => {
    const all = (await leadsTab()).json;
    const au = (await leadsTab('&seg=au')).json;
    expect(au.seg).toBe('au');
    expect(au.leads.length).toBe(all.segment_counts.au);
    expect(au.leads.every((l) => l.segment !== 'overseas')).toBe(true);
    expect(au.leads.map((l) => l.email)).toContain(wa.email);
    expect(au.leads.map((l) => l.email)).toContain(oldAu.email);
    expect(au.leads.map((l) => l.email)).not.toContain(ukNo.email);
    // the stage chips count inside the chosen segment; the segment counts do not move
    expect(au.counts.all).toBe(au.leads.length);
    expect(au.segment_counts).toEqual(all.segment_counts);

    const os = (await leadsTab('&seg=overseas')).json;
    expect(os.leads.every((l) => l.segment === 'overseas')).toBe(true);
    expect(os.leads.map((l) => l.email)).toEqual(expect.arrayContaining([ukNo.email, nzNo.email, declined.email]));
    const nz = (await leadsTab('&seg=nz')).json;
    expect(nz.leads.every((l) => l.country === 'nz' && l.segment === 'overseas')).toBe(true);
    expect(nz.leads.map((l) => l.email)).toContain(nzNo.email);
    const other = (await leadsTab('&seg=other')).json;
    expect(other.leads.map((l) => l.email)).toContain(declined.email);
    // a UK-trained, Ahpra-registered doctor is under Australian GPs, not UK
    expect((await leadsTab('&seg=uk')).json.leads.map((l) => l.email)).not.toContain(wa.email);
    // the segment filter combines with the stage chips
    const auOpen = (await leadsTab('&seg=au&filter=open')).json;
    expect(auOpen.leads.every((l) => l.segment !== 'overseas' && l.stage.key === 'open')).toBe(true);
    // an unknown value is "all"
    expect((await leadsTab('&seg=banana')).json.seg).toBe('all');
  });

  it('one lead in full (the drawer) carries the same fields', async () => {
    const admin = h.superAdmin();
    const id = leadByEmail(wa.email).id;
    const res = await h.get('/api/ceo/leads/' + id, { cookie: admin.cookie, host: admin.host });
    expect(res.status).toBe(200);
    expect(res.json.lead).toMatchObject({ segment: 'au_vr', au_state: 'WA', tz_label: 'Perth' });
  });

  it('switch OFF: no segment key on any row, no counts, and the parameter is ignored', async () => {
    h.setSwitch(false);
    const res = await leadsTab('&seg=au');
    expect(res.json.segment_counts).toBeUndefined();
    expect(res.json.seg).toBeUndefined();
    expect(res.json.leads.map((l) => l.email)).toContain(ukNo.email);
    for (const l of res.json.leads) {
      expect(l.segment).toBeUndefined();
      expect(l.segment_label).toBeUndefined();
      expect(l.au_state).toBeUndefined();
      expect(l.tz_label).toBeUndefined();
    }
    expect(res.json.leads.find((l) => l.email === wa.email).hazel.reason).toBe('au_segment');
  });
});

describe('Meta lead forms: form id → segment, answers read as slugs', () => {
  let metaSeq = 0;
  function metaLead(formId, email, fields) {
    metaSeq += 1;
    const base = { full_name: 'Test Doctor' + metaSeq, email, phone_number: '+61400000' + (400 + metaSeq) };
    const all = Object.assign(base, fields);
    return { entry: [{ changes: [{ value: {
      leadgen_id: 'L-wp15-' + metaSeq + '-' + Math.random().toString(36).slice(2),
      form_id: formId,
      field_data: Object.keys(all).map((name) => ({ name, values: [all[name]] }))
    } }] }] };
  }
  async function postMeta(payload) {
    return h.post('/api/webhooks/facebook-lead?secret=wp15-secret', payload, { headers: ipHeaders() });
  }
  const AU_Q = {
    ahpra: 'are_you_currently_registered_with_ahpra?',
    state: 'which_state_or_territory_are_you_in?',
    vr: 'are_you_a_vocationally_registered_gp_(fracgp_or_facrrm)?',
    ab: 'does_the_19ab_moratorium_apply_to_you?',
    rtw: 'what_is_your_right_to_work_in_australia?'
  };
  const LIVE_TRAINING = '_where_did_you_complete_your_gp_training?';

  it('an Australian form with the proposed questions: qualified on the Ahpra answer, tagged from the answers', async () => {
    const email = 'meta.au1.wp15@gplink-test.local';
    const res = await postMeta(metaLead('FORM-AU', email, {
      [AU_Q.ahpra]: 'yes', [AU_Q.state]: 'western_australia', [AU_Q.vr]: 'yes', [AU_Q.ab]: 'no',
      [AU_Q.rtw]: 'australian_citizen_or_permanent_resident'
    }));
    expect(res.status).toBe(200);
    expect(res.json.kind).toBe('gp_lead');
    const row = leadByEmail(email);
    expect(row.kind).toBe('gp');
    expect(row.metadata.source).toBe('meta_lead_ad');
    expect(row.metadata.fb_form_id).toBe('FORM-AU');
    expect(row.metadata.consult).toMatchObject({
      qualified: true, segment: 'au_vr', ahpra_registered: true, state: 'WA', location_country: 'au',
      vr_status: 'yes', restriction_19ab: 'no', visa_status: 'citizen_pr'
    });
    expect(row.metadata.consult.screened_out).toBeUndefined();
    expect(row.metadata.consult.consent).toBeUndefined();
    // the owner is told; the lead is not sent the magic link written for a doctor moving country
    expect(alertsFor(email)).toHaveLength(1);
    expect(sent.filter((m) => m && [].concat(m.to || []).indexOf(email) !== -1)).toHaveLength(0);
  });

  it('an Australian form, Ahpra "yes", trained in India: qualified, not turned down', async () => {
    const email = 'meta.au2.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-AU', email, { [AU_Q.ahpra]: 'yes', [AU_Q.state]: 'victoria', [AU_Q.vr]: 'not_sure', [LIVE_TRAINING]: 'india' }));
    const c = consultOf(email);
    expect(c).toMatchObject({ qualified: true, segment: 'au_unknown', ahpra_registered: true, state: 'VIC', vr_status: 'unsure', country: 'other', country_raw: 'india' });
    expect(c.screened_out).toBeUndefined();
    expect(typeof c.token).toBe('string');
  });

  it('an Australian form that asks nothing more: au_unknown, and a person looks (never declined on training)', async () => {
    const bare = 'meta.au3.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-AU', bare, { phone_number: '+919800000403' }));
    expect(consultOf(bare)).toMatchObject({ qualified: false, country_unknown: true, segment: 'au_unknown' });
    expect(consultOf(bare).screened_out).toBeUndefined();
    expect(consultOf(bare).ahpra_registered).toBeUndefined();
    expect(alertsFor(bare)[0].subject).toContain('Check this lead: ');

    // The phone may still corroborate the COUNTRY of an answer we could not
    // read, exactly as it always has. It sets neither the segment (that came
    // from the form id) nor ahpra_registered.
    const barePhone = 'meta.au3b.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-AU', barePhone, { phone_number: '+61400000403' }));
    expect(consultOf(barePhone)).toMatchObject({ qualified: true, country: 'au', country_inferred_from_phone: true, segment: 'au_unknown' });
    expect(consultOf(barePhone).ahpra_registered).toBeUndefined();

    // An answer we DID read is never overridden by the phone.
    const elsewhere = 'meta.au4.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-AU', elsewhere, { phone_number: '+61400000404', [LIVE_TRAINING]: 'somewhere_else' }));
    expect(consultOf(elsewhere)).toMatchObject({ qualified: false, country_unknown: true, segment: 'au_unknown', country: 'other' });
    expect(consultOf(elsewhere).country_inferred_from_phone).toBeUndefined();
    expect(consultOf(elsewhere).screened_out).toBeUndefined();
    const me = await h.post('/api/public/consult-lead/match', { email: elsewhere }, { headers: ipHeaders() });
    // undecided: the page shows the ordinary form (which asks), not the turndown
    expect(me.json).toMatchObject({ found: true, qualified: false, undecided: true, auSegment: true });

    const uk = 'meta.au5.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-AU', uk, { [LIVE_TRAINING]: 'united_kingdom' }));
    expect(consultOf(uk)).toMatchObject({ qualified: true, country: 'uk', segment: 'au_unknown' });
  });

  it('an Australian form, Ahpra "no": today\'s screening decides, and an unserved country still declines', async () => {
    const uk = 'meta.au6.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-AU', uk, { [AU_Q.ahpra]: 'no', [LIVE_TRAINING]: 'united_kingdom' }));
    expect(consultOf(uk)).toMatchObject({ qualified: true, country: 'uk', segment: 'overseas', ahpra_registered: false });
    const out = 'meta.au7.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-AU', out, { [AU_Q.ahpra]: 'no', [LIVE_TRAINING]: 'somewhere_else' }));
    expect(consultOf(out)).toMatchObject({ qualified: false, screened_out: true, segment: 'overseas', ahpra_registered: false });
  });

  it('today\'s overseas form (the live form\'s real keys): the stored row is the row it always was', async () => {
    const fields = { 'are_you_a_currently_registered_gp?': 'yes', [LIVE_TRAINING]: 'united_kingdom', "anything_you'd_like_us_to_cover_on_the_call?": 'pay and schools' };
    const on = 'meta.os1.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-OS', on, fields));
    h.setSwitch(false);
    const off = 'meta.os2.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-OS', off, fields));
    const a = leadByEmail(on);
    const b = leadByEmail(off);
    expect(Object.keys(a.metadata.consult).sort()).toEqual(Object.keys(b.metadata.consult).sort());
    expect(Object.keys(a.metadata.consult).sort()).toEqual(['call_booked', 'country', 'country_raw', 'country_source', 'is_gp', 'nudges', 'qualified', 'token']);
    expect(Object.keys(a.metadata).sort()).toEqual(Object.keys(b.metadata).sort());
    expect(a.metadata.consult.country).toBe('uk');
    // and a declined answer is still declined
    h.setSwitch(true);
    const out = 'meta.os3.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-OS', out, { [LIVE_TRAINING]: 'somewhere_else' }));
    expect(consultOf(out)).toMatchObject({ qualified: false, screened_out: true });
    expect(consultOf(out).segment).toBeUndefined();
  });

  it('an overseas form that carries the Ahpra question is read too', async () => {
    const email = 'meta.os4.wp15@gplink-test.local';
    await postMeta(metaLead('FORM-OS', email, { [AU_Q.ahpra]: 'yes', [AU_Q.state]: 'queensland', [LIVE_TRAINING]: 'somewhere_else' }));
    expect(consultOf(email)).toMatchObject({ qualified: true, segment: 'au_unknown', ahpra_registered: true, state: 'QLD' });
    expect(consultOf(email).screened_out).toBeUndefined();
  });

  it('a form id configured as BOTH overseas and Australian fails safe: overseas screening, and a loud log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const email = 'meta.both.wp15@gplink-test.local';
      await postMeta(metaLead('FORM-BOTH', email, { [LIVE_TRAINING]: 'somewhere_else' }));
      const c = consultOf(email);
      // not tagged Australian by the form id, and declined exactly as an overseas form would
      expect(c).toMatchObject({ qualified: false, screened_out: true });
      expect(c.segment).toBeUndefined();
      const logged = spy.mock.calls.map((a) => a.join(' ')).join('\n');
      expect(logged).toContain('CONFIGURATION ERROR');
      expect(logged).toContain('FORM-BOTH');
      expect(logged).toContain('FB_AU_GP_LEAD_FORM_IDS');
    } finally { spy.mockRestore(); }
  });

  it('switch OFF: an Australian form is still a doctor\'s form (never the practice path), with no segment', async () => {
    h.setSwitch(false);
    const email = 'meta.au8.wp15@gplink-test.local';
    const res = await postMeta(metaLead('FORM-AU', email, { [AU_Q.ahpra]: 'yes', [AU_Q.state]: 'western_australia', [LIVE_TRAINING]: 'united_kingdom' }));
    expect(res.json.kind).toBe('gp_lead');
    const row = leadByEmail(email);
    expect(row.kind).toBe('gp');
    expect(Object.keys(row.metadata.consult).sort()).toEqual(['call_booked', 'country', 'country_raw', 'country_source', 'is_gp', 'nudges', 'qualified', 'token']);
    expect((h.readLocalDb().practiceProspects || []).length || 0).toBe(0);
  });
});
