'use strict';

/**
 * WP-09 test rig: boots the real server (AU harness + emulator) with a fake
 * practice, one role and one pending application per doctor, and records what
 * the submit-to-practice action sends: the Resend email body, the DoubleTick
 * WhatsApp template body, and the practice decision page's payload.
 *
 *   const rig = await bootIntroRig({ name: 'wp09', doctors: [d1, d2] });
 *   const out = await rig.introduce(d1);      // { status, json, email, whatsapp, decision }
 *   await rig.close();
 *
 * Nothing real is reached: Resend and DoubleTick are answered by the recorder.
 */

const { bootAuTestServer } = require('./au-server-harness.js');
const { buildAuFixtureDb, fakeUuid } = require('./au-fixtures.js');

const PRACTICE_ID = fakeUuid('p', '901');
const ROLE_ID = 9001;
const PRACTICE_NAME = 'Test Metro Practice (FAKE)';
const PRACTICE_EMAIL = 'manager@metro-practice.gplink-test.local';
const PRACTICE_SECONDARY = 'owner@metro-practice.gplink-test.local';
const PRACTICE_PHONE = '+61400000901';
const ROLE_TITLE = 'General Practitioner (FAKE role)';
const NOW = '2026-11-01T00:00:00.000Z';

function appIdFor(doctor) { return fakeUuid('a', String(doctor.userId).slice(-6)); }
function tokenFor(doctor) { return 'tok_' + String(doctor.userId).replace(/[^a-z0-9]/gi, '').slice(-12); }

function freshApplication(doctor, extra) {
  return Object.assign({
    id: appIdFor(doctor),
    user_id: doctor.userId,
    career_role_id: ROLE_ID,
    provider_role_id: 'ats_wp09_role',
    status: 'applied',
    ats_stage: 'applied',
    origin: 'gp_applied',
    practice_id: PRACTICE_ID,
    practice_submission_status: 'pending_va_submission',
    practice_action_token: tokenFor(doctor),
    submitted_to_practice_at: null,
    submitted_to_practice_by: null,
    practice_contact_email: null,
    practice_contact_name: null,
    practice_decision: null,
    practice_opened_at: null,
    ai_recommendation: null,
    withdrawn_at: null,
    zoho_submission_id: null,
    zoho_application_id: null,
    submission_task_id: null,
    applied_at: NOW,
    updated_at: NOW
  }, extra || {});
}

async function bootIntroRig(opts) {
  const o = opts || {};
  const doctors = o.doctors || [];
  const tables = Object.assign(buildAuFixtureDb(doctors), {
    practices: [{
      id: PRACTICE_ID, name: PRACTICE_NAME, source: 'internal_ats',
      contact_name: 'Test Manager', contact_email: PRACTICE_EMAIL, contact_phone: PRACTICE_PHONE,
      secondary_contacts: [{ name: 'Test Owner', email: PRACTICE_SECONDARY }],
      is_active: true, created_at: NOW
    }],
    career_roles: [{
      id: ROLE_ID, provider: 'internal_ats', provider_role_id: 'ats_wp09_role', title: ROLE_TITLE,
      practice_name: PRACTICE_NAME, practice_id: PRACTICE_ID, location_city: 'Parramatta', location_state: 'NSW',
      dpa: false, is_active: true, created_at: NOW,
      // enough for a doctor to apply to it through POST /api/career/apply
      approval_status: 'approved', job_status: 'open', ats_created: true, updated_at: NOW, published_at: NOW,
      location_country: 'Australia', suburb: 'Parramatta', nearest_city: 'Sydney', tags: [],
      masked_title: 'Non-DPA - Parramatta - Mixed Billing', billing_model: 'mixed', mixed_billing: true, mmm: 'MM1', metro: true
    }],
    gp_applications: doctors.map(function (d) { return freshApplication(d, (o.applicationExtra || {})[d.userId]); }),
    user_documents: [], registration_tasks: [], task_timeline: [], push_subscriptions: [],
    notification_preferences: [], ats_stage_events: [], scheduled_calls: [], career_interviews: [],
    ats_offers: [], admin_audit_log: []
  }, o.tables || {});

  const h = await bootAuTestServer({
    name: o.name || 'wp09',
    tables,
    emulator: Object.assign({ rpc: { rate_limit_hit: function () { return { allowed: true }; } } }, o.emulator || {}),
    env: Object.assign({
      RESEND_API_KEY: 're_test_wp09',
      DOUBLETICK_API_KEY: 'dt_test_wp09',
      DOUBLETICK_BASE_URL: 'https://doubletick.invalid',
      HAZEL_WHATSAPP_NUMBER: '+61494391968',
      APP_BASE_URL: 'https://app.gplink-test.local'
    }, o.env || {})
  });

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
      if (u.indexOf('/whatsapp/message/template') !== -1) whatsapps.push(body);
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'wa-' + whatsapps.length }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return harnessFetch(url, init);
  };

  let ipSeq = 0;
  function resetApplication(doctor, extra) {
    const rows = h.emu.table('gp_applications');
    const id = appIdFor(doctor);
    const idx = rows.findIndex(function (r) { return r.id === id; });
    const fresh = freshApplication(doctor, extra);
    if (idx === -1) rows.push(fresh); else rows[idx] = fresh;
    return fresh;
  }

  /** Staff submit one doctor's application; returns everything that went out. */
  async function introduce(doctor, io) {
    const i = io || {};
    const staff = i.staff || h.superAdmin();
    const e0 = emails.length;
    const w0 = whatsapps.length;
    const res = await h.post('/api/admin/career/application/submit-to-practice', { applicationId: appIdFor(doctor) }, staff);
    const sentEmails = emails.slice(e0);
    const sentWa = whatsapps.slice(w0);
    let decision = null;
    if (i.decision !== false) {
      ipSeq += 1;
      decision = await h.get('/api/practice/application/decision-context?token=' + encodeURIComponent(tokenFor(doctor)),
        { headers: { 'x-real-ip': '10.9.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1), 'x-forwarded-for': '10.9.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1) } });
    }
    return {
      status: res.status,
      json: res.json,
      emails: sentEmails,
      email: sentEmails[0] || null,
      whatsapps: sentWa,
      whatsapp: sentWa[0] ? sentWa[0].messages[0].content : null,
      decision: decision ? decision.json : null,
      decisionStatus: decision ? decision.status : null
    };
  }

  return Object.assign({}, h, {
    emails, whatsapps, introduce, resetApplication,
    appIdFor, tokenFor,
    close: async function () { globalThis.fetch = harnessFetch; await h.close(); }
  });
}

module.exports = {
  bootIntroRig, appIdFor, tokenFor, freshApplication,
  PRACTICE_ID, ROLE_ID, PRACTICE_NAME, PRACTICE_EMAIL, PRACTICE_SECONDARY, PRACTICE_PHONE, ROLE_TITLE
};
