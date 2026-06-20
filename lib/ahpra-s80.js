'use strict';

// AHPRA section 80(1)(b) "Notice to provide further information" — pure helpers.
//
// This module holds the logic that does NOT touch the database or network, so it
// can be unit-tested in isolation:
//   - the extraction prompt (what we ask the model to pull out of the officer's email)
//   - parsing + normalising the model's reply into well-owned items WITHOUT losing detail
//   - generating the single combined reply draft to AHPRA
//
// The server (server.js) wires these into the live email pipeline, the holding
// tray, the GP page and the admin endpoints.

// Who acts on an item.
//   'gp'   — the doctor does it (upload a file, or request a document from their institution)
//   'team' — the GP Link support team handles it behind the scenes (never shown to the GP)
var S80_OWNERS = ['gp', 'team'];

// How an item is actioned.
//   'upload'              — GP uploads a file they hold/can obtain; team then reviews it
//   'request_institution' — GP asks an institution (GMC, OET, etc.) to send the document
//                           directly to AHPRA, then marks it complete
//   'team'                — team-owned work (supervised practice plan, qualification/PSV check)
var S80_MODES = ['upload', 'request_institution', 'team'];

var DEFAULT_REPLY_SUBJECT = 'Notice to provide further information under section 80(1)(b)';

// ── Extraction prompt ──────────────────────────────────────────────────────

var EXTRACTION_SYSTEM = [
  'You read emails an AHPRA officer sends to a GP registration support team and turn them into a precise, complete checklist.',
  'Your single most important rule: NEVER drop or summarise away any detail the officer wrote. Copy the exact requirements.',
  'Return strict JSON only — no prose, no markdown fences.'
].join(' ');

function buildExtractionPrompt(emailMeta) {
  emailMeta = emailMeta || {};
  return [
    'An AHPRA (Australian Health Practitioner Regulation Agency) officer has emailed a GP registration support team,',
    'usually a "Notice to provide further information under section 80(1)(b)" listing documents/clarifications they need.',
    '',
    'Split the email into every individual thing that is being asked for. For EACH item return:',
    '- "title": a short human label (e.g. "Certificate of Good Standing from GMC").',
    '- "detail": the FULL requirement, copied faithfully from the email. Include every sub-point, every form-question',
    '  reference (e.g. "Q3 of SPPA-00"), certification requirements, and how to submit it. DO NOT shorten or paraphrase',
    '  away specifics. If the officer listed several attachments under one heading, keep them all.',
    '- "sub_items": an array of strings, one per distinct attachment/sub-requirement the officer listed under this item',
    '  (e.g. each named SPPA-00 attachment). Use [] if the item is a single thing.',
    '- "owner": who must act —',
    '    "gp"   = the doctor provides it (a personal document, or they request it from an institution);',
    '    "team" = the GP Link support team handles it behind the scenes.',
    '- "mode": how it gets done —',
    '    "upload"              = the GP uploads a file they hold or can obtain (e.g. reference letters, certified copies);',
    '    "request_institution" = the GP asks an institution to send the document DIRECTLY to AHPRA, then marks it done',
    '                            (e.g. Certificate of Good Standing from a medical council; test confirmation from OET/IELTS);',
    '    "team"                = the support team does it (not shown to the GP).',
    '- "institution": for "request_institution" items, the body that issues it (e.g. "GMC", "RCGP", "OET", "ECFMG"); else "".',
    '- "kind": one of "supervised_practice_plan", "qualification_check", "english", "good_standing", or "" if none fit.',
    '',
    'Ownership rules you MUST apply:',
    '- A supervised practice plan / SPPA-00 (and its attachments: supervisor CVs, position description, Section G,',
    '  conflict-of-interest details) is ALWAYS owner "team", mode "team", kind "supervised_practice_plan".',
    '- A qualification check / primary source verification / PSV (e.g. ECFMG, EPIC, AMC) is ALWAYS owner "team",',
    '  mode "team", kind "qualification_check" (the team will arrange a guidance call for the GP).',
    '- A Certificate of Good Standing / certificate of registration from a medical council is owner "gp",',
    '  mode "request_institution", kind "good_standing".',
    '- Confirmation of an English test (OET/IELTS) sent directly from the test body is owner "gp",',
    '  mode "request_institution", kind "english".',
    '- Reference letters / employer letters / certified copies the GP can gather are owner "gp", mode "upload".',
    '',
    'Also extract the single overall deadline the officer gives for the whole notice (e.g. "no later than 29 August 2025"),',
    'and the AHPRA reference number if present (e.g. "1460970").',
    '',
    'Return strict JSON ONLY in exactly this shape:',
    '{"deadline":"YYYY-MM-DD"|null,"reference":"string"|null,"items":[{"title":"","detail":"","sub_items":[],"owner":"gp|team","mode":"upload|request_institution|team","institution":"","kind":""}]}',
    '',
    'Email subject: ' + String(emailMeta.subject || '').slice(0, 800),
    'Email from: ' + String(emailMeta.sender || '').slice(0, 200),
    'Email body:',
    String(emailMeta.bodyText || '').slice(0, 16000)
  ].join('\n');
}

// ── Parsing + normalising ──────────────────────────────────────────────────

// Pull the first JSON object out of the model's reply. Returns the parsed object,
// or null if no parseable JSON object is present (caller should fail loud, not
// silently drop the notice).
function parseExtractionText(rawText) {
  var text = String(rawText || '');
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

function cleanString(v, max) {
  var s = (v === null || v === undefined) ? '' : String(v);
  // Strip NUL bytes (they have broken our HTML/JS parsing before) but keep all
  // normal whitespace so the copied requirement text stays readable.
  s = s.replace(/\u0000/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function normalizeSubItems(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var entry = raw[i];
    var label = '';
    var done = false;
    if (typeof entry === 'string') {
      label = cleanString(entry, 600);
    } else if (entry && typeof entry === 'object') {
      label = cleanString(entry.label || entry.title || entry.text || '', 600);
      done = entry.done === true;
    }
    if (label) out.push({ label: label, done: done });
  }
  return out;
}

// Coerce one raw model item into our strict shape. Owner/mode are forced to be
// internally consistent (e.g. mode 'team' implies owner 'team').
function normalizeItem(raw) {
  raw = raw || {};
  var title = cleanString(raw.title || raw.name || 'AHPRA requested item', 200);
  var detail = cleanString(raw.detail || raw.description || '', 8000);
  var subItems = normalizeSubItems(raw.sub_items || raw.subItems || raw.attachments);
  var kind = cleanString(raw.kind || '', 60).toLowerCase();
  var institution = cleanString(raw.institution || '', 120);

  var owner = String(raw.owner || '').trim().toLowerCase();
  // Map legacy/loose owner words onto our two buckets.
  if (owner === 'practice' || owner === 'hazel' || owner === 'support' || owner === 'gplink' || owner === 'gp link') owner = 'team';
  if (S80_OWNERS.indexOf(owner) === -1) owner = '';

  var mode = String(raw.mode || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (mode === 'request' || mode === 'institution' || mode === 'request_from_institution') mode = 'request_institution';
  if (S80_MODES.indexOf(mode) === -1) mode = '';

  // Kind-driven hard rules (these override a confused model).
  var hay = title + ' ' + detail;
  if (kind === 'supervised_practice_plan' || /sppa[\s_-]?00|supervis(ed|ion) practice plan|section g/i.test(hay)) {
    owner = 'team'; mode = 'team'; if (!kind) kind = 'supervised_practice_plan';
  } else if (kind === 'qualification_check' || kind === 'psv' || /primary source verification|\bpsv\b|ecfmg|epic\b|qualification check/i.test(hay)) {
    owner = 'team'; mode = 'team'; kind = 'qualification_check';
  }

  // Fill any gaps left after the rules.
  if (!owner) owner = (mode === 'team') ? 'team' : 'gp';
  if (!mode) {
    if (owner === 'team') mode = 'team';
    else if (kind === 'good_standing' || kind === 'english' || institution) mode = 'request_institution';
    else mode = 'upload';
  }
  // Consistency: team mode is always team-owned; a GP can't "own" a team-mode item.
  if (mode === 'team') owner = 'team';
  if (owner === 'team' && mode !== 'team') mode = 'team';

  return {
    title: title,
    detail: detail || title,
    sub_items: subItems,
    owner: owner,
    mode: mode,
    institution: mode === 'request_institution' ? institution : '',
    kind: kind
  };
}

// Validate + normalise a whole parsed extraction object.
function normalizeExtraction(parsed) {
  parsed = parsed || {};
  var deadline = null;
  if (typeof parsed.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline.trim())) {
    deadline = parsed.deadline.trim();
  }
  var reference = cleanString(parsed.reference || '', 60) || null;
  var rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  var items = [];
  for (var i = 0; i < rawItems.length; i++) {
    var norm = normalizeItem(rawItems[i]);
    if (norm.title) items.push(norm);
  }
  return { deadline: deadline, reference: reference, items: items };
}

// Best-effort reference detector for when the model misses it.
function detectReference(text) {
  var s = String(text || '');
  var m = s.match(/\b(?:reference|ref(?:erence)?\s*(?:no\.?|number)?|application)\b[^0-9]{0,12}(\d{6,9})/i);
  if (m) return m[1];
  return null;
}

// A short one-line description for the task's `description` column (the full,
// loss-free text always lives in metadata.detail + metadata.sub_items).
function shortDescription(item) {
  var ownerLabel = item.owner === 'gp' ? 'GP' : 'Team';
  var modeLabel = item.mode === 'upload' ? 'upload'
    : item.mode === 'request_institution' ? ('request from ' + (item.institution || 'institution'))
    : 'team handles';
  var base = '[' + ownerLabel + ' · ' + modeLabel + '] ' + (item.detail || item.title);
  if (item.sub_items && item.sub_items.length) {
    base += ' (' + item.sub_items.length + ' required attachment' + (item.sub_items.length === 1 ? '' : 's') + ')';
  }
  return base.slice(0, 1800);
}

// ── Combined reply draft ───────────────────────────────────────────────────

// Build the single reply the team sends back on the original AHPRA thread once
// the GP has actioned their institution-request items. Returns {subject, body}.
function buildCombinedReplyDraft(opts) {
  opts = opts || {};
  var gpName = cleanString(opts.gpFullName || '', 120) || 'the applicant';
  var reference = cleanString(opts.reference || '', 60);
  var threadSubject = cleanString(opts.threadSubject || '', 300);
  var requested = Array.isArray(opts.requestedItems) ? opts.requestedItems : [];
  var uploads = Array.isArray(opts.uploadItems) ? opts.uploadItems : [];

  var subject = threadSubject
    ? (/^re:/i.test(threadSubject) ? threadSubject : ('Re: ' + threadSubject))
    : ('Re: ' + DEFAULT_REPLY_SUBJECT + (reference ? ' — ' + reference : ''));

  var lines = [];
  lines.push('Dear AHPRA Officer,');
  lines.push('');
  lines.push('Thank you for your notice' + (reference ? ' (reference ' + reference + ')' : '') +
    ' regarding ' + gpName + "'s application. We are writing to confirm the requested items have now been actioned.");
  lines.push('');

  if (uploads.length) {
    lines.push('Please find attached the following documents:');
    for (var u = 0; u < uploads.length; u++) {
      lines.push('  - ' + cleanString(uploads[u].title || 'Document', 200));
    }
    lines.push('');
  }

  if (requested.length) {
    lines.push('The following items have been requested to be sent to you directly from the issuing institution. We would be grateful if you could confirm receipt:');
    for (var r = 0; r < requested.length; r++) {
      var it = requested[r];
      var inst = cleanString(it.institution || '', 120);
      lines.push('  - ' + cleanString(it.title || 'Item', 200) + (inst ? ' (direct from ' + inst + ')' : ''));
    }
    lines.push('');
  }

  lines.push('Please let us know if anything further is required. We would be happy to assist.');
  lines.push('');
  lines.push('Kind regards,');
  lines.push('The GP Link Registration Support Team');

  return { subject: subject, body: lines.join('\n') };
}

module.exports = {
  S80_OWNERS: S80_OWNERS,
  S80_MODES: S80_MODES,
  DEFAULT_REPLY_SUBJECT: DEFAULT_REPLY_SUBJECT,
  EXTRACTION_SYSTEM: EXTRACTION_SYSTEM,
  buildExtractionPrompt: buildExtractionPrompt,
  parseExtractionText: parseExtractionText,
  normalizeItem: normalizeItem,
  normalizeExtraction: normalizeExtraction,
  detectReference: detectReference,
  shortDescription: shortDescription,
  buildCombinedReplyDraft: buildCombinedReplyDraft
};
