// Coverage for GET /api/ceo/leads, the CEO dashboard's Leads tab data source.
// Reads site_enquiries kind=gp (the Meta-ads / landing-page consult funnel).
// Boots a real server against a temp JSON DB (Supabase left unconfigured, so
// the local-JSON-db path is exercised) with a signed super_admin cookie,
// harness mirrors tests/ceo-meetings-endpoints.test.js; seeding uses
// __testUtils.__seedSiteEnquiriesForTest like tests/consult-lead-endpoints.test.js.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-ceo-leads-${RUN_ID}.json`;
const SUPER_HOST = 'ats-test.local';

let server, port, testUtils;

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = b64url(JSON.stringify({
    userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' },
    expiresAt: Date.now() + 3600000
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end();
  });
}

const call       = (method, p) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie() });
const callNoAuth = (method, p) => httpReq(method, p, { host: SUPER_HOST });

// ── Fixtures ────────────────────────────────────────────────────────────────
// Every row carries ip + user_agent in metadata, exactly as the real capture
// paths write them, so the privacy assertion has something real to catch.
const PRIVATE_IP = '203.0.113.77';
const PRIVATE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) SecretAgent/1.0';

function lead(over) {
  const o = over || {};
  return {
    id: o.id,
    created_at: o.created_at,
    kind: 'gp',
    name: o.name,
    email: o.email,
    phone: o.phone || null,
    state: o.state || 'uk',
    message: o.message || null,
    status: o.status || 'new',
    metadata: {
      source: o.source || 'site_start_form',
      ip: PRIVATE_IP,
      user_agent: PRIVATE_UA,
      consult: o.consult
    }
  };
}

// Oldest -> newest by created_at; seeded deliberately out of order.
const QUALIFIED = lead({
  id: 'se_qual_' + RUN_ID, created_at: '2026-07-10T01:00:00.000Z',
  name: 'Dr Aisha Khan', email: 'aisha@example.co.uk', phone: '+447700900123',
  message: 'Visa timing?',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false, token: 'tok-' + RUN_ID, nudges: [
    { seq: 'not_booked', step: 0, sent_at: '2026-07-11T01:00:00.000Z' },
    { seq: 'not_booked', step: 1, sent_at: '2026-07-12T01:00:00.000Z' }
  ] }
});
const BOOKED = lead({
  id: 'se_booked_' + RUN_ID, created_at: '2026-07-11T02:00:00.000Z',
  name: 'Dr Liam O\'Connor', email: 'liam@example.ie', state: 'ie', source: 'meta_lead_ad',
  consult: { qualified: true, is_gp: true, country: 'ie', call_booked: true,
    call_booked_at: '2026-07-12T03:00:00.000Z', call_question: 'Can I bring my family?', nudges: [] }
});
const SCREENED_OUT = lead({
  id: 'se_out_' + RUN_ID, created_at: '2026-07-12T03:00:00.000Z',
  name: 'Sam Nurse', email: 'sam@example.com', state: 'other',
  consult: { qualified: false, is_gp: false, country: 'other', call_booked: false, screened_out: true, nudges: [] }
});
const NOT_SCREENED = lead({
  id: 'se_direct_' + RUN_ID, created_at: '2026-07-13T04:00:00.000Z',
  name: 'Khaleed Mahmoud', email: 'khaleed@example.com', state: 'other', source: 'calendly_direct',
  // handleCalendlyInviteeCreated deletes screened_out and sets not_screened:
  // they booked the Calendly link direct and were never asked anything.
  consult: { qualified: false, is_gp: null, country: 'other', call_booked: true,
    call_booked_at: '2026-07-13T04:00:00.000Z', not_screened: true, nudges: [] }
});
const CONVERTED = lead({
  id: 'se_conv_' + RUN_ID, created_at: '2026-07-14T05:00:00.000Z',
  name: 'Dr Yuki Tanaka', email: 'yuki@example.co.uk', status: 'converted',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: true,
    call_booked_at: '2026-07-14T06:00:00.000Z', stopped: 'signed_up', nudges: [
      { seq: 'booked_no_signup', step: 0, sent_at: '2026-07-15T05:00:00.000Z' }
    ] }
});
// A practice enquiry, different kind, must never appear in a GP leads list.
const PRACTICE_ROW = {
  id: 'se_prac_' + RUN_ID, created_at: '2026-07-15T06:00:00.000Z', kind: 'practice',
  name: 'Werribee Medical', email: 'admin@practice.example', state: 'vic', status: 'new',
  metadata: { source: 'marketing-site', ip: PRIVATE_IP, user_agent: PRIVATE_UA }
};

const ALL_GP = [SCREENED_OUT, CONVERTED, QUALIFIED, NOT_SCREENED, BOOKED]; // shuffled order

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV        = 'true';
  process.env.NODE_ENV                 = 'test';
  process.env.AUTH_DISABLED            = 'false';
  process.env.AUTH_SECRET              = 'ceo-leads-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB      = 'false';
  process.env.SUPABASE_URL             = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN      = 'false';
  process.env.DB_FILE_PATH             = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS       = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS             = '';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__seedSiteEnquiriesForTest(ALL_GP.concat([PRACTICE_ROW]));
});

describe('GET /api/ceo/leads, auth', () => {
  it('rejects a request with no admin session', async () => {
    const res = await callNoAuth('GET', '/api/ceo/leads');
    expect([401, 403]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it('leaks no lead data in the unauthenticated response body', async () => {
    const res = await callNoAuth('GET', '/api/ceo/leads');
    expect(res.raw).not.toContain('aisha@example.co.uk');
    expect(res.raw).not.toContain('Aisha Khan');
  });
});

describe('GET /api/ceo/leads, listing', () => {
  it('returns the seeded gp leads, newest first, excluding practice enquiries', async () => {
    const res = await call('GET', '/api/ceo/leads');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ids = res.body.leads.map((l) => l.id);
    expect(ids).toEqual([CONVERTED.id, NOT_SCREENED.id, SCREENED_OUT.id, BOOKED.id, QUALIFIED.id]);
    expect(ids).not.toContain(PRACTICE_ROW.id);
    expect(res.body.total).toBe(5);
  });

  it('projects the fields the Leads tab renders', async () => {
    const res = await call('GET', '/api/ceo/leads');
    const q = res.body.leads.find((l) => l.id === QUALIFIED.id);
    expect(q).toMatchObject({
      name: 'Dr Aisha Khan',
      email: 'aisha@example.co.uk',
      phone: '+447700900123',
      country: 'uk',              // sourced from row.state
      status: 'new',
      source: 'site_start_form',
      qualified: true,
      call_booked: false,
      nudges_sent: 2
    });
    expect(q.last_nudge_at).toBe('2026-07-12T01:00:00.000Z');
    expect(q.created_at).toBe('2026-07-10T01:00:00.000Z');
    // The start form stores the question on the row itself.
    expect(q.call_question).toBe('Visa timing?');
  });

  it('reports a question typed at booking time, plus the booking timestamp', async () => {
    const res = await call('GET', '/api/ceo/leads');
    const b = res.body.leads.find((l) => l.id === BOOKED.id);
    expect(b.call_question).toBe('Can I bring my family?');
    expect(b.call_booked).toBe(true);
    expect(b.call_booked_at).toBe('2026-07-12T03:00:00.000Z');
  });

  it('reports why the chase emails stopped', async () => {
    const res = await call('GET', '/api/ceo/leads');
    const c = res.body.leads.find((l) => l.id === CONVERTED.id);
    expect(c.stopped).toBe('signed_up');
    expect(c.nudges_sent).toBe(1);
    expect(c.last_nudge_at).toBe('2026-07-15T05:00:00.000Z');
  });
});

// The bug this whole tab exists to prevent: a never-screened Calendly booking
// being indistinguishable from someone we screened and turned down.
describe('GET /api/ceo/leads, not_screened vs screened_out', () => {
  it('reports a never-screened lead distinctly from a screened-out lead', async () => {
    const res = await call('GET', '/api/ceo/leads');
    const never = res.body.leads.find((l) => l.id === NOT_SCREENED.id);
    const out   = res.body.leads.find((l) => l.id === SCREENED_OUT.id);

    // Never asked: not_screened set, screened_out explicitly NOT set.
    expect(never.not_screened).toBe(true);
    expect(never.screened_out).toBe(false);

    // Asked and turned down: the exact mirror image.
    expect(out.screened_out).toBe(true);
    expect(out.not_screened).toBe(false);

    // Both are unqualified (and so both nudge-ineligible), which is precisely
    // why the two flags must stay separable by the UI.
    expect(never.qualified).toBe(false);
    expect(out.qualified).toBe(false);
  });
});

describe('GET /api/ceo/leads, filters', () => {
  it('filter=all returns every gp lead', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=all');
    expect(res.body.leads.length).toBe(5);
  });

  it('filter=qualified returns only consult.qualified === true', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=qualified');
    const ids = res.body.leads.map((l) => l.id).sort();
    expect(ids).toEqual([BOOKED.id, CONVERTED.id, QUALIFIED.id].sort());
    expect(res.body.total).toBe(3);
  });

  it('filter=booked returns only consult.call_booked === true', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=booked');
    const ids = res.body.leads.map((l) => l.id).sort();
    expect(ids).toEqual([BOOKED.id, CONVERTED.id, NOT_SCREENED.id].sort());
  });

  it('filter=converted returns only status === converted', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=converted');
    expect(res.body.leads.map((l) => l.id)).toEqual([CONVERTED.id]);
  });

  it('filter=not_qualified returns everyone qualified !== true (screened out AND never screened)', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=not_qualified');
    const ids = res.body.leads.map((l) => l.id).sort();
    expect(ids).toEqual([NOT_SCREENED.id, SCREENED_OUT.id].sort());
  });

  it('an unknown filter falls back to all rather than erroring', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=bogus');
    expect(res.status).toBe(200);
    expect(res.body.leads.length).toBe(5);
  });

  it('counts carry every chip total', async () => {
    const res = await call('GET', '/api/ceo/leads');
    expect(res.body.counts).toEqual({
      all: 5, qualified: 3, booked: 3, converted: 1, not_qualified: 2
    });
  });
});

describe('GET /api/ceo/leads, search + paging', () => {
  it('q matches on name and email, case-insensitively', async () => {
    const byName = await call('GET', '/api/ceo/leads?q=aisha');
    expect(byName.body.leads.map((l) => l.id)).toEqual([QUALIFIED.id]);
    const byEmail = await call('GET', '/api/ceo/leads?q=LIAM@EXAMPLE.IE');
    expect(byEmail.body.leads.map((l) => l.id)).toEqual([BOOKED.id]);
    const miss = await call('GET', '/api/ceo/leads?q=nobodyhere');
    expect(miss.body.leads).toEqual([]);
    expect(miss.body.total).toBe(0);
  });

  it('counts reflect the active search, not the whole table', async () => {
    const res = await call('GET', '/api/ceo/leads?q=aisha');
    expect(res.body.counts).toEqual({
      all: 1, qualified: 1, booked: 0, converted: 0, not_qualified: 0
    });
  });

  it('limit/offset page the filtered set while total stays the full count', async () => {
    const res = await call('GET', '/api/ceo/leads?limit=2&offset=1');
    expect(res.body.leads.map((l) => l.id)).toEqual([NOT_SCREENED.id, SCREENED_OUT.id]);
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

// PRIVACY: metadata holds the submitter's IP + user agent. The endpoint
// projects explicit fields precisely so these can never reach the browser;
// assert on the RAW body so a nested/renamed leak is still caught.
describe('GET /api/ceo/leads, privacy', () => {
  it('never returns raw metadata.ip or metadata.user_agent', async () => {
    const res = await call('GET', '/api/ceo/leads');
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(PRIVATE_IP);
    expect(res.raw).not.toContain(PRIVATE_UA);
    expect(res.raw).not.toContain('SecretAgent');
    expect(res.raw).not.toContain('user_agent');
    expect(res.raw).not.toContain('"ip"');
    // And no lead object carries a metadata blob at all.
    res.body.leads.forEach((l) => {
      expect(l.metadata).toBeUndefined();
      expect(l.ip).toBeUndefined();
      expect(l.user_agent).toBeUndefined();
    });
  });

  it('keeps ip/user_agent out of every filtered + searched response too', async () => {
    for (const p of ['?filter=qualified', '?filter=booked', '?filter=not_qualified', '?q=aisha']) {
      const res = await call('GET', '/api/ceo/leads' + p);
      expect(res.raw).not.toContain(PRIVATE_IP);
      expect(res.raw).not.toContain(PRIVATE_UA);
    }
  });
});
