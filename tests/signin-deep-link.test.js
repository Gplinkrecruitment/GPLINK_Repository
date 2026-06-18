import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Regression coverage for the re-upload deep-link bug: when Hazel (an RSO) asks a
// GP to re-upload a document, the email's "Re-upload Document" button points at
// /pages/my-documents.html?reupload=<key>. A logged-out GP hitting that link is
// bounced through the server-side auth gate to /pages/signin. The gate USED to
// drop the destination (bare /pages/signin), so after signing in the GP landed on
// the dashboard instead of the document. The gate now preserves the destination as
// ?next=, which pages/signin.html honours after login.

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let baseUrl;

// Plain GET that does NOT follow redirects (we assert on the 302 itself).
function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

const SIGNIN = '/pages/signin';
const next = (dest) => SIGNIN + '?next=' + encodeURIComponent(dest);

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false'; // auth ENABLED so the protected-page gate fires
  process.env.AUTH_SECRET = 'test-signin-deep-link-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-test-signin-deep-link-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('sign-in deep-link preservation (?next)', () => {
  it('the email .html re-upload link survives the clean-URL hop AND preserves the deep link', async () => {
    // Hop 1: .html -> clean URL, query preserved
    const r1 = await get('/pages/my-documents.html?reupload=mrcgp_certificate');
    expect(r1.status).toBe(302);
    expect(r1.headers.location).toBe('/pages/my-documents?reupload=mrcgp_certificate');
    // Hop 2: unauthenticated protected page -> signin, deep link preserved as ?next
    const r2 = await get(r1.headers.location);
    expect(r2.status).toBe(302);
    expect(r2.headers.location).toBe(next('/pages/my-documents?reupload=mrcgp_certificate'));
  });

  it('unauthenticated protected page with a deep-link query redirects to signin?next=<destination>', async () => {
    const res = await get('/pages/my-documents?reupload=mrcgp_certificate');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(next('/pages/my-documents?reupload=mrcgp_certificate'));
  });

  it('preserves a plain protected page (no query) as ?next', async () => {
    const res = await get('/pages/account');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(next('/pages/account'));
  });

  it('does NOT add ?next for the default dashboard (/pages/index)', async () => {
    const res = await get('/pages/index');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SIGNIN);
  });

  it('strips app-shell embed params (gp_shell, gp_shell_static) from the preserved ?next', async () => {
    const res = await get('/pages/my-documents?reupload=mrcgp_certificate&gp_shell=embedded&gp_shell_static=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(next('/pages/my-documents?reupload=mrcgp_certificate'));
  });

  it('/logout still redirects to bare /pages/signin (no next)', async () => {
    const res = await get('/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SIGNIN);
  });

  it('the preserved next is a safe internal path that signin.html will accept', async () => {
    const res = await get('/pages/my-documents?reupload=mrcgp_certificate');
    const nextVal = new URLSearchParams(res.headers.location.split('?').slice(1).join('?')).get('next');
    expect(nextVal).toBe('/pages/my-documents?reupload=mrcgp_certificate');
    // Mirrors the open-redirect guard in pages/signin.html
    expect(/^\/pages\//.test(nextVal)).toBe(true);
    expect(/^\/\//.test(nextVal)).toBe(false);
    expect(/:\/\//.test(nextVal)).toBe(false);
  });
});
