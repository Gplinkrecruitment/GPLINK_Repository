// The staff offer band (2026-07-31), and the silent-nudge bug it exposed.
//
// ── Why this file exists ────────────────────────────────────────────────────
// tests/ai-matching-pipeline.test.js:427-459 ("post-interview silence gets
// chased") is a describe block of SOURCE GREPS. Every one of them passed
// while pass B of /api/cron/practice-decision-reminders sent literally
// nothing: it called sendPostInterviewDecisionEmail(piApp.id), which
// short-circuits on the post_interview_email_sent_at stamp that the SAME
// function wrote when the interview ended, and which nothing ever clears. The
// helper returned {skipped:'already_sent'}; the cron still incremented pdSent,
// still patched last_practice_reminder_at, and still reported
// {ok:true, reminders_sent:N}. Only the day-7 CEO chase ever reached a human.
//
// A grep for "sendPostInterviewDecisionEmail(piApp.id)" can never see that,
// because the call really is there and really is spelled correctly. Only a
// behavioural test that watches the outbound mail can. Hence this file: it
// boots the real server against an in-memory PostgREST emulator (same pattern
// as tests/career-contracts-flow.test.js) and counts actual emails.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('offer band: forced post-interview chase, offer-state, contract nudge (live-boot)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-nudge-${RUN_ID}.json`);
  const GP_A = { userId: 'u-gp-nx-a', email: 'gp-nx-a@gplink-test.local' };
  const GP_B = { userId: 'u-gp-nx-b', email: 'gp-nx-b@gplink-test.local' };
  const SUPER_HOST = 'ceo-nx.local';
  const SUPER_EMAIL = 'super-nx@gplink-test.local';
  const NOW = Date.now();
  const DAY = 86400000;
  const isoDaysAgo = (d) => new Date(NOW - d * DAY).toISOString();

  const APP_FORCE = 'app-nx-force';        // the silent-nudge repro
  const APP_AWAIT = 'app-nx-await';        // practice has not decided; no contract
  const APP_EXT = 'app-nx-extended';       // contract uploaded, v1 voided
  const APP_DECLINED = 'app-nx-declined';  // practice turned the doctor down
  const APP_GP = 'app-nx-gp';              // contract sitting with the doctor
  const APP_CONSENT = 'app-nx-consent';    // change request sitting with the practice
  const APP_SIGNED = 'app-nx-signed';      // done — nobody to chase
  const APP_VOIDONLY = 'app-nx-voidonly';  // only discarded revisions
  const APP_LIMIT = 'app-nx-limit';        // 6h rate-limit subject

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];

  const practiceApp = (id, userId, extra) => Object.assign({
    id,
    user_id: userId,
    career_role_id: 'role-nx-1',
    practice_id: 'p-nx-1',
    status: 'interview_completed',
    ats_stage: 'interview',
    practice_contact_email: 'reception@erina-test.local',
    practice_contact_name: 'Erina Reception',
    applied_at: isoDaysAgo(30)
  }, extra || {});

  const db = {
    user_profiles: [
      { user_id: GP_A.userId, email: GP_A.email, first_name: 'Priya', last_name: 'Nair', registration_country: 'uk' },
      { user_id: GP_B.userId, email: GP_B.email, first_name: 'Tomasz', last_name: 'Kowalski', registration_country: 'ie' }
    ],
    career_roles: [
      { id: 'role-nx-1', provider: 'internal_ats', title: 'General Practitioner — VR', practice_name: 'Erina Family Medical Centre', practice_id: 'p-nx-1', is_active: true, job_status: 'open' }
    ],
    practices: [
      { id: 'p-nx-1', name: 'Erina Family Medical Centre', contact_email: 'reception@erina-test.local', contact_name: 'Erina Reception' }
    ],
    gp_applications: [
      // Already emailed 6 days ago — exactly the state pass B finds, and
      // exactly the state the unforced guard refuses to act on.
      practiceApp(APP_FORCE, GP_A.userId, { post_interview_email_sent_at: isoDaysAgo(6), interview_completed_at: isoDaysAgo(6) }),
      practiceApp(APP_AWAIT, GP_A.userId, { post_interview_email_sent_at: isoDaysAgo(5), interview_completed_at: isoDaysAgo(5), practice_reminder_count: 2, last_practice_reminder_at: isoDaysAgo(3) }),
      practiceApp(APP_EXT, GP_B.userId, { post_interview_email_sent_at: isoDaysAgo(9), interview_completed_at: isoDaysAgo(9) }),
      practiceApp(APP_DECLINED, GP_A.userId, { status: 'not_proceeding', ats_stage: 'not_proceeding', practice_decision: 'turned_down', practice_decision_reason: 'Went with an internal candidate.', post_interview_email_sent_at: isoDaysAgo(8), interview_completed_at: isoDaysAgo(8) }),
      practiceApp(APP_GP, GP_B.userId, { status: 'offer', ats_stage: 'offer' }),
      practiceApp(APP_CONSENT, GP_B.userId, { status: 'offer', ats_stage: 'offer' }),
      practiceApp(APP_SIGNED, GP_A.userId, { status: 'offer', ats_stage: 'offer' }),
      practiceApp(APP_VOIDONLY, GP_A.userId, { status: 'offer', ats_stage: 'offer' }),
      practiceApp(APP_LIMIT, GP_A.userId, { post_interview_email_sent_at: isoDaysAgo(4), interview_completed_at: isoDaysAgo(4) })
    ],
    career_contracts: [
      // APP_EXT: v1 was returned to the practice (void), v2 is the live upload.
      { id: 'c-nx-ext-v1', application_id: APP_EXT, user_id: GP_B.userId, career_role_id: 'role-nx-1', version: 1, status: 'void', ai_review_status: 'not_run', created_at: isoDaysAgo(8), updated_at: isoDaysAgo(7) },
      {
        id: 'c-nx-ext-v2', application_id: APP_EXT, user_id: GP_B.userId, career_role_id: 'role-nx-1', version: 2, status: 'uploaded',
        ai_review_status: 'done',
        ai_review: {
          overall: 'minor_gaps',
          summary: 'Sessions per week is lower than what was agreed at interview.',
          discrepancies: [{ field: 'sessions_per_week', contract_says: '6', expected: '8', source: 'interview_summary', severity: 'warning' }],
          interview_terms_available: true
        },
        contract_bucket: 'gp-link-documents', contract_path: 'contracts/nx/ext/v2/contract.pdf', contract_filename: 'erina-contract.pdf',
        ceo_note: 'Chased sessions figure with the practice.',
        uploaded_at: isoDaysAgo(1), created_at: isoDaysAgo(7), updated_at: isoDaysAgo(1)
      },
      { id: 'c-nx-gp-v1', application_id: APP_GP, user_id: GP_B.userId, career_role_id: 'role-nx-1', version: 1, status: 'sent_to_gp', ai_review_status: 'done', contract_bucket: 'gp-link-documents', contract_path: 'contracts/nx/gp/v1/contract.pdf', uploaded_at: isoDaysAgo(6), sent_to_gp_at: isoDaysAgo(4), created_at: isoDaysAgo(6), updated_at: isoDaysAgo(4) },
      { id: 'c-nx-consent-v1', application_id: APP_CONSENT, user_id: GP_B.userId, career_role_id: 'role-nx-1', version: 1, status: 'practice_review', ai_review_status: 'done', change_request: 'Please make the start date 1 November.', practice_contact_email: 'reception@erina-test.local', practice_contact_name: 'Erina Reception', created_at: isoDaysAgo(5), updated_at: isoDaysAgo(2) },
      { id: 'c-nx-signed-v1', application_id: APP_SIGNED, user_id: GP_A.userId, career_role_id: 'role-nx-1', version: 1, status: 'signed', ai_review_status: 'done', signed_at: isoDaysAgo(1), created_at: isoDaysAgo(6), updated_at: isoDaysAgo(1) },
      { id: 'c-nx-void-v1', application_id: APP_VOIDONLY, user_id: GP_A.userId, career_role_id: 'role-nx-1', version: 1, status: 'void', ai_review_status: 'not_run', created_at: isoDaysAgo(6), updated_at: isoDaysAgo(5) }
    ],
    runtime_kv: [],
    ats_stage_events: [],
    user_state: [
      { user_id: GP_A.userId, state: { gp_onboarding_complete: true }, updated_at: isoDaysAgo(0) },
      { user_id: GP_B.userId, state: { gp_onboarding_complete: true }, updated_at: isoDaysAgo(0) }
    ]
  };

  const appRow = (id) => db.gp_applications.find((a) => a.id === id);
  const contractRow = (id) => db.career_contracts.find((c) => c.id === id);

  function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
  function buildMatcher(params) {
    const filters = [];
    for (const [k, v] of params.entries()) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      const mm = /^(eq|neq)\.(.*)$/s.exec(v);
      if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
    }
    return (row) => filters.every((f) => {
      const cell = row ? row[f.col] : undefined;
      const eq = String(cell) === String(f.val);
      return f.op === 'eq' ? eq : !eq;
    });
  }

  function startEmulator() {
    return new Promise((resolve) => {
      sbServer = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://sb.local');
        const sendJson = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const readRaw = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });

        if (u.pathname.startsWith('/storage/v1/')) {
          const mm = u.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { await readRaw(); sendJson(200, { signedURL: '/object/sign/' + mm[1] + '?token=test-sign-token' }); return; }
          sendJson(404, { message: 'storage not found' }); return;
        }

        // Deliberately NOT implementing /rest/v1/rpc/rate_limit_hit: the 404
        // is what makes checkRateLimitWindow fall back to its runtime_kv
        // path, which this emulator DOES support. Same behaviour a database
        // that has not had the rate_limit_hit migration applied would show.
        const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
        if (!m) { sendJson(404, { message: 'not found' }); return; }
        const rows = tableOf(decodeURIComponent(m[1]));
        const matches = buildMatcher(u.searchParams);
        if (req.method === 'GET') {
          let out = rows.filter(matches);
          const limit = parseInt(u.searchParams.get('limit') || '', 10);
          if (Number.isFinite(limit)) out = out.slice(0, limit);
          sendJson(200, out); return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readRaw()).toString('utf8') || 'null');
          const incoming = Array.isArray(body) ? body : (body ? [body] : []);
          const saved = incoming.map((r) => {
            const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
            rows.push(row); return row;
          });
          sendJson(201, saved); return;
        }
        if (req.method === 'PATCH') {
          const patch = JSON.parse((await readRaw()).toString('utf8') || 'null');
          const matched = rows.filter(matches);
          matched.forEach((row) => Object.assign(row, patch || {}));
          sendJson(200, matched); return;
        }
        if (req.method === 'DELETE') {
          const matched = rows.filter(matches);
          matched.forEach((row) => { const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1); });
          sendJson(200, matched); return;
        }
        sendJson(405, { message: 'method not allowed' });
      });
      sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
    });
  }

  function httpJson(method, p, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = Object.assign({}, extraHeaders || {});
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed }); });
      });
      r.on('error', reject); r.end(data);
    });
  }
  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function adminCookie(role) {
    const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: role || 'super_admin' }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
  }
  const atsGet = (p, withCookie = true) => httpJson('GET', p, null, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));
  const atsPost = (p, body, withCookie = true) => httpJson('POST', p, body, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'nudge-nx-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = 'gp-link-documents';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = 'hello@mygplink-test.local';
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
    process.env.ADMIN_EMAILS = '';

    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.startsWith('https://api.resend.com/')) {
        let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
        resendCalls.push({ url: u, body: parsed });
        return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
      }
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    vi.resetModules();
    mod = await import('../server.js');
    server = mod.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
  });

  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;
    if (server) await new Promise((r) => server.close(r));
    if (sbServer) await new Promise((r) => sbServer.close(r));
    try { fs.unlinkSync(DB_FILE); } catch {}
  });

  // ── 1. THE SILENT NUDGE ───────────────────────────────────────────────────

  it('BUG REPRO: an unforced re-send on an already-emailed application short-circuits and sends NOTHING', async () => {
    const before = resendCalls.length;
    const result = await mod.__testUtils.sendPostInterviewDecisionEmail(APP_FORCE);
    expect(result).toEqual({ ok: false, skipped: 'already_sent' });
    // This is the whole bug: pass B made exactly this call and then counted a
    // reminder anyway. No email left the building.
    expect(resendCalls.length).toBe(before);
  });

  it('force:true reaches the send path even though post_interview_email_sent_at is already set', async () => {
    const before = resendCalls.length;
    const priorStamp = appRow(APP_FORCE).post_interview_email_sent_at;
    const result = await mod.__testUtils.sendPostInterviewDecisionEmail(APP_FORCE, { force: true, reminder: true });
    expect(result.ok).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.to).toContain('reception@erina-test.local');
    // The stamp is refreshed so the next chase is measured from this send.
    expect(appRow(APP_FORCE).post_interview_email_sent_at).not.toBe(priorStamp);
  });

  it('the forced send reads as a follow-up, not a byte-for-byte repeat of the first email', async () => {
    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.subject).toBe('Still thinking about Dr Nair?');
    expect(sent.subject).not.toContain('How did the interview');
    expect(sent.text).toContain("We haven't heard back yet about Dr Nair");
    // Same ask, same one-click decision links — only the framing changed.
    expect(sent.text).toContain('/pages/practice-offer.html?token=');
    expect(sent.text).toContain('intent=offer');
    expect(sent.text).toContain('intent=decline');
  });

  it('a forced send does NOT re-stamp status/interview_completed_at (the escalation clock keeps running)', async () => {
    const row = appRow(APP_FORCE);
    expect(row.status).toBe('interview_completed');
    // Still 6 days ago, not "just now" — otherwise every chase would reset the
    // day-3/day-5/day-7 cadence and the day-7 CEO escalation could never fire.
    expect(row.interview_completed_at).toBe(isoDaysAgo(6));
  });

  it('the first-send guard is intact: an unforced call still short-circuits after a forced one', async () => {
    const before = resendCalls.length;
    const result = await mod.__testUtils.sendPostInterviewDecisionEmail(APP_FORCE);
    expect(result).toEqual({ ok: false, skipped: 'already_sent' });
    expect(resendCalls.length).toBe(before);
  });

  it('force does not override the terminal-application guard', async () => {
    const before = resendCalls.length;
    const result = await mod.__testUtils.sendPostInterviewDecisionEmail(APP_DECLINED, { force: true, reminder: true });
    expect(result).toEqual({ ok: false, skipped: 'terminal' });
    expect(resendCalls.length).toBe(before);
  });

  // ── 2. GET /api/ats/application/offer-state ───────────────────────────────

  it('offer-state: 401/403 without a staff session', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_AWAIT, false);
    expect([401, 403]).toContain(r.status);
  });

  it('offer-state: 404 for an unknown application id', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=app-does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, message: 'Application not found.' });
  });

  it('offer-state: 400 without an applicationId', async () => {
    const r = await atsGet('/api/ats/application/offer-state');
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('offer-state: awaiting practice decision — full shape, contract null, empty history', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_AWAIT);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.applicationId).toBe(APP_AWAIT);
    expect(r.body.stage).toBe('interview');
    expect(r.body.status).toBe('interview_completed');
    expect(r.body.outOfPipeline).toBe(false);
    expect(r.body.contract).toBe(null);
    expect(r.body.history).toEqual([]);
    expect(r.body.practice).toEqual({
      decision: 'awaiting',
      name: 'Erina Family Medical Centre',
      contactEmail: 'reception@erina-test.local',
      contactName: 'Erina Reception',
      emailSentAt: isoDaysAgo(5),
      daysSinceEmail: 5,
      remindersSent: 2,
      lastReminderAt: isoDaysAgo(3),
      declineReason: '',
      interviewCompletedAt: isoDaysAgo(5)
    });
  });

  it('offer-state: day counts are whole days, and null (not 0) when the anchor timestamp is absent', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_GP);
    expect(r.status).toBe(200);
    expect(r.body.contract.daysSinceUploaded).toBe(6);
    expect(r.body.contract.daysSinceSentToGp).toBe(4);
    expect(r.body.contract.signedAt).toBe(null);
    // No post-interview email on this row at all.
    expect(r.body.practice.emailSentAt).toBe(null);
    expect(r.body.practice.daysSinceEmail).toBe(null);
  });

  it('offer-state: an extended offer exposes the live contract, its AI verdict and a 1h signed url', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_EXT);
    expect(r.status).toBe(200);
    expect(r.body.practice.decision).toBe('extended');
    expect(r.body.outOfPipeline).toBe(false);

    const c = r.body.contract;
    expect(c.id).toBe('c-nx-ext-v2');
    expect(c.version).toBe(2);
    expect(c.status).toBe('uploaded');
    expect(c.statusLabel).toBe('Awaiting your review');
    expect(c.uploadedAt).toBe(isoDaysAgo(1));
    expect(c.sentToGpAt).toBe(null);
    expect(c.signedAt).toBe(null);
    expect(c.daysSinceUploaded).toBe(1);
    expect(c.daysSinceSentToGp).toBe(null);
    expect(typeof c.fileUrl).toBe('string');
    expect(c.fileUrl).toContain('/object/sign/');
    expect(c.signedFileUrl).toBe(null);
    expect(c.changeRequest).toBe('');
    expect(c.changeResponse).toBe('');
    expect(c.ceoNote).toBe('Chased sessions figure with the practice.');
    expect(c.ai).toEqual({
      status: 'done',
      overall: 'minor_gaps',
      summary: 'Sessions per week is lower than what was agreed at interview.',
      discrepancies: [{ field: 'sessions_per_week', severity: 'warning', contract_says: '6', expected: '8', source: 'interview_summary' }],
      interviewTermsAvailable: true
    });
  });

  it('offer-state: history is EVERY version including void rows, newest version first, with isLive', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_EXT);
    expect(r.body.history.map((h) => h.version)).toEqual([2, 1]);
    expect(r.body.history.map((h) => h.id)).toEqual(['c-nx-ext-v2', 'c-nx-ext-v1']);
    expect(r.body.history[0].isLive).toBe(true);
    expect(r.body.history[1].isLive).toBe(false);
    expect(r.body.history[1].status).toBe('void');
    expect(r.body.history[1].statusLabel).toBe('Replaced by a later version');
    expect(r.body.history[1].createdAt).toBe(isoDaysAgo(8));
    expect(r.body.history[1].updatedAt).toBe(isoDaysAgo(7));
  });

  it('offer-state: a void-only application has history but no live contract', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_VOIDONLY);
    expect(r.status).toBe(200);
    expect(r.body.contract).toBe(null);
    expect(r.body.history).toHaveLength(1);
    expect(r.body.history[0].isLive).toBe(false);
    // A contract row exists, so the practice DID extend — the live row was
    // just discarded.
    expect(r.body.practice.decision).toBe('extended');
  });

  it('offer-state: a practice decline reports declined + outOfPipeline with the reason', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_DECLINED);
    expect(r.status).toBe(200);
    expect(r.body.outOfPipeline).toBe(true);
    expect(r.body.practice.decision).toBe('declined');
    expect(r.body.practice.declineReason).toBe('Went with an internal candidate.');
    expect(r.body.status).toBe('not_proceeding');
  });

  it('offer-state: never leaks a bare storage path, an upload/consent token or a practice action token', async () => {
    const r = await atsGet('/api/ats/application/offer-state?applicationId=' + APP_EXT);
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain('uploadToken');
    expect(raw).not.toContain('practice_action_token');
    expect(raw).not.toContain('practice-offer.html?token=');
    expect(raw).not.toContain('practice-consent.html?token=');
    // No raw storage columns. The object path DOES appear inside the signed
    // URL — that is what a signed URL is, and GET /api/ceo/contracts is
    // identical — but nowhere else, so nothing can be re-signed from it.
    expect(raw).not.toContain('contract_bucket');
    expect(raw).not.toContain('contract_path');
    expect(raw).not.toContain('signed_bucket');
    const stripped = raw.split('"fileUrl":"')[1].split('"')[0];
    expect(stripped).toContain('/storage/v1/object/sign/');
    expect(raw.replace(stripped, '')).not.toContain('contracts/nx/ext/v2/contract.pdf');
  });

  // ── 3. POST /api/ats/contract/nudge ───────────────────────────────────────

  it('nudge: 401/403 without a staff session', async () => {
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_AWAIT }, false);
    expect([401, 403]).toContain(r.status);
  });

  it('nudge: 404 for an unknown application id', async () => {
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: 'app-does-not-exist' });
    expect(r.status).toBe(404);
  });

  it('nudge: no contract yet → chases the practice with a FORCED follow-up email', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_AWAIT });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, target: 'practice' });
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.to).toContain('reception@erina-test.local');
    expect(sent.subject).toBe('Still thinking about Dr Nair?');
    // Recorded on the column that already exists for a practice chase.
    expect(appRow(APP_AWAIT).last_practice_reminder_at).not.toBe(isoDaysAgo(3));
  });

  it('nudge: a second nudge inside 6 hours is 429 too_soon with a retryAfterMinutes budget', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_AWAIT });
    expect(r.status).toBe(429);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('too_soon');
    expect(r.body.retryAfterMinutes).toBeGreaterThan(0);
    expect(r.body.retryAfterMinutes).toBeLessThanOrEqual(360);
    // Nothing was sent — this is a real gate, not a cosmetic response.
    expect(resendCalls.length).toBe(before);
  });

  it('nudge: the 6h window is PER APPLICATION — a different application is unaffected', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_LIMIT });
    expect(r.status).toBe(200);
    expect(r.body.target).toBe('practice');
    expect(resendCalls.length).toBe(before + 1);
    const again = await atsPost('/api/ats/contract/nudge', { applicationId: APP_LIMIT });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('too_soon');
  });

  it('nudge: a contract sitting with the doctor chases the doctor, not the practice', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_GP });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.target).toBe('gp');
    expect(r.body.emailed).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.to).toContain(GP_B.email);
    expect(sent.subject).toContain('Your contract is still waiting');
    expect(sent.html).toContain('/pages/offer-review?applicationId=' + APP_GP);
    // Same in-app notification the rest of the contract pipeline writes.
    const state = db.user_state.find((s) => s.user_id === GP_B.userId).state;
    expect(state.gp_link_updates[0].category).toBe('career');
    expect(state.gp_link_updates[0].title).toContain('Your contract is still waiting');
  });

  it('nudge: a change request sitting with the practice chases the practice on the consent ask', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_CONSENT });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, target: 'practice' });
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.to).toContain('reception@erina-test.local');
    expect(sent.subject).toContain('requested contract change');
    expect(sent.html).toContain('Please make the start date 1 November.');
    expect(sent.html).toContain('/pages/practice-consent.html?token=');
  });

  it('nudge: 409 nothing_to_nudge once the contract is signed', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_SIGNED });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('nothing_to_nudge');
    expect(resendCalls.length).toBe(before);
  });

  it('nudge: 409 nothing_to_nudge when every revision is void', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_VOIDONLY });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('nothing_to_nudge');
    expect(resendCalls.length).toBe(before);
  });

  it('nudge: 409 nothing_to_nudge on a terminal application (nobody chases a practice about a doctor who is gone)', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_DECLINED });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('nothing_to_nudge');
    expect(resendCalls.length).toBe(before);
  });

  it('nudge: a refused nudge does not spend the 6h budget', async () => {
    // APP_SIGNED 409'd above; the rate-limit gate runs AFTER routing, so a
    // repeated refusal keeps answering 409 rather than degrading to 429.
    const r = await atsPost('/api/ats/contract/nudge', { applicationId: APP_SIGNED });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('nothing_to_nudge');
  });

  it('nudge: 400 without an applicationId', async () => {
    const r = await atsPost('/api/ats/contract/nudge', {});
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  // ── 4. Permission boundary ────────────────────────────────────────────────

  it('the CEO-only contract ACTIONS were not widened: ai-check still refuses a consultant', async () => {
    // Deliberate: every career_contracts *action* endpoint (/api/ceo/contracts,
    // /api/ceo/contract/decision, /api/ceo/contract/change-decision,
    // /api/ceo/contract/ai-check) is requireCeoSession. The two endpoints added
    // here are read-only / reminder-only, so they take requireAtsSession — but
    // nothing above widened an existing permission.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const aiCheck = src.slice(src.indexOf("if (pathname === '/api/ceo/contract/ai-check' && req.method === 'POST')"));
    expect(aiCheck.slice(0, 600)).toContain('requireCeoSession(req, res)');
    expect(aiCheck.slice(0, 600)).not.toContain('requireAtsSession(req, res)');
  });
});
