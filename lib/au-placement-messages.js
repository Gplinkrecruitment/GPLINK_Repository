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
    ctaUrl: base + '/pages/my-documents',
    footer: GP_FOOTER,
    bell: {
      type: 'success',
      title: 'Your placement is secured',
      target: '/pages/my-documents',
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
    ctaUrl: base + '/pages/my-documents',
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
  GP_REQUEST_ITEMS,
  PRACTICE_REQUEST_ITEMS,
  PRACTICE_REQUEST_ITEM_KEYS,
  PENDING_BELL_KEY,
  bellIdentity,
  buildDurableBellEntry,
  addPendingBell,
  reconcilePendingBell
};
