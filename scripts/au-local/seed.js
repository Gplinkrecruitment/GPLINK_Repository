#!/usr/bin/env node
'use strict';
/*
 * Seeds the LOCAL test database with obviously fake data. Safe to re-run.
 *
 *   Staff logins     CEO (super admin), RSO, consultant, plus the "admin pool"
 *   Practices        one non-DPA metro practice (signed agreement, two approved
 *                    open roles) and one DPA regional practice (one approved role)
 *   Doctor           one overseas (UK) doctor who has finished onboarding
 *
 * No Australian doctor is seeded on purpose: the reviewer signs one up through
 * the real screens.
 *
 * Rows are built the way the app builds them (the same helper functions from
 * lib/ where they exist), not copied from anywhere. Nothing here can reach
 * production: it connects to 127.0.0.1 only and checks the database's marker.
 *
 * EXTENDING: later work packages add columns (pathway, role fields). Put a file
 * in scripts/au-local/seed.d/ that exports `async function (ctx) {}`; each one
 * runs after the base seed, in filename order, with ctx = { db, cfg, ids, say,
 * upsertPractice, upsertRole, upsertDoctor }.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./lib/config.js');
const { pgClient, assertLocalDatabase } = require('./lib/stack.js');
const { createAuthEmulator } = require('./lib/auth-emulator.js');
const { createStorageEmulator } = require('./lib/storage-emulator.js');
const practicePipeline = require(path.join(cfg.REPO_ROOT, 'lib', 'practice-pipeline.js'));
const intakeLogic = require(path.join(cfg.REPO_ROOT, 'lib', 'practice-intake-logic.js'));

function say(msg) { process.stdout.write(msg + '\n'); }
const D = cfg.TEST_EMAIL_DOMAIN;
const now = () => new Date().toISOString();

// Phone numbers are from the ranges the regulators reserve for fiction
// (Australia: 0491 570 xxx; UK: 07700 900xxx), so they can never be real.
const PRACTICES = [
  {
    key: 'metro',
    name: 'Test Metro Practice (FAKE)',
    group: { entity_name: 'Test Metro Medical Pty Ltd (FAKE)', abn: '00 000 000 001' },
    contact: { name: 'Test Metro Manager (FAKE)', email: 'metro.practice@' + D, phone: '+61491570156', role: 'Practice Manager' },
    latitude: -33.8150, longitude: 151.0011, postcode: '2150',
    intake: {
      practice_name: 'Test Metro Practice (FAKE)', billing_style: 'mixed', dpa: false, mmm: 'MM1', visa_sponsorship: false,
      ownership: 'Independent, doctor-owned', years_operating: '12', nursing_on_site: true, gp_count: '8',
      percentage_split: '70% of billings', incentives: 'Relocation not applicable. Flexible sessions. (FAKE listing for testing)',
      earnings_text: 'Test figure only', suburb: 'Parramatta', nearest_city: 'Sydney', state: 'NSW',
      address: '1 Test Street, Parramatta NSW 2150', urgency: 'asap', employment_type: 'either', gps_needed: '2',
      website: 'https://test-metro-practice.' + D, supervision_available: false,
      role_summary: 'FAKE role for testing. A busy mixed-billing metropolitan practice in a non-DPA area.',
      intro_text: 'This is a fake practice used only for testing the GP Link app.', intro_video_url: ''
    },
    roles: [
      { key: 'metro-ft', employment_type: 'full_time', role_summary: 'FAKE role 1 of 2 (full time). Mixed billing, established patient base, metropolitan non-DPA.' },
      { key: 'metro-pt', employment_type: 'part_time', role_summary: 'FAKE role 2 of 2 (part time). Mixed billing, flexible sessions, metropolitan non-DPA.' }
    ]
  },
  {
    key: 'regional',
    name: 'Test Regional Practice (FAKE)',
    group: { entity_name: 'Test Regional Health Pty Ltd (FAKE)', abn: '00 000 000 002' },
    contact: { name: 'Test Regional Manager (FAKE)', email: 'regional.practice@' + D, phone: '+61491570157', role: 'Practice Manager' },
    latitude: -32.2569, longitude: 148.6011, postcode: '2830',
    intake: {
      practice_name: 'Test Regional Practice (FAKE)', billing_style: 'bulk', dpa: true, mmm: 'MM3', visa_sponsorship: true,
      ownership: 'Independent', years_operating: '20', nursing_on_site: true, gp_count: '5',
      percentage_split: '75% of billings', incentives: 'Regional incentives may apply. (FAKE listing for testing)',
      earnings_text: 'Test figure only', suburb: 'Dubbo', nearest_city: 'Dubbo', state: 'NSW',
      address: '2 Test Road, Dubbo NSW 2830', urgency: '3_6m', employment_type: 'full_time', gps_needed: '1',
      website: 'https://test-regional-practice.' + D, supervision_available: true,
      role_summary: 'FAKE role for testing. A bulk-billing regional practice in a Distribution Priority Area.',
      intro_text: 'This is a fake practice used only for testing the GP Link app.', intro_video_url: ''
    },
    roles: [
      { key: 'regional-ft', employment_type: 'full_time', role_summary: 'FAKE role (full time). Bulk billing, DPA regional, supervision available.' }
    ]
  }
];

const UK_DOCTOR = {
  id: '00000000-0000-4000-a000-0000000000d1',
  email: 'uk.doctor@' + D, firstName: 'Test', lastName: 'Ukgp',
  countryDial: '+44', phoneNumber: '7700900123',
  country: 'GB', registerNumber: '7000001', preferredCity: 'Sydney', targetDate: '2027-06', whoMoving: 'just_me'
};

function uuidFor(label) {
  // Stable ids, so re-running the seed updates the same rows.
  const h = crypto.createHash('sha256').update('gplink-au-local-seed:' + label).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
}

async function upsertRow(db, table, row, conflictCols) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => {
    const v = row[c];
    return (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) ? JSON.stringify(v) : v;
  });
  const params = cols.map((c, i) => '$' + (i + 1));
  const updates = cols.filter((c) => !conflictCols.includes(c)).map((c) => '"' + c + '" = excluded."' + c + '"');
  const sql = 'insert into public."' + table + '" (' + cols.map((c) => '"' + c + '"').join(', ') + ') values (' + params.join(', ') + ') ' +
    'on conflict (' + conflictCols.map((c) => '"' + c + '"').join(', ') + ') do ' + (updates.length ? 'update set ' + updates.join(', ') : 'nothing') + ' returning *';
  const r = await db.query(sql, vals);
  return r.rows[0];
}

async function ensureAccount(db, auth, person, extra) {
  let row = await auth.findByEmail(person.email);
  if (!row) {
    row = await auth.createUser({
      id: person.id, email: person.email, password: cfg.TEST_PASSWORD, confirmed: true,
      userMetadata: Object.assign({ firstName: person.firstName, lastName: person.lastName }, (extra && extra.userMetadata) || {}),
      // The app treats an address as verified once this stamp exists (verify-later accounts).
      appMetadata: { email_verified_at: now() }
    });
  } else {
    await db.query("update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf', 10)), email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1", [row.id, cfg.TEST_PASSWORD]);
  }
  // The live trigger created user_profiles + user_state; make sure the names are right.
  await db.query('update public.user_profiles set first_name = $2, last_name = $3, email = $4 where user_id = $1', [row.id, person.firstName, person.lastName, person.email]);
  return row.id;
}

async function seedStaff(ctx) {
  const { db, auth } = ctx;
  for (const key of Object.keys(cfg.STAFF)) {
    const person = cfg.STAFF[key];
    const id = await ensureAccount(db, auth, person);
    await upsertRow(db, 'user_roles', { user_id: id, role: person.role }, ['user_id']);
    await db.query('update public.user_profiles set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where user_id = $1', [id]);
    ctx.ids.staff[key] = id;
    say('  staff login: ' + person.email.padEnd(34) + person.role);
  }
  // The RSO roster. server.js prefers this table over its built-in list, and an
  // RSO only sees doctors assigned to their roster entry.
  for (const key of ['rso', 'adminPool']) {
    const p = cfg.STAFF[key];
    await upsertRow(db, 'rso_team', {
      user_id: ctx.ids.staff[key], name: (p.firstName + ' ' + p.lastName).trim(), email: p.email,
      phone: key === 'rso' ? '+61491570158' : '', active: true, on_leave: false,
      calendly_event_url: 'https://calendly.com/aulocal-fake/' + key
    }, ['user_id']);
    // Each RSO works from a registered mailbox; the app refuses to hand a
    // doctor to an RSO who has none (bulk reassign, mailbox-owner routing).
    await upsertRow(db, 'va_gmail_accounts', {
      user_id: ctx.ids.staff[key], email_address: p.email, display_name: (p.firstName + ' ' + p.lastName).trim(), watch_active: false
    }, ['email_address']);
  }
  // Consultants can also be granted through this list (CEO dashboard "Team" card).
  await upsertRow(db, 'runtime_kv', {
    key: 'ats_consultants',
    value: { consultants: [{ email: cfg.STAFF.consultant.email, name: 'Test Consultant (FAKE)', added_at: now(), added_by: cfg.STAFF.ceo.email }] }
  }, ['key']);
}

async function upsertPractice(ctx, spec) {
  const { db } = ctx;
  const validated = practicePipeline.validatePracticeIntakePayload(spec.intake);
  if (!validated.ok) throw new Error('Seed practice "' + spec.name + '" is not a valid intake: ' + validated.error);
  const intake = validated.value;
  const near = intakeLogic.nearestCity(spec.latitude, spec.longitude);
  intake.general_location = intakeLogic.buildGeneralLocation({ suburb: intake.suburb, state: intake.state, nearestCity: near.city });

  const practiceId = uuidFor('practice:' + spec.key);
  const groupId = uuidFor('group:' + spec.key);
  const signedKey = 'practices/' + practiceId + '/agreement-signed.pdf';
  const signedAt = now();

  await upsertRow(db, 'practice_groups', {
    id: groupId, entity_name: spec.group.entity_name, abn: spec.group.abn,
    contact_name: spec.contact.name, contact_email: spec.contact.email, contact_phone: spec.contact.phone, contact_role: spec.contact.role,
    intake_token: 'aulocal-seed-group-' + spec.key, agreement_status: 'signed', agreement_signed_at: signedAt,
    agreement_signed_by: spec.contact.name, agreement_signed_pdf_key: signedKey, source: 'manual', metadata: { seeded_by: 'au-local' }
  }, ['id']);

  const practice = await upsertRow(db, 'practices', {
    id: practiceId, name: spec.name,
    location_city: near.city, location_state: intake.state, location_country: 'Australia',
    practice_type: 'General Practice', contact_name: spec.contact.name, contact_email: spec.contact.email, contact_phone: spec.contact.phone,
    source: 'manual', notes: 'FAKE practice seeded for local testing.', is_active: true, created_by: cfg.STAFF.ceo.email,
    stage: 'active', website: intake.website, dpa: intake.dpa, billing_style: intake.billing_style,
    nearest_city: near.city, suburb: intake.suburb, address: intake.address,
    agreement_status: 'signed', agreement_signed_at: signedAt, agreement_signed_by: spec.contact.name, agreement_signed_pdf_key: signedKey,
    intro_text: intake.intro_text, intro_video_url: intake.intro_video_url, intake_token: 'aulocal-seed-practice-' + spec.key,
    metadata: {
      intake,
      agreement_signing: { legal_entity_name: spec.group.entity_name, abn_acn: 'ABN ' + spec.group.abn, signer_job_title: spec.contact.role },
      seeded_by: 'au-local'
    },
    org_type: 'practice', group_id: groupId, urgency: intake.urgency, latitude: spec.latitude, longitude: spec.longitude,
    postcode: spec.postcode, dpa_suggested: intake.dpa, dpa_mismatch: false, employment_type: intake.employment_type,
    gps_needed: intake.gps_needed, supervision_available: intake.supervision_available, secondary_contacts: JSON.stringify([])
  }, ['id']);

  // A stand-in signed agreement, so "view signed agreement" opens a real file.
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 96>>stream\nBT /F1 18 Tf 60 760 Td (FAKE signed practice agreement - local test only) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  await ctx.storage.putObject('gp-link-documents', signedKey, pdf, 'application/pdf', true);

  ctx.ids.practices[spec.key] = practice.id;
  say('  practice: ' + spec.name + '  (' + (intake.dpa ? 'DPA' : 'non-DPA') + ', ' + intake.suburb + ' ' + intake.state + ', agreement signed)');

  for (const roleSpec of spec.roles) await upsertRole(ctx, practice, Object.assign({}, intake, { employment_type: roleSpec.employment_type, role_summary: roleSpec.role_summary }), roleSpec.key);
  return practice;
}

// Mirrors createPendingJobFromIntake() in server.js, then the approval a
// CEO gives on the Jobs board (approval_status 'approved', is_active true).
async function upsertRole(ctx, practice, intake, key) {
  const maskArgs = {
    nearestCity: intake.nearest_city, suburb: intake.suburb, billingStyle: intake.billing_style,
    dpa: intake.dpa === true, visaSponsorship: intake.visa_sponsorship === true, earningsText: intake.earnings_text, state: intake.state
  };
  const masked = practicePipeline.buildMaskedTitle(maskArgs);
  const row = await upsertRow(ctx.db, 'career_roles', {
    provider: 'internal_ats', provider_role_id: 'ats_aulocal_' + key.replace(/[^a-z0-9]/gi, ''),
    title: masked, masked_title: masked, practice_name: practice.name, practice_id: practice.id,
    location_city: intake.suburb || intake.nearest_city || '', location_state: intake.state || '', location_country: 'Australia',
    suburb: intake.suburb || '', nearest_city: intake.nearest_city || '',
    billing_model: intake.billing_style || '', dpa: intake.dpa === true, mmm: intake.mmm || '',
    earnings_text: intake.earnings_text || '', address: intake.address || '',
    summary: [intake.role_summary, intake.incentives ? 'Additional incentives: ' + intake.incentives : '', intake.percentage_split ? 'Percentage split: ' + intake.percentage_split : ''].filter(Boolean).join('\n\n'),
    employment_type: intake.employment_type || '', practice_type: intake.ownership || '',
    mixed_billing: intake.billing_style === 'mixed', private_billing: intake.billing_style === 'private',
    visa_pathway_aligned: intake.visa_sponsorship === true,
    metro: intake.mmm === 'MM1', regional: !!intake.mmm && intake.mmm !== 'MM1',
    is_active: true, job_status: 'open', approval_status: 'approved',
    ats_created: true, posted_by: 'practice_intake',
    details: intakeLogic.buildIntakeJobDetails(intake),
    source_payload: {
      intake,
      practice_intro: { text: practice.intro_text || intake.intro_text || '', video_url: practice.intro_video_url || '' },
      gpLink: { packageTerms: intakeLogic.buildPackageTerms(intake) }
    },
    published_at: now(), synced_at: now()
  }, ['provider', 'provider_role_id']);
  ctx.ids.roles[key] = row.id;
  say('    role:   ' + masked + '  [' + (intake.employment_type || '') + ', approved, open]');
  return row;
}

async function upsertDoctor(ctx, d) {
  const { db, auth } = ctx;
  const id = await ensureAccount(db, auth, d, { userMetadata: { countryDial: d.countryDial, phoneNumber: d.phoneNumber } });
  const registerBody = d.country === 'GB' ? 'gmc' : (d.country === 'IE' ? 'imc' : (d.country === 'NZ' ? 'mcnz' : ''));
  await db.query(
    `update public.user_profiles set country_dial = $2, phone_number = $3, phone = $4,
            qualification_country = $5, preferred_city = $6, target_arrival_date = $7, who_moving = $8,
            register_body = nullif($9, ''), register_number = $10, register_status = 'pending_verification',
            onboarding_completed_at = coalesce(onboarding_completed_at, now()), account_status = 'active'
      where user_id = $1`,
    [id, d.countryDial, d.phoneNumber, (d.countryDial + ' ' + d.phoneNumber).trim(), d.country, d.preferredCity, d.targetDate, d.whoMoving, registerBody, d.registerNumber]);
  // What POST /api/onboarding/complete stores: the wizard's own state object.
  const onboarding = {
    _version: 2, currentStep: 5, country: d.country, registerNumber: d.registerNumber, qualDocs: {}, accountReviewFlag: false,
    targetDate: d.targetDate, preferredCity: d.preferredCity, whoMoving: d.whoMoving, childrenCount: 1, childrenAges: [],
    leadSource: '', leadSourceDetail: '', idVerification: null, completedAt: now()
  };
  await upsertRow(db, 'user_state', { user_id: id, state: { gp_onboarding: onboarding, gp_onboarding_complete: true } }, ['user_id']);
  // (No user_roles row: the app does not write one for a doctor at sign-up.)
  // What _ensureRegCase() creates at sign-up: stage 'myintealth', owned by the admin pool.
  const existing = await db.query('select id from public.registration_cases where user_id = $1 limit 1', [id]);
  let caseId = existing.rows[0] && existing.rows[0].id;
  if (!caseId) {
    const ins = await db.query(
      "insert into public.registration_cases (user_id, stage, status, assigned_va, assigned_rso, last_gp_activity_at) values ($1, 'myintealth', 'active', $2, $2, now()) returning id",
      [id, ctx.ids.staff.adminPool]);
    caseId = ins.rows[0].id;
  }
  ctx.ids.doctors[d.email] = { userId: id, caseId };
  say('  doctor: Dr ' + d.firstName + ' ' + d.lastName + '  <' + d.email + '>  (overseas, ' + d.country + ', onboarding finished, registration case open)');
  return id;
}

(async () => {
  const db = pgClient();
  try { await db.connect(); } catch (e) {
    process.stderr.write('STOP: the local database is not running or not set up (' + e.message + '). Run scripts/au-local/setup.sh\n');
    process.exit(1);
  }
  try {
    await assertLocalDatabase(db);
    const secrets = cfg.loadSecrets();
    const quietOutbox = { recordSystemEmail() {}, note() {}, append() {} };
    const auth = createAuthEmulator({ db, secrets, outbox: quietOutbox });
    const storage = createStorageEmulator({ db, secrets, outbox: quietOutbox });
    const ctx = { db, cfg, auth, storage, say, ids: { staff: {}, practices: {}, roles: {}, doctors: {} } };
    ctx.upsertPractice = (spec) => upsertPractice(ctx, spec);
    ctx.upsertRole = (practice, intake, key) => upsertRole(ctx, practice, intake, key);
    ctx.upsertDoctor = (d) => upsertDoctor(ctx, d);
    ctx.upsertRow = (table, row, conflictCols) => upsertRow(db, table, row, conflictCols);

    await seedStaff(ctx);
    for (const spec of PRACTICES) await upsertPractice(ctx, spec);
    await upsertDoctor(ctx, UK_DOCTOR);

    // Extensions added by later work packages.
    const extDir = path.join(__dirname, 'seed.d');
    if (fs.existsSync(extDir)) {
      for (const f of fs.readdirSync(extDir).filter((x) => x.endsWith('.js')).sort()) {
        say('  extra seed: ' + f);
        const fn = require(path.join(extDir, f));
        await (typeof fn === 'function' ? fn : fn.seed)(ctx);
      }
    }
    say('  password for every seeded login: ' + cfg.TEST_PASSWORD);
  } finally {
    await db.end();
  }
})().catch((err) => {
  process.stderr.write('seed failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(1);
});
