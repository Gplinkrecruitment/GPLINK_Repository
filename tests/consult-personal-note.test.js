// A personal WhatsApp note the owner approved in advance (lib/consult-personal-note.js):
// held on the lead, sent by the consult-nudge cron when its time comes, and only
// if the doctor still has no app account.
//
// Unit tests for the pure decision, then the real server in LOCAL-JSON mode over
// HTTP with a stub DoubleTick (same harness as tests/consult-noshow-rescue.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import note from '../lib/consult-personal-note.js';

const H = 3600 * 1000;
const NOW = Date.parse('2026-11-18T10:05:00Z');
const base = (over, consultOver) => Object.assign({
  id: 'l1', kind: 'gp', status: 'new', email: 'dr@example.com', phone: '+447700900123',
  metadata: { consult: Object.assign({
    call_booked: true,
    personal_note: { id: 'n1', send_after: '2026-11-18T10:00:00Z', name: 'Dr Radrie', first: 'It was lovely speaking with you last week!', second: 'No pressure at all' }
  }, consultOver || {}) }
}, over || {});
const decide = (row, extra) => note.personalNoteDecision(Object.assign({ row, nowMs: NOW, hasPhone: true }, extra || {}));

describe('personalNoteDecision', () => {
  it('does nothing without a note, or once it is sent or cancelled', () => {
    expect(decide(base({}, { personal_note: undefined })).action).toBe('none');
    expect(decide(base({}, { personal_note: { send_after: '2026-11-18T10:00:00Z', name: 'a', first: 'b', second: 'c', sent_at: 'x' } })).action).toBe('none');
    expect(decide(base({}, { personal_note: { send_after: '2026-11-18T10:00:00Z', name: 'a', first: 'b', second: 'c', cancelled: 'signed_up' } })).action).toBe('none');
  });

  it('waits until its time, then asks for the account check before sending', () => {
    expect(note.personalNoteDecision({ row: base(), nowMs: NOW - H, hasPhone: true }).action).toBe('wait');
    expect(decide(base()).action).toBe('check_account');
    const d = decide(base(), { accountExists: false });
    expect(d.action).toBe('send');
    expect(d.message).toEqual({ templateName: 'gp_link_khaleed_personal_checkin', language: 'en',
      placeholders: ['Dr Radrie', 'It was lovely speaking with you last week!', 'No pressure at all'] });
  });

  it('is cancelled when the doctor has signed up, by any of the three signals', () => {
    expect(decide(base(), { accountExists: true })).toEqual({ action: 'cancel', reason: 'signed_up' });
    expect(decide(base({ status: 'converted' }))).toEqual({ action: 'cancel', reason: 'signed_up' });
    expect(decide(base({}, { stopped: 'signed_up' }))).toEqual({ action: 'cancel', reason: 'signed_up' });
    // ...and that is noticed before the note is even due.
    expect(note.personalNoteDecision({ row: base({ status: 'converted' }), nowMs: NOW - 48 * H, hasPhone: true }).action).toBe('cancel');
  });

  it('honours a stop, but not an exhausted email chase or a reply', () => {
    ['unsubscribed', 'do_not_call', 'not_interested'].forEach((s) => {
      expect(decide(base({}, { stopped: s }))).toEqual({ action: 'cancel', reason: 'stopped_' + s });
    });
    expect(decide(base({}, { stopped: 'exhausted' }), { accountExists: false }).action).toBe('send');
    expect(decide(base({}, { stopped: 'replied' }), { accountExists: false }).action).toBe('send');
  });

  it('gives up on a note that is too late, has no number, or keeps failing', () => {
    expect(note.personalNoteDecision({ row: base(), nowMs: NOW + note.PERSONAL_NOTE_EXPIRES_MS + H, hasPhone: true })).toEqual({ action: 'cancel', reason: 'expired' });
    expect(note.personalNoteDecision({ row: base(), nowMs: NOW, hasPhone: false })).toEqual({ action: 'cancel', reason: 'no_phone' });
    const failing = base(); failing.metadata.consult.personal_note.tries = note.PERSONAL_NOTE_MAX_TRIES;
    expect(decide(failing)).toEqual({ action: 'cancel', reason: 'send_failed' });
  });

  it('refuses text WhatsApp would reject as a template parameter', () => {
    const bad = (over) => { const r = base(); Object.assign(r.metadata.consult.personal_note, over); return decide(r); };
    expect(bad({ first: 'line one\nline two' })).toEqual({ action: 'cancel', reason: 'bad_text' });
    expect(bad({ second: 'a tab\there' })).toEqual({ action: 'cancel', reason: 'bad_text' });
    expect(bad({ second: 'too     many spaces' })).toEqual({ action: 'cancel', reason: 'bad_text' });
    expect(bad({ name: '' })).toEqual({ action: 'cancel', reason: 'bad_text' });
    expect(bad({ send_after: 'not a date' })).toEqual({ action: 'cancel', reason: 'bad_send_after' });
  });

  it('renders the message exactly as the approved template reads', () => {
    expect(note.renderPersonalNote({ name: 'Dr Radrie', first: 'First.', second: 'Second' }))
      .toBe('Hi Dr Radrie, Khaleed here from GP Link. Hope all is well!\n\nFirst.\n\nSecond 😊\n\nWarm regards,\nKhaleed');
  });
});

// ── the cron ────────────────────────────────────────────────────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-personal-note-${RUN_ID}.json`;
let server, addrPort, testUtils, dtServer, resendServer;
const dtCaptured = [];
const resendCaptured = [];
let dtStatus = 200;
const NUDGE_CRON = '/api/cron/consult-nudge';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const TEMPLATE = 'gp_link_khaleed_personal_checkin';

function get(p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path: p, method: 'GET', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* null */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end();
  });
}
function stub(store, status, reply) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        store.push({ path: req.url, method: req.method, body: parsed });
        res.writeHead(status(), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply()));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const dbRow = (id) => ((JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).siteEnquiries) || []).find((r) => r.id === id);
const notesSent = () => dtCaptured.filter((c) => c.path === '/whatsapp/message/template' && c.body && c.body.messages && c.body.messages[0].content.templateName === TEMPLATE);
let seq = 0;
// A lead whose consultation was held a week ago and who has every other touch
// on record, so nothing else in the cron falls due.
function seedLead(noteOver, rowOver, consultOver) {
  seq++;
  const weekAgo = new Date(Date.now() - 7 * 24 * H).toISOString();
  const consult = Object.assign({
    token: 'PNTOK' + seq, qualified: true, is_gp: true, country: 'uk', stopped: 'exhausted',
    call_booked: true, call_booked_at: weekAgo, call_at: weekAgo, call_completed_at: weekAgo, call_attended: true,
    wa: { call_booked: { sent_at: weekAgo }, post_call_onboard: { sent_at: weekAgo } },
    personal_note: Object.assign({ id: 'pn-' + seq, send_after: new Date(Date.now() - 5 * 60000).toISOString(), name: 'Dr Radrie',
      first: 'It was lovely speaking with you last week!', second: 'No pressure at all', created_by: 'test' }, noteOver || {})
  }, consultOver || {});
  return Object.assign({
    id: 'lead-pn-' + RUN_ID + '-' + seq, created_at: new Date(Date.now() - 30 * 24 * H).toISOString(), kind: 'gp',
    name: 'Radrie Cole', email: 'radrie.pn' + seq + '@nhs-test.co.uk', status: 'new', phone: '+44 7700 9002' + String(10 + seq),
    metadata: { source: 'zoho_import', consult }
  }, rowOver || {});
}

beforeAll(async () => {
  dtServer = await stub(dtCaptured, () => dtStatus, () => (dtStatus === 200 ? { messages: [{ id: 'wa-stub', status: 'SENT' }] } : { message: 'template paused' }));
  resendServer = await stub(resendCaptured, () => 200, () => ({ id: 'stub' }));
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-consult-personal-note-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendServer.address().port + '/emails';
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtServer.address().port;
  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  for (const s of [server, dtServer, resendServer]) { if (s) await new Promise((resolve) => s.close(resolve)); }
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('the consult-nudge cron sends a due personal note', () => {
  it('sends it once, with the approved wording as the three template parameters', async () => {
    dtCaptured.length = 0; dtStatus = 200;
    const lead = seedLead();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    expect((await get(NUDGE_CRON, AUTH)).status).toBe(200);
    const sent = notesSent();
    expect(sent.length).toBe(1);
    expect(sent[0].body.messages[0].to.replace(/\D/g, '')).toBe(lead.phone.replace(/\D/g, ''));
    expect(sent[0].body.messages[0].content.templateData.body.placeholders).toEqual(['Dr Radrie', 'It was lovely speaking with you last week!', 'No pressure at all']);
    expect(dbRow(lead.id).metadata.consult.personal_note.sent_at).toEqual(expect.any(String));
    await get(NUDGE_CRON, AUTH);
    await get(NUDGE_CRON, AUTH);
    expect(notesSent().length).toBe(1);
  });

  it('holds a note that is not due yet, and never sends to a doctor who signed up', async () => {
    dtCaptured.length = 0; dtStatus = 200;
    const early = seedLead({ send_after: new Date(Date.now() + 6 * H).toISOString() });
    const signedUp = seedLead({}, { status: 'converted' }, { stopped: 'signed_up' });
    testUtils.__seedSiteEnquiriesForTest([early, signedUp]);
    await get(NUDGE_CRON, AUTH);
    expect(notesSent().length).toBe(0);
    expect(dbRow(early.id).metadata.consult.personal_note.sent_at).toBeUndefined();
    expect(dbRow(early.id).metadata.consult.personal_note.cancelled).toBeUndefined();
    expect(dbRow(signedUp.id).metadata.consult.personal_note.cancelled).toBe('signed_up');
  });

  it('a refused send is counted and tried again on a later pass', async () => {
    dtCaptured.length = 0; dtStatus = 500;
    const lead = seedLead();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await get(NUDGE_CRON, AUTH);
    expect(dbRow(lead.id).metadata.consult.personal_note.sent_at).toBeUndefined();
    expect(dbRow(lead.id).metadata.consult.personal_note.tries).toBe(1);
    dtStatus = 200;
    await get(NUDGE_CRON, AUTH);
    expect(dbRow(lead.id).metadata.consult.personal_note.sent_at).toEqual(expect.any(String));
  });
});
