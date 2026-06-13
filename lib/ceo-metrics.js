'use strict';

// ── Constants ───────────────────────────────────────────────────
var OPEN_TASK_STATUSES = ['open','in_progress','waiting','waiting_on_gp','waiting_on_practice','waiting_on_external','escalated'];
var OVERDUE_EXCLUDED_STATUSES = ['completed','cancelled'];

// User-facing funnel order == true DB progression so the cumulative funnel narrows top->bottom (#28).
var FUNNEL_STAGES = [
  { key: 'myintealth', label: 'MyIntealth' },
  { key: 'amc', label: 'AMC' },
  { key: 'career', label: 'Secure Placement' },
  { key: 'ahpra', label: 'AHPRA' },
  { key: 'pbs', label: 'PBS & Medicare' },
  { key: 'commencement', label: 'Commencement' }
];

// visa shares pbs index (deferred); complete sits above the funnel (#56).
var DB_STAGE_ORDER = { myintealth: 0, amc: 1, career: 2, ahpra: 3, pbs: 4, visa: 4, commencement: 5, complete: 6 };

var SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 182;
var DAY_MS = 86400000;

// ── Status normalisation (mirrors server.js:10102) ──────────────
function normalizeStatusKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Single source of secured statuses — mirrors server.js:10126 incl. 'placed' (#8/#61).
var SECURED_STATUS_KEYS = new Set(['hired','secured','placed','placement_secured','offer_accepted','contract_signed']);
var INTERVIEW_STATUS_KEYS = new Set(['interview','interview_scheduled','interview_confirmed']);
var OFFER_STATUS_KEYS = new Set(['offer','offer_pending','offered']);

function isSecuredStatus(status) { return SECURED_STATUS_KEYS.has(normalizeStatusKey(status)); }
function isInterviewStatus(status) { return INTERVIEW_STATUS_KEYS.has(normalizeStatusKey(status)); }
function isOfferStatus(status) { return OFFER_STATUS_KEYS.has(normalizeStatusKey(status)); }

module.exports = {
  OPEN_TASK_STATUSES, OVERDUE_EXCLUDED_STATUSES, FUNNEL_STAGES, DB_STAGE_ORDER, SIX_MONTHS_MS, DAY_MS,
  normalizeStatusKey, isSecuredStatus, isInterviewStatus, isOfferStatus
};
