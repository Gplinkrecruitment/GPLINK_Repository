'use strict';
/**
 * WP-18: everything the owner needs to get the Australian WhatsApp templates
 * approved, in one place. Pure, no I/O.
 *
 *   SUBMIT          one entry per NEW template: what to type into DoubleTick
 *   REUSED          what each reused existing template carries
 *   OWNER_CHOICE    the five existing templates that say "Registration
 *                   Support Officer"
 *   SUPERSEDED      drafts written earlier that no longer need submitting
 *   MESSAGE_TABLE   every Australian message with a WhatsApp leg: which row
 *                   carries it, and the email that carries it meanwhile
 *   renderSheet()   docs/au-gp/whatsapp-templates.md, word for word
 *
 * The wording of the lead templates lives in lib/au-lead-copy.js and of the
 * lifecycle ones in lib/au-messages.js; this file only adds what DoubleTick
 * asks for on top (category, sample values, buttons). Which template a row
 * points at, and whether it is on, is lib/au-whatsapp-templates.js alone.
 *
 * Regenerate the sheet: WP18_WRITE_SHEET=1 npx vitest run tests/au-wp18-sheet.test.js
 */

const wa = require('./au-whatsapp-templates.js');
const auLeadCopy = require('./au-lead-copy.js');
const auMessages = require('./au-messages.js');

const APP = 'https://app.mygplink.com.au';
// Sample values to type into DoubleTick. All obviously fake.
const S = Object.freeze({
  first: 'Sam',
  practice: 'Test Metro Practice',
  time: 'Thursday 14 January, 10:30 am (Perth time)',
  book: APP + '/start?lead=sample#book',
  join: 'https://zoom.us/j/0000000000',
  contact: 'Alex',
  doctor: 'Dr Jane Citizen',
  date: '15 February 2027',
  staff: 'Jordan',
  appId: '00000000-0000-4000-8000-000000000000'
});

const lead = function (key) { return auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES[key].body; };
const life = function (key) {
  const t = auMessages.LIFECYCLE_WHATSAPP_TEMPLATES.filter(function (x) { return x.key === key; })[0];
  return t.body;
};
const url = function (text, address, sample) { return { type: 'URL', text: text, url: address, sample: sample || '' }; };

/** One entry per row of AU_WHATSAPP_TEMPLATES whose source is a NEW template. */
const SUBMIT = Object.freeze([
  // ── The lead funnel ──
  { key: 'lead_hello_5m', group: 'Leads', category: 'MARKETING', body: lead('lead_hello_5m'),
    variables: [['first name', S.first], ['booking link', S.book]], buttons: [],
    turnsOn: 'N01: the hello, about 5 minutes after an Australian GP fills in the form.' },
  { key: 'lead_check_in_1h', group: 'Leads', category: 'MARKETING', body: lead('lead_check_in_1h'),
    variables: [['first name', S.first], ['booking link', S.book]], buttons: [],
    turnsOn: 'N01: the check-in, an hour after the form.' },
  { key: 'lead_day_after_24h', group: 'Leads', category: 'MARKETING', body: lead('lead_day_after_24h'),
    variables: [['first name', S.first], ['booking link', S.book]], buttons: [],
    turnsOn: 'N01: the last note, a day after the form.' },
  { key: 'lead_call_booked', group: 'Leads', category: 'UTILITY', body: lead('lead_call_booked'),
    variables: [['first name', S.first], ['the time on their own clock', S.time]], buttons: [],
    turnsOn: 'N02: "your call is booked".' },
  { key: 'lead_call_reminder', group: 'Leads', category: 'UTILITY', body: lead('lead_call_reminder'),
    variables: [['first name', S.first], ['the time on their own clock', S.time], ['link to join', S.join]], buttons: [],
    turnsOn: 'N02: the reminder the day before the call.' },
  { key: 'lead_signed_up', group: 'Leads', category: 'MARKETING', body: lead('lead_signed_up'),
    variables: [['first name', S.first]], buttons: [],
    turnsOn: 'N04: the welcome for a lead who creates an account.',
    note: 'Meta classed the existing welcome as MARKETING; expect the same here.' },
  // ── Before a placement ──
  { key: 'match_accepted', group: 'Matching, interviews and the contract', category: 'UTILITY', body: life('match_accepted'),
    variables: [['first name', S.first], ['practice name', S.practice]], buttons: [],
    turnsOn: '"Thanks for accepting your match" (N09).' },
  { key: 'interview_times_ready', group: 'Matching, interviews and the contract', category: 'UTILITY', body: life('interview_times_ready'),
    variables: [['first name', S.first], ['practice name', S.practice]],
    buttons: [url('Choose your time', APP + '/pages/secure-interview?applicationId={{1}}', S.appId)],
    turnsOn: '"Your interview times are ready".' },
  { key: 'interview_confirmed', group: 'Matching, interviews and the contract', category: 'UTILITY', body: life('interview_confirmed'),
    variables: [['first name', S.first], ['practice name', S.practice], ['the time on the doctor\'s own clock', S.time], ['link to join', S.join]], buttons: [],
    turnsOn: '"Your interview is confirmed", to the doctor.' },
  { key: 'interview_confirmed_practice', group: 'Matching, interviews and the contract', category: 'UTILITY', body: life('interview_confirmed_practice'),
    variables: [['contact name', S.contact], ['the doctor', S.doctor], ['the time on the practice\'s own clock', 'Thursday 14 January, 1:30 pm (Sydney time)'], ['link to join', S.join]], buttons: [],
    turnsOn: '"Your interview is confirmed", to the practice, when the candidate is an Australian GP.' },
  { key: 'contract_ready', group: 'Matching, interviews and the contract', category: 'UTILITY', body: life('contract_ready'),
    variables: [['first name', S.first], ['practice name', S.practice]],
    buttons: [url('Complete agreement', APP + '/pages/offer-review?applicationId={{1}}', S.appId)],
    turnsOn: '"Your contract is ready to sign".' },
  // ── After a placement ──
  { key: 'placement_secured', group: 'Placement and the first week', category: 'UTILITY',
    body: 'Hi {{1}}, congratulations: your placement at {{2}} is secured.\n\nYour pre-start checklist is in the GP Link app: your start date, a Medicare provider number for the new practice location, your indemnity certificate and your credentialing documents.\n\nTap below to open it. Our team will be in touch to help with each step.',
    variables: [['first name', S.first], ['practice name', S.practice]],
    buttons: [url('Open my checklist', APP + '/pages/prestart')],
    turnsOn: 'N11: "your placement is secured".',
    note: 'The button is a fixed page: there is no button variable to fill in.' },
  { key: 'rso_welcome', group: 'Placement and the first week', category: 'UTILITY', body: life('rso_welcome'),
    variables: [['doctor\'s first name', S.first], ['the team member\'s first name', S.staff], ['the same name again, as the sign-off', S.staff]], buttons: [],
    turnsOn: 'The hello from the team member assigned to the doctor\'s case.' },
  { key: 'cleared_to_start', group: 'Placement and the first week', category: 'UTILITY', body: life('cleared_to_start'),
    variables: [['first name', S.first], ['practice name', S.practice], ['the start date', S.date]], buttons: [],
    turnsOn: 'N16: "you are cleared to start".', note: 'Optional: the email and the in-app notice already carry this one.' },
  { key: 'commencement_checkin', group: 'Placement and the first week', category: 'UTILITY',
    body: 'Hi {{1}}, you have finished your first week at {{2}}. We hope it went well.\n\nHow are you settling in? If anything is not as you expected, reply here or message us in the GP Link app and we will help sort it out with the practice.',
    variables: [['first name', S.first], ['practice name', S.practice]], buttons: [],
    turnsOn: 'N18: the first-week check-in, to the doctor.', note: 'It asks an open question, so Meta may class it as MARKETING. That is fine.' },
  { key: 'commencement_checkin_practice', group: 'Placement and the first week', category: 'UTILITY',
    body: 'Hi {{1}}, {{2}} has now completed the first week at your practice. We hope it has gone well.\n\nHow are they settling in? If anything needs attention, reply here or to our email and we will help.',
    variables: [['contact name', S.contact], ['the doctor', S.doctor]], buttons: [],
    turnsOn: 'N18: the first-week check-in, to the practice.', note: 'It asks an open question, so Meta may class it as MARKETING. That is fine.' },
  // ── Sign-up (for a doctor who did not come through the lead form) ──
  { key: 'welcome', group: 'Sign-up', category: 'UTILITY', body: life('welcome'),
    variables: [['first name', S.first]], buttons: [url('Finish my profile', APP + '/pages/onboarding')],
    turnsOn: 'N04: the welcome for an Australian GP who signs up directly.',
    note: 'A doctor who came through the lead form and whose `lead_signed_up` template is also on would get two welcomes. Switch on one of the pair, or both only if that is acceptable.' },
  { key: 'onboarding_nudge', group: 'Sign-up', category: 'UTILITY', body: life('onboarding_nudge'),
    variables: [['first name', S.first]], buttons: [url('Continue my profile', APP + '/pages/onboarding')],
    turnsOn: 'N05: "finish your profile" reminders.',
    note: 'A doctor who came through the lead form already gets the existing set-up nudge (section 1). With this one on as well they would get both. Leave it off unless you want direct sign-ups nudged on WhatsApp too.' }
]);

/** What each reused existing template carries, and what the app fills in. */
const REUSED = Object.freeze({
  practice_intro: { carries: 'N10: the introduction a practice gets when we put an Australian GP forward (no CV to attach).', fills: 'contact name; practice name; the Australian introduction paragraph (for example "Dr Jane Citizen is a vocationally registered GP (FRACGP) based in Victoria..."); the button opens the same decision page as the email.' },
  practice_intro_cv: { carries: 'N10: the same introduction with the CV attached.', fills: 'the same three values, the CV as the attached document, and the same button.' },
  lead_call_hour_before: { carries: 'N02: the reminder about an hour before the call.', fills: 'first name; the clock time with the city named, for example "10:30 am (Perth time)"; the link to join.' },
  lead_call_starting: { carries: 'N02: "your call starts in 5 minutes".', fills: 'first name; the link to join.' },
  lead_call_missed: { carries: 'N02: the note after a missed call.', fills: 'first name; the link to pick a new time.' },
  lead_post_call_onboard: { carries: 'N03: "set up your account", ten minutes after a call the doctor attended.', fills: 'first name; the sign-up link.' },
  lead_onboarding_incomplete: { carries: 'N05: "finish your set-up", a day after a lead signs up.', fills: 'first name.' },
  match_invitation: { carries: 'N09: "you have been matched with a practice".', fills: 'first name; the practice and place; the "held until" line; the link to the match.' },
  account_released: { carries: '"Your account has been released" (staff release an account from review).', fills: 'first name. The button opens the job board.' }
});

/** The owner's choice: existing templates that say "Registration Support Officer". */
const OWNER_CHOICE = Object.freeze({
  match_accepted_existing: { message: '"Thanks for accepting your match"', says: '"Your Registration Support Officer is now arranging your interview"' },
  interview_times_ready_existing: { message: '"Your interview times are ready"', says: '"your Registration Support Officer will be on the call with you, so you are never in the room alone"' },
  interview_confirmed_existing: { message: '"Your interview is confirmed" (to the doctor)', says: '"Your Registration Support Officer will be on the call with you"' },
  interview_confirmed_practice_existing: { message: '"Your interview is confirmed" (to the practice)', says: '"A GP Link Registration Support Officer will also be on the call"' },
  contract_ready_existing: { message: '"Your contract is ready to sign"', says: '"reply here and your Registration Support Officer will help"' }
});

/** Drafts written earlier that do NOT need submitting. */
const SUPERSEDED = Object.freeze([
  { draft: 'gp_link_au_practice_candidate_intro', by: 'gp_link_practice_candidate_intro' },
  { draft: 'gp_link_au_practice_candidate_intro_cv', by: 'gp_link_practice_candidate_intro_cv' },
  { draft: 'gp_link_au_lead_call_1h', by: 'gp_link_consult_call_1h' },
  { draft: 'gp_link_au_lead_call_starting_5m', by: 'gp_link_consult_call_starting_5m' },
  { draft: 'gp_link_au_lead_missed_call', by: 'gp_link_consult_missed_call' },
  { draft: 'gp_link_au_lead_post_call', by: 'gp_link_consult_post_call_onboard_v3' },
  { draft: 'gp_link_au_lead_onboarding_nudge', by: 'gp_link_consult_onboarding_nudge' },
  // Never drafted in full: the existing match invitation was confirmed neutral.
  { draft: 'gp_link_au_match_invitation', by: 'gp_link_app_match_invitation' }
]);

const T16 = 'tests/au-wp16-lead-copy-server.test.js';
const T16R = 'tests/au-wp16-reminders-and-golive-server.test.js';
const T17W = 'tests/au-wp17-welcome-onboarding-server.test.js';
const T17P = 'tests/au-wp17-prestart-messages-server.test.js';
const T18 = 'tests/au-wp18-template-guard.test.js';

/**
 * Every Australian message that has a WhatsApp leg. `key` is its row in
 * lib/au-whatsapp-templates.js (null = email only by design). `email` is what
 * carries the message while the WhatsApp is off; `proof` is the test that
 * shows that email being sent with the WhatsApp skipped.
 */
const MESSAGE_TABLE = Object.freeze([
  { message: 'N01 hello (5 minutes)', to: 'lead', key: 'lead_hello_5m', email: 'The 5-minute note goes by email instead', proof: [T16, 'a NEW Australian lead with all three notes overdue gets ONE per run, in order; the UK lead beside them is chased as ever'] },
  { message: 'N01 check-in (1 hour)', to: 'lead', key: 'lead_check_in_1h', email: 'The 1-hour email', proof: [T16, 'a NEW Australian lead with all three notes overdue gets ONE per run, in order; the UK lead beside them is chased as ever'] },
  { message: 'N01 last note (24 hours)', to: 'lead', key: 'lead_day_after_24h', email: 'The 24-hour email', proof: [T16, 'a NEW Australian lead with all three notes overdue gets ONE per run, in order; the UK lead beside them is chased as ever'] },
  { message: 'N02 call booked', to: 'lead', key: 'lead_call_booked', email: '"Your call is booked" email', proof: [T16, '"your call is booked": Australian wording, the time on their own clock, sent at any hour (they just booked)'] },
  { message: 'N02 reminder, the day before', to: 'lead', key: 'lead_call_reminder', email: 'The day-before reminder email', proof: [T16R, 'the day before: the Australian email, on Perth time; the WhatsApp is a named skip, recorded once'] },
  { message: 'N02 reminder, an hour before', to: 'lead', key: 'lead_call_hour_before', email: 'The one-hour reminder email also goes', proof: [T18, 'an Australian-segment lead'] },
  { message: 'N02 "starts in 5 minutes"', to: 'lead', key: 'lead_call_starting', email: '(WhatsApp only, as for an overseas lead)', proof: [T18, 'an Australian-segment lead'] },
  { message: 'N02 missed call', to: 'lead', key: 'lead_call_missed', email: 'The missed-call email also goes', proof: [T18, 'an Australian-segment lead'] },
  { message: 'N03 after the call: set up your account', to: 'lead', key: 'lead_post_call_onboard', email: 'The after-the-call email also goes', proof: [T18, 'an Australian-segment lead'] },
  { message: 'N04 welcome (a lead who signs up)', to: 'lead', key: 'lead_signed_up', email: 'The Australian welcome email (N04)', proof: [T17W, 'a sign-up whose address belongs to an Australian-segment lead gets the Australian welcome, once, and never the overseas one'] },
  { message: 'N04 welcome (direct sign-up)', to: 'doctor', key: 'welcome', email: 'The Australian welcome email (N04)', proof: [T17W, 'a brand-new sign-up nobody knows yet: nothing is sent at sign-up; "yes" to the first question sends the Australian welcome, exactly once under a double submit'] },
  { message: 'N05 finish your set-up (a lead who signed up)', to: 'lead', key: 'lead_onboarding_incomplete', email: 'The "finish your profile" reminder emails (N05) also go', proof: [T18, 'an Australian-segment lead'] },
  { message: 'N05 finish your profile', to: 'doctor', key: 'onboarding_nudge', email: 'The "finish your profile" reminder emails (N05)', proof: [T17W, 'an Australian doctor part-way through gets the Australian reminder with their own step label; an overseas doctor still gets the overseas one'] },
  { message: 'N09 match invitation', to: 'doctor', key: 'match_invitation', email: 'The match email also goes', proof: [T18, 'matchInvitation'] },
  { message: 'N09 thanks for accepting your match', to: 'doctor', key: 'match_accepted', email: '"Application received" email (and the same words as a plain WhatsApp when the doctor has written to us in the last day)', proof: [T18, 'matchAccepted'] },
  { message: 'Interview times are ready', to: 'doctor', key: 'interview_times_ready', email: '"Your interview times are ready" email', proof: [T18, 'timesReady'] },
  { message: 'Interview confirmed (doctor)', to: 'doctor', key: 'interview_confirmed', email: '"Your interview is confirmed" email', proof: [T18, 'booked'] },
  { message: 'Interview confirmed (practice)', to: 'practice', key: 'interview_confirmed_practice', email: 'The interview confirmation email to the practice', proof: [T18, 'booked'] },
  { message: 'Contract ready to sign', to: 'doctor', key: 'contract_ready', email: '"Congratulations: the position is yours" email', proof: [T18, 'contractReady'] },
  { message: 'N10 introduction to the practice', to: 'practice', key: 'practice_intro', email: 'The introduction email also goes', proof: [T18, 'intro'] },
  { message: 'N10 introduction to the practice, with the CV', to: 'practice', key: 'practice_intro_cv', email: 'The introduction email also goes', proof: [T18, 'intro'] },
  { message: 'Account released', to: 'doctor', key: 'account_released', email: 'The "account released" email also goes', proof: [T18, 'accountReleased'] },
  { message: 'N11 placement secured', to: 'doctor', key: 'placement_secured', email: 'The "placement secured" email and in-app notice (N11)', proof: ['tests/au-wp11-placement-server.test.js', null] },
  { message: 'Hello from the assigned team member', to: 'doctor', key: 'rso_welcome', email: 'None: this hello is WhatsApp only. Nothing is sent in its place, and the skip is written on the case timeline.', proof: [T18, 'assignAdminCase'] },
  { message: 'N16 cleared to start', to: 'doctor', key: 'cleared_to_start', email: 'The "cleared to start" email and in-app notice (N16)', proof: [T17P, 'staff confirm the start date: N15 goes to the doctor (email, bell) and to the practice, once; ticking the last pre-start task sends N16, once'] },
  { message: 'N18 first-week check-in (doctor)', to: 'doctor', key: 'commencement_checkin', email: 'The first-week email and in-app notice (N18)', proof: ['tests/au-wp13-server.test.js', null] },
  { message: 'N18 first-week check-in (practice)', to: 'practice', key: 'commencement_checkin_practice', email: 'The first-week email to the practice (N18)', proof: ['tests/au-wp13-server.test.js', null] },
  { message: 'Reminder for a call booked with a staff member', to: 'doctor', key: null, email: 'The Australian call-reminder email (the day before, and as it starts)', proof: [T18, 'callReminder:registration:dayBefore'] }
]);

/** 'reused' | 'awaiting approval' | "owner's choice" | 'switched on' | 'email only'. */
function statusOf(key, env) {
  if (!key) return 'email only';
  const row = wa.AU_WHATSAPP_TEMPLATES[key];
  if (!row) return 'email only';
  const own = wa.auWhatsAppTemplate(key, env || {});
  // FR-2 (S2-06): two reused templates go to VR GPs (segment A) only,
  // because their fixed wording promises matching (R-06). The sheet says so.
  if (row.source === wa.SOURCE.NEUTRAL) return own.approved ? (row.launchedSegmentOnly === true ? 'reused (VR GPs only)' : 'reused') : 'reused (switched off)';
  if (own.approved) return 'switched on';
  if (wa.AU_WHATSAPP_TEMPLATES[key + '_existing']) {
    return wa.auWhatsAppTemplate(key + '_existing', env || {}).approved ? 'switched on (existing wording)' : 'awaiting approval (or your choice, section 4)';
  }
  return 'awaiting approval';
}

/** Which section of the sheet each row of AU_WHATSAPP_TEMPLATES belongs to. */
function sheetModel() {
  const reused = [];
  const submit = [];
  const ownerChoice = [];
  Object.keys(wa.AU_WHATSAPP_TEMPLATES).forEach(function (key) {
    const src = wa.AU_WHATSAPP_TEMPLATES[key].source;
    if (src === wa.SOURCE.NEUTRAL) reused.push(key);
    else if (src === wa.SOURCE.RSO_WORDING) ownerChoice.push(key);
    else submit.push(key);
  });
  return { reused, submit, ownerChoice, notNeeded: SUPERSEDED.map(function (x) { return x.draft; }) };
}

function quote(body) { return String(body).split('\n').map(function (l) { return '> ' + l; }).join('\n'); }

function renderSheet() {
  const rows = wa.AU_WHATSAPP_TEMPLATES;
  const model = sheetModel();
  const L = [];
  L.push('# Australian WhatsApp templates: what to submit, and what already works');
  L.push('');
  L.push('*Generated from `lib/au-whatsapp-templates.js` and `lib/au-whatsapp-submission.js`. Do not edit by hand: change the code and regenerate (`WP18_WRITE_SHEET=1 npx vitest run tests/au-wp18-sheet.test.js`).*');
  L.push('');
  L.push('**Nothing in this file has been sent to DoubleTick or Meta.** It is the list of what you would create there, in the words to type.');
  L.push('');
  L.push('## In short');
  L.push('');
  L.push('- **' + model.reused.length + ' messages already go by WhatsApp** to Australian GPs and their practices, through templates you already have (two of them, the after-the-call note and the set-up nudge, only to VR GPs: their wording promises matching, so every other Australian lead gets the careful email instead). On 22 November 2026 we read the approved wording of every existing template and these ones say nothing about moving country, visas or registering. Nothing to submit. (Section 1.)');
  L.push('- **' + model.submit.length + ' new templates to submit** in DoubleTick. Until each is approved, its message goes by email instead. Nothing is lost in the meantime. (Section 2.)');
  L.push('- **' + SUPERSEDED.length + ' templates drafted earlier are not needed.** (Section 3.)');
  L.push('- **One decision for you:** five existing messages say "your Registration Support Officer". For Australian GPs they are switched off and the email goes instead. You can switch any of them back on with one setting. (Section 4.)');
  L.push('- An Australian GP is **never** sent one of the overseas templates (MyIntealth, AMC, AHPRA, visa, "your move", the UK hello and the rest). That is fixed in the code and cannot be switched on.');
  L.push('');
  L.push('### How to switch a template on');
  L.push('');
  L.push('1. Create it in DoubleTick exactly as written in section 2 and wait for Meta to approve it.');
  L.push('2. Add its **key** to the setting `AU_WHATSAPP_APPROVED_TEMPLATES` (a comma-separated list in the app\'s environment settings in Vercel), then redeploy. Example: `AU_WHATSAPP_APPROVED_TEMPLATES=lead_hello_5m,placement_secured`.');
  L.push('');
  L.push('That is the whole change: each key turns on that one message and nothing else. To switch one **off** (including one from section 1), add its key to `AU_WHATSAPP_DISABLED_TEMPLATES` the same way.');
  L.push('');
  L.push('### Every Australian message and its WhatsApp today');
  L.push('');
  L.push('| Message | Goes to | WhatsApp today | Template | Key | Meanwhile, by email |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  MESSAGE_TABLE.forEach(function (m) {
    const row = m.key ? rows[m.key] : null;
    L.push('| ' + m.message + ' | ' + m.to + ' | ' + statusOf(m.key, {}) + ' | ' + (row ? '`' + row.templateName + '`' : 'none') + ' | ' + (m.key ? '`' + m.key + '`' : '') + ' | ' + m.email + ' |');
  });
  L.push('');
  L.push('The other Australian messages (N06, N07, N08, N12 to N15, N17, N19 to N21) are email only by design and have no WhatsApp.');
  L.push('');

  // ── Section 1 ──
  L.push('## 1. Already working: nothing to submit');
  L.push('');
  L.push('These existing templates carry an Australian message as they are. Each was read word for word on 22 November 2026 (the wording is quoted in `whatsapp-live-templates.md`).');
  L.push('');
  L.push('| Key | Existing template | Carries | What the app fills in |');
  L.push('| --- | --- | --- | --- |');
  model.reused.forEach(function (key) {
    L.push('| `' + key + '` | `' + rows[key].templateName + '` | ' + REUSED[key].carries + ' | ' + REUSED[key].fills + ' |');
  });
  L.push('');
  L.push('One thing to confirm: the after-the-call note (`lead_post_call_onboard`) says setting up an account takes "about 5 minutes" and asks the doctor to "upload your CV". If that does not suit the Australian sign-up, add `lead_post_call_onboard` to `AU_WHATSAPP_DISABLED_TEMPLATES` and the email carries it alone.');
  L.push('');

  // ── Section 2 ──
  L.push('## 2. To submit in DoubleTick');
  L.push('');
  L.push('For every template: **language** English (`en`); **WhatsApp number** the existing GP Link one; **header** none; **footer** none. Type the body exactly, keeping `{{1}}`, `{{2}}` where they are. DoubleTick asks for a sample for each one: use the samples given. Meta decides the final category; if it offers to change it, accept.');
  L.push('');
  L.push('Wording rules these keep, which matter if you edit one: no body starts or ends with a `{{n}}`; nothing about registration steps, changing country or where the doctor trained; no dollar figure or percentage. A template can only be edited 24 hours after its last edit, and an edit sends it back for review, so check the wording before you submit.');
  L.push('');
  let group = '';
  SUBMIT.forEach(function (t) {
    const row = rows[t.key];
    if (t.group !== group) { group = t.group; L.push('### ' + group); L.push(''); }
    L.push('#### `' + row.templateName + '`');
    L.push('');
    L.push('- **Turns on:** ' + t.turnsOn);
    L.push('- **Category to choose:** ' + t.category);
    L.push('- **Language:** English (`en`)');
    L.push('- **Header:** none');
    L.push('- **Body:**');
    L.push('');
    L.push(quote(t.body));
    L.push('');
    L.push('- **Samples:** ' + t.variables.map(function (v, i) { return '`{{' + (i + 1) + '}}` ' + v[0] + ': "' + v[1] + '"'; }).join('; '));
    if (t.buttons.length) {
      L.push('- **Buttons:** ' + t.buttons.map(function (b) {
        return 'Visit website, text "' + b.text + '", address `' + b.url + '`' + (b.sample ? ' (sample for the `{{1}}` at the end: "' + b.sample + '")' : ' (a fixed address: no variable)');
      }).join('; '));
    } else L.push('- **Buttons:** none');
    if (t.note) L.push('- **Note:** ' + t.note);
    L.push('- **Once Meta approves it, add this key:** `' + t.key + '`');
    L.push('');
  });

  // ── Section 3 ──
  L.push('## 3. Not needed');
  L.push('');
  L.push('Earlier in the build these were proposed as new templates. An existing approved template already does the job, so do not submit them.');
  L.push('');
  L.push('| Drafted earlier | Covered by the existing template |');
  L.push('| --- | --- |');
  SUPERSEDED.forEach(function (x) { L.push('| `' + x.draft + '` | `' + x.by + '` |'); });
  L.push('');

  // ── Section 4 ──
  L.push('## 4. Your decision');
  L.push('');
  L.push('Five existing templates contain no wrong word, but each says "your Registration Support Officer", and the interview ones promise that person will be on the call. That is the overseas team\'s job title, and may not be how an Australian interview runs.');
  L.push('');
  L.push('**Today, for Australian GPs:** these five WhatsApps are off. The doctor (and the practice) still get the email for each, with the same link, so nobody misses anything.');
  L.push('');
  L.push('**Your two options, per message:**');
  L.push('');
  L.push('- **Wait for the neutral version.** Submit the matching template in section 2. Once approved, add its key. (Recommended.)');
  L.push('- **Keep the existing one for now.** Add the key below to `AU_WHATSAPP_APPROVED_TEMPLATES`. Australian GPs then get the existing WhatsApp, wording as it is. When the neutral version is approved and its key added, the neutral one takes over by itself.');
  L.push('');
  L.push('| Message | Existing template | It says | Key to keep it on | Neutral version (section 2) |');
  L.push('| --- | --- | --- | --- | --- |');
  model.ownerChoice.forEach(function (key) {
    const base = key.replace(/_existing$/, '');
    L.push('| ' + OWNER_CHOICE[key].message + ' | `' + rows[key].templateName + '` | ' + OWNER_CHOICE[key].says + ' | `' + key + '` | `' + rows[base].templateName + '` (key `' + base + '`) |');
  });
  L.push('');
  L.push('The overseas staff welcome ("I\'m your dedicated Registration Support Officer... getting registered to work as a GP in Australia") is not on this list and cannot be switched on for an Australian GP. Its Australian version is `gp_link_au_team_welcome` in section 2.');
  L.push('');
  return L.join('\n');
}

module.exports = { SUBMIT, REUSED, OWNER_CHOICE, SUPERSEDED, MESSAGE_TABLE, SAMPLES: S, statusOf, sheetModel, renderSheet };
