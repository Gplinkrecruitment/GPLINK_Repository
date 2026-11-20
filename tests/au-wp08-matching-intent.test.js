// WP-08 of the Australian GP build: AI matching inputs and prompts, the
// match-reason sanitiser, and the intent score. Pure (no server).
//
// The two fixtures were generated from the code AS IT WAS BEFORE WP-08 (commit
// 5e0ac8b9), by running the unchanged modules:
//   tests/fixtures/au-wp08-overseas-match-prompt.json   every byte sent to the
//       model for two overseas doctors and two jobs, both directions
//   tests/fixtures/au-wp08-intent-overseas-baseline.json  144 overseas inputs
//       and the score, band and signals each produced
// They are the proof that an overseas doctor's prompt and score did not move.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const match = require('../lib/ai-candidate-job-match.js');
const intent = require('../lib/ats-intent.js');
const re = require('../lib/role-eligibility.js');

const promptFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/au-wp08-overseas-match-prompt.json'), 'utf8'));
const intentFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/au-wp08-intent-overseas-baseline.json'), 'utf8'));

function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: Object.keys(init.headers).sort() });
    return { ok: true, json: async () => ({ content: [{ text: reply || '{"ranked":[]}' }] }) };
  };
  return { calls, fetchImpl };
}

const AU_GP = {
  id: 'gp-au-1', name: 'Dr Test Auvr', qualificationCountry: 'AU', preferredCity: 'Sydney',
  targetArrivalDate: '2027-03', whoMoving: 'Partner and children', childrenCount: '2',
  handoverSummary: 'A vocationally registered GP working in western Sydney.',
  au: {
    pathway: 'au_vr', segment: 'A', vr: true, registrar: false, supervised: false, registrationFlag: true, dpaRestricted: false,
    currentSuburb: 'Parramatta', currentState: 'NSW', commuteRadiusKm: 30, preferredLocations: ['Sydney', 'Regional NSW'],
    sessionsWanted: 8, availableFrom: '2027-01-15', noticePeriodWeeks: 4, earliestStart: '2027-01-15',
    specialInterests: ['Skin cancer medicine'], billingPreference: 'mixed', distanceKmByJob: { 11: 3 }
  }
};
const AU_JOB_EXTRA = { suburb: 'Parramatta', billing_model: 'Mixed Billing', mmm: 'MM1', vr_requirement: 'vr_required', sessions_min: 6, sessions_max: 10, special_interests: ['Skin cancer medicine'], engagement_type: 'permanent', dpa_status: 'no' };

describe('the overseas prompt is byte-identical to before WP-08', () => {
  it('the system prompt has not changed by a character', () => {
    expect(match.AI_MATCH_SYSTEM_PROMPT).toBe(promptFixture.systemPrompt);
  });

  it('candidates-for-a-job and jobs-for-a-doctor send exactly the same request as before', async () => {
    const r = recorder();
    await match.aiRankCandidatesForJob(promptFixture.jobs[0], promptFixture.gps, { apiKey: 'k', model: 'm', fetchImpl: r.fetchImpl });
    await match.aiRankJobsForGp(promptFixture.gps[0], promptFixture.jobs, { apiKey: 'k', model: 'm', fetchImpl: r.fetchImpl });
    expect(JSON.stringify(r.calls)).toBe(JSON.stringify(promptFixture.captured));
  });

  it('still identical when the job carries the new role fields and the request also holds an Australian doctor', async () => {
    const r = recorder();
    const jobWithFields = Object.assign({}, promptFixture.jobs[0], AU_JOB_EXTRA);
    await match.aiRankCandidatesForJob(jobWithFields, promptFixture.gps.concat([AU_GP]), { apiKey: 'k', model: 'm', fetchImpl: r.fetchImpl });
    expect(r.calls.length).toBe(2);
    // call 1: the overseas doctors, exactly the snapshot
    expect(JSON.stringify(r.calls[0])).toBe(JSON.stringify(promptFixture.captured[0]));
    // call 2: the Australian doctor, alone, on the Australian prompt
    expect(r.calls[1].body.system[0].text).toBe(match.AI_MATCH_SYSTEM_PROMPT_AU);
    expect(r.calls[1].body.messages[0].content).toContain('gp-au-1');
    expect(r.calls[1].body.messages[0].content).not.toContain('gp-1"');
  });
});

describe('the Australian prompt: the right inputs, and none of the overseas ones', () => {
  async function auRequest(direction) {
    const r = recorder();
    const job = Object.assign({}, promptFixture.jobs[0], AU_JOB_EXTRA);
    if (direction === 'jobs') await match.aiRankJobsForGp(AU_GP, [job, Object.assign({}, promptFixture.jobs[1], { vr_requirement: 'vr_preferred', accepts_supervised: true, dpa_status: 'yes', billing_model: 'bulk', mmm: 'MM3' })], { apiKey: 'k', model: 'm', fetchImpl: r.fetchImpl });
    else await match.aiRankCandidatesForJob(job, [AU_GP], { apiKey: 'k', model: 'm', fetchImpl: r.fetchImpl });
    expect(r.calls.length).toBe(1);
    return r.calls[0].body;
  }

  for (const direction of ['jobs', 'candidates']) {
    it(direction + ': pathway facts, suburb, commute, sessions, availability, interests, billing model', async () => {
      const body = await auRequest(direction);
      const user = body.messages[0].content;
      expect(body.system[0].text).toBe(match.AI_MATCH_SYSTEM_PROMPT_AU);
      for (const key of ['vocationally_registered', 'gp_registrar', 'needs_supervision', 'registration_flag_on_file', 'limited_to_dpa_roles',
        'current_suburb', 'current_state', 'commute_radius_km', 'preferred_locations', 'sessions_wanted', 'available_from',
        'notice_period_weeks', 'earliest_start', 'special_interests', 'billing_preference',
        'billing_model', 'vr_requirement', 'accepts_registrars', 'accepts_supervised', 'sessions_min', 'sessions_max', 'in_dpa', 'mmm', 'area', 'distance_km']) {
        expect(user, key).toContain('"' + key + '"');
      }
      expect(user).toContain('"current_suburb": "Parramatta"');
      expect(user).toContain('"earliest_start": "2027-01-15"');
      expect(user).toContain('"billing_model": "mixed"');
      expect(user).toContain('"registration_flag_on_file": true');
      // ...and nothing about arriving, who is moving, a visa pathway or where they trained
      for (const gone of ['target_arrival_date', 'who_moving', 'children_count', 'qualification_country', 'visa_pathway_aligned', '2027-03', 'Partner and children']) {
        expect(user, gone).not.toContain(gone);
      }
      expect(user).not.toMatch(/visa|overseas|relocat|arriv/i);
    });
  }

  it('the Australian system prompt allows the billing model and forbids figures; it names no banned word', () => {
    const p = match.AI_MATCH_SYSTEM_PROMPT_AU;
    expect(p).toMatch(/bulk billing, mixed billing or private billing/);
    expect(p).toMatch(/NEVER mention a dollar figure, a percentage/);
    expect(p).not.toMatch(/who is moving|visa|country of training|family circumstances/i);
    expect(re.AU_FORBIDDEN_WORDS.test(p)).toBe(false);
    expect(p).not.toBe(match.AI_MATCH_SYSTEM_PROMPT);
  });

  it('a condition is only ever a flag: its text is not an input', () => {
    const shaped = JSON.stringify(Object.assign({}, AU_GP, { au: Object.assign({}, AU_GP.au, { conditionsText: 'SECRET CONDITION TEXT' }) }));
    expect(shaped).toContain('SECRET CONDITION TEXT');
    return (async () => {
      const r = recorder();
      const gp = Object.assign({}, AU_GP, { au: Object.assign({}, AU_GP.au, { conditionsText: 'SECRET CONDITION TEXT', conditions_text: 'SECRET CONDITION TEXT' }) });
      await match.aiRankJobsForGp(gp, [promptFixture.jobs[0]], { apiKey: 'k', model: 'm', fetchImpl: r.fetchImpl });
      expect(JSON.stringify(r.calls)).not.toContain('SECRET CONDITION TEXT');
    })();
  });
});

describe('match-reason sanitiser (owner decision 9, COM-24)', () => {
  const GOOD = [
    'The practice is mixed billing, which is what you said you prefer.',
    'It is a bulk-billing practice ten minutes from Parramatta.',
    'Private billing, and they want your skin cancer experience.',
    'You could start in mid January, which suits their timeline.',
    'Eight sessions a week is inside the range they offer.'
  ];
  const BAD = [
    'You would earn $350,000 a year.',
    'They offer 70% of billings.',
    'The split is 70 per cent.',
    'A 65 percent share of billings.',
    'Income around 300k.',
    'Typically 350 k for full time.',
    'A 70/30 split.',
    'A strong salary package.',
    'The remuneration is generous.',
    'Good earning potential.',
    'Your registration condition is accepted here.',
    'They can work with your undertaking.',
    'It is a DPA so the 19AB moratorium is not a problem.',
    'Visa sponsorship is available.',
    'Relocation support is included.',
    'Open to overseas doctors.'
  ];

  it('keeps reasons that only name the billing model; drops any figure, percentage, flag or banned word', () => {
    expect(match.sanitiseAuMatchReasons(GOOD)).toEqual(GOOD);
    BAD.forEach((r) => expect(match.sanitiseAuMatchReasons([r]), r).toEqual([]));
    expect(match.sanitiseAuMatchReasons(GOOD.concat(BAD))).toEqual(GOOD);
    expect(match.sanitiseAuMatchReasons(['  spaced  ', '', null, 7])).toEqual(['spaced']);
    expect(match.sanitiseAuMatchReasons(null)).toEqual([]);
  });

  it('the Australian branch parses with that sanitiser; the overseas branch keeps today\'s no-money rule exactly', () => {
    const raw = JSON.stringify({ ranked: [{ id: 'x', score: 80, reasons: ['It is a mixed billing practice near you.', 'You would earn $300k.', 'Close to the beach.'] }] });
    expect(match.parseMatchRanking(raw, { mode: 'au' }).ranked[0].reasons).toEqual(['It is a mixed billing practice near you.', 'Close to the beach.']);
    // overseas: "billing" itself is still banned, as it always was
    expect(match.parseMatchRanking(raw).ranked[0].reasons).toEqual(['Close to the beach.']);
    expect(match.parseMatchRanking(raw, undefined).ranked[0].reasons).toEqual(['Close to the beach.']);
  });

  it('end to end: an Australian ranking reply is sanitised; an overseas one is filtered as before', async () => {
    const reply = JSON.stringify({ ranked: [{ id: '11', score: 90, reasons: ['Mixed billing, as you prefer.', 'About 75% of billings.', 'Three kilometres from home.'] }] });
    const au = recorder(reply);
    const auOut = await match.aiRankJobsForGp(AU_GP, [promptFixture.jobs[0]], { apiKey: 'k', model: 'm', fetchImpl: au.fetchImpl });
    expect(auOut.ranked[0].reasons).toEqual(['Mixed billing, as you prefer.', 'Three kilometres from home.']);
    const os = recorder(reply);
    const osOut = await match.aiRankJobsForGp(promptFixture.gps[0], [promptFixture.jobs[0]], { apiKey: 'k', model: 'm', fetchImpl: os.fetchImpl });
    expect(osOut.ranked[0].reasons).toEqual(['Three kilometres from home.']);
  });
});

describe('intent score: overseas scores are numerically identical to before WP-08', () => {
  it('all 144 overseas inputs give the same score, band and signals', () => {
    expect(intentFixture.rows.length).toBe(144);
    intentFixture.rows.forEach((row) => {
      expect(intent.computeIntent(row.input), 'row ' + row.n).toEqual(row.output);
    });
  });

  it('anything that is not exactly the Australian model is the overseas calculation', () => {
    const row = intentFixture.rows[57];
    for (const model of [undefined, null, '', 'overseas', 'AU', 'au ', true, 1]) {
      const input = Object.assign({}, row.input, { pathwayModel: model, ahpraVerified: true, ahpraOnFile: true });
      expect(intent.computeIntent(input), JSON.stringify(model)).toEqual(row.output);
    }
    expect(intent.INTENT_WEIGHTS).toEqual([18, 18, 16, 14, 14, 10, 10]);
  });
});

describe('intent score: the Australian model (ADM-25, DAT-17)', () => {
  // A fully engaged doctor who is already registered in Australia: verified on
  // the register, CV + cover letter + ID on file (no degree is ever asked for),
  // last in the app three weeks ago.
  const base = { commsEngagementVal: 1, onboardingCompleted: true, docs: { cv: true, coverLetter: true, idDoc: true }, regStageIndex: 0, regStageMax: 6, callsCompleted: 2, callsMissed: 0, lastActiveDays: 21, bestAtsStage: 'interview' };

  it('the same doctor scored on the overseas model loses 18 points for the stage and the degree (the defect)', () => {
    const overseas = intent.computeIntent(base);
    const pts = (label) => overseas.signals.filter((s) => s.label === label)[0].points;
    expect(pts('Registration progress')).toBe(0);                       // 14 lost
    expect(pts('Documents (CV, cover letter, ID, degree)')).toBe(12);   // 4 lost
    const au = intent.computeIntent(Object.assign({}, base, { pathwayModel: 'au', ahpraVerified: true, ahpraOnFile: true }));
    const auPts = (label) => au.signals.filter((s) => s.label === label)[0].points;
    expect(auPts('Ahpra registration checked')).toBe(14);
    expect(auPts('Documents (CV, cover letter, ID)')).toBe(16);
    expect(auPts('Recent app activity')).toBe(10);                      // 21 days is recent for them
    expect(pts('Recent app activity')).toBe(3);
    expect(au.score - overseas.score).toBe(14 + 4 + 7);
    expect(au.score).toBe(97);
    expect(au.band).toBe('Hot');
  });

  it('the registration signal follows the Ahpra check, not an overseas stage', () => {
    const score = (extra) => intent.computeIntent(Object.assign({}, base, { pathwayModel: 'au' }, extra)).signals.filter((s) => s.label === 'Ahpra registration checked')[0];
    expect(score({ ahpraVerified: true, ahpraOnFile: true }).v).toBe(1);
    expect(score({ ahpraVerified: false, ahpraOnFile: true }).v).toBe(0.5);
    expect(score({}).v).toBe(0);
    // an overseas stage index is ignored for them, in both directions
    expect(score({ ahpraVerified: true, regStageIndex: 0 }).v).toBe(1);
    expect(score({ regStageIndex: 6 }).v).toBe(0);
    // a blocked case still costs something
    expect(score({ ahpraVerified: true, blockedDays: 30 }).v).toBeCloseTo(0.6, 5);
  });

  it('the shape is the same seven weighted signals, and the withdrawal penalty still applies', () => {
    const au = intent.computeIntent(Object.assign({}, base, { pathwayModel: 'au', ahpraVerified: true, withdrawnCount: 3 }));
    expect(au.signals.slice(0, 7).map((s) => s.w)).toEqual([18, 18, 16, 14, 14, 10, 10]);
    expect(au.signals[7]).toMatchObject({ label: 'Withdrawn applications', points: -14 });
    expect(au.score).toBe(97 - 14);
    const cold = intent.computeIntent({ pathwayModel: 'au', lastActiveDays: 200 });
    expect(cold.band).toBe('Cold');
    expect(cold.signals.filter((s) => s.label === 'Recent app activity')[0].v).toBe(0.1);
    for (const [days, v] of [[28, 1], [29, 0.6], [56, 0.6], [57, 0.3], [120, 0.3], [121, 0.1]]) {
      expect(intent.computeIntent({ pathwayModel: 'au', lastActiveDays: days }).signals[5].v, String(days)).toBe(v);
    }
  });
});
