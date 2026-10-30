// Coverage for the CEO dashboard's Leads tab data source:
//   GET  /api/ceo/leads              list, stage chips, Hazel filter, tiles, dialler status
//   GET  /api/ceo/leads/:id          one lead with every call + chase log
//   POST /api/ceo/leads/:id/call     ring now with Hazel (Retell stubbed below)
//   POST /api/ceo/leads/:id/hazel    pause / resume / schedule / unschedule / do_not_call
// Reads site_enquiries kind=gp (the Meta-ads / landing-page consult funnel).
// Boots a real server against a temp JSON DB (Supabase left unconfigured, so
// the local-JSON-db path is exercised) with a signed super_admin cookie —
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

function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(payload);
  });
}

const call       = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const callNoAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });

// A fake Retell: records every /v2/create-phone-call so "ring now" can be
// asserted without a phone ever ringing.
let retellServer, retellPort;
const retellCalls = [];
function startRetellStub() {
  return new Promise((resolve) => {
    retellServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        if (req.method === 'POST' && req.url === '/v2/create-phone-call') {
          retellCalls.push(parsed);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ call_id: 'call_ceo_' + retellCalls.length, call_status: 'registered', agent_id: 'agent_1' }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
      });
    });
    retellServer.listen(0, '127.0.0.1', () => { retellPort = retellServer.address().port; resolve(); });
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Every row carries ip + user_agent in metadata — exactly as the real capture
// paths write them — so the privacy assertion has something real to catch.
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
// A practice enquiry — different kind, must never appear in a GP leads list.
const PRACTICE_ROW = {
  id: 'se_prac_' + RUN_ID, created_at: '2026-07-15T06:00:00.000Z', kind: 'practice',
  name: 'Werribee Medical', email: 'admin@practice.example', state: 'vic', status: 'new',
  metadata: { source: 'marketing-site', ip: PRIVATE_IP, user_agent: PRIVATE_UA }
};

const ALL_GP = [SCREENED_OUT, CONVERTED, QUALIFIED, NOT_SCREENED, BOOKED]; // shuffled order

// ── Hazel fixtures (fresh leads, so the age guard does not get in the way) ──
const MIN = 60000;
const nowIso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();
const FRESH = () => nowIso(-2 * 3600000);
const VOICEMAIL = lead({
  id: 'se_vm_' + RUN_ID, created_at: nowIso(-3 * 3600000), name: 'Dr Priya Nair', email: 'priya@example.co.uk', phone: '+447700900200',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [],
    ai_call: { call_id: 'call_vm', attempt: 1, status: 'ended', outcome: 'voicemail', started_at: nowIso(-12 * MIN), completed_at: nowIso(-10 * MIN), duration_s: 31, summary: 'Reached voicemail.' },
    ai_calls: [{ call_id: 'call_vm', attempt: 1, outcome: 'voicemail', started_at: nowIso(-12 * MIN), completed_at: nowIso(-10 * MIN), duration_s: 31, summary: 'Reached voicemail.' }] }
});
const HAZEL_BOOKED = lead({
  id: 'se_hzbooked_' + RUN_ID, created_at: nowIso(-5 * 3600000), name: 'Dr Tom Reilly', email: 'tom@example.ie', phone: '+353871234567', state: 'ie',
  consult: { qualified: true, is_gp: true, country: 'ie', call_booked: true, call_booked_at: nowIso(-30 * MIN), call_at: nowIso(3 * 86400000), nudges: [],
    ai_call: { call_id: 'call_bk', attempt: 1, status: 'ended', outcome: 'booked', tool_outcome: 'booked', started_at: nowIso(-40 * MIN), completed_at: nowIso(-30 * MIN), duration_s: 412, summary: 'Booked a consultation for Thursday.', sentiment: 'Positive', gp_status: 'gp', timeframe: 'early next year', notes: 'Partner is a nurse.' },
    ai_calls: [{ call_id: 'call_bk', attempt: 1, outcome: 'booked', started_at: nowIso(-40 * MIN), completed_at: nowIso(-30 * MIN), duration_s: 412, summary: 'Booked a consultation for Thursday.', sentiment: 'Positive', notes: 'Partner is a nurse.' }] }
});
const NOT_A_GP = lead({
  id: 'se_notgp_' + RUN_ID, created_at: nowIso(-6 * 3600000), name: 'Alex Pharmacist', email: 'alex@example.co.uk', phone: '+447700900300',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false, stopped: 'not_interested', nudges: [],
    ai_call: { call_id: 'call_ng', attempt: 1, status: 'ended', outcome: 'not_a_gp', tool_outcome: 'not_a_gp', started_at: nowIso(-50 * MIN), completed_at: nowIso(-48 * MIN), duration_s: 55 },
    ai_calls: [{ call_id: 'call_ng', attempt: 1, outcome: 'not_a_gp', started_at: nowIso(-50 * MIN), completed_at: nowIso(-48 * MIN), duration_s: 55 }] }
});
const PAUSED = lead({
  id: 'se_paused_' + RUN_ID, created_at: FRESH(), name: 'Dr Mo Haddad', email: 'mo@example.co.uk', phone: '+447700900400',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false, calls_paused: true, nudges: [] }
});
const SCHEDULED = lead({
  id: 'se_sched_' + RUN_ID, created_at: '2026-01-05T09:00:00.000Z', name: 'Dr Ana Costa', email: 'ana@example.co.uk', phone: '+447700900500',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false, call_back_at: nowIso(5 * 86400000), stopped: 'exhausted', nudges: [] }
});
const EXHAUSTED = lead({
  id: 'se_exh_' + RUN_ID, created_at: FRESH(), name: 'Dr Ben Okafor', email: 'ben@example.co.uk', phone: '+447700900600',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false, stopped: 'exhausted', nudges: [
    { seq: 'not_booked', step: 0, sent_at: nowIso(-90 * MIN), email: 'sent' }
  ], wa: { nb_intro: { sent_at: nowIso(-80 * MIN) } } }
});
const DNC = lead({
  id: 'se_dnc_' + RUN_ID, created_at: FRESH(), name: 'Dr Grace Lee', email: 'grace@example.co.uk', phone: '+447700900700',
  consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false, stopped: 'do_not_call', nudges: [] }
});
const HAZEL_GP = [VOICEMAIL, HAZEL_BOOKED, NOT_A_GP, PAUSED, SCHEDULED, EXHAUSTED, DNC];

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
  await startRetellStub();
  process.env.RETELL_API_URL           = 'http://127.0.0.1:' + retellPort;
  process.env.RETELL_API_KEY           = 'key_test';
  process.env.RETELL_AGENT_ID          = 'agent_1';
  process.env.RETELL_FROM_NUMBER_UK    = '+442030000000';
  process.env.LEAD_CALLS_ENABLED       = 'true';
  delete process.env.RETELL_FROM_NUMBER_AU;
  delete process.env.LEAD_CALLS_TEST_NUMBERS;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (retellServer) await new Promise((r) => retellServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__seedSiteEnquiriesForTest(ALL_GP.concat([PRACTICE_ROW]));
});

describe('GET /api/ceo/leads — auth', () => {
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

describe('GET /api/ceo/leads — listing', () => {
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
describe('GET /api/ceo/leads — not_screened vs screened_out', () => {
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

    // Both are unqualified (and so both nudge-ineligible) — which is precisely
    // why the two flags must stay separable by the UI.
    expect(never.qualified).toBe(false);
    expect(out.qualified).toBe(false);
  });
});

describe('GET /api/ceo/leads — filters', () => {
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

  // Stage chips are exclusive: a lead sits under exactly one of open / booked /
  // signed_up / burnt / not_qualified / unscreened. "Booked" therefore no
  // longer swallows the signed-up and the never-screened bookers.
  it('filter=booked returns the booked stage only', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=booked');
    expect(res.body.leads.map((l) => l.id)).toEqual([BOOKED.id]);
    expect(res.body.leads[0].stage).toMatchObject({ key: 'booked', label: 'Booked', mod: 'blue' });
  });

  it('filter=unscreened returns the never-screened bookers, filter=signed_up the converted', async () => {
    const un = await call('GET', '/api/ceo/leads?filter=unscreened');
    expect(un.body.leads.map((l) => l.id)).toEqual([NOT_SCREENED.id]);
    expect(un.body.leads[0].stage.key).toBe('unscreened');
    const su = await call('GET', '/api/ceo/leads?filter=signed_up');
    expect(su.body.leads.map((l) => l.id)).toEqual([CONVERTED.id]);
    expect(su.body.leads[0].stage.key).toBe('signed_up');
  });

  it('filter=open returns qualified leads that are not booked, signed up or burnt', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=open');
    expect(res.body.leads.map((l) => l.id)).toEqual([QUALIFIED.id]);
    expect(res.body.leads[0].stage.key).toBe('open');
  });

  it('filter=converted returns only status === converted', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=converted');
    expect(res.body.leads.map((l) => l.id)).toEqual([CONVERTED.id]);
  });

  it('filter=not_qualified returns only leads who were screened and turned down', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=not_qualified');
    expect(res.body.leads.map((l) => l.id)).toEqual([SCREENED_OUT.id]);
    expect(res.body.leads[0].stage).toMatchObject({ key: 'not_qualified', label: 'Not qualified' });
  });

  it('an unknown filter falls back to all rather than erroring', async () => {
    const res = await call('GET', '/api/ceo/leads?filter=bogus');
    expect(res.status).toBe(200);
    expect(res.body.leads.length).toBe(5);
  });

  it('counts carry every chip total, and the tiles the headline numbers', async () => {
    const res = await call('GET', '/api/ceo/leads');
    expect(res.body.counts).toEqual({
      all: 5, open: 1, booked: 1, signed_up: 1, burnt: 0, not_qualified: 1, unscreened: 1
    });
    expect(res.body.tiles).toEqual({ open: 1, queued: 0, scheduled: 0, called: 0, booked_by_hazel: 0, burnt: 0 });
    expect(res.body.hazel_counts).toMatchObject({ any: 5, not_called: 5, queued: 0 });
  });
});

describe('GET /api/ceo/leads — search + paging', () => {
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
      all: 1, open: 1, booked: 0, signed_up: 0, burnt: 0, not_qualified: 0, unscreened: 0
    });
  });

  it('q also matches a phone number, ignoring spaces', async () => {
    const res = await call('GET', '/api/ceo/leads?q=' + encodeURIComponent('7700 900123'));
    expect(res.body.leads.map((l) => l.id)).toEqual([QUALIFIED.id]);
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
describe('GET /api/ceo/leads — privacy', () => {
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

// ── The Hazel column: how the last call went and what she will do next ──────
describe('GET /api/ceo/leads — Hazel column', () => {
  beforeEach(() => { testUtils.__seedSiteEnquiriesForTest(ALL_GP.concat(HAZEL_GP, [PRACTICE_ROW])); });

  const byId = async (id, qs) => {
    const res = await call('GET', '/api/ceo/leads' + (qs || ''));
    expect(res.status).toBe(200);
    return res.body.leads.find((l) => l.id === id);
  };

  it('reports the dialler status as booleans and limits, never a secret', async () => {
    const res = await call('GET', '/api/ceo/leads');
    expect(res.body.hazel).toMatchObject({
      enabled: true, configured: true, from_uk: true, from_au: false,
      max_lead_age_days: 3, max_attempts: 2, retry_after_min: 180, test_mode: false, test_numbers: 0
    });
    expect(res.raw).not.toContain('key_test');
    expect(res.raw).not.toContain('agent_1');
    expect(res.raw).not.toContain('+442030000000');
  });

  it('a fresh qualified lead is queued, even when its chase emails ran out', async () => {
    const l = await byId(EXHAUSTED.id);
    expect(l.stage.key).toBe('open');
    expect(l.stopped).toBe('exhausted');
    expect(l.stopped_label).toBe('every chase email sent');
    expect(l.hazel.state).toBe('queued');
    expect(l.hazel.attempts).toBe(0);
    expect(l.hazel.last).toBeNull();
    expect(l.nudges_sent).toBe(1);
    expect(l.wa_sent).toBe(1);
  });

  it('after a voicemail: last call facts + a retry due 3 h later', async () => {
    const l = await byId(VOICEMAIL.id);
    expect(l.hazel.state).toBe('retry');
    expect(l.hazel.label).toBe('Retry scheduled');
    expect(l.hazel.last).toMatchObject({ outcome: 'voicemail', outcome_label: 'Voicemail', attempt: 1, duration_s: 31, summary: 'Reached voicemail.' });
    expect(l.hazel.max_attempts).toBe(2);
    expect(l.hazel.spoke).toBe(false);
    expect(Date.parse(l.hazel.due_at) - Date.parse(VOICEMAIL.metadata.consult.ai_call.completed_at)).toBe(180 * MIN);
  });

  it('a booking made on the call is attributed to Hazel', async () => {
    const l = await byId(HAZEL_BOOKED.id);
    expect(l.stage.key).toBe('booked');
    expect(l.booked_via).toBe('hazel');
    expect(l.call_at).toBe(HAZEL_BOOKED.metadata.consult.call_at);
    expect(l.hazel.booked).toBe(true);
    expect(l.hazel.spoke).toBe(true);
    expect(l.hazel.last).toMatchObject({ outcome: 'booked', tool_outcome: 'booked', sentiment: 'Positive', gp_status: 'gp', timeframe: 'early next year', notes: 'Partner is a nurse.' });
  });

  it('"not a GP" on the call makes the lead burnt, with the reason', async () => {
    const l = await byId(NOT_A_GP.id);
    expect(l.stage).toMatchObject({ key: 'burnt', label: 'Burnt' });
    expect(l.stage.reason).toMatch(/not a GP/);
    expect(l.hazel.state).toBe('burnt');
  });

  it('paused, scheduled and do-not-call leads say so', async () => {
    const p = await byId(PAUSED.id);
    expect(p.calls_paused).toBe(true);
    expect(p.hazel).toMatchObject({ state: 'paused', label: 'Paused by you' });
    const sch = await byId(SCHEDULED.id);
    expect(sch.call_back_at).toBe(SCHEDULED.metadata.consult.call_back_at);
    expect(sch.hazel).toMatchObject({ state: 'scheduled', label: 'Call-back scheduled by you', due_at: SCHEDULED.metadata.consult.call_back_at });
    const d = await byId(DNC.id);
    expect(d.stage).toMatchObject({ key: 'burnt', reason: 'asked not to be called' });
    expect(d.hazel.state).toBe('burnt');
  });

  it('an old lead is blocked by the age guard, and the label says how to override it', async () => {
    const l = await byId(QUALIFIED.id);
    expect(l.hazel).toMatchObject({ state: 'blocked', reason: 'too_old' });
    expect(l.hazel.label).toContain('3-day limit');
    expect(l.hazel.detail).toContain('call-back');
  });

  it('the hazel= filter narrows within the stage, with counts', async () => {
    const q = await call('GET', '/api/ceo/leads?filter=open&hazel=queued');
    expect(q.body.leads.map((l) => l.id)).toEqual([EXHAUSTED.id]);
    expect(q.body.hazel_counts).toMatchObject({ queued: 1, scheduled: 2, blocked: 2, called: 1, not_called: 4 });
    const b = await call('GET', '/api/ceo/leads?hazel=booked');
    expect(b.body.leads.map((l) => l.id)).toEqual([HAZEL_BOOKED.id]);
    const na = await call('GET', '/api/ceo/leads?hazel=no_answer');
    expect(na.body.leads.map((l) => l.id)).toEqual([VOICEMAIL.id]);
    const burnt = await call('GET', '/api/ceo/leads?filter=burnt');
    expect(burnt.body.leads.map((l) => l.id).sort()).toEqual([NOT_A_GP.id, DNC.id].sort());
    expect(burnt.body.tiles).toMatchObject({ burnt: 2, booked_by_hazel: 1, called: 3, queued: 1, scheduled: 2 });
  });
});

describe('GET /api/ceo/leads/:id — one lead in full', () => {
  beforeEach(() => { testUtils.__seedSiteEnquiriesForTest(ALL_GP.concat(HAZEL_GP, [PRACTICE_ROW])); });

  it('rejects without a session and 404s an unknown or non-GP id', async () => {
    expect((await callNoAuth('GET', '/api/ceo/leads/' + HAZEL_BOOKED.id)).status).not.toBe(200);
    expect((await call('GET', '/api/ceo/leads/nope-' + RUN_ID)).status).toBe(404);
    expect((await call('GET', '/api/ceo/leads/' + PRACTICE_ROW.id)).status).toBe(404);
  });

  it('returns the projection, every call (from the lead history) and the chase log', async () => {
    const res = await call('GET', '/api/ceo/leads/' + HAZEL_BOOKED.id);
    expect(res.status).toBe(200);
    expect(res.body.lead).toMatchObject({ id: HAZEL_BOOKED.id, booked_via: 'hazel' });
    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0]).toMatchObject({ call_id: 'call_bk', outcome: 'booked', outcome_label: 'Booked on the call', duration_s: 412, sentiment: 'Positive', notes: 'Partner is a nurse.', transcript: '' });
    const ex = await call('GET', '/api/ceo/leads/' + EXHAUSTED.id);
    expect(ex.body.calls).toEqual([]);
    expect(ex.body.chase.nudges).toEqual([{ seq: 'not_booked', step: 0, sent_at: EXHAUSTED.metadata.consult.nudges[0].sent_at, email: 'sent' }]);
    expect(ex.body.chase.whatsapp).toEqual([{ kind: 'nb_intro', sent_at: EXHAUSTED.metadata.consult.wa.nb_intro.sent_at }]);
    expect(res.raw).not.toContain(PRIVATE_IP);
    expect(res.raw).not.toContain('user_agent');
  });
});

describe('POST /api/ceo/leads/:id/hazel — owner controls', () => {
  beforeEach(() => { testUtils.__seedSiteEnquiriesForTest(ALL_GP.concat(HAZEL_GP, [PRACTICE_ROW])); });

  it('pause and resume flip the lead between paused and queued', async () => {
    const p = await call('POST', '/api/ceo/leads/' + EXHAUSTED.id + '/hazel', { action: 'pause' });
    expect(p.status).toBe(200);
    expect(p.body.lead.calls_paused).toBe(true);
    expect(p.body.lead.hazel.state).toBe('paused');
    const again = await call('GET', '/api/ceo/leads/' + EXHAUSTED.id);
    expect(again.body.lead.hazel.state).toBe('paused');
    const r = await call('POST', '/api/ceo/leads/' + EXHAUSTED.id + '/hazel', { action: 'resume' });
    expect(r.body.lead.calls_paused).toBe(false);
    expect(r.body.lead.hazel.state).toBe('queued');
  });

  it('schedule needs a future time, clears a pause, and unschedule removes it', async () => {
    const bad = await call('POST', '/api/ceo/leads/' + PAUSED.id + '/hazel', { action: 'schedule', at: 'next tuesday' });
    expect(bad.status).toBe(400);
    const past = await call('POST', '/api/ceo/leads/' + PAUSED.id + '/hazel', { action: 'schedule', at: nowIso(-2 * 3600000) });
    expect(past.status).toBe(400);
    const at = nowIso(2 * 86400000);
    const ok = await call('POST', '/api/ceo/leads/' + PAUSED.id + '/hazel', { action: 'schedule', at });
    expect(ok.status).toBe(200);
    expect(ok.body.lead.call_back_at).toBe(at);
    expect(ok.body.lead.calls_paused).toBe(false);
    expect(ok.body.lead.hazel).toMatchObject({ state: 'scheduled', due_at: at });
    const un = await call('POST', '/api/ceo/leads/' + PAUSED.id + '/hazel', { action: 'unschedule' });
    expect(un.body.lead.call_back_at).toBe('');
    expect(un.body.lead.hazel.state).toBe('queued');
  });

  it('do_not_call burns the lead and refuses later scheduling', async () => {
    const d = await call('POST', '/api/ceo/leads/' + VOICEMAIL.id + '/hazel', { action: 'do_not_call' });
    expect(d.status).toBe(200);
    expect(d.body.lead.stopped).toBe('do_not_call');
    expect(d.body.lead.stage).toMatchObject({ key: 'burnt', reason: 'asked not to be called' });
    const s = await call('POST', '/api/ceo/leads/' + VOICEMAIL.id + '/hazel', { action: 'schedule', at: nowIso(86400000) });
    expect(s.status).toBe(409);
  });

  it('rejects an unknown action and an unauthenticated caller', async () => {
    expect((await call('POST', '/api/ceo/leads/' + VOICEMAIL.id + '/hazel', { action: 'ring_everyone' })).status).toBe(400);
    expect((await callNoAuth('POST', '/api/ceo/leads/' + VOICEMAIL.id + '/hazel', { action: 'pause' })).status).not.toBe(200);
  });
});

describe('POST /api/ceo/leads/:id/call — ring now with Hazel', () => {
  beforeEach(() => { retellCalls.length = 0; testUtils.__seedSiteEnquiriesForTest(ALL_GP.concat(HAZEL_GP, [PRACTICE_ROW])); });

  it('places the call through Retell, stamps the lead, and consumes a scheduled call-back', async () => {
    const res = await call('POST', '/api/ceo/leads/' + SCHEDULED.id + '/call', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.call_id).toMatch(/^call_ceo_/);
    expect(retellCalls).toHaveLength(1);
    expect(retellCalls[0]).toMatchObject({ from_number: '+442030000000', to_number: '+447700900500', override_agent_id: 'agent_1' });
    expect(retellCalls[0].metadata).toMatchObject({ enquiry_id: SCHEDULED.id, attempt: 1, source: 'ceo-manual' });
    expect(retellCalls[0].retell_llm_dynamic_variables.first_name).toBe('Ana');
    expect(res.body.lead.hazel.state).toBe('in_progress');
    expect(res.body.lead.hazel.last).toMatchObject({ status: 'registered', attempt: 1 });
    expect(res.body.lead.call_back_at).toBe('');
    // A second press while that call is live is refused.
    const dup = await call('POST', '/api/ceo/leads/' + SCHEDULED.id + '/call', {});
    expect(dup.status).toBe(409);
    expect(retellCalls).toHaveLength(1);
  });

  it('rings an old lead the automatic dialler would skip (the owner decides)', async () => {
    const res = await call('POST', '/api/ceo/leads/' + QUALIFIED.id + '/call', {});
    expect(res.status).toBe(200);
    expect(retellCalls[0].to_number).toBe('+447700900123');
  });

  it('never rings a do-not-call lead, a lead with no phone, or a number outside the four markets', async () => {
    expect((await call('POST', '/api/ceo/leads/' + DNC.id + '/call', {})).status).toBe(409);
    expect((await call('POST', '/api/ceo/leads/' + BOOKED.id + '/call', {})).status).toBe(400);
    testUtils.__seedSiteEnquiriesForTest([lead({ id: 'se_us_' + RUN_ID, created_at: FRESH(), name: 'Dr US', email: 'us@example.com', phone: '+12125550100', state: 'us', consult: { qualified: true, country: 'us' } })]);
    expect((await call('POST', '/api/ceo/leads/se_us_' + RUN_ID + '/call', {})).status).toBe(400);
    expect(retellCalls).toHaveLength(0);
  });

  it('honours the dry-run allow-list and reports missing config plainly', async () => {
    process.env.LEAD_CALLS_TEST_NUMBERS = '+447000000001';
    const t = await call('POST', '/api/ceo/leads/' + EXHAUSTED.id + '/call', {});
    expect(t.status).toBe(409);
    expect(t.body.message).toMatch(/Test mode/);
    delete process.env.LEAD_CALLS_TEST_NUMBERS;
    const savedKey = process.env.RETELL_API_KEY;
    process.env.RETELL_API_KEY = '';
    const nk = await call('POST', '/api/ceo/leads/' + EXHAUSTED.id + '/call', {});
    expect(nk.status).toBe(503);
    expect(nk.body.message).toContain('RETELL_API_KEY');
    process.env.RETELL_API_KEY = savedKey;
    const au = await call('POST', '/api/ceo/leads/' + HAZEL_BOOKED.id + '/call', {});
    // Irish lead rings from the UK number, which exists — so this one goes
    // through; an AU lead would be told RETELL_FROM_NUMBER_AU is missing.
    expect(au.status).toBe(200);
    testUtils.__seedSiteEnquiriesForTest([lead({ id: 'se_au_' + RUN_ID, created_at: FRESH(), name: 'Dr Syd', email: 'syd@example.com.au', phone: '+61400000000', state: 'au', consult: { qualified: true, country: 'au' } })]);
    const noAu = await call('POST', '/api/ceo/leads/se_au_' + RUN_ID + '/call', {});
    expect(noAu.status).toBe(503);
    expect(noAu.body.message).toContain('RETELL_FROM_NUMBER_AU');
  });
});
