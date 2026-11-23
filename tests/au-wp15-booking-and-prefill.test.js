// WP-15 (Australian GP build), against the real server with the database stub:
//
//   COM-35  the lead's segment is carried onto the booking row
//           (scheduled_calls.notification_channels.lead) when a consultation
//           is booked, for both ways a booking arrives
//   WEB-02  a lead who said "Yes, registered with Ahpra" and then creates an
//           account with the same email starts onboarding in the Australian
//           branch with what they already answered; nothing sets a pathway
//
// and with the switch off neither happens. The database stub does not evaluate
// ilike filters (it lets every row through), so each test holds ONE lead.
// Nothing real is sent; every identity is fake.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootAuTestServer } = require('./helpers/au-server-harness.js');

let h, t;
let seq = 0;
const SLOT = '2026-12-01T02:00:00.000Z';
const AU_YES = { ahpraRegistered: true, state: 'WA', vrStatus: 'yes', restriction19ab: 'unsure', rightToWork: 'temporary', consentVersion: 'au_a1_draft_2026_11' };

async function submitLead(over) {
  seq += 1;
  const body = Object.assign({
    name: 'Dr Test Booker' + seq, email: 'booker' + seq + '.wp15@gplink-test.local', phone: '+61400' + String(300000 + seq),
    country: 'uk', question: '', website: '', utm: {}, tz: 'Australia/Perth'
  }, over || {});
  const ip = '10.41.0.' + (seq % 250 + 1);
  const res = await h.post('/api/public/consult-lead', body, { headers: { 'x-forwarded-for': ip, 'x-real-ip': ip } });
  expect(res.status).toBe(200);
  return body;
}
function invitee(email, extra) {
  seq += 1;
  return { payload: Object.assign({
    uri: 'https://api.calendly.com/scheduled_events/EV' + seq + '/invitees/INV' + seq,
    email, name: 'Dr Test Booker', timezone: 'Australia/Perth',
    scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/EV' + seq, start_time: SLOT },
    questions_and_answers: [], tracking: {}
  }, extra || {}) };
}
const calls = () => h.emu.table('scheduled_calls');
const leadRows = () => h.emu.table('site_enquiries');

beforeAll(async () => {
  h = await bootAuTestServer({ name: 'wp15-booking', tables: { site_enquiries: [], scheduled_calls: [], webhook_events: [] } });
  t = h.testUtils;
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => {
  h.setSwitch(true);
  leadRows().length = 0;
  calls().length = 0;
});

describe('COM-35: the segment is on the booking row', () => {
  it('a lead books the public calendar: the new row carries segment, state and VR status', async () => {
    const lead = await submitLead(AU_YES);
    expect(leadRows()).toHaveLength(1);
    await t.handleCalendlyInviteeCreated(invitee(lead.email));
    expect(calls()).toHaveLength(1);
    const call = calls()[0];
    expect(call).toMatchObject({ invitee_email: lead.email, status: 'booked', host_kind: 'ceo', meeting_kind: 'consultation', created_by: 'calendly_direct' });
    expect(call.notification_channels).toEqual({ lead: { segment: 'au_restricted', lead_id: leadRows()[0].id, state: 'WA', vr_status: 'yes' } });
    // the lead itself is stamped as before
    expect(leadRows()[0].metadata.consult).toMatchObject({ call_booked: true, call_at: SLOT, segment: 'au_restricted' });
    // no column was invented: the row uses only columns the table has
    expect(Object.keys(call)).not.toContain('segment');
    expect(Object.keys(call)).not.toContain('lead_segment');
  });

  it('an overseas lead who answered "No": the row says overseas, and nothing Australian', async () => {
    const lead = await submitLead({ ahpraRegistered: false, consentVersion: 'overseas_v0', phone: '+447700900601', tz: 'Europe/London' });
    await t.handleCalendlyInviteeCreated(invitee(lead.email, { timezone: 'Europe/London' }));
    expect(calls()[0].notification_channels).toEqual({ lead: { segment: 'overseas', lead_id: leadRows()[0].id } });
  });

  it('a lead from before WP-15 (no segment recorded): overseas for a UK lead, au_unknown for an Australian-trained one', async () => {
    const uk = await submitLead({ phone: '+447700900602' });
    await t.handleCalendlyInviteeCreated(invitee(uk.email));
    expect(calls()[0].notification_channels.lead.segment).toBe('overseas');
    leadRows().length = 0; calls().length = 0;
    const au = await submitLead({ country: 'au' });
    await t.handleCalendlyInviteeCreated(invitee(au.email));
    expect(calls()[0].notification_channels.lead).toEqual({ segment: 'au_unknown', lead_id: leadRows()[0].id });
  });

  it('a call staff invited (the row already exists): the stamp is merged into the row\'s existing markers', async () => {
    const lead = await submitLead(AU_YES);
    const token = 'a'.repeat(32);
    calls().push({
      id: 'call-invited-1', correlation_token: token, status: 'invited', invitee_email: lead.email, meeting_kind: 'consultation', host_kind: 'ceo',
      notification_channels: { consult_reminders: { day_before: '2026-11-30T02:00:00.000Z' } }, created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z'
    });
    await t.handleCalendlyInviteeCreated(invitee(lead.email, { tracking: { utm_content: 'call_' + token } }));
    expect(calls()).toHaveLength(1);
    expect(calls()[0].status).toBe('booked');
    expect(calls()[0].notification_channels).toEqual({
      consult_reminders: { day_before: '2026-11-30T02:00:00.000Z' },
      lead: { segment: 'au_restricted', lead_id: leadRows()[0].id, state: 'WA', vr_status: 'yes' }
    });
  });

  it('someone with no lead on file books: the row is written as before (nothing to carry)', async () => {
    await t.handleCalendlyInviteeCreated(invitee('stranger.wp15@gplink-test.local'));
    expect(calls()).toHaveLength(1);
    expect(calls()[0].notification_channels).toBeUndefined();
  });

  it('switch OFF: no stamp on either path', async () => {
    const lead = await submitLead(AU_YES);
    h.setSwitch(false);
    await t.handleCalendlyInviteeCreated(invitee(lead.email));
    expect(calls()).toHaveLength(1);
    expect(calls()[0].notification_channels).toBeUndefined();
    expect(t.auBookingLeadStamp(leadRows()[0])).toBeNull();
    const token = 'b'.repeat(32);
    calls().length = 0;
    calls().push({ id: 'call-invited-2', correlation_token: token, status: 'invited', invitee_email: lead.email, meeting_kind: 'consultation', host_kind: 'ceo', notification_channels: null });
    const before = h.emu.requests.length;
    await t.handleCalendlyInviteeCreated(invitee(lead.email, { tracking: { utm_content: 'call_' + token } }));
    expect(calls()[0].notification_channels).toBeNull();
    const wrote = h.emu.requests.slice(before).filter((r) => r.table === 'scheduled_calls' && r.method !== 'GET');
    expect(JSON.stringify(wrote.map((r) => r.body))).not.toContain('notification_channels');
  });
});

describe('WEB-02: onboarding starts an Australian-segment lead in the Australian branch', () => {
  const cookieFor = (email) => h.gpCookie(email, 'user-' + email.split('@')[0]);

  it('same email as a "Yes" lead: fromLead, with the answers in the wizard\'s own values, and no pathway is written', async () => {
    const lead = await submitLead(AU_YES);
    const before = h.emu.requests.length;
    const res = await h.get('/api/onboarding/au-prefill?lead=1', { cookie: cookieFor(lead.email) });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, fromLead: true, segment: 'au_restricted', answers: { state: 'WA', moratorium19ab: 'unsure', workRights: 'temporary' } });
    const writes = h.emu.requests.slice(before).filter((r) => r.method !== 'GET');
    expect(writes).toEqual([]);
    expect(await t.resolveCandidatePathway('user-' + lead.email.split('@')[0])).toMatchObject({ isAu: false });
  });

  it('"citizen or permanent resident" is one answer on the lead form and two in onboarding, so it is not carried', async () => {
    const lead = await submitLead(Object.assign({}, AU_YES, { state: 'outside', restriction19ab: 'no', rightToWork: 'citizen_pr' }));
    const res = await h.get('/api/onboarding/au-prefill?lead=1', { cookie: cookieFor(lead.email) });
    expect(res.json).toMatchObject({ fromLead: true, answers: { state: '', moratorium19ab: 'no', workRights: '' } });
  });

  it('a "No" lead, a lead from before WP-15 and a doctor who never enquired get the ordinary first question', async () => {
    const no = await submitLead({ ahpraRegistered: false, consentVersion: 'overseas_v0' });
    expect((await h.get('/api/onboarding/au-prefill?lead=1', { cookie: cookieFor(no.email) })).json).toEqual({ ok: true, fromLead: false });
    leadRows().length = 0;
    const old = await submitLead({ country: 'au' });
    expect((await h.get('/api/onboarding/au-prefill?lead=1', { cookie: cookieFor(old.email) })).json).toEqual({ ok: true, fromLead: false });
    leadRows().length = 0;
    const none = await h.get('/api/onboarding/au-prefill?lead=1', { cookie: cookieFor('nobody.wp15@gplink-test.local') });
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ ok: true, fromLead: false });
  });

  it('without ?lead=1 the route answers as it did (404 for a doctor with no Australian pathway)', async () => {
    const lead = await submitLead(AU_YES);
    expect((await h.get('/api/onboarding/au-prefill', { cookie: cookieFor(lead.email) })).status).toBe(404);
  });

  it('signed out: refused; switch OFF: the route does not exist', async () => {
    const lead = await submitLead(AU_YES);
    expect((await h.get('/api/onboarding/au-prefill?lead=1')).status).toBe(401);
    h.setSwitch(false);
    expect((await h.get('/api/onboarding/au-prefill?lead=1', { cookie: cookieFor(lead.email) })).status).toBe(404);
    expect(await t.auOnboardingPrefillFromLead({ userProfile: { email: lead.email } })).toBeNull();
  });

  it('the wizard asks for it before showing the first question, and falls back to the question', () => {
    const js = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'onboarding.js'), 'utf8');
    const fn = js.slice(js.indexOf('function auAskOrStartFromLead()'), js.indexOf('// Called once from the init chain'));
    expect(fn).toContain('fetch("/api/onboarding/au-prefill?lead=1"');
    expect(fn).toContain('var timer = setTimeout(ask, 2500);');
    expect(fn).toContain('data.fromLead === true');
    expect(fn).toContain('state.auBranch = "yes";');
    expect(fn).toContain('.catch(function () { clearTimeout(timer); ask(); });');
    // it never sends or sets a pathway
    expect(fn).not.toMatch(/candidate_pathway|pathway\s*=/);
    const take = js.slice(js.indexOf('function auTakeOver(params)'), js.indexOf('(function auWireStaticButtons()'));
    // FR-3 (R3-01), deliberate: a "no" saved in the wizard (another device) counts as answered too.
    expect(take).toContain('if (alreadyUnderWay || auReadLocalAnswer() === "no" || state.auBranch === "no") return false;\n    auAskOrStartFromLead();');
  });
});
