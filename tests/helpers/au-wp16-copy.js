'use strict';

/**
 * WP-16: every Australian lead and consult message, rendered through the
 * REAL builders (the ones the server calls), for every segment.
 *
 *   renderAllAuMessages()   { segment: { messageId: { sent, subject, title,
 *                             text, html } } } plus the proposed WhatsApp
 *                             templates
 *   forbiddenIn(text)       the words an Australian-segment message must not
 *                             carry (the acceptance rule + AGENT-RULES s4)
 *   renderCopyDeck()        docs/au-gp/au-lead-copy.md, generated from the
 *                             same renders so the deck cannot drift
 */

const auLeadCopy = require('../../lib/au-lead-copy.js');
const consultLead = require('../../lib/consult-lead.js');
const bookerNudgeEmail = require('../../lib/booker-nudge-email.js');
const consultReminders = require('../../lib/consult-reminders.js');
const consultNoShow = require('../../lib/consult-noshow.js');
const auTimezone = require('../../lib/au-timezone.js');
const auWhatsAppTemplates = require('../../lib/au-whatsapp-templates.js');
const auDoctorText = require('../../lib/au-doctor-text.js');

const AU_SEGMENTS = ['au_vr', 'au_unknown', 'au_restricted', 'au_non_vr', 'au_registrar'];
const SAMPLE = {
  name: 'Jane Citizen',
  callAtIso: '2027-01-14T02:30:00Z',
  bookUrl: 'https://app.mygplink.com.au/start?lead=EXAMPLE#book',
  signupUrl: 'https://app.mygplink.com.au/pages/signin?signup=1',
  joinUrl: 'https://zoom.example/j/123456'
};
// Zones an Australian-segment lead can be on, including one abroad.
const SAMPLE_ZONES = ['Australia/Perth', 'Australia/Sydney', 'Australia/Adelaide', 'Australia/Darwin', 'Europe/London', 'Pacific/Auckland', 'Europe/Dublin'];

// The acceptance rule (review report, WP-16) plus AGENT-RULES section 4.
// Word boundaries on purpose: "remove" and "moved in" are not "move"; "UK" is
// a word, not the letters inside another one.
const EXTRA_FORBIDDEN = [
  ['move', /\bmov(e|es|ed|ing)\b/i],
  ['visa', /visa/i],
  ['relocat', /relocat/i],
  ['UK', /\bU\.?K\.?\b/],
  ['United Kingdom', /united kingdom/i],
  ['dollar figure', /\$/],
  ['percentage', /%|\bper ?cent\b/i],
  ['AHPRA (write Ahpra)', /\bAHPRA\b/],
  ['em dash', /—/],
  ['Not yet eligible', /not yet eligible/i]
];

// Text a person reads: links are not words (a sign-up link carries an
// encoded email address, which has a percent sign in it).
function readable(text) {
  return String(text == null ? '' : text).replace(/https?:\/\/[^\s"'<>)]+/g, ' ');
}

function forbiddenIn(text) {
  const s = readable(text);
  const found = auDoctorText.violations(s).slice();
  EXTRA_FORBIDDEN.forEach(function (pair) { if (pair[1].test(s) && found.indexOf(pair[0]) === -1) found.push(pair[0]); });
  return found;
}

function htmlToText(html) {
  return String(html || '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function whenIn(zone) { return consultReminders.formatLeadCallTime(SAMPLE.callAtIso, zone, { cityLabel: true }); }

/** One message for one segment, through the builder the server uses. */
function renderOne(id, segment, zone) {
  const z = zone || 'Australia/Perth';
  const plan = auLeadCopy.messagePlan(id, segment);
  if (!plan.send) return { sent: false, reason: plan.reason };
  const displayName = consultLead.consultDisplayName(SAMPLE.name);
  const au = { segment: segment };
  if (id === 'booking_link' || id === 'booking_link_generic') {
    const c = auLeadCopy.plainEmail(id, plan.group, { displayName });
    return { sent: true, subject: c.subject, title: c.title, text: c.body + '\n\n' + c.ctaText + ': ' + SAMPLE.bookUrl, button: c.ctaText };
  }
  const nb = auLeadCopy.NUDGE_STEP_IDS.not_booked.indexOf(id);
  if (nb !== -1) {
    const c = consultLead.consultNudgeCopy('not_booked', nb, { displayName, bookUrl: SAMPLE.bookUrl, signupUrl: SAMPLE.signupUrl, au });
    return { sent: true, subject: c.subject, title: c.title, text: c.body + '\n\n' + c.ctaText + ': ' + c.ctaUrl, button: c.ctaText };
  }
  const bk = auLeadCopy.NUDGE_STEP_IDS.booked_no_signup.indexOf(id);
  if (bk !== -1) {
    const n = bookerNudgeEmail.buildBookerNudgeEmail(bk, { displayName, signupUrl: SAMPLE.signupUrl, au: { segment, whenText: bk === 0 ? whenIn(z) : '' } });
    if (!n) return { sent: false, reason: auLeadCopy.SKIP_NOT_LAUNCHED };
    return { sent: true, subject: n.subject, title: '', text: n.text, html: n.bodyHtml, htmlText: htmlToText(n.bodyHtml) };
  }
  if (id === 'n02_reminder_day' || id === 'n02_reminder_hour') {
    const c = consultReminders.buildConsultReminderEmail(id === 'n02_reminder_day' ? 'email_h24' : 'email_h1',
      { name: SAMPLE.name, callAtIso: SAMPLE.callAtIso, timeZone: z, joinUrl: SAMPLE.joinUrl, au });
    return { sent: true, subject: c.subject, title: c.title, text: c.text, button: c.ctaText };
  }
  if (id === 'n02_noshow') {
    const label = auTimezone.zoneCityLabel(z);
    const c = consultNoShow.noShowEmailCopy({ displayName, whenText: consultNoShow.slotInWords(SAMPLE.callAtIso, z) + (label ? ' (' + label + ')' : ''), au });
    return { sent: true, subject: c.subject, title: c.title, text: c.body + '\n\n' + c.ctaText + ': ' + SAMPLE.bookUrl, button: c.ctaText };
  }
  throw new Error('no renderer for ' + id);
}

function renderAllAuMessages(zone) {
  const out = { messages: {}, whatsapp: {} };
  AU_SEGMENTS.forEach(function (segment) {
    out.messages[segment] = {};
    auLeadCopy.MESSAGE_IDS.forEach(function (id) {
      const r = renderOne(id, segment, zone);
      // The HTML is long and is the same words: the snapshot keeps the words.
      const kept = Object.assign({}, r); delete kept.html;
      out.messages[segment][id] = kept;
    });
  });
  Object.keys(auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES).forEach(function (key) {
    const t = auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES[key];
    const row = auWhatsAppTemplates.AU_WHATSAPP_TEMPLATES[key];
    out.whatsapp[key] = { templateName: row ? row.templateName : '', approved: row ? row.approved : null, body: t.body, placeholders: t.placeholders, buttons: t.buttons };
  });
  return out;
}

// ── The copy deck ──────────────────────────────────────────────────────────
function quote(text) {
  return String(text).split('\n').map(function (l) { return '> ' + l; }).join('\n').replace(/> \n/g, '>\n').replace(/> $/gm, '>');
}

function renderCopyDeck() {
  const L = [];
  L.push('# Australian lead and consult messages: the copy deck');
  L.push('');
  L.push('Written by WP-16. **Generated from the code** (`lib/au-lead-copy.js`, through the builders the server uses) by `tests/helpers/au-wp16-copy.js`; `tests/au-wp16-copy-snapshot.test.js` fails if this file and the code disagree. To change a word, change it in `lib/au-lead-copy.js` and regenerate (`WP16_WRITE_COPY=1 npx vitest run tests/au-wp16-copy-snapshot.test.js`).');
  L.push('');
  L.push('**Who gets these.** Australian-segment leads only, and only with the Australian switch on. Every other lead, and every lead with the switch off, gets exactly the messages they get today.');
  L.push('');
  L.push('**Two wordings.** "Main" goes to `au_vr` (vocationally registered, unrestricted) and `au_unknown` (Australian, detail not known yet), and is written to be true for any Ahpra-registered doctor. "Careful" goes to `au_restricted`, `au_non_vr` and `au_registrar`, which are built but not launched: it promises nothing about roles ("' + auLeadCopy.SAFE_LINE + '"). Where a message is only about being matched to roles, the careful group is not sent it at all.');
  L.push('');
  L.push('**Rules every message keeps.** A confidential conversation about a better-fitting practice: billing mix, location, flexibility. No dollar figures, no percentages, no promise of a particular role or pay. The line "' + auLeadCopy.CONFIDENTIALITY_LINE + '" The regulator is written "Ahpra". Every email carries the unsubscribe link in its footer (the reminder emails are about a call the doctor booked and carry none, as today).');
  L.push('');
  L.push('**Two send rules** (`docs/au-gp/CONVENTIONS.md` section 28):');
  L.push('');
  L.push('- *Go-live.* A lead only enters a sequence if the event that starts it (they qualified, booked, attended, or missed a call) happened after Australian messages went live. Older leads get nothing automatic; the Leads tab marks them for a personal follow-up.');
  L.push('- *Quiet hours.* A message that goes out because time has passed is only sent between 08:00 and 20:00 on the doctor\'s own clock. Outside those hours it waits for the next run inside them. Reminders about a booked call and replies to something the doctor just did are not held.');
  L.push('');
  L.push('**WhatsApp.** None of these goes by WhatsApp today: no Australian template is approved, so every WhatsApp is skipped (the reason is logged and shown on the Leads tab) and the email carries the message. The proposed templates are at the end, and in `docs/au-gp/whatsapp-templates.md`.');
  L.push('');
  L.push('## The messages at a glance');
  L.push('');
  L.push('| Message | Report ref | When | Channel | Main (`au_vr`, `au_unknown`) | Careful (`au_restricted`, `au_non_vr`, `au_registrar`) | Quiet hours | Go-live rule measured from |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const quietWords = { gated: 'held outside 08:00 to 20:00', exempt: 'not held', prompt: 'not held within 30 minutes of the event, then held' };
  const anchorWords = { qualified: 'when they qualified', booked: 'when they booked', attended: 'when the attended call ended', no_show: 'the slot they missed', none: 'not applied' };
  auLeadCopy.MESSAGE_IDS.forEach(function (id) {
    const m = auLeadCopy.MESSAGES[id];
    L.push('| ' + m.label + ' (`' + id + '`) | ' + m.ref + ' | ' + m.when + ' | ' + m.channel + ' | sent | ' + (m.groups.indexOf('safe') !== -1 ? 'sent, careful wording' : '**not sent**') + ' | ' + quietWords[m.quiet] + ' | ' + anchorWords[m.anchor] + ' |');
  });
  L.push('');
  L.push('In the examples below the doctor is "Dr Citizen" and the call is ' + whenIn('Australia/Perth') + '. The time is always given on the doctor\'s own clock and names the city.');
  L.push('');
  auLeadCopy.MESSAGE_IDS.forEach(function (id) {
    const m = auLeadCopy.MESSAGES[id];
    L.push('## ' + m.label + ' (`' + id + '`, ' + m.ref + ')');
    L.push('');
    L.push('**When:** ' + m.when);
    L.push('');
    [['au_vr', 'Main wording'], ['au_restricted', 'Careful wording']].forEach(function (pair) {
      const r = renderOne(id, pair[0], 'Australia/Perth');
      L.push('### ' + pair[1]);
      L.push('');
      if (!r.sent) { L.push('Not sent to this group (reason on the lead\'s record: `' + r.reason + '`).'); L.push(''); return; }
      const main = pair[0] === 'au_vr' ? null : renderOne(id, 'au_vr', 'Australia/Perth');
      if (main && main.sent && main.subject === r.subject && main.text === r.text) { L.push('The same words as the main wording.'); L.push(''); return; }
      L.push('**Subject:** ' + r.subject);
      L.push('');
      if (r.title) { L.push('**Heading:** ' + r.title); L.push(''); }
      L.push(quote(r.text));
      L.push('');
    });
  });
  L.push('## Proposed WhatsApp templates (not submitted: an owner action)');
  L.push('');
  L.push('| Key | Template name | Purpose | Body | Variables | Buttons | Status |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  Object.keys(auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES).forEach(function (key) {
    const t = auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES[key];
    const row = auWhatsAppTemplates.AU_WHATSAPP_TEMPLATES[key];
    L.push('| `' + key + '` | `' + row.templateName + '` | ' + t.purpose + ' (' + t.category + ') | ' + t.body.replace(/\n/g, '<br>') + ' | ' + t.placeholders.map(function (p, i) { return '`{{' + (i + 1) + '}}` ' + p; }).join('; ') + ' | ' + t.buttons + ' | not submitted: owner action |');
  });
  L.push('');
  return L.join('\n');
}

module.exports = { AU_SEGMENTS, SAMPLE, SAMPLE_ZONES, EXTRA_FORBIDDEN, readable, forbiddenIn, htmlToText, renderOne, renderAllAuMessages, renderCopyDeck };
