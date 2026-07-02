// Task C — accepting an in-app offer completes the placement (Zoho-free)
// + the offer_contract download fix.
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-offer-flow.test.js. Outbound email (Resend) and push (FCM) are
// captured by wrapping global fetch; every OTHER external host (nominatim /
// homely lifestyle enrichment) is stubbed with an empty 200 so the accept flow
// runs offline-deterministic. A tiny /storage/v1 stub lets the contract upload
// + signed-URL download run for real.
//
// Covers:
//  1. Contract download fix: POST /api/ats/offer with a contract now stores a
//     Supabase Storage path on the user_documents row; GET
//     /api/prepared-documents lists offer_contract READ-ONLY (PUT/DELETE still
//     reject the key → no new upload slot) and /api/prepared-documents/download
//     resolves BOTH shapes — signed storage URL and the Drive-URL fallback for
//     rows delivered without a storage path.
//  2. Accept with an offer record → offer accepted, gp_applications.status
//     placement_secured, gp_career_state written with the offer's terms
//     (GP-share split, start date, case practice contact), task automation
//     observable (practice-pack tasks created), placements row, internal job
//     flipped 'filled', ONE email to the offer sender, NO GP congratulation
//     email, apply-guard 409 + withdraw-block now active, and
//     /api/career/applications reports the secured status + placement (the
//     payload career.html writes into localStorage gp_career_state).
//  3. Accept WITHOUT an offer record → legacy behaviour (stage advance only).
//  4. Decline → offer declined, stage stays 'offer', sender emailed, kind
//     idempotent repeat, 404 for non-owners.
//  5. placements table missing (migration un-applied) → tolerant skip, accept
//     still completes. Runs LAST — the store caches the determination.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-accept-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + storage) emulator

const SUPER_HOST = 'ceo-accept.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-1', email: 'gp@gplink-test.local' };
const GP2 = { userId: 'u-gp-2', email: 'other@gplink-test.local' };
const GP3 = { userId: 'u-gp-3', email: 'third@gplink-test.local' };
const NOW = new Date().toISOString();

// When true the emulator answers every /rest/v1/placements request with the
// PostgREST "table not in schema cache" error — the un-applied-migration case.
let simulateMissingPlacements = false;

// Captured outbound calls.
const resendCalls = [];
const fcmCalls = [];

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Test', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'ie' },
    { user_id: GP3.userId, email: GP3.email, first_name: 'Third', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [
    // Real GP states always carry the progress keys (the app writes them from
    // day one) — task automation stringifies them while diffing.
    { user_id: GP.userId, state: { gp_onboarding_complete: true, gp_push_tokens: [{ token: 'push-tok-1' }], gp_epic_progress: { completed: {} }, gp_amc_progress: { completed: {} }, gp_ahpra_progress: {}, gp_documents_prep: {} }, updated_at: NOW },
    // GP2 carries the Drive-URL-only offer_contract shape (delivered via
    // deliverToMyDocuments + _updatePreparedDocsState — the pre-fix Zoho path).
    {
      user_id: GP2.userId,
      state: {
        gp_onboarding_complete: true,
        gp_epic_progress: { completed: {} },
        gp_prepared_docs: JSON.stringify({ docs: { offer_contract: { url: 'https://drive.google.com/file/d/DRIVE123/view', fileName: 'Contract.pdf', ready: true } } })
      },
      updated_at: NOW
    },
    { user_id: GP3.userId, state: { gp_onboarding_complete: true, gp_epic_progress: { completed: {} }, gp_amc_progress: { completed: {} }, gp_ahpra_progress: {}, gp_documents_prep: {} }, updated_at: NOW }
  ],
  registration_cases: [
    // Case practice contact takes PRECEDENCE over the practice record's contact.
    { id: 'case-1', user_id: GP.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null, practice_contact: { name: 'Casey Contact', email: 'casey@case-contact.local', phone: '+61 400 111 222' } },
    { id: 'case-2', user_id: GP2.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null },
    { id: 'case-3', user_id: GP3.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null }
  ],
  rso_team: [],
  user_roles: [],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD', billing_model: 'Mixed Billing', is_active: true, job_status: 'open', ats_created: true, updated_at: NOW }
  ],
  gp_applications: [
    { id: 'app-1', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW },
    { id: 'app-4', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW },
    { id: 'app-5', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW },
    { id: 'app-6', user_id: GP3.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW }
  ],
  user_documents: [
    // CVs so /api/career/apply reaches the already-placed guard.
    { id: 'doc-cv-gp', user_id: GP.userId, document_key: 'cv_signed_dated', status: 'uploaded' },
    // GP2's offer contract: delivered WITHOUT a storage path (Drive-only shape).
    { id: 'doc-oc-gp2', user_id: GP2.userId, document_key: 'offer_contract', status: 'approved', file_name: 'Contract.pdf' }
  ],
  ats_offers: [
    // Live offers for the decline flow (app-5) and the tolerant-skip flow (app-6).
    { id: 'offer-app5', application_id: 'app-5', user_id: GP2.userId, career_role_id: 'role-1', practice_id: 'p1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', billing_split: '65 / 35', sessions_per_week: '6', compensation_range: '$300k+ estimated', start_date: '2026-10-01', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW },
    { id: 'offer-app6', application_id: 'app-6', user_id: GP3.userId, career_role_id: 'role-1', practice_id: 'p1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', billing_split: '75 / 25', sessions_per_week: '7', compensation_range: '$320k+ estimated', start_date: '2026-11-02', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW }
  ],
  ats_stage_events: [],
  registration_tasks: [],
  task_timeline: [],
  placements: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue; // unsupported → don't filter
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { resolve(null); }
    });
  });
}

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // ── Supabase Storage stub: uploads succeed, signing echoes the path ──
      if (u.pathname.startsWith('/storage/v1/object/sign/')) {
        send(200, { signedURL: u.pathname.replace('/storage/v1', '') + '?token=test-token' });
        return;
      }
      if (u.pathname.startsWith('/storage/v1/object/')) {
        await readBody(req); // drain
        send(200, { Key: u.pathname.replace('/storage/v1/object/', '') });
        return;
      }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      if (table === 'placements' && simulateMissingPlacements) {
        send(404, { code: 'PGRST205', message: "Could not find the table 'public.placements' in the schema cache", details: null, hint: null });
        return;
      }
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        keep.forEach((row) => rows.push(row));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

// ── Session cookie minting (patterns from the sibling test files) ───────────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');

function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (host) headers.Host = host;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

const atsPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });
const gpGet = (p, who = GP) => httpReq('GET', p, { cookie: userCookie(who.email, who.userId) });
const gpPost = (p, body, who = GP) => httpReq('POST', p, { cookie: userCookie(who.email, who.userId), body });

const senderEmails = () => resendCalls.filter((c) => {
  const to = c.body && c.body.to;
  return (Array.isArray(to) ? to : [to]).some((t) => String(t || '').includes(SUPER_EMAIL));
});

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-accept-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-accept.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  // Real email + push config so the notification legs actually run — the
  // wrapped fetch below captures them instead of hitting the network.
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.FCM_SERVER_KEY = 'test-fcm-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (u.startsWith('https://fcm.googleapis.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      fcmCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    // The Supabase emulator (and the app itself) live on 127.0.0.1.
    if (u.startsWith(`http://127.0.0.1`)) return realFetch(url, opts);
    // Everything else (nominatim geocoding, homely listings, …) is stubbed
    // empty so the lifestyle enrichment degrades instantly and offline.
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ── 1. Contract download fix ────────────────────────────────────────────────
describe('offer_contract download fix', () => {
  it('sending an offer with a contract stores a storage path on the user_documents row', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 accept-test contract');
    const r = await atsPost('/api/ats/offer', {
      application_id: 'app-1',
      billing_split: '70 / 30',
      sessions_per_week: '8',
      compensation_range: '$350k+ estimated',
      start_date: '2026-08-03',
      notes: 'Includes relocation help.',
      contract_data_url: 'data:application/pdf;base64,' + pdfBytes.toString('base64'),
      contract_file_name: 'Offer-Contract.pdf'
    });
    expect(r.status).toBe(200);
    expect(r.body.contract_delivered).toBe(true);

    const doc = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'offer_contract');
    expect(doc).toBeTruthy();
    expect(doc.status).toBe('approved');
    // The fix: a Supabase Storage path is now persisted for the download flow.
    expect(String(doc.file_url || '')).toContain('offer-documents/offer_contract');
  });

  it('GET /api/prepared-documents lists offer_contract with an /api/ download link', async () => {
    const r = await gpGet('/api/prepared-documents?country=uk');
    expect(r.status).toBe(200);
    const doc = r.body.docs && r.body.docs.offer_contract;
    expect(doc).toBeTruthy();
    expect(doc.fileName).toBe('Offer-Contract.pdf');
    expect(doc.downloadUrl).toBe('/api/prepared-documents/download?country=uk&key=offer_contract');
    // offer-review.html only shows the button for '/api/…' links + non-rejected.
    expect(String(doc.status)).not.toBe('rejected');
  });

  it('download resolves via the SIGNED-URL shape (storage path on the row)', async () => {
    const r = await gpGet('/api/prepared-documents/download?country=uk&key=offer_contract');
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toContain('/storage/v1/object/sign/');
    expect(String(r.headers.location)).toContain('offer_contract');
  });

  it('download resolves via the DRIVE-URL fallback shape (no storage path)', async () => {
    // GP2's row has no file_url/google_drive_file_id — only the
    // gp_prepared_docs KV entry written by _updatePreparedDocsState.
    const r = await gpGet('/api/prepared-documents/download?country=ie&key=offer_contract', GP2);
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toBe('https://drive.google.com/file/d/DRIVE123/view');
  });

  it('and the GP with nothing stored anywhere still gets a clean 404', async () => {
    const r = await gpGet('/api/prepared-documents/download?country=uk&key=offer_contract', GP3);
    expect(r.status).toBe(404);
  });

  it('offer_contract NEVER becomes an upload slot: PUT and DELETE reject the key', async () => {
    const put = await httpReq('PUT', '/api/prepared-documents', {
      cookie: userCookie(GP.email, GP.userId),
      body: { country: 'uk', key: 'offer_contract', fileName: 'x.pdf', mimeType: 'application/pdf', fileSize: 10, fileDataUrl: 'data:application/pdf;base64,JVBERg==' }
    });
    expect(put.status).toBe(400);
    const del = await httpReq('DELETE', '/api/prepared-documents', {
      cookie: userCookie(GP.email, GP.userId),
      body: { country: 'uk', key: 'offer_contract' }
    });
    expect(del.status).toBe(400);
    // The delivered row is untouched.
    expect(db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'offer_contract')).toBeTruthy();
  });
});

// ── 2. Accept with an in-app offer → placement completes locally ───────────
describe('POST /api/career/offer/accept — offer record exists', () => {
  it('completes the placement end-to-end without Zoho', async () => {
    const sendersBefore = senderEmails().length;
    const r = await gpPost('/api/career/offer/accept', { applicationId: 'app-1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.placement_secured).toBe(true);
    expect(r.body.ats_stage).toBe('hired');

    // Offer record → accepted with a response timestamp.
    const offer = db.ats_offers.find((o) => o.application_id === 'app-1');
    expect(offer.status).toBe('accepted');
    expect(offer.responded_at).toBeTruthy();

    // gp_applications: the status every legacy consumer keys off + the kanban.
    const app = db.gp_applications.find((a) => a.id === 'app-1');
    expect(app.status).toBe('placement_secured');
    expect(app.ats_stage).toBe('hired');
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-1' && e.to_stage === 'hired');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe('gp_accept_offer');

    // gp_career_state — the exact Zoho reverse-sync shape.
    const state = db.user_state.find((s) => s.user_id === GP.userId).state;
    const career = state.gp_career_state;
    expect(career.career_secured).toBe(true);
    const entry = career.applications.find((a) => a.id === 'app-1');
    expect(entry.status).toBe('placement_secured');
    expect(entry.isPlacementSecured).toBe(true);
    expect(entry.provider_role_id).toBe('ats_r1');

    // Placement payload fields career.html's secured view reads.
    const placement = entry.placement;
    expect(placement.practiceName).toBe('Greenslopes Family Medical');
    expect(placement.roleTitle).toBe('General Practitioner — VR');
    expect(placement.location).toBe('Brisbane, QLD');
    expect(placement.statusLabel).toBe('Placement confirmed');
    expect(placement.startDateIso).toBe('2026-08-03');
    // Split is always the GP's (majority) share — '70 / 30' → '70%'.
    const split = placement.quickStats.find((s) => s.label === 'Split');
    expect(split.value).toBe('70%');
    expect(placement.compensation.range).toBe('$350k+ estimated');
    // Case practice_contact takes precedence over the practice record.
    expect(placement.practiceContact.email).toBe('casey@case-contact.local');
    expect(placement.practiceContact.name).toBe('Casey Contact');
    // The delivered contract resolves through the FIXED download path.
    expect(placement.contractUrl).toContain('/api/prepared-documents/download');
    expect(placement.contractUrl).toContain('key=offer_contract');

    // Task automation ran (observable effect: practice-pack tasks created).
    const packTasks = db.registration_tasks.filter((t) => t.case_id === 'case-1' && t.task_type === 'practice_pack_child');
    expect(packTasks.length).toBeGreaterThanOrEqual(5);
    expect(packTasks.map((t) => t.related_document_key)).toContain('sppa_00');

    // Placement-of-record row.
    const placementRow = db.placements.find((p) => p.application_id === 'app-1');
    expect(placementRow).toBeTruthy();
    expect(placementRow.status).toBe('active');
    expect(placementRow.billing_split).toBe('70 / 30');
    expect(placementRow.placed_by).toBe(SUPER_EMAIL);
    expect(placementRow.offer_id).toBe(offer.id);

    // Internal job flipped to filled.
    expect(db.career_roles.find((j) => j.id === 'role-1').job_status).toBe('filled');

    // Exactly ONE email to the offer sender, none congratulating the GP
    // (the page shows its own celebration; journey emails are separate).
    const senders = senderEmails().slice(sendersBefore);
    expect(senders.length).toBe(1);
    expect(String(senders[0].body.subject)).toContain('accepted the offer');
    expect(String(senders[0].body.subject)).toContain('Test Doctor');
    const gpCongrats = resendCalls.filter((c) => {
      const to = c.body && c.body.to;
      const toGp = (Array.isArray(to) ? to : [to]).some((t) => String(t || '').includes(GP.email));
      return toGp && /hired|congratulations/i.test(String(c.body && c.body.subject || ''));
    });
    expect(gpCongrats.length).toBe(0);

    // Case timeline audit entry.
    const tl = db.task_timeline.find((t) => t.case_id === 'case-1' && /Offer accepted in-app/.test(String(t.title || '')));
    expect(tl).toBeTruthy();
  });

  it('repeat accept is idempotent — no new writes, no new emails', async () => {
    const sendersBefore = senderEmails().length;
    const placementsBefore = db.placements.length;
    const r = await gpPost('/api/career/offer/accept', { applicationId: 'app-1' });
    expect(r.status).toBe(200);
    expect(r.body.placement_secured).toBe(true);
    expect(r.body.advanced).toBe(false);
    expect(senderEmails().length).toBe(sendersBefore);
    expect(db.placements.length).toBe(placementsBefore);
  });

  it('the already-placed apply-guard now fires (409 already_placed)', async () => {
    const r = await gpPost('/api/career/apply', { roleId: 'internal_ats:ats_r1' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('already_placed');
  });

  it('the withdraw-block is active for the secured application', async () => {
    const r = await gpPost('/api/career/application/withdraw', { applicationId: 'app-1' });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/secured placement/i);
  });

  it('/api/career/applications reports the secured status + in-app placement (career.html hydration source)', async () => {
    const r = await gpGet('/api/career/applications');
    expect(r.status).toBe(200);
    const app = r.body.applications.find((a) => String(a.id) === 'app-1');
    expect(app).toBeTruthy();
    expect(app.status).toBe('placement_secured');
    expect(app.placement).toBeTruthy();
    expect(app.placement.practiceName).toBe('Greenslopes Family Medical');
    expect(app.placement.quickStats.find((s) => s.label === 'Split').value).toBe('70%');
    expect(app.placement.practiceContact.email).toBe('casey@case-contact.local');
    expect(app.placement.startDateIso).toBe('2026-08-03');
  });
});

// ── 3. Accept WITHOUT an offer record → legacy behaviour preserved ─────────
describe('POST /api/career/offer/accept — no offer record (legacy Zoho apps)', () => {
  it('advances the stage only; status/placement stay untouched for the Zoho sync to write', async () => {
    const sendersBefore = senderEmails().length;
    const r = await gpPost('/api/career/offer/accept', { applicationId: 'app-4' }, GP2);
    expect(r.status).toBe(200);
    expect(r.body.advanced).toBe(true);
    expect(r.body.ats_stage).toBe('hired');
    expect(r.body.placement_secured).toBeUndefined();

    const app = db.gp_applications.find((a) => a.id === 'app-4');
    expect(app.ats_stage).toBe('hired');
    expect(app.status).toBe('applied'); // NOT placement_secured
    expect(db.placements.find((p) => p.application_id === 'app-4')).toBeUndefined();
    const state = db.user_state.find((s) => s.user_id === GP2.userId).state;
    expect(state.gp_career_state).toBeUndefined();
    expect(senderEmails().length).toBe(sendersBefore);
  });
});

// ── 4. Decline ──────────────────────────────────────────────────────────────
describe('POST /api/career/offer/decline', () => {
  it("404s someone else's application (no existence leak)", async () => {
    const r = await gpPost('/api/career/offer/decline', { applicationId: 'app-5' }, GP);
    expect(r.status).toBe(404);
  });

  it('declines the offer, keeps the stage at offer, emails the sender', async () => {
    const sendersBefore = senderEmails().length;
    const r = await gpPost('/api/career/offer/decline', { applicationId: 'app-5' }, GP2);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('declined');

    const offer = db.ats_offers.find((o) => o.application_id === 'app-5');
    expect(offer.status).toBe('declined');
    expect(offer.responded_at).toBeTruthy();

    // The kanban card STAYS in the offer lane for consultant follow-up.
    const app = db.gp_applications.find((a) => a.id === 'app-5');
    expect(app.ats_stage).toBe('offer');
    expect(app.status).toBe('applied');

    const senders = senderEmails().slice(sendersBefore);
    expect(senders.length).toBe(1);
    expect(String(senders[0].body.subject)).toContain('declined the offer');

    const tl = db.task_timeline.find((t) => t.case_id === 'case-2' && /Offer declined/.test(String(t.title || '')));
    expect(tl).toBeTruthy();
  });

  it('a repeat decline is a quiet idempotent 200', async () => {
    const sendersBefore = senderEmails().length;
    const r = await gpPost('/api/career/offer/decline', { applicationId: 'app-5' }, GP2);
    expect(r.status).toBe(200);
    expect(r.body.already).toBe(true);
    expect(senderEmails().length).toBe(sendersBefore);
  });

  it('404s when there is no offer to decline', async () => {
    const r = await gpPost('/api/career/offer/decline', { applicationId: 'app-4' }, GP2);
    expect(r.status).toBe(404);
  });
});

// ── 5. placements table missing → tolerant skip (LAST: cached) ─────────────
describe('placements migration not applied (tolerant skip)', () => {
  it('accept still completes; the placements row is skipped, everything else lands', async () => {
    simulateMissingPlacements = true;
    const r = await gpPost('/api/career/offer/accept', { applicationId: 'app-6' }, GP3);
    expect(r.status).toBe(200);
    expect(r.body.placement_secured).toBe(true);

    expect(db.placements.find((p) => p.application_id === 'app-6')).toBeUndefined();
    const app = db.gp_applications.find((a) => a.id === 'app-6');
    expect(app.status).toBe('placement_secured');
    expect(app.ats_stage).toBe('hired');
    const offer = db.ats_offers.find((o) => o.application_id === 'app-6');
    expect(offer.status).toBe('accepted');
    const state = db.user_state.find((s) => s.user_id === GP3.userId).state;
    expect(state.gp_career_state.career_secured).toBe(true);
    expect(state.gp_career_state.applications.find((a) => a.id === 'app-6').placement.quickStats.find((s) => s.label === 'Split').value).toBe('75%');
  });
});
