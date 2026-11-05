import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ctx = require('../lib/ads-context.js');

const NOW = Date.UTC(2026, 10, 2, 8, 0, 0);
const DAY = 86400000;
function at(daysAgo, hours) { return new Date(NOW - daysAgo * DAY + (hours || 0) * 3600000).toISOString(); }
function lead(id, over) {
  return Object.assign({
    id: id, email: id + '@example.test', created_at: at(3), status: 'new',
    metadata: { source: 'meta_lead_ad', fb_ad_id: '111', consult: { qualified: true, call_booked: false, nudges: [{ email: 'sent' }], wa: { hello_5m: { sent_at: at(3) } } } }
  }, over || {});
}

describe('enrichLeads', () => {
  it('keeps Meta leads only and joins Hazel calls by enquiry id and consults by email', () => {
    const leads = [
      lead('a', { metadata: { source: 'meta_lead_ad', fb_ad_id: '111', consult: { qualified: true, call_booked: true, call_booked_at: at(3, 0.1), owner_alert: true, nudges: [], wa: {} } } }),
      lead('b', { metadata: { source: 'site_start_form', consult: { qualified: true } } }),
      lead('c', { created_at: 'garbage' })
    ];
    const calls = [
      { enquiry_id: 'a', outcome: 'voicemail', started_at: at(3, 0.05) },
      { enquiry_id: 'a', outcome: 'booked', started_at: at(3, 3), duration_s: 140, sentiment: 'Positive', analysis: { custom_analysis_data: { objections: 'timing', lost_booking_reason: 'none', timeframe: '3-6 months', gp_status: 'gp' } } }
    ];
    const consults = [
      { invitee_email: 'A@example.test', status: 'completed', completed_at: at(1), created_at: at(3) },
      { invitee_email: 'a@example.test', status: 'completed', completed_at: at(40), created_at: at(40) } // an older enquiry, ignored
    ];
    const facts = ctx.enrichLeads({ leads, calls, consults, now: NOW });
    expect(facts).toHaveLength(1);
    const f = facts[0];
    expect(f.ad_id).toBe('111');
    expect(f.booked).toBe(true);
    expect(f.hours_to_book).toBe(0.1);
    expect(f.attended).toBe(true);
    expect(f.owner_paged).toBe(true);
    expect(f.hazel).toMatchObject({ attempts: 2, spoke: true, final: 'booked', booked_on_call: true, objections: 'timing', lost_reason: null, timeframe: '3-6 months', gp_status: 'gp', sentiment: 'Positive' });
    expect(f.hazel.outcomes).toEqual(['voicemail', 'booked']);
  });
  it('treats "none"/"n/a" analysis values as absent and tolerates non-object metadata', () => {
    const calls = [{ enquiry_id: 'x', outcome: 'unclear', started_at: at(1), analysis: { custom_analysis_data: { objections: 'N/A', timeframe: '' } } }];
    const facts = ctx.enrichLeads({ leads: [lead('x', { metadata: { source: 'meta_lead_ad', consult: 'oops' } })], calls, now: NOW });
    expect(facts[0].hazel.objections).toBeNull();
    expect(facts[0].hazel.spoke).toBe(true);
    expect(facts[0].ad_id).toBeNull();
  });
});

describe('funnelFor and summariseEcosystem', () => {
  const leads = [
    lead('a', { metadata: { source: 'meta_lead_ad', fb_ad_id: '111', consult: { qualified: true, call_booked: true, call_booked_at: at(3, 0.05), nudges: [], wa: {} } } }),
    lead('b', { created_at: at(2), status: 'converted', metadata: { source: 'meta_lead_ad', fb_ad_id: '111', consult: { qualified: true, call_booked: true, call_booked_at: at(2, 2), stopped: 'signed_up', nudges: [], wa: {} } } }),
    lead('c', { created_at: at(20), metadata: { source: 'meta_lead_ad', fb_ad_id: '222', consult: { qualified: true, replied_at: at(19), stopped: 'replied', nudges: [{ email: 'sent' }], wa: { hello_5m: { sent_at: at(20) } } } } }),
    lead('d', { created_at: at(45), metadata: { source: 'meta_lead_ad', fb_ad_id: '222', consult: { qualified: true, nudges: [], wa: {} } } })
  ];
  const calls = [
    { enquiry_id: 'a', outcome: 'booked', started_at: at(3), duration_s: 100, analysis: { custom_analysis_data: { objections: 'money' } } },
    { enquiry_id: 'c', outcome: 'voicemail', started_at: at(20), duration_s: 20 },
    { enquiry_id: 'c', outcome: 'no_answer', started_at: at(19), duration_s: 0 }
  ];
  const consults = [
    { invitee_email: 'a@example.test', status: 'completed', completed_at: at(1), created_at: at(3), meeting_summary: '## Quick recap\n\nThe meeting was between GP and Dr. Jane Roe about moving in 2027.\n\n## Next steps\nx' },
    { invitee_email: 'b@example.test', status: 'booked', created_at: at(1) }
  ];
  const facts = ctx.enrichLeads({ leads, calls, consults, now: NOW });

  it('buckets leads into 7 and 30 day windows with rates and cost per booking', () => {
    const f30 = ctx.funnelFor(facts, NOW - 30 * DAY, NOW + DAY);
    expect(f30.totals).toMatchObject({ leads: 3, qualified: 3, hazel_called: 2, hazel_spoke: 1, booked: 2, attended: 1, signed_up: 1 });
    expect(f30.by_ad['111'].booked).toBe(2);
    expect(f30.by_ad['222'].leads).toBe(1);
    expect(f30.median_hours_to_book).toBeCloseTo(1.05, 1); // (0.1 h + 2 h) / 2
    expect(f30.booked_within_10min_pct).toBe(50);
    const rated = ctx.withRates(f30.totals, 300);
    expect(rated.booking_rate_pct).toBe(67);
    expect(rated.cost_per_booking).toBe(150);
    expect(rated.cost_per_attended).toBe(300);
    expect(ctx.withRates(f30.totals, 0).cost_per_booking).toBeNull();
  });
  it('summarises Hazel, the chase, the voice of the lead, consult themes and demand', () => {
    const e = ctx.summariseEcosystem({ leadFacts: facts, calls, consults, now: NOW, spend30: 300, spend7: 100,
      roles: [{ is_active: true, location_state: 'qld', regional: true, mixed_billing: true }, { is_active: true, location_state: 'vic', metro: true, billing_model: 'private' }, { is_active: false, location_state: 'nsw' }],
      posts: [{ status: 'posted', publish_at: at(2) }, { status: 'approved', publish_at: at(-3) }] });
    expect(e.automation.length).toBeGreaterThan(3);
    expect(e.hazel).toMatchObject({ calls_30d: 3, spoke_30d: 1, voicemail_30d: 1, no_answer_30d: 1, booked_on_call_30d: 1, median_duration_s: 60 });
    expect(e.nudges).toMatchObject({ leads_30d: 3, with_whatsapp: 1, with_email: 1, replied: 1 });
    expect(e.funnel_30d.cost_per_booking).toBe(150);
    expect(e.funnel_7d.booked).toBe(2);
    expect(e.voice_of_lead.objections).toEqual([{ value: 'money', count: 1 }]);
    expect(e.consult_themes).toHaveLength(1);
    expect(e.gp_questions).toMatchObject({ consults: 1, since: at(1).slice(0, 10), window_days: 365 });
    expect(e.consult_themes[0].recap).toMatch(/the doctor/);
    expect(e.consult_themes[0].recap).not.toMatch(/Jane/);
    expect(e.consult_themes[0].recap).not.toMatch(/Next steps/);
    expect(e.demand).toMatchObject({ open_roles: 2, regional_pct: 50, mixed_or_private_billing: 2 });
    expect(e.demand.by_state[0]).toEqual({ value: 'QLD', count: 1 });
    expect(e.organic).toEqual({ posted_last_7d: 1, scheduled_next_7d: 1 });
    expect(e.by_ad_30d['111'].signed_up).toBe(1);
    const deep = ctx.deepFunnelForAd(e, '111', { spend: 100 }, { spend: 300 });
    expect(deep.d30.cost_per_booking).toBe(150);
    expect(deep.d7.booked).toBe(2);
  });
  it('anonymises names, emails and phone numbers', () => {
    expect(ctx.anonymise('Dr. Sam Taylor rang 07700 900123 from sam.taylor@x.com; Dr Lee too', 'sam.taylor@x.com'))
      .toBe('the doctor rang [number] from [email]; the doctor too');
  });
});

describe('consultQuestions: what GPs ask about across every consultation', () => {
  const NOTES_A = '## Quick recap\n\nIntro.\n\n## Next steps\n### Jane\n- [Send CV](https://tasks.zoom.us/x)\n\n## Summary\n### GP Income and Visa Structure\nJane asked about the 482 visa and whether her husband could work. GP clarified that GPs are paid on billings with a service fee of around 30%.\n\n### Jane\'s Move Timeline\nJane wanted to know how long AHPRA registration takes and said she hopes to move in 2027.';
  const NOTES_B = '## Summary\n### DPA and Visa Requirements Discussion\nGP explained that overseas GPs must work in Distribution Priority Areas near the cities. Dr. Tom Brown inquired about Perth and the Gold Coast.\n\n### Consultation Lengths\nGP clarified that GPs choose their consultation length and schedule.';
  const consults = [
    { invitee_email: 'jane.roe@example.test', completed_at: '2026-11-01T10:00:00.000Z', meeting_summary: NOTES_A },
    { invitee_email: 'tom.brown@example.test', scheduled_at: '2026-08-02T10:00:00.000Z', meeting_summary: NOTES_B },
    { invitee_email: 'old@example.test', completed_at: '2024-01-01T10:00:00.000Z', meeting_summary: NOTES_B },
    { invitee_email: 'nothing@example.test', completed_at: '2026-10-01T10:00:00.000Z' }
  ];
  const q = ctx.consultQuestions(consults, Date.parse('2026-11-05T00:00:00Z'));

  it('counts every consultation with notes inside the window, once per theme, most common first', () => {
    expect(q.consults).toBe(2); // the 2024 one is outside the year, the fourth has no notes
    expect(q.since).toBe('2026-08-02');
    const by = {}; q.themes.forEach((t) => { by[t.key] = t; });
    expect(by.visa).toMatchObject({ label: 'Visa and permanent residency', consults: 2, share_pct: 100 });
    expect(by.location.consults).toBe(1); // "relocation" and "Move Timeline" are not a location
    expect(by.income.consults).toBe(1);
    expect(by.registration.consults).toBe(1);
    expect(by.family.consults).toBe(1);
    expect(by.practice.consults).toBe(1);
    expect(by.timeline.consults).toBe(1);
    expect(by.english).toBeUndefined();
    expect(q.themes[0].consults).toBeGreaterThanOrEqual(q.themes[q.themes.length - 1].consults);
    expect(q.themes.every((t) => t.consults > 0)).toBe(true);
  });

  it('keeps the substance anonymised, names the speakers, drops the Zoom task links and the next steps', () => {
    const text = JSON.stringify(q);
    expect(text).not.toMatch(/Jane|Tom|Brown|example\.test|tasks\.zoom/);
    expect(text).not.toContain('Send CV');
    const by = {}; q.themes.forEach((t) => { by[t.key] = t; });
    expect(by.visa.headings).toEqual(['GP Income and Visa Structure', 'DPA and Visa Requirements Discussion']);
    expect(by.visa.examples[0]).toBe('the doctor asked about the 482 visa and whether her husband could work.');
    expect(by.income.examples[0]).toBe('GP Link clarified that GPs are paid on billings with a service fee of around 30%.'); // on-theme, not the first question in the block
    expect(by.practice.examples[0]).toBe('GP Link clarified that GPs choose their consultation length and schedule.');
    expect(by.visa.mentions).toBe(2);
    // Names come from the notes themselves, not only the invitee's address.
    expect(ctx.participantNames('## Quick recap\nThe meeting was between GP and Firdous Ahmed.\n## Next steps\n### Firdous\n- x\n### GP\n- y\n## Summary\n### Hamza\'s Australia Relocation Plans\nText.')).toEqual(['firdous', 'ahmed', 'hamza']);
    const named = ctx.consultQuestions([{ invitee_email: 'xx@example.test', completed_at: '2026-11-01T00:00:00Z', meeting_summary: '## Next steps\n### Firdous\n- x\n## Summary\n### Firdous\'s Visa Options\nFirdous asked about the 482 visa.' }], Date.parse('2026-11-05T00:00:00Z'));
    expect(JSON.stringify(named)).not.toMatch(/Firdous/);
    expect(named.themes[0].headings[0]).toBe("the doctor's Visa Options");
    expect(q.questions.map((x) => x.said)).toEqual([
      'the doctor asked about the 482 visa and whether her husband could work.',
      'the doctor wanted to know how long AHPRA registration takes and said she hopes to move in 2027.',
      'the doctor inquired about Perth and the Gold Coast.'
    ]);
    expect(q.questions[0].when).toBe('2026-11-01');
    expect(q.note).toMatch(/"GP Link" is the consultant/);
  });

  it('copes with nothing, and with notes that have no Summary section', () => {
    expect(ctx.consultQuestions([], 0)).toMatchObject({ consults: 0, since: null, themes: [], questions: [] });
    expect(ctx.consultQuestions(null, 0).consults).toBe(0);
    const bare = ctx.consultQuestions([{ invitee_email: 'x@y.test', completed_at: '2026-11-01T00:00:00Z', meeting_summary: 'Dr Ann Lee asked whether the OET is required.' }], Date.parse('2026-11-05T00:00:00Z'));
    expect(bare.themes.map((t) => t.key)).toEqual(['english']);
    expect(bare.questions[0].said).toBe('the doctor asked whether the OET is required.');
    expect(ctx.GP_THEMES.length).toBeGreaterThan(10);
  });
});

// 2026-11-06: DPA is not rural. The metro/regional booleans on career_roles
// default to false and are not maintained, so the setting of a role comes
// from the Modified Monash code, the nearest city and the location label.
describe('roleSetting and demand settings', () => {
  it('classifies from the flags only when true, else MMM, nearest city and label', () => {
    const rs = ctx.roleSetting;
    expect(rs({ metro: true })).toBe('outer_metro');
    expect(rs({ regional: true })).toBe('regional_town');
    expect(rs({ metro: false, regional: false, mmm: 'MM1', nearest_city: 'Melbourne', location_city: 'Werribee' })).toBe('outer_metro');
    expect(rs({ mmm: 'MM2', nearest_city: 'Brisbane' })).toBe('regional_city');
    expect(rs({ mmm: 'MM5' })).toBe('regional_town');
    expect(rs({ metro: false, regional: false, nearest_city: 'Brisbane', location_label: 'Ipswich and Greater Brisbane Corridor, QLD' })).toBe('outer_metro');
    expect(rs({ metro: false, regional: false, nearest_city: 'Perth', location_label: 'Perth, WA', location_city: 'Joondalup' })).toBe('outer_metro');
    expect(rs({ metro: false, regional: false, nearest_city: 'Perth', location_label: 'South West Region, WA', location_city: 'Bunbury' })).toBe('regional_city');
    expect(rs({ metro: false, regional: false, nearest_city: 'Newcastle', location_label: 'Hunter Valley Region, NSW' })).toBe('regional_city');
    expect(rs({ metro: false, regional: false, location_label: 'Pilbara Region, WA', location_city: 'Karratha' })).toBe('regional_town');
    expect(rs({ metro: false, regional: false })).toBe('unknown');
  });
  it('demandSummary reports the mix with examples and never calls false/false "regional"', () => {
    const roles = [
      { is_active: true, location_state: 'WA', metro: false, regional: false, nearest_city: 'Perth', location_label: 'Perth, WA', location_city: 'Joondalup' },
      { is_active: true, location_state: 'VIC', metro: false, regional: false, nearest_city: 'Melbourne', location_label: 'Melbourne West Growth Corridor, VIC', location_city: 'Werribee' },
      { is_active: true, location_state: 'QLD', metro: false, regional: false, nearest_city: 'Brisbane', location_label: 'Darling Downs Region, QLD', location_city: 'Toowoomba' },
      { is_active: true, location_state: 'WA', metro: false, regional: false, location_label: 'Pilbara Region, WA', location_city: 'Karratha' },
      { is_active: true, location_state: 'NSW', metro: false, regional: false },
      { is_active: false, location_state: 'NSW', metro: false, regional: false, location_city: 'Dubbo' }
    ];
    const d = ctx.demandSummary(roles);
    expect(d.open_roles).toBe(5);
    expect(d.settings).toEqual({ outer_metro: 2, regional_city: 1, regional_town: 1, unknown: 1 });
    expect(d.regional_pct).toBe(50);
    expect(d.where_examples.outer_metro).toEqual(['Joondalup (Perth)', 'Werribee (Melbourne)']);
    expect(d.where_examples.regional_city).toEqual(['Toowoomba, QLD']);
    expect(d.where_examples.regional_town).toEqual(['Karratha, WA']);
    expect(d.note).toMatch(/DPA .* not rural/);
    expect(ctx.demandSummary([{ is_active: true, metro: false, regional: false }]).regional_pct).toBeNull();
  });
});
