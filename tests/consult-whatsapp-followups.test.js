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

// Set to a template name to make the stub DoubleTick refuse that template with
// a 4xx (what a template still pending WhatsApp approval looks like).
let dtRejectTemplate = '';

function startCaptureServer(store, replyBody) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        if (store === dtCaptured && dtRejectTemplate && body.indexOf('"templateName":"' + dtRejectTemplate + '"') !== -1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'template not approved' }));
          return;
        }
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
    // Touches 2 and 3 of the pre-booking chase follow the same gates, each with
    // its own marker — the first touch having gone does not block the second.
    expect(waLib.NOT_BOOKED_WA_KINDS).toEqual(['not_booked', 'not_booked_2', 'not_booked_3']);
    expect(waLib.consultWaEligible('not_booked_2', { qualified: true, wa: { not_booked: { sent_at: 'x' } } })).toBe(true);
    expect(waLib.consultWaEligible('not_booked_2', { qualified: true, wa: { not_booked_2: { sent_at: 'x' } } })).toBe(false);
    expect(waLib.consultWaEligible('not_booked_3', { qualified: true, call_booked: true })).toBe(false);
    expect(waLib.consultWaEligible('not_booked_3', { qualified: true, stopped: 'exhausted' })).toBe(false);
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
    // Same shape, different template, for the later chase touches.
    const second = waLib.buildConsultWaMessage('not_booked_2', { name: 'Aisha Khan', bookUrl: 'https://x/start?lead=T#book' });
    expect(second.templateName).toBe('gp_link_consult_book_nudge_2');
    expect(second.placeholders).toEqual(['Aisha', 'https://x/start?lead=T#book']);
    const third = waLib.buildConsultWaMessage('not_booked_3', { name: 'Aisha Khan', bookUrl: 'https://x/start?lead=T#book' });
    expect(third.templateName).toBe('gp_link_consult_book_nudge_3');
    expect(waLib.buildConsultWaMessage('not_booked_3', { name: 'A' })).toBe(null);
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

// A not_booked lead part-way through the sequence: `steps` = recorded step
// numbers, each stamped at a plausible time for a lead created `ageMs` ago.
function seedMidSequence(ageMs, steps, extraConsult) {
  const created = Date.now() - ageMs;
  const at = { 0: created + 2 * H, 1: created + 48 * H, 2: created + 5 * D };
  const lead = seedLead({ created_at: new Date(created).toISOString() });
  lead.metadata.consult.nudges = steps.map((s) => ({ seq: 'not_booked', step: s, sent_at: new Date(at[s]).toISOString() }));
  Object.assign(lead.metadata.consult, extraConsult || {});
  return lead;
}

describe('cron wiring', () => {
  it('rides WhatsApp along on the first due not_booked email touch, once per step', async () => {
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
    // The DoubleTick contact is named with the candidate's FULL name before
    // the message, so the chat never shows a bare phone number as the name.
    const nameSaves = dtCaptured.filter((c) => c.path === '/customer/assign-tags-custom-fields');
    expect(nameSaves.length).toBe(1);
    expect(nameSaves[0].body).toEqual({ phone: '447700900123', name: 'Aisha Khan', wabaNumber: '61494391968' });
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.wa.not_booked.sent_at).toEqual(expect.any(String));
    expect(row.metadata.consult.nudges[0]).toMatchObject({ step: 0, email: 'sent' });
    // Rerun: nothing due, marker holds — no second WhatsApp.
    await get(CRON, AUTH);
    expect(waSends().length).toBe(1);
  });

  it('touch 2 (48h) sends the second template with its email; touch 3 (day 5) is WhatsApp only', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    // 49h old, step 0 recorded at 2h with its WhatsApp sent → step 1 is due.
    const lead = seedMidSequence(49 * H, [0], { wa: { not_booked: { sent_at: 'x' } } });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    let res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(1);
    expect(resendCaptured.length).toBe(1);
    expect(waSends().length).toBe(1);
    expect(lastWaMessage().content.templateName).toBe('gp_link_consult_book_nudge_2');
    let row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.wa.not_booked_2.sent_at).toEqual(expect.any(String));
    expect(row.metadata.consult.nudges[1]).toMatchObject({ step: 1, email: 'sent' });

    // Day 6, steps 0 and 1 done → the last note goes out on WhatsApp alone.
    resendCaptured.length = 0; dtCaptured.length = 0;
    const late = seedMidSequence(6 * D, [0, 1], { wa: { not_booked: { sent_at: 'x' }, not_booked_2: { sent_at: 'y' } } });
    testUtils.__seedSiteEnquiriesForTest([late]);
    res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(1);
    expect(resendCaptured.length).toBe(0);
    expect(waSends().length).toBe(1);
    expect(lastWaMessage().content.templateName).toBe('gp_link_consult_book_nudge_3');
    row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.nudges[2]).toMatchObject({ step: 2, email: 'none' });
    expect(row.metadata.consult.wa.not_booked_3.sent_at).toEqual(expect.any(String));
    // All three steps sent and nothing owed → exhausted on the next pass, and no more messages.
    res = await get(CRON, AUTH);
    expect(res.json.stopped).toBe(1);
    expect(readDb().siteEnquiries[0].metadata.consult.stopped).toBe('exhausted');
    expect(waSends().length).toBe(1);
  });

  it('a WhatsApp template that is refused (pending approval) is owed and retried, and holds off the exhausted stop', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    dtRejectTemplate = 'gp_link_consult_book_nudge_2';
    try {
      const lead = seedMidSequence(49 * H, [0], { wa: { not_booked: { sent_at: 'x' } } });
      testUtils.__seedSiteEnquiriesForTest([lead]);
      let res = await get(CRON, AUTH);
      expect(res.json.sent).toBe(1);           // the email leg went…
      expect(resendCaptured.length).toBe(1);
      expect(waSends().length).toBe(0);        // …the WhatsApp leg was refused
      let row = readDb().siteEnquiries[0];
      expect(row.metadata.consult.nudges.length).toBe(2);
      expect(row.metadata.consult.wa.not_booked_2).toBeUndefined();
      expect(row.metadata.consult.wa_skipped).toBeUndefined();
      // Still refused next hour: nothing sent, still owed, no stop.
      res = await get(CRON, AUTH);
      expect(waSends().length).toBe(0);
      expect(res.json.stopped).toBe(0);
      // Approved: the owed leg goes out on the next pass, with no email.
      dtRejectTemplate = '';
      resendCaptured.length = 0;
      res = await get(CRON, AUTH);
      expect(resendCaptured.length).toBe(0);
      expect(waSends().length).toBe(1);
      expect(lastWaMessage().content.templateName).toBe('gp_link_consult_book_nudge_2');
      row = readDb().siteEnquiries[0];
      expect(row.metadata.consult.wa.not_booked_2.sent_at).toEqual(expect.any(String));
    } finally {
      dtRejectTemplate = '';
    }
  });

  it('a hard-bounced email keeps the WhatsApp chase going and is never filed as an unsubscribe', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedLead();
    await testUtils.suppressEmail(lead.email, 'hard_bounce', 'resend_webhook');
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(1);
    expect(res.json.stopped).toBe(0);
    expect(resendCaptured.length).toBe(0);   // dead address: no email attempt reaches Resend
    expect(waSends().length).toBe(1);        // live phone: the WhatsApp still goes
    expect(lastWaMessage().content.templateName).toBe('gp_link_consult_book_nudge');
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.stopped).toBeUndefined();
    expect(row.metadata.consult.email_bounced).toBe(true);
    expect(row.metadata.consult.nudges[0]).toMatchObject({ step: 0, email: 'bounced' });
    // Later steps skip the email leg outright and record that they did.
    const later = seedMidSequence(49 * H, [0], { email_bounced: true, wa: { not_booked: { sent_at: 'x' } } });
    testUtils.__seedSiteEnquiriesForTest([later]);
    resendCaptured.length = 0; dtCaptured.length = 0;
    await get(CRON, AUTH);
    expect(resendCaptured.length).toBe(0);
    expect(waSends().length).toBe(1);
    expect(lastWaMessage().content.templateName).toBe('gp_link_consult_book_nudge_2');
    expect(readDb().siteEnquiries[0].metadata.consult.nudges[1]).toMatchObject({ step: 1, email: 'skipped' });
  });

  it('a real unsubscribe (or spam complaint) still stops every channel, with the reason recorded', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedLead();
    await testUtils.suppressEmail(lead.email, 'unsubscribe', 'marketing');
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await get(CRON, AUTH);
    expect(res.json.stopped).toBe(1);
    expect(resendCaptured.length).toBe(0);
    expect(waSends().length).toBe(0);
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.stopped).toBe('unsubscribed');
    expect(row.metadata.consult.unsubscribe_reason).toBe('unsubscribe');
    // and stays stopped on the next pass — no re-check, no message
    await get(CRON, AUTH);
    expect(waSends().length).toBe(0);
  });

  it('repairs a lead stopped as "unsubscribed" by the old code when the suppression was really a bounce', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const bounced = seedLead();
    bounced.metadata.consult.stopped = 'unsubscribed';
    await testUtils.suppressEmail(bounced.email, 'hard_bounce', 'resend_webhook');
    const genuine = seedLead();
    genuine.metadata.consult.stopped = 'unsubscribed';
    await testUtils.suppressEmail(genuine.email, 'unsubscribe', 'marketing');
    testUtils.__seedSiteEnquiriesForTest([bounced, genuine]);
    const res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(1);
    const rows = readDb().siteEnquiries;
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
    // The bounced one resumes on WhatsApp: stop lifted, first touch out, email leg skipped.
    expect(byEmail[bounced.email].metadata.consult.stopped).toBeUndefined();
    expect(byEmail[bounced.email].metadata.consult.email_bounced).toBe(true);
    expect(byEmail[bounced.email].metadata.consult.nudges[0]).toMatchObject({ step: 0, email: 'skipped' });
    expect(waSends().length).toBe(1);
    expect(lastWaMessage().to).toBe('+447700900123');
    expect(resendCaptured.length).toBe(0);
    // The genuine one stays stopped, now with its reason on record so it is not re-checked hourly.
    expect(byEmail[genuine.email].metadata.consult.stopped).toBe('unsubscribed');
    expect(byEmail[genuine.email].metadata.consult.unsubscribe_reason).toBe('unsubscribe');
  });

  it('joins a Calendly booking to the enquiry by PHONE when the doctor booked under another email', async () => {
    dtCaptured.length = 0;
    const lead = seedLead({ phone: '+44 7700 900123' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const now = new Date().toISOString();
    // Same person, gmail on Calendly, nhs.net on the lead — and Calendly's phone written differently.
    await testUtils.ensureLeadBookedCallAt('same.person@gmail.com', '2026-09-20T09:00:00Z', now, '+447700900123');
    let row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.call_booked).toBe(true);
    expect(row.metadata.consult.call_at).toBe('2026-09-20T09:00:00Z');
    expect(row.metadata.consult.booking_email).toBe('same.person@gmail.com');
    expect(row.metadata.consult.booked_via).toBe('phone_match');
    // …and the booking confirmation went to them like any other booker.
    expect(waSends().length).toBe(1);
    expect(lastWaMessage().content.templateName).toBe('gp_link_consult_call_booked');
    // The direct-booker capture sees the phone match too and does NOT split them into a second lead.
    await testUtils.captureCalendlyDirectBookerLead({ email: 'same.person@gmail.com', name: 'Aisha Khan', phone: '+447700900123', nowIso: now, scheduledAt: '2026-09-20T09:00:00Z' });
    expect(readDb().siteEnquiries.length).toBe(1);
    // A stranger with a different number still gets their own lead row.
    await testUtils.captureCalendlyDirectBookerLead({ email: 'stranger@example.com', name: 'Someone Else', phone: '+447700900999', nowIso: now, scheduledAt: '2026-09-21T09:00:00Z' });
    expect(readDb().siteEnquiries.length).toBe(2);
    // Now that the lead is booked, the pre-booking chase is over for it.
    resendCaptured.length = 0; dtCaptured.length = 0;
    await get(CRON, AUTH);
    expect(waSends().map((s) => s.body.messages[0].content.templateName)).not.toContain('gp_link_consult_book_nudge');
  });

  it('records which ad produced a Calendly booking, and never lets a later event overwrite it', async () => {
    // The Warm/Hot retargeting ads send people STRAIGHT to Calendly, so they never
    // touch a lead form: utm_campaign, forwarded by Calendly, is the only thing that
    // separates one of those bookings from an organic direct one.
    expect(testUtils.normalizeCalendlyBookingUtm({ utm_campaign: 'WARM', utm_source: 'facebook', utm_medium: 'paid' }))
      .toEqual({ campaign: 'warm', source: 'facebook', medium: 'paid' });
    // utm_content carries the correlation token, not a campaign — it must not leak in.
    expect(testUtils.normalizeCalendlyBookingUtm({ utm_content: 'call_abc' })).toBe(null);
    expect(testUtils.normalizeCalendlyBookingUtm(null)).toBe(null);
    expect(testUtils.normalizeCalendlyBookingUtm({ utm_campaign: 'x'.repeat(400) }).campaign.length).toBe(120);

    // A Cold form-filler who never booked comes back through a Warm ad.
    const lead = seedLead({ phone: '+44 7700 900321' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const now = new Date().toISOString();
    await testUtils.ensureLeadBookedCallAt(lead.email, '2026-09-25T09:00:00Z', now, null, { campaign: 'warm', source: 'facebook' });
    expect(readDb().siteEnquiries[0].metadata.consult.booking_utm).toEqual({ campaign: 'warm', source: 'facebook' });

    // Calendly replays the tracking block on every invitee.created, so a reschedule
    // must not hand the credit to whatever campaign happens to be tagged later.
    await testUtils.ensureLeadBookedCallAt(lead.email, '2026-09-26T09:00:00Z', now, null, { campaign: 'hot' });
    expect(readDb().siteEnquiries[0].metadata.consult.booking_utm.campaign).toBe('warm');
    expect(readDb().siteEnquiries[0].metadata.consult.call_at).toBe('2026-09-26T09:00:00Z');

    // …and an untagged booking never blanks a campaign already on record.
    await testUtils.ensureLeadBookedCallAt(lead.email, '2026-09-27T09:00:00Z', now, null, null);
    expect(readDb().siteEnquiries[0].metadata.consult.booking_utm.campaign).toBe('warm');

    // A stranger who books straight off a Warm ad gets the tag on their new lead row.
    await testUtils.captureCalendlyDirectBookerLead({
      email: 'warm.booker@example.com', name: 'New Booker', phone: '+447700900777',
      nowIso: now, scheduledAt: '2026-09-28T09:00:00Z', utm: { campaign: 'warm', source: 'facebook' }
    });
    const fresh = readDb().siteEnquiries.find((r) => r.email === 'warm.booker@example.com');
    expect(fresh.metadata.consult.booking_utm).toEqual({ campaign: 'warm', source: 'facebook' });
    expect(fresh.metadata.consult.call_booked).toBe(true);
    // An organic direct booker still gets a clean row with no campaign invented for them.
    await testUtils.captureCalendlyDirectBookerLead({
      email: 'organic.booker@example.com', name: 'Organic', phone: '+447700900888',
      nowIso: now, scheduledAt: '2026-09-29T09:00:00Z'
    });
    const organic = readDb().siteEnquiries.find((r) => r.email === 'organic.booker@example.com');
    expect(organic.metadata.consult.booking_utm).toBeUndefined();
    expect(organic.metadata.consult.call_booked).toBe(true);
  });

  it('phone matching compares the last ten digits and refuses short numbers', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedLead({ phone: '07700 900-123' })]);
    expect(testUtils.consultPhoneMatchKey('+44 7700 900123')).toBe('7700900123');
    expect(testUtils.consultPhoneMatchKey('07700900123')).toBe('7700900123');
    expect(testUtils.consultPhoneMatchKey('12345')).toBe('');
    expect((await testUtils.findConsultLeadByPhone('+447700900123')).phone).toBe('07700 900-123');
    expect(await testUtils.findConsultLeadByPhone('+447700900124')).toBe(null);
    expect(await testUtils.findConsultLeadByPhone('900123')).toBe(null);
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

  it('refuses to save a junk contact name (digits-only or too short)', async () => {
    dtCaptured.length = 0;
    expect((await testUtils.ensureDoubleTickContactName('+447700900123', '447700900123')).skipped).toBe(true);
    expect((await testUtils.ensureDoubleTickContactName('+447700900123', ' ')).skipped).toBe(true);
    expect((await testUtils.ensureDoubleTickContactName('', 'Aisha Khan')).skipped).toBe(true);
    expect(dtCaptured.length).toBe(0);
    expect((await testUtils.ensureDoubleTickContactName('+447700900123', 'Aisha Khan')).ok).toBe(true);
    expect(dtCaptured.length).toBe(1);
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
