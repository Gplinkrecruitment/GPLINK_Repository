// A day-early Zoom join must not complete an interview (production, 2026-09-07/08).
//
// Dr Ganesh's PKG interview was booked for 2026-09-08 09:00Z. The practice
// joined the link on 2026-09-07 09:14Z — a day early, three minutes alone —
// and Zoom sent meeting.ended for that instance. handleZoomMeetingEnded
// completed the call, a garbage summary was fetched and saved, and the
// practice was emailed its extend-offer / decline links before the interview
// had happened. The real instance the next day overwrote the uuid but kept
// summary_status 'saved', so its real summary was never fetched.
//
// Live-boot against the in-memory PostgREST emulator, signed webhooks, Resend
// and Zoom (OAuth + meeting_summary) captured through a fetch override —
// modelled on the Task 9 block in tests/career-contracts-flow.test.js.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');

describe('early-join guard — rule constants and wiring (source assertions)', () => {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');

  it('is tunable by env with the agreed defaults: 60 min before the slot, under 15 min long', () => {
    expect(src).toMatch(/function zoomEarlyJoinMinutes\(\) \{\s*var n = Number\(process\.env\.ZOOM_EARLY_JOIN_MIN\);\s*return Number\.isFinite\(n\) && n > 0 \? n : 60;/);
    expect(src).toMatch(/function zoomEarlyJoinMaxDurationMinutes\(\) \{\s*var n = Number\(process\.env\.ZOOM_EARLY_JOIN_MAX_DURATION_MIN\);\s*return Number\.isFinite\(n\) && n > 0 \? n : 15;/);
  });

  it('dedupes a summary event separately from the meeting.ended for the same instance', () => {
    const at = src.indexOf("const isDuplicate = await checkAndRecordWebhookEvent('zoom', eventId, event, payload);");
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(at - 900, at);
    expect(before).toContain('eventObj.uuid || eventObj.meeting_uuid || payload.id');
    expect(before).toContain("+ ':' + event");
  });

  it('meeting.ended keeps its lookup and its Task 9 guard, and only ever writes admin_notes for an early join', () => {
    const start = src.indexOf('async function handleZoomMeetingEnded(');
    const end = src.indexOf('async function handleZoomSummaryCompleted(');
    const fn = src.slice(start, end);
    expect(fn).toMatch(/status=in\.\(booked,invited,completed\)/);
    expect(fn).toContain("if (callRecord.meeting_kind === 'interview' && callRecord.application_id)");
    const guard = fn.slice(fn.indexOf('if (early.early)'), fn.indexOf('const supersedesEarlySummary'));
    expect(guard).toContain('early join ignored');
    expect(guard).toMatch(/body: \{\s*admin_notes: appendSystemAdminNote\(callRecord\.admin_notes, zoomEarlyJoinNote\(callRecord, timing, early\)\),\s*updated_at: now\s*\}/);
    expect(guard).not.toMatch(/status:|summary_status|zoom_meeting_uuid|completed_at/);
    expect(guard).toContain('return;');
  });
});

describe('early-join guard — live-boot (Zoom webhooks → scheduled_calls)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-zoom-early-${RUN_ID}.json`);
  const ZOOM_SECRET = 'zoom-webhook-secret-' + RUN_ID;
  const GP = { userId: 'u-gp-ej-1', email: 'ej-gp@gplink-test.local' };
  const PRACTICE_EMAIL = 'reception@pkg-test.local';
  const NOW_MS = Date.now();
  const NOW = new Date(NOW_MS).toISOString();
  const H = 3600000;
  const iso = (ms) => new Date(ms).toISOString();

  // Slots: tomorrow (an early join is possible) and two hours ago (a real,
  // on-time instance has just ended).
  const TOMORROW = iso(NOW_MS + 24 * H);
  const PAST_SLOT = iso(NOW_MS - 2 * H);
  const PAST_SLOT_MS = NOW_MS - 2 * H;

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const zoomSummaryRequests = [];

  const app = (id, extra) => Object.assign({
    id, user_id: GP.userId, career_role_id: 'role-ej-1', practice_id: 'p-ej-1', provider_role_id: 'ats_ej_1',
    status: 'interview', ats_stage: 'interview', applied_at: NOW,
    practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'PKG Reception'
  }, extra || {});
  const call = (id, appId, meetingId, extra) => Object.assign({
    id, case_id: null, user_id: GP.userId, application_id: appId, meeting_kind: 'interview',
    status: 'booked', zoom_meeting_id: meetingId, stage: null, summary_status: 'not_requested', created_at: NOW
  }, extra || {});

  const db = {
    user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Ganesh', last_name: 'Testerson', registration_country: 'in' }],
    practices: [{ id: 'p-ej-1', name: 'PKG Medical Centre', source: 'internal_ats', contact_name: 'PKG Reception', contact_email: PRACTICE_EMAIL, is_active: true, created_at: NOW }],
    career_roles: [{ id: 'role-ej-1', provider: 'internal_ats', provider_role_id: 'ats_ej_1', title: 'General Practitioner', practice_name: 'PKG Medical Centre', practice_id: 'p-ej-1', is_active: true, job_status: 'open', updated_at: NOW }],
    gp_applications: [
      app('app-ej-1'),
      app('app-ej-2'),
      // Case 3/5: the early join already emailed the practice (stamped).
      app('app-ej-3', { status: 'interview_completed', interview_completed_at: iso(PAST_SLOT_MS - 24 * H), post_interview_email_sent_at: iso(PAST_SLOT_MS - 24 * H) }),
      app('app-ej-4'),
      app('app-ej-5', { status: 'interview_completed', interview_completed_at: iso(PAST_SLOT_MS - 24 * H), post_interview_email_sent_at: iso(PAST_SLOT_MS - 24 * H) }),
      app('app-ej-6')
    ],
    scheduled_calls: [
      // (1) booked for tomorrow — the practice clicks the link today.
      call('call-ej-1', 'app-ej-1', 'zm-ej-1', { scheduled_at: TOMORROW }),
      // (2) booked two hours ago — a real, on-time instance.
      call('call-ej-2', 'app-ej-2', 'zm-ej-2', { scheduled_at: PAST_SLOT }),
      // (3) completed + saved from an early join a day before the slot (uuid A).
      call('call-ej-3', 'app-ej-3', 'zm-ej-3', {
        scheduled_at: PAST_SLOT, status: 'completed', summary_status: 'saved',
        zoom_meeting_uuid: 'uuid-A-early', completed_at: iso(PAST_SLOT_MS - 24 * H), summary_saved_at: iso(PAST_SLOT_MS - 24 * H + 60000),
        meeting_summary: 'disjointed conversation with no clear main topic', summary_fetch_attempts: 1
      }),
      // (4) booked for tomorrow — Zoom's summary for an early instance arrives.
      call('call-ej-4', 'app-ej-4', 'zm-ej-4', { scheduled_at: TOMORROW }),
      // (5) saved-from-early row; the real instance's summary_completed arrives.
      call('call-ej-5', 'app-ej-5', 'zm-ej-5', {
        scheduled_at: PAST_SLOT, status: 'completed', summary_status: 'saved',
        zoom_meeting_uuid: 'uuid-A5-early', completed_at: iso(PAST_SLOT_MS - 24 * H), summary_saved_at: iso(PAST_SLOT_MS - 24 * H + 60000),
        meeting_summary: 'disjointed conversation with no clear main topic', summary_fetch_attempts: 1
      }),
      // (6) booked two hours ago — both events for ONE instance must be processed.
      call('call-ej-6', 'app-ej-6', 'zm-ej-6', { scheduled_at: PAST_SLOT })
    ],
    webhook_events: [],
    registration_tasks: []
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
      if (!FILTER_OPS.includes(op)) continue;
      filters.push({ col: key, op, val: raw.slice(dot + 1) });
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
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
    });
  }
  function startSupabaseEmulator() {
    return new Promise((resolve) => {
      sbServer = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://sb.local');
        const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
        if (!m) { send(404, { message: 'not found' }); return; }
        const rows = tableOf(decodeURIComponent(m[1]));
        const matches = buildMatcher(u.searchParams);
        if (req.method === 'GET') {
          let out = rows.filter(matches);
          // created_at.desc is what every lookup here orders by; honour it so the
          // "newest row for this meeting" semantics hold in the emulator too.
          if ((u.searchParams.get('order') || '') === 'created_at.desc') out = out.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
          const limit = parseInt(u.searchParams.get('limit') || '', 10);
          if (Number.isFinite(limit)) out = out.slice(0, limit);
          send(200, out); return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const incoming = Array.isArray(body) ? body : (body ? [body] : []);
          const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; rows.push(row); return row; });
          send(201, saved); return;
        }
        if (req.method === 'PATCH') {
          const patch = await readBody(req);
          const matched = rows.filter(matches);
          matched.forEach((row) => Object.assign(row, patch || {}));
          send(200, matched); return;
        }
        send(405, { message: 'method not allowed' });
      });
      sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
    });
  }

  function postZoomWebhook(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = 'v0=' + crypto.createHmac('sha256', ZOOM_SECRET).update('v0:' + ts + ':' + data).digest('hex');
      const r = http.request({
        host: '127.0.0.1', port, path: '/api/webhooks/zoom', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-zm-request-timestamp': ts, 'x-zm-signature': sig }
      }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed }); });
      });
      r.on('error', reject); r.end(data);
    });
  }
  const meetingEnded = (id, uuid, startMs, endMs, duration) => postZoomWebhook({
    event: 'meeting.ended',
    payload: { object: { id, uuid, start_time: startMs == null ? undefined : iso(startMs), end_time: endMs == null ? undefined : iso(endMs), duration } }
  });
  const summaryCompleted = (id, uuid, startMs, endMs) => postZoomWebhook({
    event: 'meeting.summary_completed',
    payload: { object: { id, meeting_uuid: uuid, meeting_start_time: iso(startMs), meeting_end_time: iso(endMs), summary_title: 'Meeting summary' } }
  });

  const appRow = (id) => db.gp_applications.find((a) => a.id === id);
  const callRow = (id) => db.scheduled_calls.find((c) => c.id === id);

  beforeAll(async () => {
    await startSupabaseEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'zoom-early-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = 'hello@mygplink-test.local';
    process.env.ZOOM_WEBHOOK_SECRET = ZOOM_SECRET;
    process.env.ZOOM_CLIENT_ID = 'zoom-client-' + RUN_ID;
    process.env.ZOOM_CLIENT_SECRET = 'zoom-secret-' + RUN_ID;
    process.env.ZOOM_ACCOUNT_ID = 'zoom-account-' + RUN_ID;
    delete process.env.ZOOM_EARLY_JOIN_MIN;
    delete process.env.ZOOM_EARLY_JOIN_MAX_DURATION_MIN;
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';

    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.startsWith('https://api.resend.com/')) {
        let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
        resendCalls.push({ url: u, body: parsed });
        return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
      }
      if (u === 'https://zoom.us/oauth/token') {
        return Promise.resolve(new Response(JSON.stringify({ access_token: 'zoom-test-token', expires_in: 3600 }), { status: 200 }));
      }
      if (u.startsWith('https://api.zoom.us/v2/meetings/')) {
        zoomSummaryRequests.push(u);
        return Promise.resolve(new Response(JSON.stringify({ summary_title: 'Interview', summary_content: 'REAL SUMMARY', next_steps: ['Extend an offer'] }), { status: 200 }));
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

  // (1)
  it('a day-early join that ended now, 3 minutes long, is noted on the row and otherwise ignored: still booked, no stamps, no email', async () => {
    const before = resendCalls.length;
    const r = await meetingEnded('zm-ej-1', 'uuid-ej-1-early', NOW_MS - 3 * 60000, NOW_MS, 3);
    expect(r.status).toBe(200);
    const c = callRow('call-ej-1');
    expect(c.status).toBe('booked');
    expect(c.summary_status).toBe('not_requested');
    expect(c.zoom_meeting_uuid).toBeUndefined();
    expect(c.completed_at).toBeUndefined();
    expect(c.admin_notes).toContain('joined early');
    expect(c.admin_notes).toMatch(/3 min long\. Ignored: not treated as the interview\./);
    expect(c.updated_at).toBeTruthy();
    const a = appRow('app-ej-1');
    expect(a.status).toBe('interview');
    expect(a.interview_completed_at).toBeUndefined();
    expect(a.post_interview_email_sent_at).toBeUndefined();
    expect(resendCalls.length).toBe(before);
  });

  // (2)
  it("an on-time instance completes the call and emails the practice exactly once — today's behaviour", async () => {
    const before = resendCalls.length;
    const r = await meetingEnded('zm-ej-2', 'uuid-ej-2', PAST_SLOT_MS, PAST_SLOT_MS + 30 * 60000, 30);
    expect(r.status).toBe(200);
    const c = callRow('call-ej-2');
    expect(c.status).toBe('completed');
    expect(c.summary_status).toBe('pending');
    expect(c.zoom_meeting_uuid).toBe('uuid-ej-2');
    expect(c.completed_at).toBeTruthy();
    expect(c.admin_notes).toBeUndefined();
    const a = appRow('app-ej-2');
    expect(a.status).toBe('interview_completed');
    expect(a.post_interview_email_sent_at).toBeTruthy();
    expect(resendCalls.length).toBe(before + 1);
    expect(resendCalls[resendCalls.length - 1].body.to).toEqual([PRACTICE_EMAIL]);
    expect(resendCalls[resendCalls.length - 1].body.subject).toBe('How did the interview with Dr Testerson go?');
  });

  // (3)
  it('the real instance supersedes a summary saved from an early join: uuid B, pending, attempts reset, completed_at = its end, no second email', async () => {
    const before = resendCalls.length;
    const endMs = PAST_SLOT_MS + 32 * 60000;
    const r = await meetingEnded('zm-ej-3', 'uuid-B-real', PAST_SLOT_MS, endMs, 32);
    expect(r.status).toBe(200);
    const c = callRow('call-ej-3');
    expect(c.status).toBe('completed');
    expect(c.zoom_meeting_uuid).toBe('uuid-B-real');
    expect(c.summary_status).toBe('pending');
    expect(c.summary_fetch_attempts).toBe(0);
    expect(c.completed_at).toBe(iso(endMs));
    expect(c.admin_notes).toContain('will be replaced');
    // The garbage summary is still there until the fetch replaces it — nothing is deleted blind.
    expect(c.meeting_summary).toBe('disjointed conversation with no clear main topic');
    expect(resendCalls.length).toBe(before);
    expect(appRow('app-ej-3').post_interview_email_sent_at).toBe(iso(PAST_SLOT_MS - 24 * H));
  });

  // (4)
  it("a summary_completed for an early instance on a booked row is ignored: still booked, no email, no Zoom fetch", async () => {
    const before = resendCalls.length;
    const zoomBefore = zoomSummaryRequests.length;
    const r = await summaryCompleted('zm-ej-4', 'uuid-ej-4-early', NOW_MS - 3 * 60000, NOW_MS);
    expect(r.status).toBe(200);
    const c = callRow('call-ej-4');
    expect(c.status).toBe('booked');
    expect(c.summary_status).toBe('not_requested');
    expect(c.zoom_meeting_uuid).toBeUndefined();
    expect(appRow('app-ej-4').status).toBe('interview');
    expect(appRow('app-ej-4').post_interview_email_sent_at).toBeUndefined();
    expect(resendCalls.length).toBe(before);
    expect(zoomSummaryRequests.length).toBe(zoomBefore);
  });

  // (5)
  it('a summary_completed for the real instance on a saved-from-early row re-arms it and fetches THAT instance: REAL SUMMARY, uuid B, saved', async () => {
    const before = resendCalls.length;
    const zoomBefore = zoomSummaryRequests.length;
    const r = await summaryCompleted('zm-ej-5', 'uuid-B5-real', PAST_SLOT_MS, PAST_SLOT_MS + 32 * 60000);
    expect(r.status).toBe(200);
    const c = callRow('call-ej-5');
    expect(c.zoom_meeting_uuid).toBe('uuid-B5-real');
    expect(c.summary_status).toBe('saved');
    expect(c.meeting_summary).toBe('REAL SUMMARY');
    expect(c.summary_fetch_attempts).toBe(1);
    expect(c.completed_at).toBe(iso(PAST_SLOT_MS + 32 * 60000));
    expect(c.admin_notes).toContain('will be replaced');
    expect(zoomSummaryRequests.length).toBe(zoomBefore + 1);
    expect(zoomSummaryRequests[zoomSummaryRequests.length - 1]).toContain('/v2/meetings/uuid-B5-real/meeting_summary');
    // The practice was emailed after the early join already; the re-arm does not email again.
    expect(resendCalls.length).toBe(before);
  });

  // (6)
  it('a meeting.ended and a summary_completed for the SAME instance are both processed — the dedupe id carries the event name', async () => {
    const before = resendCalls.length;
    const ended = await meetingEnded('zm-ej-6', 'uuid-ej-6', PAST_SLOT_MS, PAST_SLOT_MS + 30 * 60000, 30);
    expect(ended.status).toBe(200);
    expect(ended.body.duplicate).toBeUndefined();
    expect(callRow('call-ej-6').status).toBe('completed');
    expect(callRow('call-ej-6').summary_status).toBe('pending');
    expect(resendCalls.length).toBe(before + 1);

    const summary = await summaryCompleted('zm-ej-6', 'uuid-ej-6', PAST_SLOT_MS, PAST_SLOT_MS + 30 * 60000);
    expect(summary.status).toBe(200);
    expect(summary.body.duplicate).toBeUndefined();
    const c = callRow('call-ej-6');
    expect(c.summary_status).toBe('saved');
    expect(c.meeting_summary).toBe('REAL SUMMARY');
    expect(c.zoom_meeting_uuid).toBe('uuid-ej-6');

    const ids = db.webhook_events.filter((e) => e.provider === 'zoom').map((e) => e.event_id);
    expect(ids).toContain('uuid-ej-6:meeting.ended');
    expect(ids).toContain('uuid-ej-6:meeting.summary_completed');
    // ...and a genuine replay of either is still a duplicate.
    const replay = await meetingEnded('zm-ej-6', 'uuid-ej-6', PAST_SLOT_MS, PAST_SLOT_MS + 30 * 60000, 30);
    expect(replay.body.duplicate).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
  });
});
