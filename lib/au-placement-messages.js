'use strict';
/**
 * WP-11 (Australian GP build): the messages an Australian placement sends.
 * Pure, no I/O. server.js decides WHEN each goes and sends it through the
 * guarded helpers; this file is the only place that says WHAT each says.
 *
 *   N11  placement secured        -> the doctor   email, bell, WhatsApp (only
 *                                                 through an approved
 *                                                 Australian template)
 *   N12  placement confirmed      -> the practice email
 *   N13  a pre-start item is asked for -> the doctor   email, bell
 *   N14  the practice must sign or supply something -> the practice   email
 *   N18  one week after the start -> the doctor (email, bell, WhatsApp only
 *        through an approved Australian template) and the practice (email;
 *        WhatsApp only through an approved Australian template)
 *   N19  weeks 4, 8 and 12 -> the doctor (email, bell) and the practice (email)
 *   N20  twelve weeks in -> the doctor (email, bell): a referral ask
 *        (N18 to N20 are WP-13's; the daily lifecycle job sends them)
 *
 * This is first-cut copy. **WP-17 owns the final wording: change it here.**
 * Each builder returns a `key` for the once-ever ledger (gp_nudge_log), so
 * each message goes at most once per placement (N13 / N14: once per request).
 *
 * Rules the copy keeps (tests scan every builder's output):
 *   - nothing from AGENT-RULES section 4 reaches a doctor;
 *   - a practice is never told a doctor is "internationally trained", never
 *     promised "AHPRA steps", never shown a dollar figure or a percentage;
 *   - the regulator is "Ahpra";
 *   - the promise about the doctor's current practice is the FB-1 wording;
 *   - the guarantee is described only as the 2026 agreement describes it
 *     (assets/legal/src/agreement-2026.html: "A 12-week guarantee period
 *     applies to permanent placements"; it runs "from the date the candidate
 *     commences the placement"; clause 7). No credit figures are quoted.
 *   - dates are calendar dates ("1 February 2027"); no clock times are sent,
 *     so no time-zone label is needed.
 */

const CURRENT_PRACTICE_PROMISE = 'We never contact your current practice without asking you first';
const GP_FOOTER = 'Questions? Reply to this email and our team will help.';
const PRACTICE_FOOTER = 'Sent by the GP Link recruitment team.';

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

/** "1 February 2027" for a YYYY-MM-DD date; '' for anything else. */
function formatStartDate(value) {
  const s = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const t = Date.parse(s + 'T00:00:00Z');
  if (!Number.isFinite(t)) return '';
  try {
    return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(t));
  } catch (e) { return ''; }
}

function ledgerPart(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 80) || 'none';
}

// ── N11: placement secured -> the doctor ─────────────────────────────────────

/**
 * @param {{ appBaseUrl, practiceName?, startDate?, placementKey, variant? }} input
 *   variant: 'A' (default) or 'B' / 'C' (one extra neutral line)
 * @returns {{ id, key, subject, title, body, ctaText, ctaUrl, footer, bell, whatsapp }}
 */
function buildPlacementSecuredMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const practice = clean(i.practiceName, 160);
  const start = formatStartDate(i.startDate);
  const extra = i.variant === 'B' || i.variant === 'C';
  const lines = [
    'Your placement' + (practice ? ' at ' + practice : '') + ' is secured.'
      + (start ? ' Your expected start date is ' + start + '.' : ''),
    '',
    'Before your first day there are a few things to line up. Your pre-start checklist:',
    '• Notice period and start date: tell us your notice period so we can confirm your start date with the practice.',
    '• Medicare provider number: you will need a provider number for the new practice location. Let us know once you have applied, and the number when it is issued.',
    '• Indemnity: upload your current medical indemnity certificate of currency.',
    '• Credentialing: we put together the pack the practice needs (your Ahpra registration, your indemnity certificate and your other pre-start documents) and send it to them for you.'
  ];
  if (extra) lines.push('• Registration: our team will be in touch about anything your registration needs for the new practice.');
  lines.push('');
  lines.push('You can upload your documents and see what is still needed in the app. A member of our team will be in touch to help with each step.');
  lines.push('');
  lines.push(CURRENT_PRACTICE_PROMISE + '.');
  return {
    id: 'N11',
    key: 'au_n11_placement_secured:' + ledgerPart(i.placementKey),
    subject: 'Your placement is secured: your pre-start checklist',
    title: 'Congratulations, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Open your checklist',
    ctaUrl: base + '/pages/prestart',
    footer: GP_FOOTER,
    bell: {
      type: 'success',
      title: 'Your placement is secured',
      target: '/pages/prestart',
      body: 'Your pre-start checklist is ready: start date, a Medicare provider number for the new location, your indemnity certificate and credentialing.'
        + (start ? ' Expected start date: ' + start + '.' : '')
    },
    // Placeholders for the proposed template (docs/au-gp/whatsapp-templates.md,
    // key `placement_secured`): {{1}} first name, {{2}} practice name.
    whatsapp: { templateKey: 'placement_secured', placeholders: ['{{name}}', practice || 'your new practice'] }
  };
}

// ── N12: placement confirmed -> the practice ─────────────────────────────────

/**
 * @param {{ gpName, contactName?, roleTitle?, startDate?, placementKey,
 *           supervisionPaperwork?: boolean, staffDecisionPending?: boolean,
 *           contactLine?: string }} input
 * @returns {{ id, key, subject, title, bodyHtml, text, footer }}
 */
function buildPlacementConfirmedPracticeMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const dr = drName(i.gpName) || 'Your GP Link candidate';
  const role = clean(i.roleTitle, 160) || 'the GP role';
  const contact = clean(i.contactName, 120) || 'there';
  const start = formatStartDate(i.startDate);
  const bullets = [
    'Start date: ' + (start
      ? 'the expected start date is ' + start + '. We confirm ' + dr + '\'s notice period and tell you straight away if that date moves.'
      : 'we confirm ' + dr + '\'s notice period and agree the start date with you.'),
    'Provider number: ' + dr + ' applies for a Medicare provider number for your practice location. We let you know when it is issued.',
    'Credentialing: we send you ' + dr + '\'s credentialing pack (Ahpra registration, indemnity certificate and supporting documents) before the start date.',
    'Guarantee period: a 12-week guarantee period applies to permanent placements, starting on the day ' + dr + ' commences. We check in with you and with ' + dr + ' during that time. The terms are in clause 7 of your Recruitment Services Agreement.'
  ];
  if (i.supervisionPaperwork === true) {
    bullets.push('Supervision: this placement needs supervision paperwork from your practice. We will send you exactly what is needed.');
  } else if (i.staffDecisionPending === true) {
    bullets.push('Anything else: our team will be in touch if anything further is needed from your practice.');
  }
  const contactLine = clean(i.contactLine, 240) || 'If you have any questions, reply to this email and our team will help.';
  const intro = 'Good news: ' + dr + ' has confirmed the placement for ' + role + ' at your practice.';
  const text = 'Hi ' + contact + ',\n\n' + intro + '\n\nWhat happens next\n'
    + bullets.map(function (b) { return '- ' + b; }).join('\n')
    + '\n\n' + contactLine + '\n\nKind regards,\nGP Link Recruitment Team';
  const bodyHtml = '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc('Hi ' + contact + ',') + '</p>'
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc('Good news: ') + '<strong>' + esc(dr) + '</strong>'
    + esc(' has confirmed the placement for ') + '<strong>' + esc(role) + '</strong>' + esc(' at your practice.') + '</p>'
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 8px"><strong>What happens next</strong></p>'
    + '<ul style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px;padding-left:20px">'
    + bullets.map(function (b) {
      const colon = b.indexOf(':');
      return '<li style="margin:0 0 8px"><strong>' + esc(b.slice(0, colon)) + '</strong>' + esc(b.slice(colon)) + '</li>';
    }).join('')
    + '</ul>'
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 24px">' + esc(contactLine) + '</p>';
  return {
    id: 'N12',
    key: 'au_n12_placement_confirmed:' + ledgerPart(i.placementKey),
    subject: 'Placement confirmed: ' + dr,
    title: 'Placement confirmed',
    bodyHtml,
    text,
    footer: PRACTICE_FOOTER
  };
}

// ── N13: a pre-start item is asked for -> the doctor ─────────────────────────

// The things staff (or the reminder job) can ask a doctor for that are not a
// document upload. Document items come from lib/document-requirements.js.
const GP_REQUEST_ITEMS = Object.freeze({
  notice_period: Object.freeze({ label: 'Your notice period', help: 'Tell us how much notice you need to give, so we can confirm your start date with the practice.' }),
  start_date: Object.freeze({ label: 'Your start date', help: 'Confirm the date you can start at the new practice.' }),
  provider_number: Object.freeze({ label: 'Your Medicare provider number for the new location', help: 'Let us know once you have applied, and send us the number when it is issued.' }),
  referees: Object.freeze({ label: 'Two referees', help: 'Send us the names and contact details of two referees we can speak to.' })
});

/**
 * @param {{ appBaseUrl, items: Array<{ label: string, help?: string }>,
 *           requestKey: string, practiceName?, startDate?, reminder?: boolean }} input
 *   items: what is asked for, in doctor-facing words (a document's `label` /
 *          `short` from auDocumentRequirements, or a GP_REQUEST_ITEMS row).
 * @returns {{ id, key, subject, title, body, ctaText, ctaUrl, footer, bell }|null} null with nothing to ask
 */
function buildPrestartItemRequestMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const items = (Array.isArray(i.items) ? i.items : [])
    .map(function (it) { return { label: clean(it && it.label, 160), help: clean(it && it.help, 300) }; })
    .filter(function (it) { return it.label; });
  if (!items.length) return null;
  const start = formatStartDate(i.startDate);
  const one = items.length === 1;
  const lines = [
    (i.reminder === true ? 'A quick reminder. ' : '')
      + 'To keep your start' + (start ? ' on ' + start : '') + ' on track, we need ' + (one ? 'one thing' : 'a few things') + ' from you:',
    ''
  ];
  items.forEach(function (it) { lines.push('• ' + it.label + (it.help ? ': ' + it.help : '')); });
  lines.push('');
  lines.push('You can upload documents in the app. For anything else, just reply to this email.');
  return {
    id: 'N13',
    key: 'au_n13_prestart_item:' + ledgerPart(i.requestKey),
    subject: one ? 'Needed before you start: ' + items[0].label : 'A few things we need before you start',
    title: one ? 'One thing we need from you, {{name}}' : 'A few things we need from you, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Open the app',
    ctaUrl: base + '/pages/prestart',
    footer: GP_FOOTER,
    bell: {
      type: 'action',
      title: one ? 'Needed before you start' : 'A few things needed before you start',
      body: items.map(function (it) { return it.label; }).join('; ') + '.'
    }
  };
}

// ── N14: the practice must sign or supply something -> the practice ──────────

// What a practice can be asked for. Fixed wording: staff pick codes, they do
// not type the request (a short note may be added; the server checks it).
const PRACTICE_REQUEST_ITEMS = Object.freeze({
  provider_number_location_details: 'The details of your practice location that the doctor needs for the Medicare provider number application (practice name, street address and the location\'s details)',
  start_date_confirmation: 'Your confirmation of the agreed start date',
  credentialing_forms: 'Your practice\'s own credentialing or onboarding forms for the doctor to complete',
  signed_contract_copy: 'A copy of the contract signed by the practice',
  orientation_details: 'First-day details for the doctor: who to ask for, start time and rooms'
});
const PRACTICE_REQUEST_ITEM_KEYS = Object.freeze(Object.keys(PRACTICE_REQUEST_ITEMS));

/**
 * @param {{ gpName, contactName?, itemKeys: string[], note?: string,
 *           startDate?, requestKey: string }} input
 * @returns {{ id, key, subject, title, bodyHtml, text, footer, itemKeys }|null} null with nothing valid to ask
 */
function buildPracticeFormNeededMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const dr = drName(i.gpName) || 'your new GP';
  const contact = clean(i.contactName, 120) || 'there';
  const keys = (Array.isArray(i.itemKeys) ? i.itemKeys : [])
    .filter(function (k, idx, all) { return PRACTICE_REQUEST_ITEM_KEYS.indexOf(k) !== -1 && all.indexOf(k) === idx; });
  if (!keys.length) return null;
  const start = formatStartDate(i.startDate);
  const note = clean(i.note, 400);
  const intro = 'To have everything ready for ' + dr + '\'s start' + (start ? ' on ' + start : '') + ', we need the following from your practice:';
  const bullets = keys.map(function (k) { return PRACTICE_REQUEST_ITEMS[k]; });
  const closing = 'You can reply to this email with the details or attachments. Thank you.';
  const text = 'Hi ' + contact + ',\n\n' + intro + '\n\n' + bullets.map(function (b) { return '- ' + b; }).join('\n')
    + (note ? '\n\n' + note : '') + '\n\n' + closing + '\n\nKind regards,\nGP Link Recruitment Team';
  const bodyHtml = '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc('Hi ' + contact + ',') + '</p>'
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 8px">' + esc(intro) + '</p>'
    + '<ul style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px;padding-left:20px">'
    + bullets.map(function (b) { return '<li style="margin:0 0 8px">' + esc(b) + '</li>'; }).join('') + '</ul>'
    + (note ? '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc(note) + '</p>' : '')
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 24px">' + esc(closing) + '</p>';
  return {
    id: 'N14',
    key: 'au_n14_practice_form:' + ledgerPart(i.requestKey),
    subject: dr + ': what we need from your practice before the start date',
    title: 'What we need from your practice',
    bodyHtml,
    text,
    footer: PRACTICE_FOOTER,
    itemKeys: keys
  };
}

// ── N21: segment B flagged -> the doctor and the practice (WP-14) ────────────
// First-cut copy; WP-17 owns the wording. Rules these keep:
//   - SENT ONLY WHEN A STAFF MEMBER CHOOSES TO SEND IT, after confirming each
//     outcome. Segment B is not launched: nothing here goes automatically.
//   - Each of the three parts says what GP Link has confirmed and what it
//     needs. Neither message describes what Ahpra's or Home Affairs' process
//     is: those rules are not confirmed (owner decision 2).
//   - The word "visa" appears ONLY when `visaWordsAllowed` is true, which the
//     server sets from lib/au-doctor-text.js sponsorTiedVisaException (a
//     sponsor-tied segment B doctor). Otherwise the visa part is left out
//     whole, whatever status was passed. Every other banned word still
//     applies to both messages.

const N21_MORATORIUM = Object.freeze({ DPA_ONLY: 'dpa_only', NOT_RESTRICTED: 'not_restricted' });
const N21_SUPERVISION = Object.freeze({ NEEDED: 'needed', NOT_NEEDED: 'not_needed' });
const N21_VISA = Object.freeze({ TRANSFER_IN_PROGRESS: 'transfer_in_progress', NO_ACTION: 'no_action', NOT_APPLICABLE: 'not_applicable' });

/** Is every part of an N21 a staff-confirmed outcome? (No part may be a guess.) */
function n21Ready(input) {
  const i = input && typeof input === 'object' ? input : {};
  const missing = [];
  if (i.moratorium !== N21_MORATORIUM.DPA_ONLY && i.moratorium !== N21_MORATORIUM.NOT_RESTRICTED) missing.push('moratorium');
  if (i.supervision !== N21_SUPERVISION.NEEDED && i.supervision !== N21_SUPERVISION.NOT_NEEDED) missing.push('supervision');
  if ([N21_VISA.TRANSFER_IN_PROGRESS, N21_VISA.NO_ACTION, N21_VISA.NOT_APPLICABLE].indexOf(i.visa) === -1) missing.push('visa');
  return { ready: missing.length === 0, missing };
}

function n21VisaShown(i) {
  return i.visaWordsAllowed === true && (i.visa === N21_VISA.TRANSFER_IN_PROGRESS || i.visa === N21_VISA.NO_ACTION);
}

/**
 * N21 -> the doctor.
 * @param {{ appBaseUrl, practiceName?, placementKey, sendKey?, teamLabel?,
 *           moratorium, supervision, visa, visaWordsAllowed?: boolean }} input
 * @returns {{ id, key, subject, title, body, ctaText, ctaUrl, footer }|null} null when a part is not confirmed
 */
function buildSegmentBOutcomeGpMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (!n21Ready(i).ready) return null;
  const base = trimBase(i.appBaseUrl);
  const practice = clean(i.practiceName, 160) || 'your new practice';
  const team = clean(i.teamLabel, 60) || 'your GP Link team';
  const lines = [
    'Here is where things stand for your new role at ' + practice + '. Our team has confirmed each of these.',
    '',
    'Section 19AB',
    i.moratorium === N21_MORATORIUM.DPA_ONLY
      ? 'We have confirmed that section 19AB applies to you at the moment. That means the locations we can place you in are Distribution Priority Areas, and ' + practice + ' is one.'
      : 'We have confirmed that section 19AB does not restrict where you can work.',
    '',
    'Supervision',
    i.supervision === N21_SUPERVISION.NEEDED
      ? 'Your registration needs a supervision arrangement at ' + practice + '. We are collecting the paperwork from the practice and will ask you for anything we need from you. You do not need to send anything to Ahpra yourself unless we ask.'
      : 'No new supervision paperwork is needed for this change of practice.'
  ];
  if (n21VisaShown(i)) {
    lines.push('');
    lines.push('Your visa');
    lines.push(i.visa === N21_VISA.TRANSFER_IN_PROGRESS
      ? 'Your visa is tied to your current employer, so your nomination is being transferred to ' + practice + '. You do not need to apply for a new visa. Please do not start at ' + practice + ' until we confirm the transfer is approved.'
      : 'We have confirmed that nothing needs to change on your visa for this change of practice.');
  }
  lines.push('');
  lines.push('If anything here does not match your situation, tell ' + team + ' straight away.');
  return {
    id: 'N21',
    key: 'au_n21_segment_b_gp:' + ledgerPart(i.placementKey) + ':' + ledgerPart(i.sendKey || 'first'),
    subject: 'Your new practice: what we have confirmed',
    title: 'An update for you, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Open your checklist',
    ctaUrl: base + '/pages/prestart',
    footer: GP_FOOTER
  };
}

/**
 * N21 -> the practice.
 * @param {{ gpName, contactName?, placementKey, sendKey?, moratorium, supervision,
 *           visa, visaWordsAllowed?: boolean, contactLine?: string }} input
 * @returns {{ id, key, subject, title, bodyHtml, text, footer }|null}
 */
function buildSegmentBOutcomePracticeMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (!n21Ready(i).ready) return null;
  const dr = drName(i.gpName) || 'your new GP';
  const contact = clean(i.contactName, 120) || 'there';
  const bullets = [
    'Section 19AB: ' + (i.moratorium === N21_MORATORIUM.DPA_ONLY
      ? 'we have confirmed that section 19AB applies to ' + dr + ', so ' + dr + ' can only work in a Distribution Priority Area. We have checked your practice location against that.'
      : 'we have confirmed that section 19AB does not restrict where ' + dr + ' can work.'),
    'Supervision: ' + (i.supervision === N21_SUPERVISION.NEEDED
      ? dr + '\'s registration needs a supervision arrangement at your practice. We will send you exactly what we need from you, including the details of the supervising doctor.'
      : 'no supervision paperwork is needed from your practice for ' + dr + '.')
  ];
  if (n21VisaShown(i)) {
    bullets.push('Visa: ' + (i.visa === N21_VISA.TRANSFER_IN_PROGRESS
      ? dr + '\'s visa is tied to their current employer, so the nomination needs to be transferred to your practice. This is a transfer, not a new visa application. Please tell us who your registered migration agent is and we will brief them. ' + dr + ' should not start until the transfer is approved.'
      : 'we have confirmed that no visa action is needed from your practice for ' + dr + '.'));
  }
  const contactLine = clean(i.contactLine, 240) || 'If you have any questions, reply to this email and our team will help.';
  const intro = 'Here is what we have confirmed for ' + dr + '\'s start at your practice, and what we need from you.';
  const text = 'Hi ' + contact + ',\n\n' + intro + '\n\n' + bullets.map(function (b) { return '- ' + b; }).join('\n')
    + '\n\n' + contactLine + '\n\nKind regards,\nGP Link Recruitment Team';
  const bodyHtml = '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc('Hi ' + contact + ',') + '</p>'
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 8px">' + esc(intro) + '</p>'
    + '<ul style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px;padding-left:20px">'
    + bullets.map(function (b) {
      const colon = b.indexOf(':');
      return '<li style="margin:0 0 8px"><strong>' + esc(b.slice(0, colon)) + '</strong>' + esc(b.slice(colon)) + '</li>';
    }).join('')
    + '</ul>'
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 24px">' + esc(contactLine) + '</p>';
  return {
    id: 'N21',
    key: 'au_n21_segment_b_practice:' + ledgerPart(i.placementKey) + ':' + ledgerPart(i.sendKey || 'first'),
    subject: dr + ': what we have confirmed before the start date',
    title: 'Before the start date',
    bodyHtml,
    text,
    footer: PRACTICE_FOOTER
  };
}

/**
 * The automatic reminder to a practice that is holding the supervised
 * practice agreement for a SEGMENT B doctor (already in Australia, changing
 * practice). Replaces, for that doctor only, the reminder written for a
 * doctor arriving from another country. It says what GP Link needs back and
 * nothing about what the regulator's process is.
 * @param {{ gpName?: string }} input
 * @returns {{ subject: string, bodyHtml: string }}
 */
function buildSupervisionPracticeReminder(input) {
  const i = input && typeof input === 'object' ? input : {};
  const dr = drName(i.gpName) || 'the doctor joining your practice';
  return {
    subject: 'Reminder: supervised practice paperwork for ' + dr,
    bodyHtml: '<p>Hello,</p>'
      + '<p>' + esc('Just a friendly reminder: we are still waiting on the completed and signed supervised practice agreement for ' + dr
        + ', who is joining your practice and needs a new supervised practice arrangement with you.') + '</p>'
      + '<p>When it is ready, please reply to our earlier email with the signed document attached. If anything is unclear, or you need a fresh copy of the form, just reply to this email and we will help straight away.</p>'
      + '<p>Kind regards,<br>GP Link Registration Team</p>'
  };
}

// ── N18, N19, N20: after the doctor has started (WP-13) ──────────────────────
// First-cut copy; WP-17 owns the wording. Rules these keep:
//   - NOTHING commercial ever reaches the doctor: no fee, no invoice, no
//     credit, and not the word "guarantee" (the doctor's own stage label for
//     that period is "Settling in", lib/journey-ladders.js);
//   - the practice is told about the guarantee only what the agreement says
//     (a 12-week guarantee period from commencement, clause 7), with no
//     figure and no percentage;
//   - no clock time is sent, so no time-zone label is needed.

function practiceParagraphs(contact, paragraphs, closing) {
  const text = 'Hi ' + contact + ',\n\n' + paragraphs.join('\n\n') + '\n\n' + closing + '\n\nKind regards,\nGP Link Recruitment Team';
  const bodyHtml = '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc('Hi ' + contact + ',') + '</p>'
    + paragraphs.map(function (p) { return '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 16px">' + esc(p) + '</p>'; }).join('')
    + '<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 24px">' + esc(closing) + '</p>';
  return { text, bodyHtml };
}

/**
 * N18 -> the doctor: one week after they started.
 * @param {{ appBaseUrl, practiceName?, placementKey, teamLabel? }} input
 */
function buildCommencementCheckinGpMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const practice = clean(i.practiceName, 160);
  const team = clean(i.teamLabel, 60) || 'your GP Link team';
  const lines = [
    'You have finished your first week' + (practice ? ' at ' + practice : '') + '. We hope it went well.',
    '',
    'How are you settling in? If anything is not as you expected (your rooms, the systems, your bookings, your provider number), tell us and we will help sort it out with the practice.',
    '',
    'Just reply to this email, or message ' + team + ' in the app. We will check in with you again over the coming weeks.'
  ];
  return {
    id: 'N18',
    key: 'au_n18_week1_gp:' + ledgerPart(i.placementKey),
    subject: 'How was your first week?',
    title: 'One week in, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Message us',
    ctaUrl: base + '/pages/messages',
    footer: GP_FOOTER,
    bell: {
      type: 'info',
      title: 'How was your first week?',
      target: '/pages/messages',
      body: 'We hope your first week' + (practice ? ' at ' + practice : '') + ' went well. Tell us if anything needs sorting out.'
    },
    // Proposed template (docs/au-gp/whatsapp-templates.md, key
    // `commencement_checkin`): {{1}} first name, {{2}} practice name.
    whatsapp: { templateKey: 'commencement_checkin', placeholders: ['{{name}}', practice || 'your new practice'] }
  };
}

/**
 * N18 -> the practice: one week after the doctor started.
 * @param {{ gpName, contactName?, placementKey, contactLine? }} input
 */
function buildCommencementCheckinPracticeMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const dr = drName(i.gpName) || 'your new GP';
  const contact = clean(i.contactName, 120) || 'there';
  const closing = clean(i.contactLine, 240) || 'Just reply to this email and our team will help.';
  const built = practiceParagraphs(contact, [
    dr + ' has now completed the first week at your practice. We hope it has gone well.',
    'How is ' + dr + ' settling in? If anything needs attention (rooms, systems, bookings, or anything you expected to be in place and is not), please let us know early so we can help.',
    'We will check in with you and with ' + dr + ' again at weeks 4, 8 and 12.'
  ], closing);
  return {
    id: 'N18',
    key: 'au_n18_week1_practice:' + ledgerPart(i.placementKey),
    subject: dr + ': first week check-in',
    title: 'First week check-in',
    bodyHtml: built.bodyHtml,
    text: built.text,
    footer: PRACTICE_FOOTER,
    // Proposed template, key `commencement_checkin_practice`: {{1}} contact
    // name, {{2}} the doctor.
    whatsapp: { templateKey: 'commencement_checkin_practice', placeholders: [contact, dr] }
  };
}

/**
 * N19 -> the doctor: the check-in at week 4, 8 or 12.
 * @param {{ appBaseUrl, practiceName?, placementKey, week: 4|8|12, teamLabel? }} input
 */
function buildWeekCheckinGpMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const practice = clean(i.practiceName, 160);
  const week = Number(i.week) === 8 ? 8 : (Number(i.week) === 12 ? 12 : 4);
  const team = clean(i.teamLabel, 60) || 'your GP Link team';
  const lines = [
    'You are ' + week + ' weeks in' + (practice ? ' at ' + practice : '') + '. This is our week ' + week + ' check-in.',
    '',
    'How is it going? We would like to hear what is working well and anything that is not: your patient bookings, the support you are getting, or anything you were told to expect that has not happened.',
    '',
    'Reply to this email, or message ' + team + ' in the app, and one of us will be in touch.'
      + (week === 12 ? ' This is the last of our scheduled check-ins, but we are always here if you need us.' : '')
  ];
  return {
    id: 'N19',
    key: 'au_n19_checkin_w' + week + '_gp:' + ledgerPart(i.placementKey),
    week,
    subject: 'Checking in: ' + week + ' weeks' + (practice ? ' at ' + practice : ''),
    title: week + ' weeks in, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Message us',
    ctaUrl: base + '/pages/messages',
    footer: GP_FOOTER,
    bell: {
      type: 'info',
      title: 'Week ' + week + ' check-in',
      target: '/pages/messages',
      body: 'You are ' + week + ' weeks in' + (practice ? ' at ' + practice : '') + '. Tell us how it is going.'
    }
  };
}

/**
 * N19 -> the practice: the check-in at week 4, 8 or 12.
 * @param {{ gpName, contactName?, placementKey, week: 4|8|12, guaranteeEndsAt?, contactLine? }} input
 */
function buildWeekCheckinPracticeMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const dr = drName(i.gpName) || 'your GP';
  const contact = clean(i.contactName, 120) || 'there';
  const week = Number(i.week) === 8 ? 8 : (Number(i.week) === 12 ? 12 : 4);
  const ends = formatStartDate(i.guaranteeEndsAt);
  const closing = clean(i.contactLine, 240) || 'Just reply to this email and our team will help.';
  const built = practiceParagraphs(contact, [
    dr + ' has now been with your practice for ' + week + ' weeks. This is our week ' + week + ' check-in.',
    'How is the placement going from your side? Please tell us about anything that is not working, however small, so we can help early.',
    week === 12
      ? 'This is the last check-in of the 12-week guarantee period' + (ends ? ', which ends on ' + ends : '') + '. The terms are in clause 7 of your Recruitment Services Agreement.'
      : 'These check-ins are part of the 12-week guarantee period' + (ends ? ', which runs until ' + ends : '') + '. The terms, including what we need you to tell us and when, are in clause 7 of your Recruitment Services Agreement.'
  ], closing);
  return {
    id: 'N19',
    key: 'au_n19_checkin_w' + week + '_practice:' + ledgerPart(i.placementKey),
    week,
    subject: dr + ': week ' + week + ' check-in',
    title: 'Week ' + week + ' check-in',
    bodyHtml: built.bodyHtml,
    text: built.text,
    footer: PRACTICE_FOOTER
  };
}

/**
 * N20 -> the doctor: twelve weeks in, a thank-you and a referral ask. No
 * reward, fee or incentive is offered or implied: none exists.
 * @param {{ appBaseUrl, practiceName?, placementKey, teamLabel? }} input
 */
function buildReferralAskMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = trimBase(i.appBaseUrl);
  const practice = clean(i.practiceName, 160);
  const team = clean(i.teamLabel, 60) || 'your GP Link team';
  const lines = [
    'You have now been' + (practice ? ' at ' + practice : ' in your new role') + ' for twelve weeks. Thank you for letting us be part of it.',
    '',
    'If you know another GP who is thinking about a new role, we would be glad to help them too. Reply to this email with their name, or simply pass on our details, and we will take it from there. We only ever contact someone who has agreed to hear from us.',
    '',
    'And if you ever need anything, ' + team + ' is a message away.'
  ];
  return {
    id: 'N20',
    key: 'au_n20_referral_ask:' + ledgerPart(i.placementKey),
    subject: 'Twelve weeks in: thank you',
    title: 'Thank you, {{name}}',
    body: lines.join('\n'),
    ctaText: 'Message us',
    ctaUrl: base + '/pages/messages',
    footer: GP_FOOTER,
    bell: {
      type: 'info',
      title: 'Twelve weeks in: thank you',
      target: '/pages/messages',
      body: 'Know another GP thinking about a new role? We would be glad to help them too.'
    }
  };
}

// ── Bell items that survive an open browser ──────────────────────────────────
// The bell list (`gp_link_updates`) is a blob the doctor's browser owns: every
// save from an open page sends its own copy and the server stores it whole. An
// item the server added after that page loaded is not in the page's copy, so
// the page's next save wipes it. For the Australian items the server keeps
// each one in a list only it can write (`gp_au_bell_pending`, not a
// browser-syncable key) until a browser has sent the item back, proving it
// has it. Until then every save from a browser has the item put back in.

const PENDING_BELL_KEY = 'gp_au_bell_pending';
const PENDING_BELL_MAX = 20;
const PENDING_BELL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function parseList(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = []; } }
  return Array.isArray(v) ? v : [];
}

// The browser's bell code keeps only type, title, detail, ts, target, nudgeId
// and category of each entry (js/updates-sync.js sanitizeUpdate), so an `id`
// does not survive a round trip. An entry is recognised by its time stamp and
// title instead: both survive, and the stamp is unique to the push.
function bellIdentity(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return String(e.ts || '') + '|' + String(e.title || '').trim();
}

/**
 * A bell entry for an Australian message. `detail` is what the bell panel
 * shows under the title; `body` is kept beside it because the server's other
 * career entries use that name. `target` is where a tap goes.
 */
function buildDurableBellEntry(id, bell, nowIso) {
  const b = bell && typeof bell === 'object' ? bell : {};
  const text = clean(b.body || b.detail, 600);
  const entry = {
    id: 'au_' + ledgerPart(id),
    type: b.type || 'info',
    title: clean(b.title, 160) || 'Update',
    body: text,
    detail: text,
    ts: nowIso || new Date().toISOString(),
    category: 'career'
  };
  entry.target = typeof b.target === 'string' && b.target.indexOf('/pages/') === 0 ? b.target.slice(0, 300) : '/pages/my-documents';
  return entry;
}

/** Add an entry to the pending list (newest first, no duplicates, capped). */
function addPendingBell(pendingValue, entry) {
  const mine = bellIdentity(entry);
  const list = parseList(pendingValue).filter(function (e) { return e && bellIdentity(e) !== mine; });
  list.unshift(entry);
  if (list.length > PENDING_BELL_MAX) list.length = PENDING_BELL_MAX;
  return list;
}

/**
 * Called when a browser saves its state. Puts back any pending entry the
 * incoming bell list does not contain, and forgets the ones it does.
 *
 * @param {{ pending: any, incomingHasList: boolean, incomingList: any,
 *           nextList: any, nowMs?: number }} input
 *   pending          the stored gp_au_bell_pending value
 *   incomingHasList  did this save include gp_link_updates at all?
 *   incomingList     the browser's gp_link_updates (a JSON string or an array)
 *   nextList         the value about to be stored for gp_link_updates
 * @returns {{ changed: boolean, nextList: any, pending: Array, restored: string[], delivered: string[] }}
 *   nextList keeps the representation it came in (string stays a string).
 */
function reconcilePendingBell(input) {
  const i = input && typeof input === 'object' ? input : {};
  const nowMs = typeof i.nowMs === 'number' ? i.nowMs : Date.now();
  const before = parseList(i.pending);
  const fresh = before.filter(function (e) {
    if (!e || !e.ts || !e.title) return false;
    const t = Date.parse(e.ts || '');
    return !Number.isFinite(t) || nowMs - t <= PENDING_BELL_MAX_AGE_MS;
  });
  const out = { changed: fresh.length !== before.length, nextList: i.nextList, pending: fresh, restored: [], delivered: [] };
  if (!fresh.length || i.incomingHasList !== true) return out;
  const incoming = {};
  parseList(i.incomingList).forEach(function (e) { if (e) incoming[bellIdentity(e)] = true; });
  const asString = typeof i.nextList === 'string';
  const list = parseList(i.nextList).slice();
  const have = {};
  list.forEach(function (e) { if (e) have[bellIdentity(e)] = true; });
  const stillPending = [];
  // Oldest first, so unshifting leaves the newest on top.
  fresh.slice().reverse().forEach(function (e) {
    const who = bellIdentity(e);
    if (incoming[who]) { out.delivered.push(who); return; }
    stillPending.unshift(e);
    if (!have[who]) { list.unshift(e); have[who] = true; out.restored.push(who); }
  });
  if (list.length > 50) list.length = 50;
  out.pending = stillPending;
  if (out.restored.length) { out.nextList = asString ? JSON.stringify(list) : list; out.changed = true; }
  if (out.delivered.length) out.changed = true;
  return out;
}

module.exports = {
  CURRENT_PRACTICE_PROMISE,
  formatStartDate,
  buildPlacementSecuredMessage,
  buildPlacementConfirmedPracticeMessage,
  buildPrestartItemRequestMessage,
  buildPracticeFormNeededMessage,
  buildCommencementCheckinGpMessage,
  buildCommencementCheckinPracticeMessage,
  buildWeekCheckinGpMessage,
  buildWeekCheckinPracticeMessage,
  buildReferralAskMessage,
  N21_MORATORIUM, N21_SUPERVISION, N21_VISA, n21Ready,
  buildSegmentBOutcomeGpMessage,
  buildSegmentBOutcomePracticeMessage,
  buildSupervisionPracticeReminder,
  GP_REQUEST_ITEMS,
  PRACTICE_REQUEST_ITEMS,
  PRACTICE_REQUEST_ITEM_KEYS,
  PENDING_BELL_KEY,
  bellIdentity,
  buildDurableBellEntry,
  addPendingBell,
  reconcilePendingBell
};
