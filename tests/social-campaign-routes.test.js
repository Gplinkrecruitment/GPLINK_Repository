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

// ── scheduling a month in batches ───────────────────────────────────────────
// Owner, 2026-08-18: "I should be able to approve and schedule in less than all of
// the creatives." Approving used to demand a decision on every post, which stranded
// 19 reviewed creatives behind 11 unread ones, and the endpoint then 409'd
// ("That month is already approved.") so a partial schedule could never be topped up.
//
// The security property is unchanged and is re-asserted below: a date is only ever
// written to an approved post, and the publisher's due-query needs BOTH, so an
// undecided post stays unpublishable no matter how many batches are booked.
describe('a month can be scheduled in batches, then topped up', () => {
  const month = (() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 2, 1);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  })();
  let ids = {};

  function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function ceoCookie() {
    const payload = b64url(JSON.stringify({
      userProfile: { email: 'ceo@gplink-test.local', adminRole: 'super_admin' },
      expiresAt: Date.now() + 3600000
    }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
  }
  // Built lazily: AUTH_SECRET is only set in beforeAll, and a cookie minted at
  // collection time would be signed with `undefined`.
  const ceo = () => ({ Cookie: ceoCookie() });

  async function board() {
    const r = await req('GET', '/api/ceo/social?month=' + month, { headers: ceo() });
    expect(r.status).toBe(200);
    return r.json;
  }
  function decide(slot, decision) {
    return req('POST', '/api/ceo/social/post', { body: { id: ids[slot], decision }, headers: ceo() });
  }
  const scheduleNow = () => req('POST', '/api/ceo/social/approve', { body: { month }, headers: ceo() });

  it('ingests five creatives and marks the month ready', async () => {
    const r = await req('POST', '/api/admin/social/ingest', {
      body: { month, posts: [1, 2, 3, 4, 5].map((s) => creative(s)), ready: true }, headers: ingestAuth
    });
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(5);
    const b = await board();
    b.posts.forEach((p) => { ids[p.slot] = p.id; });
    expect(Object.keys(ids)).toHaveLength(5);
    expect(b.summary.by_status.draft).toBe(5);
  });

  it('refuses to schedule while nothing has been approved yet', async () => {
    const r = await scheduleNow();
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/Approve at least one of the 5 post/);
  });

  it('schedules the first batch of two while three are still undecided', async () => {
    expect((await decide(1, 'approve')).status).toBe(200);
    expect((await decide(2, 'approve')).status).toBe(200);
    const r = await scheduleNow();
    expect(r.status).toBe(200);
    expect(r.json.scheduled).toBe(2);
    expect(r.json.still_to_review).toBe(3);
    expect(r.json.first_publish_at).toBeTruthy();
    expect(r.json.note).toMatch(/3 post\(s\) are still waiting on a decision/);
  });

  it('only those two carry a date; the undecided ones carry none', async () => {
    const b = await board();
    const dated = b.posts.filter((p) => p.publish_at).map((p) => p.slot).sort();
    expect(dated).toEqual([1, 2]);
    b.posts.filter((p) => p.status === 'draft').forEach((p) => expect(p.publish_at).toBeFalsy());
    expect(b.campaign.status).toBe('approved');
  });

  it('a second click tops the month up instead of being refused as already approved', async () => {
    const before = (await board()).posts.filter((p) => p.publish_at).map((p) => p.publish_at);
    expect((await decide(3, 'approve')).status).toBe(200);
    const r = await scheduleNow();
    expect(r.status).toBe(200);
    expect(r.json.scheduled).toBe(1);
    expect(r.json.already_scheduled).toBe(2);

    const after = await board();
    const dated = after.posts.filter((p) => p.publish_at);
    expect(dated).toHaveLength(3);
    // The earlier batch keeps the exact dates it was given, and the new post lands
    // on a slot nobody already held.
    const newDate = after.posts.find((p) => p.slot === 3).publish_at;
    expect(before).not.toContain(newDate);
    before.forEach((d) => expect(after.posts.some((p) => p.publish_at === d)).toBe(true));
    expect(new Set(dated.map((p) => p.publish_at)).size).toBe(3);
  });

  it('a further click with nothing newly approved is refused, not a no-op success', async () => {
    const r = await scheduleNow();
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/Approve at least one of the 2 post/);
  });

  it('a rejected post is never scheduled, and approving the last one still tops up', async () => {
    expect((await decide(4, 'reject')).status).toBe(200);
    expect((await decide(5, 'approve')).status).toBe(200);
    const r = await scheduleNow();
    expect(r.status).toBe(200);
    expect(r.json.scheduled).toBe(1);
    expect(r.json.still_to_review).toBe(0);

    const b = await board();
    expect(b.posts.find((p) => p.slot === 4).publish_at).toBeFalsy();
    expect(b.posts.filter((p) => p.publish_at)).toHaveLength(4);
    expect(new Set(b.posts.filter((p) => p.publish_at).map((p) => p.publish_at)).size).toBe(4);
  });

  it('rejecting an already-scheduled post frees its slot for the next top-up', async () => {
    const b0 = await board();
    const freed = b0.posts.find((p) => p.slot === 2).publish_at;
    expect(freed).toBeTruthy();
    expect((await decide(2, 'reject')).status).toBe(200);
    expect((await board()).posts.find((p) => p.slot === 2).publish_at).toBeFalsy();

    // Bring slot 4 back and schedule it: it should be handed the freed slot, which
    // is the earliest one now available.
    expect((await decide(4, 'approve')).status).toBe(200);
    const r = await scheduleNow();
    expect(r.status).toBe(200);
    expect(r.json.scheduled).toBe(1);
    expect((await board()).posts.find((p) => p.slot === 4).publish_at).toBe(freed);
  });

  // ── "start posting from today" ──────────────────────────────────────────────
  // The batch is labelled for a future month, so a month-fenced schedule can only
  // ever answer "1 <that month>". start_today re-lays the whole approved batch from
  // now instead (owner, 2026-08-18: approved September's creatives and wanted them
  // going out that day).
  it('start_today moves the whole approved batch to run from now', async () => {
    const before = await board();
    const wasFuture = before.posts.filter((p) => p.publish_at).map((p) => p.publish_at).sort();
    expect(wasFuture.length).toBeGreaterThan(1);
    // Everything currently sits in the campaign month, which is two months out, so
    // every date is weeks away. (Not asserted by month string: 1 Oct 09:00 Melbourne
    // is 30 Sep in UTC, so the ISO month can legitimately read one lower.)
    wasFuture.forEach((d) => {
      expect(new Date(d).getTime() - Date.now()).toBeGreaterThan(20 * 24 * 3600 * 1000);
    });

    const r = await req('POST', '/api/ceo/social/approve', {
      body: { month, start_today: true }, headers: ceo()
    });
    expect(r.status).toBe(200);
    expect(r.json.rescheduled).toBe(true);
    expect(r.json.scheduled).toBe(wasFuture.length);

    const after = await board();
    const now = Date.now();
    const dates = after.posts.filter((p) => p.publish_at && p.status === 'approved')
      .map((p) => p.publish_at).sort();
    expect(dates).toHaveLength(wasFuture.length);
    // Every date moved earlier, none is in the past, and none collides.
    expect(new Set(dates).size).toBe(dates.length);
    dates.forEach((d) => expect(new Date(d).getTime()).toBeGreaterThan(now));
    expect(new Date(dates[0]).getTime()).toBeLessThan(new Date(wasFuture[0]).getTime());
    // The first one is within a day, i.e. it really does start now rather than
    // on the first of the campaign month.
    expect(new Date(dates[0]).getTime() - now).toBeLessThan(36 * 3600 * 1000);
  });

  it('a re-lay is allowed even when nothing new has been approved', async () => {
    // The normal gate refuses when there is nothing NEW to date. Moving an
    // already-booked batch forward is an action in its own right, so it must not
    // be caught by that gate.
    const r = await req('POST', '/api/ceo/social/approve', {
      body: { month, start_today: true }, headers: ceo()
    });
    expect(r.status).toBe(200);
    expect(r.json.rescheduled).toBe(true);
    expect(r.json.scheduled).toBeGreaterThan(0);
  });

  it('a re-lay with nothing approved at all is refused, not an empty success', async () => {
    const otherMonth = (() => {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + 5, 1);
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    })();
    await req('POST', '/api/admin/social/ingest', {
      body: { month: otherMonth, posts: [creative(1)], ready: true }, headers: ingestAuth
    });
    const r = await req('POST', '/api/ceo/social/approve', {
      body: { month: otherMonth, start_today: true }, headers: ceo()
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/Nothing is approved yet/);
  });

  it('the publisher still refuses to touch anything without a date', async () => {
    // The guarantee that made all-or-nothing approval unnecessary in the first place.
    const b = await board();
    const undated = b.posts.filter((p) => !p.publish_at);
    expect(undated.length).toBeGreaterThan(0);
    const r = await req('GET', '/api/cron/social-publish', { headers: cronAuth });
    expect(r.status).toBe(200);
    expect(r.json.failed).toBe(0);
    // Nothing undated may ever appear in a publish attempt.
    const attemptedSlots = (r.json.details || []).map((d) => d.slot);
    undated.forEach((p) => expect(attemptedSlots).not.toContain(p.slot));
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
