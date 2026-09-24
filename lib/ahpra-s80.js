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
//   'gp'       — the doctor does it (upload a file, or request a document from their institution)
//   'practice' — the supervising practice supplies it (an updated supervisor CV, a position
//                description, a letter from the practice); the team emails the practice to request
//                it and reviews what comes back. Never shown to the GP.
//   'team'     — the GP Link support team handles it behind the scenes (never shown to the GP)
var S80_OWNERS = ['gp', 'practice', 'team'];

// How an item is actioned.
//   'upload'              — GP uploads a file they hold/can obtain; team then reviews it
//   'request_institution' — GP asks an institution (GMC, OET, etc.) to send the document
//                           directly to AHPRA, then marks it complete
//   'practice_upload'     — the team emails the practice asking for the document; the practice
//                           replies with it attached (or staff file it by hand); team reviews it
//   'team'                — team-owned work (supervised practice plan, qualification/PSV check)
var S80_MODES = ['upload', 'request_institution', 'practice_upload', 'team'];

// Human labels shared by the admin tray, the Ops Queue and task descriptions. The client keeps
// a copy of these (pages/admin.html) — keep both in step.
var S80_OWNER_LABELS = { gp: 'GP does it', practice: 'Practice does it', team: 'Team handles' };
var S80_MODE_LABELS = { upload: 'GP uploads', request_institution: 'GP requests from institution', practice_upload: 'Practice uploads', team: 'Team handles' };

// Owner/mode are a coupled pair: a mode always implies exactly one owner.
function ownerForMode(mode) {
  if (mode === 'team') return 'team';
  if (mode === 'practice_upload') return 'practice';
  return 'gp';
}
function isGpMode(mode) { return mode === 'upload' || mode === 'request_institution'; }

// The GP mode to fall back to when an item is routed back to the doctor: the AI's original
// call first (so "revert to what the AI marked" really reverts), then the item's nature.
function defaultGpMode(meta) {
  meta = meta || {};
  if (isGpMode(meta.ai_mode)) return meta.ai_mode;
  if (meta.kind === 'good_standing' || meta.kind === 'english' || meta.institution) return 'request_institution';
  return 'upload';
}

// Apply a Who/How change from the review tray to an item's stored metadata and return the
// consistent {owner, mode} pair. Pure and DB-driven: the caller passes what is SAVED, not what
// happens to be on screen — the old client handler read the sibling <select> from the DOM, and a
// change saved between two re-renders produced pairs like owner=team + mode=upload (seen on Dr
// Mercy's "Resubmission of CV" item), which hid the GP preview. An explicit owner wins over an
// explicit mode when the two disagree.
function applyRouting(meta, change) {
  meta = meta || {};
  change = change || {};
  var mode = S80_MODES.indexOf(meta.mode) >= 0 ? meta.mode : '';
  var owner = S80_OWNERS.indexOf(meta.owner) >= 0 ? meta.owner : (mode ? ownerForMode(mode) : 'gp');
  var wantOwner = S80_OWNERS.indexOf(change.owner) >= 0 ? change.owner : '';
  var wantMode = S80_MODES.indexOf(change.mode) >= 0 ? change.mode : '';
  if (wantMode) { mode = wantMode; owner = ownerForMode(mode); }
  if (wantOwner && owner !== wantOwner) {
    owner = wantOwner;
    if (owner === 'team') mode = 'team';
    else if (owner === 'practice') mode = 'practice_upload';
    else if (!isGpMode(mode)) mode = defaultGpMode(meta);
  }
  if (!mode) mode = owner === 'team' ? 'team' : owner === 'practice' ? 'practice_upload' : defaultGpMode(meta);
  owner = ownerForMode(mode);
  return { owner: owner, mode: mode };
}

// Never leave a routed item without the copy its new owner needs: a GP item must have a
// GP-facing instruction (that is the "What the GP will see" preview) and a practice item a
// practice-facing one. Returns only the keys that need writing. Existing text is never replaced,
// so the AI's richer wording survives a round trip through "Team handles" and back.
function ensureInstructions(meta, ctx) {
  meta = meta || {};
  ctx = ctx || {};
  var patch = {};
  var item = { title: meta.title || '', detail: meta.detail || '', kind: meta.kind || '', institution: meta.institution || '', mode: meta.mode, owner: meta.owner };
  if (meta.owner === 'gp' && !cleanString(meta.gp_instructions || '', 4000)) {
    var guide = docGuides.matchGuide({ title: item.title, detail: item.detail, kind: item.kind, institution: item.institution, mode: item.mode }, ctx.country || 'uk', { officer: ctx.officer || meta.officer });
    patch.gp_instructions = applyOfficerEmail(fallbackGpInstructions(item, guide), ctx.officer || meta.officer, (guide && guide.destination_email) ? 'AHPRA' : null);
    if (!(Array.isArray(meta.how_to_steps) && meta.how_to_steps.length) && guide) {
      patch.how_to_steps = Array.isArray(guide.steps) ? guide.steps.slice() : [];
      patch.doc_guide_key = guide.key || '';
      patch.guide_reminder = guide.reminder || '';
    }
  }
  if (meta.owner === 'practice' && !cleanString(meta.practice_instructions || '', 4000)) {
    patch.practice_instructions = fallbackPracticeInstructions(item);
  }
  return patch;
}

function fallbackGpInstructions(item, guide) {
  var title = item.title || 'the requested document';
  if (item.mode === 'request_institution') {
    var dest = (guide && guide.destination_email) ? guide.destination_email : '';
    var who = item.institution || 'the issuing body';
    return 'Ask ' + who + ' to send this directly to AHPRA' + (dest ? ' at ' + dest : '') + ', then tap “Mark as requested”.';
  }
  return 'Upload “' + title + '”. Our team will review it for you once it’s in.';
}

function fallbackPracticeInstructions(item) {
  var title = item.title || 'the requested document';
  return 'AHPRA has asked for “' + title + '” to progress the doctor’s registration. Please reply to this email with the document attached and we will pass it on to AHPRA.';
}

// GP- and practice-facing copy must not read as machine-written: the owner asked for no em
// dashes in anything a doctor or practice reads. Turn a spaced dash into a sentence break and
// capitalise what follows. Unspaced en dashes (date ranges like 2019–2021) are left alone.
function dashesToSentences(text) {
  var s = String(text || '');
  if (!s || !/[—–]/.test(s)) return s;
  var parts = s.split(/\s+[—–]\s+|—/);
  var out = parts[0].trim();
  for (var i = 1; i < parts.length; i++) {
    var next = parts[i].trim();
    if (!next) continue;
    if (!out) { out = next; continue; }
    if (!/[.!?:]$/.test(out)) out += '.';
    out += ' ' + next.charAt(0).toUpperCase() + next.slice(1);
  }
  return out;
}

var DEFAULT_REPLY_SUBJECT = 'Notice to provide further information under section 80(1)(b)';

// ── Extraction prompt ──────────────────────────────────────────────────────

var EXTRACTION_SYSTEM = [
  'You read emails an AHPRA officer sends to a GP registration support team and turn them into a precise, complete checklist.',
  'Your single most important rule: NEVER drop or summarise away any detail the officer wrote. Copy the exact requirements.',
  'You ALSO rewrite each requirement TWICE in plain English: once for the doctor (second person, "you"), and once',
  'for the GP Link support team / RSO — a simple "here is what AHPRA is actually asking, and what to do" that drops',
  'the officer\'s legal and jargon wording. Never copy the officer\'s point of view.',
  'You do NOT create tasks for general process instructions (how/where to submit) — only for real documents or actions.',
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
    '- "team_instructions": a short, plain-English rewrite for the GP Link support team (the RSO): 1–2 sentences saying',
    '  what AHPRA is actually asking for and exactly what the team needs to do — in simple terms, NOT the officer\'s legal',
    '  wording. For any PSV / MyIntealth / AMC item, this MUST say to book a Zoom call with the doctor to debug the issue.',
    '- "practice_instructions": ONLY for owner "practice" items — a short, courteous note written TO THE PRACTICE MANAGER',
    '  (1–3 sentences) saying exactly which document they need to send back and why AHPRA needs it. Otherwise "".',
    '- "deliverable": the single document or action that satisfies this item, in a few words (e.g. "Updated CV",',
    '  "Certificate of Good Standing from GMC", "Updated supervisor CV"). Two items with the same deliverable are the same task.',
    '- "sub_items": an array of strings, one per distinct attachment/sub-requirement the officer listed under this item',
    '  (e.g. each named SPPA-00 attachment). Use [] if the item is a single thing.',
    '- "owner": who must act —',
    '    "gp"       = the doctor provides it (a personal document, or they request it from an institution);',
    '    "practice" = the SUPERVISING PRACTICE (where the doctor will work) must supply or amend a document (an updated',
    '                 or signed supervisor CV, a position description, a letter or confirmation from that practice);',
    '    "team"     = the GP Link support team handles it behind the scenes.',
    '- "mode": how it gets done —',
    '    "upload"              = the GP uploads a file they hold or can obtain (e.g. reference letters, certified copies);',
    '    "request_institution" = the GP asks an institution to send the document DIRECTLY to AHPRA, then marks it done',
    '                            (e.g. Certificate of Good Standing from a medical council; test confirmation from OET/IELTS);',
    '    "practice_upload"     = the team emails the practice and the practice sends the document back;',
    '    "team"                = the support team does it (not shown to the GP).',
    '- "institution": for "request_institution" items, the body that issues it, named exactly as the letter names it',
    '  (e.g. "GMC", "RCGP", "OET", "ECFMG", "Medical and Dental Council of Nigeria"). Never swap in the doctor\'s home',
    '  regulator when the letter names a different council or board. Otherwise "".',
    '- "kind": one of "supervised_practice_plan", "qualification_check", "english", "good_standing",',
    '  "training_confirmation" (confirmation of GP/specialist training from the GMC, RCGP/CCT), "practice_document",',
    '  or "" if none fit.',
    '',
    'ONE DOCUMENT = ONE ITEM. If two requirements in the letter are satisfied by the SAME document or action (for example',
    'the English language standard is to be evidenced by the same resubmitted CV that must explain the gaps in practice),',
    'return ONE item: name the deliverable in the title, and cover BOTH requirements in detail, gp_instructions and',
    'team_instructions. Never return two items that ask the doctor for the same document.',
    'Never use em dashes in gp_instructions or practice_instructions — use full stops and short sentences instead.',
    '',
    'Do NOT create an item for general instructions about how or where to submit/send documents, portal usage, contact',
    'details, timelines, or an explanation of the process — that is guidance, not a task. Fold any such wording into the',
    'relevant document item\'s detail if useful, but never emit a standalone "how to submit"/"submitting documents" item.',
    'Do NOT create an item for a statutory declaration. A statutory declaration only applies as a fallback if the GMC',
    '(or the issuing council) cannot confirm the doctor\'s registration / good standing — the doctor waits for the GMC',
    'confirmation instead, so a statutory declaration is never its own task.',
    'For a "confirmation of training" item (GMC confirmation of GP/specialist training, RCGP/CCT), NEVER mention a',
    'statutory declaration at all — not in gp_instructions, team_instructions or sub_items — even if the officer offers',
    'an "interim statutory declaration" alongside it. The doctor simply requests the confirmation from the GMC.',
    '',
    'Ownership rules you MUST apply:',
    '- The supervised practice plan / SPPA-00 form itself (and the attachments the officer lists UNDER it: supervisor CVs,',
    '  position description, Section G, conflict-of-interest details) is ALWAYS owner "team", mode "team",',
    '  kind "supervised_practice_plan".',
    '- A standalone query about a document only the SUPERVISING PRACTICE can supply or amend — an updated, corrected or',
    '  signed supervisor CV, a position description, a letter or confirmation from that practice — is owner "practice",',
    '  mode "practice_upload", kind "practice_document", with practice_instructions filled in. (Reference letters from',
    '  the doctor\'s PREVIOUS employers are still the doctor\'s to gather: owner "gp", mode "upload".)',
    '- A qualification check / primary source verification / PSV, OR anything about MyIntealth or the AMC',
    '  (e.g. ECFMG, EPIC, AMC portfolio/assessment, MyIntealth submission or status), is ALWAYS owner "team",',
    '  mode "team", kind "qualification_check" — the team books a Zoom call with the doctor to debug it.',
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
    '{"deadline":"YYYY-MM-DD"|null,"reference":"string"|null,"items":[{"title":"","detail":"","gp_instructions":"","team_instructions":"","practice_instructions":"","deliverable":"","sub_items":[],"owner":"gp|practice|team","mode":"upload|request_institution|practice_upload|team","institution":"","kind":""}]}',
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
  // RSO-facing plain rewrite (what AHPRA is asking + what the team does), kept separate from the
  // officer's verbatim `detail`. Shown to the team instead of the confusing officer wording.
  var teamInstr = cleanString(raw.team_instructions || raw.teamInstructions || raw.rso_instructions || raw.team_instruction || '', 4000);
  // Practice-facing note (what the practice manager must send back) for practice-owned items.
  var practiceInstr = cleanString(raw.practice_instructions || raw.practiceInstructions || raw.practice_instruction || '', 4000);
  // The one document/action that satisfies the item — the key duplicate items are merged on.
  var deliverable = cleanString(raw.deliverable || '', 200);
  var subItems = normalizeSubItems(raw.sub_items || raw.subItems || raw.attachments);
  var kind = cleanString(raw.kind || '', 60).toLowerCase();
  var institution = cleanString(raw.institution || '', 120);

  var owner = String(raw.owner || '').trim().toLowerCase();
  // Map legacy/loose owner words onto our buckets.
  if (owner === 'clinic' || owner === 'practice manager' || owner === 'supervising practice') owner = 'practice';
  if (owner === 'hazel' || owner === 'support' || owner === 'gplink' || owner === 'gp link') owner = 'team';
  if (S80_OWNERS.indexOf(owner) === -1) owner = '';

  var mode = String(raw.mode || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (mode === 'request' || mode === 'institution' || mode === 'request_from_institution') mode = 'request_institution';
  if (mode === 'practice' || mode === 'practice_uploads' || mode === 'request_practice' || mode === 'request_from_practice') mode = 'practice_upload';
  if (S80_MODES.indexOf(mode) === -1) mode = '';

  // Kind-driven hard rules (these override a confused model).
  var hay = title + ' ' + detail;
  // The wording test is a TIEBREAKER, not an override: it promotes an item the model left to the
  // team (Mercy's supervisor-CV query came back tagged SPPA/team) but never takes an item away
  // from the doctor when the model said "gp" — "a statement signed by the practice principal at
  // your previous employer" is still the doctor's to gather.
  var practiceDoc = owner !== 'gp' && isPracticeDocumentItem({ title: title, detail: detail });
  if (/sppa[\s_-]?00|supervis(ed|ion) practice plan|section g/i.test(hay) ||
      (kind === 'supervised_practice_plan' && !practiceDoc && owner !== 'practice' && mode !== 'practice_upload')) {
    // The SPPA-00 form (and the attachments listed under it) runs through the team's SPPA pipeline.
    owner = 'team'; mode = 'team'; kind = 'supervised_practice_plan';
  } else if (kind === 'qualification_check' || kind === 'psv' ||
      /primary source verification|\bpsv\b|ecfmg|epic\b|qualification check|\bmyintealth\b|my\s?intealth|\bamc\b/i.test(hay)) {
    // PSV / MyIntealth / AMC issues are debugged on a Zoom call the team books with the doctor.
    owner = 'team'; mode = 'team'; kind = 'qualification_check';
  } else if (owner === 'practice' || mode === 'practice_upload' || kind === 'practice_document' ||
      (kind === 'supervised_practice_plan' && owner !== 'gp') || practiceDoc) {
    // A standalone document only the supervising practice can supply or amend (an updated
    // supervisor CV, a position description, a letter from the practice): the team emails them.
    owner = 'practice'; mode = 'practice_upload';
    if (!kind || kind === 'supervised_practice_plan') kind = 'practice_document';
  }

  // A confirmation-of-training item is its own kind: the model often tags it "good_standing"
  // (both come from the GMC), which used to pull the Certificate of Good Standing steps and
  // mailbox onto it. The explicit words in the title/detail win over the tag.
  if ((!kind || kind === 'good_standing') && isTrainingConfirmationItem({ title: title, detail: detail })) kind = 'training_confirmation';

  // Fill any gaps left after the rules.
  if (!owner) owner = (mode === 'team') ? 'team' : (mode === 'practice_upload') ? 'practice' : 'gp';
  if (!mode) {
    if (owner === 'team') mode = 'team';
    else if (owner === 'practice') mode = 'practice_upload';
    else if (kind === 'good_standing' || kind === 'english' || kind === 'training_confirmation' || institution) mode = 'request_institution';
    else mode = 'upload';
  }
  // Consistency: every mode implies exactly one owner (team mode is team-owned, practice_upload is
  // practice-owned, upload/request_institution are the GP's). An owner without a matching mode
  // takes that owner's only/default mode.
  if (ownerForMode(mode) !== owner) {
    if (owner === 'team') mode = 'team';
    else if (owner === 'practice') mode = 'practice_upload';
    else owner = ownerForMode(mode);
  }

  // Attach the app's existing "how to get this" steps for documents we already
  // guide (Certificate of Good Standing, Confirmation of training, …). Only GP
  // items need these; team items are handled behind the scenes. The steps follow
  // the issuing body the letter names: a body outside our UK / Ireland / NZ guides
  // gets generic "contact that body, send it straight to AHPRA" steps instead.
  var country = ctx.country || 'uk';
  var howToSteps = [];
  var docGuideKey = '';
  var guideReminder = '';
  var guide = (owner === 'gp') ? docGuides.matchGuide({ title: title, detail: detail, kind: kind, institution: institution, mode: mode }, country, { officer: ctx.officer }) : null;
  if (guide) {
    howToSteps = Array.isArray(guide.steps) ? guide.steps.slice() : [];
    docGuideKey = guide.key || '';
    guideReminder = guide.reminder || '';
  }

  // Fallback GP instruction if the model didn't supply usable copy, so the doctor
  // is never shown the officer's raw wording or an empty card.
  if (!gpInstr && owner === 'gp') {
    gpInstr = fallbackGpInstructions({ title: title, mode: mode, institution: institution }, guide);
  }
  // Backstop: never leak the officer's "to my email address" wording to the GP.
  // For a known document, the steps below carry the real mailbox, so the instruction
  // says just "AHPRA"; otherwise we name the assigned officer's actual address.
  gpInstr = dashesToSentences(applyOfficerEmail(gpInstr, ctx.officer, (guide && guide.destination_email) ? 'AHPRA' : null));

  // Practice-facing note for practice-owned items (what the practice manager must send back).
  if (owner === 'practice' && !practiceInstr) practiceInstr = fallbackPracticeInstructions({ title: title });
  practiceInstr = dashesToSentences(practiceInstr);

  // A qualification_check (PSV / MyIntealth / AMC) always needs the team to book a Zoom call with the
  // doctor to debug it — surface that as a flag the tray/active views can push on.
  var needsCall = (kind === 'qualification_check');

  // RSO-facing plain rewrite. Fall back to a sensible default so the team is never left with only the
  // officer's raw wording. Never run through applyOfficerEmail — this is internal, not GP-facing.
  if (!teamInstr) {
    if (needsCall) {
      teamInstr = 'Book a Zoom call with the doctor to debug their PSV / MyIntealth / AMC status and work out exactly what AHPRA is missing.';
    } else if (kind === 'supervised_practice_plan') {
      teamInstr = 'The team prepares/updates the SPPA-00 and its attachments, then submits it to AHPRA.';
    } else if (owner === 'practice') {
      teamInstr = 'Email the practice to request “' + title + '”, then review what they send back before it goes to AHPRA.';
    } else if (owner === 'gp' && mode === 'request_institution') {
      teamInstr = 'Get the doctor to ask ' + (institution || 'the issuing body') + ' to send “' + title + '” directly to AHPRA, then confirm it arrives.';
    } else if (owner === 'gp' && mode === 'upload') {
      teamInstr = 'Ask the doctor to upload “' + title + '”, then review it before it goes to AHPRA.';
    } else {
      teamInstr = 'AHPRA is asking for “' + title + '” — the team handles this.';
    }
  }

  // The confirmation-of-training item never offers the statutory-declaration route (owner rule).
  var normalized = removeStatutoryDeclarationOption({
    title: title, detail: detail || title, gp_instructions: gpInstr, team_instructions: teamInstr,
    practice_instructions: practiceInstr, sub_items: subItems
  });
  gpInstr = normalized.gp_instructions; teamInstr = normalized.team_instructions;
  practiceInstr = normalized.practice_instructions; subItems = normalized.sub_items;

  return {
    title: title,
    detail: detail || title,
    gp_instructions: gpInstr,
    team_instructions: teamInstr,
    practice_instructions: practiceInstr,
    deliverable: deliverable,
    stat_dec_removed: !!normalized.stat_dec_removed,
    needs_call: needsCall,
    how_to_steps: howToSteps,
    doc_guide_key: docGuideKey,
    guide_reminder: guideReminder,
    sub_items: subItems,
    owner: owner,
    mode: mode,
    institution: mode === 'request_institution' ? institution : '',
    kind: kind
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

// A "how/where to submit documents" or process-explanation line is guidance, not a task —
// the officer explaining the mechanics, not requesting a document. The prompt already tells the
// model not to emit these; this is a backstop so one never becomes its own task box.
function isSubmissionInfoItem(item) {
  var t = String((item && item.title) || '').toLowerCase().replace(/[“”"']/g, '').trim();
  if (!t) return false;
  if (/^how (to|you|do you|do i|we) .*(submit|send|provide|upload|lodge|return|supply)/.test(t)) return true;
  if (/^(submitting|sending|uploading|providing|lodging) (your |the |these )?documents?\b/.test(t)) return true;
  if (/^(where|how) (to|do you|do i) (submit|send|upload|provide)\b/.test(t)) return true;
  if (/how to submit documents|method of submission|submission (instructions|process|method|guide|details)|how (documents|files) (are|should be) (submitted|sent)/.test(t)) return true;
  return false;
}

// A statutory declaration is never tasked to the GP: it only applies as a fallback if the GMC (or the
// issuing council) can't confirm registration / good standing, so the doctor waits for the GMC
// confirmation rather than acting on a stat dec. Keyed on the item title, so a good-standing item that
// merely mentions a stat dec in its detail is still kept.
function isStatutoryDeclarationItem(item) {
  var t = String((item && item.title) || '').toLowerCase().replace(/[“”"']/g, '').trim();
  if (!t) return false;
  return /statutory declaration|\bstat\.?\s*decs?\b/.test(t);
}

// The "Confirmation of GP/specialist training from the GMC (RCGP/CCT)" item. Officers routinely
// offer an "interim statutory declaration" alongside it; the owner's rule (2026-09-17) is that we
// never put that option in front of the doctor or the team for THIS item — the doctor requests
// the confirmation from the GMC, full stop. (Standalone stat-dec items were already dropped.)
var TRAINING_CONFIRMATION_RE = /confirmation of (?:your |uk )?(?:gp |specialist )?training|confirmation of training|training (?:confirmation|verification)|certificate of completion of training|\bcct\b.*\b(?:confirmation|confirm)\b|\b(?:confirm|confirmation)\b.*\b(?:rcgp|cct)\b/i;
function isTrainingConfirmationItem(item) {
  var hay = String((item && item.title) || '') + ' ' + String((item && item.detail) || '');
  return TRAINING_CONFIRMATION_RE.test(hay);
}

var STAT_DEC_RE = /statutory declaration|\bstat\.?\s*decs?\b/i;

// Drop every sentence that mentions a statutory declaration. Sentence-level so the rest of the
// instruction ("apply to the GMC for the confirmation…") survives untouched.
function stripStatutoryDeclarationSentences(text) {
  var s = String(text || '');
  if (!s || !STAT_DEC_RE.test(s)) return s;
  var parts = s.split(/(?<=[.!?])\s+|\n+/);
  var kept = parts.filter(function (p) { return p.trim() && !STAT_DEC_RE.test(p); });
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

// Apply the rule to one normalised item: GP text, team text and sub-items lose the stat-dec
// option; the officer's verbatim `detail` is left alone (it is the record of what was asked).
function removeStatutoryDeclarationOption(item) {
  if (!item || !isTrainingConfirmationItem(item)) return item;
  var touched = false;
  ['gp_instructions', 'team_instructions', 'practice_instructions'].forEach(function (k) {
    var before = String(item[k] || '');
    if (!before || !STAT_DEC_RE.test(before)) return;
    item[k] = stripStatutoryDeclarationSentences(before);
    touched = true;
  });
  if (Array.isArray(item.sub_items) && item.sub_items.length) {
    var keptSubs = item.sub_items.filter(function (s) { return !STAT_DEC_RE.test(String((s && s.label) || s || '')); });
    if (keptSubs.length !== item.sub_items.length) { item.sub_items = keptSubs; touched = true; }
  }
  if (touched) item.stat_dec_removed = true;
  return item;
}

// A document only the SUPERVISING practice can supply or amend — an updated supervisor CV, a
// position description, a letter from the practice. Deliberately narrow: the doctor's OWN CV,
// reference letters from PREVIOUS employers (the GP gathers those), and a GP document that
// merely mentions an employer must not match.
function isPracticeDocumentItem(item) {
  var t = String((item && item.title) || '');
  var d = String((item && item.detail) || '');
  var hay = t + ' ' + d;
  // Anything about a PREVIOUS employer/practice is the doctor's history, not the placing practice.
  if (/\b(?:previous|former|prior|past|earlier)\s+(?:employers?|practices?|roles?|positions?|posts?|jobs?)\b/i.test(hay)) return false;
  return /supervisor'?s?\s+cvs?\b|cvs?\s+(?:of|for)\s+(?:the\s+|your\s+|each\s+)?(?:\w+\s+){0,2}supervisors?\b|position\s+description|letter\s+from\s+(?:the\s+|your\s+)?(?:supervising\s+)?practice\b|signed\s+by\s+(?:the\s+)?(?:practice|principal|supervisor)\b/i.test(hay);
}

// ── Duplicate items (one document asked for twice) ──────────────────────────
//
// An officer's letter often states two requirements that the SAME document satisfies — Dr
// Mercy's notice asked for a resubmitted CV with the gaps explained, and separately said the
// English-language standard could only be assessed once that same CV was resubmitted. The model
// returned two tasks; the doctor would have been asked to upload the one CV twice. Items that
// share a deliverable (and the same owner + mode) are folded into one.
var CV_WORD_RE = /\b(?:cv|curriculum vitae|r[eé]sum[eé])\b/i;
// The officer ASKING for the CV again (not merely mentioning one): "we require resubmission of
// your CV", "please resubmit your CV", "provide an updated CV", "CV resubmission".
var CV_REQUEST_RE = /\b(?:re-?submi(?:t|ssion\s+of)|provide|submit|supply|send|require|lodge)\s+(?:an?\s+|the\s+|your\s+)?(?:updated|amended|revised|corrected|complete|full|new)?\s*(?:cv|curriculum vitae)\b|\bcv\s+re-?submission\b/i;
var SUPERVISOR_CV_RE = /supervisor'?s?\s+cv|cv\s+of\s+(?:the\s+)?(?:\w+\s+){0,2}supervisor|dr\.?\s+\w+'s\s+cv/i;

// The document an item boils down to: 'cv' when the title or the model's deliverable names the
// doctor's own CV, 'cv?' when only the officer's wording asks for the CV again (weak: merges only
// into a titled CV item, never with another weak match), 'd:<text>' for a model-named deliverable,
// '' when unknown (never merged).
function deliverableSignature(item) {
  item = item || {};
  var title = String(item.title || '');
  var deliv = String(item.deliverable || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (CV_WORD_RE.test(title) && !SUPERVISOR_CV_RE.test(title)) return 'cv';
  if (deliv && CV_WORD_RE.test(deliv) && !/supervisor/.test(deliv)) return 'cv';
  var detail = String(item.detail || '');
  if (CV_REQUEST_RE.test(detail) && !SUPERVISOR_CV_RE.test(detail)) return 'cv?';
  if (deliv) return 'd:' + deliv + '|' + String(item.institution || '').toLowerCase().trim();
  return '';
}
function signaturesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return a !== 'cv?';           // two weak CV mentions are not the same task
  return (a === 'cv' && b === 'cv?') || (a === 'cv?' && b === 'cv');
}

function joinDistinct(a, b, sep) {
  a = cleanString(a, 8000); b = cleanString(b, 8000);
  if (!a) return b;
  if (!b || a === b || a.indexOf(b) >= 0) return a;
  return a + sep + b;
}

function mergeTwoItems(primary, secondary) {
  var merged = {};
  Object.keys(primary).forEach(function (k) { merged[k] = primary[k]; });
  merged.title = cleanString(primary.title + ' (also covers: ' + secondary.title + ')', 200);
  merged.detail = joinDistinct(primary.detail, secondary.detail, '\n\n');
  merged.gp_instructions = dashesToSentences(joinDistinct(primary.gp_instructions, secondary.gp_instructions, '\n\n'));
  merged.team_instructions = joinDistinct(primary.team_instructions, secondary.team_instructions, ' ');
  merged.practice_instructions = dashesToSentences(joinDistinct(primary.practice_instructions, secondary.practice_instructions, '\n\n'));
  merged.sub_items = (primary.sub_items || []).concat(secondary.sub_items || []);
  merged.kind = primary.kind || secondary.kind || '';
  merged.needs_call = !!(primary.needs_call || secondary.needs_call);
  merged.deliverable = primary.deliverable || secondary.deliverable || '';
  merged.institution = primary.institution || secondary.institution || '';
  if (!(Array.isArray(primary.how_to_steps) && primary.how_to_steps.length) && Array.isArray(secondary.how_to_steps) && secondary.how_to_steps.length) {
    merged.how_to_steps = secondary.how_to_steps.slice();
    merged.doc_guide_key = secondary.doc_guide_key || '';
    merged.guide_reminder = secondary.guide_reminder || '';
  }
  merged.merged_from = (primary.merged_from || [primary.title]).concat(secondary.merged_from || [secondary.title]);
  return merged;
}

// Fold items that ask for the same document into one. The item whose TITLE names the document
// (e.g. "Resubmission of CV…") is the base; the other's requirement is appended so nothing the
// officer asked for is lost. Only same-owner, same-mode items merge — a CV the GP uploads and a
// test result an institution must send are different actions even if worded alike.
function mergeDuplicateItems(items) {
  var out = [];
  (Array.isArray(items) ? items : []).forEach(function (item) {
    var sig = deliverableSignature(item);
    if (sig) {
      for (var i = 0; i < out.length; i++) {
        var prev = out[i];
        if (signaturesMatch(prev._sig, sig) && prev.owner === item.owner && prev.mode === item.mode) {
          // The item whose title names the document is the base (a 'cv' beats a 'cv?').
          var merged = (sig === 'cv' && prev._sig === 'cv?') ? mergeTwoItems(item, prev) : mergeTwoItems(prev, item);
          merged._sig = (sig === 'cv' || prev._sig === 'cv') ? 'cv' : sig;
          out[i] = merged;
          return;
        }
      }
    }
    var copy = {};
    Object.keys(item).forEach(function (k) { copy[k] = item[k]; });
    copy._sig = sig;
    out.push(copy);
  });
  return out.map(function (it) { delete it._sig; return it; });
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
    if (norm.title && !isSubmissionInfoItem(norm) && !isStatutoryDeclarationItem(norm)) items.push(norm);
  }
  items = mergeDuplicateItems(items);
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
  var ownerLabel = item.owner === 'gp' ? 'GP' : item.owner === 'practice' ? 'Practice' : 'Team';
  var modeLabel = item.mode === 'upload' ? 'upload'
    : item.mode === 'request_institution' ? ('request from ' + (item.institution || 'institution'))
    : item.mode === 'practice_upload' ? 'practice uploads'
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

// Picks the AHPRA officer to email from an ordered list of candidates. Each candidate is
// { email, name } or a raw sender string ("Paige Hooper <paige.hooper@ahpra.gov.au>").
// The first real address wins; the generic placeholder counts as unknown.
function resolveReplyOfficer(candidates) {
  var list = Array.isArray(candidates) ? candidates : [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!c) continue;
    var email = '', name = '';
    if (typeof c === 'string') {
      var angle = c.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      if (angle) { name = angle[1]; email = angle[2]; } else { email = c; }
    } else if (typeof c === 'object') {
      email = c.email || ''; name = c.name || '';
    }
    email = cleanString(email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (email === 'officer@ahpra.gov.au') continue;
    // A notice forwarded in by our own staff carries our address as the sender, never the officer's.
    if (/@mygplink\.com\.au$/.test(email)) continue;
    name = cleanString(name, 120);
    return { email: email, name: looksLikeName(name) ? name : '' };
  }
  return { email: '', name: '' };
}

// Deterministic fail-open template for the per-document reply to the AHPRA officer.
function buildOfficerReplyDraft(opts) {
  opts = opts || {};
  var gpName = cleanString(opts.gpName || '', 120) || 'the applicant';
  var itemTitle = cleanString(opts.itemTitle || '', 200) || 'the requested document';
  var reference = cleanString(opts.reference || '', 60);
  var officerName = cleanString(opts.officerName || '', 120);
  var subject = 'Re: ' + DEFAULT_REPLY_SUBJECT + (reference ? ' — ' + reference : '');
  var lines = [];
  lines.push('Dear ' + (officerName && !/@/.test(officerName) ? officerName : 'AHPRA Officer') + ',');
  lines.push('');
  lines.push('Further to your notice' + (reference ? ' (reference ' + reference + ')' : '') + ' regarding Dr ' + gpName + "'s application, please find attached the " + itemTitle + '.');
  lines.push('');
  lines.push('Please let us know if anything further is required.');
  lines.push('');
  lines.push('Kind regards,');
  lines.push('The GP Link Registration Support Team');
  return { subject: subject, body: lines.join('\n') };
}

// AI prompt (SUGGEST_REPLY_MODEL) for the same reply — richer, still edited by the RSO before send.
function buildOfficerReplyMessages(opts) {
  opts = opts || {};
  var gpName = cleanString(opts.gpName || '', 120) || 'the applicant';
  var itemTitle = cleanString(opts.itemTitle || '', 200) || 'the requested document';
  var requirement = cleanString(opts.requirement || '', 3000);
  var reference = cleanString(opts.reference || '', 60);
  var officerName = cleanString(opts.officerName || '', 120);
  var system = [
    'You draft a short, professional email FROM a GP registration support team TO an AHPRA officer,',
    'replying to the officer\'s "provide further information" notice and attaching ONE requested document.',
    'Plain, courteous, concise (3-5 sentences). No markdown. Do not invent facts. Sign off as',
    '"The GP Link Registration Support Team". Output ONLY the email body text (no subject line).'
  ].join(' ');
  var userText = [
    'Reply to the AHPRA officer' + (officerName ? ' (' + officerName + ')' : '') + '.',
    'Applicant: Dr ' + gpName + '.',
    (reference ? 'AHPRA reference: ' + reference + '.' : ''),
    'The attached document is: ' + itemTitle + '.',
    (requirement ? 'It was requested as: ' + requirement : ''),
    'Write the email body confirming the attached ' + itemTitle + ' is provided for this application, and inviting the officer to advise if anything further is needed.'
  ].filter(Boolean).join('\n');
  return { system: system, userText: userText };
}

// ── Practice request email (owner 'practice' / mode 'practice_upload') ─────────

// Deterministic fail-open template for the email the team sends the practice asking for the
// document. Plain text; the server turns it into the composer's HTML. No em dashes: a practice
// manager reads this.
function buildPracticeRequestDraft(opts) {
  opts = opts || {};
  var gpName = cleanString(opts.gpName || '', 120) || 'the doctor';
  var contactName = cleanString(opts.contactName || '', 120);
  var itemTitle = cleanString(opts.itemTitle || '', 200) || 'the requested document';
  var ask = cleanString(opts.practiceInstructions || '', 4000);
  var reference = cleanString(opts.reference || '', 60);
  var deadline = cleanString(opts.deadline || '', 40);
  var senderName = cleanString(opts.senderName || '', 120) || 'The GP Link Registration Team';
  var subject = itemTitle + ' needed for Dr ' + gpName + ' (AHPRA request' + (reference ? ' ' + reference : '') + ')';
  var lines = [];
  lines.push('Hi ' + (contactName || 'there') + ',');
  lines.push('');
  lines.push('AHPRA has come back to us on Dr ' + gpName + "'s registration application and needs one more thing from the practice: " + itemTitle + '.');
  lines.push('');
  if (ask) { lines.push(ask); lines.push(''); }
  lines.push('Could you please reply to this email with the document attached' + (deadline ? ' by ' + deadline : ' at your earliest convenience') + '? We will check it and send it on to AHPRA for you.');
  lines.push('');
  lines.push('Thank you for your help.');
  lines.push('');
  lines.push('Kind regards,');
  lines.push(senderName);
  return { subject: subject, body: lines.join('\n') };
}

// AI prompt (SUGGEST_REPLY_MODEL) for the same email — richer, still edited by the RSO before send.
function buildPracticeRequestMessages(opts) {
  opts = opts || {};
  var gpName = cleanString(opts.gpName || '', 120) || 'the doctor';
  var contactName = cleanString(opts.contactName || '', 120);
  var practiceName = cleanString(opts.practiceName || '', 200);
  var itemTitle = cleanString(opts.itemTitle || '', 200) || 'the requested document';
  var requirement = cleanString(opts.requirement || '', 3000);
  var ask = cleanString(opts.practiceInstructions || '', 3000);
  var reference = cleanString(opts.reference || '', 60);
  var deadline = cleanString(opts.deadline || '', 40);
  var senderName = cleanString(opts.senderName || '', 120) || 'The GP Link Registration Team';
  var system = [
    'You draft a short, warm, professional email FROM a GP recruitment agency\'s registration support team TO the',
    'practice manager of the clinic where a doctor is going to work. AHPRA (the Australian medical regulator) has',
    'asked for a document that only the practice can provide, and the email asks the practice to send it back by',
    'replying with it attached. Plain English, no jargon, no markdown, no em dashes, 4-7 short sentences.',
    'Say exactly which document is needed and, in one sentence, why AHPRA needs it. Never quote the regulator\'s',
    'legal wording and never blame anyone. Do not invent facts or dates. Sign off with the sender name given.',
    'Output ONLY the email body text (no subject line).'
  ].join(' ');
  var userText = [
    'Write to ' + (contactName ? contactName : 'the practice manager') + (practiceName ? ' at ' + practiceName : '') + '.',
    'Doctor: Dr ' + gpName + '.',
    (reference ? 'AHPRA reference: ' + reference + '.' : ''),
    'Document needed from the practice: ' + itemTitle + '.',
    (ask ? 'What we need them to do: ' + ask : ''),
    (requirement ? 'What AHPRA actually wrote (for your understanding only, do not quote it): ' + requirement : ''),
    (deadline ? 'AHPRA deadline: ' + deadline + ' (ask for it a few days before).' : ''),
    'Ask them to reply to this email with the document attached, and say we will check it and forward it to AHPRA.',
    'Sign off as: ' + senderName
  ].filter(Boolean).join('\n');
  return { system: system, userText: userText };
}

// ── Recognising the practice's document when it arrives by email ─────────────
//
// The practice does not reliably reply on our request thread: they email the updated CV as a
// fresh message, from the practice manager rather than the contact we wrote to, or the doctor
// forwards it. The server gathers the open practice items, the usable attachments, the AI's
// verdict for each (item, attachment) pair and how well we know the sender; this pure function
// makes the call so it can be tested without Gmail or the model.

// A surname-ish hint from an item title such as "Supervisor CV clarification/resubmission (Dr
// Ranatunga)" or "Updated CV for Dr Jane Smith" — lower-cased tokens of 4+ letters that follow a
// title (Dr/Prof/Mr/Ms), so a filename like "Ranatunga_CV_2026.pdf" can be matched cheaply.
function titleNameHints(title) {
  var out = [];
  var re = /\b(?:dr|doctor|prof(?:essor)?|mr|mrs|ms|miss)\.?\s+([a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+){0,2})/gi;
  var m;
  while ((m = re.exec(String(title || ''))) !== null) {
    m[1].split(/\s+/).forEach(function (w) {
      var t = w.replace(/[^a-z]/gi, '').toLowerCase();
      if (t.length >= 4 && out.indexOf(t) === -1) out.push(t);
    });
  }
  return out;
}

function filenameMatchesHints(filename, hints) {
  var f = String(filename || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!f || !hints || !hints.length) return false;
  for (var i = 0; i < hints.length; i++) if (f.indexOf(hints[i]) !== -1) return true;
  return false;
}

// opts: {
//   items:       [{id, title}]                              open practice items (one case)
//   attachments: [{index, filename, mimeType}]              usable attachments (pdf/image/docx)
//   verdicts:    {"<itemId>|<index>": {verdict, summary}}   from the AI check (may be missing)
//   senderTrust: 'requested' (the address we emailed) | 'contact' (the practice contact on file)
//                | 'affiliated' (practice domain / brought in on our thread) | 'candidate' | 'unknown'
// }
// Returns {itemId, attachmentIndex, reason} or null. Reasons, strongest first:
//   ai_match          the AI says this file satisfies the item
//   filename          the file is named after the person the item is about, and the AI did not object
//   single_candidate  we wrote to this sender for exactly one thing and they sent exactly one file
function decidePracticeUploadMatch(opts) {
  opts = opts || {};
  var items = Array.isArray(opts.items) ? opts.items : [];
  var atts = Array.isArray(opts.attachments) ? opts.attachments : [];
  var verdicts = opts.verdicts || {};
  var trust = String(opts.senderTrust || 'unknown');
  if (!items.length || !atts.length || trust === 'unknown') return null;
  function v(item, att) { var k = item.id + '|' + att.index; return (verdicts[k] && verdicts[k].verdict) || 'unchecked'; }
  var i, a, item, att;
  // 1. The AI recognised the document. Prefer a pair where the filename agrees too.
  var aiHits = [];
  for (i = 0; i < items.length; i++) for (a = 0; a < atts.length; a++) {
    if (v(items[i], atts[a]) === 'match') aiHits.push({ item: items[i], att: atts[a], named: filenameMatchesHints(atts[a].filename, titleNameHints(items[i].title)) });
  }
  if (aiHits.length) {
    aiHits.sort(function (x, y) { return (y.named ? 1 : 0) - (x.named ? 1 : 0); });
    return { itemId: aiHits[0].item.id, attachmentIndex: aiHits[0].att.index, reason: 'ai_match' };
  }
  // 2. Named after the person the item is about, and the AI did not flag it as the wrong document.
  for (i = 0; i < items.length; i++) {
    var hints = titleNameHints(items[i].title);
    if (!hints.length) continue;
    for (a = 0; a < atts.length; a++) {
      if (filenameMatchesHints(atts[a].filename, hints) && v(items[i], atts[a]) !== 'possible_issue') {
        return { itemId: items[i].id, attachmentIndex: atts[a].index, reason: 'filename' };
      }
    }
  }
  // 3. We asked this very sender for exactly one document and they sent exactly one file.
  if ((trust === 'requested' || trust === 'contact') && items.length === 1 && atts.length === 1 && v(items[0], atts[0]) !== 'possible_issue') {
    return { itemId: items[0].id, attachmentIndex: atts[0].index, reason: 'single_candidate' };
  }
  return null;
}

module.exports = {
  S80_OWNERS: S80_OWNERS,
  S80_MODES: S80_MODES,
  S80_OWNER_LABELS: S80_OWNER_LABELS,
  titleNameHints: titleNameHints,
  filenameMatchesHints: filenameMatchesHints,
  decidePracticeUploadMatch: decidePracticeUploadMatch,
  S80_MODE_LABELS: S80_MODE_LABELS,
  ownerForMode: ownerForMode,
  isGpMode: isGpMode,
  applyRouting: applyRouting,
  ensureInstructions: ensureInstructions,
  dashesToSentences: dashesToSentences,
  isPracticeDocumentItem: isPracticeDocumentItem,
  deliverableSignature: deliverableSignature,
  mergeDuplicateItems: mergeDuplicateItems,
  buildPracticeRequestDraft: buildPracticeRequestDraft,
  buildPracticeRequestMessages: buildPracticeRequestMessages,
  DEFAULT_REPLY_SUBJECT: DEFAULT_REPLY_SUBJECT,
  EXTRACTION_SYSTEM: EXTRACTION_SYSTEM,
  buildExtractionPrompt: buildExtractionPrompt,
  parseExtractionText: parseExtractionText,
  isRealDate: isRealDate,
  applyOfficerEmail: applyOfficerEmail,
  officerLabel: officerLabel,
  normalizeItem: normalizeItem,
  normalizeExtraction: normalizeExtraction,
  isSubmissionInfoItem: isSubmissionInfoItem,
  isStatutoryDeclarationItem: isStatutoryDeclarationItem,
  isTrainingConfirmationItem: isTrainingConfirmationItem,
  stripStatutoryDeclarationSentences: stripStatutoryDeclarationSentences,
  removeStatutoryDeclarationOption: removeStatutoryDeclarationOption,
  detectReference: detectReference,
  shortDescription: shortDescription,
  buildCombinedReplyDraft: buildCombinedReplyDraft,
  resolveReplyOfficer: resolveReplyOfficer,
  buildOfficerReplyDraft: buildOfficerReplyDraft,
  buildOfficerReplyMessages: buildOfficerReplyMessages,
  docGuides: docGuides
};
