// Phase 6 Batch C4, installable PWA (audit 2026-07-07 platform):
//  1. /manifest.webmanifest is served with the manifest content-type and is
//     valid JSON with name / short_name / start_url / display / icons.
//  2. Every icon the manifest references resolves (200, image/png) through the
//     static handler.
//  3. app-shell.html links the manifest + theme-color; the other primary GP
//     pages carry the manifest link too (asserted from source, those routes
//     are shell-wrapped over HTTP).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');

let server;
let port;

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'true'; // page-serving test, auth is covered elsewhere
  process.env.AUTH_SECRET = 'pwa-manifest-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-pwa-manifest-${RUN_ID}.json`;

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('manifest.webmanifest', () => {
  let res;
  let manifest;

  beforeAll(async () => {
    res = await get('/manifest.webmanifest');
    manifest = JSON.parse(res.raw);
  });

  it('is served with the manifest content-type', () => {
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/manifest\+json/);
  });

  it('has the required installability fields', () => {
    expect(manifest.name).toBe('GP Link');
    expect(manifest.short_name).toBe('GP Link');
    // Clean-URL form: the server 302s /pages/app-shell.html → /pages/app-shell
    // and resolves the extensionless path back to the file internally.
    expect(manifest.start_url).toBe('/pages/app-shell');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#/);
    expect(manifest.background_color).toMatch(/^#/);
  });

  it('declares 192 and 512 icons including a maskable purpose', () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i) => String(i.purpose || '').includes('maskable'))).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.src.startsWith('/')).toBe(true);
    }
  });

  it('every referenced icon resolves through the static handler as a real PNG', async () => {
    const srcs = [...new Set(manifest.icons.map((i) => i.src))];
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      const iconRes = await get(src);
      expect(iconRes.status).toBe(200);
      expect(iconRes.headers['content-type']).toBe('image/png');
      // PNG magic bytes
      expect(iconRes.raw.slice(1, 4)).toBe('PNG');
    }
  });
});

describe('page wiring', () => {
  it('the app-shell entry (manifest start_url) serves and links the manifest + theme-color', async () => {
    // /pages/app-shell, the clean-URL entry the manifest's start_url points at.
    const res = await get('/pages/app-shell');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('rel="manifest"');
    expect(res.raw).toContain('href="/manifest.webmanifest"');
    expect(res.raw).toContain('name="theme-color"');
    expect(res.raw).toContain('rel="apple-touch-icon"');
  });

  it('the primary GP pages carry the manifest link + apple-touch-icon', () => {
    const pages = [
      'index', 'myinthealth', 'amc', 'ahpra', 'career', 'my-documents',
      'visa', 'pbs', 'commencement', 'messages', 'account',
      'registration-intro', 'signin'
    ];
    for (const p of pages) {
      const src = fs.readFileSync(path.join(ROOT, 'pages', `${p}.html`), 'utf8');
      expect(src, `${p}.html missing manifest link`).toContain('href="/manifest.webmanifest"');
      expect(src, `${p}.html missing apple-touch-icon`).toContain('rel="apple-touch-icon"');
      expect(src, `${p}.html missing theme-color`).toContain('name="theme-color"');
    }
  });

  it('the service worker file still serves (registration unaffected)', async () => {
    const res = await get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });
});
