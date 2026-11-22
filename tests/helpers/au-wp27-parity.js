'use strict';

/**
 * WP-27 parity capture: every metric endpoint's full response, the weekly
 * owner digest (subject + body), the daily gone-quiet email, the review queue
 * and the gone-quiet list, from the REAL server on the in-memory database.
 *
 *   const cap = await captureAll(h)          // h: bootLeadCopyServer (supabase mode)
 *
 * The snapshots under tests/fixtures/au-wp27-parity.*.snapshot.json were
 * written by this file BEFORE WP-27 changed any code (WP27_WRITE_SNAPSHOT=1):
 *   overseas-on   overseas-only database, switch on
 *   overseas-off  overseas-only database, switch off
 *   merged-off    overseas + Australian database, switch off
 * Never regenerate them to make a test pass.
 */

const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');
const snapshotPath = function (key) { return path.join(FIXTURE_DIR, 'au-wp27-parity.' + key + '.snapshot.json'); };

// Keys whose value is how long the server took, not a metric.
const TIMING_KEYS = /^(generated_in_ms|generated_ms|took_ms|duration_ms|elapsed_ms)$/;

function normalise(value, key) {
  if (Array.isArray(value)) return value.map(function (v) { return normalise(v, key); });
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(function (k) { out[k] = normalise(value[k], k); });
    return out;
  }
  if (typeof value === 'number' && TIMING_KEYS.test(String(key))) return '<ms>';
  return value;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function settle(h) {
  let last = -1;
  for (let i = 0; i < 50; i++) {
    await sleep(40);
    const n = h.emails.length + h.emu.requests.length;
    if (n === last) return;
    last = n;
  }
}
function mailShape(call) {
  const b = (call && call.body) || {};
  return { to: b.to || null, subject: b.subject || null, html: b.html || null, text: b.text || null };
}

// The metric endpoints, as the owner's and the staff's screens call them.
const CEO_GETS = [
  ['overview7', '/api/ceo/overview?window=7d&tz=Australia%2FSydney'],
  ['overview30', '/api/ceo/overview?window=30d&tz=Australia%2FSydney'],
  ['dashboardCurrent', '/api/ceo/dashboard?period=current'],
  ['dashboard7', '/api/ceo/dashboard?period=7d'],
  ['dashboardAll', '/api/ceo/dashboard?period=all'],
  ['trends', '/api/ceo/trends'],
  ['conversionAll', '/api/ceo/conversion-funnel?period=all'],
  ['conversion30', '/api/ceo/conversion-funnel?period=30d'],
  ['sourceAll', '/api/ceo/source-attribution?period=all'],
  ['source30', '/api/ceo/source-attribution?period=30d'],
  ['rsos', '/api/ceo/rsos'],
  ['pipelineSummary', '/api/ceo/pipeline-summary'],
  ['attention', '/api/ats/attention'],
  ['stalledList', '/api/ats/stalled-applications'],
  ['newApplications', '/api/ats/new-applications'],
  ['waitingOnPractice', '/api/ats/waiting-on-practice'],
  ['reviewQueue', '/api/ceo/review-queue'],
  ['onboardingIncomplete', '/api/ceo/onboarding-incomplete'],
  ['candidates', '/api/ceo/candidates?q=&stage=&band=&account_status=&sort=intent&ats_bucket='],
  ['stuckCases', '/api/admin/stuck-cases'],
  ['adminDashboard', '/api/admin/dashboard'],
  ['drillPipelineMyintealth', '/api/ceo/drilldown/pipeline?stage=myintealth&period=current'],
  ['drillPipelineCareer', '/api/ceo/drilldown/pipeline?stage=career&period=all'],
  ['drillBlockers', '/api/ceo/drilldown/blockers?period=current'],
  ['drillTasksOpen', '/api/ceo/drilldown/tasks?status=open&period=current'],
  ['drillTasksOverdue', '/api/ceo/drilldown/tasks?status=overdue&period=current'],
  ['drillActivityCold', '/api/ceo/drilldown/activity?bucket=cold&period=current'],
  ['drillActivityActive', '/api/ceo/drilldown/activity?bucket=active&period=current'],
  ['drillTicketsOpen', '/api/ceo/drilldown/tickets?status=open&period=current'],
  ['drillCompletions', '/api/ceo/drilldown/completions?period=current'],
  ['drillPlacementsApplied', '/api/ceo/drilldown/placements?status=applied&period=all'],
  ['drillPlacementsInterviewing', '/api/ceo/drilldown/placements?status=interviewing&period=all'],
  ['drillPlacementsSecured', '/api/ceo/drilldown/placements?status=secured&period=all'],
  ['drillPlaced', '/api/ceo/drilldown/placed?period=current'],
  ['drillRsoUnassigned', '/api/ceo/drilldown/rso?rso_id=__unassigned__&period=current'],
  ['drillRsoA', '/api/ceo/drilldown/rso?rso_id=00000000-0000-4000-8000-00000000e001&period=current']
];
const CSV_GETS = [
  ['exportGps', '/api/admin/export?entity=gps&format=csv'],
  ['exportPlacements', '/api/admin/export?entity=placements&format=csv']
];

/**
 * @param {object} h  a booted harness (tests/helpers/au-wp16-harness.js, supabase mode)
 * @returns {Promise<object>} everything, JSON-serialisable and normalised
 */
async function captureAll(h) {
  const sa = h.superAdmin();
  const out = { endpoints: {}, csv: {}, staff: {}, digest: null, stalled: null };
  for (const [name, url] of CEO_GETS) {
    const r = await h.get(url, sa);
    out.endpoints[name] = { status: r.status, body: r.json };
  }
  for (const [name, url] of CSV_GETS) {
    const r = await h.get(url, sa);
    out.csv[name] = { status: r.status, body: r.raw };
  }
  // What a consultant and an RSO are answered on the same routes.
  const co = h.consultant();
  const rso = h.rso();
  for (const [name, url] of [['overview', '/api/ceo/overview?window=7d'], ['dashboard', '/api/ceo/dashboard'], ['reviewQueue', '/api/ceo/review-queue'],
    ['attention', '/api/ats/attention'], ['stalledList', '/api/ats/stalled-applications'], ['pipelineSummary', '/api/ceo/pipeline-summary']]) {
    const c = await h.get(url, co);
    out.staff['consultant:' + name] = { status: c.status, body: c.json };
  }
  const rsoDash = await h.get('/api/admin/dashboard', rso);
  out.staff['rso:adminDashboard'] = { status: rsoDash.status, body: rsoDash.json };

  // The weekly owner digest: the forced send (the dashboard button), then the
  // scheduled job (which records its weekly marker), then the job again.
  h.reset();
  const forced = await h.post('/api/ceo/owner-digest/send', {}, sa);
  await settle(h);
  out.digest = { forced: { status: forced.status, body: forced.json, emails: h.emails.map(mailShape) } };
  h.reset();
  const cron1 = await h.cron('/api/cron/owner-digest');
  await settle(h);
  out.digest.cron = { status: cron1.status, body: cron1.json, emails: h.emails.map(mailShape) };
  h.reset();
  const cron2 = await h.cron('/api/cron/owner-digest');
  await settle(h);
  out.digest.cronAgain = { status: cron2.status, body: cron2.json, emails: h.emails.map(mailShape) };

  // The daily gone-quiet sweep: first run (alerts), the sentinel it stores,
  // then a second run (nothing new to say).
  h.reset();
  const sweep1 = await h.cron('/api/cron/stalled-applications');
  await settle(h);
  const sentinelOf = function () {
    const row = h.emu.table('runtime_kv').find(function (r) { return r && r.key === 'stalled_application_alerts'; });
    return row ? row.value : null;
  };
  out.stalled = { first: { status: sweep1.status, body: sweep1.json, emails: h.emails.map(mailShape), sentinel: JSON.parse(JSON.stringify(sentinelOf())) } };
  h.reset();
  const sweep2 = await h.cron('/api/cron/stalled-applications');
  await settle(h);
  out.stalled.second = { status: sweep2.status, body: sweep2.json, emails: h.emails.map(mailShape), sentinel: JSON.parse(JSON.stringify(sentinelOf())) };
  const listAfter = await h.get('/api/ats/stalled-applications', sa);
  out.stalled.listAfter = { status: listAfter.status, body: listAfter.json };
  out.stalled.timeline = h.emu.table('task_timeline').filter(function (r) { return r && r.event_type === 'stalled_application_alert'; })
    .map(function (r) { return { case_id: r.case_id, title: r.title, detail: r.detail, metadata: r.metadata }; });
  return normalise(out);
}

function readSnapshot(key) { return JSON.parse(fs.readFileSync(snapshotPath(key), 'utf8')); }
function writeSnapshot(key, value) { fs.writeFileSync(snapshotPath(key), JSON.stringify(value, null, 1) + '\n'); }

module.exports = { captureAll, normalise, readSnapshot, writeSnapshot, snapshotPath, CEO_GETS, CSV_GETS, settle, mailShape };

// What is compared. Today: everything. (WP-27 adds Australian-only keys with
// the switch on; they are removed here so the snapshot taken before the
// package still compares. See AU_ONLY_KEYS.)
function comparable(value) { return value; }
module.exports.comparable = comparable;
