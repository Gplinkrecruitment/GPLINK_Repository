import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// Practice photos were stored pointing at the Supabase PROJECT host
// (<ref>.supabase.co) because the scripts that populated them ran off a local
// .env, while production talks to the custom domain (login.mygplink.com.au).
//
// Whitelisting the project host in CSP made the marketing site render, but the
// in-app career page still showed broken thumbnails on a real phone: a
// third-party-looking *.supabase.co host is exactly what iOS content blockers,
// Private Relay and corporate DNS drop, and nothing looks wrong server-side
// because the URL still returns 200 to curl.
//
// So every doctor-facing image URL is rewritten onto the SAME first-party
// origin the app already talks to. Both hosts serve the identical object.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const CUSTOM_ORIGIN = 'https://login.mygplink.com.au';
let server;
let addrPort;
let testUtils;

function gpSessionCookie() {
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const payload = b64(JSON.stringify({
    userProfile: { email: 'gp-storage-url@example.com' },
    expiresAt: Date.now() + 3600000,
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `gp_session=${encodeURIComponent(payload + '.' + sig)}`;
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-storage-url-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  // Mirrors production: the CUSTOM domain, not the project host.
  process.env.SUPABASE_URL = CUSTOM_ORIGIN;
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-storage-url-${RUN_ID}.json`;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('public job images are served from the app\'s own Supabase origin', () => {
  it('rewrites a project-host storage URL onto the configured origin', () => {
    const mapped = testUtils.mapCareerRoleRowToPublicJob({
      provider: 'internal_ats',
      provider_role_id: 'x1',
      header_image_url: 'https://rqrqcfxalkvzwbedvsjs.supabase.co/storage/v1/object/public/career-hero-images/Perth/Perth%207.jpg',
    });
    expect(mapped.header_image_url).toBe(
      CUSTOM_ORIGIN + '/storage/v1/object/public/career-hero-images/Perth/Perth%207.jpg'
    );
  });

  it('keeps the object path byte-for-byte, including percent-encoding', () => {
    const mapped = testUtils.mapCareerRoleRowToPublicJob({
      provider: 'internal_ats',
      provider_role_id: 'x2',
      header_image_url: 'https://abc.supabase.co/storage/v1/object/public/career-hero-images/Perth/Perth%206%20%281%29.jpg',
    });
    expect(mapped.header_image_url).toBe(
      CUSTOM_ORIGIN + '/storage/v1/object/public/career-hero-images/Perth/Perth%206%20%281%29.jpg'
    );
  });

  it('leaves non-Supabase image hosts completely alone (the wikimedia majority)', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg';
    const mapped = testUtils.mapCareerRoleRowToPublicJob({
      provider: 'internal_ats', provider_role_id: 'x3', header_image_url: url,
    });
    expect(mapped.header_image_url).toBe(url);
  });

  it('leaves a URL already on the configured origin unchanged', () => {
    const url = CUSTOM_ORIGIN + '/storage/v1/object/public/career-hero-images/Sydney/Sydney%203.jpg';
    const mapped = testUtils.mapCareerRoleRowToPublicJob({
      provider: 'internal_ats', provider_role_id: 'x4', header_image_url: url,
    });
    expect(mapped.header_image_url).toBe(url);
  });

  it('is empty-safe and does not invent a URL', () => {
    const mapped = testUtils.mapCareerRoleRowToPublicJob({
      provider: 'internal_ats', provider_role_id: 'x5', header_image_url: '',
    });
    expect(mapped.header_image_url).toBe('');
  });

  it('does not touch non-storage paths on a supabase host (auth/rest endpoints)', () => {
    const url = 'https://abc.supabase.co/auth/v1/authorize?provider=google';
    const mapped = testUtils.mapCareerRoleRowToPublicJob({
      provider: 'internal_ats', provider_role_id: 'x6', header_image_url: url,
    });
    expect(mapped.header_image_url).toBe(url);
  });
});
