'use strict';
/**
 * WP-17 (Australian GP build): THE catalogue of every message an Australian
 * doctor, or a practice hiring one, is sent after they have an account.
 * Pure, no I/O. server.js decides WHEN each goes and sends it through the
 * guarded helpers; this file says WHAT each says and lists every one.
 *
 *   AU_MESSAGES        the registry, N04 to N22: when, to whom, channels, what
 *                      each unlaunched segment gets, quiet hours, the
 *                      once-ever key, the builder, the trigger and its tests.
 *   build*             the builders WP-17 wrote (N04, N05, N08, N15, N16, N17,
 *                      N22). The builders earlier packages wrote are folded in
 *                      by re-export, so this is the one module to import:
 *                      N06 (lib/au-staff-tools.js), N11 to N14 and N18 to N21
 *                      (lib/au-placement-messages.js), N10 (lib/career-intro.js).
 *   roleLabelFor /     COM-23: the one answer to "what do we call the person
 *   applyRoleLabel     looking after this doctor?" in a message.
 *   resolveAuNudge     COM-18: the staff nudge defaults for an Australian case.
 *
 * Rules every string keeps (tests/au-wp17-copy.test.js scans every message for
 * every segment group):
 *   - none of the words in AGENT-RULES section 4 reaches a doctor (the one
 *     named exception is N21 to a sponsor-tied segment B doctor, WP-14);
 *   - a practice is never told "internationally trained", "Expedited
 *     Specialist Pathway" or "AHPRA steps";
 *   - no dollar figure, no percentage; nothing commercial (a fee, an invoice,
 *     a credit, the word "guarantee") ever reaches a doctor;
 *   - the promise about the doctor's current practice in its agreed wording;
 *   - "Ahpra"; dates as Australian calendar dates ("1 February 2027"); no
 *     clock time is sent, so no time-zone label is needed;
 *   - a doctor in a segment that is not launched (B, C) is promised no roles.
 *
 * The owner-readable deck, docs/au-gp/au-lifecycle-copy.md, is generated from
 * this file; a test fails if they differ.
 */

const placement = require('./au-placement-messages.js');
const staffTools = require('./au-staff-tools.js');
const careerIntro = require('./career-intro.js');
const gpApp = require('./au-gp-app.js');

const CONFIDENTIALITY_LINE = 'We never contact your current practice without asking you first.';
const CONFIDENTIAL_PARAGRAPH = 'Your enquiry is confidential. ' + CONFIDENTIALITY_LINE;
const GP_FOOTER = 'Questions? Reply to this email and our team will help.';
const PRACTICE_FOOTER = 'Sent by the GP Link recruitment team.';
const PRACTICE_SIGN_OFF = 'Kind regards,\nGP Link Recruitment Team';

function trimBase(url) { return String(url || '').replace(/\/+$/, ''); }
function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function esc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function drName(name) {
  const n = clean(name, 160);
  if (!n) return '';
  return /^dr\b/i.test(n) ? n : 'Dr ' + n;
}
function ledgerPart(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 80) || 'none';
}
const formatDate = placement.formatStartDate;

// ── Segment groups ───────────────────────────────────────────────────────────
// 'main'  : segment A (au_vr), and a doctor whose segment is not known yet.
//           Written to be true for any Ahpra-registered doctor.
// 'safe'  : segments B and C (au_restricted, au_non_vr, au_registrar). Built,
//           not launched (owner decision 1): the wording promises no roles.
const GROUP = Object.freeze({ MAIN: 'main', SAFE: 'safe' });
const SAFE_PATHWAYS = Object.freeze(['au_restricted', 'au_non_vr', 'au_registrar']);

/** The copy group for a pathway (or a lead segment: the names are the same). */
function groupForPathway(pathway) {
  return SAFE_PATHWAYS.indexOf(String(pathway || '').trim().toLowerCase()) !== -1 ? GROUP.SAFE : GROUP.MAIN;
}
/** 'A' | 'B' | 'C' for an Australian pathway; '' for anything else. */
function segmentLetter(pathway) {
  const p = String(pathway || '').trim().toLowerCase();
  if (p === 'au_vr') return 'A';
  if (p === 'au_restricted') return 'B';
  if (p === 'au_non_vr' || p === 'au_registrar') return 'C';
  return '';
}

// ── COM-23: the one role label ───────────────────────────────────────────────
// The job title "Registration Support Officer" belongs to the journey of a
// doctor registering from another country. A doctor on an Australian pathway
// is looked after by the placing consultant until placement and a small team
// after it (owner decision 6), and is told so in the same words the app uses
// (gpApp.teamLabel, WP-12). Everyone else reads exactly what they always did.

const OVERSEAS_ROLE_LABEL = 'your Registration Support Officer';
const ROLE_LABEL_PATTERN = /\b([Yy])our (?:GP Link )?[Rr]egistration [Ss]upport [Oo]fficer\b/g;

/**
 * @param {{ isAu?: boolean, placed?: boolean }|null} ctx
 * @returns {{ isAu: boolean, label: string, sentenceStart: string }}
 */
function roleLabelFor(ctx) {
  const isAu = !!(ctx && ctx.isAu === true);
  const label = isAu ? gpApp.teamLabel(!!(ctx && ctx.placed === true)) : OVERSEAS_ROLE_LABEL;
  return { isAu, label, sentenceStart: label.charAt(0).toUpperCase() + label.slice(1) };
}

/**
 * Rewrite the role label in a finished doctor-facing string. For anyone who
 * is not on an Australian pathway (ctx null / isAu not true) the SAME string
 * comes back, untouched. Works on plain text and on HTML.
 */
function applyRoleLabel(text, ctx) {
  if (typeof text !== 'string' || !ctx || ctx.isAu !== true) return text;
  const label = gpApp.teamLabel(ctx.placed === true);
  return text.replace(ROLE_LABEL_PATTERN, function (m, y) { return (y === 'Y' ? 'Y' : 'y') + label.slice(1); });
}

/** Does this string (or any string value of this object) carry the label? */
function containsRoleLabel(value) {
  const has = function (t) { return typeof t === 'string' && /[Rr]egistration [Ss]upport [Oo]fficer/.test(t) && t.search(ROLE_LABEL_PATTERN) !== -1; };
  if (typeof value === 'string') return has(value);
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some(function (k) { return has(value[k]); });
}

/** applyRoleLabel for a string, or for every string value of an object (a shallow copy). */
function applyRoleLabelDeep(value, ctx) {
  if (typeof value === 'string') return applyRoleLabel(value, ctx);
  if (!value || typeof value !== 'object' || !ctx || ctx.isAu !== true) return value;
  const out = Array.isArray(value) ? value.slice() : Object.assign({}, value);
  Object.keys(out).forEach(function (k) { if (typeof out[k] === 'string') out[k] = applyRoleLabel(out[k], ctx); });
  return out;
}

// ── N04: welcome ─────────────────────────────────────────────────────────────

/**
 * The welcome for a new account known to be an Australian doctor's. Replaces
 * the overseas welcome (which points at MyIntealth) and the "book a call"
 * welcome. Sent before the segment is settled, so the main wording is true
 * for any Ahpra-registered doctor.
 * @param {{ appBaseUrl, group?: 'main'|'safe' }} input
 */
function buildWelcomeMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const safe = i.group === GROUP.SAFE;
  const lines = [
    'Your account is ready. GP Link helps Ahpra-registered GPs find a practice that fits better: the billing mix, the location and the hours you want.',
    '',
    'The next step is to finish your profile. It takes a few minutes and you will need:',
    '• Your Ahpra registration number',
    '• When you could be available',
    '• Your notice period',
    '',
    safe
      ? 'Once that is done we check your registration on the public Ahpra register and come back to you about what fits your registration.'
      : 'Once that is done we check your registration on the public Ahpra register and come back to you about the roles that fit.',
    '',
    CONFIDENTIAL_PARAGRAPH
  ];
  return {
    id: 'N04',
    key: 'au_n04_welcome',
    group: safe ? GROUP.SAFE : GROUP.MAIN,
    subject: 'Welcome to GP Link: finish your profile in a few minutes',
    title: 'Welcome to GP Link, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Finish my profile',
    ctaUrl: base + '/pages/onboarding',
    footer: GP_FOOTER,
    // Proposed template (docs/au-gp/whatsapp-templates.md, key `welcome`):
    // {{1}} first name; URL button to the profile.
    whatsapp: { templateKey: 'welcome', placeholders: ['{{name}}'] }
  };
}

// ── N05: onboarding not finished ─────────────────────────────────────────────

const HOUR = 3600000;
const DAY = 24 * HOUR;
// Shorter than the overseas sequence (seven emails over a month): an
// Australian doctor's profile takes minutes, so four reminders over a week.
const AU_ONBOARDING_NUDGE_SCHEDULE_MS = Object.freeze([HOUR, 24 * HOUR, 3 * DAY, 7 * DAY]);

// The Australian branch's own steps, in the order the doctor meets them
// (js/onboarding-au.js STEPS, then the wizard's identity step).
const AU_ONBOARDING_STEP_LABELS = Object.freeze([
  'Where you would like to work',
  'Your availability and notice period',
  'Your Ahpra registration',
  'A few registration details',
  'Check your answers',
  'Confirm your identity'
]);

/** The step an Australian doctor's saved wizard blob is on: 0 to 5. */
function auOnboardingStepOf(blob) {
  let b = blob;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  const au = b && typeof b === 'object' && b.au && typeof b.au === 'object' ? b.au : null;
  const n = au ? Number(au.step) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(AU_ONBOARDING_STEP_LABELS.length - 1, Math.floor(n));
}

function sentSet(stepsSent) {
  const set = {};
  (Array.isArray(stepsSent) ? stepsSent : []).forEach(function (s) { set[Number(s)] = true; });
  return set;
}
/** The earliest reminder that is due and unsent, or null. One per run. */
function auOnboardingNextDue(input) {
  const inactivityMs = Number(input && input.inactivityMs);
  if (!Number.isFinite(inactivityMs) || inactivityMs <= 0) return null;
  const sent = sentSet(input && input.stepsSent);
  for (let n = 0; n < AU_ONBOARDING_NUDGE_SCHEDULE_MS.length; n++) {
    if (sent[n]) continue;
    return inactivityMs >= AU_ONBOARDING_NUDGE_SCHEDULE_MS[n] ? n : null;
  }
  return null;
}
function auOnboardingExhausted(input) {
  const sent = sentSet(input && input.stepsSent);
  return !!sent[AU_ONBOARDING_NUDGE_SCHEDULE_MS.length - 1];
}

/**
 * @param {{ appBaseUrl, index: 0|1|2|3, step?: number, unsubscribeUrl?: string }} input
 *   step: the wizard step the doctor stopped on (auOnboardingStepOf)
 * @returns {{ id, key, index, subject, title, body, ctaText, ctaUrl, stepLabel, stepsLeft, text }}
 */
function buildOnboardingNudgeMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const last = AU_ONBOARDING_NUDGE_SCHEDULE_MS.length - 1;
  const index = Math.max(0, Math.min(last, Math.floor(Number(i.index) || 0)));
  const step = Math.max(0, Math.min(AU_ONBOARDING_STEP_LABELS.length - 1, Math.floor(Number(i.step) || 0)));
  const stepsLeft = AU_ONBOARDING_STEP_LABELS.length - step;
  const stepLabel = AU_ONBOARDING_STEP_LABELS[step];
  const leftBit = 'You have ' + stepsLeft + ' short step' + (stepsLeft === 1 ? '' : 's') + ' left, starting with "' + stepLabel + '".';
  const variants = [
    { subject: 'Finish your GP Link profile: a few minutes left',
      title: 'You are nearly there, {{name}}',
      body: 'You started your GP Link profile and it is saved where you left it. ' + leftBit + '\n\n'
        + 'Have your Ahpra registration number to hand and it takes a few minutes.' },
    { subject: 'Your GP Link profile is waiting',
      title: 'Pick up where you left off, {{name}}',
      body: 'Your GP Link profile is still waiting for you. ' + leftBit + '\n\n'
        + 'Once it is finished we check your registration on the public Ahpra register and come back to you about what fits.' },
    { subject: 'A few minutes to finish your GP Link profile',
      title: 'Still interested, {{name}}?',
      body: 'It has been a few days since you started your GP Link profile. ' + leftBit + '\n\n'
        + 'If something in the form is unclear, reply to this email and we will help.' },
    { subject: 'Last reminder: your GP Link profile',
      title: 'This is our last reminder, {{name}}',
      body: 'This is the last reminder we will send about finishing your GP Link profile. ' + leftBit + '\n\n'
        + 'Your answers stay saved, and you are welcome back whenever you are ready.' }
  ];
  const v = variants[index];
  const body = v.body + '\n\n' + CONFIDENTIAL_PARAGRAPH;
  const ctaUrl = base + '/pages/onboarding';
  return {
    id: 'N05',
    key: 'au_n05_onboarding:' + index,
    index,
    subject: v.subject,
    title: v.title,
    body,
    ctaText: 'Continue my profile',
    ctaUrl,
    stepLabel,
    stepsLeft,
    unsubscribeUrl: clean(i.unsubscribeUrl, 600),
    // Proposed template, key `onboarding_nudge`: {{1}} first name.
    whatsapp: { templateKey: 'onboarding_nudge', placeholders: ['{{name}}'] }
  };
}

// ── N08: profile complete ────────────────────────────────────────────────────

/**
 * Replaces "Profile Complete: the next step is MyIntealth".
 * @param {{ appBaseUrl, group?: 'main'|'safe' }} input
 */
function buildProfileCompleteMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const safe = i.group === GROUP.SAFE;
  const lines = safe
    ? [
      'Thanks for finishing your profile.',
      '',
      'Here is what happens now:',
      '• We check your registration on the public Ahpra register.',
      '• One of our team then looks at your details and gets in touch to talk through what fits your registration.',
      '',
      'There is nothing more you need to do for now.',
      '',
      CONFIDENTIAL_PARAGRAPH
    ]
    : [
      'Thanks for finishing your profile.',
      '',
      'Here is what happens now:',
      '• We check your registration on the public Ahpra register, usually within two business days, and email you as soon as it is done.',
      '• We line up the GP roles that fit what you told us: location, billing mix and hours.',
      '• When a role looks right you can apply in a couple of taps, or we send you a match to look at.',
      '',
      'You can browse roles in the app in the meantime.',
      '',
      CONFIDENTIAL_PARAGRAPH
    ];
  return {
    id: 'N08',
    key: 'au_n08_profile_complete',
    group: safe ? GROUP.SAFE : GROUP.MAIN,
    subject: safe ? 'Your GP Link profile is complete' : 'Your profile is complete: we are lining up matches',
    title: safe ? 'Thanks, {{name}}' : 'You are all set, {{name}}',
    body: lines.join('\n'),
    ctaText: safe ? 'Open GP Link' : 'See GP roles',
    ctaUrl: base + '/pages/career',
    footer: GP_FOOTER
  };
}

// ── N15: notice given, start date agreed ─────────────────────────────────────

const N15_KIND = Object.freeze({ NOTICE: 'notice', START_DATE: 'start_date' });

function weeksText(weeks) {
  const n = Number(weeks);
  if (weeks === null || weeks === undefined || weeks === '' || !Number.isFinite(n) || n < 0) return '';
  const w = Math.round(n);
  return w + ' week' + (w === 1 ? '' : 's');
}

function practiceParagraphs(contact, paragraphs, closing) {
  const text = 'Hi ' + contact + ',\n\n' + paragraphs.join('\n\n') + '\n\n' + closing + '\n\n' + PRACTICE_SIGN_OFF;
  const bodyHtml = '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc('Hi ' + contact + ',') + '</p>'
    + paragraphs.map(function (p) { return '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc(p) + '</p>'; }).join('')
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 24px">' + esc(closing) + '</p>';
  return { text, bodyHtml };
}

/**
 * N15 -> the doctor. Two moments, one message each:
 *   kind 'notice'      the doctor has just recorded that they gave notice
 *   kind 'start_date'  staff confirmed the start date (correction: the date
 *                      replaces one confirmed earlier)
 * @param {{ appBaseUrl, kind, practiceName?, placementKey, noticeDate?, noticeWeeks?,
 *           startDate?, startDateConfirmed?: boolean, correction?: boolean, teamLabel? }} input
 * @returns {object|null} null when the fact the message confirms is missing
 */
function buildNoticeStartGpMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const practice = clean(i.practiceName, 160) || 'your new practice';
  const team = clean(i.teamLabel, 60) || gpApp.teamLabel(true);
  const noticeDay = typeof i.noticeDate === 'string' ? i.noticeDate.slice(0, 10) : '';
  const startDay = typeof i.startDate === 'string' ? i.startDate.slice(0, 10) : '';
  const notice = formatDate(noticeDay);
  const start = formatDate(startDay);
  const weeks = weeksText(i.noticeWeeks);
  if (i.kind === N15_KIND.NOTICE) {
    if (!notice) return null;
    const next = i.startDateConfirmed === true && start
      ? 'Your start date at ' + practice + ' is confirmed: ' + start + '.'
      : (start
        ? 'Your expected start date at ' + practice + ' is ' + start + '. We will confirm it with the practice and let you know.'
        : 'We will now agree your start date with ' + practice + ' and confirm it with you.');
    const lines = [
      'Thanks for letting us know. We have recorded that you gave notice on ' + notice + '.',
      '',
      next,
      '',
      'We have told ' + practice + ' that you have given notice. If anything changes on your side, tell ' + team + ' straight away.'
    ];
    return {
      id: 'N15', kind: N15_KIND.NOTICE,
      key: 'au_n15_notice_gp:' + ledgerPart(i.placementKey) + ':' + ledgerPart(noticeDay),
      subject: 'Your notice is recorded',
      title: 'Notice recorded, {{name}}',
      body: lines.join('\n'),
      ctaText: 'Open your checklist',
      ctaUrl: base + '/pages/prestart',
      footer: GP_FOOTER,
      bell: { type: 'success', title: 'Your notice is recorded', target: '/pages/prestart',
        body: 'You gave notice on ' + notice + '.' + (i.startDateConfirmed === true && start ? ' Start date: ' + start + '.' : ' We will confirm your start date with the practice.') }
    };
  }
  if (!start) return null;
  const correction = i.correction === true;
  const lines = [
    correction
      ? 'Your start date at ' + practice + ' has changed. The new confirmed date is ' + start + '.'
      : 'Your start date at ' + practice + ' is confirmed: ' + start + '.'
  ];
  const facts = [];
  if (weeks) facts.push('Your notice period is recorded as ' + weeks + '.');
  if (notice) facts.push('You told us you gave notice on ' + notice + '.');
  if (facts.length) { lines.push(''); lines.push(facts.join(' ')); }
  lines.push('');
  lines.push('The practice has the same date. If anything changes on your side, tell ' + team + ' straight away so we can sort it out with the practice.');
  lines.push('');
  lines.push('Your pre-start checklist shows what is still to do before your first day.');
  return {
    id: 'N15', kind: N15_KIND.START_DATE, correction,
    key: 'au_n15_start_gp:' + ledgerPart(i.placementKey) + ':' + ledgerPart(startDay),
    subject: correction ? 'Your start date has changed: ' + start : 'Your start date is confirmed: ' + start,
    title: correction ? 'A change to your start date, {{name}}' : 'Your start date is confirmed, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Open your checklist',
    ctaUrl: base + '/pages/prestart',
    footer: GP_FOOTER,
    bell: { type: 'success', title: correction ? 'Your start date has changed' : 'Your start date is confirmed', target: '/pages/prestart',
      body: (correction ? 'New start date at ' : 'Start date at ') + practice + ': ' + start + '.' }
  };
}

/**
 * N15 -> the practice. Never names, or hints at, the doctor's current practice.
 * @param {{ kind, gpName, contactName?, placementKey, noticeDate?, noticeWeeks?, startDate?,
 *           startDateConfirmed?: boolean, correction?: boolean, contactLine? }} input
 */
function buildNoticeStartPracticeMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const dr = drName(i.gpName) || 'your new GP';
  const contact = clean(i.contactName, 120) || 'there';
  const closing = clean(i.contactLine, 240) || 'If you have any questions, reply to this email and our team will help.';
  const noticeDay = typeof i.noticeDate === 'string' ? i.noticeDate.slice(0, 10) : '';
  const startDay = typeof i.startDate === 'string' ? i.startDate.slice(0, 10) : '';
  const notice = formatDate(noticeDay);
  const start = formatDate(startDay);
  const weeks = weeksText(i.noticeWeeks);
  if (i.kind === N15_KIND.NOTICE) {
    if (!notice) return null;
    const built = practiceParagraphs(contact, [
      dr + ' has let us know that notice was given on ' + notice + '.',
      i.startDateConfirmed === true && start
        ? 'The confirmed start date at your practice is ' + start + '.'
        : (start
          ? 'The expected start date at your practice is ' + start + '. We will confirm it with you as soon as it is settled.'
          : 'We will now agree the start date with you and with ' + dr + ', and confirm it in writing.')
    ], closing);
    return {
      id: 'N15', kind: N15_KIND.NOTICE,
      key: 'au_n15_notice_practice:' + ledgerPart(i.placementKey) + ':' + ledgerPart(noticeDay),
      subject: dr + ' has given notice',
      title: 'Notice given',
      bodyHtml: built.bodyHtml, text: built.text, footer: PRACTICE_FOOTER
    };
  }
  if (!start) return null;
  const correction = i.correction === true;
  const paragraphs = [
    correction
      ? 'The start date for ' + dr + ' at your practice has changed. The new confirmed date is ' + start + '.'
      : 'The start date for ' + dr + ' at your practice is confirmed: ' + start + '.'
  ];
  const facts = [];
  if (weeks) facts.push(dr + '\'s notice period is ' + weeks + '.');
  if (notice) facts.push('Notice was given on ' + notice + '.');
  if (facts.length) paragraphs.push(facts.join(' '));
  paragraphs.push(dr + ' has the same date. Before then we will send you the credentialing pack, and let you know when the Medicare provider number for your location is issued.');
  const built = practiceParagraphs(contact, paragraphs, closing);
  return {
    id: 'N15', kind: N15_KIND.START_DATE, correction,
    key: 'au_n15_start_practice:' + ledgerPart(i.placementKey) + ':' + ledgerPart(startDay),
    subject: dr + (correction ? ': start date changed to ' : ': start date confirmed, ') + start,
    title: correction ? 'Start date changed' : 'Start date confirmed',
    bodyHtml: built.bodyHtml, text: built.text, footer: PRACTICE_FOOTER
  };
}

// ── N16: pre-start complete ──────────────────────────────────────────────────

/**
 * "Cleared to start on {date}". Only ever built with a real confirmed date.
 * @param {{ appBaseUrl, practiceName?, startDate, placementKey, teamLabel? }} input
 * @returns {object|null} null without a date (the message is never sent half-true)
 */
function buildClearedToStartMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const start = formatDate(typeof i.startDate === 'string' ? i.startDate.slice(0, 10) : '');
  if (!start) return null;
  const practice = clean(i.practiceName, 160) || 'your new practice';
  const team = clean(i.teamLabel, 60) || gpApp.teamLabel(true);
  const lines = [
    'Everything on your pre-start checklist is done. You are cleared to start at ' + practice + ' on ' + start + '.',
    '',
    'What is in place:',
    '• Your start date is confirmed with the practice.',
    '• Your Medicare provider number for the new location is recorded.',
    '• Your indemnity certificate is on file.',
    '• Your credentialing pack has gone to the practice.',
    '',
    'There is nothing more you need to send us. If anything changes before your first day, tell ' + team + ' straight away.',
    '',
    'We will check in with you after your first week.'
  ];
  return {
    id: 'N16',
    key: 'au_n16_cleared_to_start:' + ledgerPart(i.placementKey),
    subject: 'You are cleared to start on ' + start,
    title: 'You are cleared to start, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Open your checklist',
    ctaUrl: base + '/pages/prestart',
    footer: GP_FOOTER,
    bell: { type: 'success', title: 'You are cleared to start', target: '/pages/prestart',
      body: 'Your pre-start checklist is complete. Start date at ' + practice + ': ' + start + '.' },
    // Proposed template, key `cleared_to_start`: {{1}} first name, {{2}}
    // practice name, {{3}} the start date.
    whatsapp: { templateKey: 'cleared_to_start', placeholders: ['{{name}}', practice, start] }
  };
}

// ── N17: stalled at match or pre-start ───────────────────────────────────────
// The doctor is only reminded about things THEY can do. With nothing of theirs
// outstanding there is no message at all: the ball is with us or the practice.

const N17_STAGE = Object.freeze({ MATCH: 'match', PRESTART: 'prestart' });
// Days after the milestone the case is aged from (lib/au-sweeps.js
// auCaseAgeAnchor: onboarding finished for the match stage, the placement
// recorded for pre-start). Each mark goes at most once.
const N17_MARK_DAYS = Object.freeze([14, 28]);
// A mark is not sent long after its day.
const N17_LATE_DAYS = 10;

/** Which reminder is owed at this age: { mark: 'd14', days: 14 } or null. */
function stalledMarkFor(ageDays) {
  const age = Number(ageDays);
  if (!Number.isFinite(age) || age < N17_MARK_DAYS[0]) return null;
  let pick = null;
  N17_MARK_DAYS.forEach(function (d) { if (age >= d) pick = d; });
  if (pick === null || age > pick + N17_LATE_DAYS) return null;
  return { mark: 'd' + pick, days: pick };
}

function matchAction(count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  return {
    kind: 'match_unanswered',
    label: n === 1 ? 'A role we matched you to is waiting for your answer' : n + ' roles we matched you to are waiting for your answer',
    help: 'Open it in the app and tell us yes or no. Either answer helps.'
  };
}

/**
 * @param {{ appBaseUrl, stage: 'match'|'prestart', actions: Array<{ label, help? }>, mark,
 *           placementKey?, practiceName?, startDate?, teamLabel? }} input
 * @returns {object|null} null with nothing the doctor can do
 */
function buildStalledReminderMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const actions = (Array.isArray(i.actions) ? i.actions : [])
    .map(function (a) { return { label: clean(a && a.label, 160), help: clean(a && a.help, 300) }; })
    .filter(function (a) { return a.label; })
    .slice(0, 8);
  if (!actions.length) return null;
  const one = actions.length === 1;
  const prestart = i.stage === N17_STAGE.PRESTART;
  const practice = clean(i.practiceName, 160);
  const start = formatDate(typeof i.startDate === 'string' ? i.startDate.slice(0, 10) : '');
  const team = clean(i.teamLabel, 60) || gpApp.teamLabel(prestart);
  const bullets = actions.map(function (a) { return '• ' + a.label + (a.help ? ': ' + a.help : ''); });
  const lines = prestart
    ? [
      'To keep your start' + (practice ? ' at ' + practice : '') + (start ? ' on ' + start : '') + ' on track, '
        + (one ? 'there is one thing' : 'there are a few things') + ' that only you can do:',
      ''
    ].concat(bullets, [
      '',
      'Everything else is with us or the practice, and we will tell you when anything changes. If something is holding you up, reply to this email and ' + team + ' will help.'
    ])
    : [
      'A quick reminder about something that is waiting on you:',
      ''
    ].concat(bullets, [
      '',
      'If a role is not right, say so in the app and tell us why: it helps us find a better fit. If you would like to talk it through first, reply to this email and ' + team + ' will be in touch.',
      '',
      CONFIDENTIALITY_LINE
    ]);
  return {
    id: 'N17',
    stage: prestart ? N17_STAGE.PRESTART : N17_STAGE.MATCH,
    key: 'au_n17_stalled:' + (prestart ? 'prestart:' + ledgerPart(i.placementKey) : 'match') + ':' + ledgerPart(i.mark || 'd14'),
    subject: prestart
      ? (one ? 'Before you start: one thing is waiting on you' : 'Before you start: a few things are waiting on you')
      : (one ? 'One thing is waiting on you' : 'A few things are waiting on you'),
    title: 'A quick reminder, {{name}}',
    body: lines.join('\n'),
    ctaText: prestart ? 'Open your checklist' : 'Open GP Link',
    ctaUrl: base + (prestart ? '/pages/prestart' : '/pages/career'),
    footer: GP_FOOTER,
    actionCount: actions.length
  };
}

// ── N22: the owner's weekly digest block ─────────────────────────────────────

const PIPELINE_STAGES = Object.freeze([
  { key: 'onboarding', label: 'Profile not finished' },
  { key: 'placement', label: 'Matching' },
  { key: 'prestart', label: 'Pre-start' },
  { key: 'commenced', label: 'Started (first week)' },
  { key: 'guarantee', label: 'In the guarantee period' },
  { key: 'complete', label: 'Complete' }
]);

/**
 * Counts per Australian stage from the rows one read function gathers.
 * @param {{ doctors: Array<{ user_id, candidate_pathway, onboarding_completed_at }>,
 *           cases: Array<{ user_id, stage, status }> }} input
 */
function auPipelineCounts(input) {
  const i = input && typeof input === 'object' ? input : {};
  const doctors = Array.isArray(i.doctors) ? i.doctors : [];
  const caseByUser = {};
  (Array.isArray(i.cases) ? i.cases : []).forEach(function (c) { if (c && c.user_id) caseByUser[String(c.user_id)] = c; });
  const stages = {};
  PIPELINE_STAGES.forEach(function (s) { stages[s.key] = 0; });
  const segments = { A: 0, B: 0, C: 0 };
  let total = 0;
  doctors.forEach(function (d) {
    const letter = segmentLetter(d && d.candidate_pathway);
    if (!letter || !d.user_id) return;
    total += 1;
    segments[letter] += 1;
    const c = caseByUser[String(d.user_id)] || null;
    const stage = String((c && c.stage) || '').trim().toLowerCase();
    if (!d.onboarding_completed_at) stages.onboarding += 1;
    else if (Object.prototype.hasOwnProperty.call(stages, stage) && stage !== 'onboarding') stages[stage] += 1;
    else stages.placement += 1;
  });
  return { total, stages, segments, needsReview: segments.B + segments.C };
}

/**
 * The block added to the weekly owner digest. '' when there is no Australian
 * doctor at all, so a week with none leaves the digest exactly as it was.
 * @returns {{ html: string, text: string, rows: Array<{ label, count }> }}
 */
function buildOwnerDigestBlock(counts) {
  const c = counts && typeof counts === 'object' ? counts : null;
  if (!c || !(Number(c.total) > 0)) return { html: '', text: '', rows: [] };
  const rows = PIPELINE_STAGES.map(function (s) { return { label: s.label, count: Number(c.stages && c.stages[s.key]) || 0 }; });
  const seg = c.segments || {};
  const review = Number(c.needsReview) || 0;
  const line = rows.map(function (r) { return r.label + ': ' + r.count; }).join(' · ');
  const segLine = 'Segment A (vocationally registered): ' + (Number(seg.A) || 0)
    + ' · Segment B (restricted): ' + (Number(seg.B) || 0)
    + ' · Segment C (non-VR and registrars): ' + (Number(seg.C) || 0);
  const html = '<p style="font-size:13px;font-weight:700;color:#0f172a;margin:0 0 6px">Australian GPs (already registered here)</p>'
    + '<p style="font-size:14px;color:#334155;line-height:1.8;margin:0 0 8px">'
    + rows.map(function (r) { return esc(r.label) + ': <strong>' + r.count + '</strong>'; }).join(' &middot; ')
    + '</p>'
    + '<p style="font-size:13px;color:#64748b;line-height:1.7;margin:0 0 20px">' + esc(segLine)
    + (review > 0 ? '. ' + review + ' in a segment that is not launched: a person decides what they are offered.' : '.') + '</p>';
  return { html, text: 'Australian GPs: ' + line + '\n' + segLine, rows };
}

// ── COM-18: the staff nudge defaults for an Australian case ─────────────────
// The existing defaults are worded for MyIntealth and AMC. For a doctor on an
// Australian pathway the default comes from here, whatever stage a staff
// member typed, so a MyIntealth-worded nudge can never be the default.

const AU_NUDGE_TEMPLATES = Object.freeze({
  onboarding: Object.freeze({
    title: 'Need a hand finishing your profile?',
    body: 'Your GP Link profile is nearly done. If anything in the form is unclear, reply here or message us and we will help.'
  }),
  placement: Object.freeze({
    title: 'Anything we can help with?',
    body: 'Just checking in. If you have a question about a role, your profile or what happens next, reply here and we will help.'
  }),
  prestart: Object.freeze({
    title: 'Need a hand with your pre-start checklist?',
    body: 'Is anything on your pre-start checklist holding you up? Reply here and we will help you sort it out.'
  }),
  commenced: Object.freeze({
    title: 'How are you settling in?',
    body: 'We hope your first days have gone well. If anything is not as you expected, reply here and we will help sort it out with the practice.'
  }),
  guarantee: Object.freeze({
    title: 'How is it going?',
    body: 'Just checking in on how things are going at your new practice. If anything needs sorting out, reply here and we will help.'
  }),
  _default: Object.freeze({
    title: 'Anything we can help with?',
    body: 'Just checking in. If you have a question or something is holding you up, reply here and we will help.'
  })
});
const AU_NUDGE_EMAIL_FOOTER = 'This note was sent by the GP Link team. If you have any questions, click the button above to reply directly.';

/** The default nudge for an Australian case at this stage (any other stage: the neutral default). */
function resolveAuNudgeTemplate(stage) {
  const key = String(stage || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AU_NUDGE_TEMPLATES, key) && key !== '_default'
    ? AU_NUDGE_TEMPLATES[key] : AU_NUDGE_TEMPLATES._default;
}

// ── COM-18: the admin composer's canned templates ───────────────────────────
// `audience` says who a default template was written for. The composer's list
// for an Australian case leaves out the ones written for a doctor registering
// from another country and offers these instead.
const OVERSEAS_ONLY_COMPOSER_KEYS = Object.freeze(['request_document_gp', 'chase_practice_sppa', 'ahpra_followup', 'welcome_next_steps']);
const AU_COMPOSER_TEMPLATES = Object.freeze([
  Object.freeze({
    key: 'au_request_document_gp',
    name: 'Australian GP: request a document',
    category: 'document_request',
    stage: 'prestart',
    subject: 'A document we need from you: {{documentName}}',
    body: 'Hi {{firstName}},\n\nBefore your first day we need a copy of your {{documentName}}. You can upload it in the GP Link app under your pre-start checklist, or reply to this email with it attached.\n\nIf anything is unclear, just reply and we will help.\n\nKind regards,\n{{rsoName}}\nGP Link'
  }),
  Object.freeze({
    key: 'au_welcome_next_steps',
    name: 'Australian GP: welcome and next steps',
    category: 'status_update',
    stage: 'onboarding',
    subject: 'Welcome to GP Link: your next steps',
    body: 'Hi {{firstName}},\n\nWelcome to GP Link. Here is what happens next:\n1. Finish your profile in the app. Have your Ahpra registration number to hand.\n2. We check your registration on the public Ahpra register.\n3. We come back to you about the roles that fit: location, billing mix and hours.\n\n' + CONFIDENTIALITY_LINE + '\n\nIf you have any questions, just reply to this email.\n\nKind regards,\n{{rsoName}}\nGP Link'
  }),
  Object.freeze({
    key: 'au_prestart_checkin',
    name: 'Australian GP: pre-start check-in',
    category: 'status_update',
    stage: 'prestart',
    subject: 'Checking in before your start date',
    body: 'Hi {{firstName}},\n\nJust checking in ahead of your start at {{practiceName}}. Your pre-start checklist in the GP Link app shows what is done and what is still to do.\n\nIf anything is holding you up, reply to this email and we will help.\n\nKind regards,\n{{rsoName}}\nGP Link'
  })
]);

/**
 * The composer's template list for one audience. `list` is the merged list
 * the endpoint already builds (defaults + the CEO's own rows).
 *   audience 'au'       : the overseas-only defaults are left out, the
 *                         Australian ones are added
 *   anything else       : `list` itself, untouched (the same array)
 */
function composerTemplatesFor(list, audience) {
  if (audience !== 'au') return list;
  const kept = (Array.isArray(list) ? list : []).filter(function (t) {
    return !(t && t.source === 'default' && OVERSEAS_ONLY_COMPOSER_KEYS.indexOf(t.key) !== -1);
  });
  const have = {};
  kept.forEach(function (t) { if (t && t.key) have[t.key] = true; });
  const extra = AU_COMPOSER_TEMPLATES.filter(function (t) { return !have[t.key]; }).map(function (t) {
    return { id: null, key: t.key, name: t.name, category: t.category, stage: t.stage, subject: t.subject, body: t.body, active: true, source: 'default' };
  });
  return extra.concat(kept);
}

// ── COM-20: the practice intake invite ───────────────────────────────────────
// The existing invite describes only doctors arriving from the UK, Ireland and
// New Zealand. With the Australian switch on it also says GP Link places GPs
// who are already registered and working in Australia.
// WP-23: the intake form now asks which GPs the practice will consider, so the
// line points at that question instead of "just tell us", and says plainly
// that a practice outside a Distribution Priority Area can apply (the next
// paragraph of the letter is about doctors moving country, who generally need
// a DPA location: a metro practice reading only that would stop here).
const INTAKE_AU_LINE = 'We also place GPs who are already registered and working in Australia and are looking for a practice that fits them better. The application form asks which GPs you would like to hear about, and your practice does not need to be in a Distribution Priority Area to apply.';

// ── E: what staff see about a message ────────────────────────────────────────

const CHANNEL_WORDS = Object.freeze({ email: 'email', bell: 'bell', practice_email: 'email to the practice', whatsapp: 'WhatsApp' });
const SKIP_WORDS = Object.freeze({
  au_template_not_approved: 'no approved Australian template',
  au_segment_not_launched: 'the doctor\'s segment is not launched',
  no_phone: 'no phone number on file',
  no_practice_email: 'no practice email on file',
  email_not_configured: 'email is not set up here',
  opted_out: 'the doctor turned reminder emails off',
  unsubscribed: 'the doctor unsubscribed from reminders',
  quiet_hours: 'outside 08:00 to 20:00 for the doctor: it goes on the next run inside those hours',
  not_sent: 'the send failed: it will be tried again',
  already_sent: 'already sent'
});

/**
 * One timeline line for a message outcome, so staff can read "N16 sent" or
 * "N04: WhatsApp skipped (no approved Australian template)".
 * @param {string} id        'N04' ... 'N22'
 * @param {{ sent?: string[], skipped?: Array<{ channel: string, reason: string }>, note?: string }} outcome
 * @returns {{ title: string, detail: string }|null} null when there is nothing to say
 */
function describeOutcome(id, outcome) {
  const o = outcome && typeof outcome === 'object' ? outcome : {};
  const entry = AU_MESSAGES[id] || null;
  const name = entry ? entry.name : '';
  const sent = (Array.isArray(o.sent) ? o.sent : []).map(function (c) { return CHANNEL_WORDS[c] || c; });
  const skipped = (Array.isArray(o.skipped) ? o.skipped : []).filter(function (s) { return s && s.channel && s.reason !== 'already_sent'; });
  if (!sent.length && !skipped.length) return null;
  const title = sent.length
    ? 'Message ' + id + ' sent' + (name ? ': ' + name : '') + ' (' + sent.join(', ') + ')'
    : 'Message ' + id + ' not sent' + (name ? ': ' + name : '');
  const detail = skipped.map(function (s) {
    return (CHANNEL_WORDS[s.channel] || s.channel).replace(/^./, function (c) { return c.toUpperCase(); })
      + ' skipped: ' + (SKIP_WORDS[s.reason] || String(s.reason));
  }).concat(o.note ? [String(o.note)] : []).join('. ');
  return { title, detail: detail || '' };
}

/**
 * Read a builder result's outcome (the shape _auSendDoctorMessage returns:
 * { email: { sent, reason }, bell: {...}, whatsapp: {...}, practice: { sent, reason } })
 * into describeOutcome's input.
 */
function outcomeFromSendResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const out = { sent: [], skipped: [] };
  [['email', r.email], ['bell', r.bell], ['whatsapp', r.whatsapp], ['practice_email', r.practice]].forEach(function (pair) {
    const part = pair[1];
    if (!part || typeof part !== 'object') return;
    if (part.sent === true) out.sent.push(pair[0]);
    else if (part.reason) out.skipped.push({ channel: pair[0], reason: part.reason });
  });
  return out;
}

/** Which message a once-ever ledger key belongs to: 'N04' ... or '' (not an Australian message key). */
function messageIdForLedgerKey(key) {
  const m = /^au_n(\d\d)_/.exec(String(key || ''));
  return m ? 'N' + m[1] : '';
}

// ── The registry ─────────────────────────────────────────────────────────────

const SAMPLE = Object.freeze({
  appBaseUrl: 'https://app.mygplink.com.au',
  practiceName: 'Test Metro Practice (FAKE)',
  gpName: 'Dr Test Auvr',
  contactName: 'Pat',
  placementKey: 'APP-EXAMPLE',
  startDate: '2027-02-01',
  noticeDate: '2026-12-07',
  noticeWeeks: 8,
  guaranteeEndsAt: '2027-04-26'
});

const SENT = 'sent';
const CAREFUL = 'sent, careful wording';
const SAME = 'sent, same words';
const NOT_SENT = 'not sent';

function registry() {
  const s = SAMPLE;
  const team = gpApp.teamLabel(true);
  return {
    N04: {
      id: 'N04', name: 'Welcome', origin: 'built new in WP-17',
      to: 'doctor',
      when: 'When a new account is known to be an Australian doctor\'s: at email verification if the address matches an Australian-segment lead, otherwise the moment they answer "yes" to the first onboarding question. It replaces the overseas welcome, which such a doctor never receives.',
      channels: { email: true, bell: false, whatsapp: 'welcome' },
      segments: { A: SENT, B: CAREFUL, C: CAREFUL },
      segmentNote: 'The segment is usually not known this early. The main wording is true for any Ahpra-registered doctor; the careful wording is used when a segment B or C answer is already on file.',
      quietHours: 'not held', quietWhy: 'It answers something the doctor just did (verified their email, or started the Australian branch).',
      ledgerKey: 'au_n04_welcome', once: 'once ever',
      builder: 'buildWelcomeMessage',
      trigger: { fn: 'auSendWelcomeMessage', callers: ['sendWelcomeEmail', 'auReleaseHeldWelcome'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-welcome-onboarding-server.test.js'],
      samples: function () {
        return [
          { label: 'Main wording', to: 'doctor', message: buildWelcomeMessage({ appBaseUrl: s.appBaseUrl, group: GROUP.MAIN }) },
          { label: 'Careful wording (segment B or C already on file)', to: 'doctor', message: buildWelcomeMessage({ appBaseUrl: s.appBaseUrl, group: GROUP.SAFE }) }
        ];
      }
    },
    N05: {
      id: 'N05', name: 'Finish your profile (reminders)', origin: 'built new in WP-17',
      to: 'doctor',
      when: 'A doctor who started the Australian onboarding branch (or was added by staff on an Australian pathway) and has not finished it: 1 hour, 24 hours, 3 days and 7 days after they were last active. Stops when they finish, unsubscribe or turn reminder emails off; starts again from the top if they come back and leave again.',
      channels: { email: true, bell: false, whatsapp: 'onboarding_nudge' },
      segments: { A: SENT, B: SAME, C: SAME },
      segmentNote: 'It is only about finishing the profile and promises nothing about roles, so every segment reads the same words.',
      quietHours: 'held', quietWhy: 'It goes because time has passed.',
      ledgerKey: 'the reminder row (onboarding_reminders.steps_sent), as for the overseas reminders', once: 'once per reminder per spell away',
      builder: 'buildOnboardingNudgeMessage',
      trigger: { fn: 'auOnboardingNudgeStep', callers: ['/api/cron/onboarding-nudge'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-welcome-onboarding-server.test.js'],
      samples: function () {
        return AU_ONBOARDING_NUDGE_SCHEDULE_MS.map(function (ms, n) {
          return { label: ['After 1 hour', 'After 24 hours', 'After 3 days', 'After 7 days (the last)'][n] + ', stopped on step ' + (n === 3 ? 6 : 3), to: 'doctor',
            message: buildOnboardingNudgeMessage({ appBaseUrl: s.appBaseUrl, index: n, step: n === 3 ? 5 : 2 }) };
        });
      }
    },
    N06: {
      id: 'N06', name: 'Ahpra check result', origin: 'finalised (first cut by WP-06)',
      to: 'doctor',
      when: 'When staff save the Ahpra register check. "Verified" only once the doctor is fully cleared (number matched, launched segment, staff-confirmed, nothing flagged). "Not matched" whenever the number could not be matched.',
      channels: { email: true, bell: true, whatsapp: false },
      segments: { A: SENT, B: 'verified: not sent (a person decides first, N07); not matched: sent', C: 'verified: not sent (a person decides first, N07); not matched: sent' },
      quietHours: 'not held', quietWhy: 'It is the result of a check a person has just saved.',
      ledgerKey: 'au_n06_ahpra_verified / au_n06_ahpra_not_matched:<number>', once: 'verified: once ever; not matched: once per number',
      builder: 'buildAhpraVerifiedMessage, buildAhpraNotMatchedMessage (lib/au-staff-tools.js)',
      trigger: { fn: 'auNotifyAhpraCheckResult', callers: ['recordAhpraRegisterCheck', 'auMaybeNotifyAhpraVerified'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp06-staff-tools-server.test.js'],
      samples: function () {
        return [
          { label: 'Verified', to: 'doctor', message: staffTools.buildAhpraVerifiedMessage({ appBaseUrl: s.appBaseUrl }) },
          { label: 'Number not matched', to: 'doctor', message: staffTools.buildAhpraNotMatchedMessage({ number: 'MED0001234567' }) }
        ];
      }
    },
    N07: {
      id: 'N07', name: 'Segment review (staff task)', origin: 'confirmed (built by WP-06)',
      to: 'staff',
      when: 'When the Ahpra check shows a condition, undertaking or notation, or the doctor is in segment B or C. A task for a person; nothing is sent to the doctor.',
      channels: { email: false, bell: false, whatsapp: false, task: 'segment_review' },
      segments: { A: 'raised only when something is flagged', B: 'raised', C: 'raised' },
      quietHours: 'not applicable', quietWhy: 'A staff task, not a message.',
      ledgerKey: 'one open segment_review task per case', once: 'one open task per case',
      builder: 'auStaffTools.buildSegmentReviewTask',
      trigger: { fn: 'auRaiseSegmentReviewTask', callers: ['recordAhpraRegisterCheck', 'onAuOnboardingCompleted'] },
      tests: ['tests/au-wp17-registry.test.js', 'tests/au-wp06-staff-tools-server.test.js'],
      samples: function () { return []; }
    },
    N08: {
      id: 'N08', name: 'Profile complete', origin: 'built new in WP-17',
      to: 'doctor',
      when: 'The moment a doctor finishes the Australian onboarding branch. Replaces "Profile Complete: the next step is MyIntealth", which an Australian doctor never receives.',
      channels: { email: true, bell: false, whatsapp: false },
      segments: { A: SENT, B: CAREFUL, C: CAREFUL },
      segmentNote: 'Segments B and C are told a person will be in touch about what fits their registration. No roles are promised.',
      quietHours: 'not held', quietWhy: 'It answers something the doctor just did.',
      ledgerKey: 'au_n08_profile_complete', once: 'once ever',
      builder: 'buildProfileCompleteMessage',
      trigger: { fn: 'auSendProfileCompleteMessage', callers: ['completeAuOnboarding'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-welcome-onboarding-server.test.js'],
      samples: function () {
        return [
          { label: 'Main wording (segment A)', to: 'doctor', message: buildProfileCompleteMessage({ appBaseUrl: s.appBaseUrl, group: GROUP.MAIN }) },
          { label: 'Careful wording (segments B and C)', to: 'doctor', message: buildProfileCompleteMessage({ appBaseUrl: s.appBaseUrl, group: GROUP.SAFE }) }
        ];
      }
    },
    N09: {
      id: 'N09', name: 'Match invitation, reminder, final call', origin: 'confirmed (the existing emails; reasons and tags by WP-08)',
      to: 'doctor',
      when: 'When staff shortlist the doctor for a role; again with 24 hours left and with 2 hours left. These are the existing match emails. For an Australian doctor the reasons are the Australian ones and the tags that do not apply are hidden.',
      channels: { email: true, bell: true, whatsapp: 'match_invitation' },
      segments: { A: SENT, B: 'not sent (a doctor in an unlaunched segment cannot be matched)', C: 'not sent (a doctor in an unlaunched segment cannot be matched)' },
      quietHours: 'invitation and 24-hour reminder: not held; final call: held', quietWhy: 'The invitation follows a staff action and the 24-hour reminder is anchored on the invitation\'s own deadline. The final call (2 hours before the deadline) is only sent between 08:00 and 20:00 on the doctor\'s clock; if the deadline passes overnight it is not sent at all.',
      ledgerKey: 'the application row (match_reminder_sent_at, match_final_call_sent_at)', once: 'once per invitation',
      builder: 'buildMatchEmailHtml (server.js)',
      trigger: { fn: 'sendMatchEmail', callers: ['announceShortlistToGp'] },
      tests: ['tests/au-wp17-existing-messages-server.test.js'],
      samples: function () { return []; }
    },
    N10: {
      id: 'N10', name: 'Introduction to the practice', origin: 'confirmed (built by WP-09)',
      to: 'practice',
      when: 'When staff submit the doctor to a practice. Says only what is on file.',
      channels: { email: true, bell: false, whatsapp: 'practice_intro' },
      segments: { A: SENT, B: 'sent, with the 19AB and supervision chips', C: 'sent, never called vocationally registered' },
      quietHours: 'not held', quietWhy: 'A staff action.',
      ledgerKey: 'the application row', once: 'once per submission',
      builder: 'careerIntro.buildAuCandidateIntro (lib/career-intro.js)',
      trigger: { fn: 'auPracticeIntroFor', callers: ['/api/practice/application/decision-context', 'handleApi'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-existing-messages-server.test.js', 'tests/au-wp09-server.test.js'],
      samples: function () {
        const facts = careerIntro.auIntroFactsFromRecords({
          pathwayResult: { pathway: 'au_vr', isAu: true, confirmed: true, launched: true, dpaRestricted: false, needsStaffReview: false, hasRegistrationFlags: false },
          credentials: { fellowship_type: 'fracgp', staff_verified_at: '2026-11-01T00:00:00.000Z', ahpra_number: 'MED0001234567', ahpra_registration_type: 'specialist', specialist_gp: true, has_conditions: false },
          profile: { current_state: 'VIC', register_body: 'ahpra', register_status: 'verified', notice_period_weeks: 4 },
          now: Date.parse('2026-11-22T00:00:00Z')
        });
        const intro = careerIntro.buildAuCandidateIntro({ gpName: s.gpName, facts });
        return [{ label: 'A staff-confirmed segment A doctor', to: 'practice', message: { id: 'N10', subject: '(the introduction email)', text: intro.paragraph + '\n\n' + (intro.confidentialityNote || '') } }];
      }
    },
    N11: {
      id: 'N11', name: 'Placement secured: your pre-start checklist', origin: 'finalised (first cut by WP-11)',
      to: 'doctor',
      when: 'When a placement is recorded for the doctor.',
      channels: { email: true, bell: true, whatsapp: 'placement_secured' },
      segments: { A: SENT, B: 'sent, with one extra line about registration', C: 'sent, with one extra line about registration' },
      quietHours: 'not held', quietWhy: 'It follows the placement being recorded.',
      ledgerKey: 'au_n11_placement_secured:<placement>', once: 'once per placement',
      builder: 'buildPlacementSecuredMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'auSendPlacementSecuredToGp', callers: ['_auRunPlacementHooksInner'], via: { _auRunPlacementHooksInner: ['auRunPlacementHooks'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp11-placement-server.test.js'],
      samples: function () {
        return [
          { label: 'Segment A', to: 'doctor', message: placement.buildPlacementSecuredMessage({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, startDate: s.startDate, placementKey: s.placementKey }) },
          { label: 'Segments B and C', to: 'doctor', message: placement.buildPlacementSecuredMessage({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, startDate: s.startDate, placementKey: s.placementKey, variant: 'B' }) }
        ];
      }
    },
    N12: {
      id: 'N12', name: 'Placement confirmed', origin: 'finalised (first cut by WP-11)',
      to: 'practice',
      when: 'When a placement is recorded. Replaces the overseas "Placement confirmed", which promises AHPRA steps.',
      channels: { email: true, bell: false, whatsapp: false },
      segments: { A: SENT, B: 'sent, with a supervision line when the registration needs it', C: SENT },
      quietHours: 'not held', quietWhy: 'It follows the placement being recorded.',
      ledgerKey: 'au_n12_placement_confirmed:<placement>', once: 'once per placement',
      builder: 'buildPlacementConfirmedPracticeMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'auSendPlacementConfirmedToPractice', callers: ['_auRunPlacementHooksInner'], via: { _auRunPlacementHooksInner: ['auRunPlacementHooks'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp11-placement-server.test.js'],
      samples: function () {
        return [{ label: 'Segment A', to: 'practice', message: placement.buildPlacementConfirmedPracticeMessage({ gpName: s.gpName, contactName: s.contactName, roleTitle: 'General Practitioner', startDate: s.startDate, placementKey: s.placementKey }) }];
      }
    },
    N13: {
      id: 'N13', name: 'Needed before you start', origin: 'finalised (first cut by WP-11)',
      to: 'doctor',
      when: 'When staff ask for a pre-start item, and automatically 3 and 7 days after the placement for required documents still missing.',
      channels: { email: true, bell: true, whatsapp: false },
      segments: { A: SENT, B: SENT, C: SENT },
      quietHours: 'held (the automatic reminders); not held (a staff request)', quietWhy: 'The automatic reminders go because time has passed.',
      ledgerKey: 'au_n13_prestart_item:<request>', once: 'once per request',
      builder: 'buildPrestartItemRequestMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'auSendPrestartItemRequest', callers: ['runAuPrestartSweep', '/api/admin/au/prestart/request-item'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp11-staff-actions-server.test.js'],
      samples: function () {
        return [{ label: 'Two items, automatic reminder', to: 'doctor', message: placement.buildPrestartItemRequestMessage({
          appBaseUrl: s.appBaseUrl, requestKey: 'docs:' + s.placementKey + ':d3', startDate: s.startDate, reminder: true,
          items: [{ label: 'Medical indemnity certificate of currency', help: 'Upload your current certificate.' }, placement.GP_REQUEST_ITEMS.provider_number]
        }) }];
      }
    },
    N14: {
      id: 'N14', name: 'What we need from your practice', origin: 'finalised (first cut by WP-11)',
      to: 'practice',
      when: 'When staff ask the practice to sign or supply something before the start date.',
      channels: { email: true, bell: false, whatsapp: false },
      segments: { A: SENT, B: SENT, C: SENT },
      quietHours: 'not held', quietWhy: 'A staff action.',
      ledgerKey: 'au_n14_practice_form:<request>', once: 'once per request',
      builder: 'buildPracticeFormNeededMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'auSendPracticeFormNeeded', callers: ['/api/admin/au/prestart/practice-request'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp11-placement-server.test.js', 'tests/au-wp11-staff-actions-server.test.js'],
      samples: function () {
        return [{ label: 'Two items', to: 'practice', message: placement.buildPracticeFormNeededMessage({
          gpName: s.gpName, contactName: s.contactName, startDate: s.startDate, requestKey: s.placementKey + ':1',
          itemKeys: ['provider_number_location_details', 'orientation_details']
        }) }];
      }
    },
    N15: {
      id: 'N15', name: 'Notice given, start date confirmed', origin: 'built new in WP-17',
      to: 'doctor and practice',
      when: 'Twice: when the doctor records in the app that they have given notice, and when staff confirm the start date. A start date that later changes sends one correction.',
      channels: { email: true, bell: true, whatsapp: false, practiceEmail: true },
      segments: { A: SENT, B: SENT, C: SENT },
      segmentNote: 'It confirms facts already on file about a placement that exists; it promises nothing.',
      quietHours: 'notice: not held; start date: held', quietWhy: 'The notice confirmation answers something the doctor just did. The start-date confirmation follows a staff action that can happen at any hour, so it waits for the doctor\'s day.',
      ledgerKey: 'au_n15_notice_gp:<placement>:<date> / au_n15_start_gp:<placement>:<date> (and the practice twins)', once: 'once per notice date; once per confirmed start date',
      builder: 'buildNoticeStartGpMessage, buildNoticeStartPracticeMessage',
      trigger: { fn: 'auSendNoticeStartMessages', callers: ['/api/gp/au-prestart/notice', 'auAfterPrestartChange', 'runAuMessagePass'], via: { auAfterPrestartChange: ['auConfirmStartDate'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-prestart-messages-server.test.js'],
      samples: function () {
        return [
          { label: 'The doctor recorded notice', to: 'doctor', message: buildNoticeStartGpMessage({ appBaseUrl: s.appBaseUrl, kind: N15_KIND.NOTICE, practiceName: s.practiceName, placementKey: s.placementKey, noticeDate: s.noticeDate, startDate: s.startDate, teamLabel: team }) },
          { label: 'The doctor recorded notice', to: 'practice', message: buildNoticeStartPracticeMessage({ kind: N15_KIND.NOTICE, gpName: s.gpName, contactName: s.contactName, placementKey: s.placementKey, noticeDate: s.noticeDate, startDate: s.startDate }) },
          { label: 'Start date confirmed', to: 'doctor', message: buildNoticeStartGpMessage({ appBaseUrl: s.appBaseUrl, kind: N15_KIND.START_DATE, practiceName: s.practiceName, placementKey: s.placementKey, noticeDate: s.noticeDate, noticeWeeks: s.noticeWeeks, startDate: s.startDate, teamLabel: team }) },
          { label: 'Start date confirmed', to: 'practice', message: buildNoticeStartPracticeMessage({ kind: N15_KIND.START_DATE, gpName: s.gpName, contactName: s.contactName, placementKey: s.placementKey, noticeDate: s.noticeDate, noticeWeeks: s.noticeWeeks, startDate: s.startDate }) },
          { label: 'Start date changed (the correction)', to: 'doctor', message: buildNoticeStartGpMessage({ appBaseUrl: s.appBaseUrl, kind: N15_KIND.START_DATE, correction: true, practiceName: s.practiceName, placementKey: s.placementKey, noticeWeeks: s.noticeWeeks, startDate: '2027-02-15', teamLabel: team }) },
          { label: 'Start date changed (the correction)', to: 'practice', message: buildNoticeStartPracticeMessage({ kind: N15_KIND.START_DATE, correction: true, gpName: s.gpName, contactName: s.contactName, placementKey: s.placementKey, noticeWeeks: s.noticeWeeks, startDate: '2027-02-15' }) }
        ];
      }
    },
    N16: {
      id: 'N16', name: 'Cleared to start', origin: 'built new in WP-17',
      to: 'doctor',
      when: 'When the last of the four pre-start tasks is completed (start date confirmed, indemnity certificate approved, provider number recorded, credentialing pack sent), and checked again by the daily job in case that moment was missed.',
      channels: { email: true, bell: true, whatsapp: 'cleared_to_start' },
      segments: { A: SENT, B: NOT_SENT, C: NOT_SENT },
      segmentNote: 'For segments B and C "cleared to start" can depend on things this checklist does not hold (a nomination transfer, supervision paperwork, a program approval), and those rules are not confirmed. A person tells them. Recorded on the timeline as skipped.',
      quietHours: 'held', quietWhy: 'It follows a staff action that can happen at any hour.',
      ledgerKey: 'au_n16_cleared_to_start:<placement>', once: 'once per placement',
      builder: 'buildClearedToStartMessage',
      trigger: { fn: 'auMaybeSendClearedToStart', callers: ['auAfterPrestartChange', 'runAuMessagePass'], via: { auAfterPrestartChange: ['auConfirmStartDate', 'auRecordProviderNumber', 'auOnAuDocumentApproved'], runAuMessagePass: ['runAuLifecycleSweep'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-prestart-messages-server.test.js'],
      samples: function () {
        return [{ label: 'Segment A', to: 'doctor', message: buildClearedToStartMessage({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, startDate: s.startDate, placementKey: s.placementKey, teamLabel: team }) }];
      }
    },
    N17: {
      id: 'N17', name: 'A quick reminder (stalled)', origin: 'built new in WP-17',
      to: 'doctor',
      when: '14 and 28 days after the milestone the case is aged from (profile finished, for a doctor not yet placed; the placement recorded, for pre-start), and only if something is waiting on the doctor: a match they have not answered, a required document not uploaded, notice not recorded, referees not given, a provider number not recorded. With nothing of theirs outstanding, nothing is sent.',
      channels: { email: true, bell: false, whatsapp: false },
      segments: { A: SENT, B: 'pre-start: sent; before a placement: not sent', C: 'pre-start: sent; before a placement: not sent' },
      segmentNote: 'Before a placement a doctor in an unlaunched segment has nothing they can do, so there is nothing to remind them of.',
      quietHours: 'held', quietWhy: 'It goes because time has passed.',
      ledgerKey: 'au_n17_stalled:match:<mark> / au_n17_stalled:prestart:<placement>:<mark>', once: 'once per mark (day 14, day 28)',
      builder: 'buildStalledReminderMessage',
      trigger: { fn: 'auSendStalledReminder', callers: ['runAuMessagePass', 'sendStalledNudgeForPosition'], via: { runAuMessagePass: ['runAuLifecycleSweep'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-prestart-messages-server.test.js'],
      samples: function () {
        return [
          { label: 'Pre-start, three things waiting on the doctor', to: 'doctor', message: buildStalledReminderMessage({
            appBaseUrl: s.appBaseUrl, stage: N17_STAGE.PRESTART, mark: 'd14', placementKey: s.placementKey, practiceName: s.practiceName, startDate: s.startDate, teamLabel: team,
            actions: [
              { label: 'Tell us when you have given notice', help: 'Record the date in your checklist so we can confirm your start date.' },
              { label: 'Medical indemnity certificate of currency', help: 'Upload your current certificate.' },
              { label: 'Two referees', help: 'Give us two people we can speak to. We ask you before contacting anyone at your current practice.' }
            ]
          }) },
          { label: 'Not yet placed, one match not answered', to: 'doctor', message: buildStalledReminderMessage({
            appBaseUrl: s.appBaseUrl, stage: N17_STAGE.MATCH, mark: 'd14', teamLabel: gpApp.teamLabel(false), actions: [matchAction(1)]
          }) }
        ];
      }
    },
    N18: {
      id: 'N18', name: 'First week check-in', origin: 'finalised (first cut by WP-13)',
      to: 'doctor and practice',
      when: '7 days after staff confirm the doctor started.',
      channels: { email: true, bell: true, whatsapp: 'commencement_checkin', practiceEmail: true },
      segments: { A: SENT, B: SENT, C: SENT },
      quietHours: 'held (on the practice\'s clock)', quietWhy: 'It goes because time has passed.',
      ledgerKey: 'au_lc:week1:<placement> (owner) + au_n18_week1_gp / au_n18_week1_practice', once: 'once per placement',
      builder: 'buildCommencementCheckinGpMessage, buildCommencementCheckinPracticeMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'runLifecycleSweep', file: 'lib/au-commencement.js', callers: ['runAuLifecycleSweep'], via: { runAuLifecycleSweep: ['runAuLifecycleInHoursPass'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp13-server.test.js'],
      samples: function () {
        return [
          { label: 'To the doctor', to: 'doctor', message: placement.buildCommencementCheckinGpMessage({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, placementKey: s.placementKey, teamLabel: team }) },
          { label: 'To the practice', to: 'practice', message: placement.buildCommencementCheckinPracticeMessage({ gpName: s.gpName, contactName: s.contactName, placementKey: s.placementKey }) }
        ];
      }
    },
    N19: {
      id: 'N19', name: 'Check-ins at weeks 4, 8 and 12', origin: 'finalised (first cut by WP-13)',
      to: 'doctor and practice',
      when: '4, 8 and 12 weeks after the doctor started.',
      channels: { email: true, bell: true, whatsapp: false, practiceEmail: true },
      segments: { A: SENT, B: SENT, C: SENT },
      quietHours: 'held (on the practice\'s clock)', quietWhy: 'It goes because time has passed.',
      ledgerKey: 'au_lc:checkin:<placement>:w4|w8|w12 (owner) + au_n19_checkin_w<N>_gp / _practice', once: 'once per placement and week',
      builder: 'buildWeekCheckinGpMessage, buildWeekCheckinPracticeMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'runLifecycleSweep', file: 'lib/au-commencement.js', callers: ['runAuLifecycleSweep'], via: { runAuLifecycleSweep: ['runAuLifecycleInHoursPass'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp13-server.test.js'],
      samples: function () {
        return [
          { label: 'Week 4, to the doctor', to: 'doctor', message: placement.buildWeekCheckinGpMessage({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, placementKey: s.placementKey, week: 4, teamLabel: team }) },
          { label: 'Week 4, to the practice', to: 'practice', message: placement.buildWeekCheckinPracticeMessage({ gpName: s.gpName, contactName: s.contactName, placementKey: s.placementKey, week: 4, guaranteeEndsAt: s.guaranteeEndsAt }) },
          { label: 'Week 12, to the doctor', to: 'doctor', message: placement.buildWeekCheckinGpMessage({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, placementKey: s.placementKey, week: 12, teamLabel: team }) },
          { label: 'Week 12, to the practice', to: 'practice', message: placement.buildWeekCheckinPracticeMessage({ gpName: s.gpName, contactName: s.contactName, placementKey: s.placementKey, week: 12, guaranteeEndsAt: s.guaranteeEndsAt }) }
        ];
      }
    },
    N20: {
      id: 'N20', name: 'Twelve weeks in: thank you', origin: 'finalised (first cut by WP-13)',
      to: 'doctor',
      when: 'The day after the twelve weeks end. A thank-you and a referral ask. No reward is offered: none exists.',
      channels: { email: true, bell: true, whatsapp: false },
      segments: { A: SENT, B: SENT, C: SENT },
      quietHours: 'held (on the practice\'s clock)', quietWhy: 'It goes because time has passed.',
      ledgerKey: 'au_lc:referral:<placement> (owner) + au_n20_referral_ask:<placement>', once: 'once per placement',
      builder: 'buildReferralAskMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'runLifecycleSweep', file: 'lib/au-commencement.js', callers: ['runAuLifecycleSweep'], via: { runAuLifecycleSweep: ['runAuLifecycleInHoursPass'] } },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp13-server.test.js'],
      samples: function () {
        return [{ label: 'To the doctor', to: 'doctor', message: placement.buildReferralAskMessage({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, placementKey: s.placementKey, teamLabel: team }) }];
      }
    },
    N21: {
      id: 'N21', name: 'What we have confirmed (segment B)', origin: 'finalised (first cut by WP-14)',
      to: 'doctor and practice',
      when: 'Only when a staff member ticks "I have checked each outcome" on the Segment B card and chooses who to send it to. Never automatic.',
      channels: { email: true, bell: false, whatsapp: false, practiceEmail: true },
      segments: { A: NOT_SENT, B: 'sent by staff only', C: NOT_SENT },
      segmentNote: 'The one message where the word "visa" may appear, and only for a segment B doctor whose right to work is tied to a sponsor (the WP-14 exception).',
      quietHours: 'not held', quietWhy: 'A staff action.',
      ledgerKey: 'au_n21_segment_b_gp:<placement>:<outcomes> / au_n21_segment_b_practice:…', once: 'once per set of outcomes per recipient',
      builder: 'buildSegmentBOutcomeGpMessage, buildSegmentBOutcomePracticeMessage (lib/au-placement-messages.js)',
      trigger: { fn: 'auSendSegmentBN21', callers: ['/api/admin/au/segment-b/n21-send'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp14-segment-b-server.test.js'],
      samples: function () {
        const outcome = { moratorium: placement.N21_MORATORIUM.DPA_ONLY, supervision: placement.N21_SUPERVISION.NOT_NEEDED, visa: placement.N21_VISA.NOT_APPLICABLE };
        return [
          { label: 'To the doctor (a citizen or permanent resident: no visa part)', to: 'doctor', message: placement.buildSegmentBOutcomeGpMessage(Object.assign({ appBaseUrl: s.appBaseUrl, practiceName: s.practiceName, placementKey: s.placementKey, teamLabel: team }, outcome)) },
          { label: 'To the practice', to: 'practice', message: placement.buildSegmentBOutcomePracticeMessage(Object.assign({ gpName: s.gpName, contactName: s.contactName, placementKey: s.placementKey }, outcome)) }
        ];
      }
    },
    N22: {
      id: 'N22', name: 'Australian pipeline (owner digest block)', origin: 'built new in WP-17',
      to: 'owner',
      when: 'Inside the weekly owner digest, when there is at least one doctor on an Australian pathway. A week with none leaves the digest exactly as it was.',
      channels: { email: true, bell: false, whatsapp: false },
      segments: { A: 'counted', B: 'counted, and flagged as needing a person', C: 'counted, and flagged as needing a person' },
      quietHours: 'not applicable', quietWhy: 'Part of the existing weekly email to the owner.',
      ledgerKey: 'the digest\'s own weekly marker', once: 'once a week, with the digest',
      builder: 'auPipelineCounts, buildOwnerDigestBlock',
      trigger: { fn: 'auOwnerDigestBlock', callers: ['sendOwnerDigestEmail'] },
      tests: ['tests/au-wp17-copy.test.js', 'tests/au-wp17-existing-messages-server.test.js'],
      samples: function () {
        const counts = { total: 9, stages: { onboarding: 2, placement: 3, prestart: 2, commenced: 1, guarantee: 1, complete: 0 }, segments: { A: 7, B: 1, C: 1 }, needsReview: 2 };
        return [{ label: 'Nine Australian doctors', to: 'owner', message: { id: 'N22', subject: '(inside the weekly digest)', text: buildOwnerDigestBlock(counts).text } }];
      }
    }
  };
}

/**
 * WP-18 (T2): the reminder for a call an Australian doctor has booked with a
 * GP Link staff member (not the CEO's consultation). The overseas doctor gets
 * these two reminders by WhatsApp, in templates about "your registration
 * support call"; an Australian doctor gets this email instead. Deliberately
 * says nothing about what the call is for.
 * @param {{ window: 'h24'|'soon', firstName?, whenText, joinUrl }} input
 *   whenText: the time on the doctor's own clock, "Thursday 14 January,
 *   10:30 am (Perth time)"
 * @returns {object|null} null without a join link (or, for the day-before
 *   one, without a time): the message is never sent half-made
 */
function buildStaffCallReminderMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const join = clean(i.joinUrl, 600);
  const when = clean(i.whenText, 120);
  const first = clean(i.firstName, 60);
  const soon = i.window === 'soon';
  if (!join || (!soon && !when)) return null;
  const hi = first ? 'Hi ' + first + ',' : 'Hi there,';
  const lines = soon
    ? [hi + ' your call with the GP Link team is starting now.', '',
      'Use the button below to join. If you are running a few minutes late, that is fine: join when you can.', '',
      'If you need to move it, reply to this email and we will find another time.']
    : [hi + ' a reminder that your call with the GP Link team is coming up on ' + when + '.', '',
      'Use the button below to join when it is time.', '',
      'If the time no longer suits, reply to this email and we will find another.'];
  const body = lines.join('\n');
  return {
    id: 'staff_call_reminder',
    window: soon ? 'soon' : 'h24',
    subject: soon ? 'Your GP Link call is starting' : 'Reminder: your GP Link call is coming up',
    title: soon ? 'Your call is starting' : 'Your GP Link call',
    body: body,
    ctaText: 'Join the call',
    ctaUrl: join,
    text: body + '\n\nJoin the call: ' + join
  };
}

const AU_MESSAGES = Object.freeze(registry());
const MESSAGE_IDS = Object.freeze(Object.keys(AU_MESSAGES));

// Every NEW WhatsApp template a lifecycle message needs (none approved yet:
// lib/au-whatsapp-templates.js). `existing` names the existing template the
// row stands in for: its live wording was read by WP-18
// (docs/au-gp/whatsapp-live-templates.md) and says "your Registration Support
// Officer", so an Australian doctor is not sent it (unless the owner switches
// its `_existing` row on) and gets the email until this neutral version is
// approved. Each takes the same variables in the same order as the existing
// one, because the same code fills both. No body starts or ends with a
// variable. (The match invitation and "account released" are not here: their
// existing templates were confirmed neutral and are reused.)
const LIFECYCLE_WHATSAPP_TEMPLATES = Object.freeze([
  { key: 'welcome', message: 'N04', templateName: 'gp_link_au_welcome', variables: '{{1}} first name', button: 'URL button: "Finish my profile" to https://app.mygplink.com.au/pages/onboarding',
    body: 'Hi {{1}}, welcome to GP Link. Your account is ready.\n\nThe next step is to finish your profile. It takes a few minutes: have your Ahpra registration number to hand.\n\nWe never contact your current practice without asking you first.' },
  { key: 'onboarding_nudge', message: 'N05', templateName: 'gp_link_au_onboarding_nudge', variables: '{{1}} first name', button: 'URL button: "Continue my profile" to https://app.mygplink.com.au/pages/onboarding',
    body: 'Hi {{1}}, your GP Link profile is saved where you left it and takes a few minutes to finish. Have your Ahpra registration number to hand.\n\nIf anything in the form is unclear, reply here and we will help.' },
  { key: 'cleared_to_start', message: 'N16', templateName: 'gp_link_au_cleared_to_start', variables: '{{1}} first name, {{2}} practice name, {{3}} the start date', button: 'none',
    body: 'Hi {{1}}, good news: everything on your pre-start checklist is complete, and you are cleared to start at {{2}} on {{3}}.\n\nIf anything changes before then, reply here and we will help.' },
  { key: 'match_accepted', message: 'N09', existing: 'gp_link_app_match_accepted', templateName: 'gp_link_au_match_accepted', variables: '{{1}} first name, {{2}} practice name', button: 'none',
    body: 'Hi {{1}}, thanks for accepting your match with {{2}}. We are now arranging your interview and will send you times to choose from, usually within a couple of business days. Reply here if you have any questions.' },
  { key: 'interview_times_ready', message: 'existing "interview times ready"', existing: 'gp_link_interview_times_ready', templateName: 'gp_link_au_interview_times_ready', variables: '{{1}} first name, {{2}} practice name', button: 'URL button: "Choose your time" to https://app.mygplink.com.au/pages/secure-interview?applicationId={{1}} (the app fills the application id)',
    body: 'Hi {{1}}, great news: {{2}} would like to interview you, and their available times are ready for you to choose from.\n\nTap the button below to pick the time that suits you best. It only takes a moment.\n\nIf none of the times work for you, just reply to this message and we will arrange others.' },
  { key: 'interview_confirmed', message: 'existing "interview confirmed" (to the doctor)', existing: 'gp_link_interview_confirmed_gp', templateName: 'gp_link_au_interview_confirmed_gp', variables: '{{1}} first name, {{2}} practice name, {{3}} the time on the doctor\'s own clock, {{4}} the link to join', button: 'none',
    body: 'Hi {{1}}, your interview with {{2}} is confirmed for {{3}}.\n\nJoin the video call here when it is time:\n{{4}}\n\nIf you need to reschedule, just reply to this message and we will sort it out.' },
  { key: 'interview_confirmed_practice', message: 'existing "interview confirmed" (to the practice)', existing: 'gp_link_interview_confirmed_practice', templateName: 'gp_link_au_interview_confirmed_practice', variables: '{{1}} contact name, {{2}} the doctor, {{3}} the time on the practice\'s own clock, {{4}} the link to join', button: 'none',
    body: 'Hello {{1}}, this is GP Link. Your interview with {{2}} is confirmed for {{3}}.\n\nJoin the video call here when it is time:\n{{4}}\n\nIf you need to reschedule, just reply to this message and we will arrange a new time.' },
  { key: 'contract_ready', message: 'existing "contract ready"', existing: 'gp_link_contract_ready', templateName: 'gp_link_au_contract_ready', variables: '{{1}} first name, {{2}} practice name', button: 'URL button: "Complete agreement" to https://app.mygplink.com.au/pages/offer-review?applicationId={{1}} (the app fills the application id)',
    body: 'Congratulations {{1}}, {{2}} has offered you the position.\n\nThe next step is to review your employment agreement and sign it. Tap the button below to open it. If something needs adjusting before you can sign, you can request a change on the same page.\n\nAny questions, reply here and our team will help.' },
  { key: 'rso_welcome', message: 'existing "RSO welcome" (F47)', existing: 'gp_link_app_rso_welcome', templateName: 'gp_link_au_team_welcome', variables: '{{1}} first name, {{2}} the team member\'s first name, {{3}} the same name again as the sign-off (the same three variables as the existing template)', button: 'none',
    body: 'Hi Dr {{1}}, welcome to GP Link.\n\nI\'m {{2}}, and I will be your main point of contact from here to your first day at your new practice.\n\nWhenever you have a question or need a hand, just send me a message here.\n\nWarm regards,\n{{3}}\nGP Link' }
]);

module.exports = Object.assign({}, placement, {
  CONFIDENTIALITY_LINE,
  CONFIDENTIAL_PARAGRAPH,
  GP_FOOTER,
  PRACTICE_FOOTER,
  GROUP,
  groupForPathway,
  segmentLetter,
  // COM-23
  OVERSEAS_ROLE_LABEL,
  roleLabelFor,
  applyRoleLabel,
  applyRoleLabelDeep,
  containsRoleLabel,
  // N04
  buildWelcomeMessage,
  // N05
  AU_ONBOARDING_NUDGE_SCHEDULE_MS,
  AU_ONBOARDING_STEP_LABELS,
  auOnboardingStepOf,
  auOnboardingNextDue,
  auOnboardingExhausted,
  buildOnboardingNudgeMessage,
  // N06 (lib/au-staff-tools.js)
  buildAhpraVerifiedMessage: staffTools.buildAhpraVerifiedMessage,
  buildAhpraNotMatchedMessage: staffTools.buildAhpraNotMatchedMessage,
  buildCandidateInviteEmail: staffTools.buildCandidateInviteEmail,
  // N08
  buildProfileCompleteMessage,
  // WP-18: the staff-hosted call reminder (email only)
  buildStaffCallReminderMessage,
  // N15
  N15_KIND,
  buildNoticeStartGpMessage,
  buildNoticeStartPracticeMessage,
  // N16
  buildClearedToStartMessage,
  // N17
  N17_STAGE,
  N17_MARK_DAYS,
  N17_LATE_DAYS,
  stalledMarkFor,
  matchAction,
  buildStalledReminderMessage,
  // N22
  PIPELINE_STAGES,
  auPipelineCounts,
  buildOwnerDigestBlock,
  // COM-18
  AU_NUDGE_TEMPLATES,
  AU_NUDGE_EMAIL_FOOTER,
  resolveAuNudgeTemplate,
  OVERSEAS_ONLY_COMPOSER_KEYS,
  AU_COMPOSER_TEMPLATES,
  composerTemplatesFor,
  // COM-20
  INTAKE_AU_LINE,
  // E
  describeOutcome,
  outcomeFromSendResult,
  messageIdForLedgerKey,
  // the registry
  SAMPLE,
  AU_MESSAGES,
  MESSAGE_IDS,
  LIFECYCLE_WHATSAPP_TEMPLATES
});
