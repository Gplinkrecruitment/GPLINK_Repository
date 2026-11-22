// WP-27 (Australian GP build) ACCEPTANCE: adding Australian fixtures changes no
// overseas metric.
//
// The database here is the overseas business PLUS a rich Australian set (a
// doctor in every Australian state, held B and C, a second placement cycle, an
// ended placement, leads, interviews, offers), with the switch ON. Every
// metric endpoint, the weekly owner digest, the gone-quiet sweep, the review
// queue and the gone-quiet list are captured and compared with the snapshot
// taken from the overseas-ONLY database before the package
// (tests/fixtures/au-wp27-parity.overseas-on.snapshot.json).
//
// The rule the comparison enforces:
//   1. Every number, list and section about overseas doctors is IDENTICAL.
//   2. The only places allowed to differ are the ones docs/au-gp/metrics.md
//      names as being about everyone (the owner's consult diary, things
//      waiting on a person, the shared candidates board, an RSO's assigned
//      caseload, row-level exports). Each is listed in NEUTRAL below with the
//      exact difference expected; in every such list the overseas rows are
//      still compared byte for byte.
//   3. Anything else that differs fails the test, by path.
//
// The switch-off half (whole responses and emails byte-identical to before the
// package, with the Australian rows in the database) is
// tests/au-wp27-parity-merged-off.test.js.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const fx = require('./helpers/au-wp27-fixtures.js');
const parity = require('./helpers/au-wp27-parity.js');
const auPipeline = require('../lib/au-pipeline.js');

let h;
let got;      // the merged capture, Australian-only keys removed
let raw;      // the merged capture as answered
let want;     // the overseas-only snapshot from before the package
const AU = fx.auDoctors();

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: fx.NOW_MS });
  h = await bootLeadCopyServer({ name: 'wp27-acceptance', mode: 'supabase', tables: fx.merged(fx.overseasTables(), fx.auTables()) });
  h.setSwitch(true);
  raw = await parity.captureAll(h);
  got = parity.comparable(raw);
  want = parity.comparable(parity.readSnapshot('overseas-on'));
}, 120000);

afterAll(async () => {
  if (h) await h.closeAll();
  vi.useRealTimers();
});

// Anything that names an Australian fixture row.
const AU_MARK = /Testau|Test Aulead|aulead-|app-au-|task-au-|sc-au|sc-aulead|plc-au-|tick-au|doc-au|\.w\d+@gplink-test\.local|0000000[0-9a-f]*[ab]\dw\d+/;
const isAuRow = (row) => AU_MARK.test(JSON.stringify(row));
const overseasRows = (list) => (Array.isArray(list) ? list.filter((r) => !isAuRow(r)) : list);

// One path for the three dashboard periods, the two Overview windows and the
// consultant's copy of a shared endpoint.
const generic = (path) => path
  .replace(/^endpoints\.overview(7|30)\./, 'endpoints.overview.')
  .replace(/^endpoints\.dashboard(7|All|Current)\./, 'endpoints.dashboard.')
  .replace(/^staff\.consultant:(attention|pipelineSummary|stalledList)\./, 'endpoints.$1.')
  .replace(/^staff\.rso:adminDashboard\./, 'endpoints.adminDashboard.');

const plus = (n) => ({ kind: 'plus', n });
const LIST = { kind: 'list' };
const text = (value) => ({ kind: 'text', value });

// THE NEUTRAL METRICS: about everyone, on purpose. path -> the exact change.
const NEUTRAL = {
  // Row-level exports list every doctor and placement (with a Pathway column).
  'csv.exportGps.body': { kind: 'csv' },
  'csv.exportPlacements.body': { kind: 'csv' },
  // The staff case list and the candidates board list every doctor (WP-26).
  'endpoints.adminDashboard.body.candidates': LIST,
  'endpoints.candidates.body.candidates': LIST,
  'endpoints.candidates.body.total': plus(18),
  'endpoints.pipelineSummary.body.total': plus(18),
  'endpoints.pipelineSummary.body.buckets': { kind: 'buckets' },
  'endpoints.pipelineSummary.body.ats.applied': plus(3),
  'endpoints.pipelineSummary.body.ats.interview': plus(1),
  'endpoints.pipelineSummary.body.ats.offer': plus(1),
  'endpoints.pipelineSummary.body.ats.hired': plus(8),
  'endpoints.onboardingIncomplete.body.count': plus(1),
  'endpoints.onboardingIncomplete.body.items': LIST,
  // The board's work queues: an application is an application.
  'endpoints.attention.body.new_applications': plus(3),
  'endpoints.newApplications.body.total': plus(3),
  'endpoints.newApplications.body.applications': LIST,
  // Things waiting on a person are never hidden: documents and escalations.
  'endpoints.dashboard.body.doc_reviews_pending': plus(1),
  'endpoints.dashboard.body.escalations': LIST,
  'endpoints.overview.body.doctors.docs_to_review': plus(1),
  'endpoints.overview.body.doctors.docs_7d': plus(1),
  'endpoints.overview.body.status.registration.docs_to_review': plus(1),
  'endpoints.overview.body.status.registration.docs_7d': plus(1),
  'endpoints.overview.body.status.registration.docs_list': LIST,
  'endpoints.overview.body.status.registration.escalated': plus(1),
  'endpoints.overview.body.status.registration.escalations': LIST,
  'endpoints.overview.body.status.registration.headline': text('1 AHPRA/regulator email · 2 escalations'),
  'endpoints.overview.body.status.registration.detail': text('2 documents waiting for review · first: Testos Doc5'),
  'endpoints.overview.body.needs.escalations': LIST,
  'endpoints.overview.body.needs.replies': LIST,
  'endpoints.reviewQueue.body.items': LIST,
  'endpoints.reviewQueue.body.counts.docs': plus(1),
  'endpoints.reviewQueue.body.counts.documents': plus(1),
  'endpoints.reviewQueue.body.counts.total': plus(14),
  // The owner's own consult diary: an Australian lead's consult is a consult.
  'endpoints.overview.body.status.consults.booked_7d': plus(1),
  'endpoints.overview.body.status.consults.booked_window': plus(1),
  'endpoints.overview.body.status.consults.upcoming': LIST,
  'endpoints.overview.body.series.booked': { kind: 'series', add: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] },
  'endpoints.overview.body.brief.segments': { kind: 'brief' },
  // An RSO's caseload counts the cases assigned to them, whatever the pathway.
  'endpoints.dashboard.body.rso_workload': { kind: 'workload' },
  'endpoints.rsos.body.rsos': { kind: 'workload' },
  'endpoints.drillRsoA.body.items': LIST,
  // The digest gains the Australian block; everything around it is checked below.
  'digest.forced.emails': { kind: 'digest' },
  'digest.cron.emails': { kind: 'digest' }
};

// Cases assigned to each RSO in the Australian fixtures (pre-start onwards).
const AU_ASSIGNED = { [fx.RSO_A]: 2, [fx.RSO_B]: 5 };

function check(path, before, after) {
  const rule = NEUTRAL[generic(path)];
  if (!rule) throw new Error('An overseas number changed when Australian fixtures were added: ' + path
    + '\n  overseas only: ' + JSON.stringify(before).slice(0, 300) + '\n  with Australian: ' + JSON.stringify(after).slice(0, 300));
  if (rule.kind === 'plus') { expect(after, path).toBe(before + rule.n); return; }
  if (rule.kind === 'text') { expect(after, path).toBe(rule.value); return; }
  if (rule.kind === 'list') {
    expect(overseasRows(after), path).toEqual(before);
    expect(after.length, path).toBeGreaterThan(before.length);
    return;
  }
  if (rule.kind === 'csv') {
    const keep = (csv) => String(csv).split('\n').filter((line) => !AU_MARK.test(line)).join('\n');
    expect(keep(after), path).toBe(before);
    return;
  }
  if (rule.kind === 'series') { expect(after, path).toEqual(before.map((v, i) => v + rule.add[i])); return; }
  if (rule.kind === 'buckets') {
    const byKey = (list) => Object.fromEntries(list.map((b) => [b.key, b.count]));
    const a = byKey(after), b = byKey(before);
    expect(Object.keys(a), path).toEqual(Object.keys(b));
    Object.keys(b).forEach((k) => expect(a[k], path + ' ' + k).toBeGreaterThanOrEqual(b[k]));
    expect(after.reduce((n, x) => n + x.count, 0) - before.reduce((n, x) => n + x.count, 0), path).toBe(18);
    return;
  }
  if (rule.kind === 'workload') {
    const idOf = (w) => w.rso_id;
    const beforeBy = Object.fromEntries(before.map((w) => [idOf(w), w]));
    expect(after.map(idOf).sort(), path).toEqual(before.map(idOf).sort());
    after.forEach((w) => {
      const b = beforeBy[idOf(w)];
      expect(w.case_count - b.case_count, path + ' ' + (w.rso_name || idOf(w))).toBe(AU_ASSIGNED[idOf(w)] || 0);
      // ADM-04: an Australian case with nobody assigned is NOT in "Unassigned".
      if (idOf(w) === '__unassigned__') expect(w, path).toEqual(b);
    });
    return;
  }
  if (rule.kind === 'brief') {
    const words = (segs) => segs.map((s) => s.t).join('');
    expect(words(after), path).toBe(words(before).replace('1 consult booked', '2 consults booked'));
    return;
  }
  if (rule.kind === 'digest') {
    expect(after.length, path).toBe(before.length);
    after.forEach((mail, i) => {
      expect(mail.subject, path).toBe(before[i].subject);
      expect(mail.to, path).toEqual(before[i].to);
      const start = mail.html.indexOf('<p style="font-size:13px;font-weight:700;color:#0f172a;margin:0 0 6px">Australian GPs');
      expect(start, path + ': the Australian block is there').toBeGreaterThan(0);
      // The block is one insertion: remove it and the email is the overseas email, byte for byte.
      let common = 0;
      while (common < before[i].html.length && before[i].html[common] === mail.html[common]) common++;
      expect(common, path + ': everything before the block is unchanged').toBe(start);
      const tail = before[i].html.slice(common);
      expect(mail.html.endsWith(tail), path + ': everything after the block is unchanged').toBe(true);
      expect(mail.html.slice(0, start) + tail, path).toBe(before[i].html);
    });
    return;
  }
  throw new Error('no check for ' + path);
}

describe('WP-27 acceptance: adding Australian fixtures changes no overseas metric', () => {
  it('every endpoint answered', () => {
    Object.keys(want.endpoints).forEach((name) => expect(got.endpoints[name].status, name).toBe(want.endpoints[name].status));
    Object.keys(want.staff).forEach((name) => expect(got.staff[name].status, name).toBe(want.staff[name].status));
  });

  it('every overseas number, list and section is identical; only the named everyone-metrics differ, each by exactly the expected amount', () => {
    const paths = parity.diffPaths(want, got);
    const seen = {};
    paths.forEach((path) => {
      check(path, parity.at(want, path), parity.at(got, path));
      seen[generic(path)] = true;
    });
    // Every rule above was needed: a rule nothing matches is a stale exemption.
    Object.keys(NEUTRAL).forEach((key) => expect(seen[key], 'the exemption for ' + key + ' matched nothing').toBe(true));
  });

  it('the endpoints that are overseas by definition are byte-identical in full', () => {
    ['trends', 'conversionAll', 'conversion30', 'sourceAll', 'source30', 'stuckCases', 'stalledList', 'waitingOnPractice',
      'drillPipelineMyintealth', 'drillPipelineCareer', 'drillBlockers', 'drillTasksOpen', 'drillTasksOverdue', 'drillActivityCold',
      'drillActivityActive', 'drillTicketsOpen', 'drillCompletions', 'drillPlacementsApplied', 'drillPlacementsInterviewing',
      'drillPlacementsSecured', 'drillPlaced', 'drillRsoUnassigned'
    ].forEach((name) => expect(got.endpoints[name], name).toEqual(want.endpoints[name]));
    // The Registration -> Pipeline view: every card but the three everyone-metrics.
    ['dashboardCurrent', 'dashboard7', 'dashboardAll'].forEach((name) => {
      ['kpi', 'pipeline', 'ats_funnel', 'blockers', 'task_health', 'velocity', 'placements', 'gp_activity', 'tickets', 'completions'].forEach((card) => {
        expect(got.endpoints[name].body[card], name + '.' + card).toEqual(want.endpoints[name].body[card]);
      });
    });
    // The Overview: the funnel, the Hayley and Meta lights, the doctors block, the tiles.
    ['overview7', 'overview30'].forEach((name) => {
      const a = got.endpoints[name].body, b = want.endpoints[name].body;
      ['funnel', 'tiles'].forEach((k) => expect(a[k], name + '.' + k).toEqual(b[k]));
      expect(a.status.hayley, name).toEqual(b.status.hayley);
      expect(a.status.meta, name).toEqual(b.status.meta);
      expect(a.status.registration.cases, name).toEqual(b.status.registration.cases);
      expect(a.series.leads, name).toEqual(b.series.leads);
      expect(a.series.signups, name).toEqual(b.series.signups);
      ['accounts_window', 'accounts_total', 'onboarded_30d', 'incomplete', 'incomplete_ids', 'placements_active', 'placements_window', 'latest_placement', 'recent', 'open_jobs', 'practices']
        .forEach((k) => expect(a.doctors[k], name + '.doctors.' + k).toEqual(b.doctors[k]));
    });
  });

  it('the gone-quiet sweep: the same email, the same sentinel, the same timeline note (the Australian threshold is behind its go-live guard)', () => {
    expect(got.stalled).toEqual(want.stalled);
    // The run said what it did for the Australian side, in its own key.
    expect(raw.stalled.first.body.au).toEqual({ stalled: 0, alerted: 0, threshold_days: 14, live_from: fx.NOW });
  });

  it('no Australian doctor appears under an overseas stage, and no overseas doctor in the Australian section', () => {
    const o = raw.endpoints.overview7.body;
    const overseasPart = JSON.stringify(Object.assign({}, o, { au: undefined, status: Object.assign({}, o.status, { consults: undefined, registration: Object.assign({}, o.status.registration, { docs_list: undefined, escalations: undefined }) }), needs: undefined }));
    expect(AU_MARK.test(overseasPart)).toBe(false);
    expect(/Testos/.test(JSON.stringify(o.au))).toBe(false);
    const d = raw.endpoints.dashboardCurrent.body;
    ['kpi', 'pipeline', 'blockers', 'gp_activity', 'completions', 'placements'].forEach((k) => expect(AU_MARK.test(JSON.stringify(d[k])), k).toBe(false));
    // The funnel email names only overseas stages, and counts only overseas doctors in them.
    const mail = raw.digest.forced.emails[0].html;
    const from = mail.indexOf('Registration funnel');
    const funnel = mail.slice(from, mail.indexOf('</p>', mail.indexOf('MyIntealth', from)));
    const before = want.digest.forced.emails[0].html;
    expect(funnel).toMatch(/MyIntealth: <strong>\d+<\/strong>/);
    expect(before.indexOf(funnel)).toBe(before.indexOf('Registration funnel'));
    expect(funnel).not.toMatch(/Pre-start|Guarantee|Matched/);
  });
});

describe('WP-27: the Australian section, from the same request', () => {
  const groupOf = {
    onboarding: 'onboarding', looking: 'looking', matched: 'matched', interview: 'interview', contract: 'contract',
    prestart: 'prestart', startReached: 'prestart', firstWeek: 'commenced', guarantee: 'guarantee', guaranteeEnding: 'guarantee',
    complete: 'complete', ended: 'ended', cycleTwo: 'matched', heldB: 'held', heldC: 'held',
    flags: 'looking', expiring: 'looking', mismatch: 'looking', nonDpa: 'matched'
  };

  it('every Australian doctor is in exactly one group, the one its facts say', () => {
    const p = raw.endpoints.overview7.body.au.pipeline;
    const where = {};
    p.columns.concat(p.before, p.closing, [p.held]).forEach((g) => g.doctors.forEach((d) => { (where[d.user_id] = where[d.user_id] || []).push(g.key); }));
    Object.keys(groupOf).forEach((key) => expect(where[AU[key].userId], key).toEqual([groupOf[key]]));
    expect(Object.keys(where).length).toBe(Object.keys(groupOf).length);
    expect(p.total).toBe(19);
    expect(p.columns.map((c) => [c.key, c.count])).toEqual([['matched', 3], ['interview', 1], ['contract', 1], ['prestart', 2], ['commenced', 1], ['guarantee', 2]]);
    expect(p.columns.map((c) => c.label)).toEqual(auPipeline.PIPELINE_COLUMNS.map((c) => c.label));
    // Held doctors are shown apart, never in a pipeline column.
    expect(p.held.count).toBe(2);
    p.columns.forEach((c) => c.doctors.forEach((d) => expect(['B', 'C'].indexOf(d.segment), d.name).toBe(-1)));
  });

  it('stages are words, and a placement line is truthful about a doctor who has started', () => {
    const body = raw.endpoints.overview7.body;
    const p = body.au.pipeline;
    const all = p.columns.concat(p.before, p.closing, [p.held]);
    all.forEach((g) => { expect(g.label).not.toMatch(/_|prestart|myintealth/i); g.doctors.forEach((d) => expect(d.group_label).toBe(g.label)); });
    const line = (key) => all.flatMap((g) => g.doctors).find((d) => d.user_id === AU[key].userId).start;
    expect(line('prestart').text).toBe('starts ' + '8 December 2026');
    expect(line('startReached').text).toMatch(/^was due to start 16 November 2026/);
    expect(line('firstWeek').text).toBe('started 15 November 2026');
    expect(line('guarantee').text).toMatch(/^started /);
    expect(line('ended').text).toMatch(/^ended /);
    // Never "starts <date>" for a doctor who has commenced.
    p.commenced.list.forEach((x) => expect(x.start.text).toMatch(/^(started|ended) /));
    expect(JSON.stringify(body.au)).not.toMatch(/MyIntealth|myintealth/);
    // The overseas "latest placement" is an overseas placement.
    expect(body.doctors.latest_placement.practice_name).toBe('Test Regional Practice (FAKE)');
    expect(body.doctors.latest_placement.start_date).toBe(fx.dayAt(60));
  });

  it('Australian timings are their own numbers, in days, never blended with overseas', () => {
    const p = raw.endpoints.overview7.body.au.pipeline;
    expect(p.timing.application_to_placement.sample_size).toBe(8);
    expect(p.timing.application_to_placement.median_days).toBeLessThan(30);
    expect(p.commenced).toMatchObject({ total: 6, window: 1 });
    // The overseas figure is exactly what it was with no Australian doctor.
    expect(raw.endpoints.conversionAll.body.time_to_placement).toEqual(want.endpoints.conversionAll.body.time_to_placement);
    expect(want.endpoints.conversionAll.body.time_to_placement.from_application).toEqual({ avg_days: 36, median_days: 36, sample_size: 1 });
  });

  it('the commercial tile is auPlacementCommercialSummary(), figure for figure', async () => {
    const tile = raw.endpoints.overview7.body.au.commercial;
    const hook = await h.testUtils.auPlacementCommercialSummary(fx.NOW_MS);
    expect(hook.ok).toBe(true);
    expect(tile.counts).toEqual(hook.counts);
    expect(tile.counts).toEqual({ invoicesDue: 3, invoicesOverdue: 2, inGuarantee: 3, guaranteeEndingSoon: 1 });
    const strip = (list) => list.map((x) => { const c = Object.assign({}, x); delete c.gp_name; delete c.case_id; return c; }).sort((a, b) => String(a.placement_id).localeCompare(String(b.placement_id)));
    const byId = (list) => JSON.parse(JSON.stringify(list)).sort((a, b) => String(a.placement_id).localeCompare(String(b.placement_id)));
    expect(strip(tile.invoices_due)).toEqual(byId(hook.invoicesDue));
    expect(strip(tile.in_guarantee)).toEqual(byId(hook.inGuarantee));
    expect(strip(tile.guarantee_ending_soon)).toEqual(byId(hook.guaranteeEndingSoon));
    expect(tile.invoices_due.every((x) => /^Dr Testau /.test(x.gp_name))).toBe(true);
  });

  it('GET /api/ceo/au-pipeline gives the CEO the same section', async () => {
    const res = await h.get('/api/ceo/au-pipeline?window=7d', h.superAdmin());
    expect(res.status).toBe(200);
    const mine = parity.normalise(res.json.au);
    expect(mine.pipeline.columns).toEqual(raw.endpoints.overview7.body.au.pipeline.columns);
    expect(mine.commercial).toEqual(raw.endpoints.overview7.body.au.commercial);
    expect(mine.review.count).toBe(13);
  });

  it('ROLE SCOPING: a consultant gets the pipeline with no fee, invoice or credit figure; an RSO is refused; the Overview stays CEO-only', async () => {
    const co = await h.get('/api/ceo/au-pipeline', h.consultant());
    expect(co.status).toBe(200);
    expect(co.json.viewer_role).toBe('consultant');
    expect(co.json.au.pipeline.columns.map((c) => c.count)).toEqual([3, 1, 1, 2, 1, 2]);
    expect('commercial' in co.json.au).toBe(false);
    expect(co.raw).not.toMatch(/fee_amount|fee_tier|invoice|credit|15000|10000|INV-FAKE/i);
    expect(co.json.au.review.items.every((it) => ['au_invoice_overdue', 'au_credit_decision'].indexOf(it.kind) === -1)).toBe(true);
    expect(co.json.au.review.count).toBe(9);
    const rso = await h.get('/api/ceo/au-pipeline', h.rso());
    expect([401, 403, 404]).toContain(rso.status);
    expect(String(rso.raw)).not.toMatch(/Testau/);
    expect((await h.get('/api/ceo/overview', h.consultant())).status).toBe(403);
    expect((await h.get('/api/ceo/review-queue', h.consultant())).status).toBe(403);
    // The CEO does see the amounts.
    expect(JSON.stringify(raw.endpoints.overview7.body.au.commercial)).toMatch(/"fee_amount_ex_gst":15000/);
  });

  it('switch off: the route does not exist and the Overview has no Australian section', async () => {
    h.setSwitch(false);
    try {
      expect((await h.get('/api/ceo/au-pipeline', h.superAdmin())).status).toBe(404);
      const o = await h.get('/api/ceo/overview?window=7d', h.superAdmin());
      expect('au' in o.json).toBe(false);
      expect((await h.post('/api/ceo/au/19ab-mismatch/reviewed', { case_id: AU.mismatch.caseId }, h.superAdmin())).status).toBe(404);
    } finally { h.setSwitch(true); }
  });
});

describe('WP-27 (N22): the digest\'s Australian block', () => {
  const lines = () => {
    const html = raw.digest.forced.emails[0].html;
    const start = html.indexOf('>Australian GPs (already registered here)<');
    return html.slice(start + 1).replace(/<\/p>|<\/li>|<\/ul>/g, '\n').replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').split('\n').map((s) => s.trim()).filter(Boolean);
  };
  it('says where every Australian doctor is, what moved this week, the money counts and what needs the owner', () => {
    const l = lines();
    expect(l[0]).toBe('Australian GPs (already registered here)');
    expect(l[1]).toBe('Matched: 3 · Interview: 1 · Contract: 1 · Pre-start: 2 · Commenced: 1 · Guarantee: 2');
    expect(l[2]).toBe('Not in the pipeline: Finishing their profile: 1 · Looking, not yet matched: 4 · Complete: 1 · Ended: 1 · On hold (segment B or C, not launched): 2');
    expect(l[3]).toBe('This week: New Australian leads: 1 (same as last week) · New sign-ups: 1 (same as last week) · Applications: 1 (-1 vs last week) · Interviews booked: 1 (same as last week) · Placements recorded: 0 (same as last week) · Commenced: 0 (-1 vs last week)');
    expect(l[4]).toBe('Awaiting an Ahpra register check: 0 · Placements recorded: 8 · Commenced: 6 · typical time from application to placement: 2.3 weeks');
    expect(l[5]).toBe('Invoices due: 3 (2 unpaid past terms) · In the guarantee period: 3 · Guarantee ending within 14 days: 1');
    expect(l[6]).toBe('Needs you: 13 items');
    expect(l.slice(7, 12).every((x) => /: Dr Testau /.test(x))).toBe(true);
    expect(l[12]).toBe('and 8 more in the review queue');
  });
  it('W3-D24: the Australian interview booked this week is counted, and the overseas "Interviews booked" row is what it was', () => {
    expect(lines()[3]).toContain('Interviews booked: 1');
    const row = (html) => { const i = html.indexOf('>Interviews booked<'); return html.slice(i, i + 260); };
    expect(row(raw.digest.forced.emails[0].html)).toBe(row(want.digest.forced.emails[0].html));
  });
  it('an Australian doctor is never listed under MyIntealth, and the block carries no amount or contact detail', () => {
    const html = raw.digest.forced.emails[0].html;
    const block = html.slice(html.indexOf('>Australian GPs (already registered here)<'));
    expect(block.split('View full dashboard')[0]).not.toMatch(/MyIntealth|AMC|\$\d|@gplink-test|MED\d/);
  });
  it('the scheduled digest carries the same block, once a week', () => {
    expect(raw.digest.cron.emails.length).toBe(1);
    expect(raw.digest.cron.emails[0].html).toBe(raw.digest.forced.emails[0].html);
    expect(raw.digest.cronAgain.emails).toEqual([]);
  });
});
