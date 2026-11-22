'use strict';

/**
 * WP-27 (metrics, digest, review queue, gone-quiet): the two fixture sets the
 * acceptance test compares.
 *
 *   overseasTables()   an overseas-only business: twelve doctors across every
 *                      overseas stage (one blocked, one withdrawn, one archived,
 *                      one placed), their tasks, tickets, applications, an
 *                      interview, a placement, leads, Hayley calls, consults,
 *                      a flagged contract, an urgent regulator email, register
 *                      and account reviews, and one introduced application that
 *                      has been quiet for 70 days.
 *   auTables()         what an Australian launch adds: a doctor in every
 *                      Australian state (part-way through onboarding, looking,
 *                      matched, interview, contract, pre-start, start date
 *                      reached, first week, guarantee, guarantee ending,
 *                      complete, ended with a credit to decide, a second
 *                      placement cycle), held segment B and C doctors, the
 *                      review cases (Ahpra flags, registration expiring, 19AB
 *                      mismatch, a 19AB doctor in a non-DPA role), Australian
 *                      leads, an Australian interview, offers, a ticket, a
 *                      document to review and an escalation.
 *   merged(a, b)       one database holding both.
 *
 * Every date hangs off NOW (the test pins the clock there), so the fixtures
 * mean the same whenever the file runs. Every identity is obviously fake.
 */

const { buildAuDoctor, buildAuFixtureDb } = require('./au-fixtures.js');
const fees = require('../../lib/au-placement-fees.js');
const lc = require('../../lib/au-lifecycle.js');

// Wednesday 18 November 2026, 13:00 in Sydney. The Monday-anchored week the
// digest reports is 16 November; last week is 9 November.
const NOW = '2026-11-18T02:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY = 86400000;
const HOUR = 3600000;
const TODAY = lc.localDay(NOW_MS, 'Australia/Sydney');

const ago = function (days, hours) { return new Date(NOW_MS - days * DAY - (hours || 0) * HOUR).toISOString(); };
const ahead = function (days, hours) { return new Date(NOW_MS + days * DAY + (hours || 0) * HOUR).toISOString(); };
const dayAt = function (n) { return fees.addDays(TODAY, n); };

const RSO_A = '00000000-0000-4000-8000-00000000e001';
const RSO_B = '00000000-0000-4000-8000-00000000e002';
const CONSULTANT_EMAIL = 'consultant.test@gplink-test.local';

const PRACTICES = [
  { id: 'prac-metro', name: 'Test Metro Practice (FAKE)', is_active: true, location_state: 'VIC', location_city: 'Melbourne', contact_name: 'Pat Manager', contact_email: 'metro.practice@gplink-test.local', source: 'manual', agreement_status: 'signed', agreement_signed_at: ago(40), created_at: ago(60), metadata: {} },
  { id: 'prac-regional', name: 'Test Regional Practice (FAKE)', is_active: true, location_state: 'NSW', location_city: 'Dubbo', contact_name: 'Sam Manager', contact_email: 'regional.practice@gplink-test.local', source: 'facebook_lead', agreement_status: 'signed', agreement_signed_at: ago(5), created_at: ago(6), metadata: {} },
  { id: 'prac-west', name: 'Test West Practice (FAKE)', is_active: true, location_state: 'WA', location_city: 'Perth', contact_name: 'Lee Manager', contact_email: 'west.practice@gplink-test.local', source: 'manual', agreement_status: 'sent', agreement_signed_at: null, created_at: ago(20), metadata: {} }
];
const ROLES = [
  { id: 'role-metro', title: 'General Practitioner', practice_name: 'Test Metro Practice (FAKE)', practice_id: 'prac-metro', is_active: true, job_status: 'open', approval_status: 'approved', published_at: ago(30), created_at: ago(31), location_city: 'Melbourne', location_state: 'VIC', dpa: false, dpa_status: 'no' },
  { id: 'role-regional', title: 'General Practitioner', practice_name: 'Test Regional Practice (FAKE)', practice_id: 'prac-regional', is_active: true, job_status: 'open', approval_status: 'approved', published_at: ago(4), created_at: ago(5), location_city: 'Dubbo', location_state: 'NSW', dpa: true, dpa_status: 'yes' },
  { id: 'role-west', title: 'General Practitioner', practice_name: 'Test West Practice (FAKE)', practice_id: 'prac-west', is_active: true, job_status: 'open', approval_status: 'approved', published_at: ago(10), created_at: ago(11), location_city: 'Perth', location_state: 'WA', dpa: false, dpa_status: 'unknown' },
  { id: 'role-closed', title: 'General Practitioner', practice_name: 'Test Metro Practice (FAKE)', practice_id: 'prac-metro', is_active: false, job_status: 'filled', approval_status: 'approved', published_at: ago(90), created_at: ago(91), location_city: 'Melbourne', location_state: 'VIC', dpa: false, dpa_status: 'no' }
];

function app(id, userId, roleId, fields) {
  const role = ROLES.find(function (r) { return r.id === roleId; }) || {};
  return Object.assign({
    id, user_id: userId, career_role_id: roleId, practice_id: role.practice_id || null,
    status: 'applied', ats_stage: 'applied', origin: 'gp_applied', revealed: false,
    practice_submission_status: 'pending_va_submission', practice_decision: null, practice_decision_at: null, practice_responded_at: null,
    submitted_to_practice_at: null, matched_at: null, interview_completed_at: null, ats_stage_updated_at: null,
    applied_at: ago(5), updated_at: ago(5), match_outcome: null, practice_chase_flagged_at: null,
    app_consent_at: null
  }, fields || {});
}

function task(id, caseId, fields) {
  return Object.assign({
    id, case_id: caseId, title: 'Call the doctor', description: 'A manual task', task_type: 'manual', status: 'open', priority: 'normal',
    due_date: dayAt(10), related_stage: null, related_document_key: null, metadata: {}, source_trigger: 'va_manual',
    escalated_at: null, escalated_reason: null, escalated_by: null, completed_at: null,
    created_at: ago(6), updated_at: ago(6)
  }, fields || {});
}

function lead(id, fields, consult, source) {
  return Object.assign({
    id, kind: 'gp', name: 'Test Lead ' + id, email: id + '@gplink-test.local', phone: '+447700900' + String(id).replace(/\D/g, '').padStart(3, '0').slice(-3),
    state: null, status: 'new', created_at: ago(2),
    metadata: { source: source || 'meta_lead_ad', consult: consult || {} }
  }, fields || {});
}

function consultCall(id, email, fields) {
  return Object.assign({
    id, invitee_email: email, meeting_kind: 'consultation', host_kind: 'ceo', status: 'booked',
    scheduled_at: ahead(1), booked_at: ago(1), completed_at: null, no_show_at: null, cancelled_at: null,
    failed_attempt_count: 0, invite_sent_at: null, zoom_join_url: 'https://zoom.example/j/' + id, created_at: ago(1),
    application_id: null, practice_availability_status: null, user_id: null
  }, fields || {});
}

// ── The overseas business ────────────────────────────────────────────────────
function overseasDoctors() {
  const mk = function (n, stage, caseFields, profileFields, kind) {
    return buildAuDoctor(kind || 'overseas_null', {
      idSuffix: 'o' + n,
      profile: Object.assign({ first_name: 'Testos', last_name: 'Doc' + n, created_at: ago(40 + n), updated_at: ago(40 + n), onboarding_completed_at: ago(39 + n) }, profileFields || {}),
      caseRow: Object.assign({ stage, created_at: ago(40 + n), updated_at: ago(3), last_gp_activity_at: ago(3) }, caseFields || {})
    });
  };
  return {
    o1: mk(1, 'myintealth', { created_at: ago(1), updated_at: ago(1), last_gp_activity_at: ago(1) }, { created_at: ago(2), updated_at: ago(2), onboarding_completed_at: ago(1), lead_source: 'google' }),
    o2: mk(2, 'amc', { assigned_rso: RSO_A, updated_at: ago(10), last_gp_activity_at: ago(10) }, { lead_source: 'facebook_instagram' }),
    o3: mk(3, 'career', { assigned_rso: RSO_A, updated_at: ago(20), last_gp_activity_at: ago(20) }),
    o4: mk(4, 'ahpra', { assigned_rso: RSO_B, status: 'blocked', blocker_status: 'waiting_on_practice', blocker_reason: 'Practice has not sent the SPPA', blocker_set_at: ago(9) }),
    o5: mk(5, 'visa', { assigned_rso: RSO_B }),
    o6: mk(6, 'pbs', { assigned_rso: RSO_A }),
    o7: mk(7, 'commencement', {}),
    o8: mk(8, 'complete', { completed_at: ago(4), status: 'active' }),
    o9: mk(9, 'amc', { status: 'withdrawn' }),
    o10: mk(10, 'myintealth', {}, { account_status: 'archived' }),
    o11: mk(11, 'myintealth', { created_at: ago(8), updated_at: ago(8), last_gp_activity_at: ago(8) },
      { created_at: ago(9), updated_at: ago(9), register_body: 'gmc', register_number: '7000011', register_status: 'pending_verification', register_auto_checked_at: ago(1), onboarding_completed_at: null }, 'overseas_explicit'),
    o12: mk(12, 'myintealth', { created_at: ago(12), updated_at: ago(12), last_gp_activity_at: ago(12) },
      { created_at: ago(13), updated_at: ago(13), register_body: 'gmc', register_number: '7000012', register_status: 'mismatch', register_verified_at: ago(5) })
  };
}

function overseasTables() {
  const d = overseasDoctors();
  const list = Object.keys(d).map(function (k) { return d[k]; });
  const t = buildAuFixtureDb(list);
  // o12's account is held under review (the gate lives on user_state).
  const st12 = t.user_state.find(function (r) { return r.user_id === d.o12.userId; });
  st12.state.account_status = 'under_review';
  st12.state.gp_onboarding = Object.assign({}, st12.state.gp_onboarding, { idVerification: { status: 'manual_review', issues: ['Passport photo is blurred'] } });
  st12.updated_at = ago(3);

  t.practices = PRACTICES.map(function (p) { return Object.assign({}, p); });
  t.career_roles = ROLES.map(function (r) { return Object.assign({}, r); });

  t.gp_applications = [
    app('app-o3-new', d.o3.userId, 'role-regional', { applied_at: ago(2), updated_at: ago(2) }),
    // Introduced (interview stage) and quiet for 70 days: the overseas gone-quiet item.
    app('app-o3-quiet', d.o3.userId, 'role-metro', { status: 'interview', ats_stage: 'interview', revealed: true, practice_submission_status: 'client_approved', practice_decision: 'approved', practice_decision_at: ago(72), submitted_to_practice_at: ago(75), applied_at: ago(80), ats_stage_updated_at: ago(70), updated_at: ago(1) }),
    // Introduced and quiet for 20 days: under the overseas threshold.
    app('app-o5-recent', d.o5.userId, 'role-regional', { status: 'offer', ats_stage: 'offer', revealed: true, practice_submission_status: 'client_approved', practice_decision: 'approved', practice_decision_at: ago(25), submitted_to_practice_at: ago(28), applied_at: ago(30), ats_stage_updated_at: ago(20), updated_at: ago(20) }),
    app('app-o4-placed', d.o4.userId, 'role-regional', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', practice_decision: 'approved', practice_decision_at: ago(35), submitted_to_practice_at: ago(38), applied_at: ago(39), ats_stage_updated_at: ago(3), updated_at: ago(3) }),
    app('app-o2-sub', d.o2.userId, 'role-metro', { practice_submission_status: 'submitted', submitted_to_practice_at: ago(9), applied_at: ago(12), updated_at: ago(9) }),
    app('app-o9-wd', d.o9.userId, 'role-metro', { status: 'withdrawn', ats_stage: 'not_proceeding', applied_at: ago(30), updated_at: ago(29) })
  ];
  t.ats_offers = [
    { id: 'offer-o5', application_id: 'app-o5-recent', status: 'declined', created_at: ago(18), updated_at: ago(15) },
    { id: 'offer-o4', application_id: 'app-o4-placed', status: 'accepted', created_at: ago(10), updated_at: ago(4) }
  ];
  t.placements = [
    { id: 'plc-o4', user_id: d.o4.userId, application_id: 'app-o4-placed', career_role_id: 'role-regional', practice_id: 'prac-regional', practice_name: 'Test Regional Practice (FAKE)', job_title: 'General Practitioner', location: 'Dubbo, NSW', start_date: dayAt(60), status: 'active', placed_at: ago(3), created_at: ago(3) }
  ];
  t.career_interviews = [
    { id: 'civ-o3', application_id: 'app-o3-quiet', user_id: d.o3.userId, status: 'scheduled', created_at: ago(1) },
    { id: 'civ-o5', application_id: 'app-o5-recent', user_id: d.o5.userId, status: 'completed', created_at: ago(8) }
  ];

  t.registration_tasks = [
    task('task-o1-open', d.o1.caseId, { related_stage: 'myintealth' }),
    task('task-o2-overdue', d.o2.caseId, { related_stage: 'amc', due_date: dayAt(-5), status: 'in_progress', created_at: ago(15) }),
    task('task-o3-esc', d.o3.caseId, { related_stage: 'career', status: 'escalated', title: 'Doctor asked about the practice', escalated_at: ago(1), escalated_reason: 'Needs the owner', escalated_by: 'rso.test@gplink-test.local', source_trigger: 'whatsapp_help' }),
    task('task-o5-doc', d.o5.caseId, { related_stage: 'visa', task_type: 'doc_review', title: 'Review passport', related_document_key: 'passport', created_at: ago(2) }),
    task('task-o6-waiting', d.o6.caseId, { related_stage: 'pbs', status: 'waiting_on_gp', due_date: dayAt(-1) }),
    task('task-o2-done', d.o2.caseId, { related_stage: 'amc', status: 'completed', completed_at: ago(2), created_at: ago(9) }),
    task('task-o4-done', d.o4.caseId, { related_stage: 'ahpra', status: 'completed', completed_at: ago(9), created_at: ago(12) }),
    task('task-o9-open', d.o9.caseId, { related_stage: 'amc' })
  ];
  t.task_timeline = [
    { id: 'tl-o2-a', case_id: d.o2.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to amc', detail: '', actor: 'system', metadata: { from_stage: 'myintealth', to_stage: 'amc' }, created_at: ago(30) },
    { id: 'tl-o3-a', case_id: d.o3.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to amc', detail: '', actor: 'system', metadata: { from_stage: 'myintealth', to_stage: 'amc' }, created_at: ago(35) },
    { id: 'tl-o3-b', case_id: d.o3.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to career', detail: '', actor: 'system', metadata: { from_stage: 'amc', to_stage: 'career' }, created_at: ago(21) },
    { id: 'tl-o8-a', case_id: d.o8.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to complete', detail: '', actor: 'system', metadata: { from_stage: 'commencement', to_stage: 'complete' }, created_at: ago(4) },
    { id: 'tl-o1-a', case_id: d.o1.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to myintealth', detail: '', actor: 'system', metadata: { from_stage: null, to_stage: 'myintealth' }, created_at: ago(1) }
  ];
  t.support_tickets = [
    { id: 'tick-o1', user_id: d.o1.userId, case_id: d.o1.caseId, status: 'open', subject: 'A question', created_at: ago(1), resolved_at: null, first_reply_at: null },
    { id: 'tick-o2', user_id: d.o2.userId, case_id: d.o2.caseId, status: 'closed', subject: 'Solved', created_at: ago(5), resolved_at: ago(3), first_reply_at: ago(4, 20) }
  ];

  t.site_enquiries = [
    lead('lead-1', { created_at: ago(0, 5), name: 'Test Leadone' }, { country: 'uk', ai_call: { status: 'ended', outcome: 'booked' }, ai_calls: [{ duration_s: 140, outcome: 'booked' }], call_booked_at: ago(0, 4), call_at: ahead(1), booked_via: 'hazel' }),
    lead('lead-2', { created_at: ago(2), name: 'Test Leadtwo' }, { country: 'uk', ai_call: { status: 'ended', outcome: 'voicemail' }, ai_calls: [{ duration_s: 0, outcome: 'voicemail' }] }),
    lead('lead-3', { created_at: ago(3), name: 'Test Leadthree' }, { country: 'ie' }, 'site_start_form'),
    lead('lead-4', { created_at: ago(5), name: 'Test Leadfour' }, { country: 'uk', call_booked_at: ago(4), call_at: ago(2), call_completed_at: ago(2), call_attended: true, stopped: 'signed_up' }, 'calendly_direct'),
    lead('lead-5', { created_at: ago(6), name: 'Test Leadfive' }, { country: 'uk', call_booked_at: ago(5), call_at: ago(3), call_completed_at: ago(3), call_attended: false, call_back_by: 'owner', call_back_note: 'Replied: "can we move it to Friday?"', replied_at: ago(1) }),
    lead('lead-6', { created_at: ago(20), name: 'Test Leadsix' }, { country: 'nz' }),
    lead('lead-zoho', { created_at: ago(1), name: 'Test Zoho' }, { country: 'uk' }, 'zoho_import'),
    { id: 'lead-practice', kind: 'practice', name: 'Test Practice Enquiry', email: 'p.enq@gplink-test.local', phone: '', state: null, status: 'new', created_at: ago(2), metadata: { source: 'site_form' } }
  ];
  t.lead_calls = [
    { id: 'lc-1', enquiry_id: 'lead-1', direction: 'outbound', status: 'ended', outcome: 'booked', disconnection_reason: 'agent_hangup', started_at: ago(0, 4), duration_s: 140, cost_cents: 80, created_at: ago(0, 4) },
    { id: 'lc-2', enquiry_id: 'lead-2', direction: 'outbound', status: 'ended', outcome: 'voicemail', disconnection_reason: 'voicemail_reached', started_at: ago(1, 20), duration_s: 0, cost_cents: 5, created_at: ago(1, 20) },
    { id: 'lc-3', enquiry_id: 'lead-6', direction: 'outbound', status: 'ended', outcome: 'no_answer', disconnection_reason: 'dial_no_answer', started_at: ago(19), duration_s: 0, cost_cents: 2, created_at: ago(19) }
  ];
  t.scheduled_calls = [
    consultCall('sc-lead-1', 'lead-1@gplink-test.local', { scheduled_at: ahead(1), booked_at: ago(0, 4), created_at: ago(0, 4) }),
    consultCall('sc-lead-4', 'lead-4@gplink-test.local', { status: 'completed', scheduled_at: ago(2), booked_at: ago(4), completed_at: ago(2), created_at: ago(4) }),
    consultCall('sc-lead-5', 'lead-5@gplink-test.local', { status: 'completed', scheduled_at: ago(3), booked_at: ago(5), completed_at: ago(3), created_at: ago(5) }),
    // The overseas doctor's practice interview (the modern booking).
    { id: 'sc-o3-int', invitee_email: d.o3.email, meeting_kind: 'interview', host_kind: 'practice', status: 'booked', scheduled_at: ahead(3), booked_at: ago(1), completed_at: null, no_show_at: null, cancelled_at: null, failed_attempt_count: 0, invite_sent_at: null, zoom_join_url: '', created_at: ago(1), application_id: 'app-o3-quiet', practice_availability_status: 'confirmed', user_id: d.o3.userId },
    { id: 'sc-o2-int', invitee_email: d.o2.email, meeting_kind: 'interview', host_kind: 'practice', status: 'invited', scheduled_at: null, booked_at: null, completed_at: null, no_show_at: null, cancelled_at: null, failed_attempt_count: 0, invite_sent_at: ago(2), zoom_join_url: '', created_at: ago(2), application_id: 'app-o2-sub', practice_availability_status: 'requested', user_id: d.o2.userId }
  ];
  t.career_contracts = [
    { id: 'con-o4', user_id: d.o4.userId, application_id: 'app-o4-placed', status: 'under_review', contract_filename: 'Contract (FAKE).pdf', ai_review: { overall: 'major_discrepancies', summary: 'The restraint clause is wider than agreed.' }, sent_to_gp_at: null, created_at: ago(3) }
  ];
  t.incoming_email_todos = [
    { id: 'todo-o5', sender_email: 'noreply@ahpra.gov.au', subject: 'Further information required', ai_urgency: 'urgent', ai_summary: 'Ahpra wants a certified copy within 14 days.', matched_user_id: d.o5.userId, gmail_message_id: 'gm-o5', created_at: ago(1), resolved_at: null }
  ];
  t.user_documents = [
    { id: 'doc-o5', user_id: d.o5.userId, document_key: 'passport', country_code: 'GB', status: 'under_review', created_at: ago(2), updated_at: ago(2) }
  ];
  ['runtime_kv', 'ad_reviews', 'ad_drafts', 'gp_nudge_log', 'user_roles', 'admin_audit_log', 'rate_limits', 'pep_waitlist', 'onboarding_reminders',
    'visa_applications', 'pbs_applications', 'case_events', 'task_messages', 'task_documents', 'practice_doc_ops', 'candidate_leads',
    'notification_preferences', 'email_suppression', 'user_nudges', 'cron_heartbeats', 'au_gp_doctor_details', 'client_errors', 'email_templates'
  ].forEach(function (name) { if (!t[name]) t[name] = []; });
  return t;
}

// ── What an Australian launch adds ───────────────────────────────────────────
function auPlacement(id, doctor, appId, roleId, fields) {
  const role = ROLES.find(function (r) { return r.id === roleId; }) || {};
  return Object.assign({
    id, user_id: doctor.userId, application_id: appId, career_role_id: roleId, practice_id: role.practice_id, practice_name: role.practice_name,
    job_title: 'General Practitioner', location: role.location_city + ', ' + role.location_state, start_date: null, status: 'active',
    placed_at: ago(10), created_at: ago(10),
    candidate_basis: 'australia', fee_tier: null, fee_amount_ex_gst: null, agreement_variant: null,
    commenced_at: null, commencement_confirmed_by: null, invoice_due_at: null, invoice_sent_at: null, invoice_paid_at: null, invoice_reference: null,
    guarantee_ends_at: null, ended_at: null, end_reason: null, credit_pct: null, sessions_per_week_numeric: null
  }, fields || {});
}
function commenced(daysAgo, fields) {
  const on = dayAt(-daysAgo);
  return Object.assign({
    commenced_at: on, commencement_confirmed_by: CONSULTANT_EMAIL, invoice_due_at: on, guarantee_ends_at: fees.guaranteeEndsOn(on),
    fee_tier: 'full_time', fee_amount_ex_gst: 15000, agreement_variant: 'standard_2026', start_date: on, placed_at: ago(daysAgo + 20), created_at: ago(daysAgo + 20)
  }, fields || {});
}

function auDoctors() {
  let n = 0;
  const mk = function (key, kind, last, o) {
    n += 1;
    const x = o || {};
    return buildAuDoctor(kind, {
      idSuffix: 'w' + n,
      selfDeclared: x.selfDeclared,
      noCase: x.noCase,
      profile: Object.assign({ first_name: 'Testau', last_name: last, created_at: ago(30 + n), updated_at: ago(30 + n), onboarding_completed_at: ago(29 + n), phone: '+6140027' + String(1000 + n) }, x.profile || {}),
      credentials: x.credentials === null ? null : Object.assign({ registration_expiry: dayAt(400), indemnity_expiry: dayAt(300), ahpra_last_checked_at: ago(20), ahpra_last_checked_by: CONSULTANT_EMAIL, staff_verified_at: ago(20), staff_verified_by: CONSULTANT_EMAIL }, x.credentials || {}),
      caseRow: Object.assign({ created_at: ago(29 + n), updated_at: ago(2), last_gp_activity_at: ago(40) }, x.caseRow || {}),
      state: x.state
    });
  };
  return {
    // Part-way through the Australian onboarding branch: no pathway yet, the
    // server-owned branch marker, no case.
    onboarding: mk('onboarding', 'overseas_null', 'Onboarding', { credentials: null, noCase: true,
      profile: { created_at: ago(2), updated_at: ago(2), onboarding_completed_at: null, registration_country: 'Australia', qualification_country: 'AU', gmc_number: '', register_body: null, register_number: null, register_status: null, target_arrival_date: '', who_moving: '' },
      state: { gp_onboarding_complete: false, gp_au_branch_started_at: ago(2), gp_onboarding: { country: 'AU', auBranch: 'yes', currentStep: 2 } } }),
    looking: mk('looking', 'au_vr', 'Looking', { profile: { created_at: ago(3), updated_at: ago(3), onboarding_completed_at: ago(3) }, caseRow: { created_at: ago(3) } }),
    matched: mk('matched', 'au_vr', 'Matched'),
    interview: mk('interview', 'au_vr', 'Interview'),
    contract: mk('contract', 'au_vr', 'Contract'),
    prestart: mk('prestart', 'au_vr', 'Prestart', { caseRow: { stage: 'prestart', assigned_rso: RSO_A } }),
    startReached: mk('startReached', 'au_vr', 'Startreached', { caseRow: { stage: 'prestart', assigned_rso: RSO_A } }),
    firstWeek: mk('firstWeek', 'au_vr', 'Firstweek', { caseRow: { stage: 'commenced', assigned_rso: RSO_B } }),
    guarantee: mk('guarantee', 'au_vr', 'Guarantee', { caseRow: { stage: 'guarantee', assigned_rso: RSO_B } }),
    guaranteeEnding: mk('guaranteeEnding', 'au_vr', 'Guaranteeending', { caseRow: { stage: 'guarantee', assigned_rso: RSO_B } }),
    complete: mk('complete', 'au_vr', 'Complete', { caseRow: { stage: 'complete', completed_at: ago(10), assigned_rso: RSO_B } }),
    ended: mk('ended', 'au_vr', 'Ended', { caseRow: { stage: 'complete', completed_at: ago(6), assigned_rso: RSO_B } }),
    cycleTwo: mk('cycleTwo', 'au_vr', 'Cycletwo', { caseRow: { stage: 'placement', completed_at: null } }),
    heldB: mk('heldB', 'au_restricted', 'Heldb'),
    heldC: mk('heldC', 'au_non_vr', 'Heldc'),
    flags: mk('flags', 'au_vr', 'Flags', { credentials: { has_conditions: true, conditions_text: 'Must practise under supervision (FAKE)', flags_reviewed_at: null, flags_reviewed_by: null } }),
    expiring: mk('expiring', 'au_vr', 'Expiring', { credentials: { registration_expiry: dayAt(30), ahpra_last_checked_at: ago(100) } }),
    mismatch: mk('mismatch', 'au_vr', 'Mismatch', { credentials: { moratorium_19ab_status: 'yes', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: CONSULTANT_EMAIL, moratorium_19ab_confirmed_at: ago(4) } }),
    nonDpa: mk('nonDpa', 'au_vr', 'Nondpa', { credentials: { moratorium_19ab_status: 'yes', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: CONSULTANT_EMAIL, moratorium_19ab_confirmed_at: ago(4) } })
  };
}

function auTables() {
  const d = auDoctors();
  const list = Object.keys(d).map(function (k) { return d[k]; });
  const t = buildAuFixtureDb(list);

  t.gp_applications = [
    app('app-au-matched', d.matched.userId, 'role-metro', { practice_submission_status: 'submitted', submitted_to_practice_at: ago(3), applied_at: ago(4), updated_at: ago(3), app_consent_at: ago(4) }),
    // Introduced and quiet for 20 days: past the Australian threshold, under the overseas one.
    app('app-au-interview', d.interview.userId, 'role-metro', { status: 'interview', ats_stage: 'interview', revealed: true, practice_submission_status: 'client_approved', practice_decision: 'approved', practice_decision_at: ago(22), submitted_to_practice_at: ago(24), applied_at: ago(25), ats_stage_updated_at: ago(20), updated_at: ago(1), app_consent_at: ago(25) }),
    app('app-au-contract', d.contract.userId, 'role-metro', { status: 'offer', ats_stage: 'offer', revealed: true, practice_submission_status: 'client_approved', practice_decision: 'approved', practice_decision_at: ago(9), submitted_to_practice_at: ago(11), applied_at: ago(12), ats_stage_updated_at: ago(4), interview_completed_at: ago(6), updated_at: ago(4), app_consent_at: ago(12) }),
    app('app-au-prestart', d.prestart.userId, 'role-metro', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(30), ats_stage_updated_at: ago(10), updated_at: ago(10) }),
    app('app-au-start', d.startReached.userId, 'role-regional', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(40), ats_stage_updated_at: ago(25), updated_at: ago(25) }),
    app('app-au-first', d.firstWeek.userId, 'role-metro', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(40), ats_stage_updated_at: ago(23), updated_at: ago(23) }),
    app('app-au-guar', d.guarantee.userId, 'role-west', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(80), ats_stage_updated_at: ago(60), updated_at: ago(60) }),
    app('app-au-guarend', d.guaranteeEnding.userId, 'role-regional', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(110), ats_stage_updated_at: ago(95), updated_at: ago(95) }),
    app('app-au-complete', d.complete.userId, 'role-metro', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(130), ats_stage_updated_at: ago(120), updated_at: ago(120) }),
    app('app-au-ended', d.ended.userId, 'role-metro', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(70), ats_stage_updated_at: ago(60), updated_at: ago(60) }),
    // The second placement cycle: the first placement finished, the doctor is looking again.
    app('app-au-cycle1', d.cycleTwo.userId, 'role-closed', { status: 'placement_secured', ats_stage: 'hired', revealed: true, practice_submission_status: 'client_approved', applied_at: ago(200), ats_stage_updated_at: ago(180), updated_at: ago(180) }),
    app('app-au-cycle2', d.cycleTwo.userId, 'role-regional', { applied_at: ago(2), updated_at: ago(2), app_consent_at: ago(2) }),
    // A doctor staff confirmed 19AB applies to, submitted to a role that is not in a DPA.
    app('app-au-nondpa', d.nonDpa.userId, 'role-metro', { practice_submission_status: 'submitted', submitted_to_practice_at: ago(2), applied_at: ago(3), updated_at: ago(2), app_consent_at: ago(3) })
  ];
  t.ats_offers = [
    { id: 'offer-au-contract', application_id: 'app-au-contract', status: 'sent', created_at: ago(4), updated_at: ago(4) },
    { id: 'offer-au-prestart', application_id: 'app-au-prestart', status: 'accepted', created_at: ago(14), updated_at: ago(10) }
  ];
  t.placements = [
    auPlacement('plc-au-prestart', d.prestart, 'app-au-prestart', 'role-metro', { start_date: dayAt(20), placed_at: ago(10), created_at: ago(10) }),
    auPlacement('plc-au-start', d.startReached, 'app-au-start', 'role-regional', { start_date: dayAt(-2), placed_at: ago(25), created_at: ago(25) }),
    auPlacement('plc-au-first', d.firstWeek, 'app-au-first', 'role-metro', commenced(3)),
    auPlacement('plc-au-guar', d.guarantee, 'app-au-guar', 'role-west', commenced(40, { invoice_sent_at: dayAt(-20), invoice_reference: 'INV-FAKE-0040', fee_tier: 'part_time', fee_amount_ex_gst: 10000 })),
    auPlacement('plc-au-guarend', d.guaranteeEnding, 'app-au-guarend', 'role-regional', commenced(75, { invoice_sent_at: dayAt(-74), invoice_paid_at: dayAt(-70), invoice_reference: 'INV-FAKE-0075' })),
    auPlacement('plc-au-complete', d.complete, 'app-au-complete', 'role-metro', commenced(100, { invoice_sent_at: dayAt(-99), invoice_paid_at: dayAt(-95), invoice_reference: 'INV-FAKE-0100' })),
    auPlacement('plc-au-ended', d.ended, 'app-au-ended', 'role-metro', commenced(40, { status: 'ended', ended_at: dayAt(-6), end_reason: 'resigned: left for family reasons (FAKE)', credit_pct: null, invoice_sent_at: dayAt(-39), invoice_reference: 'INV-FAKE-0041' })),
    auPlacement('plc-au-cycle1', d.cycleTwo, 'app-au-cycle1', 'role-closed', commenced(150, { invoice_sent_at: dayAt(-149), invoice_paid_at: dayAt(-145), invoice_reference: 'INV-FAKE-0150' }))
  ];

  const auTask = function (id, doctor, type, fields, meta) {
    return task(id, doctor.caseId, Object.assign({ task_type: type, related_stage: 'prestart', source_trigger: 'au_placement', title: type.replace(/_/g, ' ') },
      fields || {}, { metadata: Object.assign({ au: true, owner: 'rso', placement_key: null }, meta || {}) }));
  };
  t.registration_tasks = [
    auTask('task-au-pre-start', d.prestart, 'start_date_tracking', { status: 'completed', completed_at: ago(8), due_date: dayAt(-7) }, { owner: 'consultant', owner_then: 'rso', placement_key: 'app-au-prestart', placement_task_kind: 'start_date_tracking', confirmed_start_date: dayAt(20) }),
    auTask('task-au-pre-provider', d.prestart, 'provider_number_new_location', { due_date: dayAt(-3), title: 'Provider number for the new location' }, { placement_key: 'app-au-prestart', placement_task_kind: 'provider_number_new_location' }),
    auTask('task-au-pre-indemnity', d.prestart, 'indemnity_certificate', { due_date: dayAt(6), title: 'Indemnity certificate' }, { placement_key: 'app-au-prestart', placement_task_kind: 'indemnity_certificate' }),
    auTask('task-au-start-provider', d.startReached, 'provider_number_new_location', { due_date: dayAt(-10), title: 'Provider number for the new location' }, { placement_key: 'app-au-start', placement_task_kind: 'provider_number_new_location' }),
    auTask('task-au-invoice-first', d.firstWeek, 'invoice_due', { related_stage: 'commenced', due_date: dayAt(-3), title: 'Send the placement invoice' }, { owner: 'ceo', placement_key: 'app-au-first', lifecycle_kind: 'invoice' }),
    auTask('task-au-credit', d.ended, 'manual', { related_stage: 'complete', due_date: dayAt(-4), title: 'Decide the guarantee credit, then replacement or credit', source_trigger: 'au_lifecycle' }, { owner: 'ceo', placement_key: 'app-au-ended', lifecycle_kind: 'replacement_or_credit' }),
    auTask('task-au-heldb-review', d.heldB, 'segment_review', { related_stage: 'placement', due_date: dayAt(-1), title: 'Review this doctor: segment B', source_trigger: 'au_segment_review' }, { owner: 'consultant' }),
    auTask('task-au-doc', d.matched, 'doc_review', { related_stage: 'placement', title: 'Review Ahpra certificate', related_document_key: 'au_ahpra_certificate', created_at: ago(1) }, { owner: 'consultant' }),
    auTask('task-au-esc', d.contract, 'manual', { related_stage: 'placement', status: 'escalated', title: 'Practice wants to change the start date', escalated_at: ago(0, 6), escalated_reason: 'Needs the owner', escalated_by: CONSULTANT_EMAIL }, { owner: 'consultant' }),
    auTask('task-au-done', d.guarantee, 'guarantee_checkin', { related_stage: 'guarantee', status: 'completed', completed_at: ago(3), created_at: ago(40), title: 'Week 4 check-in' }, { owner: 'consultant', placement_key: 'app-au-guar', lifecycle_kind: 'checkin' })
  ];
  t.task_timeline = [
    { id: 'tl-au-pre', case_id: d.prestart.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to prestart', detail: '', actor: 'system', metadata: { from_stage: 'placement', to_stage: 'prestart', ladder: 'au', pathway: 'au_vr' }, created_at: ago(10) },
    { id: 'tl-au-first', case_id: d.firstWeek.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to commenced', detail: '', actor: CONSULTANT_EMAIL, metadata: { from_stage: 'prestart', to_stage: 'commenced', ladder: 'au', pathway: 'au_vr' }, created_at: ago(3) },
    { id: 'tl-au-done', case_id: d.complete.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to complete', detail: '', actor: 'system', metadata: { from_stage: 'guarantee', to_stage: 'complete', ladder: 'au', pathway: 'au_vr' }, created_at: ago(2) },
    { id: 'tl-au-cycle', case_id: d.cycleTwo.caseId, task_id: null, event_type: 'stage_change', title: 'New placement cycle 2 opened: stage set to placement', detail: '', actor: 'system', metadata: { from_stage: 'complete', to_stage: 'placement', ladder: 'au', pathway: 'au_vr', placement_cycle: 2, cycle_opened: true, cycle_trigger: 'applied', previous_placement_key: 'app-au-cycle1' }, created_at: ago(2) }
  ];
  t.support_tickets = [
    { id: 'tick-au', user_id: d.prestart.userId, case_id: d.prestart.caseId, status: 'open', subject: 'A question about my start', created_at: ago(1), resolved_at: null, first_reply_at: null },
    { id: 'tick-au-closed', user_id: d.guarantee.userId, case_id: d.guarantee.caseId, status: 'closed', subject: 'Solved', created_at: ago(4), resolved_at: ago(2), first_reply_at: ago(3, 20) }
  ];
  t.site_enquiries = [
    lead('aulead-1', { created_at: ago(1), name: 'Test Auleadone', phone: '+61400270001', state: 'VIC' }, { country: 'au', segment: 'au_vr', call_booked_at: ago(0, 8), call_at: ahead(2) }, 'site_start_form'),
    lead('aulead-2', { created_at: ago(4), name: 'Test Auleadtwo', phone: '+61400270002', state: 'NSW' }, { country: 'au', segment: 'au_vr' }, 'meta_lead_ad'),
    lead('aulead-3', { created_at: ago(12), name: 'Test Auleadthree', phone: '+61400270003', state: 'WA' }, { country: 'au', segment: 'au_restricted', call_back_by: 'owner', call_back_note: 'Replied: "when can we talk?"', replied_at: ago(0, 3) }, 'site_start_form')
  ];
  t.scheduled_calls = [
    consultCall('sc-aulead-1', 'aulead-1@gplink-test.local', { scheduled_at: ahead(2), booked_at: ago(0, 8), created_at: ago(0, 8) }),
    // The Australian doctor's practice interview, booked this week.
    { id: 'sc-au-int', invitee_email: d.interview.email, meeting_kind: 'interview', host_kind: 'practice', status: 'booked', scheduled_at: ahead(2), booked_at: ago(1), completed_at: null, no_show_at: null, cancelled_at: null, failed_attempt_count: 0, invite_sent_at: null, zoom_join_url: '', created_at: ago(1), application_id: 'app-au-interview', practice_availability_status: 'confirmed', user_id: d.interview.userId },
    { id: 'sc-au-int-done', invitee_email: d.contract.email, meeting_kind: 'interview', host_kind: 'practice', status: 'completed', scheduled_at: ago(6), booked_at: ago(9), completed_at: ago(6), no_show_at: null, cancelled_at: null, failed_attempt_count: 0, invite_sent_at: null, zoom_join_url: '', created_at: ago(9), application_id: 'app-au-contract', practice_availability_status: 'confirmed', user_id: d.contract.userId }
  ];
  t.user_documents = [
    { id: 'doc-au', user_id: d.matched.userId, document_key: 'au_ahpra_certificate', country_code: 'au_reg', status: 'under_review', created_at: ago(1), updated_at: ago(1) }
  ];
  return t;
}

/** One database holding both sets (rows of the same table are concatenated). */
function merged(a, b) {
  const out = {};
  Object.keys(a).forEach(function (k) { out[k] = (a[k] || []).map(function (r) { return JSON.parse(JSON.stringify(r)); }); });
  Object.keys(b).forEach(function (k) {
    out[k] = (out[k] || []).concat((b[k] || []).filter(function (r) {
      // Shared reference rows (practices, roles) are already there.
      return !(out[k] || []).some(function (x) { return x && r && x.id !== undefined && x.id === r.id; });
    }).map(function (r) { return JSON.parse(JSON.stringify(r)); }));
  });
  return out;
}

function auUserIds() {
  const d = auDoctors();
  return Object.keys(d).map(function (k) { return d[k].userId; });
}

module.exports = {
  NOW, NOW_MS, TODAY, DAY, ago, ahead, dayAt, RSO_A, RSO_B, CONSULTANT_EMAIL, PRACTICES, ROLES,
  overseasDoctors, overseasTables, auDoctors, auTables, merged, auUserIds
};
