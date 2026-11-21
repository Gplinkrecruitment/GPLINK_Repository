'use strict';

/**
 * WP-11 test rig: boots the real server (AU harness + emulator) with a fake
 * practice, one role and, per doctor, an application with an offer on the
 * table and a contract ready to sign. It records EVERYTHING a placement
 * produces: every Resend email, every DoubleTick WhatsApp, every Google Drive
 * call (a fake client: nothing real is reached), and reads the tasks, timeline,
 * bell items and documents straight from the emulator.
 *
 *   const rig = await bootPlacementRig({ name: 'wp11', doctors: [d] });
 *   await rig.place(d, 'ats_placement');        // one of rig.ENTRY_POINTS
 *   const out = rig.capture(d);                 // tasks, emails, whatsapps, bell, ...
 *   await rig.close();
 *
 * `rig.normalise(capture)` strips ids and timestamps so two runs compare equal
 * (used by the overseas before/after snapshot).
 */

const { bootAuTestServer } = require('./au-server-harness.js');
const { buildAuFixtureDb, fakeUuid } = require('./au-fixtures.js');

const PRACTICE_ID = fakeUuid('p', '911');
const ROLE_ID = 9111;
const PRACTICE_NAME = 'Test Metro Practice (FAKE)';
const PRACTICE_EMAIL = 'manager@metro-practice.gplink-test.local';
const PRACTICE_PHONE = '+61400000911';
const ROLE_TITLE = 'General Practitioner (FAKE role)';
const NOW = '2026-11-01T00:00:00.000Z';
const START_DATE = '2027-02-01';

// Every way a placement is (or may be) recorded. See docs/au-gp/CONVENTIONS.md
// section 23 for what each one is.
const ENTRY_POINTS = Object.freeze([
  'finalize',          // finalizeInAppPlacement called directly
  'ats_placement',     // POST /api/ats/placement (staff "Mark placement secured")
  'ops_record',        // POST /api/admin/ops/record-placement
  'finalize_signed',   // POST /api/career/contract/finalize-signed (the doctor signs)
  'state_put',         // PUT /api/state after the placement is already on record
  'ops_replay',        // POST /api/admin/ops/replay-career-secured
  'cases_sync'         // POST /api/admin/cases/sync
]);

function appIdFor(doctor) { return fakeUuid('a', String(doctor.userId).slice(-6)); }
function offerIdFor(doctor) { return fakeUuid('f', String(doctor.userId).slice(-6)); }
function contractIdFor(doctor) { return fakeUuid('c', String(doctor.userId).slice(-6)); }

function freshApplication(doctor, extra) {
  return Object.assign({
    id: appIdFor(doctor),
    user_id: doctor.userId,
    career_role_id: ROLE_ID,
    provider_role_id: 'ats_wp11_role',
    status: 'offer',
    ats_stage: 'offer',
    origin: 'gp_applied',
    practice_id: PRACTICE_ID,
    practice_submission_status: 'client_approved',
    practice_action_token: null,
    submitted_to_practice_at: NOW,
    practice_contact_email: PRACTICE_EMAIL,
    practice_contact_name: 'Test Manager',
    practice_decision: 'approved',
    withdrawn_at: null,
    match_outcome: null,
    zoho_submission_id: null,
    zoho_application_id: null,
    applied_at: NOW,
    updated_at: NOW,
    ats_stage_updated_at: NOW
  }, extra || {});
}
function freshOffer(doctor, extra) {
  return Object.assign({
    id: offerIdFor(doctor),
    application_id: appIdFor(doctor),
    user_id: doctor.userId,
    career_role_id: ROLE_ID,
    practice_id: PRACTICE_ID,
    job_title: ROLE_TITLE,
    practice_name: PRACTICE_NAME,
    billing_split: '70%',
    sessions_per_week: '8',
    compensation_range: '',
    relocation_package: '',
    start_date: START_DATE,
    notes: '',
    contract_document_key: null,
    status: 'sent',
    sent_by: 'consultant.test@gplink-test.local',
    sent_at: NOW,
    responded_at: null,
    created_at: NOW,
    updated_at: NOW
  }, extra || {});
}
function freshContract(doctor, extra) {
  return Object.assign({
    id: contractIdFor(doctor),
    application_id: appIdFor(doctor),
    user_id: doctor.userId,
    version: 1,
    status: 'sent_to_gp',
    bucket: 'gp-link-documents',
    path: 'contracts/' + appIdFor(doctor) + '/v1/contract.pdf',
    filename: 'contract.pdf',
    mime_type: 'application/pdf',
    created_at: NOW,
    updated_at: NOW
  }, extra || {});
}

// A recording stand-in for the googleapis Drive client. Every call is pushed
// onto `calls` as { api: 'files.create', args }, and answered with the smallest
// shape the server reads.
function makeFakeDrive() {
  const calls = [];
  let seq = 0;
  function answer(api, args) {
    calls.push({ api, args });
    if (api === 'files.create') { seq += 1; return Promise.resolve({ data: { id: 'drv-' + seq, name: (args && args.requestBody && args.requestBody.name) || '', webViewLink: 'https://drive.invalid/file/drv-' + seq } }); }
    if (api === 'files.list') return Promise.resolve({ data: { files: [] } });
    if (api === 'files.get') return Promise.resolve({ data: { id: (args && args.fileId) || '', name: '', parents: [], webViewLink: '' } });
    return Promise.resolve({ data: {} });
  }
  const group = function (name) {
    return new Proxy({}, { get: function (_t, method) { return function (args) { return answer(name + '.' + String(method), args); }; } });
  };
  return { client: { files: group('files'), permissions: group('permissions') }, calls };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
function scrub(text) {
  return String(text == null ? '' : text).replace(ISO_RE, '<time>').replace(UUID_RE, '<id>');
}

async function bootPlacementRig(opts) {
  const o = opts || {};
  const doctors = o.doctors || [];
  const tables = Object.assign(buildAuFixtureDb(doctors), {
    practices: [{
      id: PRACTICE_ID, name: PRACTICE_NAME, source: 'internal_ats',
      contact_name: 'Test Manager', contact_email: PRACTICE_EMAIL, contact_phone: PRACTICE_PHONE,
      location_state: 'NSW', location_city: 'Parramatta', is_active: true, created_at: NOW
    }],
    career_roles: [{
      id: ROLE_ID, provider: 'internal_ats', provider_role_id: 'ats_wp11_role', title: ROLE_TITLE,
      practice_name: PRACTICE_NAME, practice_id: PRACTICE_ID, location_city: 'Parramatta', location_state: 'NSW',
      dpa: false, is_active: true, created_at: NOW, approval_status: 'approved', job_status: 'open', ats_created: true,
      updated_at: NOW, published_at: NOW, location_country: 'Australia', suburb: 'Parramatta', nearest_city: 'Sydney', tags: [],
      masked_title: 'Non-DPA - Parramatta - Mixed Billing', billing_model: 'mixed', mixed_billing: true, mmm: 'MM1', metro: true,
      positions_needed: 5
    }],
    gp_applications: doctors.map(function (d) { return freshApplication(d, (o.applicationExtra || {})[d.userId]); }),
    ats_offers: doctors.map(function (d) { return freshOffer(d); }),
    career_contracts: doctors.map(function (d) { return freshContract(d); }),
    placements: [], user_documents: [], registration_tasks: [], task_timeline: [], task_documents: [], task_messages: [],
    practice_doc_ops: [], push_subscriptions: [], notification_preferences: [], ats_stage_events: [], scheduled_calls: [],
    career_interviews: [], admin_audit_log: [], gp_nudge_log: [], visa_cases: [], pbs_cases: [], support_tickets: []
  }, o.tables || {});

  const h = await bootAuTestServer({
    name: o.name || 'wp11',
    tables,
    emulator: Object.assign({ rpc: { rate_limit_hit: function () { return { allowed: true }; } } }, o.emulator || {}),
    env: Object.assign({
      RESEND_API_KEY: 're_test_wp11',
      DOUBLETICK_API_KEY: 'dt_test_wp11',
      DOUBLETICK_BASE_URL: 'https://doubletick.invalid',
      HAZEL_WHATSAPP_NUMBER: '+61494391968',
      APP_BASE_URL: 'https://app.gplink-test.local',
      // Drive reads as configured, but the client is the recorder below.
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'drive-test@gplink-test.local',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'not-a-real-key',
      GOOGLE_DRIVE_ROOT_FOLDER_ID: 'drv-root-test'
    }, o.env || {})
  });
  const drive = makeFakeDrive();
  h.testUtils.__setGoogleDriveClientForTest(drive.client);

  const emails = [];
  const whatsapps = [];
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    let body = null;
    try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch (e) { body = null; }
    if (u.indexOf('https://api.resend.com/') === 0) {
      emails.push(body);
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + emails.length }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (u.indexOf('https://doubletick.invalid') === 0) {
      if (u.indexOf('/whatsapp/message/') !== -1) whatsapps.push(body);
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'wa-' + whatsapps.length }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return harnessFetch(url, init);
  };

  const t = h.testUtils;
  const table = function (name) { return h.emu.table(name); };
  const caseOf = function (d) { return table('registration_cases').find(function (c) { return c.user_id === d.userId; }) || null; };
  const stateOf = function (d) {
    const row = table('user_state').find(function (r) { return r.user_id === d.userId; });
    return row ? row.state : null;
  };
  const settle = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 60); }); };

  /** Add a doctor (and their application, offer and contract) to the running rig. */
  function addDoctor(d, extra) {
    const db = buildAuFixtureDb([d]);
    Object.keys(db).forEach(function (name) { db[name].forEach(function (row) { table(name).push(row); }); });
    table('gp_applications').push(freshApplication(d, extra && extra.application));
    table('ats_offers').push(freshOffer(d, extra && extra.offer));
    table('career_contracts').push(freshContract(d, extra && extra.contract));
    return d;
  }

  /**
   * Record a placement for `d` through one entry point. Returns the HTTP
   * response where there is one. `io.commencementDate` (default START_DATE)
   * is passed where the entry point takes one; pass null to leave it out.
   */
  async function place(d, entry, io) {
    const i = io || {};
    const appId = appIdFor(d);
    const commencement = Object.prototype.hasOwnProperty.call(i, 'commencementDate') ? i.commencementDate : START_DATE;
    const app = table('gp_applications').find(function (a) { return a.id === appId; });
    const offer = table('ats_offers').find(function (x) { return x.application_id === appId; });
    let res = null;
    if (entry === 'finalize') {
      await t.finalizeInAppPlacementForTest(Object.assign({}, app), Object.assign({}, offer), d.userId, d.email,
        { placementConfirmed: true, commencementDate: commencement });
    } else if (entry === 'ats_placement') {
      res = await h.post('/api/ats/placement', Object.assign({ applicationId: appId }, commencement ? { commencementDate: commencement } : {}), i.staff || h.consultant());
    } else if (entry === 'ops_record') {
      res = await h.post('/api/admin/ops/record-placement',
        Object.assign({ application_id: appId, start_date: START_DATE }, commencement ? { commencement_date: commencement } : {}),
        i.staff || h.superAdmin());
    } else if (entry === 'finalize_signed') {
      res = await h.post('/api/career/contract/finalize-signed',
        { applicationId: appId, filename: 'signed-contract.pdf', mimeType: 'application/pdf' },
        { cookie: h.gpCookie(d.email, d.userId) });
    } else if (entry === 'state_put' || entry === 'ops_replay' || entry === 'cases_sync') {
      // The placement is already on record (a Zoho-synced placement, or one
      // recorded while nothing was listening): the application says secured,
      // the placement row exists, and the doctor's own mirror says secured.
      // (io.repeat: the same call again, with nothing re-seeded.)
      if (!i.repeat) {
        app.status = 'placement_secured';
        app.ats_stage = 'hired';
        offer.status = 'accepted';
        table('placements').push({
          id: fakeUuid('b', String(d.userId).slice(-6)), user_id: d.userId, application_id: appId, career_role_id: ROLE_ID,
          practice_id: PRACTICE_ID, practice_name: PRACTICE_NAME, job_title: ROLE_TITLE, start_date: commencement || null,
          status: 'active', placed_at: NOW, created_at: NOW
        });
      }
      const securedCareer = { career_secured: true, applications: [{ id: appId, status: 'placement_secured', isPlacementSecured: true, placement: { practiceName: PRACTICE_NAME } }] };
      if (entry === 'state_put') {
        res = await h.put('/api/state', { state: { gp_career_state: securedCareer }, updatedAt: new Date().toISOString() },
          { cookie: h.gpCookie(d.email, d.userId) });
      } else {
        const row = table('user_state').find(function (r) { return r.user_id === d.userId; });
        if (row && !i.repeat) row.state = Object.assign({}, row.state, { gp_career_state: securedCareer });
        if (entry === 'ops_replay') {
          res = await h.post('/api/admin/ops/replay-career-secured', { user_id: d.userId }, i.staff || h.superAdmin());
        } else {
          res = await h.post('/api/admin/cases/sync', {}, i.staff || h.superAdmin());
        }
      }
    } else {
      throw new Error('unknown entry point ' + entry);
    }
    // Several sends are fire-and-forget: let them land before reading back.
    await settle(i.settleMs || 250);
    return res;
  }

  /** Everything on record for one doctor after a placement. */
  function capture(d) {
    const c = caseOf(d);
    const caseId = c ? c.id : null;
    const state = stateOf(d) || {};
    let bell = state.gp_link_updates;
    if (typeof bell === 'string') { try { bell = JSON.parse(bell); } catch (e) { bell = []; } }
    const app = table('gp_applications').find(function (a) { return a.id === appIdFor(d); }) || {};
    const toList = function (v) { return Array.isArray(v) ? v : (v ? [v] : []); };
    const mine = function (e) { return toList(e && e.to).some(function (x) { return String(x).toLowerCase().indexOf(String(d.email).toLowerCase()) !== -1; }); };
    const practice = function (e) { return toList(e && e.to).some(function (x) { return String(x).toLowerCase().indexOf(PRACTICE_EMAIL) !== -1; }); };
    return {
      caseStage: c ? c.stage : null,
      assignedRso: c ? (c.assigned_rso || c.assigned_va || null) : null,
      application: { status: app.status || null, ats_stage: app.ats_stage || null },
      placements: table('placements').filter(function (p) { return p.user_id === d.userId; }),
      jobStatus: (table('career_roles').find(function (r) { return r.id === ROLE_ID; }) || {}).job_status || null,
      tasks: table('registration_tasks').filter(function (x) { return x.case_id === caseId; }),
      timeline: table('task_timeline').filter(function (x) { return x.case_id === caseId; }),
      documents: table('user_documents').filter(function (x) { return x.user_id === d.userId; }),
      practiceDocOps: table('practice_doc_ops').filter(function (x) { return x.case_id === caseId; }),
      visaCases: table('visa_cases').filter(function (x) { return x.user_id === d.userId; }),
      emailsToDoctor: emails.filter(mine),
      emailsToPractice: emails.filter(practice),
      emailsOther: emails.filter(function (e) { return !mine(e) && !practice(e); }),
      whatsapps: whatsapps.slice(),
      bell: Array.isArray(bell) ? bell : [],
      nudges: table('gp_nudge_log').filter(function (x) { return x.user_id === d.userId; }),
      drive: drive.calls.slice()
    };
  }

  /** A capture with ids and times removed: what two identical runs share. */
  function normalise(cap) {
    const email = function (e) {
      return { to: [].concat(e.to || []).map(scrub), subject: scrub(e.subject), text: scrub(e.text), html: scrub(e.html) };
    };
    return {
      caseStage: cap.caseStage,
      assignedRso: cap.assignedRso ? '<set>' : null,
      application: cap.application,
      placements: cap.placements.map(function (p) { return { status: p.status, start_date: p.start_date || null, practice_name: p.practice_name || '', job_title: p.job_title || '' }; }),
      jobStatus: cap.jobStatus,
      tasks: cap.tasks.map(function (x) {
        return {
          task_type: x.task_type, title: scrub(x.title), status: x.status || null, priority: x.priority || null,
          related_stage: x.related_stage || null, related_document_key: x.related_document_key || null,
          source_trigger: x.source_trigger || null, has_due_date: !!x.due_date,
          due_in_days: x.due_date ? Math.round((new Date(x.due_date).getTime() - Date.now()) / 86400000) : null
        };
      }),
      timeline: cap.timeline.map(function (x) { return { event_type: x.event_type, title: scrub(x.title), detail: scrub(x.detail), actor: x.actor || null }; }),
      documents: cap.documents.map(function (x) { return { document_key: x.document_key, country_code: x.country_code == null ? null : x.country_code, status: x.status || null, file_name: x.file_name || null }; }),
      practiceDocOps: cap.practiceDocOps.map(function (x) { return { document_key: x.document_key || null, ops_status: x.ops_status || null }; }),
      visaCases: cap.visaCases.length,
      emailsToDoctor: cap.emailsToDoctor.map(email),
      emailsToPractice: cap.emailsToPractice.map(email),
      emailsOther: cap.emailsOther.map(email),
      whatsapps: cap.whatsapps.map(function (w) { return JSON.parse(scrub(JSON.stringify(w))); }),
      bell: cap.bell.map(function (b) { return { type: b.type || null, title: scrub(b.title), body: scrub(b.body) }; }),
      nudges: cap.nudges.map(function (n) { return { nudge_key: scrub(n.nudge_key), channel: n.channel }; }),
      drive: cap.drive.map(function (c) {
        const rb = (c.args && c.args.requestBody) || {};
        return { api: c.api, name: scrub(rb.name || ''), type: rb.type || null, role: rb.role || null, mimeType: rb.mimeType || null };
      })
    };
  }

  function resetRecorders() { emails.length = 0; whatsapps.length = 0; drive.calls.length = 0; }

  return Object.assign({}, h, {
    emails, whatsapps, drive,
    table, caseOf, stateOf, settle,
    addDoctor, place, capture, normalise, resetRecorders,
    appIdFor, offerIdFor, contractIdFor,
    ENTRY_POINTS,
    close: async function () {
      globalThis.fetch = harnessFetch;
      h.testUtils.__setGoogleDriveClientForTest(null);
      await h.close();
    }
  });
}

module.exports = {
  bootPlacementRig, makeFakeDrive, scrub,
  appIdFor, offerIdFor, contractIdFor, freshApplication, freshOffer, freshContract,
  ENTRY_POINTS, PRACTICE_ID, ROLE_ID, PRACTICE_NAME, PRACTICE_EMAIL, PRACTICE_PHONE, ROLE_TITLE, START_DATE, NOW
};
