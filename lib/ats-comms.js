'use strict';

// ── ATS comms-engagement helpers ────────────────────────────────
// Pure pieces for the AI comms-engagement scan. The actual model
// call lives in server.js; everything here is deterministic and
// dependency-free so it can be unit-tested and reused on the client.

var THIRTY_DAYS_MS = 30 * 86400000;
var HOUR_MS = 3600000;
var MAX_ITEMS = 15;   // cap each prompt section to ~15 items
var MAX_CHARS = 240;  // cap each rendered message to ~240 chars

// ── Internal: timestamp coercion ────────────────────────────────
// Accepts an ISO string, a numeric epoch-ms string, or epoch ms.
// Returns NaN for anything unparseable so callers can skip it.
function toMs(at) {
  if (at === null || at === undefined) return NaN;
  if (typeof at === 'number') return Number.isFinite(at) ? at : NaN;
  if (typeof at === 'string') {
    var s = at.trim();
    if (s === '') return NaN;
    if (/^-?\d+$/.test(s)) { var n = Number(s); return Number.isFinite(n) ? n : NaN; }
    var t = new Date(s).getTime();
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
}

// ── Internal: string shaping for the prompt ─────────────────────
function collapseWhitespace(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function capChars(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function stringifyItem(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return collapseWhitespace(item);
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    var preferred = ['text', 'body', 'snippet', 'message', 'summary', 'subject'];
    for (var i = 0; i < preferred.length; i++) {
      var v = item[preferred[i]];
      if (typeof v === 'string' && v.trim()) return collapseWhitespace(v);
    }
    try { return collapseWhitespace(JSON.stringify(item)); }
    catch (e) { return ''; }
  }
  return '';
}

function renderSection(items) {
  if (!Array.isArray(items) || !items.length) return '(none on file)';
  var out = [];
  for (var i = 0; i < items.length && out.length < MAX_ITEMS; i++) {
    var txt = capChars(stringifyItem(items[i]), MAX_CHARS);
    if (!txt) continue;
    out.push((out.length + 1) + '. ' + txt);
  }
  return out.length ? out.join('\n') : '(none on file)';
}

// ── 1. Average reply latency (hours) ────────────────────────────
// Sort messages chronologically, then for each inbound reply that
// follows an outbound, record the gap from the most recent
// unanswered outbound. Returns the average gap in hours (1 dp), or
// null when no measurable outbound→inbound pair exists.
function computeReplyLatencyHrs(messages, opts) {
  opts = opts || {}; // reserved for future options
  if (!Array.isArray(messages)) return null;

  var ordered = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m) continue;
    var dir = m.direction;
    if (dir !== 'inbound' && dir !== 'outbound') continue;
    var ms = toMs(m.at);
    if (!Number.isFinite(ms)) continue;
    ordered.push({ direction: dir, ms: ms });
  }
  ordered.sort(function (a, b) { return a.ms - b.ms; });

  var pendingOut = null; // ms of the most recent outbound awaiting a reply
  var gaps = [];
  for (var j = 0; j < ordered.length; j++) {
    if (ordered[j].direction === 'outbound') {
      pendingOut = ordered[j].ms;
    } else if (pendingOut !== null && ordered[j].ms >= pendingOut) {
      gaps.push((ordered[j].ms - pendingOut) / HOUR_MS);
      pendingOut = null;
    }
  }

  if (!gaps.length) return null;
  var sum = 0;
  for (var k = 0; k < gaps.length; k++) sum += gaps[k];
  return Math.round((sum / gaps.length) * 10) / 10;
}

// ── 2. Message volume in the last 30 days ───────────────────────
function countMessages30d(messages, nowMs) {
  if (!Array.isArray(messages)) return 0;
  if (nowMs === null || nowMs === undefined) nowMs = Date.now();
  var cutoff = nowMs - THIRTY_DAYS_MS;
  var count = 0;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m) continue;
    var ms = toMs(m.at);
    if (!Number.isFinite(ms)) continue;
    if (ms >= cutoff && ms <= nowMs) count++;
  }
  return count;
}

// ── 3. Build the model prompt ───────────────────────────────────
function buildCommsPrompt(input) {
  input = input || {};
  var name = collapseWhitespace(input.candidateName || '') || 'this candidate';
  var lines = [];
  lines.push('You are assessing the communication engagement of ' + name + ', a doctor candidate in a medical recruitment pipeline.');
  lines.push('Review the message history below and judge how engaged and responsive the candidate is.');
  lines.push('');
  lines.push('--- WHATSAPP (inbound) ---');
  lines.push(renderSection(input.whatsappInbound));
  lines.push('');
  lines.push('--- EMAILS (outbound, full) ---');
  lines.push(renderSection(input.outboundEmails));
  lines.push('');
  lines.push('--- EMAIL SNIPPETS (inbound, metadata) ---');
  lines.push(renderSection(input.emailSnippets));
  lines.push('');
  lines.push('--- CALLS ---');
  lines.push(renderSection(input.calls));
  lines.push('');
  lines.push('Return STRICT JSON only (no prose, no code fences) with exactly these keys:');
  lines.push('{');
  lines.push('  "messages30d": <integer count of candidate messages in the last 30 days>,');
  lines.push('  "avgReplyHrs": <number average hours the candidate takes to reply, or null if unknown>,');
  lines.push('  "tone": "<short phrase describing the candidate tone>",');
  lines.push('  "engagementVal": <number 0..1 where 1 is highly engaged>,');
  lines.push('  "aiRead": "<2-3 sentence plain-English read on the candidate engagement>"');
  lines.push('}');
  return lines.join('\n');
}

// ── 4. Parse the model verdict ──────────────────────────────────
function safeVerdict() {
  return { messages30d: 0, avgReplyHrs: null, tone: 'No data', engagementVal: 0, aiRead: '' };
}

function toIntNonNeg(v) {
  var n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(v) {
  var n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function toTrimmedString(v, fallback) {
  if (v === null || v === undefined) return fallback;
  var s = String(v).trim();
  return s === '' ? fallback : s;
}

function parseCommsVerdict(aiText) {
  if (aiText === null || aiText === undefined) return safeVerdict();
  var text = String(aiText);
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return safeVerdict();

  var raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { return safeVerdict(); }
  if (!raw || typeof raw !== 'object') return safeVerdict();

  return {
    messages30d: toIntNonNeg(raw.messages30d),
    avgReplyHrs: toNumberOrNull(raw.avgReplyHrs),
    tone: toTrimmedString(raw.tone, 'No data'),
    engagementVal: clamp01(raw.engagementVal),
    aiRead: toTrimmedString(raw.aiRead, '')
  };
}

module.exports = {
  computeReplyLatencyHrs,
  countMessages30d,
  buildCommsPrompt,
  parseCommsVerdict
};
