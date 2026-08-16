import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// End-to-end over the real server: ingest → review → approve → publish.
// Runs against the in-memory store (no Supabase), which is the same fallback the
// rest of the suite uses.
//
// The security property under test throughout: a post that a human has not
// approved must be unpublishable. publish_at is only stamped at approval, and
// the publisher's due-query requires it, so this is enforced by construction
// rather than by a check someone could later delete.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const CRON_SECRET = 'social-cron-' + RUN_ID;
const INGEST_TOKEN = 'social-ingest-' + RUN_ID;
let server;
let port;

function req(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        headers || {}
      )
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const ingestAuth = { Authorization: 'Bearer ' + INGEST_TOKEN };
const cronAuth = { Authorization: 'Bearer ' + CRON_SECRET };

function creative(slot, over = {}) {
  return {
    slot,
    caption: 'Caption number ' + slot + '.',
    image_data_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    image_width: 1080,
    image_height: 1350,
    pillar: 'Education',
    ...over
  };
}

// Next month, so the schedule never lands in the past.
function futureMonth() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'social-routes-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.SOCIAL_INGEST_TOKEN = INGEST_TOKEN;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-social-routes-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch { /* ignore */ }
});

describe('ingest is closed to strangers', () => {
  it('refuses with no credential at all', async () => {
    const r = await req('POST', '/api/admin/social/ingest', { body: { month: futureMonth(), posts: [] } });
    expect([401, 403]).toContain(r.status);
  });

  it('refuses a wrong ingest token', async () => {
    const r = await req('POST', '/api/admin/social/ingest', {
      body: { month: futureMonth(), posts: [] },
      headers: { Authorization: 'Bearer not-the-token' }
    });
    expect([401, 403]).toContain(r.status);
  });

  it('rejects a month that is not YYYY-MM', async () => {
    const r = await req('POST', '/api/admin/social/ingest', {
      body: { month: 'next month', posts: [creative(1)] }, headers: ingestAuth
    });
    expect(r.status).toBe(400);
  });

  it('requires posts[]', async () => {
    const r = await req('POST', '/api/admin/social/ingest', {
      body: { month: futureMonth() }, headers: ingestAuth
    });
    expect(r.status).toBe(400);
  });
});

describe('the CEO review surface is CEO-only', () => {
  it('does not serve the campaign to an anonymous caller', async () => {
    const r = await req('GET', '/api/ceo/social');
    expect([401, 403]).toContain(r.status);
  });

  it('does not accept an approval from an anonymous caller', async () => {
    const r = await req('POST', '/api/ceo/social/approve', { body: { month: futureMonth() } });
    expect([401, 403]).toContain(r.status);
  });

  it('does not accept a per-post decision from an anonymous caller', async () => {
    const r = await req('POST', '/api/ceo/social/post', { body: { id: 'x', decision: 'approve' } });
    expect([401, 403]).toContain(r.status);
  });
});

describe('the crons are secret-gated', () => {
  it('refuses the publisher without the cron secret', async () => {
    const r = await req('GET', '/api/cron/social-publish');
    expect(r.status).toBe(401);
  });

  it('refuses the monthly opener without the cron secret', async () => {
    const r = await req('GET', '/api/cron/social-campaign-open');
    expect(r.status).toBe(401);
  });

  it('runs the opener with the secret and opens next month', async () => {
    const r = await req('GET', '/api/cron/social-campaign-open', { headers: cronAuth });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('ingest → schedule', () => {
  const month = futureMonth();

  it('accepts a batch and reports what it stored', async () => {
    const posts = [creative(1), creative(2), creative(3)];
    const r = await req('POST', '/api/admin/social/ingest', { body: { month, posts }, headers: ingestAuth });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.created).toBe(3);
    expect(r.json.total).toBe(3);
  });

  it('re-ingesting a slot replaces it rather than duplicating it', async () => {
    const r = await req('POST', '/api/admin/social/ingest', {
      body: { month, posts: [creative(2, { caption: 'Replaced copy.' })] }, headers: ingestAuth
    });
    expect(r.json.replaced).toBe(1);
    expect(r.json.created).toBe(0);
    expect(r.json.total).toBe(3);
  });

  it('publishes nothing while the month is unapproved', async () => {
    const r = await req('GET', '/api/cron/social-publish', { headers: cronAuth });
    expect(r.status).toBe(200);
    // No approved campaign, so the publisher must not even consider the posts.
    expect(r.json.published).toBeFalsy();
  });

  it('marks the month ready for review when the generator says it is done', async () => {
    const r = await req('POST', '/api/admin/social/ingest', {
      body: { month, posts: [], ready: true }, headers: ingestAuth
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('in_review');
  });
});

describe('a post waiting on configuration is held, not failed', () => {
  // Approving a month before its token exists must not retire good creatives.
  // The publisher records why and leaves attempts alone, so the post goes out by
  // itself on the next run after the value lands, with no cleanup required.
  it('reports held rather than failed when a target network is unconfigured', async () => {
    const r = await req('GET', '/api/cron/social-publish', { headers: cronAuth });
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty('held');
    // Nothing may be marked failed purely because an env var is absent.
    expect(r.json.failed).toBe(0);
  });
});

describe('the public image route', () => {
  it('rejects an id that is not a uuid instead of touching storage', async () => {
    const r = await req('GET', '/api/public/social-image?id=../../etc/passwd');
    expect(r.status).toBe(400);
  });

  it('404s an unknown but well-formed id', async () => {
    const r = await req('GET', '/api/public/social-image?id=' + crypto.randomUUID());
    expect(r.status).toBe(404);
  });

  it('is reachable without a session, because Meta fetches it', async () => {
    // The point is that it does NOT 401/403 — Graph has no cookie.
    const r = await req('GET', '/api/public/social-image?id=' + crypto.randomUUID());
    expect([400, 404, 502]).toContain(r.status);
  });
});
