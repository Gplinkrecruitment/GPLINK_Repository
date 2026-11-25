'use strict';

/**
 * WP-30 parity: every route WP-30 touched, walked on the REAL server, so that
 * two states can be compared word for word.
 *
 *   computeAreaParity(h)  the WP-23 practice walk (website lead x3, the Meta
 *                         webhook, intake load / save / reload, the agreement,
 *                         signing, the pending job, approval, the public
 *                         board), then: the two public area checks, a second
 *                         intake save with a changed address, the staff
 *                         practice list / record, the job editor (read, a DPA
 *                         change, an address change), the staff "Add a job",
 *                         and each address WP-30 added.
 *
 * tests/fixtures/au-wp30-before.snapshot.json was written by this file on the
 * tree BEFORE WP-30 changed anything (commit 34692cbe of au-gp-testing), once
 * with the Australian switch off and once with it on. Never regenerate it to
 * make a test pass.
 *
 * Every identity here is fake. Nothing is sent: outbound requests are answered
 * by the test harness with an empty reply.
 */

const wp23 = require('./au-wp23-parity.js');

const copy = function (v) { return JSON.parse(JSON.stringify(v === undefined ? null : v)); };

function clearTables(h) {
  wp23.EMPTY_TABLES.forEach(function (name) { h.emu.table(name).length = 0; });
  h.reset();
  if (h.emu.reset) h.emu.reset();
}

async function computeAreaParity(h) {
  const out = {};
  const table = function (name) { return h.emu.table(name); };
  const byEmail = function (email) { return table('practices').filter(function (p) { return p.contact_email === email; })[0] || null; };
  const sa = h.superAdmin();
  const scrub = wp23.makeScrubber();
  const note = function (row, label) {
    if (!row) return;
    scrub.add(row.id, label + '-id'); scrub.add(row.intake_token, label + '-token'); scrub.add(row.group_id, label + '-group');
  };

  // 1. The practice front door, start to finish (the WP-23 walk, unchanged).
  const front = await wp23.computePracticeParity(h);
  out.intakePageFile = front.files.intakePage;
  delete front.files.intakePage;
  out.front = front;

  const metro = byEmail('practice.metro.test@gplink-test.local');
  const dpaLead = byEmail('practice.dpa.test@gplink-test.local');
  const unknownLead = byEmail('practice.unknown.test@gplink-test.local');
  note(metro, 'metro'); note(dpaLead, 'dpa-lead'); note(unknownLead, 'unknown-lead');
  note(byEmail('practice.meta.test@gplink-test.local'), 'meta');
  table('practice_groups').forEach(function (g, i) { scrub.add(g.id, 'group-' + i); });
  const job = table('career_roles').filter(function (j) { return j.practice_id === metro.id; })[0];
  scrub.add(job.id, 'job-id'); scrub.add(job.provider_role_id, 'provider-role-id');
  table('site_enquiries').forEach(function (e, i) { scrub.add(e.id, 'enquiry-' + i); });

  // 2. The two public area checks.
  const dpaSuburb = await h.get('/api/public/practice-dpa?suburb=Dubbo&state=NSW');
  const dpaSuburbBad = await h.get('/api/public/practice-dpa?state=NSW');
  const dpaPoint = await h.get('/api/dpa/check?lat=-32.2569&lon=148.6011');
  const dpaPointBad = await h.get('/api/dpa/check');
  out.areaChecks = {
    suburb: { status: dpaSuburb.status, json: dpaSuburb.json }, suburbMissing: { status: dpaSuburbBad.status, json: dpaSuburbBad.json },
    point: { status: dpaPoint.status, json: dpaPoint.json }, pointMissing: { status: dpaPointBad.status, json: dpaPointBad.json }
  };

  // 3. A second practice fills its intake, then saves it again with another address.
  const clinicA = Object.assign(wp23.intakeClinic('dpa'), { practice_name: 'Test dpa Practice (FAKE)' });
  const saveA = await h.post('/api/practice-intake', { token: dpaLead.intake_token, practices: [clinicA] });
  const afterA = copy(byEmail('practice.dpa.test@gplink-test.local'));
  const clinicB = Object.assign({}, clinicA, { address: '7 Fake Lane, Orange NSW 2800', suburb: 'Orange', postcode: '2800', nearest_city: 'Orange', latitude: null, longitude: null, google_place_id: '', dpa: 'no', dpa_suggested: null, mmm: '' });
  const saveB = await h.post('/api/practice-intake', { token: dpaLead.intake_token, practices: [clinicB] });
  const afterB = copy(byEmail('practice.dpa.test@gplink-test.local'));
  const loadB = await h.get('/api/practice-intake?token=' + encodeURIComponent(dpaLead.intake_token));
  if (saveA.json) scrub.add(saveA.json.group_id, 'dpa-lead-group');
  table('practice_groups').forEach(function (g, i) { scrub.add(g.id, 'group-' + i); });
  out.resubmit = {
    first: { status: saveA.status, json: saveA.json, stored: afterA },
    second: { status: saveB.status, json: saveB.json, stored: afterB },
    reload: { status: loadB.status, json: loadB.json }
  };

  // 4. Staff: the practice list and one practice record.
  const list = await h.get('/api/ats/practices', sa);
  const record = await h.get('/api/ats/practice?id=' + encodeURIComponent(metro.id), sa);
  const leadRecord = await h.get('/api/ats/practice?id=' + encodeURIComponent(unknownLead.id), sa);
  out.staffPractices = {
    list: { status: list.status, json: list.json },
    record: { status: record.status, json: record.json },
    leadRecord: { status: leadRecord.status, json: leadRecord.json }
  };

  // 5. Staff: the job editor. Read, change the DPA answer, change the address.
  const jobRow = function () { return copy(table('career_roles').filter(function (j) { return j.id === job.id; })[0] || null); };
  const jobGet = await h.get('/api/ats/job?id=' + encodeURIComponent(job.id), sa);
  const patchDpa = await h.request('PATCH', '/api/ats/job?id=' + encodeURIComponent(job.id), Object.assign({ body: { dpa: true } }, sa));
  const afterDpa = jobRow();
  const patchMmm = await h.request('PATCH', '/api/ats/job?id=' + encodeURIComponent(job.id), Object.assign({ body: { mmm: 'MM2', address: '9 New Street, Surry Hills NSW 2010' } }, sa));
  const afterMmm = jobRow();
  const patchTitle = await h.request('PATCH', '/api/ats/job?id=' + encodeURIComponent(job.id), Object.assign({ body: { summary: 'An updated summary (FAKE).' } }, sa));
  out.staffJob = {
    get: { status: jobGet.status, json: jobGet.json },
    patchDpa: { status: patchDpa.status, json: patchDpa.json, stored: afterDpa },
    patchMmmAndAddress: { status: patchMmm.status, json: patchMmm.json, stored: afterMmm },
    patchSummary: { status: patchTitle.status, json: patchTitle.json, stored: jobRow() }
  };

  // 6. Staff add a job with full details for the same practice, at another address.
  const addIntake = Object.assign(wp23.intakeClinic('dpa'), { practice_name: '' });
  ['latitude', 'longitude', 'google_place_id', 'dpa_suggested', 'postcode'].forEach(function (k) { delete addIntake[k]; });
  const add = await h.post('/api/ats/jobs', { practice_id: metro.id, intake: addIntake }, sa);
  const added = table('career_roles').filter(function (j) { return j.practice_id === metro.id && j.id !== job.id; })[0] || null;
  if (added) { scrub.add(added.id, 'added-job-id'); scrub.add(added.provider_role_id, 'added-provider-role-id'); }
  out.staffAddJob = { status: add.status, json: add.json, stored: copy(added) };
  // ... and one through the short form (a title and a place, nothing else).
  const addShort = await h.post('/api/ats/jobs', { title: 'Short-form role (FAKE)', practice_id: metro.id, city: 'Surry Hills', state: 'NSW', billing: 'mixed', type: 'full_time', summary: 'A fake role.' }, sa);
  const addedShort = table('career_roles').filter(function (j) { return j.title === 'Short-form role (FAKE)'; })[0] || null;
  if (addedShort) { scrub.add(addedShort.id, 'short-job-id'); scrub.add(addedShort.provider_role_id, 'short-provider-role-id'); }
  out.staffAddShortJob = { status: addShort.status, json: addShort.json, stored: copy(addedShort) };

  // 7. The addresses WP-30 added. Before WP-30 (and whenever WP-30 is off) they are not routes at all.
  const probes = {};
  for (const item of [
    ['intakeArea', '/api/practice-intake/area', { token: metro.intake_token, address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW' }, null],
    ['intakeAreaNote', '/api/practice-intake/area-note', { token: metro.intake_token, note: 'This looks wrong to us' }, null],
    ['staffPracticeArea', '/api/ats/practice/area', { id: metro.id, action: 'recheck' }, sa],
    ['staffJobArea', '/api/ats/job/area', { id: job.id, action: 'recheck' }, sa],
    ['staffCheckAll', '/api/ats/practices/area/check-all', {}, sa]
  ]) {
    const res = await h.post(item[1], item[2], item[3] || undefined);
    probes[item[0]] = { status: res.status, raw: res.raw };
  }
  out.newAddresses = probes;

  // 8. What is left in the database for the practices and roles touched.
  out.finalRows = {
    practices: copy(table('practices')).sort(function (a, b) { return String(a.contact_email).localeCompare(String(b.contact_email)); }),
    roles: copy(table('career_roles')).sort(function (a, b) { return String(a.title + a.address).localeCompare(String(b.title + b.address)); }),
    auditActions: table('admin_audit_log').map(function (r) { return r.action; }).sort()
  };
  return scrub.clean(out);
}

module.exports = { computeAreaParity, clearTables };
