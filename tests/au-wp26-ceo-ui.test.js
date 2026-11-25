// WP-26 (Australian GP build): what the CEO dashboard draws for an AUSTRALIAN
// doctor. Each module (js/ceo-ats-*.js) is run whole in a stand-in window
// (tests/helpers/au-wp26-parity.js). The overseas side of every view here is
// pinned byte for byte in tests/au-wp26-overseas-parity.test.js.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const parity = require('./helpers/au-wp26-parity.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CEO = read('pages/ceo-dashboard.html');
const CAND_SRC = read('js/ceo-ats-candidates.js');
const XSS = '<img src=x onerror=alert(1)>';
const OVERSEAS_WORDS = /\bGB\b|MyIntealth|\bAMC\b|AHPRA application|AHPRA Registration|Visa\b|Target arrival|who's moving|Family \//;
const RAW_KEYS = /reference_check|restraint_check|start_date_tracking|guarantee_checkin|invoice_due|dpa_19ab_check|>\s*prestart\s*<|pathway_on_hold|vr_required/;

const NAMES = ['rowHtml', 'listScaffold', 'detailHtml', 'profileCardInner', 'onboardingCardInner', 'docsCardInner', 'applicationsCardInner',
  'auEnable', 'auCardsHtml', 'auTasksCardInner', 'auTaskFormHtml', 'auPrestartCardInner', 'auEligibilityCardInner', 'auEmailCardInner',
  'auConsentLineHtml', 'auInterviewFinishHtml', 'auPlacementLineHtml'];

function load(opts) {
  const m = parity.loadCeoModule('js/ceo-ats-candidates.js', NAMES, opts);
  if (!(opts && opts.switchOff)) m.auEnable([{ value: '', label: 'All pathways' }], [{ value: 'au:prestart', label: 'Pre-start' }]);
  return m;
}

const AU = {
  case_id: 'case-au-1', user_id: 'user-au-1', name: 'Dr Test Auvr ' + XSS, email: 'au.vr.test@gplink-test.local', phone: '+61491570156',
  country: 'GB', reg: '', account_status: 'active', joined: '2026-11-20T03:04:05.000Z', rso: '00000000-0000-4000-a000-0000000000c2', zoho: '',
  intent: { score: 40, band: 'Warm', signals: [] }, reg_stage: 'prestart', reg_stage_label: 'prestart', blocked: false, blocked_days: 0,
  rail: [{ key: 'placement', label: 'Placement', state: 'done' }, { key: 'prestart', label: 'Pre-start', state: 'current' }],
  onboarding: { completed: true, fieldsFilled: 1, qualCountry: '', specialty: 'FRACGP — General Practice', target: 'Not set', city: 'Parramatta', family: '', idVerified: true },
  docs: { cv: true, coverLetter: false, primaryDegree: false, idDoc: true }, comms: null, calls: [], ai_handover: null, doc_reviews: [], doc_reviews_pending: 0, career_lock: null,
  apps: [
    { id: 'app-1', job_id: 'role-1', job_title: 'Non-DPA - Parramatta ' + XSS, practice_name: 'Test Metro Practice (FAKE)', ats_stage: 'interview', status: 'interview', practice_submission_status: 'submitted', source: 'in_app',
      interview: { id: 'call-1', status: 'booked', scheduled_at: '2026-11-23T00:00:00Z', join_url: '' }, offer: { status: 'accepted', label: 'Offer accepted' }, contract: null },
    { id: 'app-2', job_id: 'role-2', job_title: 'DPA - Dubbo', practice_name: 'Test Regional Practice (FAKE)', ats_stage: 'offer', status: 'offer', practice_submission_status: 'pending_va_submission', source: 'in_app',
      interview: null, offer: { status: 'accepted', label: 'Offer accepted' }, contract: null }
  ],
  au: {
    enabled: true, chip: 'Australian VR', stage: 'prestart', stage_label: 'Pre-start', placing_consultant: 'consultant@gplink-test.local',
    public_register_url: 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx',
    pathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true, recorded: true, confirmed: true, needsStaffReview: false, dpaRestricted: false, dpaRestrictedReason: 'staff_confirmed_19ab_not_applicable' },
    record: { candidate_pathway: 'au_vr', pathway_set_by: 'consultant@gplink-test.local' },
    credentials: { ahpra_number: 'MED0001234567', staff_verified_at: '2026-11-21T00:00:00Z' }, case: { id: 'case-au-1', stage: 'prestart' },
    check_task: null, segment_review_task: null,
    doc_slots: [
      { key: 'au_indemnity_certificate', slot: 'au:au_indemnity_certificate', label: 'Indemnity certificate of currency', required: true, has: true, status: 'approved', expires_at: '2027-06-30T00:00:00.000Z', expiry_tracked: true },
      { key: 'au_right_to_work', slot: 'au:au_right_to_work', label: 'Right-to-work evidence ' + XSS, required: true, has: false, status: 'pending', expiry_tracked: false }
    ],
    drawer: {
      reg_number: 'MED0001234567', rso_name: 'Test Rso (FAKE)', placing_consultant_name: 'Test Consultant (FAKE) (consultant@gplink-test.local)',
      available_from: '2026-12-14', notice_period_weeks: 4, current_location: 'Parramatta NSW 2150', doc_count: { have: 2, approved: 1, total: 8 },
      app_consent: { 'app-1': { on_file: true, source: 'staff_verbal', at: '2026-11-22T01:00:00Z' }, 'app-2': { on_file: false, reason: 'none' } }
    }
  }
};
const LIST_ROW = {
  case_id: 'case-au-1', user_id: 'user-au-1', name: AU.name, email: AU.email, country: '', reg_stage: 'prestart', reg_stage_label: 'prestart',
  blocked: false, blocked_days: 0, intent_score: 40, intent_band: 'Warm', onboarding_completed: true, onboarding_pct: 100, docs: { cv: false, coverLetter: false },
  doc_reviews_pending: 0, live_apps: [], au: { pathway: 'au_vr', label: 'Australian VR', is_au: true, recorded: true, confirmed: true, needs_review: false, stage_label: 'Pre-start', country: 'AU', docs: { cv: true, coverLetter: false } }
};
const T = (id, type, extra) => Object.assign({ id, task_type: type, title: 'Task ' + id, status: 'open', priority: 'normal', due_date: '2026-12-01', stage: 'prestart', stage_label: 'Pre-start', open: true, au: true, owner: 'consultant', owner_then: '', what_to_do: 'Do it.', action: 'complete', can_complete: false, completion: null }, extra || {});
const TASKS = {
  ok: true, read_only: false, viewer_role: 'consultant', referees_on_file: 0, references_ready: false,
  restraint_outcomes: [{ value: 'no_restraint', label: 'No restraint in the current contract' }, { value: 'restraint_applies', label: 'A restraint applies to this role' }],
  tasks: [
    T('t-w12', 'guarantee_checkin', { due_date: '2027-02-14', can_complete: true, completion: { needs: 'note', note_label: 'What the doctor and the practice said' } }),
    T('t-w4', 'guarantee_checkin', { due_date: '2026-12-20', can_complete: true, completion: { needs: 'note', note_label: 'What the doctor and the practice said' } }),
    T('t-ref', 'reference_check', { title: 'Reference checks ' + XSS, can_complete: true, completion: { needs: 'references' } }),
    T('t-res', 'restraint_check', { can_complete: true, completion: { needs: 'outcome' } }),
    T('t-start', 'start_date_tracking', { action: 'start_date', owner_then: 'rso', expected_start_date: '2026-12-14' }),
    T('t-prov', 'provider_number_new_location', { action: 'provider_number', owner: 'rso' }),
    T('t-ind', 'indemnity_certificate', { action: 'document', owner: 'rso' }),
    T('t-cred', 'credentialing_pack', { owner: 'rso' }),
    T('t-inv', 'invoice_due', { action: 'invoice', owner: 'ceo' }),
    T('t-done', 'ahpra_register_check', { open: false, status: 'completed', au: false, owner: '', completed_at: '2026-11-21T00:00:00Z', completed_by: 'consultant@gplink-test.local', action: '' })
  ]
};

describe('the candidate list', () => {
  const m = load();
  const html = m.rowHtml(LIST_ROW);
  it('shows Australia, the stage in words, the pathway chip and a fresh CV tick', () => {
    expect(html).toContain('AUFLAG Australia');
    expect(html).toContain('>Pre-start</span>');
    expect(html).toContain('Australian VR');
    expect(html).toContain('CV ✓');
    expect(html).not.toContain('CV ✗');
    expect(html).not.toMatch(RAW_KEYS);
  });
  it('writes the name as text', () => {
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('the stage filter gains the Australian stages from the server, not from the page markup', () => {
    expect(m.listScaffold()).not.toMatch(/Pre-start|Guarantee|data-au-stages/);
    expect(CAND_SRC).toContain("if (d.au_pathway_enabled === true) auEnable(d.pathway_filters, d.au_stage_filters);");
    const fn = CAND_SRC.slice(CAND_SRC.indexOf('function auEnsureStageFilter()'), CAND_SRC.indexOf('function auEnsureStageFilter()') + 900);
    expect(fn).toContain("if (!auOn || !sel || !auStageFilters.length");
    expect(fn).toContain("group.label = 'Australian pathway';");
    expect(fn).toContain('o.textContent = f.label;');
  });
});

describe('the profile (ADM-28, D15, D25, W3-D24)', () => {
  const m = load();
  const html = m.detailHtml(AU);
  it('the header says Australia and a formatted joined date', () => {
    expect(html).toContain('AUFLAG Australia');
    expect(html).toContain('joined 20 Nov 2026');
    expect(html).not.toContain('2026-11-20T03:04:05');
  });
  it('the Profile card shows the Ahpra number and people by name, never a raw id', () => {
    const card = m.profileCardInner(AU);
    expect(card).toContain('Ahpra registration no.');
    expect(card).toContain('MED0001234567');
    expect(card).toContain('Test Rso (FAKE)');
    expect(card).toContain('Test Consultant (FAKE)');
    expect(card).not.toContain('00000000-0000-4000-a000-0000000000c2');
    expect(card).not.toContain('>GB<');
    const none = m.profileCardInner(Object.assign({}, AU, { au: Object.assign({}, AU.au, { drawer: {} }) }));
    expect(none).toContain('Not on file');
    expect(none).toContain('None yet (assigned at pre-start)');
    expect(none).toContain('Nobody recorded yet');
  });
  it('"Available from" and "Current location", never "Target arrival" or "who\'s moving"', () => {
    const card = m.onboardingCardInner(AU);
    expect(card).toContain('Available from');
    expect(card).toContain('14 Dec 2026 · notice 4 weeks');
    expect(card).toContain('Current location');
    expect(card).toContain('Parramatta NSW 2150');
    expect(card).not.toMatch(/Target arrival|who&#39;s moving|who's moving|Qualification country/);
  });
  it('the whole profile carries no overseas wording, no raw key, and no markup from data', () => {
    expect(html).not.toMatch(OVERSEAS_WORDS);
    expect(html).not.toMatch(RAW_KEYS);
    expect(html).not.toContain('<img src=x');
    expect(html.split('&lt;img src=x onerror=alert(1)&gt;').length).toBeGreaterThan(3);
  });
  it('carries the Australian cards: tasks, pre-start, role eligibility, commencement, segment B, email', () => {
    ['ats-au-pathway-card', 'ats-au-check-card', 'ats-au-tasks-card', 'ats-au-prestart-card', 'ats-au-eligibility-card', 'ats-au-commencement-card', 'ats-au-segment-b-card', 'ats-au-email-card']
      .forEach((id) => expect(html, id).toContain('id="' + id + '"'));
    // a consultant has no admin routes: no email card for them
    expect(load({ consultant: true }).detailHtml(AU)).not.toContain('id="ats-au-email-card"');
  });
  it('a held (not launched) doctor\'s segment card is labelled so', () => {
    const held = Object.assign({}, AU, { au: Object.assign({}, AU.au, { pathway: Object.assign({}, AU.au.pathway, { pathway: 'au_restricted', segment: 'B', launched: false }) }) });
    const h = m.auCardsHtml(held);
    expect(h).toContain('id="ats-au-notlaunched"');
    // WP-29 (deliberate): the label no longer says "Segment B is built but not
    // launched" (segment B as a whole is not held any more). It says the doctor
    // is held, why when the server says why, and what that means. A payload
    // without the server's hold answer (this one) keeps the old reading:
    // not launched = held.
    expect(h).toContain('<div class="ats-au-notlaunched" id="ats-au-notlaunched">Held. They are shown no roles and cannot apply themselves. Nothing below is sent to them automatically. Staff put them forward by hand.</div>');
    expect(m.auCardsHtml(AU)).not.toContain('ats-au-notlaunched');
    const withHold = (extra) => Object.assign({}, AU, { au: Object.assign({}, AU.au, { pathway: Object.assign({}, AU.au.pathway, { pathway: 'au_restricted', segment: 'B', launched: false }, extra) }) });
    // The server's answer wins over `launched`: a segment B doctor who is a
    // vocationally registered GP is not held, and the card does not say so.
    const notHeld = m.auCardsHtml(withHold({ selfServiceHeld: false, holdKind: null, holdWhy: '' }));
    expect(notHeld).not.toContain('ats-au-notlaunched');
    expect(notHeld).toContain('Restricted, not held: they are shown the roles they could work in');
    // Held, with the reason in words.
    const nonVr = m.auCardsHtml(withHold({ selfServiceHeld: true, holdKind: 'review', holdWhy: 'non_vr' }));
    expect(nonVr).toContain('id="ats-au-notlaunched">Held. Not vocationally registered. Non-VR placements are switched off, so they are shown no roles. Nothing below is sent to them automatically. Staff put them forward by hand.</div>');
    // A registrar is not placed: staff are not told to put them forward by hand.
    const registrar = m.auCardsHtml(withHold({ pathway: 'au_registrar', segment: 'C', selfServiceHeld: true, holdKind: 'registrar', holdWhy: 'registrar' }));
    expect(registrar).toContain('id="ats-au-notlaunched">Held. GP registrar. GP Link does not place registrars:');
    expect(registrar).toContain('Nothing below is sent to them automatically.</div>');
    expect(registrar).not.toContain('Staff put them forward by hand.');
  });
});

describe('applications: consent on file, interview finished, the placement line', () => {
  const m = load();
  const html = m.applicationsCardInner(AU);
  it('says per application whether consent to share is on file, and how it was given', () => {
    expect(html).toContain('data-au-consent="app-1"');
    expect(html).toMatch(/On file<\/span>[^]*recorded by staff \(verbal\), 22 Nov 2026/);
    expect(html).toMatch(/data-au-consent="app-2"[^]*Not on file/);
    const unreadable = m.auConsentLineHtml(Object.assign({}, AU, { au: Object.assign({}, AU.au, { drawer: { app_consent: null } }) }), AU.apps[0]);
    expect(unreadable).toContain('Could not be read');
  });
  it('a booked interview can be marked finished (W3-D22)', () => {
    expect(html).toContain('class="ats-btn ats-btn-sm ats-au-int-finished" data-app-id="app-1"');
    expect(m.auInterviewFinishHtml(AU, AU.apps[1])).toBe('');
    expect(CAND_SRC).toContain("ATS.api('/api/ats/interview/complete', { method: 'POST', body: { applicationId: String(appId) } })");
  });
  it('the placement can be recorded once the card is at Offer (found on the walk)', () => {
    expect(m.auPlacementLineHtml(AU, AU.apps[1])).toContain('ats-mark-placement');
    expect(m.auPlacementLineHtml(AU, AU.apps[1])).toContain('data-placement-app-id="app-2"');
    expect(m.auPlacementLineHtml(AU, AU.apps[0])).toBe(''); // still at Interview
    expect(m.auPlacementLineHtml(AU, Object.assign({}, AU.apps[1], { ats_stage: 'hired' }))).toBe('');
    expect(m.auPlacementLineHtml(AU, Object.assign({}, AU.apps[1], { offer: { status: 'sent' } }))).toBe(''); // drawn by the existing line
  });
  it('none of it is drawn for an overseas doctor', () => {
    expect(m.auConsentLineHtml(parity.UK_CANDIDATE, AU.apps[0])).toBe('');
    expect(m.auInterviewFinishHtml(parity.UK_CANDIDATE, AU.apps[0])).toBe('');
    expect(m.auPlacementLineHtml(parity.UK_CANDIDATE, AU.apps[1])).toBe('');
  });
  it('the job title is written as text', () => {
    expect(html).not.toContain('<img src=x');
  });
});

describe('tasks on the case are actionable for the staff who own them (W3-D22)', () => {
  const m = load({ consultant: true });
  const html = m.auTasksCardInner(TASKS);
  it('open tasks in date order: week 4 before week 12', () => {
    expect(html.indexOf('Task t-w4')).toBeLessThan(html.indexOf('Task t-w12'));
    expect(html.indexOf('Task t-w12')).toBeLessThan(html.indexOf('Task t-done'));
  });
  it('each task says its kind and owner in words, never a raw key', () => {
    expect(html).toContain('Guarantee check-in · Pre-start · owner: Consultant');
    expect(html).toContain('Notice period and start date · Pre-start · owner: Consultant, then RSO');
    expect(html).toContain('owner: CEO');
    expect(html).not.toMatch(RAW_KEYS);
    expect(html).not.toContain('Read only');
  });
  it('a consultant gets "Mark done" on what the server says they may complete, and the right form for the rest', () => {
    ['t-w4', 't-w12', 't-ref', 't-res'].forEach((id) => expect(html, id).toContain('class="ats-btn ats-btn-sm ats-au-task-open" data-task-id="' + id + '" data-form="complete">Mark done'));
    expect(html).toContain('data-task-id="t-start" data-form="start_date">Save start date');
    expect(html).toContain('data-task-id="t-prov" data-form="provider_number">Record number');
    expect(html).toContain('Closes by itself when the certificate is approved.');
    expect(html).toContain('The CEO records the invoice as sent.');
    expect(html).toContain('The RSO completes this from the admin page.');
    expect(html).not.toContain('ats-au-task-ceo-complete');
  });
  it('the CEO may also tick an RSO task; a viewer with nothing to do is told so', () => {
    const ceo = load().auTasksCardInner(Object.assign({}, TASKS, { viewer_role: 'ceo' }));
    expect(ceo).toContain('class="ats-btn ats-btn-ghost ats-btn-sm ats-au-task-ceo-complete" data-task-id="t-cred"');
    expect(ceo).toContain('Mark invoice sent');
    const nothing = m.auTasksCardInner({ ok: true, read_only: true, viewer_role: 'consultant', tasks: [TASKS.tasks[9]] });
    expect(nothing).toContain('Nothing for you to complete');
    expect(nothing).not.toMatch(/<button/);
  });
  it('the forms: a reason when no referees are on file, an outcome for the restraint check, a date field for the start date', () => {
    const by = (id) => TASKS.tasks.filter((t) => t.id === id)[0];
    const ref = m.auTaskFormHtml(by('t-ref'), 'complete', TASKS);
    expect(ref).toContain('No referees are on file yet (0 of 2)');
    expect(ref).toContain('data-field="reason"');
    const ready = m.auTaskFormHtml(by('t-ref'), 'complete', Object.assign({}, TASKS, { references_ready: true, referees_on_file: 2 }));
    expect(ready).not.toContain('data-field="reason"');
    const res = m.auTaskFormHtml(by('t-res'), 'complete', TASKS);
    expect(res).toContain('data-field="outcome"');
    expect(res).toContain('A restraint applies to this role');
    const start = m.auTaskFormHtml(by('t-start'), 'start_date', TASKS);
    expect(start).toContain('<input type="date"');
    expect(start).toContain('value="2026-12-14"');
    expect(m.auTaskFormHtml(by('t-prov'), 'provider_number', TASKS)).toContain('data-field="provider_number"');
    expect(CAND_SRC).not.toMatch(/window\.prompt\([^)]*start date/i);
  });
  it('a task title containing markup is written as text', () => {
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Reference checks &lt;img src=x onerror=alert(1)&gt;');
  });
  it('completing goes to the server route that decides, and the lists are dropped from the cache afterwards', () => {
    expect(CAND_SRC).toContain("path = '/api/ats/candidate/task/complete';");
    expect(CAND_SRC).toContain("'/api/ats/candidate/tasks', '/api/admin/au/prestart', '/api/ats/candidate/role-eligibility', '/api/ceo/candidate', '/api/ceo/candidates'");
    ['/api/ats/candidate/tasks?case_id=', '/api/admin/au/prestart?case_id=', '/api/ats/candidate/role-eligibility?user_id=', '/api/admin/email-templates?case_id=']
      .forEach((p) => expect(CAND_SRC, p).toContain("ATS.swr('" + p));
  });
});

describe('the pre-start panel', () => {
  const m = load();
  const view = {
    ok: true, placement: { key: 'app-1', practice_name: 'Test Metro Practice (FAKE) ' + XSS, start_date: '2026-12-14' }, prestart_complete: false,
    prestart_counts: { done: 5, total: 8 }, documents_outstanding: ['au_right_to_work', 'au_wwcc'],
    provider_number: { number: '123456AB', location_name: 'Parramatta' },
    doctor_details: { referees: [{ name: 'Dr Referee One (FAKE) ' + XSS, role: 'Practice principal', relationship: 'Supervisor', email: 'ref.one@gplink-test.local', phone: '', agreedToContact: true, atCurrentPractice: true }],
      noticeGiven: true, noticeGivenDate: '2026-11-16', existingProviderNumbers: [{ number: '654321BA', location: 'Old practice' }], prescriberNumber: '1234567' }
  };
  const html = m.auPrestartCardInner(view);
  it('shows the placement, the count, the referees, notice and the provider number', () => {
    expect(html).toContain('5 of 8 done');
    expect(html).toContain('14 Dec 2026');
    expect(html).toContain('Referees (1 of 2)');
    expect(html).toContain('Practice principal');
    expect(html).toContain('works at the doctor’s CURRENT practice: ask the doctor before calling');
    expect(html).toContain('Yes, on 16 Nov 2026');
    expect(html).toContain('123456AB · Parramatta');
    expect(html).toContain('654321BA (Old practice)');
  });
  it('lists the documents still needed by their names and offers to ask the doctor', () => {
    // (the slot's own label when the profile is open; plain words otherwise, never the key)
    expect(html).toContain('Right to work');
    expect(html).toContain('Wwcc');
    expect(html).not.toContain('au_right_to_work ·');
    expect(html).toContain('id="ats-au-ask-doctor" data-items="au_right_to_work,au_wwcc"');
  });
  it('says so plainly when there is no placement yet, and writes names as text', () => {
    expect(m.auPrestartCardInner({ ok: true, placement: null })).toContain('No placement is recorded yet');
    expect(m.auPrestartCardInner(null)).toContain('Loading');
    expect(html).not.toContain('<img src=x');
  });
});

describe('role eligibility (WP-08\'s rule, now with a screen)', () => {
  const m = load();
  const data = { ok: true, hold: false, roles: [
    { career_role_id: 'r1', title: 'DPA - Dubbo', practice_name: 'Test Regional Practice (FAKE)', eligible: true, can_self_apply: true, reasons: [], fields: { dpa_status: 'yes', vr_required: true } },
    { career_role_id: 'r2', title: 'Non-DPA ' + XSS, practice_name: 'Test Metro Practice (FAKE)', eligible: false, reasons: [{ code: 'dpa_restricted', message: 'The doctor is limited to DPA roles (19AB not cleared by staff) and this role is not in a DPA.' }, { code: 'some_new_code' }], fields: { dpa_status: 'no' } }
  ] };
  it('for a chosen role says whether the doctor fits, and why not, in words', () => {
    const first = m.auEligibilityCardInner(data, '');
    expect(first).toContain('Fits 1 of 2 open roles');
    expect(first).toContain('This doctor fits this role');
    const second = m.auEligibilityCardInner(data, 'r2');
    expect(second).toContain('Does not fit this role');
    expect(second).toContain('limited to DPA roles');
    expect(second).toContain('Some new code'); // a code with no sentence is still words, not a key
    expect(second).not.toContain('some_new_code');
    expect(second).toContain('In a DPA: No');
    expect(second).not.toContain('<img src=x');
  });
  it('a held doctor is labelled as held', () => {
    // WP-29 (deliberate): "This pathway is not launched" became a sentence
    // about the DOCTOR (the hold is no longer per pathway), and a registrar
    // has their own.
    const heldCard = m.auEligibilityCardInner(Object.assign({}, data, { hold: true }), '');
    expect(heldCard).toContain('<span class="ats-pill amber">Held</span> This doctor is shown no roles and cannot apply themselves. Staff may put them forward by hand.');
    expect(m.auEligibilityCardInner(Object.assign({}, data, { hold: true, hold_kind: 'review' }), '')).toBe(heldCard);
    const registrarCard = m.auEligibilityCardInner(Object.assign({}, data, { hold: true, hold_kind: 'registrar' }), '');
    expect(registrarCard).toContain('<span class="ats-pill amber">Held</span> GP registrar: GP Link does not place registrars. They are shown no roles and cannot apply.');
    expect(registrarCard).not.toContain('put them forward by hand');
    expect(m.auEligibilityCardInner(data, '')).not.toContain('ats-pill amber">Held');
  });
});

describe('documents on the drawer (ADM-13)', () => {
  const m = load();
  const html = m.docsCardInner(AU);
  it('the same "N of M" as the RSO page, the expiry in words, a way to set it', () => {
    expect(html).toContain('2 of 8 docs · 1 approved');
    expect(html).toContain('Expires 30 Jun 2027');
    expect(html).toContain('class="ats-btn ats-btn-ghost ats-btn-sm ats-au-doc-expiry"');
    expect(html).toContain('data-au-key="au_indemnity_certificate"');
    expect(html.split('ats-au-doc-expiry').length - 1).toBe(1); // not for a slot with no file / no expiry
    expect(html).toContain('ats-au-doc-view');
    expect(html).toContain('data-slot="au:au_right_to_work"');
    expect(html).not.toContain('<img src=x');
  });
});

describe('Leads, Matching, Meetings, Contracts', () => {
  it('no "Call now with Hazel" for an Australian lead: follow up personally', () => {
    const leads = parity.loadCeoModule('js/ceo-ats-leads.js', ['actionsHtml']);
    const html = leads.actionsHtml(Object.assign({}, parity.UK_LEAD, { segment: 'au_vr', country: 'au', phone: '+61491570156' }));
    expect(html).toContain('Hazel does not ring Australian GPs: follow up personally');
    expect(html).not.toMatch(/data-lead-act="call"|Call now with Hazel|Resume Hazel|Pause Hazel|Schedule a call-back/);
    expect(leads.actionsHtml(parity.UK_LEAD)).toContain('Call now with Hazel');
  });
  it('the matching board gives the role-rule block codes readable reasons', () => {
    const match = parity.loadCeoModule('js/ceo-ats-matching.js', ['mbBlockLabels']);
    const labels = match.mbBlockLabels({ reasons: ['pathway_on_hold', 'vr_required', 'registrars_not_accepted', 'supervised_not_accepted', 'role_dpa_unknown', 'dpa_ineligible'] });
    labels.forEach((l) => expect(l).not.toMatch(/_|^pathway on hold$|^vr required$/));
    // WP-29 (deliberate): was 'Pathway not launched: put forward by hand' (the
    // hold is about the doctor now), and the new sponsorship reason has words.
    expect(labels[0]).toBe('Doctor is held: put forward by hand');
    expect(labels[5]).toBe('Not DPA eligible');
    expect(match.mbBlockLabels({ reasons: ['sponsorship_not_offered'] })).toEqual(['Practice does not offer sponsorship']);
  });
  it('the Meetings tab offers "Mark interview finished" only on the rows the server marks', () => {
    const mtg = parity.loadCeoModule('js/ceo-ats-meetings.js', ['rowHtml']);
    const row = parity.UK_MEETINGS[0];
    expect(mtg.rowHtml(Object.assign({}, row, { au_can_mark_finished: true }), false)).toContain('class="ats-btn ats-btn-sm mtg-finished-btn" data-app-id="app-uk-1"');
    expect(mtg.rowHtml(row, false)).not.toContain('mtg-finished-btn');
    expect(mtg.rowHtml(Object.assign({}, row, { au_can_mark_finished: true, status: 'completed' }), false)).not.toContain('mtg-finished-btn');
    expect(read('js/ceo-ats-meetings.js')).toContain("ATS.api('/api/ats/interview/complete', { method: 'POST', body: { applicationId: String(finAppId) } })");
  });
  it('the Contracts tab shows the server\'s sentence to a consultant', () => {
    expect(read('js/ceo-ats-contracts.js')).toContain("if (d && d.ok === false && d.code === 'ceo_only' && d.message) { listEl.innerHTML = ATS.emptyHtml(d.message); return; }");
  });
});

describe('the email card (WP-17\'s Australian templates, now on the CEO dashboard)', () => {
  const m = load();
  it('offers a template picker, a subject and a message, and refuses to send a placeholder', () => {
    const html = m.auEmailCardInner(AU);
    expect(html).toContain('id="ats-au-email-template"');
    expect(html).toContain('id="ats-au-email-send"');
    expect(CAND_SRC).toContain("auEmailTemplates = (d && d.ok && d.audience === 'au' && Array.isArray(d.templates)) ? d.templates : [];");
    expect(CAND_SRC).toMatch(/if \(\/\\\{\\\{\\w\+\\\}\\\}\/\.test\(subject \+ ' ' \+ body\)\)/);
    expect(CAND_SRC).toContain("ATS.api('/api/admin/email/send', { method: 'POST', body: { to: c.email, subject: subject, bodyText: body, caseId: c.case_id, newThread: true } })");
  });
});

describe('with the switch off, or for an overseas doctor, nothing Australian is drawn or asked for', () => {
  it('the Australian cards are empty until the server says the switch is on', () => {
    const off = load({ switchOff: true });
    expect(off.auCardsHtml(AU)).toBe('');
    expect(off.rowHtml(Object.assign({}, LIST_ROW, { au: undefined, country: 'United Kingdom' }))).toContain('UKFLAG United Kingdom');
    // the Australian profile branches all hang off the switch too
    expect(off.profileCardInner(AU)).toContain('Registration no.');
    expect(off.onboardingCardInner(AU)).toContain('Target arrival');
  });
  it('no request is made by rendering, and every Australian loader checks the switch first', () => {
    const m = load();
    m.detailHtml(AU); m.rowHtml(LIST_ROW);
    expect(m.calls.api).toEqual([]);
    expect(m.calls.swr).toEqual([]);
    ['auLoadTasks', 'auLoadPrestart', 'auLoadEligibility'].forEach((name) => {
      const start = CAND_SRC.indexOf('function ' + name + '(c) {');
      expect(CAND_SRC.slice(start, start + 160), name).toContain('if (!auOn ||');
    });
  });
});

describe('the CEO page\'s own GP file (Registration tab)', () => {
  it('the four Australian stages get their words from the shared helper, so none is printed raw', () => {
    expect(CEO).toContain('if (!STAGE_LABELS[st.key]) STAGE_LABELS[st.key] = st.label;');
    expect(CEO).toContain("['prestart', 'commenced', 'guarantee'].forEach(function (k) { PARITY_STAGE_LABELS[k] = window.GPAuStaff.stageLabel(k, true); });");
    // the page's own maps are untouched for every stage they already had
    expect(CEO).toContain("var STAGE_LABELS = { career: 'Secure Placement', myintealth: 'MyIntealth', amc: 'AMC Portfolio', ahpra: 'AHPRA Registration', pbs: 'PBS & Medicare', commencement: 'Commencement', complete: 'Complete', visa: 'Visa', practice_contact: 'Medical Practice Contact' };");
  });
  it('an Australian case reads AU, carries a pathway badge, and is offered a pre-start call', () => {
    expect(CEO).toContain("var gpCountry = auCaseIsAu(cs) ? 'AU' : (cs.registration_country || cs.gp_selected_country || '');");
    expect(CEO).toContain('data-au-pathway-badge');
    expect(CEO).toContain('<option value="prestart" selected>Pre-start call</option>');
    expect(CEO).toContain("var CEO_ZOOM_STAGES = ['myintealth', 'amc', 'ahpra'];");
  });
});

describe('cache-busters', () => {
  it('every changed script and the stylesheet moved, and the stylesheet is not behind the Candidates script', () => {
    const v = (re) => CEO.match(re)[1];
    const cand = v(/ceo-ats-candidates\.js\?v=(\d{8}[a-z])/);
    expect(cand >= '20261122c').toBe(true);
    expect(v(/ceo-ats\.css\?v=(\d{8}[a-z])/) >= cand).toBe(true);
    expect(v(/ceo-ats-leads\.js\?v=(\d{8}[a-z])/) >= '20261122b').toBe(true);
    expect(v(/ceo-ats-contracts\.js\?v=(\d{8}[a-z])/) >= '20261122b').toBe(true);
    expect(v(/ceo-ats-meetings\.js\?v=(\d{8}[a-z])/) >= '20261122a').toBe(true);
    expect(v(/ceo-ats-matching\.js\?v=(\d{8}[a-z])/) >= '20261122a').toBe(true);
    expect(v(/guide-panel\.js\?v=(\d{8}[a-z])/)).toBe(read('pages/admin.html').match(/guide-panel\.js\?v=(\d{8}[a-z])/)[1]);
    expect(CAND_SRC.match(/au-commencement\.js\?v=(\d{8}[a-z])/)[1]).toBe(read('pages/admin.html').match(/au-commencement\.js\?v=(\d{8}[a-z])/)[1]);
    expect(read('sw.js')).toMatch(/var VERSION = "2026112[2-9][a-z]"/);
  });
  it('the guide panel frames only http(s) addresses and the app\'s own guide pages', () => {
    const src = read('js/guide-panel.js');
    expect(src).toContain("return /^\\/api\\/admin\\/guide\\/au\\/[a-z0-9-]{1,40}$/.test(String(u || ''));");
    expect(src).toContain('if (isOwnGuidePage(raw)) return raw;');
    expect(src).toContain("(canEdit && this.auGuide && this.auGuide.seeded !== true)");
    expect(src).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });
});
