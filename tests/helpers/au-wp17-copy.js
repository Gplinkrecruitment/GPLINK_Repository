'use strict';

/**
 * WP-17: every Australian lifecycle message, taken from the registry in
 * lib/au-messages.js (the builders the server sends through), for the tests
 * that scan the words and for the owner-readable deck.
 *
 *   everySample()     [{ id, label, to, message }] for N04 to N22
 *   stringsOf(msg)    every string a recipient can read in one message
 *   copySnapshot()    the JSON the snapshot test pins
 *   renderDeck()      docs/au-gp/au-lifecycle-copy.md, generated
 *
 * To change a word: change it in the builder, then regenerate both files with
 *   WP17_WRITE_COPY=1 npx vitest run tests/au-wp17-copy.test.js
 */

const auMessages = require('../../lib/au-messages.js');
const auWhatsAppTemplates = require('../../lib/au-whatsapp-templates.js');
const practicePipeline = require('../../lib/practice-pipeline.js');

function everySample() {
  const out = [];
  auMessages.MESSAGE_IDS.forEach(function (id) {
    const entry = auMessages.AU_MESSAGES[id];
    (entry.samples() || []).forEach(function (s) {
      out.push({ id: id, label: s.label, to: s.to, message: s.message });
    });
  });
  return out;
}

function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, '\n').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Every string the recipient of one message can read, by part. */
function stringsOf(message) {
  const m = message || {};
  const parts = {};
  ['subject', 'title', 'body', 'ctaText', 'footer', 'text'].forEach(function (k) { if (typeof m[k] === 'string' && m[k]) parts[k] = m[k]; });
  if (m.bodyHtml) parts.html = htmlToText(m.bodyHtml);
  if (m.bell) { parts.bellTitle = String(m.bell.title || ''); parts.bellBody = String(m.bell.body || m.bell.detail || ''); }
  if (m.whatsapp && Array.isArray(m.whatsapp.placeholders)) parts.whatsappPlaceholders = m.whatsapp.placeholders.join(' | ');
  return parts;
}

function allText(message) {
  const p = stringsOf(message);
  return Object.keys(p).map(function (k) { return p[k]; }).join('\n');
}

function copySnapshot() {
  const out = { messages: {}, whatsappTemplates: auMessages.LIFECYCLE_WHATSAPP_TEMPLATES, nudgeDefaults: auMessages.AU_NUDGE_TEMPLATES,
    nudgeEmailFooter: auMessages.AU_NUDGE_EMAIL_FOOTER, composerTemplates: auMessages.AU_COMPOSER_TEMPLATES, intakeLine: auMessages.INTAKE_AU_LINE,
    roleLabels: { beforePlacement: auMessages.roleLabelFor({ isAu: true, placed: false }).label, afterPlacement: auMessages.roleLabelFor({ isAu: true, placed: true }).label } };
  everySample().forEach(function (s) {
    if (!out.messages[s.id]) out.messages[s.id] = [];
    out.messages[s.id].push({ label: s.label, to: s.to, key: s.message.key || null, parts: stringsOf(s.message), ctaUrl: s.message.ctaUrl || null });
  });
  return JSON.parse(JSON.stringify(out));
}

function quote(text) {
  return String(text || '').split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
}

function channelWords(entry) {
  const c = entry.channels || {};
  const bits = [];
  if (c.task) return 'a staff task (`' + c.task + '`): nothing is sent';
  if (c.email) bits.push(entry.to === 'owner' ? 'inside the weekly digest email' : 'email');
  if (c.bell) bits.push('bell');
  if (c.practiceEmail) bits.push('email to the practice');
  if (c.whatsapp) {
    const row = auWhatsAppTemplates.auWhatsAppTemplate(c.whatsapp);
    bits.push('WhatsApp only through the Australian template `' + c.whatsapp + '` (' + (row && row.approved ? 'approved' : 'not approved: skipped, the reason is recorded') + ')');
  }
  return bits.join('; ');
}

function renderDeck() {
  const L = [];
  L.push('# Australian lifecycle messages: the copy deck');
  L.push('');
  L.push('Written by WP-17. **Generated from the code** (`lib/au-messages.js`, the registry `AU_MESSAGES` and the builders the server sends through) by `tests/helpers/au-wp17-copy.js`; `tests/au-wp17-copy.test.js` fails if this file and the code disagree. To change a word, change it in the builder and regenerate (`WP17_WRITE_COPY=1 npx vitest run tests/au-wp17-copy.test.js`).');
  L.push('');
  L.push('**Who gets these.** Doctors on an Australian pathway and the practices hiring them, and only with the Australian switch on. Every other doctor and practice, and everyone with the switch off, gets exactly the messages they get today. The messages a *lead* gets before they have an account (N01 to N03) are in `au-lead-copy.md`.');
  L.push('');
  L.push('**Rules every message keeps.** None of the words a doctor already working in Australia should never read (MyIntealth, AMC, EPIC, visa, relocation, "your move", overseas, internationally trained, GMC, SPPA, Section G, supervisor CV, "Not yet eligible"); the one named exception is N21 to a segment B doctor whose right to work is tied to a sponsor. No dollar figures and no percentages. Nothing commercial ever reaches a doctor: no fee, invoice or credit, and not the word "guarantee". A practice is never told a doctor is "internationally trained" or on the "Expedited Specialist Pathway". The line "' + auMessages.CONFIDENTIALITY_LINE + '" in exactly those words. The regulator is written "Ahpra". Dates are Australian calendar dates ("1 February 2027"); no message states a clock time.');
  L.push('');
  L.push('**Once each.** Every part of every message (the email, the bell item, the email to the practice, the WhatsApp) is claimed in the once-ever ledger (`gp_nudge_log`) before it is sent, so a double click, two overlapping jobs or a retry never sends it twice. A part that could not be sent gives its claim back and is tried again.');
  L.push('');
  L.push('**Quiet hours.** A message that goes because time has passed, or because a staff member did something at whatever hour they happened to be working, is only sent between 08:00 and 20:00 on the doctor\'s own clock. Outside those hours it waits, unmarked, for the next run inside them. A message that answers something the doctor just did is not held.');
  L.push('');
  L.push('**WhatsApp.** Of these, only the match invitation goes by WhatsApp today (through the existing template, whose approved wording was read and is neutral). For the others no Australian template is approved yet, so the WhatsApp leg is skipped (the reason is written on the case timeline) and the email carries the message. What to submit is in `whatsapp-templates.md`; the drafts are also at the end of this file.');
  L.push('');
  L.push('**Who the doctor is told is looking after them.** Before a placement: "' + auMessages.roleLabelFor({ isAu: true, placed: false }).label + '". After it: "' + auMessages.roleLabelFor({ isAu: true, placed: true }).label + '". The job title "Registration Support Officer" is never written to an Australian doctor; an overseas doctor still reads it exactly as before.');
  L.push('');
  L.push('## The messages at a glance');
  L.push('');
  L.push('| # | Message | To | When | Channel | Quiet hours | Once | Built |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  auMessages.MESSAGE_IDS.forEach(function (id) {
    const e = auMessages.AU_MESSAGES[id];
    L.push('| ' + id + ' | ' + e.name + ' | ' + e.to + ' | ' + e.when + ' | ' + channelWords(e) + ' | ' + e.quietHours + ' | ' + e.once + ' | ' + e.origin + ' |');
  });
  L.push('');
  L.push('## What each segment gets');
  L.push('');
  L.push('Segment A (`au_vr`) is launched. Segments B (`au_restricted`) and C (`au_non_vr`, `au_registrar`) are built but not launched: a doctor in one of them is never promised roles.');
  L.push('');
  L.push('| # | Message | A | B | C | Why |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  auMessages.MESSAGE_IDS.forEach(function (id) {
    const e = auMessages.AU_MESSAGES[id];
    L.push('| ' + id + ' | ' + e.name + ' | ' + e.segments.A + ' | ' + e.segments.B + ' | ' + e.segments.C + ' | ' + (e.segmentNote || '') + ' |');
  });
  L.push('');
  L.push('In the examples below the doctor is "' + auMessages.SAMPLE.gpName + '", the practice is "' + auMessages.SAMPLE.practiceName + '" and the start date is 1 February 2027. `{{name}}` is the doctor\'s first name.');
  auMessages.MESSAGE_IDS.forEach(function (id) {
    const e = auMessages.AU_MESSAGES[id];
    L.push('');
    L.push('## ' + id + ': ' + e.name);
    L.push('');
    L.push('**When:** ' + e.when);
    L.push('');
    L.push('**To:** ' + e.to + '. **Channel:** ' + channelWords(e) + '.');
    L.push('');
    L.push('**Quiet hours:** ' + e.quietHours + '. ' + e.quietWhy);
    L.push('');
    L.push('**Once:** ' + e.once + ' (`' + e.ledgerKey + '`).');
    L.push('');
    L.push('**In the code:** builder `' + e.builder + '`; sent by `' + e.trigger.fn + '`.');
    const samples = e.samples() || [];
    if (!samples.length) {
      L.push('');
      L.push(id === 'N07' ? 'Nothing is sent to the doctor: this is a task for a person.' : 'These are the existing emails (their wording is in `server.js`, not repeated here). `tests/au-wp17-existing-messages-server.test.js` renders all three for an Australian doctor and scans them for the banned words.');
    }
    samples.forEach(function (s) {
      const m = s.message;
      L.push('');
      L.push('### ' + s.label + ' (to the ' + s.to + ')');
      L.push('');
      if (m.subject) { L.push('**Subject:** ' + m.subject); L.push(''); }
      if (m.title && s.to === 'doctor') { L.push('**Heading:** ' + m.title); L.push(''); }
      L.push(quote(m.body || m.text || ''));
      if (m.ctaText) { L.push(''); L.push('**Button:** ' + m.ctaText + (m.ctaUrl ? ' (' + m.ctaUrl + ')' : '')); }
      if (m.footer && s.to === 'doctor') { L.push(''); L.push('**Footer:** ' + m.footer); }
      if (m.bell) { L.push(''); L.push('**Bell:** ' + m.bell.title + ': ' + (m.bell.body || m.bell.detail || '')); }
    });
  });
  L.push('');
  L.push('## Staff nudge defaults for an Australian case');
  L.push('');
  L.push('When a staff member sends a "nudge" without typing their own message, the default now depends on the doctor. An overseas doctor gets the existing defaults, unchanged. A doctor on an Australian pathway gets one of these, chosen by the stage their case is on; a stage that is not theirs (a staff member typing "myintealth") falls back to their case\'s own stage.');
  L.push('');
  L.push('| Stage | Title | Message |');
  L.push('| --- | --- | --- |');
  Object.keys(auMessages.AU_NUDGE_TEMPLATES).forEach(function (k) {
    const t = auMessages.AU_NUDGE_TEMPLATES[k];
    L.push('| ' + (k === '_default' ? 'anything else' : k) + ' | ' + t.title + ' | ' + t.body + ' |');
  });
  L.push('');
  L.push('## Composer templates for an Australian case');
  L.push('');
  L.push('The staff email composer\'s "Insert template" list, when it is opened for a doctor on an Australian pathway, leaves out the defaults written for a doctor registering from another country (' + auMessages.OVERSEAS_ONLY_COMPOSER_KEYS.map(function (k) { return '`' + k + '`'; }).join(', ') + ') and offers these instead. `{{firstName}}` and the like are filled in by the composer; staff read and edit before sending.');
  auMessages.AU_COMPOSER_TEMPLATES.forEach(function (t) {
    L.push('');
    L.push('### ' + t.name);
    L.push('');
    L.push('**Subject:** ' + t.subject);
    L.push('');
    L.push(quote(t.body));
  });
  L.push('');
  L.push('## The practice intake invite');
  L.push('');
  L.push('With the Australian switch on, the invite a practice gets to complete its placement application gains one paragraph, after the one about doctors from the UK, Ireland and New Zealand:');
  L.push('');
  L.push(quote(auMessages.INTAKE_AU_LINE));
  L.push('');
  L.push('## Proposed WhatsApp templates');
  L.push('');
  L.push('Nothing here has been submitted. Until a row is approved its WhatsApp is skipped and the email carries the message. Rows marked "stands in for" replace an existing template whose approved wording says "your Registration Support Officer": an Australian doctor is not sent the existing one unless the owner switches it on (`whatsapp-templates.md`, section 4).');
  L.push('');
  L.push('| Key | Template name | For | Stands in for | Variables | Button | Proposed body |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  auMessages.LIFECYCLE_WHATSAPP_TEMPLATES.forEach(function (t) {
    L.push('| `' + t.key + '` | `' + t.templateName + '` | ' + t.message + ' | ' + (t.existing ? '`' + t.existing + '`' : '') + ' | ' + t.variables + ' | ' + t.button + ' | ' + String(t.body).replace(/\n/g, '<br>') + ' |');
  });
  L.push('');
  return L.join('\n');
}

function intakeCopy(on) {
  return practicePipeline.buildIntakeEmailCopy({
    practiceName: 'Test Metro Practice (FAKE)', contactName: 'Pat Manager', intakeUrl: 'https://app.gplink-test.local/intake/TESTTOKEN',
    auLine: on ? auMessages.INTAKE_AU_LINE : ''
  });
}

module.exports = { everySample, stringsOf, allText, htmlToText, copySnapshot, renderDeck, intakeCopy };
