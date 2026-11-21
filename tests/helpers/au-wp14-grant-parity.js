'use strict';
/**
 * WP-14 overseas parity, on the real server: an OVERSEAS doctor's AHPRA final
 * notice ("registration granted") does exactly what it did before WP-14.
 *
 * `captureGrant(root)` boots the server found under `root` against the
 * in-memory database stub, runs handleAhpraRegistrationGranted for a fake
 * overseas doctor (nothing recorded: the regression doctor), once with the
 * switch ON and once with it OFF, and returns everything it produced with ids
 * and times removed: the case row, every task, the visa case, the passport
 * request rows, the dependants, the timeline, and every outbound call.
 *
 * tests/fixtures/au-wp14-grant-parity.snapshot.json was written by running
 * this against the tree at commit 4b08e987 (the commit WP-14 started from):
 *   git archive 4b08e987 | tar -x -C /tmp/base      (plus a node_modules link)
 *   NODE_ENV=test node tests/helpers/au-wp14-grant-parity.js /tmp/base tests/fixtures/au-wp14-grant-parity.snapshot.json
 * The test runs it against the working tree and compares.
 */
const path = require('path');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

function scrub(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value).replace(UUID, '<id>').replace(ISO, '<time>').replace(/"ts":\d+/g, '"ts":0'));
}
function metaOf(row) {
  let m = row.metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = {}; } }
  return m && typeof m === 'object' ? m : {};
}

const EMPTY = ['task_timeline', 'task_messages', 'task_documents', 'user_documents', 'visa_applications', 'visa_documents', 'visa_dependants',
  'visa_timeline_events', 'visa_updates', 'ats_offers', 'gp_applications', 'placements', 'practices', 'gp_nudge_log', 'practice_doc_ops',
  'admin_audit_log', 'processed_gmail_messages'];

async function runOnce(h, fixtures, outbound, switchOn) {
  const d = fixtures.buildAuDoctor('overseas_null', {
    idSuffix: 'gpar',
    caseRow: { stage: 'ahpra', practice_name: 'Test Regional Practice (FAKE)', ahpra_application_number: null },
    profile: { who_moving: 'me_partner_children', children_count: '2', first_name: 'Test', last_name: 'Grantparity' }
  });
  // The same starting rows for both runs, replaced in place.
  const db = Object.assign(fixtures.buildAuFixtureDb([d]), {
    registration_tasks: [
      { id: 'open-ahpra-task', case_id: d.caseId, task_type: 'ahpra_correspondence', related_stage: 'ahpra', status: 'open', title: 'AHPRA correspondence', metadata: {}, created_at: '2026-11-01T00:00:00.000Z' }
    ]
  });
  EMPTY.forEach((name) => { if (!db[name]) db[name] = []; });
  Object.keys(h.emu.db).forEach((name) => { if (name !== 'rso_team') h.emu.db[name].length = 0; });
  Object.keys(db).forEach((name) => { const target = h.emu.table(name); db[name].forEach((row) => target.push(JSON.parse(JSON.stringify(row)))); });
  h.emu.reset();
  outbound.length = 0;

  h.setSwitch(switchOn);
  const summary = await h.testUtils.handleAhpraRegistrationGranted({
    caseId: d.caseId, userId: d.userId, source: { type: 'manual' }, actor: 'staff.test@gplink-test.local',
    registration: {
      registration_number: 'MED0001234567', registration_type: 'Specialist', effective_date: '2026-11-02', expiry_date: '2027-09-30',
      has_conditions: true,
      conditions: { summary: 'Supervised practice', supervised_practice: { level: 'Indirect 2', supervisor: 'Dr Fake Supervisor', commencement_date: '2027-01-25' } }
    },
    attachments: []
  });
  await new Promise((r) => setTimeout(r, 300));
  const caseRow = h.emu.table('registration_cases').find((c) => c.id === d.caseId) || {};
  const pick = (row, keys) => { const out = {}; keys.forEach((k) => { out[k] = row[k] === undefined ? null : row[k]; }); return out; };
  return scrub({
    summary: { ok: summary.ok, already: summary.already, stage: summary.stage, hasVisaCase: !!summary.visaCaseId, dependants: summary.dependants, passportRequests: summary.passportRequests,
      filed: summary.filed, closed: (summary.closed || []).length, tasks: (summary.tasks || []).length, errors: summary.errors, skipped: summary.skipped || null },
    caseRow: pick(caseRow, ['stage', 'substage', 'gp_verified_stage', 'ahpra_registration_number', 'ahpra_registration_type', 'ahpra_registration_effective_date',
      'ahpra_registration_expiry_date', 'ahpra_registration_has_conditions', 'ahpra_registration_conditions', 'sponsor_name', 'pathway']),
    caseHasVisaLink: !!caseRow.visa_case_id,
    tasks: h.emu.table('registration_tasks').map((t) => ({
      task_type: t.task_type, title: t.title, status: t.status || null, priority: t.priority || null, related_stage: t.related_stage || null,
      source_trigger: t.source_trigger || null, domain: t.domain || null, has_visa_case: !!t.visa_case_id, has_due: !!t.due_date,
      metadata_keys: Object.keys(metaOf(t)).sort(), description: t.description || null,
      outbound_email: metaOf(t).outbound_email ? { subject: metaOf(t).outbound_email.subject, bodyText: metaOf(t).outbound_email.bodyText } : null,
      gp_request: metaOf(t).gp_request ? { email: metaOf(t).gp_request.email, whatsapp: metaOf(t).gp_request.whatsapp, people: metaOf(t).gp_request.people } : null
    })),
    visaApplications: h.emu.table('visa_applications').map((v) => { const o = Object.assign({}, v); delete o.id; delete o.user_id; delete o.created_at; delete o.updated_at; return o; }),
    visaDocuments: h.emu.table('visa_documents').map((v) => ({ label: v.label || null, status: v.status || null, document_type: v.document_type || null, has_dependant: !!v.dependant_id })),
    visaDependants: h.emu.table('visa_dependants').map((v) => ({ relationship: v.relationship || null, full_name: v.full_name || null })),
    visaTimeline: h.emu.table('visa_timeline_events').map((v) => ({ title: v.event_title, visible: v.visible_to_gp })),
    timeline: h.emu.table('task_timeline').map((x) => ({ event_type: x.event_type, title: x.title, detail: x.detail || null, actor: x.actor || null })),
    state: (function () { const row = h.emu.table('user_state').find((r) => r.user_id === d.userId); const st = row && row.state ? Object.assign({}, row.state) : {}; delete st.updated_at; return st; })(),
    outbound: outbound.slice().sort(),
    tablesWritten: h.emu.requests.filter((r) => r.method !== 'GET').map((r) => r.method + ' ' + r.table).sort()
  });
}

async function captureGrant(root) {
  const { bootAuTestServer } = require(path.join(root, 'tests', 'helpers', 'au-server-harness.js'));
  const fixtures = require(path.join(root, 'tests', 'helpers', 'au-fixtures.js'));
  const h = await bootAuTestServer({
    name: 'wp14-grant-parity', tables: fixtures.buildAuFixtureDb([]),
    env: { RESEND_API_KEY: 'test-resend-key', DOUBLETICK_API_KEY: 'test-doubletick-key', NOTIFY_TEST_RECIPIENTS: '', APP_BASE_URL: 'https://app.gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' }, visa_applications: { stage: 'nomination' } } }
  });
  const outbound = [];
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('http://127.0.0.1') === 0) return harnessFetch(url, init);
    outbound.push(u.replace(/\?.*$/, ''));
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  try {
    const switchOn = await runOnce(h, fixtures, outbound, true);
    const switchOff = await runOnce(h, fixtures, outbound, false);
    return { switchOn, switchOff };
  } finally {
    globalThis.fetch = harnessFetch;
    await h.close();
  }
}

module.exports = { captureGrant };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  // The server logs to stdout, so the snapshot is written to the file named as the second argument.
  const outFile = process.argv[3];
  if (!outFile) { console.error('usage: node au-wp14-grant-parity.js <root> <out.json>'); process.exit(2); }
  captureGrant(root).then((out) => { require('fs').writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n'); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
