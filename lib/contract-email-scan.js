'use strict';

// Signed-contract email scan (CEO Overview "Pipeline & money" board, 26 Nov 2026).
//
// The owner signs deals outside the app — the contract is emailed back and
// forth. Once an hour this module does a NARROW, READ-ONLY Gmail search of one
// mailbox (CONTRACT_SCAN_MAILBOX, default hello@mygplink.com.au — the master
// archive), asks the model whether each new message is a SIGNED doctor–practice
// contract, and proposes the confident ones on the board (pipeline_people,
// stage 'signed', needs_confirm). The owner confirms with one click; confirming
// creates the placement through the app's own placement path (injected).
//
// HARD RULES (see memory hello-inbox-never-watched):
//  - never registers a Gmail watch, never modifies a message, never sends;
//    only users.messages.list / messages.get / messages.attachments.get;
//  - never creates registration_tasks / incoming_email_todos (or any other
//    table outside WRITABLE_TABLES — enforced by guardedWrite below);
//  - the NEVER_PROCESS_EMAILS guard in server.js is untouched: that guard
//    governs watches + triage, and this job does neither.
//
// Everything that talks to the outside world is injected (Supabase request
// function, Gmail client, model call, PDF text reader, email parser), so the
// whole flow is testable without network.

var WRITABLE_TABLES = ['email_contract_finds', 'pipeline_people', 'pipeline_events', 'pipeline_sync_state'];
var DEFAULT_MAILBOX = 'hello@mygplink.com.au';
var SYNC_SOURCE = 'email_scan';
var CONFIDENCE_THRESHOLD = 0.7;
var CLASSIFY_CAP = 40;          // model calls per run
var LIST_CAP = 200;             // message ids looked at per run (dedupe is free)
var LOOKBACK_DAYS = 14;         // first run, before any cursor exists
var CURSOR_OVERLAP_MS = 2 * 86400000;
var BODY_CHAR_CAP = 6000;
var PDF_TEXT_CHAR_CAP = 4000;
var PDF_BYTES_CAP = 1024 * 1024;
var DAY_MS = 86400000;

// Senders that are never a doctor–practice contract. DocuSign MARKETING comes
// from docusign.com; real envelopes ("Completed: …") come from docusign.net and
// are kept. GP Link's own transactional mailer is excluded, but our people's
// mailboxes are NOT — "Dr. Win has informed us that he sent the signed contract
// back to you" is written by GP Link and is exactly what we want to find.
var NOISE_SENDERS = [
  'xero.com', 'post.xero.com', 'gocardless.com', 'zoho.com', 'zohocorp.com', 'docusign.com',
  'stripe.com', 'paypal.com', 'google.com', 'vercel.com', 'anthropic.com', 'zoom.us',
  'calendly.com', 'mailchimp.com', 'hubspot.com', 'canva.com', 'linkedin.com',
  'facebookmail.com', 'ahpra.gov.au', 'notifications@mygplink.com.au'
];
var DEFAULT_BASE_QUERY = '{has:attachment "signed contract" "signed agreement" "signed the contract" "signed the agreement" "officially yours"}'
  + ' (contract OR agreement OR "service agreement" OR signed OR executed)'
  + ' -category:promotions -category:social'
  + ' -from:(' + NOISE_SENDERS.join(' OR ') + ')';

// ── Small helpers ───────────────────────────────────────────────
function str(v) { return v == null ? '' : String(v); }
function rowsOf(r) { return (r && r.ok && Array.isArray(r.data)) ? r.data : []; }
function toMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  var t = Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function inList(values) {
  return '(' + values.map(function (v) { return '"' + String(v).replace(/["\\]/g, '') + '"'; }).join(',') + ')';
}
function chunk(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function normaliseDoctorName(name) {
  return str(name).toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z\u00c0-\u024f'\s-]/g, ' ')
    .replace(/[-']/g, ' ')
    .split(/\s+/).filter(Boolean)
    .filter(function (w, i) { return !(i === 0 && (w === 'dr' || w === 'doctor' || w === 'prof' || w === 'professor')); })
    .filter(function (w) { return ['mr', 'mrs', 'ms', 'miss', 'mbbs', 'mrcgp', 'fracgp', 'md'].indexOf(w) < 0; })
    .join(' ');
}
var PRACTICE_FILLER = ['the', 'medical', 'centre', 'center', 'clinic', 'practice', 'family', 'health', 'healthcare', 'surgery', 'group', 'gp', 'general', 'pty', 'ltd', 'and', 'of'];
function normalisePracticeName(name) {
  var words = str(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  var core = words.filter(function (w) { return PRACTICE_FILLER.indexOf(w) < 0; });
  return (core.length ? core : words).join(' ');
}
function practiceNamesMatch(a, b) {
  var x = normalisePracticeName(a), y = normalisePracticeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "deception bay" vs "deception bay north" — whole-word containment only.
  var px = ' ' + x + ' ', py = ' ' + y + ' ';
  return (x.length >= 5 && py.indexOf(px) >= 0) || (y.length >= 5 && px.indexOf(py) >= 0);
}
// Doctor names: exact normalised match, else first + last word match
// ("Yan Naing Win" vs profile "Yan" / "Win").
function doctorNamesMatch(a, b) {
  var x = normaliseDoctorName(a), y = normaliseDoctorName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  var xs = x.split(' '), ys = y.split(' ');
  if (xs.length < 2 || ys.length < 2) return false;
  return xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

// Writes are only ever allowed to the four board tables. A bug that tried to
// write anywhere else (registration_tasks, incoming_email_todos …) throws.
function guardedWrite(sb, table, query, opts) {
  if (WRITABLE_TABLES.indexOf(table) < 0) {
    throw new Error('contract-email-scan may not write to ' + table);
  }
  return sb(table, query, opts);
}

// ── Gmail query ─────────────────────────────────────────────────
// First run: newer_than:14d. Afterwards: after:<cursor − 2 days> (unix secs).
function buildScanQuery(opts) {
  var o = opts || {};
  var base = str(o.baseQuery).trim() || DEFAULT_BASE_QUERY;
  var cursorMs = toMs(o.cursorAt);
  var dateTerm = Number.isFinite(cursorMs)
    ? 'after:' + Math.floor((cursorMs - CURSOR_OVERLAP_MS) / 1000)
    : 'newer_than:' + LOOKBACK_DAYS + 'd';
  return dateTerm + ' ' + base;
}

// ── Model prompt + parsing ──────────────────────────────────────
var CLASSIFIER_SYSTEM = [
  'You check emails in the inbox of GP Link, an Australian GP recruitment agency that places overseas doctors (GPs) with Australian medical practices.',
  'Decide whether the email shows that a doctor–practice employment or services agreement has been SIGNED by at least the doctor.',
  'Counts as signed: "please find attached signed contract"; a returned signed contract/agreement PDF; a practice or GP Link confirming the doctor signed and sent the contract back; "the position is now officially yours" together with a completed agreement; a DocuSign/e-sign "Completed" notice for a doctor–practice agreement.',
  'Does NOT count: drafts, unsigned offers or contracts sent for signature, letters of offer awaiting signature, agreements between a practice and GP Link (recruitment/service-fee agreements), invoices, receipts, AHPRA forms, SPPA forms, visa or Medicare paperwork, newsletters, marketing.',
  'Reply with ONLY a JSON object, no prose, with exactly these keys:',
  '{"is_signed_placement_contract": true|false, "confidence": number 0-1, "doctor_name": string|null (the doctor, without "Dr"), "practice_name": string|null, "signed_date": "YYYY-MM-DD"|null, "evidence": string|null (a short quote from the email, at most 20 words), "why": string (one sentence)}'
].join('\n');

function buildClassifierInput(meta, extra) {
  var m = meta || {};
  var e = extra || {};
  var lines = [
    'Subject: ' + str(m.subject).slice(0, 300),
    'From: ' + (m.senderName ? m.senderName + ' <' + str(m.sender) + '>' : str(m.sender)),
    'To: ' + str(m.to).slice(0, 500),
    m.cc ? 'Cc: ' + str(m.cc).slice(0, 500) : '',
    'Date: ' + str(e.dateIso || m.date),
    'Attachments: ' + ((m.attachments || []).map(function (a) { return a.filename; }).join(', ') || 'none'),
    '',
    'Email text:',
    str(m.bodyText).slice(0, BODY_CHAR_CAP)
  ].filter(function (l, i) { return l !== '' || i > 5; });
  if (e.pdfText) {
    lines.push('', 'Text extracted from attachment "' + str(e.pdfName) + '" (may be partial):', str(e.pdfText).slice(0, PDF_TEXT_CHAR_CAP));
  }
  return lines.join('\n');
}

function clamp01(n) { n = Number(n); if (!Number.isFinite(n)) return 0; return Math.max(0, Math.min(1, n)); }
function cleanText(v, max) {
  var s = str(v).replace(/\s+/g, ' ').trim();
  if (!s || /^(null|none|unknown|n\/a)$/i.test(s)) return null;
  return s.slice(0, max || 200);
}
// Returns a normalised classification, or null when the reply is not usable JSON.
function parseClassification(text) {
  var raw = str(text).trim();
  if (!raw) return null;
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  var start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  var obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || typeof obj.is_signed_placement_contract !== 'boolean') return null;
  var signed = /^\d{4}-\d{2}-\d{2}$/.test(str(obj.signed_date).trim()) && Number.isFinite(Date.parse(str(obj.signed_date).trim()))
    ? str(obj.signed_date).trim() : null;
  var evidence = cleanText(obj.evidence, 400);
  if (evidence) evidence = evidence.split(' ').slice(0, 20).join(' ');
  var doctor = cleanText(obj.doctor_name, 120);
  if (doctor) doctor = doctor.replace(/^(dr\.?|doctor)\s+/i, '').trim() || null;
  return {
    is_signed_placement_contract: obj.is_signed_placement_contract,
    confidence: clamp01(obj.confidence),
    doctor_name: doctor,
    practice_name: cleanText(obj.practice_name, 160),
    signed_date: signed,
    evidence: evidence,
    why: cleanText(obj.why, 400) || ''
  };
}
function isProposable(c) {
  return !!(c && c.is_signed_placement_contract === true && c.confidence >= CONFIDENCE_THRESHOLD && c.doctor_name);
}
function summariseClassification(c) {
  if (!c) return 'The model reply could not be read.';
  var head = c.is_signed_placement_contract ? 'Signed contract' : 'Not a signed contract';
  return (head + ' (confidence ' + c.confidence.toFixed(2) + ')' + (c.why ? ': ' + c.why : '') + (c.evidence ? ' — "' + c.evidence + '"' : '')).slice(0, 1000);
}

// Raw Messages API call (the app's convention: fetch + pinned model id from
// env; no `temperature` — Opus 4.7+/Sonnet 5 reject it).
function createAnthropicClassifier(cfg) {
  var c = cfg || {};
  var doFetch = c.fetch || (typeof fetch === 'function' ? fetch : null);
  return async function classify(userText) {
    if (!c.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    if (!doFetch) throw new Error('fetch unavailable');
    if (c.checkBudget && !(await c.checkBudget())) throw new Error('Daily AI budget reached');
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, c.timeoutMs || 45000);
    try {
      var res = await doFetch(c.url || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: c.model,
          max_tokens: 600,
          thinking: { type: 'disabled' },
          system: CLASSIFIER_SYSTEM,
          messages: [{ role: 'user', content: userText }]
        })
      });
      var data = await res.json();
      if (data && data.usage && c.recordSpend) {
        try { c.recordSpend(data.usage.input_tokens || 0, data.usage.output_tokens || 0, data.usage.cache_read_input_tokens || 0, data.usage.cache_creation_input_tokens || 0); } catch (e) { /* spend tracking never fails a scan */ }
      }
      if (!res.ok || (data && data.error)) {
        throw new Error('AI service error: ' + ((data && data.error && data.error.message) || ('HTTP ' + res.status)));
      }
      if (data && data.stop_reason === 'refusal') return '';
      var block = (data && Array.isArray(data.content)) ? data.content.find(function (b) { return b && b.type === 'text'; }) : null;
      return block ? str(block.text) : '';
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Gmail reads (read-only) ─────────────────────────────────────
async function listMessageIds(gmail, q, cap) {
  var ids = [];
  var pageToken;
  for (var page = 0; page < 10 && ids.length < cap; page++) {
    var params = { userId: 'me', q: q, maxResults: Math.min(100, cap - ids.length) };
    if (pageToken) params.pageToken = pageToken;
    var res = await gmail.users.messages.list(params);
    var data = (res && res.data) || {};
    (data.messages || []).forEach(function (m) { if (m && m.id) ids.push({ id: m.id, threadId: m.threadId || '' }); });
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}
function pickContractPdf(attachments) {
  var pdfs = (attachments || []).filter(function (a) {
    return a && a.attachmentId && (/pdf/i.test(str(a.mimeType)) || /\.pdf$/i.test(str(a.filename))) && (Number(a.size) || 0) <= PDF_BYTES_CAP;
  });
  return pdfs.find(function (a) { return /contract|agreement|signed|executed/i.test(str(a.filename)); }) || pdfs[0] || null;
}
async function readPdfText(gmail, messageId, att, extractPdfText) {
  if (!att || !extractPdfText) return '';
  try {
    var res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: messageId, id: att.attachmentId });
    var b64 = res && res.data && res.data.data;
    if (!b64) return '';
    var buf = Buffer.from(String(b64).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!buf.length || buf.length > PDF_BYTES_CAP) return '';
    return str(extractPdfText(buf)).replace(/\s+/g, ' ').trim();
  } catch (e) {
    return '';
  }
}

// ── Board rows ──────────────────────────────────────────────────
function displayDate(dateStr) {
  var t = toMs(dateStr);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' }).format(new Date(t));
}
function buildPipelinePersonRow(find, cls, extra) {
  var e = extra || {};
  var when = displayDate(cls.signed_date || find.message_date) || 'date unknown';
  return {
    name: cls.doctor_name,
    practice_name: cls.practice_name || null,
    stage: 'signed',
    source: 'email_contract',
    source_ref: find.gmail_message_id,
    needs_confirm: true,
    user_id: e.userId || null,
    status_note: 'Signed contract found in email (' + when + ')',
    next_step: 'Confirm the placement',
    metadata: {
      gmail_message_id: find.gmail_message_id,
      thread_id: find.thread_id || null,
      evidence: cls.evidence || null,
      subject: find.subject || null,
      signed_date: cls.signed_date || null,
      confidence: cls.confidence
    }
  };
}

// Reference data loaded once per run, only when a confident find needs it.
async function loadMatchContext(sb) {
  var profiles = rowsOf(await sb('user_profiles', 'select=user_id,first_name,last_name,email&limit=5000'));
  var people = rowsOf(await sb('pipeline_people', 'select=id,name,practice_name,user_id,stage,source,source_ref,needs_confirm,metadata,archived_at&archived_at=is.null&limit=5000'));
  return { profiles: profiles, people: people };
}
function matchProfiles(ctx, doctorName) {
  return (ctx.profiles || []).filter(function (p) {
    return doctorNamesMatch([p.first_name, p.last_name].filter(Boolean).join(' '), doctorName);
  });
}
function matchPeople(ctx, doctorName) {
  return (ctx.people || []).filter(function (p) { return doctorNamesMatch(p.name, doctorName); });
}

// Is this doctor (app account) already placed at this practice in the app?
async function isAlreadyPlaced(sb, userId, practiceName) {
  if (!userId || !practiceName) return false;
  var placements = rowsOf(await sb('placements', 'select=id,practice_name,status&user_id=eq.' + encodeURIComponent(userId) + '&limit=50'));
  if (placements.some(function (p) { return str(p.status).toLowerCase() !== 'cancelled' && practiceNamesMatch(p.practice_name, practiceName); })) return true;
  var apps = rowsOf(await sb('gp_applications', 'select=id,status,ats_stage,career_role_id&user_id=eq.' + encodeURIComponent(userId) + '&limit=200'))
    .filter(function (a) { return str(a.status).toLowerCase() === 'placement_secured' || str(a.ats_stage).toLowerCase() === 'hired'; });
  var roleIds = apps.map(function (a) { return a.career_role_id; }).filter(Boolean);
  if (!roleIds.length) return false;
  var roles = rowsOf(await sb('career_roles', 'select=id,practice_name&id=in.' + encodeURIComponent(inList(roleIds)) + '&limit=200'));
  return roles.some(function (r) { return practiceNamesMatch(r.practice_name, practiceName); });
}

async function insertFind(sb, row) {
  return guardedWrite(sb, 'email_contract_finds', 'on_conflict=gmail_message_id', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: [row]
  });
}

// Create (or, for someone already on the board, update) the board row.
// pipeline_people's unique index is PARTIAL, so PostgREST on_conflict cannot
// target it — select first, then insert or patch.
async function upsertProposedPerson(sb, ctx, find, cls, userId) {
  var row = buildPipelinePersonRow(find, cls, { userId: userId });
  var bySource = rowsOf(await sb('pipeline_people', 'select=id,metadata,practice_name,user_id&source=eq.email_contract&source_ref=eq.' + encodeURIComponent(find.gmail_message_id) + '&limit=1'))[0];
  var existing = bySource || matchPeople(ctx, cls.doctor_name)[0] || null;
  if (existing) {
    var patch = {
      stage: 'signed', needs_confirm: true, status_note: row.status_note, next_step: row.next_step,
      metadata: Object.assign({}, existing.metadata || {}, { email_contract: row.metadata, gmail_message_id: find.gmail_message_id })
    };
    if (row.practice_name && !existing.practice_name) patch.practice_name = row.practice_name;
    if (userId && !existing.user_id) patch.user_id = userId;
    await guardedWrite(sb, 'pipeline_people', 'id=eq.' + encodeURIComponent(existing.id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: patch });
    return existing.id;
  }
  var ins = await guardedWrite(sb, 'pipeline_people', '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [row] });
  var created = rowsOf(ins)[0] || null;
  if (created) ctx.people.push(Object.assign({}, row, { id: created.id }));
  return created ? created.id : null;
}

async function readSyncState(sb) {
  return rowsOf(await sb('pipeline_sync_state', 'select=*&source=eq.' + SYNC_SOURCE + '&limit=1'))[0] || null;
}
async function writeSyncState(sb, patch) {
  return guardedWrite(sb, 'pipeline_sync_state', 'on_conflict=source', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [Object.assign({ source: SYNC_SOURCE }, patch)]
  });
}

// ── The hourly scan ─────────────────────────────────────────────
// deps: { sb, gmail, mailbox, classify, extractEmailMeta, extractPdfText,
//         baseQuery, nowMs, timeBudgetMs, log }
async function runContractEmailScan(deps) {
  var d = deps || {};
  var sb = d.sb;
  var nowMs = Number.isFinite(d.nowMs) ? d.nowMs : Date.now();
  var startMs = Date.now();
  var budget = d.timeBudgetMs || 240000;
  var mailbox = str(d.mailbox).trim().toLowerCase() || DEFAULT_MAILBOX;
  var log = d.log || function () {};
  var nowIso = new Date(nowMs).toISOString();
  var detail = { mailbox: mailbox, listed: 0, already_seen: 0, scanned: 0, proposed: 0, ignored: 0, errors: 0, backlog: 0 };

  var prev = null;
  try { prev = await readSyncState(sb); } catch (e) { prev = null; }
  var prevDetail = (prev && prev.detail && typeof prev.detail === 'object') ? prev.detail : {};
  var cursorAt = prevDetail.scan_cursor || (prev && prev.last_ok_at) || null;
  try { await writeSyncState(sb, { last_run_at: nowIso }); } catch (e) { /* freshness only */ }

  try {
    if (!d.gmail) throw new Error('Gmail is not connected for ' + mailbox + ' (service account not configured or not authorised).');
    if (typeof d.classify !== 'function') throw new Error('No classifier configured.');
    var q = buildScanQuery({ cursorAt: cursorAt, baseQuery: d.baseQuery });
    detail.query = q;
    var listed = await listMessageIds(d.gmail, q, LIST_CAP);
    detail.listed = listed.length;

    // Dedupe against finds already recorded (any status) — never re-classify.
    var seen = new Set();
    var idChunks = chunk(listed.map(function (m) { return m.id; }), 50);
    for (var ci = 0; ci < idChunks.length; ci++) {
      var r = await sb('email_contract_finds', 'select=gmail_message_id&gmail_message_id=in.' + encodeURIComponent(inList(idChunks[ci])));
      if (!r || !r.ok) throw new Error('Could not read email_contract_finds (dedupe).');
      rowsOf(r).forEach(function (f) { seen.add(String(f.gmail_message_id)); });
    }
    var fresh = listed.filter(function (m) { return !seen.has(m.id); });
    detail.already_seen = listed.length - fresh.length;
    var todo = fresh.slice(0, CLASSIFY_CAP);
    var ctx = null;

    for (var i = 0; i < todo.length; i++) {
      if (Date.now() - startMs > budget) break;
      var ref = todo[i];
      try {
        var got = await d.gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
        var msg = (got && got.data) || {};
        var meta = d.extractEmailMeta(msg);
        var msgMs = Number(msg.internalDate) || toMs(meta.date);
        var dateIso = Number.isFinite(msgMs) ? new Date(msgMs).toISOString() : null;
        var pdf = pickContractPdf(meta.attachments);
        var pdfText = pdf ? await readPdfText(d.gmail, ref.id, pdf, d.extractPdfText) : '';
        var replyText = await d.classify(buildClassifierInput(meta, { dateIso: dateIso, pdfText: pdfText, pdfName: pdf && pdf.filename }));
        detail.scanned++;
        var cls = parseClassification(replyText);
        var find = {
          gmail_message_id: ref.id,
          thread_id: meta.threadId || ref.threadId || null,
          mailbox: mailbox,
          subject: str(meta.subject).slice(0, 500) || null,
          from_email: str(meta.sender).toLowerCase().slice(0, 320) || null,
          message_date: dateIso,
          doctor_name: cls ? cls.doctor_name : null,
          practice_name: cls ? cls.practice_name : null,
          signed_date: cls ? cls.signed_date : null,
          confidence: cls ? cls.confidence : null,
          ai_summary: summariseClassification(cls),
          status: 'ignored'
        };
        if (!isProposable(cls)) {
          await insertFind(sb, find);
          detail.ignored++;
          continue;
        }
        if (!ctx) ctx = await loadMatchContext(sb);
        var profileHits = matchProfiles(ctx, cls.doctor_name);
        var userId = profileHits.length === 1 ? profileHits[0].user_id : null;
        var personHits = matchPeople(ctx, cls.doctor_name);
        if (!userId) {
          var linked = personHits.find(function (p) { return p.user_id; });
          if (linked) userId = linked.user_id;
        }
        if (userId && await isAlreadyPlaced(sb, userId, cls.practice_name)) {
          find.ai_summary = ('Already in the app: ' + cls.doctor_name + ' is already placed at ' + cls.practice_name + '. ' + find.ai_summary).slice(0, 1000);
          await insertFind(sb, find);
          detail.ignored++;
          continue;
        }
        // Same deal already proposed or confirmed from another message
        // (a thread usually carries several "signed" emails).
        var dupe = personHits.find(function (p) {
          return str(p.stage) === 'signed' && p.metadata && (p.metadata.gmail_message_id || p.metadata.email_contract)
            && (!cls.practice_name || !p.practice_name || practiceNamesMatch(p.practice_name, cls.practice_name));
        });
        if (dupe) {
          find.ai_summary = ('Already on the board from another email. ' + find.ai_summary).slice(0, 1000);
          find.pipeline_person_id = dupe.id;
          await insertFind(sb, find);
          detail.ignored++;
          continue;
        }
        find.status = 'proposed';
        await insertFind(sb, find);
        var personId = await upsertProposedPerson(sb, ctx, find, cls, userId);
        if (personId) {
          await guardedWrite(sb, 'email_contract_finds', 'gmail_message_id=eq.' + encodeURIComponent(ref.id), {
            method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { pipeline_person_id: personId }
          });
        }
        detail.proposed++;
      } catch (msgErr) {
        // Not recorded → retried next hour.
        detail.errors++;
        log('[contract-scan] message ' + ref.id + ' failed: ' + (msgErr && msgErr.message));
      }
    }
    detail.backlog = Math.max(0, fresh.length - (detail.scanned + detail.errors)) + (listed.length >= LIST_CAP ? 1 : 0);
    // The cursor only moves once nothing is left behind, so a backlog or a
    // failed message is picked up by the next run (after: = cursor − 2 days).
    detail.scan_cursor = (detail.backlog === 0 && detail.errors === 0) ? nowIso : (prevDetail.scan_cursor || null);
    await writeSyncState(sb, {
      last_run_at: nowIso, last_ok_at: nowIso,
      last_error: detail.errors ? (detail.errors + ' message(s) could not be checked; they will be retried.') : null,
      detail: detail
    });
    return { ok: true, detail: detail };
  } catch (err) {
    var message = str(err && err.message) || 'Scan failed';
    detail.scan_cursor = prevDetail.scan_cursor || null;
    try { await writeSyncState(sb, { last_run_at: nowIso, last_error: message.slice(0, 500), detail: detail }); } catch (e) { /* nothing more to do */ }
    log('[contract-scan] failed: ' + message);
    return { ok: false, error: message, detail: detail };
  }
}

// ── Confirm (one click on the board) ────────────────────────────
// deps: { sb, placeInApp(ctx) → {ok, placed, already, application_id, message}, actor, nowMs }
// Idempotent: confirming twice never duplicates the event or the placement; a
// second call after the doctor's account / the practice exists creates it.
async function confirmEmailFind(deps, gmailMessageId) {
  var d = deps || {};
  var sb = d.sb;
  var id = str(gmailMessageId).trim();
  var nowIso = new Date(Number.isFinite(d.nowMs) ? d.nowMs : Date.now()).toISOString();
  var actor = str(d.actor) || 'ceo';
  if (!id || !/^[A-Za-z0-9_-]{6,128}$/.test(id)) return { status: 400, body: { ok: false, message: 'That email reference is not valid.' } };
  var findRes = await sb('email_contract_finds', 'select=*&gmail_message_id=eq.' + encodeURIComponent(id) + '&limit=1');
  if (!findRes || !findRes.ok) return { status: 502, body: { ok: false, message: 'Could not read the email find. Please try again.' } };
  var find = rowsOf(findRes)[0];
  if (!find) return { status: 404, body: { ok: false, message: 'That email find was not found.' } };
  if (find.status === 'dismissed') return { status: 409, body: { ok: false, code: 'dismissed', message: 'This find was dismissed, so it cannot be confirmed.' } };
  var doctorName = find.doctor_name;
  if (!doctorName) return { status: 409, body: { ok: false, message: 'The email did not name a doctor, so there is nothing to confirm.' } };

  // The board row (create it now if the find was recorded without one).
  var person = null;
  if (find.pipeline_person_id) {
    person = rowsOf(await sb('pipeline_people', 'select=*&id=eq.' + encodeURIComponent(find.pipeline_person_id) + '&limit=1'))[0] || null;
  }
  if (!person) {
    person = rowsOf(await sb('pipeline_people', 'select=*&source=eq.email_contract&source_ref=eq.' + encodeURIComponent(id) + '&limit=1'))[0] || null;
  }
  if (!person) {
    var row = buildPipelinePersonRow(find, {
      doctor_name: doctorName, practice_name: find.practice_name, signed_date: find.signed_date,
      evidence: null, confidence: Number(find.confidence) || 0
    });
    var ins = await guardedWrite(sb, 'pipeline_people', '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [row] });
    person = rowsOf(ins)[0] || null;
    if (!person) return { status: 502, body: { ok: false, message: 'Could not add this doctor to the board. Please try again.' } };
  }

  var firstConfirm = find.status !== 'confirmed' || person.needs_confirm === true || !person.confirmed_at;
  if (firstConfirm) {
    await guardedWrite(sb, 'email_contract_finds', 'gmail_message_id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { status: 'confirmed', pipeline_person_id: person.id }
    });
    var personPatch = { needs_confirm: false, next_step: 'Placement confirmed' };
    if (!person.confirmed_at) personPatch.confirmed_at = nowIso;
    await guardedWrite(sb, 'pipeline_people', 'id=eq.' + encodeURIComponent(person.id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: personPatch });
    await guardedWrite(sb, 'pipeline_events', '', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: [{ person_id: person.id, kind: 'confirm', text: 'Confirmed signed contract from email' + (find.subject ? ' "' + str(find.subject).slice(0, 160) + '"' : ''), created_by: actor }]
    });
  }

  var meta = (person.metadata && typeof person.metadata === 'object') ? person.metadata : {};
  var practiceName = find.practice_name || person.practice_name || '';

  // Already placed by an earlier confirm.
  if (meta.placement_application_id && meta.placement_created_at) {
    return { status: 200, body: { ok: true, confirmed: true, placed: true, already: true, person_id: person.id, application_id: meta.placement_application_id, message: 'Confirmed. ' + doctorName + '\'s placement is already in the app.' } };
  }

  // Resolve the app account (linked first, then a unique name match) and the practice.
  var userId = person.user_id || null;
  var userProfile = null;
  if (!userId) {
    var profiles = rowsOf(await sb('user_profiles', 'select=user_id,first_name,last_name,email&limit=5000'))
      .filter(function (p) { return doctorNamesMatch([p.first_name, p.last_name].filter(Boolean).join(' '), doctorName); });
    if (profiles.length === 1) { userProfile = profiles[0]; userId = profiles[0].user_id; }
    else if (profiles.length > 1) {
      return { status: 200, body: { ok: true, confirmed: true, placed: false, retry: true, person_id: person.id,
        message: 'Confirmed on the board. More than one app account is called ' + doctorName + ', so no placement was created — link the right account on the board, then confirm again.' } };
    }
  }
  var practice = null;
  if (practiceName) {
    var practices = rowsOf(await sb('practices', 'select=*&limit=5000')).filter(function (p) { return practiceNamesMatch(p.name, practiceName); });
    var exact = practices.filter(function (p) { return normalisePracticeName(p.name) === normalisePracticeName(practiceName); });
    var pool = exact.length ? exact : practices;
    if (pool.length === 1) practice = pool[0];
    else if (pool.length > 1) {
      return { status: 200, body: { ok: true, confirmed: true, placed: false, retry: true, person_id: person.id,
        message: 'Confirmed on the board. More than one practice matches "' + practiceName + '", so no placement was created — tidy up Practices, then confirm again.' } };
    }
  }
  if (!userId || !practice) {
    var missing = [];
    if (!userId) missing.push(doctorName + ' has no app account');
    if (!practice) missing.push(practiceName ? (practiceName + ' isn\'t in Practices yet') : 'the email did not name the practice');
    return { status: 200, body: { ok: true, confirmed: true, placed: false, retry: true, person_id: person.id,
      message: 'Confirmed on the board. ' + missing.join(' and ') + ', so no placement was created — add them, then confirm again.' } };
  }
  if (userId !== person.user_id) {
    await guardedWrite(sb, 'pipeline_people', 'id=eq.' + encodeURIComponent(person.id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { user_id: userId } });
  }
  if (typeof d.placeInApp !== 'function') {
    return { status: 200, body: { ok: true, confirmed: true, placed: false, retry: true, person_id: person.id, message: 'Confirmed on the board. Placement creation is not available here.' } };
  }
  var placed;
  try {
    placed = await d.placeInApp({
      userId: userId, userEmail: userProfile ? userProfile.email : null, practice: practice, doctorName: doctorName,
      signedDate: find.signed_date || null, find: find, person: person, actor: actor,
      existingApplicationId: meta.placement_application_id || null
    });
  } catch (e) {
    placed = { ok: false, message: str(e && e.message) };
  }
  if (!placed || !placed.ok) {
    return { status: 200, body: { ok: true, confirmed: true, placed: false, retry: true, person_id: person.id,
      message: 'Confirmed on the board, but the placement could not be created' + (placed && placed.message ? ': ' + placed.message : '') + '. Try again.' } };
  }
  var newMeta = Object.assign({}, meta, { placement_application_id: placed.application_id || null, placement_created_at: nowIso });
  await guardedWrite(sb, 'pipeline_people', 'id=eq.' + encodeURIComponent(person.id), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: { metadata: newMeta, practice_name: practice.name || practiceName, next_step: 'Placement in the app' }
  });
  if (!placed.already) {
    await guardedWrite(sb, 'pipeline_events', '', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: [{ person_id: person.id, kind: 'note', text: 'Placement created in the app at ' + (practice.name || practiceName), created_by: actor }]
    });
  }
  return { status: 200, body: { ok: true, confirmed: true, placed: true, already: !!placed.already, person_id: person.id, application_id: placed.application_id || null,
    message: placed.already
      ? 'Confirmed. ' + doctorName + ' was already placed at ' + (practice.name || practiceName) + ' in the app.'
      : 'Confirmed. ' + doctorName + ' is now placed at ' + (practice.name || practiceName) + ' — the practice pack and placement emails have gone out.' } };
}

module.exports = {
  WRITABLE_TABLES: WRITABLE_TABLES,
  DEFAULT_MAILBOX: DEFAULT_MAILBOX,
  DEFAULT_BASE_QUERY: DEFAULT_BASE_QUERY,
  CONFIDENCE_THRESHOLD: CONFIDENCE_THRESHOLD,
  CLASSIFY_CAP: CLASSIFY_CAP,
  CLASSIFIER_SYSTEM: CLASSIFIER_SYSTEM,
  buildScanQuery: buildScanQuery,
  buildClassifierInput: buildClassifierInput,
  parseClassification: parseClassification,
  isProposable: isProposable,
  normaliseDoctorName: normaliseDoctorName,
  normalisePracticeName: normalisePracticeName,
  doctorNamesMatch: doctorNamesMatch,
  practiceNamesMatch: practiceNamesMatch,
  buildPipelinePersonRow: buildPipelinePersonRow,
  pickContractPdf: pickContractPdf,
  createAnthropicClassifier: createAnthropicClassifier,
  runContractEmailScan: runContractEmailScan,
  confirmEmailFind: confirmEmailFind,
  _guardedWrite: guardedWrite
};
