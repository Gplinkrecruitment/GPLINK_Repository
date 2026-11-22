// WP-01 of the Australian GP build ("Stop wrong messages to Australian leads
// now"): the pure rules, in BOTH states of the AU_PATHWAY_ENABLED switch.
//
//   switch ON   an Australian-segment lead (consult.country 'au') is never rung
//               by Hazel on any of her call paths, and is owed no chase email,
//               no WhatsApp and no no-show rescue message. The owner is still
//               paged. UK, Irish and New Zealand leads are unchanged.
//   switch OFF  the MESSAGES are exactly what they were before the build: an
//               Australian lead is chased like anyone else.
//
//   HAZEL IS THE EXCEPTION (WP-04, on the lead's instruction; owner decision 7).
//   The call block no longer looks at the switch: an Australian-segment lead is
//   skipped with reason 'au_segment' in BOTH states. This file used to pin
//   "switch OFF: an Australian lead is rung on the Sydney clock from the AU
//   number"; those assertions were changed on purpose and now pin the skip.
//   See docs/au-gp/CONVENTIONS.md section 2, "Deliberate exceptions to
//   switch-off parity". New Zealand leads are untouched in both states.
//
//   CHANGED in WP-16 (Australian lead and consult copy). WP-01's hold was
//   interim: "an Australian lead is owed no chase email, no WhatsApp and no
//   rescue message until Australian copy exists". The copy now exists, so the
//   three groups below that pinned the hold were changed on purpose (each
//   carries a "CHANGED in WP-16" note saying what it used to assert). What
//   they pin now: an Australian-segment lead is owed nothing ONLY when the
//   go-live rule says so (enquired before Australian messages went live, or no
//   go-live instant is known); a lead from after go-live is owed the same
//   steps on the same clock as a UK lead, in Australian wording; and a
//   WhatsApp leg is owed only through an approved Australian template. The
//   full Australian behaviour is in tests/au-wp16-*.test.js.
//
// Fixture shapes are the ones the existing suites use for stored
// site_enquiries rows (tests/lead-calls-lib.test.js, tests/consult-lead.test.js,
// tests/consult-noshow-lib.test.js). Every identity is fake.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const auLead = requireCjs('../lib/au-lead.js');
const leadCalls = requireCjs('../lib/lead-calls.js');
const consultLead = requireCjs('../lib/consult-lead.js');
const consultNoShow = requireCjs('../lib/consult-noshow.js');
const docPipeline = requireCjs('../lib/document-pipeline.js');

const ON = { auPathwayEnabled: true };
const OFF = { auPathwayEnabled: false };
const MIN = 60000;
const HOUR = 60 * MIN;

// Monday 2026-11-16 23:30 UTC. Inside calling hours everywhere at once:
// Tuesday 10:30 in Sydney, Tuesday 12:30 in Auckland. London and Dublin are at
// 23:30, so the UK and Irish cases pass ignoreHours (hours are not what this
// file is about; the Sydney-clock case below pins the hours rule itself).
const NOW = Date.parse('2026-11-16T23:30:00Z');

const CFG = leadCalls.parseLeadCallConfig({
  LEAD_CALLS_ENABLED: 'true',
  RETELL_API_KEY: 'key_test',
  RETELL_AGENT_ID: 'agent_1',
  RETELL_FROM_NUMBER_UK: '+442030000000',
  RETELL_FROM_NUMBER_AU: '+61280000000'
});

const PEOPLE = {
  au: { name: 'Dr Test Auvr', email: 'au.vr.test@gplink-test.local', phone: '+61 400 000 111' },
  uk: { name: 'Dr Test Ukgp', email: 'uk.gp.test@gplink-test.local', phone: '+44 7700 900111' },
  ie: { name: 'Dr Test Iegp', email: 'ie.gp.test@gplink-test.local', phone: '+353 87 000 0111' },
  nz: { name: 'Dr Test Nzgp', email: 'nz.gp.test@gplink-test.local', phone: '+64 21 000 111' }
};
const OVERSEAS = ['uk', 'ie', 'nz'];

function lead(country, consultOver, rowOver) {
  const p = PEOPLE[country];
  return Object.assign({
    id: 'lead-' + country,
    kind: 'gp',
    name: p.name,
    email: p.email,
    phone: p.phone,
    state: country,
    status: 'new',
    created_at: new Date(NOW - 30 * MIN).toISOString(),
    metadata: {
      source: 'meta_lead_ad',
      consult: Object.assign({ token: 'TOK-' + country, qualified: true, is_gp: true, country: country, call_booked: false, nudges: [] }, consultOver || {})
    }
  }, rowOver || {});
}

// The four ways a call to a lead can come about. (The fourth, the owner's
// "ring now" button, lives in server.js and is covered by the endpoint suite.)
const CALL_PATHS = {
  'the regular schedule': (c) => lead(c),
  'a call-back the owner scheduled, now due': (c) => lead(c, { call_back_at: new Date(NOW - 5 * MIN).toISOString() }, { created_at: new Date(NOW - 20 * 86400000).toISOString() }),
  'a call-back the doctor asked Hazel for, now due': (c) => lead(c, {
    ai_calls: [{ call_id: 'c1', outcome: 'callback_requested' }],
    ai_call: { call_id: 'c1', outcome: 'callback_requested', callback_at: new Date(NOW - 5 * MIN).toISOString(), started_at: new Date(NOW - 5 * HOUR).toISOString(), completed_at: new Date(NOW - 5 * HOUR + 2 * MIN).toISOString() }
  }),
  'the one call owed after a missed consultation': (c) => {
    const callAt = new Date(NOW - 3 * HOUR).toISOString();
    return lead(c, {
      call_booked: true, call_booked_at: new Date(NOW - 30 * HOUR).toISOString(), call_at: callAt,
      no_show: { call_at: callAt, detected_at: new Date(NOW - 2 * HOUR).toISOString(), via: 'sweep', ring: 'pending' }
    }, { created_at: new Date(NOW - 3 * 86400000).toISOString() });
  }
};

const decide = (row, sw, extra) => leadCalls.leadCallDecision(Object.assign({ row, nowMs: NOW, cfg: CFG, ignoreHours: true }, sw, extra || {}));

describe('isAuSegmentLead: the one test for "is this an Australian-segment lead?"', () => {
  it('reads consult.country, from a row or from the consult itself', () => {
    expect(auLead.isAuSegmentLead(lead('au'))).toBe(true);
    expect(auLead.isAuSegmentLead(lead('au').metadata.consult)).toBe(true);
    expect(auLead.isAuSegmentLead({ kind: 'gp', metadata: { consult: { country: ' AU ' } } })).toBe(true);
  });
  it('is false for every overseas lead, and for anything it cannot read', () => {
    OVERSEAS.forEach((c) => expect(auLead.isAuSegmentLead(lead(c))).toBe(false));
    expect(auLead.isAuSegmentLead(lead('uk', { country: 'other' }))).toBe(false);
    expect(auLead.isAuSegmentLead(lead('uk', { country: '' }))).toBe(false);
    expect(auLead.isAuSegmentLead({ kind: 'gp', metadata: {} })).toBe(false);
    expect(auLead.isAuSegmentLead({ kind: 'gp' })).toBe(false);
    expect(auLead.isAuSegmentLead(null)).toBe(false);
    expect(auLead.isAuSegmentLead(undefined)).toBe(false);
    // A UK-trained doctor living in Australia is an overseas lead: the dial
    // code and the row's state column are not the training country.
    expect(auLead.isAuSegmentLead(lead('uk', {}, { phone: '+61 400 000 222', state: 'au' }))).toBe(false);
  });
  // CHANGED in WP-04 (was: "the two behaviours follow the switch, and are off
  // whenever it is off", with auHazelBlocked(au, OFF) === false).
  it('the message hold follows the switch; the Hazel block does not', () => {
    expect(auLead.auMessagesHeld(lead('au'), ON)).toBe(true);
    expect(auLead.auMessagesHeld(lead('au'), OFF)).toBe(false);
    // Hazel: blocked whatever the switch says, and with nothing passed at all.
    expect(auLead.auHazelBlocked(lead('au'), ON)).toBe(true);
    expect(auLead.auHazelBlocked(lead('au'), OFF)).toBe(true);
    expect(auLead.auHazelBlocked(lead('au'))).toBe(true);
    OVERSEAS.forEach((c) => {
      [ON, OFF, undefined].forEach((sw) => {
        expect(auLead.auHazelBlocked(lead(c), sw)).toBe(false);
        expect(auLead.auMessagesHeld(lead(c), sw || ON)).toBe(false);
      });
    });
  });
  it('the Hazel block ignores the environment switch too', () => {
    const saved = process.env.AU_PATHWAY_ENABLED;
    try {
      process.env.AU_PATHWAY_ENABLED = 'false';
      expect(auLead.auHazelBlocked(lead('au'))).toBe(true);
      expect(auLead.auHazelBlocked(lead('nz'))).toBe(false);
      process.env.AU_PATHWAY_ENABLED = 'true';
      expect(auLead.auHazelBlocked(lead('au'))).toBe(true);
      expect(auLead.auHazelBlocked(lead('nz'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = saved;
    }
  });
});

describe('the switch is read from AU_PATHWAY_ENABLED when nothing is passed in', () => {
  const saved = process.env.AU_PATHWAY_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = saved;
  });
  // CHANGED in WP-04: with the switch false the call decision used to be
  // `action: 'call'`. Hazel is now refused in both states; only the message
  // hold still follows the switch.
  it('true holds an Australian lead\'s messages; false sends them as before; Hazel is refused either way', () => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    expect(leadCalls.leadCallDecision({ row: lead('au'), nowMs: NOW, cfg: CFG }).reason).toBe('au_segment');
    expect(consultLead.nextConsultNudge({ consult: lead('au').metadata.consult, createdAtMs: NOW - 10 * MIN, nowMs: NOW })).toBe(null);
    process.env.AU_PATHWAY_ENABLED = 'false';
    expect(leadCalls.leadCallDecision({ row: lead('au'), nowMs: NOW, cfg: CFG })).toEqual({ action: 'skip', reason: 'au_segment' });
    expect(leadCalls.leadCallDecision({ row: lead('nz'), nowMs: NOW, cfg: CFG }).action).toBe('call');
    expect(consultLead.nextConsultNudge({ consult: lead('au').metadata.consult, createdAtMs: NOW - 10 * MIN, nowMs: NOW }))
      .toEqual({ seq: 'not_booked', step: 0, email: false, wa: 'hello_5m' });
  });
});

describe('Hazel (leadCallDecision): switch ON', () => {
  Object.keys(CALL_PATHS).forEach((label) => {
    it('never rings an Australian lead by ' + label, () => {
      const d = decide(CALL_PATHS[label]('au'), ON);
      expect(d).toEqual({ action: 'skip', reason: 'au_segment' });
    });
    it('still rings UK, Irish and New Zealand leads by ' + label, () => {
      OVERSEAS.forEach((c) => {
        const d = decide(CALL_PATHS[label](c), ON);
        expect(d.action, c + ': ' + JSON.stringify(d)).toBe('call');
        expect(d.country).toBe(c);
      });
    });
  });

  it('refuses an Australian lead even inside Sydney calling hours with the AU number set up', () => {
    // No ignoreHours: 10:30 on a Tuesday in Sydney. Nothing else stands in the way.
    expect(leadCalls.leadCallDecision(Object.assign({ row: lead('au'), nowMs: NOW, cfg: CFG }, ON)))
      .toEqual({ action: 'skip', reason: 'au_segment' });
  });

  it('refuses a lead with no country on file that would be dialled as Australian', () => {
    // An owner call-back waives the screening verdict, so a row with no
    // country can reach the dial-code fallback. It must not ring as "au".
    const noCountry = lead('au', { country: '', qualified: false, call_back_at: new Date(NOW - 5 * MIN).toISOString() }, { state: null });
    expect(decide(noCountry, ON)).toEqual({ action: 'skip', reason: 'au_segment' });
    const byState = lead('au', { country: '', call_back_at: new Date(NOW - 5 * MIN).toISOString() }, { state: 'au' });
    expect(decide(byState, ON)).toEqual({ action: 'skip', reason: 'au_segment' });
  });

  it('a UK-trained doctor on an Australian mobile is still an overseas lead and still rung', () => {
    const d = decide(lead('uk', {}, { phone: '+61 400 000 222' }), ON);
    expect(d.action).toBe('call');
    expect(d.country).toBe('uk');
    expect(d.from).toBe('+442030000000');
  });

  it('tells the Leads tab why, in plain words', () => {
    const plan = leadCalls.leadCallPlan(Object.assign({ row: lead('au'), nowMs: NOW, cfg: CFG }, ON));
    expect(plan.state).toBe('blocked');
    expect(plan.reason).toBe('au_segment');
    expect(plan.label).toBe('Australian GP: Hazel does not ring Australian leads');
    expect(plan.detail).toBe('follow up with this doctor yourself');
    expect(plan.due_at).toBe('');
    // The same answer for a lead who would otherwise be "queued" by a call-back.
    const cb = leadCalls.leadCallPlan(Object.assign({ row: CALL_PATHS['a call-back the owner scheduled, now due']('au'), nowMs: NOW, cfg: CFG }, ON));
    expect(cb.state).toBe('blocked');
    expect(cb.reason).toBe('au_segment');
  });
});

// CHANGED in WP-04. This block used to be "switch OFF is exactly the old
// behaviour" and asserted that an Australian lead WAS rung (action 'call',
// country 'au', from '+61280000000', on the Sydney clock, 'outside_hours' at
// night) on all four call paths, and that the Leads tab showed them 'queued'.
// The Hazel block is now unconditional, so every one of those is the same
// refusal the switch-ON block above pins.
describe('Hazel (leadCallDecision): switch OFF, an Australian lead is refused exactly as with the switch on', () => {
  it('is skipped with au_segment inside Sydney calling hours with the AU number set up, and at night', () => {
    const d = leadCalls.leadCallDecision(Object.assign({ row: lead('au'), nowMs: NOW, cfg: CFG }, OFF));
    expect(d).toEqual({ action: 'skip', reason: 'au_segment' });
    // Night in Sydney (Tuesday 11:00 UTC = 22:00 AEDT): still au_segment, never 'outside_hours'
    // (which would mean "will ring in the morning").
    const night = Date.parse('2026-11-17T11:00:00Z');
    const late = lead('au', {}, { created_at: new Date(night - 30 * MIN).toISOString() });
    expect(leadCalls.leadCallDecision(Object.assign({ row: late, nowMs: night, cfg: CFG }, OFF))).toEqual({ action: 'skip', reason: 'au_segment' });
  });
  Object.keys(CALL_PATHS).forEach((label) => {
    it('an Australian lead is NOT rung by ' + label, () => {
      const d = decide(CALL_PATHS[label]('au'), OFF);
      expect(d).toEqual({ action: 'skip', reason: 'au_segment' });
      expect(d).toEqual(decide(CALL_PATHS[label]('au'), ON));
    });
  });
  it('a lead with no country on file that would be dialled as Australian is refused too', () => {
    const noCountry = lead('au', { country: '', qualified: false, call_back_at: new Date(NOW - 5 * MIN).toISOString() }, { state: null });
    expect(decide(noCountry, OFF)).toEqual({ action: 'skip', reason: 'au_segment' });
    const byState = lead('au', { country: '', call_back_at: new Date(NOW - 5 * MIN).toISOString() }, { state: 'au' });
    expect(decide(byState, OFF)).toEqual({ action: 'skip', reason: 'au_segment' });
  });
  it('a UK-trained doctor on an Australian mobile is still an overseas lead and still rung', () => {
    const d = decide(lead('uk', {}, { phone: '+61 400 000 222' }), OFF);
    expect(d.action).toBe('call');
    expect(d.country).toBe('uk');
    expect(d.from).toBe('+442030000000');
  });
  it('the Leads tab says why, in the same words as with the switch on', () => {
    const plan = leadCalls.leadCallPlan(Object.assign({ row: lead('au'), nowMs: NOW, cfg: CFG }, OFF));
    expect(plan.state).toBe('blocked');
    expect(plan.reason).toBe('au_segment');
    expect(plan.label).toBe('Australian GP: Hazel does not ring Australian leads');
    expect(plan).toEqual(leadCalls.leadCallPlan(Object.assign({ row: lead('au'), nowMs: NOW, cfg: CFG }, ON)));
  });
  it('NEW ZEALAND is untouched: rung from the shared AU number on the Auckland clock, in both states', () => {
    [ON, OFF].forEach((sw) => {
      const d = leadCalls.leadCallDecision(Object.assign({ row: lead('nz'), nowMs: NOW, cfg: CFG }, sw));
      expect(d.action, JSON.stringify(d)).toBe('call');
      expect(d.country).toBe('nz');
      expect(d.from).toBe('+61280000000');
    });
  });
});

describe('Hazel: UK, Irish and New Zealand leads get the same answer in both switch states', () => {
  Object.keys(CALL_PATHS).forEach((label) => {
    it(label, () => {
      OVERSEAS.forEach((c) => {
        const row = CALL_PATHS[label](c);
        expect(decide(row, ON)).toEqual(decide(row, OFF));
        const planOn = leadCalls.leadCallPlan(Object.assign({ row, nowMs: NOW, cfg: CFG }, ON));
        const planOff = leadCalls.leadCallPlan(Object.assign({ row, nowMs: NOW, cfg: CFG }, OFF));
        expect(planOn).toEqual(planOff);
      });
    });
  });
  it('and so do the skips: stopped, paused, booked, not qualified, too old', () => {
    const variants = [
      (c) => lead(c, { stopped: 'do_not_call' }),
      (c) => lead(c, { calls_paused: true }),
      (c) => lead(c, { call_booked: true }),
      (c) => lead(c, { qualified: false }),
      (c) => lead(c, {}, { created_at: new Date(NOW - 10 * 86400000).toISOString() }),
      (c) => lead(c, {}, { status: 'converted' })
    ];
    variants.forEach((make) => OVERSEAS.forEach((c) => {
      expect(decide(make(c), ON)).toEqual(decide(make(c), OFF));
    }));
  });
});

// ── The chase sequence ───────────────────────────────────────────────────────
// Every not_booked and booked_no_signup step a lead can fall due for.
function nudgeCases(country) {
  const base = lead(country).metadata.consult;
  const sent = (seq, steps, agoMs) => steps.map((s) => ({ seq, step: s, sent_at: new Date(NOW - agoMs).toISOString(), email: 'sent' }));
  const bookedAt = new Date(NOW - 30 * 86400000).toISOString();
  const completedMs = NOW - 22 * 86400000;
  const booked = (steps) => Object.assign({}, base, {
    call_booked: true, call_booked_at: bookedAt, call_at: new Date(completedMs - 30 * MIN).toISOString(),
    call_completed_at: new Date(completedMs).toISOString(), call_attended: true,
    nudges: sent('booked_no_signup', steps, 2 * 86400000)
  });
  return [
    { label: 'the 5-minute note', input: { consult: base, createdAtMs: NOW - 6 * MIN, nowMs: NOW } },
    { label: 'the 1-hour note', input: { consult: Object.assign({}, base, { nudges: sent('not_booked', [0], 70 * MIN) }), createdAtMs: NOW - 75 * MIN, nowMs: NOW } },
    { label: 'the 24-hour note', input: { consult: Object.assign({}, base, { nudges: sent('not_booked', [0, 1], 20 * HOUR) }), createdAtMs: NOW - 25 * HOUR, nowMs: NOW } },
    { label: 'the booked-now-sign-up touch', input: { consult: booked([]), createdAtMs: NOW - 31 * 86400000, callAtMs: completedMs - 30 * MIN, callCompletedMs: completedMs, nowMs: NOW } },
    { label: 'the post-call touch', input: { consult: booked([0]), createdAtMs: NOW - 31 * 86400000, callAtMs: completedMs - 30 * MIN, callCompletedMs: completedMs, nowMs: NOW } },
    { label: 'the week-one drip', input: { consult: booked([0, 1]), createdAtMs: NOW - 31 * 86400000, callAtMs: completedMs - 30 * MIN, callCompletedMs: completedMs, nowMs: NOW } },
    { label: 'the week-two drip', input: { consult: booked([0, 1, 2]), createdAtMs: NOW - 31 * 86400000, callAtMs: completedMs - 30 * MIN, callCompletedMs: completedMs, nowMs: NOW } },
    { label: 'the week-three drip', input: { consult: booked([0, 1, 2, 3]), createdAtMs: NOW - 31 * 86400000, callAtMs: completedMs - 30 * MIN, callCompletedMs: completedMs, nowMs: NOW } }
  ];
}

describe('chase emails and WhatsApps (nextConsultNudge)', () => {
  it('sanity: every case really is due for an overseas lead', () => {
    nudgeCases('uk').forEach((c) => {
      expect(consultLead.nextConsultNudge(Object.assign({}, c.input, OFF)), c.label).not.toBe(null);
    });
  });
  // CHANGED in WP-16. Was "switch ON: an Australian lead is owed none of
  // them" (the interim hold), with no go-live instant in the picture. Now the
  // go-live rule decides: none before go-live or with no instant known; every
  // one of them after it, the same step a UK lead is owed.
  it('switch ON: an Australian lead from BEFORE go-live (or with no go-live instant known) is owed none of them', () => {
    nudgeCases('au').forEach((c) => {
      expect(consultLead.nextConsultNudge(Object.assign({}, c.input, ON)), c.label + ' (no instant)').toBe(null);
      expect(consultLead.nextConsultNudge(Object.assign({ auLiveFromMs: NOW + HOUR }, c.input, ON)), c.label + ' (before go-live)').toBe(null);
    });
  });
  it('switch ON: an Australian lead from AFTER go-live is owed every one of them, the same step as a UK lead', () => {
    const au = nudgeCases('au');
    const uk = nudgeCases('uk');
    au.forEach((c, i) => {
      const got = consultLead.nextConsultNudge(Object.assign({ auLiveFromMs: NOW - 400 * 86400000 }, c.input, ON));
      expect(got, c.label).not.toBe(null);
      expect(got, c.label).toEqual(consultLead.nextConsultNudge(Object.assign({}, uk[i].input, ON)));
    });
  });
  it('switch OFF: an Australian lead is owed exactly what a UK lead is', () => {
    const au = nudgeCases('au');
    const uk = nudgeCases('uk');
    au.forEach((c, i) => {
      const got = consultLead.nextConsultNudge(Object.assign({}, c.input, OFF));
      expect(got, c.label).not.toBe(null);
      expect(got).toEqual(consultLead.nextConsultNudge(Object.assign({}, uk[i].input, OFF)));
    });
  });
  it('UK, Irish and New Zealand leads are owed the same step in both switch states', () => {
    OVERSEAS.forEach((country) => nudgeCases(country).forEach((c) => {
      const on = consultLead.nextConsultNudge(Object.assign({}, c.input, ON));
      expect(on, country + ' ' + c.label).not.toBe(null);
      expect(on).toEqual(consultLead.nextConsultNudge(Object.assign({}, c.input, OFF)));
    }));
  });
  it('a lead left alone by the go-live rule has nothing written on it: the sequence is not marked finished', () => {
    const consult = lead('au').metadata.consult;
    expect(consultLead.isConsultExhausted(consult)).toBe(false);
  });
});

describe('WhatsApp legs still owed from an earlier step (pendingConsultWaKinds)', () => {
  // A 1-hour step on record whose WhatsApp never went (template pending).
  const owing = (country) => Object.assign({}, lead(country).metadata.consult, {
    nudges: [
      { seq: 'not_booked', step: 0, sent_at: new Date(NOW - 3 * HOUR).toISOString(), email: 'none' },
      { seq: 'not_booked', step: 1, sent_at: new Date(NOW - 2 * HOUR).toISOString(), email: 'sent' }
    ],
    wa: { hello_5m: { sent_at: new Date(NOW - 3 * HOUR).toISOString() } }
  });
  // CHANGED in WP-16. Was "switch ON: nothing is owed to an Australian lead"
  // unconditionally. Still nothing while no Australian template is approved
  // (the rule that never changed: an Australian message never goes out through
  // an overseas template); owed once the owner marks one approved.
  it('switch ON: nothing is owed to an Australian lead while no Australian template is approved; overseas leads unchanged', () => {
    expect(consultLead.pendingConsultWaKinds(owing('au'), NOW, ON)).toEqual([]);
    OVERSEAS.forEach((c) => expect(consultLead.pendingConsultWaKinds(owing(c), NOW, ON)).toEqual(['check_in_1h']));
    expect(consultLead.pendingConsultWaKinds(owing('au'), NOW, Object.assign({ env: { AU_WHATSAPP_APPROVED_TEMPLATES: 'lead_check_in_1h' } }, ON))).toEqual(['check_in_1h']);
  });
  it('switch OFF: an Australian lead is owed the leg, as before', () => {
    expect(consultLead.pendingConsultWaKinds(owing('au'), NOW, OFF)).toEqual(['check_in_1h']);
    OVERSEAS.forEach((c) => expect(consultLead.pendingConsultWaKinds(owing(c), NOW, OFF)).toEqual(['check_in_1h']));
  });
});

describe('the owner is still paged about an unbooked Australian lead (consultOwnerAlertDecision)', () => {
  it('fires 20 minutes after the hour even though the 1-hour note was never sent', () => {
    ['au'].concat(OVERSEAS).forEach((c) => {
      const consult = lead(c).metadata.consult; // nudges: [] — exactly what the hold leaves behind
      expect(consultLead.consultOwnerAlertDecision({ consult, createdAtMs: NOW - 85 * MIN, nowMs: NOW }))
        .toEqual({ action: 'send', replied: false });
      expect(consultLead.consultOwnerAlertDecision({ consult, createdAtMs: NOW - 70 * MIN, nowMs: NOW }))
        .toEqual({ action: 'skip', reason: 'not_yet' });
    });
  });
  it('the page carries the lead, and says Australia', () => {
    const s = consultLead.consultOwnerAlertSummary(lead('au', { country_raw: 'australia' }, { created_at: new Date(NOW - 85 * MIN).toISOString() }), { nowMs: NOW });
    expect(s.name).toBe('Dr Test Auvr');
    expect(s.phone).toBe('+61 400 000 111');
    expect(s.answers).toContain('Country: australia');
  });
});

describe('the no-show rescue messages (noShowRescueDecision)', () => {
  // Slots are relative to the rescue's own launch gate, which this suite must
  // not depend on the wall clock for.
  const base = Math.max(NOW, consultNoShow.CONSULT_NOSHOW_RESCUE_SINCE_MS + 10 * HOUR);
  const missed = (country) => {
    const callAt = new Date(base - 100 * MIN).toISOString();
    return lead(country, {
      call_booked: true, call_booked_at: new Date(base - 30 * HOUR).toISOString(), call_at: callAt,
      no_show: { call_at: callAt, detected_at: new Date(base - 60 * MIN).toISOString(), via: 'sweep', ring: 'pending' }
    });
  };
  // CHANGED in WP-16. Was "switch ON: an Australian lead gets neither the
  // email nor the WhatsApp", reason 'au_segment' (the interim hold). Now: not
  // rescued when the slot is from before go-live (or no instant is known);
  // after go-live the Australian email is due and the WhatsApp is a named
  // skip until an Australian template is approved.
  it('switch ON: a slot missed before go-live (or with no go-live instant known) gets neither', () => {
    expect(consultNoShow.noShowRescueDecision(Object.assign({ row: missed('au'), nowMs: base, hasPhone: true }, ON)))
      .toEqual({ email: false, wa: false, reason: 'au_before_go_live' });
    expect(consultNoShow.noShowRescueDecision(Object.assign({ row: missed('au'), nowMs: base, hasPhone: true, auLiveFromMs: base }, ON)))
      .toEqual({ email: false, wa: false, reason: 'au_before_go_live' });
  });
  // CHANGED DELIBERATELY BY WP-18 (walk-findings T4). Was "...the WhatsApp is
  // skipped by name (no approved Australian template)". The existing missed-call
  // template has been read and is neutral, so the WhatsApp is now due, through
  // that template. Switched off by the owner, it is the named skip again.
  it('switch ON: a slot missed after go-live gets the email and the WhatsApp (the existing missed-call template, confirmed neutral); switched off, the WhatsApp is skipped by name', () => {
    expect(consultNoShow.noShowRescueDecision(Object.assign({ row: missed('au'), nowMs: base, hasPhone: true, auLiveFromMs: base - 30 * 86400000, env: {} }, ON)))
      .toEqual({ email: true, wa: true, reason: 'due', au: true, waSkipped: '', waTemplateName: 'gp_link_consult_missed_call' });
    expect(consultNoShow.noShowRescueDecision(Object.assign({ row: missed('au'), nowMs: base, hasPhone: true, auLiveFromMs: base - 30 * 86400000, env: { AU_WHATSAPP_DISABLED_TEMPLATES: 'lead_call_missed' } }, ON)))
      .toEqual({ email: true, wa: false, reason: 'due', au: true, waSkipped: 'au_template_not_approved', waTemplateName: '' });
  });
  it('switch OFF: an Australian lead gets both, as before', () => {
    expect(consultNoShow.noShowRescueDecision(Object.assign({ row: missed('au'), nowMs: base, hasPhone: true }, OFF)))
      .toEqual({ email: true, wa: true, reason: 'due' });
  });
  it('UK, Irish and New Zealand leads get both in either state', () => {
    OVERSEAS.forEach((c) => {
      const on = consultNoShow.noShowRescueDecision(Object.assign({ row: missed(c), nowMs: base, hasPhone: true }, ON));
      expect(on).toEqual({ email: true, wa: true, reason: 'due' });
      expect(on).toEqual(consultNoShow.noShowRescueDecision(Object.assign({ row: missed(c), nowMs: base, hasPhone: true }, OFF)));
    });
  });
});

describe('the PEP waitlist only ever applies to GB, IE and NZ (isPepGatedCountry)', () => {
  it('accepts exactly the countries that have a cutoff date', () => {
    ['GB', 'IE', 'NZ', 'gb', ' nz '].forEach((c) => expect(docPipeline.isPepGatedCountry(c)).toBe(true));
    expect(Object.keys(docPipeline.PEP_DATE_CUTOFFS).sort()).toEqual(['GB', 'IE', 'NZ']);
  });
  it('refuses Australia, anything else, and anything unreadable', () => {
    ['AU', 'au', 'UK', 'US', 'ZA', '', null, undefined, 'constructor', 'toString'].forEach((c) => {
      expect(docPipeline.isPepGatedCountry(c), String(c)).toBe(false);
    });
  });
  it('a pre-2007 Australian fellowship is never classified PEP-eligible', () => {
    const r = docPipeline.classifyPepEligibility({ documentType: 'FRACGP certificate', expectedCountry: 'AU', verified: true, dateFound: '2001-05-01' });
    expect(r).toEqual({ pepEligible: false, pepMeta: null });
  });
});
