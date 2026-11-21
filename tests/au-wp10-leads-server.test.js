// WP-10 (Australian GP build), the LEAD side, against the real server in
// local-JSON mode: the /start form's browser zone is stored (validated) on
// the lead, the Calendly invitee zone is recorded when a booking arrives, and
// with the switch off neither is written. Nothing real is sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const consultReminders = require('../lib/consult-reminders.js');
const auTimezone = require('../lib/au-timezone.js');

let h, t;
let ipSeq = 0;
let personSeq = 0;

function form(over) {
  personSeq += 1;
  return Object.assign({
    name: 'Dr Test Lead' + personSeq,
    email: 'lead' + personSeq + '.wp10@gplink-test.local',
    phone: '+61400' + String(100000 + personSeq),
    country: 'au',
    question: '',
    website: ''
  }, over || {});
}
async function submit(body, cookie) {
  ipSeq += 1;
  const ip = '10.20.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1);
  const headers = { 'x-forwarded-for': ip, 'x-real-ip': ip };
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

beforeAll(async () => {
  h = await bootAuTestServer({ name: 'wp10-leads', mode: 'local', localDb: {} });
  t = h.testUtils;
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); });

describe('WEB-03: the /start form stores the browser zone on the lead', () => {
  it('pages/site-start.html has the hidden field and sends the zone on every submit', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'pages', 'site-start.html'), 'utf8');
    expect(html).toContain('<input id="cfTz" name="tz" type="hidden" value="">');
    const submit = html.slice(html.indexOf("getElementById('consultForm').addEventListener('submit'"));
    expect(submit.slice(0, 2500)).toContain("cfTzField.value = viewerTimeZone();");
    expect(submit.slice(0, 2500)).toContain('payload.tz = cfTzField.value');
    // the form still posts to the same endpoint, before the booking step
    expect(submit.slice(0, 2500)).toContain("post('/api/public/consult-lead', payload)");
  });

  it('switch on: a valid browser zone is stored with its source', async () => {
    const body = form({ tz: 'Australia/Perth' });
    const res = await submit(body);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const c = consultOf(body.email);
    expect(c).toMatchObject({ country: 'au', timezone: 'Australia/Perth', timezone_source: 'browser' });
    expect(c.state).toBeUndefined();
    // and it is what the reminders will use for this Australian lead
    expect(consultReminders.consultLeadTimeZone(c, body.phone)).toBe('Australia/Perth');
  });

  it.each([
    ['free text', 'somewhere in Perth'],
    ['UTC (a privacy browser or a script)', 'UTC'],
    ['a zone that does not exist', 'Mars/Olympus_Mons'],
    ['markup', '<script>alert(1)</script>'],
    ['a number', 8],
    ['an object', { zone: 'Australia/Perth' }],
    ['an over-long string', 'Australia/' + 'P'.repeat(200)]
  ])('switch on: %s is ignored and never stored raw', async (_label, bad) => {
    const body = form({ tz: bad });
    const res = await submit(body);
    expect(res.status).toBe(200);
    const row = leadByEmail(body.email);
    expect(row.metadata.consult.timezone).toBeUndefined();
    expect(row.metadata.consult.timezone_source).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(typeof bad === 'string' ? bad.slice(0, 12) : '"zone":"Australia/Perth"');
    // the lead still resolves: Australia, zone unknown, Sydney as a last resort
    expect(auTimezone.auLeadZone(row)).toEqual({ zone: 'Australia/Sydney', source: 'dial_code', certain: false });
  });

  it('switch on: no zone sent (an old cached page) stores nothing and the lead is saved as before', async () => {
    const body = form();
    const res = await submit(body);
    expect(res.status).toBe(200);
    const c = consultOf(body.email);
    expect(c.timezone).toBeUndefined();
    expect(c.country).toBe('au');
  });

  it('switch on: the WP-15 hook stores an Australian state sent as `state`, and refuses anything else', async () => {
    const wa = form({ tz: 'Australia/Sydney', state: 'Western Australia' });
    await submit(wa);
    expect(consultOf(wa.email)).toMatchObject({ state: 'WA', timezone: 'Australia/Sydney', timezone_source: 'browser' });
    // precedence: the browser zone still beats the state
    expect(consultReminders.consultLeadTimeZone(consultOf(wa.email), wa.phone)).toBe('Australia/Sydney');
    const junk = form({ state: 'Texas' });
    await submit(junk);
    expect(consultOf(junk.email).state).toBeUndefined();
    // the row's own `state` column still holds the COUNTRY, as it always has
    expect(leadByEmail(wa.email).state).toBe('au');
  });

  it('switch on: a UK lead has the zone stored too, and is still told UK time', async () => {
    const body = form({ country: 'uk', phone: '+447700900' + String(100 + personSeq), tz: 'Europe/London' });
    await submit(body);
    const c = consultOf(body.email);
    expect(c).toMatchObject({ country: 'uk', timezone: 'Europe/London', timezone_source: 'browser' });
    expect(consultReminders.consultLeadTimeZone(c, body.phone)).toBe('Europe/London');
    // the UK-trained GP living in Australia: stored, NOT used (known limitation until WP-15)
    const ukInAu = form({ country: 'uk', tz: 'Australia/Perth' });
    await submit(ukInAu);
    expect(consultOf(ukInAu.email)).toMatchObject({ country: 'uk', timezone: 'Australia/Perth' });
    expect(consultReminders.consultLeadTimeZone(consultOf(ukInAu.email), ukInAu.phone)).toBe('Europe/London');
  });

  it('switch on: a returning browser re-submitting updates the zone on the same row', async () => {
    const first = form({ tz: 'Australia/Perth' });
    const res1 = await submit(first);
    const cookie = cookieFrom(res1);
    expect(cookie).toBeTruthy();
    const before = leads().length;
    const res2 = await submit(Object.assign({}, first, { tz: 'Australia/Brisbane' }), cookie);
    expect(res2.status).toBe(200);
    expect(res2.json.recognised).toBe(true);
    expect(leads().length).toBe(before);
    expect(consultOf(first.email)).toMatchObject({ timezone: 'Australia/Brisbane', timezone_source: 'browser' });
  });

  it('switch OFF: nothing new is written; the stored row has exactly the keys it had before WP-10', async () => {
    h.setSwitch(false);
    const body = form({ tz: 'Australia/Perth', state: 'WA' });
    const res = await submit(body);
    expect(res.status).toBe(200);
    const c = consultOf(body.email);
    expect(c.timezone).toBeUndefined();
    expect(c.timezone_source).toBeUndefined();
    expect(c.state).toBeUndefined();
    h.setSwitch(true);
    const twin = form({ tz: 'Australia/Perth' });
    await submit(twin);
    const onKeys = Object.keys(consultOf(twin.email)).sort();
    const offKeys = Object.keys(c).sort();
    expect(onKeys.filter((k) => offKeys.indexOf(k) === -1)).toEqual(['timezone', 'timezone_source']);
    expect(offKeys.filter((k) => onKeys.indexOf(k) === -1)).toEqual([]);
  });
});

describe('WEB-03: the Calendly invitee zone is recorded when a booking arrives', () => {
  const slot = '2026-12-01T02:00:00.000Z';

  it('switch on: an existing lead gets the zone they booked in, and it outranks the browser zone', async () => {
    const body = form({ tz: 'Australia/Sydney' });
    await submit(body);
    await t.ensureLeadBookedCallAt(body.email, slot, '2026-11-21T00:00:00.000Z', '', null, 'Australia/Perth');
    const c = consultOf(body.email);
    expect(c).toMatchObject({ call_booked: true, call_at: slot, timezone: 'Australia/Perth', timezone_source: 'calendly' });
    expect(consultReminders.formatLeadCallTime(slot, consultReminders.consultLeadTimeZone(c, body.phone))).toBe('Tuesday 1 December, 10:00 am (Perth time)');
    // a later browser zone does not replace the booking zone
    expect(auTimezone.withLeadZone(c, 'Australia/Sydney', 'browser')).toBe(c);
  });

  it('switch on: a webhook replay with the same zone writes nothing new, and a reschedule in another zone updates it', async () => {
    const body = form();
    await submit(body);
    await t.ensureLeadBookedCallAt(body.email, slot, '2026-11-21T00:00:00.000Z', '', null, 'Australia/Adelaide');
    const first = JSON.stringify(leadByEmail(body.email));
    await t.ensureLeadBookedCallAt(body.email, slot, '2026-11-21T00:05:00.000Z', '', null, 'Australia/Adelaide');
    expect(JSON.stringify(leadByEmail(body.email))).toBe(first);
    await t.ensureLeadBookedCallAt(body.email, '2026-12-02T02:00:00.000Z', '2026-11-21T00:10:00.000Z', '', null, 'Australia/Darwin');
    expect(consultOf(body.email)).toMatchObject({ timezone: 'Australia/Darwin', timezone_source: 'calendly', call_at: '2026-12-02T02:00:00.000Z' });
  });

  it('switch on: a missing or unusable invitee zone changes nothing', async () => {
    const body = form({ tz: 'Australia/Hobart' });
    await submit(body);
    await t.ensureLeadBookedCallAt(body.email, slot, '2026-11-21T00:00:00.000Z', '', null, '');
    expect(consultOf(body.email)).toMatchObject({ timezone: 'Australia/Hobart', timezone_source: 'browser', call_booked: true });
    await t.ensureLeadBookedCallAt(body.email, slot, '2026-11-21T00:01:00.000Z', '', null, 'Not/AZone');
    expect(consultOf(body.email)).toMatchObject({ timezone: 'Australia/Hobart', timezone_source: 'browser' });
    // the old five-argument call still works
    await t.ensureLeadBookedCallAt(body.email, slot, '2026-11-21T00:02:00.000Z', '', null);
    expect(consultOf(body.email)).toMatchObject({ timezone: 'Australia/Hobart', timezone_source: 'browser' });
  });

  it('switch on: someone who books the public link directly is captured with their zone', async () => {
    const email = 'direct.wp10@gplink-test.local';
    await t.captureCalendlyDirectBookerLead({
      email, name: 'Dr Test Direct', nowIso: '2026-11-21T00:00:00.000Z', scheduledAt: slot, timezone: 'Australia/Brisbane', phone: '+61400999001'
    });
    const c = consultOf(email);
    expect(c).toMatchObject({ not_screened: true, call_booked: true, timezone: 'Australia/Brisbane', timezone_source: 'calendly' });
    // never screened, so not Australian-segment: the zone is stored, not used
    expect(auTimezone.auLeadZone(leadByEmail(email))).toBeNull();
  });

  it('switch OFF: the booking is stamped exactly as before and no zone is written', async () => {
    h.setSwitch(true);
    const body = form();
    await submit(body);
    h.setSwitch(false);
    await t.ensureLeadBookedCallAt(body.email, slot, '2026-11-21T00:00:00.000Z', '', null, 'Australia/Perth');
    const c = consultOf(body.email);
    expect(c).toMatchObject({ call_booked: true, call_at: slot });
    expect(c.timezone).toBeUndefined();
    expect(c.timezone_source).toBeUndefined();
    const email = 'direct.off.wp10@gplink-test.local';
    await t.captureCalendlyDirectBookerLead({ email, name: 'Dr Test Directoff', nowIso: '2026-11-21T00:00:00.000Z', scheduledAt: slot, timezone: 'Australia/Brisbane', phone: '+61400999002' });
    expect(consultOf(email).timezone).toBeUndefined();
    expect(consultOf(email).call_booked).toBe(true);
  });
});
