import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
const SRC = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../js/ceo-ats-candidates.js', import.meta.url), 'utf8');
const DASHBOARD_HTML = readFileSync(new URL('../pages/ceo-dashboard.html', import.meta.url), 'utf8');
const ADMIN_HTML = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');

describe('identity document persistence (source contract)', () => {
  it('defines saveIdentityDocumentForUser writing a user_documents identity row', () => {
    expect(SRC).toMatch(/function saveIdentityDocumentForUser\(/);
    expect(SRC).toMatch(/document_key:\s*'identity'/);
    // full storage tuple (so CEO/ATS can sign a URL later)
    expect(SRC).toMatch(/storage_bucket:\s*SUPABASE_DOCUMENT_BUCKET/);
    expect(SRC).toMatch(/buildIdentityDocumentStoragePath/);
  });
  it('verify-identity persists on a successful read (calls saveIdentityDocumentForUser)', () => {
    expect(SRC).toMatch(/saveIdentityDocumentForUser\(/);
  });
  it('identity persistence never creates a doc-review task', () => {
    const fn = SRC.match(/async function saveIdentityDocumentForUser\([\s\S]*?\n}\n/);
    expect(fn).toBeTruthy();
    expect(fn[0]).not.toMatch(/_createRegTask|createDocReviewTask/);
    // and it must file into the Drive ID subfolder
    expect(SRC).toMatch(/driveDocFolders\.ID_FOLDER/);
  });
  it('gp-documents exposes identityDocument only under a CEO gate', () => {
    expect(SRC).toMatch(/function canViewIdentity\(/);
    expect(SRC).toMatch(/canViewIdentity\(gdAdminCtx\)/);
    // built from a signed URL over the identity user_documents row
    expect(SRC).toMatch(/document_key=eq\.identity/);
    expect(SRC).toMatch(/supabaseStorageCreateSignedUrl/);
    expect(SRC).toMatch(/identityDocument:/);
  });
});

describe('ATS candidate file — viewable ID (Task 5, source contract)', () => {
  it('ATS exposes candidate-id under requireAtsSession and idDoc detects the identity row', () => {
    expect(SRC).toMatch(/\/api\/ats\/candidate-id/);
    expect(SRC).toMatch(/requireAtsSession/);
    // idDoc now also true from a user_documents identity row, not only id_copy_data_url
    expect(SRC).toMatch(/document_key === 'identity'/);
  });
  it('candidate-id is modelled on candidate-cv: same guard, same signed-URL + 404 shape, its own audit action', () => {
    const block = SRC.match(/if \(pathname === '\/api\/ats\/candidate-id'[\s\S]*?\n {2}\}\n/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/requireAtsSession\(req, res\); if \(!ctxID\) return;/);
    expect(block[0]).toMatch(/document_key=eq\.identity/);
    expect(block[0]).toMatch(/supabaseStorageCreateSignedUrl/);
    expect(block[0]).toMatch(/sendJson\(res, 404,/);
    expect(block[0]).toMatch(/logAdminAction\(req, ctxID, 'ats_id_viewed'/);
    // never touches the CV/cv_signed_dated document — this route is ID-only
    expect(block[0]).not.toMatch(/cv_signed_dated/);
  });
  it('atsGetDocFlagsProd.idDoc ORs-in a live user_documents identity row', () => {
    const fn = SRC.match(/async function atsGetDocFlagsProd\([\s\S]*?\n\}\n/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toMatch(/idDoc: present\(function \(r\) \{ return r\.document_key === 'identity'; \}\) \|\|/);
  });
  it('js/ceo-ats-candidates.js renders a "View ID" button for a present idDoc and wires it to /api/ats/candidate-id', () => {
    expect(JS).toMatch(/d\.k === 'idDoc' && has/);
    expect(JS).toMatch(/class="ats-btn ats-btn-ghost ats-btn-sm ats-id-view"/);
    expect(JS).toMatch(/>View ID</);
    expect(JS).toMatch(/function viewCandidateId\(btn\)/);
    expect(JS).toMatch(/openSignedDoc\('\/api\/ats\/candidate-id\?' \+ q/);
    // delegated click handler wiring
    expect(JS).toMatch(/e\.target\.closest\('\.ats-id-view'\)/);
  });
  it('pages/ceo-dashboard.html carries a bumped ceo-ats-candidates.js cache-buster', () => {
    expect(DASHBOARD_HTML).toMatch(/ceo-ats-candidates\.js\?v=\d{8}[a-z]/);
  });
});

describe('ATS candidate file — viewable ID (Task 5, http harness)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const SUPER_HOST = 'ceo-id-view.local';
  const ADMIN_HOST = 'admin-id-view.local';
  const SUPER_EMAIL = 'super@gplink-test.local';
  const ADMIN_EMAIL = 'employee@gplink-test.local';
  const DB_FILE = `/tmp/gplink-identity-id-view-${RUN_ID}.json`;
  let server, port;

  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function adminCookieFor(email, adminRole) {
    const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
  }

  function httpReq(method, p, { cookie, host, body } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (host) headers.Host = host;
      let payload = null;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null; try { parsed = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  beforeAll(async () => {
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'identity-id-view-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_PUBLISHABLE_KEY = '';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
    process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
    process.env.CONSULTANT_EMAILS = '';
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    const { createServer } = await import('../server.js');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.unlinkSync(DB_FILE); } catch {}
  });

  // requireAtsSession's real branch order (resolveAdminRequestContext) is:
  // no host scope -> 404, no session -> 401, session but non-ATS role -> 403.
  // A fully unauthenticated request (no cookie at all) therefore surfaces as
  // 401, not 403 -- verified directly against the running server rather than
  // assumed, matching the existing candidate-cv 'fenced off' test elsewhere
  // in this suite. Both branches are asserted below so the ATS gate on this
  // new route is proven end to end: no session is rejected, and a real,
  // authenticated-but-wrong-role session is rejected with 403.
  it('no session at all on the ATS host is 401 (unauthenticated)', async () => {
    const r = await httpReq('GET', '/api/ats/candidate-id?user_id=u-1&case_id=c-1', { host: SUPER_HOST });
    expect(r.status).toBe(401);
  });

  it('an authenticated non-ATS admin role is 403 (proves the requireAtsSession gate)', async () => {
    const r = await httpReq('GET', '/api/ats/candidate-id?user_id=u-1&case_id=c-1', {
      host: ADMIN_HOST,
      cookie: adminCookieFor(ADMIN_EMAIL, 'admin')
    });
    expect(r.status).toBe(403);
    expect(String(r.body && r.body.message || '')).toMatch(/ATS access/i);
  });

  // Task 6: POST /api/admin/gp-identity-delete, reusing this same running
  // server/host config. Note: server.js's admin-host allowlists (and AUTH_SECRET)
  // are read once into module-level consts on first `import('../server.js')` in
  // this process, so a second beforeAll block in this file setting fresh
  // SUPER_ADMIN_ALLOWED_HOSTS/ADMIN_ALLOWED_HOSTS/AUTH_SECRET env vars would be
  // silently ignored by Node's ESM module cache (the module doesn't re-evaluate).
  // These delete-endpoint checks therefore live in this describe, against the
  // SUPER_HOST/ADMIN_HOST that are actually wired up.
  it('no session at all on the super-admin host is 401 (unauthenticated) for gp-identity-delete', async () => {
    const r = await httpReq('POST', '/api/admin/gp-identity-delete', { host: SUPER_HOST, body: { user_id: 'u-1' } });
    expect(r.status).toBe(401);
  });

  it('an authenticated RSO ("admin" role) session is 403 on gp-identity-delete (proves canViewIdentity/CEO-only gate)', async () => {
    const r = await httpReq('POST', '/api/admin/gp-identity-delete', {
      host: ADMIN_HOST,
      cookie: adminCookieFor(ADMIN_EMAIL, 'admin'),
      body: { user_id: 'u-1' }
    });
    expect(r.status).toBe(403);
    expect(String(r.body && r.body.message || '')).toMatch(/CEO\/ATS access/i);
  });
});

describe('identity document deletion (Task 6, source contract)', () => {
  it('defines an idempotent purge helper and a CEO-gated delete endpoint', () => {
    expect(SRC).toMatch(/function purgeStoredIdentityDocument\(/);
    expect(SRC).toMatch(/\/api\/admin\/gp-identity-delete/);
    expect(SRC).toMatch(/canViewIdentity\(/); // reused as the delete gate
  });
  it('purgeStoredIdentityDocument removes every stored copy, each step in its own try/catch', () => {
    const fn = SRC.match(/async function purgeStoredIdentityDocument\([\s\S]*?\n\}\n/);
    expect(fn).toBeTruthy();
    const body = fn[0];
    // 1) Supabase storage object, at the identity storage path
    expect(body).toMatch(/supabaseStorageDeleteObject\(SUPABASE_DOCUMENT_BUCKET, buildIdentityDocumentStoragePath\(userId\)\)/);
    // 2) Drive "ID — " file(s)
    expect(body).toMatch(/deleteIdentityDriveFiles\(userId\)/);
    // 3) the identity user_documents row
    expect(body).toMatch(/'user_documents'[\s\S]*?document_key=eq\.identity[\s\S]*?method: 'DELETE'/);
    // 4) legacy user_profiles fields cleared
    expect(body).toMatch(/id_copy_data_url: ''/);
    expect(body).toMatch(/id_copy_name: ''/);
    // every step wrapped so a single failure never throws out of the helper
    const tryCatchCount = (body.match(/try \{/g) || []).length;
    expect(tryCatchCount).toBeGreaterThanOrEqual(4);
    // idempotent / guarded when unconfigured
    expect(body).toMatch(/if \(!userId \|\| !isSupabaseDbConfigured\(\)\) return \{ removed: false \}/);
    expect(body).toMatch(/return \{ removed: true \}/);
  });
  it('deleteIdentityDriveFiles scans both the candidate root and the ID subfolder for "ID — " files', () => {
    const fn = SRC.match(/async function deleteIdentityDriveFiles\([\s\S]*?\n\}\n/);
    expect(fn).toBeTruthy();
    const body = fn[0];
    expect(body).toMatch(/ensureGPDriveFolder\(/);
    expect(body).toMatch(/ensureDocTypeSubfolder\(folderId, driveDocFolders\.ID_FOLDER, null\)/);
    expect(body).toMatch(/drive\.files\.list\(/);
    expect(body).toMatch(/supportsAllDrives: true/);
    expect(body).toMatch(/includeItemsFromAllDrives: true/);
    expect(body).toMatch(/\/\^ID — \//);
    expect(body).toMatch(/deleteGoogleDriveFile\(f\.id\)/);
    // silent no-op without Drive creds
    expect(body).toMatch(/if \(!isGoogleDriveConfigured\(\)/);
  });
  it('the delete endpoint is CEO-gated, requires user_id, purges, and audit-logs', () => {
    const block = SRC.match(/if \(req\.method === 'POST' && pathname === '\/api\/admin\/gp-identity-delete'\)[\s\S]*?\n {2}\}\n/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/requireAdminSession\(req, res\)/);
    expect(block[0]).toMatch(/if \(!canViewIdentity\(idDelCtx\)\) \{ sendJson\(res, 403,/);
    expect(block[0]).toMatch(/Missing user_id\./);
    expect(block[0]).toMatch(/purgeStoredIdentityDocument\(targetUserId\)/);
    expect(block[0]).toMatch(/logAdminAction\(req, idDelCtx, 'identity_deleted',/);
    expect(block[0]).toMatch(/sendJson\(res, 200, \{ ok: true, removed:/);
  });
  it('pages/ceo-dashboard.html renders a Delete ID button wired to the delete endpoint', () => {
    expect(DASHBOARD_HTML).toMatch(/function ceoDeleteIdentityDoc\(/);
    expect(DASHBOARD_HTML).toMatch(/>Delete ID</);
    expect(DASHBOARD_HTML).toMatch(/\/api\/admin\/gp-identity-delete/);
    expect(DASHBOARD_HTML).toMatch(/confirm\(/);
  });
  it('pages/admin.html renders a Delete ID button wired to the delete endpoint', () => {
    expect(ADMIN_HTML).toMatch(/function vaDeleteIdentityDoc\(/);
    expect(ADMIN_HTML).toMatch(/>Delete ID</);
    expect(ADMIN_HTML).toMatch(/\/api\/admin\/gp-identity-delete/);
    expect(ADMIN_HTML).toMatch(/confirm\(/);
  });
});

