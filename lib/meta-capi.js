// lib/meta-capi.js — Meta Conversions API for CRM: the lead-stage feed for the
// Meta-ads GP consult funnel. Pure decision logic (which stages a lead has
// reached, which of them Meta has not been told yet, what the payload looks
// like) plus one sender with an injectable fetch. Consumed by server.js — the
// FB webhook GP branch (lead received / qualified) and the hourly
// /api/cron/meta-lead-stages sweep (call booked / signed up, plus retries).
//
// Why this exists: Meta's "Maximise number of qualified leads" goal for instant
// forms only works when Meta is told, per lead, how far down the funnel that
// lead went. The website pixel cannot do that (it never knows the lead id), so
// the app reports it here, keyed by the instant-form lead id it already stores
// as site_enquiries.metadata.fb_lead_id. Events are sent as
// action_source 'system_generated' with custom_data.event_source 'crm', which is
// the shape Meta's "Conversions API for CRM" integration expects.
'use strict';

const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

// Funnel stages, in order. These are the event_name values Meta shows in Events
// Manager → dataset → funnel configuration, so keep them stable: renaming one
// after launch splits Meta's history into two stages.
//   lead         — the raw lead stage: every Meta lead we stored (Meta requires it)
//   qualified_gp — our screening said "a GP from a country we place"
//   call_booked  — a consultation was booked (Calendly webhook or /start)
//   signed_up    — the GP created an app account
// 'qualified_gp' rather than 'qualified' so it never collides with the
// hand-marked QUALIFIED stage the owner sets in Meta's Leads Centre, which
// lands on the same dataset with a different meaning ("filled in the form").
const META_LEAD_STAGES = ['lead', 'qualified_gp', 'call_booked', 'signed_up'];

// Meta discards CRM events whose event_time is more than 7 days before upload.
// Anything older is clamped to a 6-day floor so a backfilled stage still lands
// (the timestamp then reads as "when our CRM recorded it", which is honest).
const MAX_EVENT_AGE_MS = 6 * DAY_MS;

// Leads older than this are left alone by the sweep. Meta only learns from a
// stage reached within 28 days of the lead, and with the 7-day event window a
// late stamp on an old lead teaches it nothing.
const LEAD_ELIGIBILITY_MS = 35 * DAY_MS;

const DEFAULT_GRAPH_BASE = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v26.0';
const DEFAULT_LEAD_EVENT_SOURCE = 'GP Link app';

// Dialling codes for the countries the funnel screens for, so a phone stored
// in national format ("07700 …") can still be hashed in the E.164 digits Meta
// matches on. Unknown country + national format = no phone hash (a guess that
// is wrong would never match anyway).
const COUNTRY_DIAL_CODES = { uk: '44', gb: '44', ie: '353', nz: '64', au: '61' };

function metaCapiConfigFromEnv(env) {
  const e = env || process.env;
  const datasetId = String(e.META_CAPI_DATASET_ID || '').trim();
  const accessToken = String(e.META_CAPI_ACCESS_TOKEN || '').trim();
  if (!/^\d+$/.test(datasetId) || !accessToken) return null;
  const graphBase = (String(e.META_CAPI_GRAPH_URL || '').trim() || DEFAULT_GRAPH_BASE).replace(/\/+$/, '');
  return {
    datasetId,
    accessToken,
    testEventCode: String(e.META_CAPI_TEST_EVENT_CODE || '').trim() || null,
    apiVersion: String(e.META_CAPI_API_VERSION || e.FB_GRAPH_VERSION || '').trim() || DEFAULT_API_VERSION,
    graphBase,
    leadEventSource: String(e.META_CAPI_LEAD_EVENT_SOURCE || '').trim() || DEFAULT_LEAD_EVENT_SOURCE
  };
}

// The instant-form lead id Meta gave us (leadgen_id): 15–17 digits. Anything
// else (simulator rows, hand-made fixtures) cannot be matched and is not sent.
function metaLeadIdOf(row) {
  const id = String((row && row.metadata && row.metadata.fb_lead_id) || '').trim();
  return /^\d{15,17}$/.test(id) ? id : null;
}

function isMetaLeadStageCandidate(row, nowMs) {
  if (!row || row.kind !== 'gp' || !row.metadata) return false;
  if (row.metadata.source !== 'meta_lead_ad') return false;
  if (!row.metadata.consult || typeof row.metadata.consult !== 'object') return false;
  if (!metaLeadIdOf(row)) return false;
  const created = Date.parse(row.created_at || '');
  if (!Number.isFinite(created)) return false;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return now - created <= LEAD_ELIGIBILITY_MS;
}

// Every stage this lead has reached, each with the time it happened.
// opts.signedUp lets the caller add what the row cannot know on its own
// (an account exists for this email); opts.now dates observation-time stages.
function deriveMetaLeadStages(row, opts) {
  const o = opts || {};
  const consult = (row && row.metadata && row.metadata.consult) || {};
  const nowIso = new Date(Number.isFinite(o.now) ? o.now : Date.now()).toISOString();
  const createdAt = row && row.created_at ? row.created_at : nowIso;
  const stages = [{ stage: 'lead', at: createdAt }];
  if (consult.qualified === true) {
    // A lead we could not read at first is re-screened by the consult-nudge
    // cron, which stamps rescreened_at; otherwise screening happened at intake.
    stages.push({ stage: 'qualified_gp', at: consult.rescreened_at || createdAt });
  }
  if (consult.call_booked === true || consult.call_booked_at) {
    stages.push({ stage: 'call_booked', at: consult.call_booked_at || nowIso });
  }
  const signedUp = consult.stopped === 'signed_up' || (row && row.status === 'converted') || o.signedUp === true;
  if (signedUp) {
    // Nothing on the row records WHEN the account was created (the nudge cron
    // only stamps stopped:'signed_up'), so the stage is dated to when we saw it.
    stages.push({ stage: 'signed_up', at: consult.signed_up_at || nowIso });
  }
  return stages;
}

function sentMetaLeadStages(row) {
  const capi = row && row.metadata && row.metadata.consult && row.metadata.consult.meta_capi;
  return (capi && capi.sent && typeof capi.sent === 'object') ? capi.sent : {};
}

function pendingMetaLeadStages(row, opts) {
  const sent = sentMetaLeadStages(row);
  return deriveMetaLeadStages(row, opts).filter((s) => !sent[s.stage]);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeEmailForMeta(email) {
  const v = String(email || '').trim().toLowerCase();
  return v.includes('@') ? v : null;
}

// E.164 digits only (Meta: "remove symbols, letters and leading zeros, include
// the country code"). Returns null rather than guessing.
function normalizePhoneForMeta(phone, country) {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    const cc = COUNTRY_DIAL_CODES[String(country || '').trim().toLowerCase()];
    if (!cc) return null;
    digits = cc + digits.replace(/^0+/, '');
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function toEpochSeconds(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// One Conversions API event per stage. event_time is clamped into the window
// Meta accepts: never before the lead itself, never older than the 6-day floor,
// never in the future.
function buildMetaLeadStageEvents(row, stages, cfg, opts) {
  const o = opts || {};
  const leadId = metaLeadIdOf(row);
  if (!leadId) return [];
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const floorSec = Math.floor((nowMs - MAX_EVENT_AGE_MS) / 1000);
  const consult = (row.metadata && row.metadata.consult) || {};
  const leadCreatedSec = toEpochSeconds(row.created_at);
  const em = normalizeEmailForMeta(row.email);
  const ph = normalizePhoneForMeta(row.phone, consult.country);
  const leadEventSource = (cfg && cfg.leadEventSource) || DEFAULT_LEAD_EVENT_SOURCE;
  return (stages || []).map((s) => {
    let t = toEpochSeconds(s.at);
    if (t === null) t = nowSec;
    if (leadCreatedSec !== null && t < leadCreatedSec) t = leadCreatedSec;
    if (t < floorSec) t = floorSec;
    if (t > nowSec) t = nowSec;
    // lead_id stays a string here; serializeMetaCapiBody turns it into the
    // integer literal Meta wants (a 16–17 digit number is past 2^53).
    const userData = { lead_id: leadId };
    if (em) userData.em = [sha256Hex(em)];
    if (ph) userData.ph = [sha256Hex(ph)];
    return {
      event_name: s.stage,
      event_time: t,
      event_id: leadId + ':' + s.stage,
      action_source: 'system_generated',
      user_data: userData,
      custom_data: { lead_event_source: leadEventSource, event_source: 'crm' }
    };
  });
}

function serializeMetaCapiBody(events, cfg) {
  const body = { data: events, access_token: cfg.accessToken };
  if (cfg.testEventCode) body.test_event_code = cfg.testEventCode;
  return JSON.stringify(body).replace(/"lead_id":"(\d{15,17})"/g, '"lead_id":$1');
}

// POST /{dataset}/events. Never throws; every outcome is a result object so
// callers can decide whether to stamp the row.
async function sendMetaCapiEvents(events, cfg, opts) {
  const o = opts || {};
  if (!cfg) return { ok: false, error: 'not configured' };
  if (!Array.isArray(events) || !events.length) return { ok: true, status: 0, eventsReceived: 0 };
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, error: 'fetch unavailable' };
  const url = cfg.graphBase + '/' + cfg.apiVersion + '/' + cfg.datasetId + '/events';
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializeMetaCapiBody(events, cfg),
      signal: AbortSignal.timeout(o.timeoutMs || 10000)
    });
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    const received = data && Number.isFinite(Number(data.events_received)) ? Number(data.events_received) : 0;
    const fbtraceId = (data && data.fbtrace_id) || null;
    if (!resp.ok) {
      const err = data && data.error;
      const msg = (err && (err.error_user_msg || err.message)) || ('http ' + resp.status);
      return { ok: false, status: resp.status, error: String(msg).slice(0, 300), eventsReceived: received, fbtraceId };
    }
    if (received < events.length) {
      return { ok: false, status: resp.status, error: 'events_received ' + received + ' of ' + events.length, eventsReceived: received, fbtraceId };
    }
    return { ok: true, status: resp.status, eventsReceived: received, fbtraceId };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

// Merge-only: returns a new metadata object with the stages stamped as sent.
// Everything else on metadata / consult is carried through untouched.
function markMetaLeadStagesSent(metadata, stages, nowIso) {
  const md = Object.assign({}, metadata || {});
  const consult = Object.assign({}, md.consult || {});
  const capi = Object.assign({}, consult.meta_capi || {});
  const sent = Object.assign({}, capi.sent || {});
  for (const s of stages || []) sent[s.stage] = nowIso;
  capi.sent = sent;
  capi.last_sent_at = nowIso;
  consult.meta_capi = capi;
  md.consult = consult;
  return md;
}

// Derive → send → stamp. The stamp is written only after Meta acknowledged the
// events, so a failed send is simply retried by the next sweep.
// deps: { cfg, now, signedUp, fetchImpl, timeoutMs, persist(id, patch) }
async function syncMetaLeadStages(row, deps) {
  const d = deps || {};
  if (!d.cfg) return { ok: false, skipped: 'not_configured', sent: [] };
  const nowMs = Number.isFinite(d.now) ? d.now : Date.now();
  if (!isMetaLeadStageCandidate(row, nowMs)) return { ok: true, skipped: 'not_eligible', sent: [] };
  const pending = pendingMetaLeadStages(row, { now: nowMs, signedUp: d.signedUp === true });
  if (!pending.length) return { ok: true, sent: [] };
  const attempted = pending.map((s) => s.stage);
  const events = buildMetaLeadStageEvents(row, pending, d.cfg, { now: nowMs });
  const result = await sendMetaCapiEvents(events, d.cfg, { fetchImpl: d.fetchImpl, timeoutMs: d.timeoutMs });
  if (!result.ok) {
    return { ok: false, error: result.error || 'send failed', status: result.status || null, attempted, sent: [] };
  }
  const nowIso = new Date(nowMs).toISOString();
  const metadata = markMetaLeadStagesSent(row.metadata, pending, nowIso);
  let persisted = false;
  if (typeof d.persist === 'function') {
    try { persisted = !!(await d.persist(row.id, { metadata })); }
    catch (e) {
      return { ok: false, error: 'stamp failed: ' + String((e && e.message) || e), attempted, sent: attempted, persisted: false };
    }
  }
  // Keep the caller's row in step so a later Object.assign on row.metadata in
  // the same pass cannot drop the stamp (the consult-nudge cron documents this trap).
  row.metadata = metadata;
  return { ok: true, sent: attempted, persisted, eventsReceived: result.eventsReceived };
}

module.exports = {
  META_LEAD_STAGES,
  MAX_EVENT_AGE_MS,
  LEAD_ELIGIBILITY_MS,
  metaCapiConfigFromEnv,
  metaLeadIdOf,
  isMetaLeadStageCandidate,
  deriveMetaLeadStages,
  sentMetaLeadStages,
  pendingMetaLeadStages,
  normalizeEmailForMeta,
  normalizePhoneForMeta,
  buildMetaLeadStageEvents,
  serializeMetaCapiBody,
  sendMetaCapiEvents,
  markMetaLeadStagesSent,
  syncMetaLeadStages
};
