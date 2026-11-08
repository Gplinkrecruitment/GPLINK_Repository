'use strict';

// lib/automation-actions.js — the changes the morning review may propose to
// the app's OWN automation (Hazel's calling rules, the chase sequence, the
// no-show sweep), and the executor that applies the ones the owner ticks.
//
// Owner, 8 Nov 2026, on the "In the app" to-do list: "i should be able to
// click and the ai implements the automation". Until then every one of these
// settings was a constant in lib/ or an environment variable, so a tick could
// only mark the item done. These LEVERS are the settings the app now reads at
// runtime (runtime_kv key 'automation_settings', loaded by the server and
// handed to lib/lead-calls setLeadCallRuntime, lib/consult-lead
// setConsultRuntime and the no-show sweep). The model may propose a new value
// for a lever and nothing else: there is no lever for Hazel's words, so a
// confused suggestion can never script her (the owner rejected scripted
// openings outright: it "would make the call not sound human").
//
// Pure: the server loads and stores the settings; applyChanges() returns the
// next settings and one result per change, in the shape the Meta changes use
// (lib/ads-actions), so the page draws both lists the same way.

const MIN_MS = 60000;

function clock(minutes) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(minutes) || 0)));
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function fmtMinutes(min) {
  const m = Math.round(Number(min) || 0);
  if (m >= 60 && m % 60 === 0) return (m / 60) + ' hour' + (m === 60 ? '' : 's');
  if (m >= 90) return (Math.round(m / 6) / 10) + ' hours';
  return m + ' minute' + (m === 1 ? '' : 's');
}

const GROUP_LABELS = { hazel: 'Hazel', chase: 'Chase sequence', noshow: 'No-show sweep' };

const LEVERS = [
  { key: 'hazel.first_call_delay_min', group: 'hazel', label: 'Hazel: first call after the form', type: 'minutes', min: 1, max: 60, def: 3,
    describe: function (a, b) { return 'Hazel rings a new lead ' + fmtMinutes(b) + ' after the form (was ' + fmtMinutes(a) + ').'; } },
  { key: 'hazel.max_attempts', group: 'hazel', label: 'Hazel: call attempts per lead', type: 'count', min: 1, max: 4, def: 2,
    describe: function (a, b) { return 'Hazel tries each lead up to ' + b + ' time' + (b === 1 ? '' : 's') + ' (was ' + a + ').'; } },
  { key: 'hazel.retry_after_min', group: 'hazel', label: 'Hazel: gap before a retry', type: 'minutes', min: 30, max: 1440, def: 180,
    describe: function (a, b) { return 'A missed call is retried after ' + fmtMinutes(b) + ' (was ' + fmtMinutes(a) + ').'; } },
  { key: 'hazel.vary_retry_time', group: 'hazel', label: 'Hazel: retry at a different time of day', type: 'bool', def: false,
    describe: function (a, b) { return b ? 'A retry waits for a different part of the day (morning, afternoon or evening) from the call that was missed.' : 'A retry rings as soon as the gap has passed, whatever the time of day.'; } },
  { key: 'hazel.weekday_start', group: 'hazel', label: 'Hazel: weekday calls from', type: 'clock', min: 6 * 60, max: 22 * 60, def: 9 * 60,
    describe: function (a, b) { return 'Weekday calls start at ' + clock(b) + ' in the lead\'s local time (was ' + clock(a) + ').'; } },
  { key: 'hazel.weekday_end', group: 'hazel', label: 'Hazel: weekday calls until', type: 'clock', min: 6 * 60, max: 22 * 60, def: 19 * 60 + 30,
    describe: function (a, b) { return 'Weekday calls stop at ' + clock(b) + ' in the lead\'s local time (was ' + clock(a) + ').'; } },
  { key: 'hazel.weekend_start', group: 'hazel', label: 'Hazel: weekend calls from', type: 'clock', min: 6 * 60, max: 22 * 60, def: 10 * 60,
    describe: function (a, b) { return 'Weekend calls start at ' + clock(b) + ' in the lead\'s local time (was ' + clock(a) + ').'; } },
  { key: 'hazel.weekend_end', group: 'hazel', label: 'Hazel: weekend calls until', type: 'clock', min: 6 * 60, max: 22 * 60, def: 18 * 60,
    describe: function (a, b) { return 'Weekend calls stop at ' + clock(b) + ' in the lead\'s local time (was ' + clock(a) + ').'; } },
  { key: 'hazel.text_after_missed_call', group: 'hazel', label: 'Hazel: booking link by WhatsApp after a missed call', type: 'bool', def: false,
    describe: function (a, b) { return b ? 'After a voicemail or no answer, the next unsent WhatsApp with the booking link goes out at once.' : 'A missed call sends nothing; the chase sequence runs on its own clock.'; } },
  { key: 'chase.step1_min', group: 'chase', label: 'Chase: first WhatsApp after the form', type: 'minutes', min: 1, max: 60, def: 5,
    describe: function (a, b) { return 'The first WhatsApp goes ' + fmtMinutes(b) + ' after the form (was ' + fmtMinutes(a) + ').'; } },
  { key: 'chase.step2_min', group: 'chase', label: 'Chase: second note (WhatsApp and email)', type: 'minutes', min: 30, max: 360, def: 60,
    describe: function (a, b) { return 'The second note (WhatsApp and email) goes ' + fmtMinutes(b) + ' after the form (was ' + fmtMinutes(a) + ').'; } },
  { key: 'chase.step3_hours', group: 'chase', label: 'Chase: day-after note', type: 'hours', min: 12, max: 72, def: 24,
    describe: function (a, b) { return 'The day-after note goes ' + b + ' hours after the form (was ' + a + ').'; } },
  { key: 'chase.owner_page_after_min', group: 'chase', label: 'Chase: page the owner after the second note', type: 'minutes', min: 5, max: 120, def: 20,
    describe: function (a, b) { return 'The owner is paged ' + fmtMinutes(b) + ' after the second note if nothing is booked (was ' + fmtMinutes(a) + ').'; } },
  { key: 'noshow.grace_min', group: 'noshow', label: 'No-show sweep: grace after the slot', type: 'minutes', min: 15, max: 360, def: 180,
    describe: function (a, b) { return 'A booking is judged attended or no-show ' + fmtMinutes(b) + ' after its slot (was ' + fmtMinutes(a) + ').'; } }
];
const LEVER_KEYS = LEVERS.map(function (l) { return l.key; });
const BY_KEY = {};
LEVERS.forEach(function (l) { BY_KEY[l.key] = l; });
const MAX_CHANGES = 6;

function lever(key) { return BY_KEY[String(key || '')] || null; }
function defaults() { const out = {}; LEVERS.forEach(function (l) { out[l.key] = l.def; }); return out; }

// A value as the model (or the store) gives it, checked against the lever:
// minutes, hours and counts are whole numbers in range; a clock is "HH:MM"
// (or minutes from midnight; a bare "9" or "19.5" reads as hours) in range;
// a switch is true or false in any spelling. null when it does not parse.
function parseValue(l, raw) {
  if (!l) return null;
  if (l.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].indexOf(s) !== -1) return true;
    if (['false', 'no', 'off', '0'].indexOf(s) !== -1) return false;
    return null;
  }
  let n;
  if (l.type === 'clock') {
    const s = String(raw == null ? '' : raw).trim();
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(s);
    if (m) n = Number(m[1]) * 60 + Number(m[2]);
    else if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
    else n = NaN;
    if (!m && Number.isFinite(n) && n < 24) n = n * 60;
  } else {
    n = typeof raw === 'number' ? raw : Number(String(raw == null ? '' : raw).trim());
  }
  if (!Number.isFinite(n)) return null;
  n = Math.round(n);
  if (n < l.min || n > l.max) return null;
  return n;
}

function formatValue(l, v) {
  if (!l) return String(v);
  if (l.type === 'bool') return v ? 'on' : 'off';
  if (l.type === 'clock') return clock(v);
  if (l.type === 'hours') return v + ' h';
  if (l.type === 'minutes') return v + ' min';
  return String(v);
}
function rangeText(l) {
  if (l.type === 'bool') return 'on or off';
  if (l.type === 'clock') return clock(l.min) + ' to ' + clock(l.max);
  return l.min + ' to ' + l.max + (l.type === 'hours' ? ' hours' : l.type === 'minutes' ? ' minutes' : '');
}

// The stored settings: only the levers the owner has set, each valid.
function normaliseSettings(raw) {
  const out = {};
  const r = raw && typeof raw === 'object' ? raw : {};
  LEVERS.forEach(function (l) {
    if (!Object.prototype.hasOwnProperty.call(r, l.key)) return;
    const v = parseValue(l, r[l.key]);
    if (v !== null) out[l.key] = v;
  });
  return out;
}

// What is in force: the owner's stored value, else what the environment sets
// (the server works those out from its env vars), else the default.
function currentSettings(stored, envValues) {
  const out = defaults();
  const e = envValues && typeof envValues === 'object' ? envValues : {};
  LEVERS.forEach(function (l) {
    const ev = parseValue(l, e[l.key]);
    if (ev !== null) out[l.key] = ev;
  });
  Object.assign(out, normaliseSettings(stored));
  return out;
}

// For the page and the model: one line per lever.
function describeSettings(current) {
  const cur = Object.assign(defaults(), current || {});
  return LEVERS.map(function (l) {
    return { key: l.key, group: GROUP_LABELS[l.group], label: l.label, type: l.type, value: cur[l.key], display: formatValue(l, cur[l.key]), range: rangeText(l) };
  });
}
function leversForPrompt(current) {
  return describeSettings(current).map(function (d) { return { lever: d.key, is: d.display, allowed: d.range, what: d.label }; });
}

// ── what the model may write ───────────────────────────────────────────────
const CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'aut-1, aut-2, ...' },
    lever: { type: 'string', enum: LEVER_KEYS, description: 'The setting to change, by its key from the AUTOMATION LEVERS list.' },
    value: { type: 'string', description: 'The new value as text: a whole number for minutes, hours or a count; HH:MM for a clock; true or false for a switch. Inside the allowed range given for the lever.' },
    title: { type: 'string', description: 'Plain English, under 100 characters, e.g. "Give Hazel a third attempt".' },
    why: { type: 'string', description: 'The numbers this rests on, one or two sentences.' },
    priority: { type: 'integer', description: '1 (do first) to 3 (nice to have).' }
  },
  required: ['id', 'lever', 'value', 'title', 'why', 'priority']
};

function short(s, n) { const t = String(s == null ? '' : s).trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

function normaliseChange(x, idx) {
  const y = x || {};
  const l = lever(y.lever);
  if (!l) return null;
  const v = parseValue(l, y.value);
  if (v === null) return null;
  return {
    id: /^aut-\d+$/.test(String(y.id || '')) ? String(y.id) : ('aut-' + (idx + 1)),
    lever: l.key,
    value: v,
    label: GROUP_LABELS[l.group],
    title: short(y.title, 160) || l.label,
    why: short(y.why, 600),
    priority: Math.min(3, Math.max(1, Math.round(Number(y.priority)) || 2)),
    // Set by the executor once the owner has applied it (or tried to).
    applied: null
  };
}
function normaliseChanges(list) {
  const out = (Array.isArray(list) ? list : []).map(normaliseChange).filter(Boolean).slice(0, MAX_CHANGES);
  const seen = {};
  out.forEach(function (c, i) { if (seen[c.id]) c.id = 'aut-' + (i + 1) + 'b'; seen[c.id] = true; });
  return out;
}

// One sentence saying exactly what will change, against the settings in force.
function describeChange(c, current) {
  const l = lever(c && c.lever);
  if (!l) return (c && c.title) || 'Change';
  const cur = Object.assign(defaults(), current || {})[l.key];
  return l.describe(cur, c.value);
}
function describeChanges(list, current) {
  return (Array.isArray(list) ? list : []).map(function (c) {
    const l = lever(c.lever);
    return Object.assign({}, c, { label: l ? GROUP_LABELS[l.group] : (c.label || 'Automation'), effect: describeChange(c, current) });
  });
}

// ── checking and applying ──────────────────────────────────────────────────
// `next` is the settings as they will stand with the earlier changes of the
// batch already made, so "weekday_start 10:00" and "weekday_end 09:30" in one
// batch is caught whichever order they come in.
function checkChange(c, next) {
  const l = lever(c && c.lever);
  if (!l) return { ok: false, message: 'Unknown setting.' };
  const v = parseValue(l, c.value);
  if (v === null) return { ok: false, message: 'The value is outside the allowed range (' + rangeText(l) + ').' };
  if (next[l.key] === v) return { ok: false, skip: true, message: 'Already ' + formatValue(l, v) + '.' };
  const after = Object.assign({}, next);
  after[l.key] = v;
  if (after['hazel.weekday_start'] >= after['hazel.weekday_end']) return { ok: false, message: 'Refused: weekday calls would start (' + clock(after['hazel.weekday_start']) + ') after they stop (' + clock(after['hazel.weekday_end']) + ').' };
  if (after['hazel.weekend_start'] >= after['hazel.weekend_end']) return { ok: false, message: 'Refused: weekend calls would start (' + clock(after['hazel.weekend_start']) + ') after they stop (' + clock(after['hazel.weekend_end']) + ').' };
  if (after['chase.step1_min'] >= after['chase.step2_min']) return { ok: false, message: 'Refused: the first WhatsApp (' + fmtMinutes(after['chase.step1_min']) + ') must come before the second note (' + fmtMinutes(after['chase.step2_min']) + ').' };
  if (after['chase.step2_min'] >= after['chase.step3_hours'] * 60) return { ok: false, message: 'Refused: the second note (' + fmtMinutes(after['chase.step2_min']) + ') must come before the day-after note (' + after['chase.step3_hours'] + ' hours).' };
  return { ok: true, value: v };
}

// Applies `changes` (priority 1 first) to `settings` (the values in force).
// One result per change: { id, lever, ok, skipped, message, before, after }.
// A refusal never stops the others.
function applyChanges(opts) {
  const o = opts || {};
  const next = Object.assign(defaults(), o.settings || {});
  const results = [];
  const order = (Array.isArray(o.changes) ? o.changes : []).slice().sort(function (a, b) { return (a.priority || 2) - (b.priority || 2); });
  order.forEach(function (c) {
    const l = lever(c && c.lever);
    const before = l ? next[l.key] : null;
    const check = checkChange(c, next);
    if (!check.ok) { results.push({ id: c.id, lever: c.lever, ok: false, skipped: !!check.skip, message: check.message, before: before, after: null }); return; }
    next[l.key] = check.value;
    results.push({ id: c.id, lever: l.key, ok: true, skipped: false, message: l.describe(before, check.value), before: before, after: check.value });
  });
  const counts = {
    applied: results.filter(function (r) { return r.ok; }).length,
    skipped: results.filter(function (r) { return r.skipped; }).length,
    failed: results.filter(function (r) { return !r.ok && !r.skipped; }).length
  };
  return { ok: counts.failed === 0, settings: next, results: results, counts: counts };
}
function summarise(counts) {
  const c = counts || {};
  const bits = [];
  if (c.applied) bits.push(c.applied + ' setting' + (c.applied === 1 ? '' : 's') + ' changed');
  if (c.skipped) bits.push(c.skipped + ' already so');
  if (c.failed) bits.push(c.failed + ' refused');
  return bits.length ? bits.join(', ') + '.' : 'Nothing was changed.';
}

// ── what the consumers read ────────────────────────────────────────────────
// Only levers the owner has set are handed on, so an environment variable
// (LEAD_CALLS_MAX_ATTEMPTS and friends) keeps ruling until the owner changes
// that setting from the page.
function leadCallOverrides(stored) {
  const s = normaliseSettings(stored);
  const out = {};
  if (s['hazel.first_call_delay_min'] !== undefined) out.minLeadAgeMs = s['hazel.first_call_delay_min'] * MIN_MS;
  if (s['hazel.max_attempts'] !== undefined) out.maxAttempts = s['hazel.max_attempts'];
  if (s['hazel.retry_after_min'] !== undefined) out.retryAfterMs = s['hazel.retry_after_min'] * MIN_MS;
  if (s['hazel.vary_retry_time'] !== undefined) out.varyRetryTime = s['hazel.vary_retry_time'];
  if (s['hazel.text_after_missed_call'] !== undefined) out.textAfterMissedCall = s['hazel.text_after_missed_call'];
  const keys = ['hazel.weekday_start', 'hazel.weekday_end', 'hazel.weekend_start', 'hazel.weekend_end'];
  if (keys.some(function (k) { return s[k] !== undefined; })) {
    const d = defaults();
    const v = function (k) { return s[k] === undefined ? d[k] : s[k]; };
    out.callWindows = {
      weekday: [v('hazel.weekday_start'), v('hazel.weekday_end')],
      saturday: [v('hazel.weekend_start'), v('hazel.weekend_end')],
      sunday: [v('hazel.weekend_start'), v('hazel.weekend_end')]
    };
  }
  return out;
}
function consultOverrides(stored) {
  const s = normaliseSettings(stored);
  const out = {};
  if (s['chase.step1_min'] !== undefined) out.step1Ms = s['chase.step1_min'] * MIN_MS;
  if (s['chase.step2_min'] !== undefined) out.step2Ms = s['chase.step2_min'] * MIN_MS;
  if (s['chase.step3_hours'] !== undefined) out.step3Ms = s['chase.step3_hours'] * 60 * MIN_MS;
  if (s['chase.owner_page_after_min'] !== undefined) out.ownerAlertAfterMs = s['chase.owner_page_after_min'] * MIN_MS;
  return out;
}
function noshowGraceMin(stored, fallback) {
  const s = normaliseSettings(stored);
  return s['noshow.grace_min'] !== undefined ? s['noshow.grace_min'] : fallback;
}

module.exports = {
  LEVERS,
  LEVER_KEYS,
  GROUP_LABELS,
  MAX_CHANGES,
  CHANGE_SCHEMA,
  clock,
  fmtMinutes,
  lever,
  defaults,
  parseValue,
  formatValue,
  normaliseSettings,
  currentSettings,
  describeSettings,
  leversForPrompt,
  normaliseChange,
  normaliseChanges,
  describeChange,
  describeChanges,
  checkChange,
  applyChanges,
  summarise,
  leadCallOverrides,
  consultOverrides,
  noshowGraceMin
};
