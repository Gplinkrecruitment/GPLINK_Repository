// Task 5 (2026-07-18 AI job write-up + review design), admin-only preview of
// a not-yet-live job. The public website filters to is_active=true and
// /api/career/role has never had its own active/approval gate, so a pending
// (auto-created-on-signing, is_active:false) job needs a dedicated preview
// path the CEO can open before approving. THE WHOLE POINT of this feature is
// the security boundary: ?preview=1 must only ever bypass gating when the
// request ALSO carries a valid admin/ATS session (super_admin or consultant,
// on an admin-scoped host), a bare, unauthenticated preview=1 must be a
// total no-op.
//
// Boots the real server in LOCAL-JSON mode (same pattern as
// tests/ats-endpoints.test.js), so the local-JSON fallback paths this task
// added (getCareerRoleRowForPreview's dbState.atsJobs branch) run for real,
// without needing a Supabase/PostgREST emulator.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-preview-${RUN_ID}.json`);
const SUPER_HOST = 'preview-test.local';
let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function signedCookie(cookieName, userProfile) {
  const payload = b64url(JSON.stringify({ userProfile, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return cookieName + '=' + encodeURIComponent(payload + '.' + sig);
}
// Admin/ATS session, same shape tests/ats-endpoints.test.js's superCookie() uses.
function superCookie() {
  return signedCookie('gp_admin_session', { email: 'super@gplink-test.local', adminRole: 'super_admin' });
}
// Plain GP session, no admin role at all, so getAtsSessionSoft must reject it.
function gpCookie(email) {
  return signedCookie('gp_session', { email });
}
function req(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end(data);
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

const NOW = new Date().toISOString();
const PENDING_PROVIDER_ROLE_ID = 'ats_prev1';
const PENDING_PUBLIC_ID = 'internal_ats:' + PENDING_PROVIDER_ROLE_ID;
const LIVE_PROVIDER_ROLE_ID = 'ats_prevlive1';
const LIVE_PUBLIC_ID = 'internal_ats:' + LIVE_PROVIDER_ROLE_ID;
const PENDING_PRACTICE_NAME = 'Preview Pipeline Practice, DO NOT LEAK';
const LIVE_PRACTICE_NAME = 'Live Pipeline Practice, DO NOT LEAK';

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'preview-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  // Seed the local-JSON DB before the server loads it (same base dev seed
  // ats-endpoints.test.js uses), then inject our own pending + live fixtures.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });

  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  seeded.atsJobs = seeded.atsJobs || [];
  seeded.atsJobs.push(
    // Pending job, the exact shape createPendingJobFromIntake writes
    // (is_active:false, approval_status:'pending'), auto-created the moment a
    // practice signs, before any CEO review. dpa:false is deliberate: a
    // non-DPA role is normally redacted (buildRedactedRoleStub) for any
    // viewer with no known GP profile, proving admin preview bypasses THAT
    // gate too, not merely the is_active filter.
    {
      id: 'preview-jp1', provider: 'internal_ats', provider_role_id: PENDING_PROVIDER_ROLE_ID,
      title: 'GP, Preview Suburb', masked_title: 'GP | Suburb of Preview Town | Mixed billing',
      practice_name: PENDING_PRACTICE_NAME,
      location_city: 'Preview Town', location_state: 'QLD', suburb: 'Preview Suburb', nearest_city: 'Preview Town',
      is_active: false, job_status: 'open', approval_status: 'pending', dpa: false,
      billing_model: 'Mixed billing', earnings_text: '$300k+ package',
      ats_created: true, created_at: NOW, updated_at: NOW,
      source_payload: {
        gpLink: {
          aiWriteup: {
            about: 'A well-established, GP-owned practice on the outskirts of a regional Queensland hub, with a supportive multidisciplinary team and flexible session options.',
            highlights: ['Supportive, GP-owned team', 'Flexible sessions', 'Strong earning potential'],
            sources: ['form'],
            generatedAt: NOW
          }
        }
      }
    },
    // Live/approved job, used to prove preview=1 doesn't change the shape
    // of an already-public job's response.
    {
      id: 'preview-jh1', provider: 'internal_ats', provider_role_id: LIVE_PROVIDER_ROLE_ID,
      title: 'GP, Live Suburb', masked_title: 'GP | Suburb of Live Town | Private billing',
      practice_name: LIVE_PRACTICE_NAME,
      location_city: 'Live Town', location_state: 'QLD', suburb: 'Live Suburb', nearest_city: 'Live Town',
      is_active: true, job_status: 'open', approval_status: 'approved', dpa: true,
      billing_model: 'Private billing', earnings_text: '$350k+ package',
      ats_created: true, created_at: NOW, updated_at: NOW,
      source_payload: {
        gpLink: {
          aiWriteup: {
            about: 'A modern private-billing clinic in a fast-growing coastal community, with strong nursing support and no on-call requirement.',
            highlights: ['No on-call', 'Strong nursing support', 'Growing community'],
            sources: ['form'],
            generatedAt: NOW
          }
        }
      }
    }
  );
  fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('Admin-only preview, in-app GET /api/career/role', () => {
  it('(a) preview=1 + a valid admin session resolves the pending job, AI write-up included', async () => {
    const r = await req('GET', '/api/career/role?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.role).toBeTruthy();
    expect(b.role.preview).toBe(true);
    expect(b.role.aiAbout).toContain('GP-owned practice');
    expect(b.role.aiHighlights).toContain('Supportive, GP-owned team');
    // Identity masking stays intact even in preview, same name-free shape a
    // qualifying GP would see.
    expect(JSON.stringify(b.role)).not.toContain(PENDING_PRACTICE_NAME);
    expect(b.role.revealed).toBeFalsy();
  });

  it('(b) preview=1 WITHOUT a valid admin session never reveals the pending job', async () => {
    // No session at all, same admin-scoped host: matches today's plain
    // unauthenticated 401, preview=1 changes nothing.
    const anon = await req('GET', '/api/career/role?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST });
    expect(anon.status).toBe(401);
    expect(parse(anon.raw)?.role?.aiAbout).toBeFalsy();

    // A plain GP session (no admin cookie) is treated IDENTICALLY whether or
    // not preview=1 is present, proving the flag by itself is inert without
    // an admin/ATS session riding along.
    const cookie = gpCookie('plain-gp@gplink-test.local');
    const gpNoPreview = await req('GET', '/api/career/role?id=' + encodeURIComponent(PENDING_PUBLIC_ID), { host: SUPER_HOST, cookie });
    const gpWithPreview = await req('GET', '/api/career/role?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST, cookie });
    expect(gpWithPreview.status).toBe(gpNoPreview.status);
    expect(gpWithPreview.raw).toBe(gpNoPreview.raw);
    const gpBody = parse(gpWithPreview.raw);
    expect(gpBody?.role?.aiAbout).toBeFalsy();
    expect(JSON.stringify(gpBody)).not.toContain(PENDING_PRACTICE_NAME);

    // Also confirm a non-admin host can never satisfy getAtsSessionSoft even
    // while carrying a byte-identical admin cookie, the host scope check
    // isn't bypassable just by having a signed cookie.
    const wrongHost = await req('GET', '/api/career/role?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: 'not-an-admin-host.example.com', cookie: superCookie() });
    expect(wrongHost.status).not.toBe(200);
  });

  it('(c) preview=1 + admin session does not change a normal live job\'s response shape', async () => {
    const cookie = gpCookie('plain-gp-live@gplink-test.local');
    const normal = await req('GET', '/api/career/role?id=' + encodeURIComponent(LIVE_PUBLIC_ID), { host: SUPER_HOST, cookie });
    const preview = await req('GET', '/api/career/role?id=' + encodeURIComponent(LIVE_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST, cookie: superCookie() });
    expect(normal.status).toBe(200);
    expect(preview.status).toBe(200);
    const normalRole = parse(normal.raw).role;
    const previewRole = parse(preview.raw).role;
    expect(previewRole.preview).toBe(true);
    expect(normalRole.preview).toBeUndefined();
    // Same shape otherwise, preview only ever ADDS the `preview` marker.
    delete previewRole.preview;
    expect(previewRole).toEqual(normalRole);
    expect(previewRole.aiAbout).toContain('modern private-billing clinic');
  });
});

describe('Admin-only preview, public website (/api/public/jobs + /jobs/view)', () => {
  it('(d) GET /api/public/jobs?id=&preview=1 reveals the pending job only WITH an admin session', async () => {
    const withAdmin = await req('GET', '/api/public/jobs?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST, cookie: superCookie() });
    expect(withAdmin.status).toBe(200);
    const wb = parse(withAdmin.raw);
    expect(wb.ok).toBe(true);
    expect(wb.jobs).toHaveLength(1);
    expect(wb.jobs[0].id).toBe(PENDING_PUBLIC_ID);
    expect(wb.jobs[0].aiAbout).toContain('GP-owned practice');
    expect(JSON.stringify(wb)).not.toContain(PENDING_PRACTICE_NAME);

    const withoutAdmin = await req('GET', '/api/public/jobs?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST });
    expect(withoutAdmin.status).toBe(200); // public API always 200, never a 401/404
    const nb = parse(withoutAdmin.raw);
    expect(nb.ok).toBe(true);
    expect(nb.jobs).toHaveLength(0);

    const gpSession = await req('GET', '/api/public/jobs?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST, cookie: gpCookie('plain-gp-public@gplink-test.local') });
    expect(parse(gpSession.raw).jobs).toHaveLength(0);
  });

  it('(d) GET /jobs/view?id=&preview=1 renders the pending job\'s SEO head only WITH an admin session', async () => {
    const withAdmin = await req('GET', '/jobs/view?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST, cookie: superCookie() });
    expect(withAdmin.status).toBe(200);
    expect(withAdmin.raw).toContain('Suburb of Preview Town');
    expect(withAdmin.raw).not.toContain(PENDING_PRACTICE_NAME);

    const withoutAdmin = await req('GET', '/jobs/view?id=' + encodeURIComponent(PENDING_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST });
    expect(withoutAdmin.status).toBe(200); // falls back to the plain static page
    expect(withoutAdmin.raw).not.toContain('Suburb of Preview Town');
    expect(withoutAdmin.raw).not.toContain(PENDING_PRACTICE_NAME);
  });

  it('a LIVE job is unaffected by preview=1 + admin session on the public path', async () => {
    const preview = await req('GET', '/api/public/jobs?id=' + encodeURIComponent(LIVE_PUBLIC_ID) + '&preview=1', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(preview.raw);
    expect(b.ok).toBe(true);
    expect(b.jobs).toHaveLength(1);
    expect(b.jobs[0].id).toBe(LIVE_PUBLIC_ID);
    expect(b.jobs[0].aiAbout).toContain('modern private-billing clinic');
    expect(JSON.stringify(b)).not.toContain(LIVE_PRACTICE_NAME);
  });
});
