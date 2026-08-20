// Consult-funnel WhatsApp follow-ups (DoubleTick) — lib/consult-whatsapp.js +
// the server wiring: booking confirmation (ensureLeadBookedCallAt), the
// not_booked ride-along + signed_up welcome + onboarding pass (all inside
// GET /api/cron/consult-nudge). Boots the real server in LOCAL-JSON mode over
// HTTP (same harness as tests/consult-nudge-cron.test.js) with BOTH a stub
// Resend server and a stub DoubleTick server wired via env BEFORE import —
// DOUBLETICK_BASE_URL/DOUBLETICK_API_KEY are module-level consts in server.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const waLib = requireCjs('../lib/consult-whatsapp.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-wa-${RUN_ID}.json`;
let server;
let addrPort;
let testUtils;
let resendServer;
let resendPort;
let dtServer;
let dtPort;
const resendCaptured = [];
const dtCaptured = [];

const CRON = '/api/cron/consult-nudge';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const H = 3600 * 1000;
const D = 24 * H;

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}

let leadSeq = 0;
function seedLead(overrides = {}) {
  leadSeq++;
  const created = overrides.created_at || new Date(Date.now() - 3 * H).toISOString();
  const base = {
    id: 'lead-' + leadSeq, created_at: created, kind: 'gp', name: 'Aisha Khan',
    email: 'aisha' + leadSeq + '@example.co.uk', status: 'new',
    phone: '+44 7700 900123',
    metadata: { source: 'meta_lead_ad', consult: { token: 'TOK' + leadSeq, qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [] } }
  };
  const merged = Object.assign(base, overrides);
  if (overrides.metadata) merged.metadata = overrides.metadata;
  return merged;
}

function startCaptureServer(store, replyBody) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        store.push({ path: req.url, body: parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(replyBody));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

beforeAll(async () => {
  resendServer = await startCaptureServer(resendCaptured, { id: 'stub' });
  resendPort = resendServer.address().port;
  dtServer = await startCaptureServer(dtCaptured, { messages: [{ id: 'wa-stub' }] });
  dtPort = dtServer.address().port;

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-consult-wa-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendPort + '/emails';
  // Module-level consts in server.js — must exist before import.
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtPort;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (resendServer) await new Promise((resolve) => resendServer.close(resolve));
  if (dtServer) await new Promise((resolve) => dtServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

function waSends() {
  return dtCaptured.filter((c) => c.path === '/whatsapp/message/template');
}
function lastWaMessage() {
  const s = waSends();
  const m = s.length ? s[s.length - 1].body.messages[0] : null;
  return m;
}

describe('lib/consult-whatsapp pure logic', () => {
  it('eligibility mirrors the funnel gates and the sent-marker is terminal', () => {
    expect(waLib.consultWaEligible('not_booked', { qualified: true })).toBe(true);
    expect(waLib.consultWaEligible('not_booked', { qualified: true, call_booked: true })).toBe(false);
    expect(waLib.consultWaEligible('not_booked', { qualified: false })).toBe(false);
    expect(waLib.consultWaEligible('not_booked', { qualified: true, stopped: 'exhausted' })).toBe(false);
    expect(waLib.consultWaEligible('not_booked', { qualified: true, screened_out: true })).toBe(false);
    expect(waLib.consultWaEligible('not_booked', { qualified: true, wa: { not_booked: { sent_at: 'x' } } })).toBe(false);
    // A booking confirmation survives a signed_up stop but never an unsubscribe.
    expect(waLib.consultWaEligible('call_booked', { call_booked: true, stopped: 'signed_up' })).toBe(true);
    expect(waLib.consultWaEligible('call_booked', { call_booked: true, stopped: 'unsubscribed' })).toBe(false);
    expect(waLib.consultWaEligible('signed_up', { qualified: true, stopped: 'signed_up' })).toBe(true);
  });

  it('builds positional placeholders and refuses an empty booking link', () => {
    const booked = waLib.buildConsultWaMessage('call_booked', { name: 'Louise Beet', callAtIso: '2026-08-24T13:00:00Z' });
    expect(booked.templateName).toBe('gp_link_consult_call_booked');
    expect(booked.placeholders[0]).toBe('Louise');
    expect(booked.placeholders[1]).toContain('(UK time)');
    expect(booked.placeholders[1]).toContain('August');
    const nudge = waLib.buildConsultWaMessage('not_booked', { name: '', bookUrl: 'https://x/start?lead=T#book' });
    expect(nudge.placeholders).toEqual(['there', 'https://x/start?lead=T#book']);
    expect(waLib.buildConsultWaMessage('not_booked', { name: 'A' })).toBe(null);
    expect(waLib.buildConsultWaMessage('signed_up', { name: 'Priya Patel' }).placeholders).toEqual(['Priya']);
  });

  it('onboarding decision: waits 24h, sends inside the window, terminal-marks the rest', () => {
    const consult = { qualified: true, stopped: 'signed_up' };
    const now = Date.now();
    const base = { consult, userExists: true, onboardingComplete: false, nowMs: now };
    expect(waLib.onboardingNudgeDecision({ ...base, signupAtMs: now - 2 * H })).toEqual({ action: 'skip' });
    expect(waLib.onboardingNudgeDecision({ ...base, signupAtMs: now - 2 * D })).toEqual({ action: 'send' });
    expect(waLib.onboardingNudgeDecision({ ...base, signupAtMs: now - 20 * D })).toEqual({ action: 'mark', value: 'window_passed' });
    expect(waLib.onboardingNudgeDecision({ ...base, onboardingComplete: true, signupAtMs: now - 2 * D })).toEqual({ action: 'mark', value: 'completed' });
    expect(waLib.onboardingNudgeDecision({ ...base, userExists: false, signupAtMs: now - 2 * D })).toEqual({ action: 'mark', value: 'no_account' });
    expect(waLib.onboardingNudgeDecision({ consult: { qualified: true, stopped: 'signed_up', wa: { onboarding_incomplete: { sent_at: 'x' } } }, userExists: true, onboardingComplete: false, signupAtMs: now - 2 * D, nowMs: now }))
      .toEqual({ action: 'skip' });
  });
});

describe('cron wiring', () => {
  it('rides WhatsApp along on the first due not_booked email touch, once ever', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedLead();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(resendCaptured.length).toBe(1); // the email still goes out
    expect(waSends().length).toBe(1);
    const msg = lastWaMessage();
    expect(msg.to).toBe('+447700900123');
    expect(msg.content.templateName).toBe('gp_link_consult_book_nudge');
    expect(msg.content.templateData.body.placeholders[0]).toBe('Aisha');
    expect(msg.content.templateData.body.placeholders[1]).toContain('/start?lead=' + lead.metadata.consult.token);
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.wa.not_booked.sent_at).toEqual(expect.any(String));
    // Rerun: nothing due, marker holds — no second WhatsApp.
    await get(CRON, AUTH);
    expect(waSends().length).toBe(1);
  });

  it('does not WhatsApp an unqualified or phone-less lead', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const noPhone = seedLead({ phone: '' });
    testUtils.__seedSiteEnquiriesForTest([noPhone]);
    await get(CRON, AUTH);
    expect(resendCaptured.length).toBe(1); // email path unaffected
    expect(waSends().length).toBe(0);
  });

  it('sends the signed_up welcome when the cron detects the account', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedLead();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    testUtils.__seedUserForTest(lead.email);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    const sends = waSends();
    const welcome = sends.find((s) => s.body.messages[0].content.templateName === 'gp_link_consult_signup_welcome');
    expect(welcome).toBeTruthy();
    expect(welcome.body.messages[0].to).toBe('+447700900123');
    const row = readDb().siteEnquiries[0];
    expect(row.status).toBe('converted');
    expect(row.metadata.consult.stopped).toBe('signed_up');
    expect(row.metadata.consult.wa.signed_up.sent_at).toEqual(expect.any(String));
  });

  it('nudges a signed-up lead who has not finished onboarding 24h+ after signup, once ever', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedLead({});
    lead.metadata.consult.stopped = 'signed_up';
    testUtils.__seedSiteEnquiriesForTest([lead]);
    testUtils.__seedUserForTest(lead.email, { created_at: new Date(Date.now() - 2 * D).toISOString() });
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(waSends().length).toBe(1);
    const msg = lastWaMessage();
    expect(msg.content.templateName).toBe('gp_link_consult_onboarding_nudge');
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.wa.onboarding_incomplete.sent_at).toEqual(expect.any(String));
    await get(CRON, AUTH);
    expect(waSends().length).toBe(1);
  });

  it('terminal-marks instead of messaging a stale signup (window passed) or a completed onboarding', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const stale = seedLead({});
    stale.metadata.consult.stopped = 'signed_up';
    const done = seedLead({});
    done.metadata.consult.stopped = 'signed_up';
    testUtils.__seedSiteEnquiriesForTest([stale, done]);
    testUtils.__seedUserForTest(stale.email, { created_at: new Date(Date.now() - 20 * D).toISOString() });
    testUtils.__seedUserForTest(done.email, {
      created_at: new Date(Date.now() - 2 * D).toISOString(),
      onboarding_completed_at: new Date(Date.now() - D).toISOString()
    });
    await get(CRON, AUTH);
    expect(waSends().length).toBe(0);
    const rows = readDb().siteEnquiries;
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(byEmail[stale.email].metadata.consult.wa.onboarding_incomplete.resolved).toBe('window_passed');
    expect(byEmail[done.email].metadata.consult.wa.onboarding_incomplete.resolved).toBe('completed');
  });

  it('confirms a booked call over WhatsApp via maybeSendConsultWa, once ever', async () => {
    dtCaptured.length = 0;
    const lead = seedLead({});
    lead.metadata.consult.call_booked = true;
    lead.metadata.consult.call_at = '2026-09-05T07:00:00Z';
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const rows = await testUtils.listSiteEnquiryRows('', 'gp');
    const first = await testUtils.maybeSendConsultWa(rows[0], 'call_booked', { callAtIso: lead.metadata.consult.call_at });
    expect(first.ok).toBe(true);
    expect(waSends().length).toBe(1);
    const msg = lastWaMessage();
    expect(msg.content.templateName).toBe('gp_link_consult_call_booked');
    expect(msg.content.templateData.body.placeholders[1]).toContain('September');
    expect(msg.content.templateData.body.placeholders[1]).toContain('(UK time)');
    const again = await testUtils.maybeSendConsultWa(rows[0], 'call_booked', { callAtIso: lead.metadata.consult.call_at });
    expect(again.ok).toBe(false);
    expect(waSends().length).toBe(1);
  });
});
