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

// The app's existing "Show me how" acquisition steps (Certificate of Good Standing,
// Confirmation of training, etc.) so a GP item can reuse the real steps + the right
// AHPRA destination mailbox instead of the officer's loose "send it to me" wording.
var docGuides = require('./ahpra-doc-guides.js');

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
  'You ALSO rewrite each requirement into a clear, friendly instruction addressed directly to the doctor —',
  'in plain second-person English ("you"), never copying the officer\'s point of view or wording.',
  'Return strict JSON only — no prose, no markdown fences.'
].join(' ');

function buildExtractionPrompt(emailMeta, opts) {
  emailMeta = emailMeta || {};
  opts = opts || {};
  var officer = opts.officer || {};
  var officerEmail = String(officer.email || '').trim();
  // The generic placeholder is not a real officer — treat it as unknown.
  if (officerEmail.toLowerCase() === 'officer@ahpra.gov.au') officerEmail = '';
  var officerName = looksLikeName(String(officer.name || '').trim()) ? String(officer.name || '').trim() : '';
  var officerPhrase = officerEmail
    ? ('"directly to your assigned AHPRA officer' + (officerName ? ' (' + officerName + ', ' + officerEmail + ')' : ' (' + officerEmail + ')') + '"')
    : '"directly to your assigned AHPRA officer"';
  return [
    'An AHPRA (Australian Health Practitioner Regulation Agency) officer has emailed a GP registration support team,',
    'usually a "Notice to provide further information under section 80(1)(b)" listing documents/clarifications they need.',
    (officerEmail ? ('The assigned AHPRA officer for this application is ' + (officerName ? officerName + ' ' : '') + '<' + officerEmail + '>.') : ''),
    '',
    'Split the email into every individual thing that is being asked for. For EACH item return:',
    '- "title": a short human label (e.g. "Certificate of Good Standing from GMC").',
    '- "detail": the FULL requirement, copied faithfully from the email. Include every sub-point, every form-question',
    '  reference (e.g. "Q3 of SPPA-00"), certification requirements, and how to submit it. DO NOT shorten or paraphrase',
    '  away specifics. If the officer listed several attachments under one heading, keep them all.',
    '- "gp_instructions": a short, warm message written DIRECTLY TO THE DOCTOR (second person, "you"), in plain everyday',
    '  English, telling them what they need to do and why it matters. NEVER copy the officer\'s wording or point of view.',
    '  Do NOT write things like "we have received", "I require", "the applicant", or "to my email address" — turn it into',
    '  a clear instruction to the doctor. If the officer asks for something to be sent "to me" / "to my email address",',
    '  instead write ' + officerPhrase + '. Do NOT invent step-by-step "how to obtain it" instructions — the app shows the',
    '  doctor those steps separately; just explain what is needed, why, and (for request-from-institution items) that the',
    '  institution must send it DIRECTLY to AHPRA. Keep it to 1–3 short sentences.',
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
    '- "confidence": a number from 0 to 1 — how sure you are about this item\'s owner/mode/kind',
    '  classification (1 = certain, 0 = a guess).',
    '- "reason": one short sentence explaining the owner/mode choice in plain English',
    '  (e.g. "Certificate of Good Standing -> the GP requests it from the GMC").',
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
    '{"deadline":"YYYY-MM-DD"|null,"reference":"string"|null,"items":[{"title":"","detail":"","gp_instructions":"","sub_items":[],"owner":"gp|team","mode":"upload|request_institution|team","institution":"","kind":"","confidence":0.0,"reason":""}]}',
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

// Does this look like a human name (rather than an email username like
// "jane.officer")? Used so we never present an address local-part as a name.
function looksLikeName(name) {
  if (!name || /@/.test(name)) return false;
  return /\s/.test(name) || !/[._]/.test(name);
}

// A clear, human label for the assigned AHPRA officer to use in GP-facing copy.
// The generic placeholder ('officer@ahpra.gov.au') counts as "unknown".
function officerLabel(officer) {
  officer = officer || {};
  var email = cleanString(officer.email || '', 200);
  var name = cleanString(officer.name || '', 120);
  if (email.toLowerCase() === 'officer@ahpra.gov.au') email = '';
  if (!email) return 'your assigned AHPRA officer';
  if (looksLikeName(name)) return 'your assigned AHPRA officer, ' + name + ', at ' + email;
  return 'your assigned AHPRA officer at ' + email;
}

// Backstop that scrubs the officer's "send it to my email address" / "to me"
// wording out of GP-facing text and replaces it with a clear, named address.
// Only touches GP-facing copy — never the verbatim `detail` we keep for the team.
// Order matters: consume "to me at <email>" first so we don't leave a dangling
// address behind after the broader "send … to me" rule.
// `destLabel` (optional) overrides the officer label — used for documents the app
// already guides, where the steps below carry the authoritative AHPRA mailbox, so
// the instruction should just say "AHPRA" rather than name a competing address.
function applyOfficerEmail(text, officer, destLabel) {
  var s = String(text || '');
  if (!s) return s;
  var label = destLabel || officerLabel(officer);
  var repls = [
    [/\bto\s+me\s+at\s+\S+@\S+/gi, 'to ' + label],
    [/to\s+my\s+e-?mail\s*(?:address|account|inbox)?/gi, 'to ' + label],
    [/to\s+my\s+(?:inbox|attention)/gi, 'to ' + label],
    [/\bsend(?:\s+it|\s+them|\s+these)?\s+to\s+me\b/gi, 'send it to ' + label],
    [/directly\s+to\s+me\b/gi, 'directly to ' + label],
    [/\bto\s+me\s+directly\b/gi, 'to ' + label + ' directly']
  ];
  for (var i = 0; i < repls.length; i++) s = s.replace(repls[i][0], repls[i][1]);
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
function normalizeItem(raw, ctx) {
  raw = raw || {};
  ctx = ctx || {};
  var title = cleanString(raw.title || raw.name || 'AHPRA requested item', 200);
  var detail = cleanString(raw.detail || raw.description || '', 8000);
  // GP-facing instruction the model wrote (second person, plain English). Kept
  // separate from `detail` so the team still sees the officer's verbatim text.
  var gpInstr = cleanString(raw.gp_instructions || raw.gpInstructions || raw.gp_instruction || '', 4000);
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

  // Attach the app's existing "how to get this" steps for documents we already
  // guide (Certificate of Good Standing, Confirmation of training, …). Only GP
  // items need these; team items are handled behind the scenes.
  var country = ctx.country || 'uk';
  var howToSteps = [];
  var docGuideKey = '';
  var guideReminder = '';
  var guide = (owner === 'gp') ? docGuides.matchGuide({ title: title, detail: detail, kind: kind, institution: institution }, country) : null;
  if (guide) {
    howToSteps = Array.isArray(guide.steps) ? guide.steps.slice() : [];
    docGuideKey = guide.key || '';
    guideReminder = guide.reminder || '';
  }

  // Fallback GP instruction if the model didn't supply usable copy, so the doctor
  // is never shown the officer's raw wording or an empty card.
  if (!gpInstr && owner === 'gp') {
    if (mode === 'upload') {
      gpInstr = 'Upload “' + title + '”. Our team will review it for you once it’s in.';
    } else if (mode === 'request_institution') {
      var dest = (guide && guide.destination_email) ? guide.destination_email : '';
      var who = institution || 'the issuing body';
      gpInstr = 'Ask ' + who + ' to send this directly to AHPRA' + (dest ? ' at ' + dest : '') + ', then tap “Mark as requested”.';
    }
  }
  // Backstop: never leak the officer's "to my email address" wording to the GP.
  // For a known document, the steps below carry the real mailbox, so the instruction
  // says just "AHPRA"; otherwise we name the assigned officer's actual address.
  gpInstr = applyOfficerEmail(gpInstr, ctx.officer, (guide && guide.destination_email) ? 'AHPRA' : null);

  var confidence = (typeof raw.confidence === 'number' && isFinite(raw.confidence))
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;
  var reason = cleanString(raw.reason || '', 300);

  return {
    title: title,
    detail: detail || title,
    gp_instructions: gpInstr,
    how_to_steps: howToSteps,
    doc_guide_key: docGuideKey,
    guide_reminder: guideReminder,
    sub_items: subItems,
    owner: owner,
    mode: mode,
    institution: mode === 'request_institution' ? institution : '',
    kind: kind,
    confidence: confidence,
    reason: reason
  };
}

// True only for a real calendar date in strict YYYY-MM-DD form. The shape regex
// alone passes impossible dates the model can hallucinate (e.g. "2025-02-30",
// "2025-13-01"), which would then be rejected by the Postgres DATE column and
// silently drop the whole notice. This guards against that.
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return false;
  var p = s.trim().split('-');
  var y = +p[0], m = +p[1], d = +p[2];
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Validate + normalise a whole parsed extraction object. `ctx` (optional) carries
// the assigned AHPRA officer ({name,email}) and the GP's country ('uk'|'ie'|'nz')
// so items get GP-facing instructions + the right acquisition guide.
function normalizeExtraction(parsed, ctx) {
  parsed = parsed || {};
  ctx = ctx || {};
  var deadline = null;
  if (typeof parsed.deadline === 'string' && isRealDate(parsed.deadline.trim())) {
    deadline = parsed.deadline.trim();
  }
  var reference = cleanString(parsed.reference || '', 60) || null;
  var rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  var items = [];
  for (var i = 0; i < rawItems.length; i++) {
    var norm = normalizeItem(rawItems[i], ctx);
    if (norm.title) items.push(norm);
  }
  return { deadline: deadline, reference: reference, items: items, officer: ctx.officer || null, country: ctx.country || null };
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

  var officerName = cleanString(opts.officerName || '', 120);
  var lines = [];
  lines.push('Dear ' + (officerName && !/@/.test(officerName) ? officerName : 'AHPRA Officer') + ',');
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

// Decide whether a freshly-extracted bundle is safe to auto-release without human review:
// non-empty, every item highly confident, and no item that needs manual splitting / unknown kind.
function bundleAutoReleasable(items, threshold) {
  if (!Array.isArray(items) || items.length === 0) return false;
  var min = (typeof threshold === 'number') ? threshold : 0.92;
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var c = (typeof it.confidence === 'number' && isFinite(it.confidence)) ? it.confidence : 0;
    if (c < min) return false;
    if (!it.kind || it.kind === 'needs_split') return false;
  }
  return true;
}

module.exports = {
  S80_OWNERS: S80_OWNERS,
  S80_MODES: S80_MODES,
  DEFAULT_REPLY_SUBJECT: DEFAULT_REPLY_SUBJECT,
  EXTRACTION_SYSTEM: EXTRACTION_SYSTEM,
  buildExtractionPrompt: buildExtractionPrompt,
  parseExtractionText: parseExtractionText,
  isRealDate: isRealDate,
  applyOfficerEmail: applyOfficerEmail,
  officerLabel: officerLabel,
  normalizeItem: normalizeItem,
  normalizeExtraction: normalizeExtraction,
  detectReference: detectReference,
  shortDescription: shortDescription,
  buildCombinedReplyDraft: buildCombinedReplyDraft,
  docGuides: docGuides,
  bundleAutoReleasable: bundleAutoReleasable
};
