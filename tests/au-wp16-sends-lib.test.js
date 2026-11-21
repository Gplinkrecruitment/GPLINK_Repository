// WP-16 (Australian GP build): the send rules for an Australian-segment lead,
// as pure functions. lib/au-lead-sends.js + the decisions that read it
// (nextConsultNudge, pendingConsultWaKinds, noShowRescueDecision).
//
//   the go-live rule    a lead from before Australian messages went live is
//                       owed nothing; a new lead gets one step at a time, in
//                       order
//   WhatsApp            only through an approved Australian template; flips
//                       on when one is marked approved
//   overseas / off      untouched (the byte-for-byte check is
//                       tests/au-wp16-overseas-parity.test.js)
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const consultLead = require('../lib/consult-lead.js');
const consultNoShow = require('../lib/consult-noshow.js');
const auLead = require('../lib/au-lead.js');
const auLeadSends = require('../lib/au-lead-sends.js');
const auLeadCopy = require('../lib/au-lead-copy.js');
const auWhatsAppTemplates = require('../lib/au-whatsapp-templates.js');

const M = 60000;
const H = 60 * M;
const D = 24 * H;
const LIVE = Date.parse('2026-12-01T00:00:00Z');
const ON = { auPathwayEnabled: true };
const OFF = { auPathwayEnabled: false };

const consult = (over) => Object.assign({ token: 'T', qualified: true, country: 'au', segment: 'au_vr', call_booked: false, nudges: [] }, over || {});
const sent = (c, due, atMs) => Object.assign({}, c, { nudges: (c.nudges || []).concat([{ seq: due.seq, step: due.step, sent_at: new Date(atMs).toISOString(), email: 'sent' }]) });

afterEach(() => { delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES; delete process.env.AU_LEAD_COPY_LIVE_FROM; });

describe('the go-live rule (auSequenceAdmits): one place', () => {
  it('admits an event at or after go-live, and nothing else', () => {
    expect(auLeadSends.auSequenceAdmits({ anchorMs: LIVE, liveFromMs: LIVE })).toEqual({ admit: true, reason: '' });
    expect(auLeadSends.auSequenceAdmits({ anchorMs: LIVE + 1, liveFromMs: LIVE }).admit).toBe(true);
    expect(auLeadSends.auSequenceAdmits({ anchorMs: LIVE - 1, liveFromMs: LIVE })).toEqual({ admit: false, reason: 'au_before_go_live' });
    expect(auLeadSends.auSequenceAdmits({ anchorMs: '2026-12-02T00:00:00Z', liveFromMs: '2026-12-01T00:00:00Z' }).admit).toBe(true);
  });
  it('fails closed: no go-live instant, or no event time, admits nobody', () => {
    [undefined, null, NaN, '', 'soon'].forEach((bad) => {
      expect(auLeadSends.auSequenceAdmits({ anchorMs: LIVE + D, liveFromMs: bad }).admit, 'live ' + bad).toBe(false);
      expect(auLeadSends.auSequenceAdmits({ anchorMs: bad, liveFromMs: LIVE }).admit, 'anchor ' + bad).toBe(false);
    });
    expect(auLeadSends.auSequenceAdmits().admit).toBe(false);
  });
  it('reads AU_LEAD_COPY_LIVE_FROM as an ISO instant', () => {
    expect(auLeadSends.liveFromEnvMs({ AU_LEAD_COPY_LIVE_FROM: '2026-12-01T00:00:00Z' })).toBe(LIVE);
    expect(Number.isNaN(auLeadSends.liveFromEnvMs({}))).toBe(true);
    expect(Number.isNaN(auLeadSends.liveFromEnvMs({ AU_LEAD_COPY_LIVE_FROM: 'tomorrow' }))).toBe(true);
  });
  it('each message is measured from its own event', () => {
    const row = { created_at: '2026-12-05T00:00:00Z', metadata: { consult: consult({ call_booked_at: '2026-12-06T00:00:00Z', call_completed_at: '2026-12-08T00:30:00Z', no_show: { call_at: '2026-12-09T00:00:00Z' } }) } };
    const iso = (id) => new Date(auLeadSends.anchorMsFor(id, row)).toISOString().slice(0, 16);
    ['n01_5m', 'n01_1h', 'n01_24h'].forEach((id) => expect(iso(id)).toBe('2026-12-05T00:00'));
    expect(iso('n02_booked')).toBe('2026-12-06T00:00');
    ['n03_after_call', 'n03_week1', 'n03_week2', 'n03_week3'].forEach((id) => expect(iso(id)).toBe('2026-12-08T00:30'));
    expect(iso('n02_noshow')).toBe('2026-12-09T00:00');
    ['booking_link', 'n02_reminder_day', 'n02_reminder_hour', 'nope'].forEach((id) => expect(Number.isNaN(auLeadSends.anchorMsFor(id, row))).toBe(true));
    // No booking time on the lead: not admitted (there is no fallback to when they enquired).
    expect(Number.isNaN(auLeadSends.anchorMsFor('n02_booked', { created_at: '2026-12-05T00:00:00Z', metadata: { consult: consult() } }))).toBe(true);
  });
});

describe('the notes before a booking (nextConsultNudge)', () => {
  const due = (c, createdAtMs, nowMs, extra) => consultLead.nextConsultNudge(Object.assign({ consult: c, createdAtMs, nowMs }, ON, extra || {}));

  it('an OLD lead (enquired before go-live) is owed nothing, however overdue, at any later time', () => {
    const created = LIVE - 20 * D;
    [LIVE + M, LIVE + H, LIVE + 2 * D, LIVE + 30 * D].forEach((now) => {
      expect(due(consult(), created, now, { auLiveFromMs: LIVE }), new Date(now).toISOString()).toBeNull();
    });
    // ... one second before go-live counts as old.
    expect(due(consult(), LIVE - 1000, LIVE + 2 * D, { auLiveFromMs: LIVE })).toBeNull();
    // Sanity: the same lead with the switch off, or as a UK lead, IS owed the first step.
    expect(consultLead.nextConsultNudge(Object.assign({ consult: consult(), createdAtMs: created, nowMs: LIVE + H }, OFF))).toMatchObject({ seq: 'not_booked', step: 0 });
    expect(due(consult({ country: 'uk', segment: 'overseas' }), created, LIVE + H, { auLiveFromMs: LIVE })).toMatchObject({ seq: 'not_booked', step: 0 });
  });

  it('with no go-live instant passed in, no Australian step is handed out (fail closed)', () => {
    expect(due(consult(), LIVE + D, LIVE + 2 * D)).toBeNull();
    expect(due(consult(), LIVE + D, LIVE + 2 * D, { auLiveFromMs: NaN })).toBeNull();
  });

  it('a NEW lead whose three notes are all overdue gets ONE step per run, in order, never bunched', () => {
    const created = LIVE + H;
    let c = consult();
    let now = created + 3 * D;                      // all three are overdue
    const log = [];
    for (let run = 0; run < 400 && log.length < 3; run++) {
      const d = due(c, created, now, { auLiveFromMs: LIVE });
      if (d) { log.push({ step: d.step, at: now }); c = sent(c, d, now); }
      // The very next run (5 minutes on) never hands out the following step.
      const next = due(c, created, now + 5 * M, { auLiveFromMs: LIVE });
      if (d) expect(next).toBeNull();
      now += 5 * M;
    }
    expect(log.map((x) => x.step)).toEqual([0, 1, 2]);
    expect(log[1].at - log[0].at).toBeGreaterThanOrEqual(40 * M);
    expect(log[2].at - log[1].at).toBeGreaterThanOrEqual(12 * H);
    expect(due(c, created, now + 30 * D, { auLiveFromMs: LIVE })).toBeNull();
  });

  it('on the ordinary clock a new lead gets them at 5 minutes, 1 hour and 24 hours, like every other lead', () => {
    const created = LIVE + H;
    let c = consult();
    const at = [];
    for (let t = 0; t <= 2 * D; t += 5 * M) {
      const d = due(c, created, created + t, { auLiveFromMs: LIVE });
      if (d) { at.push([d.step, t / M]); c = sent(c, d, created + t); }
    }
    expect(at).toEqual([[0, 5], [1, 60], [2, 1440]]);
  });

  it('every Australian segment follows the same rule (the wording differs, not the clock)', () => {
    ['au_vr', 'au_unknown', 'au_restricted', 'au_non_vr', 'au_registrar'].forEach((segment) => {
      expect(due(consult({ segment }), LIVE + H, LIVE + H + 10 * M, { auLiveFromMs: LIVE }), segment).toMatchObject({ seq: 'not_booked', step: 0 });
      expect(due(consult({ segment }), LIVE - H, LIVE + H, { auLiveFromMs: LIVE }), segment).toBeNull();
    });
    // An old row with no segment recorded, trained in Australia, is Australian-segment too.
    expect(due({ qualified: true, country: 'au', nudges: [] }, LIVE - H, LIVE + H, { auLiveFromMs: LIVE })).toBeNull();
    expect(due({ qualified: true, country: 'au', nudges: [] }, LIVE + H, LIVE + 2 * H, { auLiveFromMs: LIVE })).toMatchObject({ step: 0 });
  });
});

describe('after a booking (nextConsultNudge, booked_no_signup)', () => {
  const dueB = (c, nowMs, createdAtMs) => consultLead.nextConsultNudge(Object.assign({
    consult: c, createdAtMs: createdAtMs || (LIVE - 30 * D), nowMs,
    callAtMs: c.call_at ? Date.parse(c.call_at) : NaN,
    callCompletedMs: consultLead.consultCallCompletedForDripMs(c), auLiveFromMs: LIVE
  }, ON));
  const iso = (ms) => new Date(ms).toISOString();

  it('an old lead who books AFTER go-live gets "your call is booked" (a new event), though never the old notes', () => {
    const c = consult({ call_booked: true, call_booked_at: iso(LIVE + D), call_at: iso(LIVE + 3 * D) });
    expect(dueB(c, LIVE + D + 2 * M)).toEqual({ seq: 'booked_no_signup', step: 0 });
  });

  it('a booking made BEFORE go-live is not confirmed late; the call, attended after go-live, still starts the after-call emails', () => {
    const booked = consult({ call_booked: true, call_booked_at: iso(LIVE - 2 * D), call_at: iso(LIVE + D) });
    expect(dueB(booked, LIVE + H)).toBeNull();
    const attended = Object.assign({}, booked, { call_completed_at: iso(LIVE + D + 30 * M), call_attended: true });
    expect(dueB(attended, LIVE + D + 31 * M)).toEqual({ seq: 'booked_no_signup', step: 1 });
  });

  it('a call that ended before go-live starts nothing, weeks later included', () => {
    const c = consult({
      call_booked: true, call_booked_at: iso(LIVE - 20 * D), call_at: iso(LIVE - 15 * D),
      call_completed_at: iso(LIVE - 15 * D + 30 * M), call_attended: true
    });
    [LIVE + M, LIVE + 7 * D, LIVE + 30 * D].forEach((now) => expect(dueB(c, now)).toBeNull());
  });

  it('a new lead walks the five steps one at a time, weekly ones a week apart', () => {
    const created = LIVE + H;
    let c = consult({ call_booked: true, call_booked_at: iso(created + 10 * M), call_at: iso(created + 2 * D) });
    const got = [];
    for (let t = 10 * M; t <= 26 * D; t += (t < 3 * D ? 5 * M : H)) {
      if (!c.call_completed_at && t >= 2 * D + 30 * M) c = Object.assign({}, c, { call_completed_at: iso(created + 2 * D + 30 * M), call_attended: true });
      const d = dueB(c, created + t, created);
      if (d) { got.push(d.step); c = sent(c, d, created + t); expect(dueB(c, created + t + 5 * M, created)).toBeNull(); }
    }
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('WhatsApp legs (pendingConsultWaKinds): only through an approved Australian template', () => {
  const owed = (c, opts) => consultLead.pendingConsultWaKinds(c, LIVE + 2 * H, opts);
  const stepDone = consult({ nudges: [{ seq: 'not_booked', step: 1, sent_at: new Date(LIVE + H).toISOString(), email: 'sent' }] });

  it('nothing is owed to an Australian lead while no template is approved; an overseas lead is owed the leg as ever', () => {
    expect(owed(stepDone, ON)).toEqual([]);
    expect(owed(Object.assign({}, stepDone, { country: 'uk', segment: 'overseas' }), ON)).toEqual(['check_in_1h']);
    expect(owed(stepDone, OFF)).toEqual(['check_in_1h']);
  });
  it('flips on when the template is marked approved (by key or by template name), for that touch only', () => {
    expect(owed(stepDone, Object.assign({ env: { AU_WHATSAPP_APPROVED_TEMPLATES: 'lead_check_in_1h' } }, ON))).toEqual(['check_in_1h']);
    expect(owed(stepDone, Object.assign({ env: { AU_WHATSAPP_APPROVED_TEMPLATES: 'gp_link_au_lead_check_in' } }, ON))).toEqual(['check_in_1h']);
    expect(owed(stepDone, Object.assign({ env: { AU_WHATSAPP_APPROVED_TEMPLATES: 'lead_hello_5m' } }, ON))).toEqual([]);
    process.env.AU_WHATSAPP_APPROVED_TEMPLATES = 'lead_check_in_1h';
    expect(owed(stepDone, ON)).toEqual(['check_in_1h']);
  });
  it('the plan names the Australian template, never the overseas one', () => {
    expect(auWhatsAppTemplates.auLeadWhatsAppPlan('hello_5m', {})).toEqual({ send: false, reason: 'au_template_not_approved', key: 'lead_hello_5m', templateName: 'gp_link_au_lead_hello' });
    expect(auWhatsAppTemplates.auLeadWhatsAppPlan('hello_5m', { AU_WHATSAPP_APPROVED_TEMPLATES: 'lead_hello_5m' })).toEqual({ send: true, reason: '', key: 'lead_hello_5m', templateName: 'gp_link_au_lead_hello', language: 'en' });
    // A kind with no Australian row can never be sent.
    expect(auWhatsAppTemplates.auLeadWhatsAppPlan('owner_lead_alert', { AU_WHATSAPP_APPROVED_TEMPLATES: 'lead_owner_lead_alert' }).send).toBe(false);
    expect(auWhatsAppTemplates.auLeadWhatsAppPlan('', {}).send).toBe(false);
  });
});

describe('a missed call (noShowRescueDecision)', () => {
  const slot = LIVE + 2 * D;
  const row = (over, slotMs) => ({
    email: 'au.vr.test@gplink-test.local', phone: '+61400000111',
    metadata: { consult: consult(Object.assign({
      call_booked: true, call_at: new Date(slotMs || slot).toISOString(),
      no_show: { call_at: new Date(slotMs || slot).toISOString(), detected_at: new Date((slotMs || slot) + 40 * M).toISOString(), via: 'sweep', ring: 'pending' }
    }, over || {})) }
  });
  const decide = (r, nowMs, extra) => consultNoShow.noShowRescueDecision(Object.assign({ row: r, nowMs, hasPhone: true, auLiveFromMs: LIVE }, ON, extra || {}));

  it('a slot missed after go-live: the email is due an hour later; the WhatsApp is skipped by name (no approved template)', () => {
    expect(decide(row(), slot + 59 * M)).toMatchObject({ email: false, wa: false, reason: 'too_soon' });
    expect(decide(row(), slot + 61 * M)).toEqual({ email: true, wa: false, reason: 'due', au: true, waSkipped: 'au_template_not_approved', waTemplateName: '' });
    expect(decide(row(), slot + 37 * H)).toMatchObject({ email: false, wa: false, reason: 'expired' });
  });
  it('a slot missed before go-live is left alone (the handover rule: never reach back)', () => {
    const old = row({}, LIVE - D);
    expect(decide(old, LIVE - D + 2 * H)).toEqual({ email: false, wa: false, reason: 'au_before_go_live' });
    // ... and with no go-live instant, nobody is rescued.
    expect(consultNoShow.noShowRescueDecision(Object.assign({ row: row(), nowMs: slot + 2 * H, hasPhone: true }, ON)).reason).toBe('au_before_go_live');
  });
  it('with the Australian template approved the WhatsApp is due, through that template', () => {
    const d = decide(row(), slot + 61 * M, { env: { AU_WHATSAPP_APPROVED_TEMPLATES: 'lead_call_missed' } });
    expect(d).toEqual({ email: true, wa: true, reason: 'due', au: true, waSkipped: '', waTemplateName: 'gp_link_au_lead_missed_call' });
  });
  it('switch off, and overseas leads: the decision is the one it always was (no extra keys)', () => {
    expect(consultNoShow.noShowRescueDecision(Object.assign({ row: row(), nowMs: slot + 61 * M, hasPhone: true }, OFF))).toEqual({ email: true, wa: true, reason: 'due' });
    const uk = row({ country: 'uk', segment: 'overseas' });
    expect(decide(uk, slot + 61 * M)).toEqual({ email: true, wa: true, reason: 'due' });
    expect(decide(row({ country: 'uk', segment: 'overseas' }, LIVE - D), LIVE - D + 2 * H)).toEqual({ email: true, wa: true, reason: 'due' });
  });
  it('a real stop still silences it', () => {
    expect(decide(row({ stopped: 'unsubscribed' }), slot + 2 * H).reason).toBe('stopped_unsubscribed');
  });
});

describe('the lead\'s own record (consult.au_log)', () => {
  it('a skip is written once; a send is always written; the record is capped', () => {
    const now = '2026-12-02T00:00:00.000Z';
    const skip = { id: 'n01_1h', ch: 'whatsapp', out: 'skipped', why: 'au_template_not_approved', key: 'check_in_1h' };
    const a = auLeadSends.withAuLog(consult(), [skip, { id: 'n01_1h', ch: 'email', out: 'sent' }], now);
    expect(a.au_log).toEqual([
      { id: 'n01_1h', ch: 'whatsapp', out: 'skipped', at: now, why: 'au_template_not_approved', key: 'check_in_1h' },
      { id: 'n01_1h', ch: 'email', out: 'sent', at: now }
    ]);
    // The same skip again changes nothing: the SAME object comes back, so no write happens.
    expect(auLeadSends.withAuLog(a, [skip], '2026-12-03T00:00:00.000Z')).toBe(a);
    // A different reason, or a different key, is a different fact.
    expect(auLeadSends.withAuLog(a, [Object.assign({}, skip, { key: 'check_in_1h:other' })]).au_log.length).toBe(3);
    expect(auLeadSends.withAuLog(a, [{ id: 'n01_1h', ch: 'email', out: 'sent' }]).au_log.length).toBe(3);
    expect(auLeadSends.withAuLog(a, []).au_log).toBe(a.au_log);
    expect(auLeadSends.withAuLog(a, [{ id: '', ch: 'email', out: 'sent' }, null])).toBe(a);
    let big = consult();
    for (let i = 0; i < 80; i++) big = auLeadSends.withAuLog(big, [{ id: 'n01_1h', ch: 'email', out: 'sent', at: new Date(LIVE + i * M).toISOString() }]);
    expect(big.au_log.length).toBe(60);
  });

  it('reads back in the owner\'s words, newest first', () => {
    const c = auLeadSends.withAuLog(consult(), [
      { id: 'n01_5m', ch: 'email', out: 'sent', at: '2026-12-02T00:05:00Z' },
      { id: 'n01_5m', ch: 'whatsapp', out: 'skipped', why: 'au_template_not_approved', key: 'hello_5m', at: '2026-12-02T00:05:00Z' },
      { id: 'n03_week1', ch: 'email', out: 'skipped', why: 'au_segment_not_launched', at: '2026-12-09T00:00:00Z' },
      { id: 'onboarding_incomplete', ch: 'whatsapp', out: 'skipped', why: 'au_template_not_approved', at: '2026-12-10T00:00:00Z' }
    ]);
    expect(auLeadSends.describeAuLog({ metadata: { consult: c }, kind: 'gp' }).map((x) => x.text)).toEqual([
      'WhatsApp skipped: no approved Australian template (Finish setting up reminder)',
      'Email skipped: not sent to this segment (not launched): follow up personally (Week 1: how it works)',
      'WhatsApp skipped: no approved Australian template (5-minute note)',
      'Email sent: 5-minute note'
    ]);
  });

  it('knows when the booking-link email went, and whether anything went in this run', () => {
    const c = auLeadSends.withAuLog(consult(), [{ id: 'booking_link', ch: 'email', out: 'sent', at: '2026-12-02T00:00:10Z' }, { id: 'n01_5m', ch: 'email', out: 'skipped', why: 'au_booking_link_just_sent', at: '2026-12-02T00:05:00Z' }]);
    expect(new Date(auLeadSends.lastBookingLinkSentMs(c)).toISOString()).toBe('2026-12-02T00:00:10.000Z');
    expect(Number.isNaN(auLeadSends.lastBookingLinkSentMs(consult()))).toBe(true);
    expect(auLeadSends.sentSince(c, Date.parse('2026-12-02T00:00:00Z'))).toBe(true);
    expect(auLeadSends.sentSince(c, Date.parse('2026-12-02T00:01:00Z'))).toBe(false);   // a skip is not a send
    expect(auLeadSends.sentSince(c, NaN)).toBe(false);
  });
});

describe('where a lead stands (leadCopyState), for the Leads tab', () => {
  const row = (created, over) => ({ kind: 'gp', created_at: new Date(created).toISOString(), metadata: { consult: consult(over) } });
  it('before go-live, live, not live yet, not Australian', () => {
    expect(auLeadSends.leadCopyState(row(LIVE - D), LIVE, ON)).toBe('before_go_live');
    expect(auLeadSends.leadCopyState(row(LIVE + D), LIVE, ON)).toBe('live');
    expect(auLeadSends.leadCopyState(row(LIVE - D, { call_booked_at: new Date(LIVE + H).toISOString() }), LIVE, ON)).toBe('live');   // booked since
    expect(auLeadSends.leadCopyState(row(LIVE + D), NaN, ON)).toBe('not_live');
    expect(auLeadSends.leadCopyState(row(LIVE + D, { country: 'uk', segment: 'overseas' }), LIVE, ON)).toBe('not_australian');
    expect(auLeadSends.leadCopyState(row(LIVE + D), LIVE, OFF)).toBe('not_australian');
  });
});

describe('the retired hold', () => {
  it('auCopyApplies is the question the former hold sites ask; the hold has no call site left in the code', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    expect(auLead.auCopyApplies(consult(), ON)).toBe(true);
    expect(auLead.auCopyApplies(consult(), OFF)).toBe(false);
    expect(auLead.auCopyApplies(consult({ country: 'uk', segment: 'overseas' }), ON)).toBe(false);
    const callSite = /auMessagesHeld\s*\(/;
    ['server.js'].concat(fs.readdirSync(path.join(root, 'lib')).filter((f) => /\.js$/.test(f)).map((f) => 'lib/' + f)).forEach((file) => {
      const src = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
        .filter((line) => callSite.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/^function auMessagesHeld/.test(line.trim()));
      expect(src, file).toEqual([]);
    });
    // The Hazel block is untouched and still ignores the switch.
    expect(auLead.auHazelBlocked(consult(), OFF)).toBe(true);
    expect(auLead.auHazelBlocked(consult(), ON)).toBe(true);
  });
  it('every message in the table has a builder, a group list and both send rules', () => {
    auLeadCopy.MESSAGE_IDS.forEach((id) => {
      const m = auLeadCopy.MESSAGES[id];
      expect(['gated', 'exempt', 'prompt'], id).toContain(m.quiet);
      expect(['qualified', 'booked', 'attended', 'no_show', 'none'], id).toContain(m.anchor);
      expect(m.groups, id).toContain('main');
      expect(auLeadCopy.messagePlan(id, 'au_vr')).toEqual({ send: true, group: 'main', reason: '' });
    });
    expect(auLeadCopy.messagePlan('nope', 'au_vr').send).toBe(false);
  });
});
