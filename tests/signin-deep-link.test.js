import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// ============================================================================
// Owner report 2026-08-06: the offer email's "Secure my position" button did
// not survive sign-in — the doctor signed in and landed on the home dashboard
// instead of their agreement.
//
// The server bounce was fine (verified against prod: /pages/offer-review?…
// → 302 /pages/signin?next=%2Fpages%2Foffer-review%3F… , query intact), and
// signin.html honours ?next on its own login paths. The culprit was
// js/auth-guard.js, which runs on the SAME page and, the moment a session
// resolved, did window.location.replace("/pages/index") unconditionally —
// racing signin.html and winning. It also fired when the doctor was already
// signed in and never saw a login form at all.
// ============================================================================
describe('auth-guard honours the deep link through sign-in', () => {
  const GUARD = fs.readFileSync(path.join(ROOT, 'js/auth-guard.js'), 'utf8');

  it('no longer hard-codes /pages/index on the sign-in page', () => {
    expect(GUARD).not.toContain('if (isSignInPage) {\n        window.location.replace("/pages/index");');
    expect(GUARD).toContain('safeSignInNextPath() || "/pages/index"');
  });

  it('validates next exactly like signin.html — internal /pages/ only', () => {
    const start = GUARD.indexOf('function safeSignInNextPath');
    expect(start).toBeGreaterThan(-1);
    const body = GUARD.slice(start, start + 600);
    expect(body).toMatch(/\^\\\/pages\\\//);   // must start /pages/
    expect(body).toMatch(/\\\/\\\//);          // rejects protocol-relative
    expect(body).toMatch(/:\\\/\\\//);         // rejects scheme
  });

  it('the validator accepts the offer deep link and refuses open redirects', () => {
    // Re-create the function standalone so the RULES are tested, not just their
    // presence in the file.
    const start = GUARD.indexOf('function safeSignInNextPath');
    const end = GUARD.indexOf('function isReviewRouteAllowed');
    const src = GUARD.slice(start, end);
    const make = new Function('window', 'URLSearchParams', src + '; return safeSignInNextPath;');
    const run = (search) => make({ location: { search } }, URLSearchParams)();

    expect(run('?next=%2Fpages%2Foffer-review%3FapplicationId%3Dabc123'))
      .toBe('/pages/offer-review?applicationId=abc123');
    expect(run('?next=%2Fpages%2Fahpra.html%3Fdoc%3Dsppa_00')).toBe('/pages/ahpra.html?doc=sppa_00');
    expect(run('')).toBe('');
    expect(run('?next=%2F%2Fevil.test%2Fx')).toBe('');            // protocol-relative
    expect(run('?next=https%3A%2F%2Fevil.test')).toBe('');         // absolute
    expect(run('?next=%2Fadmin')).toBe('');                        // outside /pages/
  });

  it('every page ships the bumped guard (a stale pin serves the old redirect)', () => {
    const pages = fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => f.endsWith('.html'));
    // Match the actual <script src=…auth-guard.js…> tag, not any mention of the
    // filename: signin.html and error.html inline a copy of the guard's
    // same-origin path validator and reference it by name in a comment, which a
    // bare .includes() counted as "ships the guard" and then demanded a
    // cache-buster those pages have no script tag to carry.
    const shipsGuard = (html) => /<script\b[^>]*\bsrc\s*=\s*["'][^"']*auth-guard\.js/i.test(html);
    const withGuard = pages.filter((f) => shipsGuard(fs.readFileSync(path.join(ROOT, 'pages', f), 'utf8')));
    expect(withGuard.length).toBeGreaterThan(0);
    withGuard.forEach((f) => {
      const html = fs.readFileSync(path.join(ROOT, 'pages', f), 'utf8');
      expect(html).toMatch(/auth-guard\.js\?v=20260810a/);
      expect(html).not.toContain('auth-guard.js?v=20260806a');
    });
  });
});
