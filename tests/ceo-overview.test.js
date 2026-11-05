// CEO dashboard Overview ("E", 2026-11-05):
//   unit  — lib/ceo-overview.js buildOverview() over a fixed clock + fixtures
//   route — GET /api/ceo/overview and POST /api/ceo/leads/:id/callback-done
//           against the REAL server + an in-memory PostgREST emulator
//           (harness copied from tests/account-export.test.js, matcher
//           extended with gte/lte/order; super-admin cookie as in
//           tests/ceo-leads-endpoint.test.js).
// Every lead carries ip + user_agent in metadata, exactly as the capture
// paths write them, so the privacy assertion has something real to catch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import ceoOverview from '../lib/ceo-overview.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-ceo-overview-${RUN_ID}.json`;
const SUPER_HOST = 'ats-test.local';
const TZ = 'Australia/Sydney';
// Fri 6 Nov 2026 09:30 in Sydney (AEDT, UTC+11).
const NOW = '2026-11-05T22:30:00.000Z';
const NOW_MS = Date.parse(NOW);
const PRIVATE_IP = '203.0.113.77';
const PRIVATE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) SecretAgent/1.0';

// ── Fixtures ────────────────────────────────────────────────────────────────
function lead(o) {
  return {
    id: o.id, created_at: o.created_at, kind: o.kind || 'gp', name: o.name, email: o.email || null,
    phone: o.phone || null, state: o.state || 'uk', status: o.status || 'new',
    metadata: { source: o.source || 'site_start_form', ip: PRIVATE_IP, user_agent: PRIVATE_UA, consult: o.consult || {} }
  };
}
const L = {
  priya: lead({ id: 'se-priya', created_at: '2026-11-05T20:00:00.000Z', name: 'Dr Priya Nair', email: 'priya.nair@example.com', phone: '+447700900101', source: 'meta_lead_ad', consult: { qualified: true } }),
  tomas: lead({ id: 'se-tomas', created_at: '2026-11-05T18:00:00.000Z', name: 'Dr Tomas Weber', email: 'tomas.weber@example.com', phone: '+447700900102', source: 'meta_lead_ad',
    consult: { qualified: true, ai_call: { call_id: '', status: 'failed', outcome: 'failed', attempt: 1, error: 'retell 402 Insufficient credit', account_error: true } } }),
  amara: lead({ id: 'se-amara', created_at: '2026-11-04T01:00:00.000Z', name: 'Dr Amara Okafor', email: 'amara.okafor@example.com', phone: '+447700900103',
    consult: { qualified: true, booked_via: 'hazel', call_booked_at: '2026-11-04T01:30:00.000Z', call_at: '2026-11-06T01:00:00.000Z',
      ai_call: { call_id: 'c1', status: 'ended', outcome: 'booked', duration_s: 300 }, ai_calls: [{ call_id: 'c1', status: 'ended', outcome: 'booked', duration_s: 300 }] } }),
  liam: lead({ id: 'se-liam', created_at: '2026-11-01T03:00:00.000Z', name: 'Dr Liam Chen', email: 'liam.chen@example.com', phone: '+447700900104', source: 'meta_lead_ad',
    consult: { qualified: true, ai_call: { call_id: 'c2', status: 'ended', outcome: 'voicemail', duration_s: 20 }, ai_calls: [{ call_id: 'c2', status: 'ended', outcome: 'voicemail', duration_s: 20 }] } }),
  sofia: lead({ id: 'se-sofia', created_at: '2026-10-31T05:00:00.000Z', name: 'Dr Sofia Rossi', email: 'sofia.rossi@example.com', source: 'calendly_direct',
    consult: { call_booked_at: '2026-10-31T05:10:00.000Z', call_completed_at: '2026-11-02T03:00:00.000Z' } }),
  hannah: lead({ id: 'se-hannah', created_at: '2026-11-03T08:00:00.000Z', name: 'Dr Hannah Park', email: 'hannah.park@example.com', phone: '+447700900106', source: 'zoho_import',
    consult: { stopped: 'replied', call_back_by: 'whatsapp_reply', call_back_at: '2026-11-04T09:00:00.000Z',
      call_back_note: 'Replied "Yes please call me Tuesday" to our WhatsApp', zoho_wa_reply: 'Yes please call me Tuesday', zoho_wa_replied_at: '2026-11-04T09:00:00.000Z' } }),
  omar: lead({ id: 'se-omar', created_at: '2026-10-20T00:00:00.000Z', name: 'Dr Omar Haddad', email: 'omar.haddad@example.com', phone: '+447700900107',
    consult: { call_booked_at: '2026-10-21T00:00:00.000Z', ai_call: { call_id: 'c5', status: 'ended', outcome: 'callback_requested', duration_s: 90 }, ai_calls: [{ call_id: 'c5', status: 'ended', outcome: 'callback_requested', duration_s: 90 }] } }),
  mei: lead({ id: 'se-mei', created_at: '2026-11-05T10:00:00.000Z', name: 'Dr Mei Lin', email: 'mei.lin@example.com', consult: { stopped: 'signed_up' } }),
  noah: lead({ id: 'se-noah', created_at: '2026-11-02T00:00:00.000Z', name: 'Dr Noah Fischer', email: 'noah.fischer@example.com', phone: '+447700900110',
    consult: { call_back_by: 'ceo', call_back_note: 'Asked about visa timing', replied_at: '2026-11-03T00:00:00.000Z', call_back_done_at: '2026-11-03T01:00:00.000Z' } }),
  practice: lead({ id: 'se-practice', created_at: '2026-11-05T12:00:00.000Z', kind: 'practice', name: 'Harbour Medical', email: 'admin@harbourmedical.example' })
};
const SITE_ENQUIRIES = Object.values(L);

const LEAD_CALLS = [
  { id: 'lc1', call_id: 'c1', enquiry_id: 'se-amara', direction: 'outbound', status: 'ended', outcome: 'booked', disconnection_reason: 'user_hangup', started_at: '2026-11-04T01:05:00.000Z', duration_s: 300, cost_cents: 85, created_at: '2026-11-04T01:05:00.000Z' },
  { id: 'lc2', call_id: 'c2', enquiry_id: 'se-liam', direction: 'outbound', status: 'ended', outcome: 'voicemail', disconnection_reason: 'voicemail_reached', started_at: '2026-11-01T03:10:00.000Z', duration_s: 20, cost_cents: 10, created_at: '2026-11-01T03:10:00.000Z' },
  { id: 'lc3', call_id: 'c3', enquiry_id: 'se-tomas', direction: 'outbound', status: 'error', outcome: 'failed', disconnection_reason: 'credit_exhausted', started_at: '2026-11-05T18:05:00.000Z', duration_s: 0, cost_cents: 0, created_at: '2026-11-05T18:05:00.000Z' },
  { id: 'lc4', call_id: 'c4', enquiry_id: null, direction: 'inbound', status: 'ended', outcome: 'unclear', disconnection_reason: 'user_hangup', started_at: '2026-11-05T19:00:00.000Z', duration_s: 60, cost_cents: 20, created_at: '2026-11-05T19:00:00.000Z' },
  { id: 'lc5', call_id: 'c5', enquiry_id: 'se-omar', direction: 'outbound', status: 'ended', outcome: 'callback_requested', disconnection_reason: 'agent_hangup', started_at: '2026-10-20T01:00:00.000Z', duration_s: 90, cost_cents: 30, created_at: '2026-10-20T01:00:00.000Z' }
];

const SCHEDULED_CALLS = [
  { id: 'sc1', invitee_email: 'amara.okafor@example.com', scheduled_at: '2026-11-06T01:00:00.000Z', booked_at: '2026-11-04T01:30:00.000Z', completed_at: null, no_show_at: null, cancelled_at: null, status: 'booked', meeting_kind: 'consultation', host_kind: 'ceo', zoom_join_url: 'https://zoom.example/j/111', created_at: '2026-11-04T01:30:00.000Z' },
  { id: 'sc2', invitee_email: 'sofia.rossi@example.com', scheduled_at: '2026-11-02T03:00:00.000Z', booked_at: '2026-10-31T05:10:00.000Z', completed_at: '2026-11-02T03:40:00.000Z', no_show_at: null, cancelled_at: null, status: 'completed', meeting_kind: 'consultation', host_kind: 'ceo', zoom_join_url: 'https://zoom.example/j/222', created_at: '2026-10-31T05:10:00.000Z' },
  { id: 'sc3', invitee_email: 'ben.carter@example.com', scheduled_at: '2026-11-09T23:00:00.000Z', booked_at: '2026-11-05T15:00:00.000Z', completed_at: null, no_show_at: null, cancelled_at: null, status: 'booked', meeting_kind: 'consultation', host_kind: null, zoom_join_url: 'https://zoom.example/j/333', created_at: '2026-11-05T15:00:00.000Z' },
  { id: 'sc4', invitee_email: 'cancelled.person@example.com', scheduled_at: '2026-11-07T01:00:00.000Z', booked_at: '2026-11-05T01:00:00.000Z', completed_at: null, no_show_at: null, cancelled_at: '2026-11-05T02:00:00.000Z', status: 'cancelled', meeting_kind: 'consultation', host_kind: 'ceo', zoom_join_url: '', created_at: '2026-11-05T01:00:00.000Z' },
  { id: 'sc5', invitee_email: 'interviewee@example.com', scheduled_at: '2026-11-07T03:00:00.000Z', booked_at: '2026-11-05T03:00:00.000Z', completed_at: null, no_show_at: null, cancelled_at: null, status: 'booked', meeting_kind: 'interview', host_kind: 'practice', zoom_join_url: '', created_at: '2026-11-05T03:00:00.000Z' },
  { id: 'sc6', invitee_email: 'dana.k@example.com', scheduled_at: '2026-11-03T00:00:00.000Z', booked_at: '2026-11-01T00:00:00.000Z', completed_at: null, no_show_at: '2026-11-03T00:30:00.000Z', cancelled_at: null, status: 'no_show', meeting_kind: 'consultation', host_kind: 'ceo', zoom_join_url: '', created_at: '2026-11-01T00:00:00.000Z' }
];

const PROFILES = [
  { user_id: 'u-ben', first_name: 'Ben', last_name: 'Carter', email: 'ben.carter@example.com', created_at: '2026-11-03T00:00:00.000Z', onboarding_completed_at: null, account_status: 'active' },
  { user_id: 'u-isla', first_name: 'Isla', last_name: 'Murphy', email: 'isla.murphy@example.com', created_at: '2026-11-05T01:00:00.000Z', onboarding_completed_at: '2026-11-05T02:00:00.000Z', account_status: 'active' },
  { user_id: 'u-ravi', first_name: 'Ravi', last_name: 'Patel', email: 'ravi.patel@example.com', created_at: '2026-10-01T00:00:00.000Z', onboarding_completed_at: '2026-10-15T00:00:00.000Z', account_status: 'active' },
  { user_id: 'u-old', first_name: 'Old', last_name: 'Account', email: 'old@example.com', created_at: '2026-11-04T00:00:00.000Z', onboarding_completed_at: null, account_status: 'archived' },
  { user_id: 'u-grace', first_name: 'Grace', last_name: 'Nwosu', email: 'grace.nwosu@example.com', created_at: '2026-09-01T00:00:00.000Z', onboarding_completed_at: null, account_status: 'active' },
  { user_id: 'u-ethan', first_name: 'Ethan', last_name: 'Walsh', email: 'ethan.walsh@example.com', created_at: '2026-08-01T00:00:00.000Z', onboarding_completed_at: '2026-08-10T00:00:00.000Z', account_status: 'active' }
];
const CASES = [
  { id: 'case-ravi', user_id: 'u-ravi', stage: 'ahpra', status: 'active' },
  { id: 'case-ethan', user_id: 'u-ethan', stage: 'visa', status: 'active' },
  { id: 'case-grace', user_id: 'u-grace', stage: 'amc', status: 'closed' },
  { id: 'case-isla', user_id: 'u-isla', stage: 'myintealth', status: 'active' }
];
const TASKS = [
  { id: 't-esc-1', case_id: 'case-ravi', title: 'AHPRA form rejected', escalated_reason: 'Needs certified translation', escalated_at: '2026-11-04T00:00:00.000Z', status: 'escalated' },
  { id: 't-open-1', case_id: 'case-ravi', title: 'Upload passport', escalated_reason: null, escalated_at: null, status: 'open' }
];
const DOCS = [
  { id: 'd1', status: 'uploaded', created_at: '2026-11-05T00:00:00.000Z' },
  { id: 'd2', status: 'under_review', created_at: '2026-10-20T00:00:00.000Z' },
  { id: 'd3', status: 'approved', created_at: '2026-11-05T00:00:00.000Z' }
];
// Documents waiting on a human = open doc_review / flagged_doc tasks (the review queue's definition).
const DOC_TASKS = [
  { id: 't-doc-1', case_id: 'case-ravi', title: 'Medical degree', task_type: 'doc_review', related_document_key: 'medical_degree', status: 'open', created_at: '2026-11-05T00:00:00.000Z' },
  { id: 't-doc-2', case_id: 'case-ravi', title: 'Passport', task_type: 'flagged_doc', related_document_key: 'passport', status: 'open', created_at: '2026-10-20T00:00:00.000Z' }
];
const ROLES = [
  { id: 'r1', job_status: 'open', is_active: true },
  { id: 'r2', job_status: 'open', is_active: false },
  { id: 'r3', job_status: 'closed', is_active: true }
];
const PRACTICES = [{ id: 'pr1', is_active: true }, { id: 'pr2', is_active: false }];
const PLACEMENTS = [
  { id: 'pl1', practice_name: 'Coastal Family Practice', location: 'Wollongong NSW', start_date: '2027-01-11', status: 'active', placed_at: '2026-11-03T00:00:00.000Z', created_at: '2026-11-03T00:00:00.000Z' },
  { id: 'pl2', practice_name: 'Riverbend Clinic', location: 'Dubbo NSW', start_date: '2026-10-01', status: 'ended', placed_at: '2026-09-01T00:00:00.000Z', created_at: '2026-09-01T00:00:00.000Z' }
];
const CONTRACTS = [
  { id: 'k1', user_id: 'u-ethan', status: 'sent', contract_filename: 'ethan-contract.pdf', ai_review: { overall: 'major_discrepancies', summary: 'Billing split is 60% in the contract but 65% was discussed in the interview.' }, sent_to_gp_at: '2026-11-04T00:00:00.000Z', created_at: '2026-11-04T00:00:00.000Z' },
  { id: 'k2', user_id: 'u-ravi', status: 'sent', contract_filename: 'ravi-contract.pdf', ai_review: { overall: 'aligned', summary: 'All good.' }, sent_to_gp_at: '2026-11-01T00:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' },
  { id: 'k3', user_id: 'u-grace', status: 'signed', contract_filename: 'grace-contract.pdf', ai_review: { overall: 'major_discrepancies', summary: 'Old.' }, sent_to_gp_at: '2026-10-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }
];
const TODOS = [
  { id: 'e1', sender_email: 'notifications@ahpra.example', subject: 'Registration decision — action required', ai_urgency: 'urgent', ai_summary: 'AHPRA asks for a certified translation within 14 days.', matched_user_id: 'u-ravi', created_at: '2026-11-05T06:00:00.000Z', resolved_at: null },
  { id: 'e2', sender_email: 'hello@example.com', subject: 'Quick question', ai_urgency: 'low', ai_summary: 'Asks about leave.', matched_user_id: null, created_at: '2026-11-05T07:00:00.000Z', resolved_at: null },
  { id: 'e3', sender_email: 'notifications@ahpra.example', subject: 'Done already', ai_urgency: 'urgent', ai_summary: 'Resolved.', matched_user_id: null, created_at: '2026-11-04T06:00:00.000Z', resolved_at: '2026-11-04T07:00:00.000Z' }
];
const SNAPSHOT_ROW = {
  id: 'rv-snap', review_date: '2026-11-06', kind: 'snapshot', error: null, created_at: '2026-11-05T20:00:00.000Z', review: {},
  snapshot: {
    fetched_at: '2026-11-05T20:00:00.000Z', live_ads: 0,
    adsets: [
      { id: 'as1', name: 'UK GPs — broad', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: 40, learning: { status: null, last_edit_at: '2026-11-03T06:00:00.000Z' } },
      { id: 'as2', name: 'IE GPs', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: 20, learning: { status: null, last_edit_at: '2026-11-02T06:00:00.000Z' } }
    ],
    totals: {
      last_7d: { spend: 210.5, leads: 7, cost_per_lead: 30.07, reach: 9000, frequency: 1.4, link_clicks: 120, click_to_lead_pct: 5.8 },
      last_30d: { spend: 900, leads: 30, cost_per_lead: 30, reach: 30000, frequency: 2.1, link_clicks: 500, click_to_lead_pct: 6 },
      prior_7d: { spend: 250, leads: 9, cost_per_lead: 27.8, reach: 9500, frequency: 1.3, link_clicks: 140, click_to_lead_pct: 6.4 },
      yesterday: { spend: 38, leads: 0, cost_per_lead: null, reach: 1200, frequency: 1.1, link_clicks: 15, click_to_lead_pct: 0 }
    },
    funnel: { d7: { booked: 2, signed_up: 1, cost_per_booking: 105.25 }, d30: { booked: 5, signed_up: 3, cost_per_booking: 180 } }
  }
};
const REVIEW_ROW = {
  id: 'rv-daily', review_date: '2026-11-06', kind: 'daily', error: null, created_at: '2026-11-05T21:00:00.000Z', snapshot: null,
  review: { headline: 'Relaunch the IE set first; it carried the week before the pause', summary: 'The IE ad set had the lowest cost per lead all week. ' + 'x'.repeat(700),
    actions_today: [{ where: 'adset', action: 'Relaunch IE GPs at $20/day', why: 'Lowest cost per lead this month' }] }
};
const DRAFTS = [
  { id: 'dr1', status: 'ready', headline: 'Your UK training counts in Australia', angle: 'recognition', launch_at: null, image_path: 'drafts/dr1.png', photo_path: null, created_at: '2026-11-05T10:00:00.000Z' },
  { id: 'dr2', status: 'draft', headline: 'Sunshine and a shorter commute', angle: 'lifestyle', launch_at: null, image_path: null, photo_path: null, created_at: '2026-11-04T10:00:00.000Z' },
  { id: 'dr3', status: 'launched', headline: 'Already live', angle: 'pay', launch_at: '2026-11-01T00:00:00.000Z', image_path: 'drafts/dr3.png', photo_path: null, created_at: '2026-11-01T00:00:00.000Z' },
  { id: 'dr4', status: 'scheduled', headline: 'Earn more, work less', angle: 'pay', launch_at: '2026-11-08T00:00:00.000Z', image_path: null, photo_path: 'photos/dr4.jpg', created_at: '2026-11-03T10:00:00.000Z' }
];

function unitInput(over) {
  return Object.assign({
    site_enquiries: SITE_ENQUIRIES, lead_calls: LEAD_CALLS, scheduled_calls: SCHEDULED_CALLS, user_profiles: PROFILES,
    registration_cases: CASES, registration_tasks: TASKS, user_documents: DOCS, doc_review_tasks: DOC_TASKS, career_roles: ROLES, practices: PRACTICES,
    placements: PLACEMENTS, career_contracts: CONTRACTS, incoming_email_todos: TODOS,
    snapshot: SNAPSHOT_ROW, review: REVIEW_ROW, ad_drafts: DRAFTS,
    nowMs: NOW_MS, window: '7d', tz: TZ,
    hazelStatus: { enabled: true, configured: true, last_run: null },
    noContactOutcomes: ['voicemail', 'no_answer', 'failed'], metaConfigured: true
  }, over || {});
}
function briefText(brief) { return brief.segments.map((s) => s.t).join(''); }

// ── Unit: buildOverview ─────────────────────────────────────────────────────
describe('lib/ceo-overview buildOverview (unit)', () => {
  const out = ceoOverview.buildOverview(unitInput());

  it('localDayKey uses the calendar day in the given zone', () => {
    expect(ceoOverview.localDayKey(new Date(NOW), TZ)).toBe('2026-11-06');
    expect(ceoOverview.localDayKey(new Date(NOW), 'Europe/London')).toBe('2026-11-05');
  });

  it('top-level shape', () => {
    expect(out.ok).toBe(true);
    expect(out.window).toBe('7d');
    expect(out.tz).toBe(TZ);
    expect(out.now).toBe(NOW);
    expect(Object.keys(out.status).sort()).toEqual(['consults', 'hayley', 'meta', 'registration']);
    for (const k of ['brief', 'funnel', 'needs', 'doctors', 'series', 'tiles']) expect(out).toHaveProperty(k);
  });

  it('funnel counts the 7-day cohort (no Zoho imports, no practice rows)', () => {
    const f = out.funnel;
    expect(f.leads).toBe(7);
    expect(f.leads_meta).toBe(3);
    expect(f.leads_direct).toBe(1);
    expect(f.leads_site).toBe(3);
    expect(f.hayley_rung).toBe(3);
    expect(f.hayley_spoke).toBe(1);
    expect(f.booked).toBe(2);
    expect(f.attended).toBe(1);
    expect(f.consults_held).toBe(1);
    expect(f.accounts).toBe(2);
    expect(f.onboarded_30d).toBe(2);
    expect(f.placed).toBe(1);
    expect(f.placements_active).toBe(1);
    expect(f.open_jobs).toBe(1);
    expect(f.spend).toBe(210.5);
    expect(f.cpl).toBe(30.07);
    expect(f.cost_per_booking).toBe(105.25);
  });

  it('people lists carry id/name/sub and the right rows', () => {
    const p = out.funnel.people;
    expect(p.leads.map((r) => r.id).sort()).toEqual(['se-amara', 'se-liam', 'se-mei', 'se-noah', 'se-priya', 'se-sofia', 'se-tomas']);
    expect(p.leads[0]).toMatchObject({ kind: 'lead', id: 'se-priya', name: 'Dr Priya Nair', phone: '+447700900101' });
    expect(p.leads[0].sub).toBe('Today · Meta lead · Hayley: not rung');
    expect(p.leads.find((r) => r.id === 'se-liam').sub).toBe('Sun 1 Nov · Meta lead · Hayley: voicemail');
    expect(p.spoke.map((r) => r.id)).toEqual(['se-amara']);
    expect(p.booked.map((r) => r.id).sort()).toEqual(['se-amara', 'se-sofia']);
    const amara = p.booked.find((r) => r.id === 'se-amara');
    expect(amara.sub).toBe('Fri 6 Nov 12:00 · Hayley booked');
    expect(amara.zoom_join_url).toBe('https://zoom.example/j/111');
    expect(p.attended).toEqual([{ kind: 'lead', id: 'se-sofia', name: 'Dr Sofia Rossi', sub: 'Attended 2 Nov', phone: '' }]);
    expect(p.accounts.map((r) => r.id)).toEqual(['u-isla', 'u-ben']);
    expect(p.accounts[1]).toMatchObject({ kind: 'user', id: 'u-ben', name: 'Ben Carter', sub: 'Tue 3 Nov · onboarding not finished · Signed up only' });
    expect(p.accounts[0].sub).toBe('Thu 5 Nov · onboarded · MyIntealth');
  });

  it('Hayley is red when Retell credit ran out after the last call', () => {
    const h = out.status.hayley;
    expect(h.state).toBe('red');
    expect(h.headline).toBe('Out of Retell credit since Fri 6 Nov 05:05');
    expect(h.calls).toBe(3);
    expect(h.spoke).toBe(1);
    expect(h.booked).toBe(1);
    expect(h.voicemail).toBe(1);
    expect(h.callbacks).toBe(0);
    expect(h.mins).toBe(5.3);
    expect(h.cost).toBe(0.95);
    expect(h.calls_24h).toBe(1);
    expect(h.last_call_at).toBe('2026-11-04T01:05:00.000Z');
    expect(h.credit_exhausted_at).toBe('2026-11-05T18:05:00.000Z');
    expect(h.not_rung.map((r) => r.id).sort()).toEqual(['se-noah', 'se-priya', 'se-tomas']);
    expect(h.not_rung.find((r) => r.id === 'se-tomas').error).toBe('retell 402 Insufficient credit');
    expect(briefText(out.brief)).toContain(', then Retell credit ran out at 05:05 on Fri 6 Nov');
  });

  it('Hayley state ladder: grey / amber off / amber quiet / green', () => {
    const grey = ceoOverview.buildOverview(unitInput({ hazelStatus: { enabled: true, configured: false } }));
    expect(grey.status.hayley.state).toBe('grey');
    const off = ceoOverview.buildOverview(unitInput({ hazelStatus: { enabled: false, configured: true } }));
    expect(off.status.hayley.state).toBe('amber');
    expect(off.status.hayley.headline).toBe('Switched off (LEAD_CALLS_ENABLED)');
    expect(briefText(off.brief)).toContain('because the dialler is switched off');
    const quiet = ceoOverview.buildOverview(unitInput({ lead_calls: LEAD_CALLS.filter((c) => c.id !== 'lc3' && c.id !== 'lc4') }));
    expect(quiet.status.hayley.state).toBe('amber');
    expect(quiet.status.hayley.headline).toBe('No calls in 24 h');
    const green = ceoOverview.buildOverview(unitInput({ lead_calls: LEAD_CALLS.filter((c) => c.id !== 'lc3').concat([
      { id: 'lc9', direction: 'outbound', status: 'ended', outcome: 'no_answer', started_at: '2026-11-05T21:00:00.000Z', duration_s: 0, cost_cents: 5, created_at: '2026-11-05T21:00:00.000Z' }]) }));
    expect(green.status.hayley.state).toBe('green');
    expect(green.status.hayley.headline).toBe('1 call today · 1 booked this week');
  });

  it('Meta is red with no live ads, and the brief says so', () => {
    const m = out.status.meta;
    expect(m.state).toBe('red');
    expect(m.live_ads).toBe(0);
    expect(m.paused_since).toBe('2026-11-03T06:00:00.000Z');
    expect(m.headline).toBe('0 ads live · paused since 3 Nov');
    expect(m.detail).toBe('Yesterday $38 for 0 leads. Review: Relaunch the IE set first; it carried the week before the pause');
    expect(m.adsets).toEqual([
      { name: 'UK GPs — broad', status: 'PAUSED', daily_budget: 40, last_edit_at: '2026-11-03T06:00:00.000Z' },
      { name: 'IE GPs', status: 'PAUSED', daily_budget: 20, last_edit_at: '2026-11-02T06:00:00.000Z' }
    ]);
    expect(m.totals.last_7d).toEqual({ spend: 210.5, leads: 7, cost_per_lead: 30.07, reach: 9000, frequency: 1.4, link_clicks: 120, click_to_lead_pct: 5.8 });
    expect(m.totals.yesterday.spend).toBe(38);
    expect(m.funnel7).toEqual({ booked: 2, signed_up: 1, cost_per_booking: 105.25 });
    expect(m.funnel30.cost_per_booking).toBe(180);
    expect(m.review.date).toBe('2026-11-05T21:00:00.000Z');
    expect(m.review.summary.length).toBeLessThanOrEqual(600);
    expect(m.review.actions_today).toEqual([{ where: 'adset', action: 'Relaunch IE GPs at $20/day', why: 'Lowest cost per lead this month' }]);
    expect(m.drafts.map((d) => d.id)).toEqual(['dr1', 'dr2', 'dr4']);
    expect(m.drafts.map((d) => d.has_image)).toEqual([true, false, true]);
    expect(m.drafts_ready).toBe(2);
    const text = briefText(out.brief);
    expect(text).toContain('No ads are running: every ad set has been paused since Tue 3 Nov, and yesterday\'s $38 bought no leads before it stopped.');
    expect(out.brief.segments.find((s) => s.t === 'No ads are running').k).toBe('bad');
  });

  it('Meta state ladder: grey without token or snapshot, amber when stale, green otherwise', () => {
    expect(ceoOverview.buildOverview(unitInput({ metaConfigured: false })).status.meta.state).toBe('grey');
    expect(ceoOverview.buildOverview(unitInput({ snapshot: null })).status.meta.state).toBe('grey');
    expect(briefText(ceoOverview.buildOverview(unitInput({ snapshot: null })).brief)).toContain('Meta is not connected.');
    const liveSnap = JSON.parse(JSON.stringify(SNAPSHOT_ROW)); liveSnap.snapshot.live_ads = 3;
    const green = ceoOverview.buildOverview(unitInput({ snapshot: liveSnap }));
    expect(green.status.meta.state).toBe('green');
    expect(green.status.meta.headline).toBe('3 ads live · $211 this week');
    expect(briefText(green.brief)).toContain('Ads spent $38 yesterday for 0 leads.');
    const stale = JSON.parse(JSON.stringify(liveSnap)); stale.snapshot.fetched_at = '2026-11-03T00:00:00.000Z';
    const amber = ceoOverview.buildOverview(unitInput({ snapshot: stale }));
    expect(amber.status.meta.state).toBe('amber');
    expect(amber.status.meta.headline).toMatch(/^3 ads live · numbers \d+ h old$/);
  });

  it('brief reads as four sentences with bold runs', () => {
    const text = briefText(out.brief);
    expect(out.brief.date_label).toBe('Friday 6 November');
    expect(text.startsWith('Since yesterday: 3 new leads (Dr Priya Nair, Dr Tomas Weber, Meta lead) and 1 Hayley call, then Retell credit ran out at 05:05 on Fri 6 Nov.')).toBe(true);
    expect(text).toContain(' 1 consult booked and 0 attended since yesterday, none missed.');
    expect(text).toContain(' This week: 7 leads, 2 booked, 1 attended, 2 new app accounts on $211 of spend — but both engines that feed it are off right now.');
    expect(out.brief.segments.find((s) => s.t === '3 new leads').k).toBe('b');
    expect(out.brief.segments.find((s) => s.t.startsWith('7 leads, 2 booked')).k).toBe('good');
    const noCalls = ceoOverview.buildOverview(unitInput({ lead_calls: LEAD_CALLS.filter((c) => c.id === 'lc1') }));
    expect(noCalls.brief.segments.find((s) => s.t === '0 Hayley calls').k).toBe('bad');
    expect(briefText(ceoOverview.buildOverview(unitInput({ scheduled_calls: [] })).brief)).toContain('No consults were booked or held since yesterday.');
  });

  it('consults: upcoming/today/next with names resolved from leads, profiles, then the email', () => {
    const c = out.status.consults;
    expect(c.upcoming.map((u) => u.id)).toEqual(['sc1', 'sc3']);
    expect(c.upcoming[0]).toEqual({ id: 'sc1', lead_id: 'se-amara', name: 'Dr Amara Okafor', email: 'amara.okafor@example.com', at: '2026-11-06T01:00:00.000Z', source: 'Hayley booked', zoom_join_url: 'https://zoom.example/j/111' });
    expect(c.upcoming[1].name).toBe('Ben Carter');
    expect(c.upcoming[1].source).toBe('Calendly direct');
    expect(c.today.map((u) => u.id)).toEqual(['sc1']);
    expect(c.next.id).toBe('sc1');
    expect(c.booked_window).toBe(4);
    expect(c.held_window).toBe(1);
    expect(c.no_show_window).toBe(1);
    expect(c.headline).toBe('1 consult today · 4 booked this week');
    expect(c.detail).toBe('1 held, 1 missed. Next: Dr Amara Okafor, Fri 6 Nov 12:00');
  });

  it('registration: urgent email makes it red; escalations, docs and stage counts', () => {
    const r = out.status.registration;
    expect(r.state).toBe('red');
    expect(r.headline).toBe('1 AHPRA/regulator email · 1 escalation');
    expect(r.escalated).toBe(1);
    expect(r.escalations).toHaveLength(1);
    expect(r.escalations[0]).toMatchObject({ task_id: 't-esc-1', case_id: 'case-ravi', title: 'AHPRA form rejected', reason: 'Needs certified translation', at: '2026-11-04T00:00:00.000Z', origin: { kind: 'task', url: '' } });
    expect(r.docs_list.map((t) => t.task_id)).toEqual(['t-doc-1', 't-doc-2']);
    expect(r.docs_list[0]).toMatchObject({ case_id: 'case-ravi', title: 'Medical degree' });
    expect(typeof r.urgent[0].gmail_url).toBe('string');
    expect(r.docs_to_review).toBe(2);
    expect(r.docs_7d).toBe(1);
    expect(r.urgent).toMatchObject([{ id: 'e1', who: 'Ravi Patel', subject: 'Registration decision — action required', summary: 'AHPRA asks for a certified translation within 14 days.', created_at: '2026-11-05T06:00:00.000Z', user_id: 'u-ravi' }]);
    expect(r.cases).toEqual({ active: 3, by_stage: [['MyIntealth', 1], ['AMC', 0], ['Secure Placement', 0], ['AHPRA', 1], ['PBS & Medicare', 1], ['Commencement', 0]] });
    const calm = ceoOverview.buildOverview(unitInput({ incoming_email_todos: [], registration_tasks: [], user_documents: [], doc_review_tasks: [] }));
    expect(calm.status.registration.state).toBe('green');
    expect(calm.status.registration.headline).toBe('All clear');
    const amber = ceoOverview.buildOverview(unitInput({ incoming_email_todos: [] }));
    expect(amber.status.registration.state).toBe('amber');
    expect(amber.status.registration.headline).toBe('1 escalation · 2 docs to review');
  });

  it('needs: replies pull the quoted text; done call-backs drop out; flagged contracts', () => {
    const n = out.needs;
    expect(n.replies).toMatchObject([{
      id: 'se-hannah', name: 'Dr Hannah Park', phone: '+447700900106', quote: 'Yes please call me Tuesday',
      when: '2026-11-04T09:00:00.000Z', booked_at: '', call_at: '', has_account: false, not_gp_hint: false
    }]);
    expect(ceoOverview.quoteOf('Replied "I am a nurse, not a GP" to our WhatsApp')).toBe('I am a nurse, not a GP');
    expect(ceoOverview.quoteOf('Asked about visa timing')).toBe('Asked about visa timing');
    expect(n.contracts).toMatchObject([{ id: 'k1', who: 'Ethan Walsh', status: 'sent', sent_to_gp_at: '2026-11-04T00:00:00.000Z', summary: 'Billing split is 60% in the contract but 65% was discussed in the interview.' }]);
    expect(n.escalations).toEqual(out.status.registration.escalations);
    const hint = JSON.parse(JSON.stringify(L.hannah));
    hint.metadata.consult.call_back_note = 'Replied "I am a healthcare assistant" to our WhatsApp';
    hint.metadata.consult.stopped = 'signed_up';
    const h = ceoOverview.buildOverview(unitInput({ site_enquiries: [hint] })).needs.replies[0];
    expect(h.not_gp_hint).toBe(true);
    expect(h.has_account).toBe(true);
  });

  it('doctors & placements', () => {
    const d = out.doctors;
    expect(d).toMatchObject({ accounts_window: 2, accounts_total: 5, onboarded_30d: 2, incomplete: 2, open_jobs: 1, practices: 1, placements_active: 1, placements_window: 1, docs_to_review: 2, docs_7d: 1 });
    expect(d.incomplete_ids).toEqual(['u-ben', 'u-grace']);
    expect(d.latest_placement).toEqual({ practice_name: 'Coastal Family Practice', location: 'Wollongong NSW', start_date: '2027-01-11' });
    expect(d.recent.map((p) => p.user_id)).toEqual(['u-isla', 'u-ben', 'u-ravi', 'u-grace', 'u-ethan']);
    expect(d.recent[2]).toMatchObject({ user_id: 'u-ravi', name: 'Ravi Patel', created_at: '2026-10-01T00:00:00.000Z', onboarded: true, stage: 'AHPRA' });
    expect(d.recent[4].stage).toBe('PBS & Medicare');
  });

  it('series: 14 local days ending today, labels and per-day counts', () => {
    const s = out.series;
    expect(s.days).toHaveLength(14);
    expect(s.leads).toHaveLength(14);
    expect(s.booked).toHaveLength(14);
    expect(s.signups).toHaveLength(14);
    expect(s.days[0]).toBe('24 Oct');
    expect(s.days[8]).toBe('1 Nov');
    expect(s.days[13]).toBe('6');
    expect(s.leads[13]).toBe(2);
    expect(s.leads.reduce((a, b) => a + b, 0)).toBe(7);
    expect(s.signups.reduce((a, b) => a + b, 0)).toBe(2);
    expect(s.booked.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('tiles', () => {
    expect(out.tiles).toEqual({ cost_per_booking: 105.25, cost_per_booking_30d: 300, hayley: { calls: 3, spoke: 1, booked: 1, mins: 5.3, cost: 0.95 } });
  });

  it('30d window widens the cohort, the brief stays on the week', () => {
    const w = ceoOverview.buildOverview(unitInput({ window: '30d' }));
    expect(w.window).toBe('30d');
    expect(w.funnel.leads).toBe(8);
    expect(w.funnel.booked).toBe(3);
    expect(w.funnel.spend).toBe(900);
    expect(w.status.hayley.calls).toBe(4);
    expect(w.status.hayley.callbacks).toBe(1);
    expect(briefText(w.brief)).toContain('This week: 7 leads, 2 booked');
    expect(ceoOverview.buildOverview(unitInput({ window: 'bogus' })).window).toBe('7d');
  });

  it('never leaks ip or user_agent from lead metadata', () => {
    const json = JSON.stringify(out);
    expect(json).not.toContain(PRIVATE_IP);
    expect(json).not.toContain(PRIVATE_UA);
    expect(json).not.toMatch(/"ip"\s*:/);
    expect(json).not.toMatch(/"user_agent"\s*:/);
  });

  it('survives empty input', () => {
    const empty = ceoOverview.buildOverview({ nowMs: NOW_MS, tz: TZ, window: '7d' });
    expect(empty.ok).toBe(true);
    expect(empty.funnel.leads).toBe(0);
    expect(empty.status.meta.state).toBe('grey');
    expect(empty.status.hayley.state).toBe('grey');
    expect(empty.status.registration.state).toBe('green');
    expect(empty.series.days).toHaveLength(14);
    expect(briefText(empty.brief)).toContain('0 new leads');
  });
});

// ── Route: real server + PostgREST emulator ─────────────────────────────────
let server, port, sbServer, sbPort, realFetch;
// What the Zoom stub lists under users/me/meetings?type=upcoming (set per test).
let zoomUpcoming = [];
const db = {
  site_enquiries: JSON.parse(JSON.stringify(SITE_ENQUIRIES)),
  lead_calls: JSON.parse(JSON.stringify(LEAD_CALLS)),
  scheduled_calls: JSON.parse(JSON.stringify(SCHEDULED_CALLS)),
  user_profiles: JSON.parse(JSON.stringify(PROFILES)),
  registration_cases: JSON.parse(JSON.stringify(CASES)),
  registration_tasks: JSON.parse(JSON.stringify(TASKS.concat(DOC_TASKS))),
  user_documents: JSON.parse(JSON.stringify(DOCS)),
  career_roles: JSON.parse(JSON.stringify(ROLES)),
  practices: JSON.parse(JSON.stringify(PRACTICES)),
  placements: JSON.parse(JSON.stringify(PLACEMENTS)),
  career_contracts: JSON.parse(JSON.stringify(CONTRACTS)),
  incoming_email_todos: JSON.parse(JSON.stringify(TODOS)),
  // Newest first is what the real table returns; a manual review without a
  // snapshot sits on top so the route has to look past it.
  ad_reviews: [
    { id: 'rv-manual', review_date: '2026-11-06', kind: 'manual', error: null, created_at: '2026-11-05T21:30:00.000Z', snapshot: null, review: { headline: 'Manual note', summary: 'n/a', actions_today: [] } },
    JSON.parse(JSON.stringify(REVIEW_ROW)),
    JSON.parse(JSON.stringify(SNAPSHOT_ROW))
  ],
  ad_drafts: JSON.parse(JSON.stringify(DRAFTS)),
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function cmp(cell, val) {
  const a = Number(cell), b = Number(val);
  if (cell !== null && cell !== undefined && cell !== '' && Number.isFinite(a) && Number.isFinite(b) && String(cell).trim() !== '') return a - b;
  return String(cell) < val ? -1 : (String(cell) > val ? 1 : 0);
}
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    if (cell === null || cell === undefined) return false;
    if (op === 'gte') return cmp(cell, val) >= 0;
    if (op === 'gt') return cmp(cell, val) > 0;
    if (op === 'lte') return cmp(cell, val) <= 0;
    if (op === 'lt') return cmp(cell, val) < 0;
    if (op === 'ilike' || op === 'like') {
      // PostgREST wildcards: % (and *) match anything; the server escapes a
      // literal % or _ as \% / \_ before sending.
      const pat = String(val).replace(/\\([%_])/g, '\u0000$1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.').replace(/\u0000([%_])/g, '\\$1');
      return new RegExp('^' + pat + '$', op === 'ilike' ? 'i' : '').test(String(cell == null ? '' : cell));
    }
    return true;
  });
}
function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const [col, dir] = String(orderParam).split('.');
  const sign = dir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => sign * cmp(a[col], String(b[col])));
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
  });
}
function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = applyOrder(rows.filter(matches), u.searchParams.get('order'));
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), ...r }; rows.push(row); return row; });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie, body, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, extra || {});
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(payload);
  });
}
const call       = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const callNoAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV        = 'true';
  process.env.NODE_ENV                 = 'test';
  process.env.AUTH_DISABLED            = 'false';
  process.env.AUTH_SECRET              = 'ceo-overview-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB      = 'false';
  process.env.SUPABASE_URL             = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN      = 'false';
  process.env.DB_FILE_PATH             = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS       = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS             = '';
  process.env.RETELL_API_KEY           = 'key_test';
  process.env.RETELL_AGENT_ID          = 'agent_1';
  process.env.RETELL_FROM_NUMBER_UK    = '+442030000000';
  process.env.LEAD_CALLS_ENABLED       = 'true';
  process.env.META_ADS_ACCESS_TOKEN    = 'test-meta-token';
  process.env.META_ADS_ACCOUNT_TIMEZONE = TZ;
  process.env.ZOOM_CLIENT_ID           = 'zoom-id';
  process.env.ZOOM_CLIENT_SECRET       = 'zoom-secret';
  process.env.ZOOM_ACCOUNT_ID          = 'zoom-account';
  process.env.CRON_SECRET              = 'cron-test-' + RUN_ID;

  // Anything that is not the emulator (Meta Graph, Resend, Retell) answers {}.
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.startsWith('https://zoom.us/oauth/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'zoom-test-token', expires_in: 3600 }), { status: 200 }));
    if (u.startsWith('https://api.zoom.us/v2/users/me/meetings')) return Promise.resolve(new Response(JSON.stringify({ meetings: zoomUpcoming, next_page_token: '' }), { status: 200 }));
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('GET /api/ceo/overview (route)', () => {
  it('is gated behind the super-admin session', async () => {
    const res = await callNoAuth('GET', '/api/ceo/overview');
    expect([401, 403]).toContain(res.status);
  });

  it('returns the full shape, built from the emulated tables', async () => {
    const res = await call('GET', '/api/ceo/overview');
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.ok).toBe(true);
    expect(b.window).toBe('7d');
    expect(b.tz).toBe(TZ);
    expect(typeof b.generated_in_ms).toBe('number');
    expect(Object.keys(b.status).sort()).toEqual(['consults', 'hayley', 'meta', 'registration']);
    for (const k of ['brief', 'funnel', 'needs', 'doctors', 'series', 'tiles']) expect(b).toHaveProperty(k);
    expect(Array.isArray(b.brief.segments)).toBe(true);
    expect(b.series.days).toHaveLength(14);
    // The route looked past the snapshot-less manual review for the numbers.
    expect(b.status.meta.live_ads).toBe(0);
    expect(b.status.meta.state).toBe('red');
    expect(b.status.meta.review.headline).toBe('Manual note');
    expect(b.status.meta.drafts.map((d) => d.id)).toEqual(['dr1', 'dr2', 'dr4']);
    // Hayley is configured + enabled in this env; the credit row makes her red.
    expect(b.status.hayley.configured).toBe(true);
    expect(b.status.hayley.enabled).toBe(true);
    expect(b.status.registration.urgent).toHaveLength(1);
    expect(b.needs.replies.map((r) => r.id)).toEqual(['se-hannah']);
    expect(b.doctors.accounts_total).toBe(5);
    expect(b.funnel.open_jobs).toBe(1);
  });

  it('never leaks ip or user_agent through the route', async () => {
    const res = await call('GET', '/api/ceo/overview');
    expect(res.raw).not.toContain(PRIVATE_IP);
    expect(res.raw).not.toContain(PRIVATE_UA);
    expect(res.raw).not.toMatch(/"ip"\s*:/);
    expect(res.raw).not.toMatch(/"user_agent"\s*:/);
  });

  it('uses the browser zone passed as ?tz= for "today", and falls back to the account zone when it is junk', async () => {
    const london = await call('GET', '/api/ceo/overview?tz=Europe/London');
    expect(london.status).toBe(200);
    expect(london.body.tz).toBe('Europe/London');
    const junk = await call('GET', '/api/ceo/overview?tz=Not/AZone');
    expect(junk.status).toBe(200);
    expect(junk.body.tz).toBe('Australia/Sydney');
  });

  it('honours window=30d and falls back to 7d for anything else', async () => {
    const w30 = await call('GET', '/api/ceo/overview?window=30d');
    expect(w30.status).toBe(200);
    expect(w30.body.window).toBe('30d');
    expect(w30.body.funnel.spend).toBe(900);
    const bogus = await call('GET', '/api/ceo/overview?window=1y');
    expect(bogus.body.window).toBe('7d');
    expect(bogus.body.funnel.spend).toBe(210.5);
  });
});

describe('POST /api/ceo/leads/:id/callback-done (route)', () => {
  it('is gated behind the super-admin session', async () => {
    const res = await callNoAuth('POST', '/api/ceo/leads/se-hannah/callback-done', {});
    expect([401, 403]).toContain(res.status);
  });

  it('GET /api/ceo/leads/:id/whatsapp-link answers 404 with a plain reason when DoubleTick is not configured', async () => {
    const res = await call('GET', '/api/ceo/leads/se-hannah/whatsapp-link');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/DoubleTick/);
  });

  it('GET /api/ceo/leads/:id/whatsapp-link returns a chat link already stored on the lead', async () => {
    const lead = db.site_enquiries.find((r) => r.id === 'se-hannah');
    lead.metadata.consult.doubletick_url = 'https://web.doubletick.io/conversations/intg_1/customer_abc';
    const res = await call('GET', '/api/ceo/leads/se-hannah/whatsapp-link');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, url: 'https://web.doubletick.io/conversations/intg_1/customer_abc' });
    delete lead.metadata.consult.doubletick_url;
  });

  it('stamps call_back_done_at on the lead and drops it from the Overview replies', async () => {
    const before = db.site_enquiries.find((r) => r.id === 'se-hannah');
    expect(before.metadata.consult.call_back_done_at).toBeUndefined();
    const res = await call('POST', '/api/ceo/leads/se-hannah/callback-done', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const after = db.site_enquiries.find((r) => r.id === 'se-hannah');
    expect(typeof after.metadata.consult.call_back_done_at).toBe('string');
    expect(Number.isFinite(Date.parse(after.metadata.consult.call_back_done_at))).toBe(true);
    expect(after.metadata.consult.call_back_done_by).toBe('ceo');
    // The rest of the consult block (and the privacy fields) are untouched.
    expect(after.metadata.consult.call_back_by).toBe('whatsapp_reply');
    expect(after.metadata.ip).toBe(PRIVATE_IP);
    const ov = await call('GET', '/api/ceo/overview');
    expect(ov.body.needs.replies).toEqual([]);
  });

  it('404s for a lead that does not exist', async () => {
    const res = await call('POST', '/api/ceo/leads/se-nope/callback-done', {});
    expect(res.status).toBe(404);
  });
});

describe('Zoom is the truth for consult times (reconcileZoomConsultTimes via the no-show cron)', () => {
  const H = 3600000, D = 86400000;
  const iso = (ms) => new Date(ms).toISOString();
  const cron = (extra) => httpReq('POST', '/api/cron/detect-no-shows', { host: SUPER_HOST, headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET }, ...(extra || {}) });

  it('moves a consult the owner dragged in Zoom, re-opens it, updates the lead, and the Overview lists it', async () => {
    const now = Date.now();
    const oldSlot = iso(now - 4 * D);
    const newSlot = new Date(now + 10 * H); newSlot.setUTCSeconds(0, 0);
    db.scheduled_calls.push({ id: 'sc-vishal', invitee_email: 'vishal@example.com', scheduled_at: oldSlot, booked_at: iso(now - 5 * D), completed_at: iso(now - 4 * D + 900000), no_show_at: null, cancelled_at: null, status: 'completed', meeting_kind: 'consultation', host_kind: 'ceo', zoom_meeting_id: '86526105611', zoom_join_url: 'https://zoom.example/j/865', created_at: iso(now - 5 * D) });
    db.site_enquiries.push({ id: 'se-vishal', created_at: iso(now - 20 * D), kind: 'gp', name: 'Dr Vishal Chaudhary', email: 'vishal@example.com', phone: '+447700900777', state: 'uk', status: 'new',
      metadata: { source: 'meta_lead_ad', consult: { qualified: true, is_gp: true, country: 'uk', call_booked: true, call_booked_at: iso(now - 5 * D), call_at: oldSlot, call_completed_at: iso(now - 4 * D + 900000), call_attended: false, call_attendance_source: 'manual', nudges: [] } } });
    zoomUpcoming = [{ id: 86526105611, type: 2, start_time: newSlot.toISOString().replace(/\.000Z$/, 'Z'), duration: 30, topic: 'Vishal Chaudhary: Finding The Perfect Australian Practice' }];

    const unauth = await httpReq('POST', '/api/cron/detect-no-shows', { host: SUPER_HOST });
    expect(unauth.status).toBe(401);

    const res = await cron();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.zoomReconcile).toMatchObject({ ok: true, moved: 1 });
    expect(res.body.zoomReconcile.moves[0]).toMatchObject({ id: 'sc-vishal', from: oldSlot, to: newSlot.toISOString(), reopened: true });

    const rowAfter = db.scheduled_calls.find((r) => r.id === 'sc-vishal');
    expect(rowAfter.status).toBe('booked');
    expect(rowAfter.scheduled_at).toBe(newSlot.toISOString());
    expect(rowAfter.completed_at).toBeNull();
    const lead = db.site_enquiries.find((r) => r.id === 'se-vishal');
    expect(lead.metadata.consult.call_at).toBe(newSlot.toISOString());
    expect(lead.metadata.consult.call_completed_at).toBeUndefined();
    expect(lead.metadata.consult.call_attended).toBeUndefined();
    expect(lead.metadata.consult.call_booked).toBe(true);

    const ov = await call('GET', '/api/ceo/overview');
    expect(ov.status).toBe(200);
    const up = ov.body.status.consults.upcoming.find((u) => u.id === 'sc-vishal');
    expect(up).toBeTruthy();
    expect(up.name).toBe('Dr Vishal Chaudhary');
    expect(up.lead_id).toBe('se-vishal');
    zoomUpcoming = [];
  });

  it('never resurrects a cancelled booking even when its Zoom meeting still exists', async () => {
    const now = Date.now();
    db.scheduled_calls.push({ id: 'sc-gone', invitee_email: 'gone@example.com', scheduled_at: iso(now + D), status: 'cancelled', cancelled_at: iso(now - H), completed_at: null, no_show_at: null, meeting_kind: 'consultation', host_kind: 'ceo', zoom_meeting_id: '99990000111', created_at: iso(now - 2 * D) });
    zoomUpcoming = [{ id: 99990000111, type: 2, start_time: iso(now + 2 * D).replace(/\.000Z$/, 'Z'), duration: 30, topic: 'gone' }];
    const res = await cron();
    expect(res.status).toBe(200);
    expect(res.body.zoomReconcile.moved).toBe(0);
    expect(db.scheduled_calls.find((r) => r.id === 'sc-gone').status).toBe('cancelled');
    zoomUpcoming = [];
  });
});
