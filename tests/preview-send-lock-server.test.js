// WP-00S — preview send lock, wired into the real server.
//
// Loads the real server.js (local file store, no Supabase) with every outbound
// fetch replaced by a recorder that never touches the network, then flips
// VERCEL_ENV / NOTIFY_TEST_RECIPIENTS between tests (the lock reads them at
// call time). Each flow is proven twice: locked on a simulated preview, and
// exactly as before with VERCEL_ENV=production or unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-preview-send-lock-${RUN_ID}.json`);

const OWNER = 'owner@gplink-test.local';
const OWNER2 = 'second@gplink-test.local';
const REAL = 'dr.real@realclinic-test.local';
const REAL2 = 'manager@realpractice-test.local';
const OWNER_PHONE = '+61400000111';
const REAL_PHONE = '+447700900123';
const MAILBOX = 'team@mygplink.com.au';
const LIST = [OWNER, OWNER2, OWNER_PHONE].join(', ');

let server, port, utils, realFetch;
const calls = [];      // every outbound fetch the server attempted
const gmailSends = []; // every Gmail messages.send the server attempted

const SAVED_ENV = {};
const TOUCHED = ['VERCEL_ENV', 'NOTIFY_TEST_RECIPIENTS', 'META_CAPI_DATASET_ID', 'META_CAPI_ACCESS_TOKEN'];

function setEnv(vercelEnv, list) {
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = vercelEnv;
  if (list === undefined) delete process.env.NOTIFY_TEST_RECIPIENTS; else process.env.NOTIFY_TEST_RECIPIENTS = list;
}
const callsTo = (needle) => calls.filter((c) => c.url.indexOf(needle) !== -1);

function decodeRaw(raw) {
  return Buffer.from(String(raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function header(rawMessage, name) {
  const m = rawMessage.split('\r\n\r\n')[0].match(new RegExp('^' + name + ': (.*)$', 'mi'));
  return m ? m[1] : null;
}
function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text, body: JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  TOUCHED.forEach((k) => { SAVED_ENV[k] = process.env[k]; });
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'preview-send-lock-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.DOUBLETICK_API_KEY = 'test-doubletick-key';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@gplink-test.local';
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'not-a-real-key';
  process.env.GOOGLE_CALENDAR_ID = 'diary@gplink-test.local';
  process.env.CALENDLY_API_TOKEN = 'test-calendly-token';
  // The server builds its ordinary allow-list once at load. It must see the
  // production shape: no list, no VERCEL_ENV.
  delete process.env.VERCEL_ENV;
  delete process.env.NOTIFY_TEST_RECIPIENTS;
  delete process.env.VERCEL;

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const o = opts || {};
    let body = null;
    try { body = o.body ? JSON.parse(o.body) : null; } catch { body = o.body; }
    calls.push({ url: u, method: o.method || 'GET', body });
    let payload = { ok: true };
    if (u.indexOf('/calendar/v3/') !== -1) payload = { id: 'evt_' + calls.length };
    else if (u.indexOf('resend.com') !== -1) payload = { id: 'email_' + calls.length };
    else if (u.indexOf('/whatsapp/message') !== -1) payload = { messages: [{ messageId: 'wa_' + calls.length, status: 'SENT' }] };
    else if (u.indexOf('create-phone-call') !== -1) payload = { call_id: 'call_' + calls.length, call_status: 'registered', agent_id: 'agent_test' };
    else if (u.indexOf('list-agent-versions') !== -1) payload = [];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const serverModule = await import('../server.js');
  utils = serverModule.__testUtils;
  utils.__setGoogleAccessTokenForTest(async () => 'test-google-token');
  utils.__setGmailClientForTest(MAILBOX, {
    users: {
      threads: { get: async () => ({ data: {} }) },
      messages: {
        send: async (args) => {
          gmailSends.push(decodeRaw(args.requestBody.raw));
          return { data: { id: 'gm_' + gmailSends.length, threadId: 'th_' + gmailSends.length } };
        }
      }
    }
  });
  server = serverModule.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (utils) { utils.__setGoogleAccessTokenForTest(null); utils.__setGmailClientForTest(MAILBOX, null); }
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = realFetch;
  TOUCHED.forEach((k) => { if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k]; });
  try { fs.unlinkSync(DB_FILE); } catch { /* never written */ }
});

beforeEach(() => { calls.length = 0; gmailSends.length = 0; setEnv(undefined, undefined); });

const NOT_PREVIEW = [['VERCEL_ENV=production', 'production'], ['VERCEL_ENV unset (localhost / tests)', undefined]];

// ── 1. Resend ────────────────────────────────────────────────────────────────
describe('Resend email (sendEmail)', () => {
  // The result sendEmail has always returned for an allow-list block: a
  // deliberate skip, never filed as a delivery failure and never retried.
  const BLOCKED = { ok: false, skipped: true, blocked: true, error: 'blocked_by_test_allowlist' };
  it('preview, no list: a send makes no network call and reports not sent', async () => {
    setEnv('preview', undefined);
    expect(await utils.sendEmail({ to: REAL, subject: 'Lock test', html: '<p>x</p>' })).toEqual(BLOCKED);
    expect(calls).toEqual([]);
  });
  it('preview, no list: even the owner address is blocked (fail closed)', async () => {
    setEnv('preview', '');
    expect(await utils.sendEmail({ to: OWNER, subject: 'Lock test', html: '<p>x</p>' })).toEqual(BLOCKED);
    expect(calls).toEqual([]);
  });
  it('preview, list set: a non-listed address makes no network call', async () => {
    setEnv('preview', LIST);
    expect(await utils.sendEmail({ to: REAL, subject: 'Lock test', html: '<p>x</p>' })).toEqual(BLOCKED);
    expect(calls).toEqual([]);
  });
  it('preview, list set: a listed address is sent, with an unlisted cc removed', async () => {
    setEnv('preview', LIST);
    expect(await utils.sendEmail({ to: OWNER, cc: REAL, subject: 'Lock test', html: '<p>x</p>' })).toEqual({ ok: true });
    const sent = callsTo('resend.com');
    expect(sent.length).toBe(1);
    expect([].concat(sent[0].body.to)).toEqual([OWNER]);
    expect([].concat(sent[0].body.cc || [])).toEqual([]);
    expect(JSON.stringify(sent[0].body)).not.toContain(REAL);
  });
  it.each(NOT_PREVIEW)('%s: sends to anyone, exactly as before', async (_label, vercelEnv) => {
    setEnv(vercelEnv, undefined);
    expect(await utils.sendEmail({ to: REAL, cc: REAL2, subject: 'Lock test', html: '<p>x</p>' })).toEqual({ ok: true });
    const sent = callsTo('resend.com');
    expect(sent.length).toBe(1);
    expect([].concat(sent[0].body.to)).toEqual([REAL]);
    expect([].concat(sent[0].body.cc)).toEqual([REAL2]);
  });
  it('VERCEL_ENV=production ignores a list that only appears at run time (the load-time list still rules)', async () => {
    // Off a preview the server keeps using the allow-list it built at load,
    // which is how it has always worked. This suite loaded with none.
    setEnv('production', LIST);
    expect(await utils.sendEmail({ to: REAL, subject: 'Lock test', html: '<p>x</p>' })).toEqual({ ok: true });
    expect(callsTo('resend.com').length).toBe(1);
  });
});

// ── 2. DoubleTick messages ───────────────────────────────────────────────────
describe('DoubleTick WhatsApp messages (guardedNotifyFetch)', () => {
  const text = (to) => ({ method: 'POST', headers: {}, body: JSON.stringify({ to, content: { text: 'hi' } }) });
  const URL_TEXT = 'https://public.doubletick.io/whatsapp/message/text';

  it('preview, no list: blocked with the same 403 shape an allow-list block has always had', async () => {
    setEnv('preview', undefined);
    const resp = await utils.guardedNotifyFetch('whatsapp', URL_TEXT, text(REAL_PHONE));
    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('blocked_by_test_allowlist');
    expect(JSON.stringify(body)).not.toContain(REAL_PHONE); // masked
    expect(calls).toEqual([]);
  });
  it('preview, list set: unlisted number blocked, listed number sent', async () => {
    setEnv('preview', LIST);
    expect((await utils.guardedNotifyFetch('whatsapp', URL_TEXT, text(REAL_PHONE))).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await utils.guardedNotifyFetch('whatsapp', URL_TEXT, text(OWNER_PHONE))).status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].body.to).toBe(OWNER_PHONE);
  });
  it('preview, list set: a template batch keeps only the listed number', async () => {
    setEnv('preview', LIST);
    const init = { method: 'POST', body: JSON.stringify({ messages: [{ to: REAL_PHONE, content: {} }, { to: OWNER_PHONE, content: {} }] }) };
    await utils.guardedNotifyFetch('whatsapp', 'https://public.doubletick.io/whatsapp/message/template', init);
    expect(calls.length).toBe(1);
    expect(calls[0].body.messages.map((m) => m.to)).toEqual([OWNER_PHONE]);
  });
  it.each(NOT_PREVIEW)('%s: the request goes out untouched', async (_label, vercelEnv) => {
    setEnv(vercelEnv, undefined);
    const init = text(REAL_PHONE);
    expect((await utils.guardedNotifyFetch('whatsapp', URL_TEXT, init)).status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].body.to).toBe(REAL_PHONE);
  });
});

// ── 3. Gmail API ─────────────────────────────────────────────────────────────
describe('Gmail API sends (sendGmailEmail)', () => {
  const mail = (to, cc) => ({ from: MAILBOX, fromName: 'GP Link', to, cc, subject: 'Lock test', bodyText: 'Hello' });

  it('preview, list set: a mixed to/cc list only reaches the listed addresses', async () => {
    setEnv('preview', LIST);
    const r = await utils.sendGmailEmail(mail('Dr Real <' + REAL + '>, Owner <' + OWNER + '>', REAL2 + ', ' + OWNER2));
    expect(r.ok).toBe(true);
    expect(gmailSends.length).toBe(1);
    expect(header(gmailSends[0], 'To')).toBe(OWNER);
    expect(header(gmailSends[0], 'Cc')).toBe(OWNER2);
    expect(gmailSends[0]).not.toContain(REAL);
    expect(gmailSends[0]).not.toContain(REAL2);
  });
  it('preview, list set: a listed "to" with only unlisted cc goes out with no Cc header at all', async () => {
    setEnv('preview', LIST);
    expect((await utils.sendGmailEmail(mail(OWNER, REAL))).ok).toBe(true);
    expect(header(gmailSends[0], 'To')).toBe(OWNER);
    expect(header(gmailSends[0], 'Cc')).toBeNull();
  });
  it('preview, list set: no listed "to" means Gmail is never called, and nothing throws', async () => {
    setEnv('preview', LIST);
    const r = await utils.sendGmailEmail(mail(REAL, OWNER));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('blocked_by_preview_send_lock');
    expect(gmailSends).toEqual([]);
  });
  it('preview, no list: every Gmail send is refused', async () => {
    setEnv('preview', undefined);
    const r = await utils.sendGmailEmail(mail(OWNER, undefined));
    expect(r).toEqual({ ok: false, error: 'blocked_by_preview_send_lock', blockedByPreviewSendLock: true });
    expect(gmailSends).toEqual([]);
  });
  it.each(NOT_PREVIEW)('%s: recipients and display names go out exactly as given', async (_label, vercelEnv) => {
    setEnv(vercelEnv, undefined);
    const r = await utils.sendGmailEmail(mail('Dr Real <' + REAL + '>, Owner <' + OWNER + '>', REAL2));
    expect(r.ok).toBe(true);
    expect(r.gmailMessageId).toBe('gm_1');
    expect(header(gmailSends[0], 'To')).toBe('Dr Real <' + REAL + '>, Owner <' + OWNER + '>');
    expect(header(gmailSends[0], 'Cc')).toBe(REAL2);
  });
  it('localhost with a list set is still untouched for Gmail (the lock is preview-only)', async () => {
    setEnv(undefined, LIST);
    expect((await utils.sendGmailEmail(mail(REAL, undefined))).ok).toBe(true);
    expect(header(gmailSends[0], 'To')).toBe(REAL);
  });
});

// ── 4. Google Calendar ───────────────────────────────────────────────────────
describe('Google Calendar events (gcalCreateEvent / gcalDeleteEvent)', () => {
  const event = () => ({
    summary: 'Interview — Dr Test Auvr @ Test Metro Practice (FAKE)',
    startUtc: '2030-01-01T00:00:00.000Z', endUtc: '2030-01-01T00:30:00.000Z',
    attendees: [OWNER, REAL], description: 'x', zoomJoinUrl: ''
  });

  it('preview, list set: unlisted attendee dropped, sendUpdates=none, event still created', async () => {
    setEnv('preview', LIST);
    const r = await utils.gcalCreateEvent(event());
    expect(r.id).toMatch(/^evt_/);
    const made = callsTo('/calendar/v3/');
    expect(made.length).toBe(1);
    expect(made[0].url).toContain('sendUpdates=none');
    expect(made[0].url).not.toContain('sendUpdates=all');
    expect(made[0].body.attendees).toEqual([{ email: OWNER }]);
    expect(JSON.stringify(made[0].body)).not.toContain(REAL);
  });
  it('preview, list set, every attendee listed: invites are allowed (sendUpdates=all)', async () => {
    setEnv('preview', LIST);
    await utils.gcalCreateEvent(Object.assign(event(), { attendees: [OWNER, OWNER2] }));
    const made = callsTo('/calendar/v3/');
    expect(made[0].url).toContain('sendUpdates=all');
    expect(made[0].body.attendees).toEqual([{ email: OWNER }, { email: OWNER2 }]);
  });
  it('preview, no list: no attendees and sendUpdates=none', async () => {
    setEnv('preview', undefined);
    await utils.gcalCreateEvent(event());
    const made = callsTo('/calendar/v3/');
    expect(made.length).toBe(1);
    expect(made[0].url).toContain('sendUpdates=none');
    expect(made[0].body.attendees).toEqual([]);
  });
  it('preview: deleting an event never notifies its attendees', async () => {
    setEnv('preview', LIST);
    expect(await utils.gcalDeleteEvent('evt_live_1')).toBe(true);
    const made = callsTo('/calendar/v3/');
    expect(made[0].method).toBe('DELETE');
    expect(made[0].url).toContain('/events/evt_live_1?sendUpdates=none');
  });
  it.each(NOT_PREVIEW)('%s: all attendees kept and sendUpdates=all, on create and delete', async (_label, vercelEnv) => {
    setEnv(vercelEnv, undefined);
    await utils.gcalCreateEvent(event());
    await utils.gcalDeleteEvent('evt_live_1');
    const made = callsTo('/calendar/v3/');
    expect(made[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/diary%40gplink-test.local/events?sendUpdates=all&conferenceDataVersion=0');
    expect(made[0].body.attendees).toEqual([{ email: OWNER }, { email: REAL }]);
    expect(made[1].url).toBe('https://www.googleapis.com/calendar/v3/calendars/diary%40gplink-test.local/events/evt_live_1?sendUpdates=all');
  });
});

// ── 5. DoubleTick account writes ─────────────────────────────────────────────
describe('DoubleTick account writes (assign, contact name)', () => {
  it.each([['no list', undefined], ['list set, even for a listed number', LIST]])('preview, %s: assign makes no network call', async (_label, list) => {
    setEnv('preview', list);
    const r = await utils.assignDoubleTickChat({ gpPhone: OWNER_PHONE, rsoPhone: '+61400000222' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'preview_send_lock' });
    expect(calls).toEqual([]);
  });
  it('preview: the contact name save makes no network call', async () => {
    setEnv('preview', LIST);
    const r = await utils.ensureDoubleTickContactName(OWNER_PHONE, 'Dr Test Auvr');
    expect(r).toEqual({ ok: false, skipped: true, reason: 'preview_send_lock' });
    expect(calls).toEqual([]);
  });
  it.each(NOT_PREVIEW)('%s: assign and contact name are written exactly as before', async (_label, vercelEnv) => {
    setEnv(vercelEnv, undefined);
    expect((await utils.assignDoubleTickChat({ gpPhone: REAL_PHONE, rsoPhone: '+61400000222' })).ok).toBe(true);
    expect((await utils.ensureDoubleTickContactName(REAL_PHONE, 'Dr Real Person')).ok).toBe(true);
    expect(callsTo('/team-member/assign').length).toBe(1);
    expect(callsTo('/team-member/assign')[0].body.customerPhoneNumber).toBe(REAL_PHONE);
    expect(callsTo('/customer/assign-tags-custom-fields').length).toBe(1);
  });
});

// ── 6. Retell, Meta CAPI, Calendly bookings ──────────────────────────────────
describe('belt and braces: Retell calls, Meta CAPI, Calendly bookings', () => {
  const row = { id: 'lead-lock-1', name: 'Test Lead', phone: REAL_PHONE, email: REAL, metadata: {} };
  const decision = { phone: REAL_PHONE, from: '+441111111111', attempt: 1, tz: 'Europe/London', country: 'uk' };
  const cfg = (testNumbers) => ({ apiKey: 'k', agentId: 'agent_test', testNumbers, directorName: 'D', agentName: 'A' });

  it('preview: a Retell call to a number outside LEAD_CALLS_TEST_NUMBERS is refused with no network call', async () => {
    setEnv('preview', LIST);
    const r = await utils.placeLeadCall(row, decision, cfg([]), { persist: false });
    expect(r).toEqual({ ok: false, error: 'blocked_by_preview_send_lock' });
    const r2 = await utils.placeLeadCall(row, decision, cfg(['+61400000999']), { persist: false });
    expect(r2.ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it('preview: a Retell call to a listed test number still goes through', async () => {
    setEnv('preview', undefined);
    const r = await utils.placeLeadCall(row, decision, cfg([REAL_PHONE]), { persist: false });
    expect(r.ok).toBe(true);
    expect(callsTo('create-phone-call').length).toBe(1);
  });
  it.each(NOT_PREVIEW)('%s: Retell calls are placed as before', async (_label, vercelEnv) => {
    setEnv(vercelEnv, undefined);
    const r = await utils.placeLeadCall(row, decision, cfg([]), { persist: false });
    expect(r.ok).toBe(true);
    expect(callsTo('create-phone-call')[0].body.to_number).toBe(REAL_PHONE);
  });

  it('preview: Meta CAPI is skipped; off preview it is not skipped by the lock', async () => {
    process.env.META_CAPI_DATASET_ID = '123456789';
    process.env.META_CAPI_ACCESS_TOKEN = 'test-capi-token';
    setEnv('preview', LIST);
    expect(await utils.syncMetaLeadStagesForRow(row, {})).toEqual({ ok: false, skipped: 'preview_send_lock', sent: [] });
    expect(calls).toEqual([]);
    for (const vercelEnv of ['production', undefined]) {
      setEnv(vercelEnv, undefined);
      const r = await utils.syncMetaLeadStagesForRow(row, {});
      expect(r && r.skipped).not.toBe('preview_send_lock');
    }
  });

  it('preview: a Calendly booking for an unlisted invitee is refused; reads and listed invitees pass', async () => {
    setEnv('preview', LIST);
    const blocked = await utils.calendlyApiFetch('/invitees', { method: 'POST', body: { invitee: { email: REAL } } });
    expect(blocked).toEqual({ ok: false, status: 0, data: null, raw: 'blocked_by_preview_send_lock' });
    expect(calls).toEqual([]);
    expect((await utils.calendlyApiFetch('/users/me')).ok).toBe(true);
    expect((await utils.calendlyApiFetch('/invitees', { method: 'POST', body: { invitee: { email: OWNER } } })).ok).toBe(true);
    expect(calls.length).toBe(2);
    setEnv('preview', undefined);
    expect((await utils.calendlyApiFetch('/invitees', { method: 'POST', body: { invitee: { email: OWNER } } })).ok).toBe(false);
    expect(calls.length).toBe(2);
  });
  it.each(NOT_PREVIEW)('%s: Calendly bookings go out as before', async (_label, vercelEnv) => {
    setEnv(vercelEnv, undefined);
    expect((await utils.calendlyApiFetch('/invitees', { method: 'POST', body: { invitee: { email: REAL } } })).ok).toBe(true);
    expect(callsTo('/invitees').length).toBe(1);
  });
});

// ── 7. Health field ──────────────────────────────────────────────────────────
describe('GET /api/health — previewSendLock appears on a preview only', () => {
  const BASE_KEYS = ['ok', 'status', 'environment', 'authDisabled', 'serverTime', 'build', 'commit', 'branch'];

  it.each(NOT_PREVIEW)('%s: exactly the fields it has always had, in the same order', async (_label, vercelEnv) => {
    for (const list of [undefined, LIST]) {
      setEnv(vercelEnv, list);
      const r = await getJson('/api/health');
      expect(r.status).toBe(200);
      expect(Object.keys(r.body)).toEqual(BASE_KEYS);
      expect(r.text).not.toContain('previewSendLock');
    }
  });
  it('preview: reports block_all with no list and allowlist with one', async () => {
    setEnv('preview', undefined);
    let r = await getJson('/api/health');
    expect(Object.keys(r.body)).toEqual(BASE_KEYS.concat(['previewSendLock']));
    expect(r.body.previewSendLock).toBe('block_all');
    setEnv('preview', LIST);
    r = await getJson('/api/health');
    expect(r.body.previewSendLock).toBe('allowlist');
    expect(r.text).not.toContain(OWNER); // the list itself is never exposed
  });
});

// ── 8. Wiring pins (source) ──────────────────────────────────────────────────
describe('server.js wiring', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  it('reads the lock at call time, never from a module-level constant', () => {
    expect(src).toContain('function currentSendLock() { return previewSendLock.resolveSendLock(process.env); }');
    expect(src).not.toMatch(/^(const|let|var) \w+ = (currentSendLock\(\)|previewSendLock\.resolveSendLock\()/m);
  });
  it('logs the mode at startup on a preview', () => {
    expect(src).toContain("console.warn('[preview-send-lock] ' + previewSendLock.describeSendLock(bootLock));");
  });
  it('there is still exactly one Gmail send and it sits behind the lock', () => {
    expect(src.split('.users.messages.send(').length - 1).toBe(1);
    const fn = src.slice(src.indexOf('async function sendGmailEmail('), src.indexOf('.users.messages.send('));
    expect(fn).toContain('previewSendLock.filterEmailRecipients(currentSendLock()');
  });
  it('no raw fetch to the DoubleTick assign / tags endpoints sits outside a guarded function', () => {
    expect(src.split("fetch(DOUBLETICK_BASE_URL + '/team-member/assign'").length - 1).toBe(1);
    expect(src.split("fetch(DOUBLETICK_BASE_URL + '/customer/assign-tags-custom-fields'").length - 1).toBe(1);
    expect(src.split('previewSendLock.blocksAccountWrites(currentSendLock())').length - 1).toBe(2);
  });
  it('every calendar write is built with a lock-decided sendUpdates', () => {
    expect(src.split('gcalLib.buildEventInsert(').length - 1).toBe(1);
    expect(src.split('gcalLib.buildEventDelete(').length - 1).toBe(1);
    expect(src).toContain('sendUpdates: gcalLockPlan.sendUpdates');
    expect(src).toContain('sendUpdates: previewSendLock.calendarChangeSendUpdates(currentSendLock())');
  });
});
