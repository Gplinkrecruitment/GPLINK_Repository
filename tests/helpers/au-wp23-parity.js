'use strict';

/**
 * WP-23 switch-off parity: the practice front door exactly as it is on `main`.
 *
 *   parityTables()            the fixture database (empty practice pipeline)
 *   computePracticeParity(h)  drives the REAL server with the Australian switch
 *                             OFF through: website practice lead (DPA yes / no /
 *                             unknown), the Meta practice lead webhook, the
 *                             intake page and script files, the intake API
 *                             (load, save), the agreement PDF, signing, the
 *                             pending job, approval, and the public board. It
 *                             records what is answered, what is stored and
 *                             every email handed to Resend.
 *
 * tests/fixtures/au-wp23-switch-off.snapshot.json was written by this file on
 * the tree BEFORE WP-23 changed any behaviour. Never regenerate it to make a
 * test pass.
 *
 * Every identity here is fake.
 */

const crypto = require('crypto');

const FB_SECRET = 'wp23-fb-secret';
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const EMPTY_TABLES = ['practices', 'practice_groups', 'career_roles', 'site_enquiries', 'webhook_events', 'runtime_kv',
  'rate_limits', 'admin_audit_log', 'gp_applications', 'user_profiles', 'user_state', 'registration_cases',
  'registration_tasks', 'task_timeline', 'gp_credentials', 'user_documents', 'placements', 'career_interviews',
  'career_suburb_geo_cache', 'ats_stage_events', 'ats_offers', 'match_cache', 'career_contracts', 'candidate_leads',
  'gp_nudge_log', 'user_roles', 'scheduled_calls', 'email_suppression', 'notification_preferences'];

function parityTables() {
  const tables = {};
  EMPTY_TABLES.forEach(function (t) { tables[t] = []; });
  return tables;
}

/** Emulator options every WP-23 server test needs (the rate limiter is a database function). */
const PARITY_EMULATOR = { rpc: { rate_limit_hit: function () { return { allowed: true }; } } };

const PARITY_ENV = {
  FB_LEAD_WEBHOOK_SECRET: FB_SECRET,
  FB_LEAD_VERIFY_TOKEN: 'wp23-fb-verify',
  FB_GP_LEAD_FORM_IDS: 'gp-form-wp23',
  TURNSTILE_SECRET_KEY: ''
};

function websiteLead(key, dpa) {
  const body = {
    gps_needed: '2',
    employment_type: 'either',
    urgency: 'asap',
    practice_name: 'Test ' + key + ' Practice (FAKE)',
    suburb: key === 'metro' ? 'Surry Hills' : (key === 'dpa' ? 'Dubbo' : 'Nowhereville'),
    state: 'NSW',
    postcode: key === 'metro' ? '2010' : (key === 'dpa' ? '2830' : '2999'),
    contact_name: 'Pat Testmanager',
    contact_role: '',
    contact_email: 'practice.' + key + '.test@gplink-test.local',
    contact_phone: '0400 000 00' + (key === 'metro' ? '1' : (key === 'dpa' ? '2' : '3')),
    website: 'https://' + key + '.gplink-test.local',
    latitude: key === 'metro' ? -33.8861 : (key === 'dpa' ? -32.2569 : null),
    longitude: key === 'metro' ? 151.2111 : (key === 'dpa' ? 148.6011 : null),
    elapsed_ms: 60000,
    company_url: ''
  };
  if (dpa !== undefined) body.dpa = dpa;
  return body;
}

/** One clinic's intake answers as the live page sends them (buildClinicPayload). */
function intakeClinic(kind) {
  const metro = kind === 'metro';
  return {
    practice_name: metro ? 'Test Inner Metro Practice (FAKE)' : 'Test Regional Practice (FAKE)',
    billing_style: metro ? 'mixed' : 'bulk',
    dpa: metro ? 'no' : 'yes',
    dpa_suggested: metro ? false : true,
    mmm: metro ? 'MM1' : 'MM3',
    suburb: metro ? 'Surry Hills' : 'Dubbo',
    nearest_city: metro ? 'Sydney' : 'Dubbo',
    state: 'NSW',
    address: metro ? '1 Fake Street, Surry Hills NSW 2010' : '2 Fake Road, Dubbo NSW 2830',
    general_location: '',
    postcode: metro ? '2010' : '2830',
    latitude: metro ? -33.8861 : -32.2569,
    longitude: metro ? 151.2111 : 148.6011,
    google_place_id: metro ? 'fake-place-metro' : 'fake-place-dpa',
    urgency: 'asap',
    employment_type: 'either',
    gps_needed: '1',
    percentage_split: '70/30',
    intro_text: 'A friendly, well supported practice (FAKE).',
    role_summary: 'Mixed general practice with a full nursing team (FAKE).',
    incentives: '',
    earnings_text: '',
    visa_sponsorship: metro ? '' : 'yes',
    ownership: 'Doctor-owned',
    years_operating: '12',
    nursing_on_site: 'yes',
    gp_count: '6',
    website: metro ? 'https://metro.gplink-test.local' : 'https://dpa.gplink-test.local',
    supervision_available: metro ? '' : 'yes',
    intro_video_url: ''
  };
}

function signBody(token) {
  return {
    token: token,
    authorised: true,
    signed_name: 'Pat Testmanager',
    signature_data_url: TINY_PNG_DATA_URL,
    legal_entity_name: 'Test Metro Holdings Pty Ltd (FAKE)',
    abn_acn: '51 824 753 556',
    signer_job_title: 'Practice Manager',
    email: 'practice.metro.test@gplink-test.local'
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function settle(h) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await sleep(40);
    if (h.emails.length === last) return;
    last = h.emails.length;
  }
}

const copy = function (v) { return JSON.parse(JSON.stringify(v === undefined ? null : v)); };
const sha = function (buf) { return crypto.createHash('sha256').update(buf).digest('hex'); };

function mailShape(call) {
  const b = (call && call.body) || {};
  return {
    from: b.from || null, to: b.to || null, cc: b.cc || null, reply_to: b.reply_to || null,
    subject: b.subject || null, html: b.html || null, text: b.text || null,
    attachments: Array.isArray(b.attachments)
      ? b.attachments.map(function (a) { return { filename: a.filename || null, hasContent: String(a.content || '').length > 1000 }; })
      : null
  };
}

/** Replaces every run-specific value (ids, tokens, times) so two runs compare equal. */
function makeScrubber() {
  const swaps = [];
  return {
    add: function (value, label) {
      const v = String(value == null ? '' : value);
      if (v.length >= 6 && !swaps.some(function (s) { return s.v === v; })) {
        swaps.push({ v: v, label: label });
        const enc = encodeURIComponent(v);
        if (enc !== v) swaps.push({ v: enc, label: label });
      }
    },
    clean: function (value) {
      let text = JSON.stringify(value === undefined ? null : value);
      swaps.slice().sort(function (a, b) { return b.v.length - a.v.length; }).forEach(function (s) {
        text = text.split(s.v).join('<' + s.label + '>');
      });
      text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, '<time>');
      text = text.replace(/ats_(?!created)[a-z0-9_]{6,}/g, '<provider-role-id>');
      text = text.replace(/http:\/\/127\.0\.0\.1:\d+/g, '<local>');
      return JSON.parse(text);
    }
  };
}

function rawGet(h, urlPath, headers) {
  const http = require('http');
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: '127.0.0.1', port: h.port, path: urlPath, method: 'GET', headers: headers || {} }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {object} h   bootLeadCopyServer({ mode: 'supabase', tables: parityTables(), emulator: PARITY_EMULATOR, env: PARITY_ENV })
 * @param {object} [o] { extra: (clinic) => clinic }  lets the after-test add keys a newer page would send
 */
async function computePracticeParity(h, o) {
  const opts = o || {};
  const scrub = makeScrubber();
  const out = {};
  const table = function (name) { return h.emu.table(name); };
  const practiceByEmail = function (email) { return table('practices').filter(function (p) { return p.contact_email === email; })[0] || null; };
  const noteRow = function (row, label) {
    if (!row) return;
    scrub.add(row.id, label + '-id');
    scrub.add(row.intake_token, label + '-token');
    scrub.add(row.group_id, label + '-group');
  };

  // 1. The files a practice's browser is sent.
  const page = await rawGet(h, '/pages/practice-intake?token=abcdefghijklmnopqrstuvwxyz');
  const leadScript = await rawGet(h, '/js/site-practice-lead.js');
  out.files = {
    intakePage: { status: page.status, sha256: sha(page.body), bytes: page.body.length },
    leadScript: { status: leadScript.status, sha256: sha(leadScript.body), bytes: leadScript.body.length }
  };

  // 2. Website practice lead: DPA yes, DPA no, lookup unknown.
  out.websiteLead = {};
  for (const item of [['dpa', true], ['metro', false], ['unknown', undefined]]) {
    h.reset();
    const body = websiteLead(item[0], item[1]);
    const res = await h.post('/api/public/practice-lead', body);
    await settle(h);
    const row = practiceByEmail(body.contact_email);
    noteRow(row, 'lead-' + item[0]);
    const enquiry = table('site_enquiries').filter(function (e) { return e.email === body.contact_email; })[0] || null;
    if (enquiry) scrub.add(enquiry.id, 'enquiry-' + item[0] + '-id');
    out.websiteLead[item[0]] = copy({ status: res.status, json: res.json, practice: row, enquiry: enquiry, emails: h.emails.map(mailShape) });
  }

  // 3. The Meta practice lead webhook (a form id that is NOT a GP form).
  h.reset();
  const fbRes = await h.post('/api/webhooks/facebook-lead?secret=' + encodeURIComponent(FB_SECRET), {
    lead_id: 'wp23-fb-lead-0001',
    form_id: 'practice-form-wp23',
    practice_name: 'Test Meta Lead Practice (FAKE)',
    contact_name: 'Sam Testowner',
    contact_email: 'practice.meta.test@gplink-test.local',
    contact_phone: '0400 000 004',
    location: 'Parramatta',
    dpa: 'no',
    gp_needed_by: 'asap',
    postcode: '2150'
  });
  await settle(h);
  const fbRow = practiceByEmail('practice.meta.test@gplink-test.local');
  noteRow(fbRow, 'fb');
  out.metaLead = copy({ status: fbRes.status, json: fbRes.json, practice: fbRow, emails: h.emails.map(mailShape) });
  // A GP form id is still routed away from the practice pipeline.
  const fbGp = await h.post('/api/webhooks/facebook-lead?secret=' + encodeURIComponent(FB_SECRET), {
    lead_id: 'wp23-fb-lead-0002', form_id: 'gp-form-wp23', full_name: 'Dr Test Lead', email: 'gp.meta.test@gplink-test.local', phone_number: '+447700900123'
  });
  out.metaGpLead = { status: fbGp.status, action: fbGp.json && fbGp.json.action, practiceCreated: !!practiceByEmail('gp.meta.test@gplink-test.local') };

  // 4. Intake: load, save (a metro practice outside a DPA), load again.
  const metro = practiceByEmail('practice.metro.test@gplink-test.local');
  const token = metro.intake_token;
  const load1 = await h.get('/api/practice-intake?token=' + encodeURIComponent(token));
  let clinic = intakeClinic('metro');
  if (typeof opts.extra === 'function') clinic = opts.extra(clinic);
  const save = await h.post('/api/practice-intake', { token: token, entity_name: 'Test Metro Holdings Pty Ltd (FAKE)', abn: '51824753556', practices: [clinic] });
  const afterSave = practiceByEmail('practice.metro.test@gplink-test.local');
  noteRow(afterSave, 'lead-metro');
  if (save.json) scrub.add(save.json.group_id, 'lead-metro-group');
  const load2 = await h.get('/api/practice-intake?token=' + encodeURIComponent(token));
  out.intake = {
    load: { status: load1.status, json: load1.json },
    save: { status: save.status, json: save.json },
    stored: JSON.parse(JSON.stringify(afterSave)),
    group: JSON.parse(JSON.stringify(table('practice_groups').filter(function (g) { return g.intake_token === token; })[0] || null)),
    reload: { status: load2.status, json: load2.json }
  };

  // 5. The agreement the practice is shown, then signing.
  const pdf = await rawGet(h, '/api/practice-intake/agreement?token=' + encodeURIComponent(token));
  out.agreement = { status: pdf.status, type: pdf.headers['content-type'], sha256: sha(pdf.body), bytes: pdf.body.length };
  h.reset();
  const sign = await h.post('/api/practice-intake/sign', signBody(token));
  await settle(h);
  const job = table('career_roles').filter(function (j) { return j.practice_id === metro.id; })[0] || null;
  if (job) { scrub.add(job.id, 'job-id'); scrub.add(job.provider_role_id, 'provider-role-id'); }
  if (sign.json) scrub.add(sign.json.job_id, 'job-id');
  out.sign = {
    status: sign.status, json: sign.json,
    practice: JSON.parse(JSON.stringify(practiceByEmail('practice.metro.test@gplink-test.local'))),
    job: JSON.parse(JSON.stringify(job)),
    jobCount: table('career_roles').length,
    emails: h.emails.map(mailShape)
  };

  // 6. Staff approve (the header photo is a precondition) and the practice is told.
  h.reset();
  const sa = h.superAdmin();
  const refuse = await h.post('/api/ats/job/approve?id=' + encodeURIComponent(job.id), { action: 'approve' }, sa);
  job.header_image_url = 'https://images.gplink-test.local/surry-hills.jpg';
  const approve = await h.post('/api/ats/job/approve?id=' + encodeURIComponent(job.id), { action: 'approve' }, sa);
  await settle(h);
  out.approve = {
    withoutPhoto: { status: refuse.status, json: refuse.json },
    status: approve.status, json: approve.json,
    job: JSON.parse(JSON.stringify(table('career_roles').filter(function (j) { return j.id === job.id; })[0] || null)),
    emails: h.emails.map(mailShape)
  };

  // 7. The public board (signed out).
  const board = await h.get('/api/public/jobs');
  out.publicBoard = { status: board.status, json: board.json };

  return scrub.clean(out);
}

module.exports = {
  parityTables, PARITY_EMULATOR, PARITY_ENV, FB_SECRET, TINY_PNG_DATA_URL,
  websiteLead, intakeClinic, signBody, computePracticeParity, settle, mailShape, rawGet, makeScrubber, EMPTY_TABLES
};
