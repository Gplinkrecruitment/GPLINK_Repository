// Post-call WhatsApp note (owner rule 2026-11-01): after a consultation the
// doctor VERIFIABLY attended, one personal note asking them to create their
// account and upload a CV — template gp_link_consult_post_call_onboard_v3,
// placeholders [first name, prefilled signup link]. "Completed" is not
// attendance (Zoom sends meeting.ended for a host-only meeting too), so the
// verdict comes from Zoom's past-meeting participant list, and the same
// verdict now gates the "great speaking with you" email drip.
//
// Boots the real server in LOCAL-JSON mode over HTTP (same harness as
// tests/consult-whatsapp-followups.test.js) with stub Resend, stub DoubleTick
// and a stub ZOOM (token + past_meetings) wired via env BEFORE import.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const waLib = requireCjs('../lib/consult-whatsapp.js');
const leadLib = requireCjs('../lib/consult-lead.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-postcall-${RUN_ID}.json`;
let server;
let addrPort;
let testUtils;
let resendServer, resendPort;
let dtServer, dtPort;
let zoomServer, zoomPort;
const resendCaptured = [];
const dtCaptured = [];
const zoomCaptured = [];

const CRON = '/api/cron/consult-nudge';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const H = 3600 * 1000;
const D = 24 * H;
const M = 60 * 1000;
const KIND = 'post_call_onboard';
const TEMPLATE = 'gp_link_consult_post_call_onboard_v3';

// Per-meeting fixtures the stub Zoom serves. Set before each verify call.
const zoomParticipants = {};  // meetingId -> array | 'fail'
const zoomHosts = {};         // meetingId -> { user_email, user_name, host_id } | undefined
const HOST = { user_email: 'hello@mygplink.com.au', user_name: 'GP Link', host_id: 'HOST-UUID' };
const hostOnly = [{ id: 'HOST-UUID', user_id: '1', name: 'GP Link', user_email: 'hello@mygplink.com.au', duration: 780 }];
const hostAndDoctor = hostOnly.concat([{ id: '', user_id: '2', name: 'Nandan Jha', user_email: '', duration: 900 }]);

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
// A booked lead whose consultation ended `completedAgoMs` ago. The booking-time
// email (step 0) is already on record so the only email that can fall due is
// the post-call one (step 1), which anchors on the call having happened.
function seedAttendedLead(completedAgoMs, extraConsult, overrides) {
  leadSeq++;
  const completedAt = new Date(Date.now() - completedAgoMs).toISOString();
  const bookedAt = new Date(Date.now() - completedAgoMs - D).toISOString();
  const consult = Object.assign({
    token: 'TOK' + leadSeq, qualified: true, is_gp: true, country: 'uk',
    call_booked: true, call_booked_at: bookedAt, call_at: new Date(Date.now() - completedAgoMs - 30 * M).toISOString(),
    call_completed_at: completedAt,
    wa: { call_booked: { sent_at: bookedAt } },
    nudges: [{ seq: 'booked_no_signup', step: 0, email: 'sent', sent_at: bookedAt }]
  }, extraConsult || {});
  return Object.assign({
    id: 'lead-pc-' + leadSeq, created_at: new Date(Date.now() - completedAgoMs - 2 * D).toISOString(), kind: 'gp',
    name: 'Aisha Khan', email: 'aisha' + leadSeq + '@example.co.uk', status: 'new', phone: '+44 7700 900123',
    metadata: { source: 'meta_lead_ad', consult }
  }, overrides || {});
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

function startZoomStub() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        zoomCaptured.push({ path: req.url, method: req.method });
        const url = new URL(req.url, 'http://x');
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (url.pathname === '/oauth/token') return send(200, { access_token: 'zoom-test-token', expires_in: 3600 });
        const m = url.pathname.match(/^\/v2\/past_meetings\/([^/]+)(\/participants)?$/);
        if (!m) return send(404, { code: 3001, message: 'not found' });
        const id = decodeURIComponent(m[1]);
        if (m[2]) {
          const fixture = zoomParticipants[id];
          if (fixture === 'fail') return send(500, { message: 'boom' });
          if (fixture === undefined) return send(404, { code: 3001, message: 'Meeting does not exist' });
          return send(200, { page_count: 1, total_records: fixture.length, participants: fixture });
        }
        const host = zoomHosts[id];
        if (!host) return send(404, { code: 3001, message: 'Meeting does not exist' });
        return send(200, Object.assign({ id: id, participants_count: 2 }, host));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

beforeAll(async () => {
  resendServer = await startCaptureServer(resendCaptured, { id: 'stub' });
  resendPort = resendServer.address().port;
  dtServer = await startCaptureServer(dtCaptured, { messages: [{ id: 'wa-stub', status: 'SENT' }] });
  dtPort = dtServer.address().port;
  zoomServer = await startZoomStub();
  zoomPort = zoomServer.address().port;

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-consult-postcall-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendPort + '/emails';
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtPort;
  // Zoom: configured (so the attendance check runs) and pointed at the stub.
  process.env.ZOOM_CLIENT_ID = 'zoom-test-client';
  process.env.ZOOM_CLIENT_SECRET = 'zoom-test-secret';
  process.env.ZOOM_ACCOUNT_ID = 'zoom-test-account';
  process.env.ZOOM_OAUTH_TOKEN_URL = 'http://127.0.0.1:' + zoomPort + '/oauth/token';
  process.env.ZOOM_API_BASE_URL = 'http://127.0.0.1:' + zoomPort + '/v2';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (resendServer) await new Promise((resolve) => resendServer.close(resolve));
  if (dtServer) await new Promise((resolve) => dtServer.close(resolve));
  if (zoomServer) await new Promise((resolve) => zoomServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

function waSends(templateName) {
  return dtCaptured
    .filter((c) => c.path === '/whatsapp/message/template')
    .filter((c) => !templateName || (c.body && c.body.messages && c.body.messages[0].content.templateName === templateName));
}
function emailsWithSubject(fragment) {
  return resendCaptured.filter((c) => c.body && String(c.body.subject || '').indexOf(fragment) !== -1);
}
function dbRow(id) {
  return (readDb().siteEnquiries || []).find((r) => r.id === id);
}

describe('lib: attendance classification and the drip anchor', () => {
  it('classifyConsultAttendance: the host alone is a no-show; anyone else is the doctor', () => {
    const host = { emails: ['hello@mygplink.com.au'], name: 'GP Link', id: 'HOST-UUID' };
    expect(leadLib.classifyConsultAttendance([], host)).toBe('no_show');
    expect(leadLib.classifyConsultAttendance(hostOnly, host)).toBe('no_show');
    expect(leadLib.classifyConsultAttendance(hostAndDoctor, host)).toBe('attended');
    // Host excluded by Zoom user id even when the email is missing…
    expect(leadLib.classifyConsultAttendance([{ id: 'HOST-UUID', name: 'Someone', user_email: '' }], host)).toBe('no_show');
    // …by display name when they joined without a linked email…
    expect(leadLib.classifyConsultAttendance([{ id: '', name: 'GP Link', user_email: '' }], host)).toBe('no_show');
    // …but a guest who merely shares the host's display name AND has their own email counts.
    expect(leadLib.classifyConsultAttendance([{ id: '', name: 'GP Link', user_email: 'dr@example.com' }], host)).toBe('attended');
    // Owner's other known accounts are hosts too; case-insensitive.
    expect(leadLib.classifyConsultAttendance([{ name: 'K', user_email: 'Hello@MyGPLink.com.au' }], host)).toBe('no_show');
    // The host's phone or tablet, joined without a login, carries the host's name — still the host…
    const named = { emails: ['hello@mygplink.com.au'], name: 'Khaleed Mahmoud', id: 'HOST-UUID' };
    expect(leadLib.classifyConsultAttendance([{ id: 'HOST-UUID', name: 'Khaleed Mahmoud', user_email: 'hello@mygplink.com.au' }, { id: '', name: "Khaleed's iPad", user_email: '' }], named)).toBe('no_show');
    // …while a doctor who shares a name word but joined with their own account counts.
    expect(leadLib.classifyConsultAttendance([{ id: '', name: 'Dr Khaleed Rahman', user_email: 'kr@example.com' }], named)).toBe('attended');
    // A participant Zoom says was in the room for 0 seconds never joined.
    expect(leadLib.classifyConsultAttendance(hostOnly.concat([{ id: '', name: 'Nandan Jha', user_email: '', duration: 0 }]), host)).toBe('no_show');
    // No host info at all ⇒ the host counts as a participant; callers always
    // supply at least the configured owner addresses.
    expect(leadLib.classifyConsultAttendance(hostOnly, {})).toBe('attended');
    expect(leadLib.classifyConsultAttendance(null, host)).toBe('no_show');
  });

  it('consultCallCompletedForDripMs: verified attendance anchors, a host-only call never does, older calls are grandfathered', () => {
    const recent = new Date(leadLib.CONSULT_ATTENDANCE_GATE_SINCE_MS + D).toISOString();
    const older = new Date(leadLib.CONSULT_ATTENDANCE_GATE_SINCE_MS - D).toISOString();
    expect(leadLib.consultCallCompletedForDripMs({ call_completed_at: recent, call_attended: true })).toBe(Date.parse(recent));
    expect(leadLib.consultCallCompletedForDripMs({ call_completed_at: recent, call_attended: false })).toBeNaN();
    expect(leadLib.consultCallCompletedForDripMs({ call_completed_at: recent })).toBeNaN(); // not verified yet ⇒ defer
    expect(leadLib.consultCallCompletedForDripMs({ call_completed_at: older })).toBe(Date.parse(older)); // grandfathered
    expect(leadLib.consultCallCompletedForDripMs({ call_completed_at: older, call_attended: false })).toBeNaN(); // an explicit verdict still wins
    expect(leadLib.consultCallCompletedForDripMs({})).toBeNaN();
    // nextConsultNudge honours it: a verified no-show has nothing "after your call" due.
    const base = { call_booked: true, call_booked_at: older, nudges: [{ seq: 'booked_no_signup', step: 0, sent_at: older }] };
    const now = Date.parse(recent) + 5 * M;
    expect(leadLib.nextConsultNudge({ consult: Object.assign({ call_completed_at: recent, call_attended: false }, base), createdAtMs: Date.parse(older), callAtMs: Date.parse(recent) - 30 * M, callCompletedMs: NaN, nowMs: now })).toBe(null);
    expect(leadLib.nextConsultNudge({ consult: Object.assign({ call_completed_at: recent, call_attended: true }, base), createdAtMs: Date.parse(older), callAtMs: Date.parse(recent) - 30 * M, callCompletedMs: Date.parse(recent), nowMs: now })).toEqual({ seq: 'booked_no_signup', step: 1 });
  });
});

describe('lib: the post-call WhatsApp kind', () => {
  it('template, shape and eligibility', () => {
    expect(waLib.CONSULT_WA_TEMPLATES.post_call_onboard.templateName).toBe(TEMPLATE);
    const msg = waLib.buildConsultWaMessage(KIND, { name: 'Nandan Jha', signupUrl: 'https://x/pages/signin?signup=1' });
    expect(msg.templateName).toBe(TEMPLATE);
    expect(msg.placeholders).toEqual(['Nandan', 'https://x/pages/signin?signup=1']);
    expect(waLib.buildConsultWaMessage(KIND, { name: 'Nandan Jha' })).toBe(null); // no link ⇒ no message
    const V = { call_attendance_source: waLib.ATTENDANCE_SOURCE_VERIFIED };
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true }, V))).toBe(true);
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, stopped: 'replied' }, V))).toBe(true);
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, stopped: 'exhausted' }, V))).toBe(true);
    // Attendance must come from a real participant read — a fallback verdict is not evidence.
    expect(waLib.consultWaEligible(KIND, { call_booked: true, call_attended: true })).toBe(false);
    expect(waLib.consultWaEligible(KIND, { call_booked: true, call_attended: true, call_attendance_source: 'unverifiable' })).toBe(false);
    expect(waLib.consultWaEligible(KIND, { call_booked: true, call_attended: true, call_attendance_source: 'zoom_not_configured' })).toBe(false);
    expect(waLib.consultWaEligible(KIND, { call_booked: true })).toBe(false);                       // not verified
    expect(waLib.consultWaEligible(KIND, { call_booked: true, call_attended: false })).toBe(false); // host-only call
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, stopped: 'signed_up' }, V))).toBe(false);
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, stopped: 'unsubscribed' }, V))).toBe(false);
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, screened_out: true }, V))).toBe(false);
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, wa: { post_call_onboard: { sent_at: 'x' } } }, V))).toBe(false);
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, wa: { post_call_onboard: { skipped: 'owner_excluded' } } }, V))).toBe(false);
    expect(waLib.consultWaEligible(KIND, Object.assign({ call_booked: true, call_attended: true, wa_skipped: { post_call_onboard: { reason: 'not_attended' } } }, V))).toBe(false);
  });

  it('postCallWaDecision: waits 10 minutes, never past 48 hours, only for verified attendance, never for an account', () => {
    const now = Date.now();
    const at = (ago) => new Date(now - ago).toISOString();
    const dec = (consult, userExists) => waLib.postCallWaDecision({ consult: Object.assign(consult.call_attended === true && !('call_attendance_source' in consult) ? { call_attendance_source: 'zoom_participants' } : {}, consult), nowMs: now, userExists });
    expect(waLib.POST_CALL_WA_DELAY_MS).toBe(10 * M);
    expect(waLib.POST_CALL_WA_WINDOW_MS).toBe(48 * H);
    expect(dec({ call_booked: true })).toEqual({ action: 'skip' });                                               // no call yet
    expect(dec({ call_booked: true, call_completed_at: at(15 * M) })).toEqual({ action: 'skip' });                 // not verified ⇒ wait, never guess
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: false })).toEqual({ action: 'mark', value: 'not_attended' });
    expect(dec({ call_booked: true, call_completed_at: at(5 * M), call_attended: true })).toEqual({ action: 'skip' }); // let it breathe
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true })).toEqual({ action: 'check_account' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true }, false)).toEqual({ action: 'send' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true }, true)).toEqual({ action: 'mark', value: 'signed_up' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, stopped: 'signed_up' })).toEqual({ action: 'mark', value: 'signed_up' });
    expect(dec({ call_booked: true, call_completed_at: at(3 * D), call_attended: true })).toEqual({ action: 'mark', value: 'window_passed' });
    expect(dec({ call_booked: true, call_completed_at: 'garbage', call_attended: true })).toEqual({ action: 'mark', value: 'no_completion_time' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, wa: { post_call_onboard: { sent_at: 'x' } } })).toEqual({ action: 'skip' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, wa_skipped: { post_call_onboard: { reason: 'x' } } })).toEqual({ action: 'skip' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, stopped: 'unsubscribed' })).toEqual({ action: 'skip' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, screened_out: true })).toEqual({ action: 'skip' });
    // A fallback verdict keeps the email drip alive but earns no WhatsApp — and says why.
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, call_attendance_source: 'unverifiable' })).toEqual({ action: 'mark', value: 'attendance_unverifiable' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, call_attendance_source: 'zoom_not_configured' })).toEqual({ action: 'mark', value: 'attendance_zoom_not_configured' });
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, call_attendance_source: undefined })).toEqual({ action: 'mark', value: 'attendance_unknown_source' });
    // A doctor who replied to an earlier note, then booked and turned up, still gets it.
    expect(dec({ call_booked: true, call_completed_at: at(15 * M), call_attended: true, stopped: 'replied' }, false)).toEqual({ action: 'send' });
  });
});

describe('server: verifying attendance against Zoom', () => {
  it('host-only participant list ⇒ no_show; host + doctor ⇒ attended; host resolved from the past-meeting record', async () => {
    zoomParticipants.M1 = hostOnly; zoomHosts.M1 = HOST;
    zoomParticipants.M2 = hostAndDoctor; zoomHosts.M2 = HOST;
    const tenMinAgo = new Date(Date.now() - 10 * M).toISOString();
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M1' }, tenMinAgo)).toBe('no_show');
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M2' }, tenMinAgo)).toBe('attended');
    const host = await testUtils.fetchZoomPastMeetingHost('M1');
    expect(host.emails).toContain('hello@mygplink.com.au');
    expect(host.name).toBe('GP Link');
    expect(host.id).toBe('HOST-UUID');
  });

  it('cannot tell ⇒ null (Zoom error, no meeting id, or an empty list before Zoom has settled)', async () => {
    zoomParticipants.M3 = 'fail';
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M3' }, new Date(Date.now() - 10 * M).toISOString())).toBe(null);
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: '' }, new Date().toISOString())).toBe(null);
    expect(await testUtils.verifyConsultCallAttendance(null, new Date().toISOString())).toBe(null);
    // Empty list one minute after the call ended: Zoom may not have written the
    // record yet — defer rather than conclude.
    zoomParticipants.M4 = []; zoomHosts.M4 = HOST;
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M4' }, new Date(Date.now() - 1 * M).toISOString())).toBe(null);
    // A host-only list that early is equally unfinished — only a positive verdict is final inside the window.
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M1' }, new Date(Date.now() - 1 * M).toISOString())).toBe(null);
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M2' }, new Date(Date.now() - 1 * M).toISOString())).toBe('attended');
    // The same empty list ten minutes later is a verdict.
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M4' }, new Date(Date.now() - 10 * M).toISOString())).toBe('no_show');
    // A missing past-meeting record (404) means nobody joined — also a verdict once settled.
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'NEVER-HAPPENED' }, new Date(Date.now() - 10 * M).toISOString())).toBe('no_show');
  });

  it('a failed host lookup still excludes the configured owner address, so the host is never counted as the doctor', async () => {
    zoomParticipants.M5 = hostOnly; // no zoomHosts.M5 ⇒ 404 on the details call
    expect(await testUtils.verifyConsultCallAttendance({ zoom_meeting_id: 'M5' }, new Date(Date.now() - 10 * M).toISOString())).toBe('no_show');
  });
});

describe('webhook: afterConsultCallCompleted verifies attendance before the instant email', () => {
  const callRecordFor = (lead, meetingId) => ({
    id: 'call-' + lead.id, meeting_kind: 'consultation', host_kind: 'ceo', zoom_meeting_id: meetingId,
    invitee_email: lead.email, scheduled_at: lead.metadata.consult.call_at, invitee_notes: ''
  });

  it('a doctor who joined gets the email at once and is stamped verified; a host-only meeting gets nothing and is stamped not attended', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    zoomParticipants.M2 = hostAndDoctor; zoomHosts.M2 = HOST;
    zoomParticipants.M1 = hostOnly; zoomHosts.M1 = HOST;
    const joined = seedAttendedLead(12 * M, { call_completed_at: undefined });
    const alone = seedAttendedLead(12 * M, { call_completed_at: undefined });
    testUtils.__seedSiteEnquiriesForTest([joined, alone]);
    const tenMinAgo = new Date(Date.now() - 10 * M).toISOString();
    const r1 = await testUtils.afterConsultCallCompleted(callRecordFor(joined, 'M2'), tenMinAgo);
    expect(r1.outcome).toBe('sent');
    expect(dbRow(joined.id).metadata.consult).toMatchObject({ call_attended: true, call_attendance_source: 'zoom_participants', call_completed_at: tenMinAgo });
    const r2 = await testUtils.afterConsultCallCompleted(callRecordFor(alone, 'M1'), tenMinAgo);
    expect(r2.skipped).toBe('not_attended');
    expect(dbRow(alone.id).metadata.consult).toMatchObject({ call_attended: false, call_attendance_source: 'zoom_participants' });
    expect(emailsWithSubject('Great speaking with you').length).toBe(1);
  });

  it('seconds after a host-only meeting.ended the verdict is deferred, not written', async () => {
    resendCaptured.length = 0;
    zoomParticipants.M1 = hostOnly; zoomHosts.M1 = HOST;
    const lead = seedAttendedLead(1 * M, { call_completed_at: undefined });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const r = await testUtils.afterConsultCallCompleted(callRecordFor(lead, 'M1'), new Date().toISOString());
    expect(r.skipped).toBe('attendance_unknown');
    expect(dbRow(lead.id).metadata.consult.call_attended).toBeUndefined();
    expect(dbRow(lead.id).metadata.consult.call_completed_at).toEqual(expect.any(String)); // completion itself is recorded
    expect(resendCaptured.length).toBe(0);
  });

  it('a late-joining doctor reopens a no-show: the second meeting.ended upgrades the verdict and un-skips the WhatsApp', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    zoomParticipants.M2 = hostAndDoctor; zoomHosts.M2 = HOST;
    const lead = seedAttendedLead(40 * M, {
      call_attended: false, call_attendance_source: 'zoom_participants',
      wa_skipped: { post_call_onboard: { reason: 'not_attended', at: 'x' } }
    });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const ended = new Date(Date.now() - 10 * M).toISOString();
    const r = await testUtils.afterConsultCallCompleted(callRecordFor(lead, 'M2'), ended);
    expect(r.outcome).toBe('sent');
    const c = dbRow(lead.id).metadata.consult;
    expect(c.call_attended).toBe(true);
    expect(c.wa_skipped.post_call_onboard).toBeUndefined();
    expect(emailsWithSubject('Great speaking with you').length).toBe(1);
    // The cron now sends the WhatsApp (the first completion was 40 min ago; the lead keeps its original completion time).
    await get(CRON, AUTH);
    expect(waSends(TEMPLATE).length).toBe(1);
  });

  it('a no-show that stays a no-show on the second meeting.ended is left alone', async () => {
    resendCaptured.length = 0;
    zoomParticipants.M1 = hostOnly; zoomHosts.M1 = HOST;
    const lead = seedAttendedLead(40 * M, { call_attended: false, call_attendance_source: 'zoom_participants' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const r = await testUtils.afterConsultCallCompleted(callRecordFor(lead, 'M1'), new Date(Date.now() - 10 * M).toISOString());
    expect(r.skipped).toBe('not_attended');
    expect(dbRow(lead.id).metadata.consult.call_attended).toBe(false);
    expect(resendCaptured.length).toBe(0);
  });
});

describe('cron: the post-call WhatsApp pass', () => {
  it('sends the note once, 10+ minutes after a verified-attended call, with the prefilled signup link', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedAttendedLead(15 * M, { call_attended: true, call_attendance_source: 'zoom_participants' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(res.json.postCallWa).toBe(1);
    const sends = waSends(TEMPLATE);
    expect(sends.length).toBe(1);
    const msg = sends[0].body.messages[0];
    expect(msg.to).toBe('+447700900123');
    expect(msg.from).toBe('61494391968');
    expect(msg.content.templateData.body.placeholders[0]).toBe('Aisha');
    expect(msg.content.templateData.body.placeholders[1]).toBe('https://app.mygplink.com.au/pages/signin?signup=1&email=' + encodeURIComponent(lead.email) + '&ref=wa_postcall');
    expect(dbRow(lead.id).metadata.consult.wa.post_call_onboard.sent_at).toEqual(expect.any(String));
    // The post-call EMAIL (step 1) also went — attendance is verified.
    expect(emailsWithSubject('Great speaking with you').length).toBe(1);
    // Rerun: nothing more.
    await get(CRON, AUTH);
    expect(waSends(TEMPLATE).length).toBe(1);
    expect(emailsWithSubject('Great speaking with you').length).toBe(1);
  });

  it('waits while the call is less than 10 minutes old, and while attendance is not yet verified', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const fresh = seedAttendedLead(4 * M, { call_attended: true, call_attendance_source: 'zoom_participants' });
    const unverified = seedAttendedLead(30 * M, {}); // no call_attended; local-JSON mode has no scheduled_calls to verify against
    testUtils.__seedSiteEnquiriesForTest([fresh, unverified]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(waSends(TEMPLATE).length).toBe(0);
    // The fresh one is just waiting; the unverified one has not been judged — neither is ruled out.
    expect(dbRow(fresh.id).metadata.consult.wa_skipped).toBeUndefined();
    expect(dbRow(unverified.id).metadata.consult.wa_skipped).toBeUndefined();
    expect(dbRow(unverified.id).metadata.consult.call_attended).toBeUndefined();
    // And the unverified lead's "great speaking with you" email is DEFERRED, not sent.
    expect(emailsWithSubject('Great speaking with you').length).toBe(1); // only the fresh, verified lead's
  });

  it('a host-only call gets neither the WhatsApp nor the post-call email, and is ruled out for good', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const noShow = seedAttendedLead(20 * M, { call_attended: false, call_attendance_source: 'zoom_participants' });
    testUtils.__seedSiteEnquiriesForTest([noShow]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(waSends(TEMPLATE).length).toBe(0);
    expect(emailsWithSubject('Great speaking with you').length).toBe(0);
    expect(dbRow(noShow.id).metadata.consult.wa_skipped.post_call_onboard.reason).toBe('not_attended');
    await get(CRON, AUTH);
    expect(waSends(TEMPLATE).length).toBe(0);
  });

  it('never asks someone who already has an account to create one', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedAttendedLead(15 * M, { call_attended: true, call_attendance_source: 'zoom_participants' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    testUtils.__seedUserForTest(lead.email);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(waSends(TEMPLATE).length).toBe(0);
    const row = dbRow(lead.id);
    expect(row.metadata.consult.stopped).toBe('signed_up');
    expect(row.metadata.consult.wa_skipped.post_call_onboard.reason).toBe('signed_up');
  });

  it('a lead whose email bounced gets the signup page without the dead address prefilled', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedAttendedLead(15 * M, { call_attended: true, call_attendance_source: 'zoom_participants', email_bounced: true });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await get(CRON, AUTH);
    const sends = waSends(TEMPLATE);
    expect(sends.length).toBe(1);
    expect(sends[0].body.messages[0].content.templateData.body.placeholders[1]).toBe('https://app.mygplink.com.au/pages/signin?signup=1&ref=wa_postcall');
  });

  it('a stale completion (older than 48h) is marked window_passed, not messaged', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const stale = seedAttendedLead(3 * D, { call_attended: true, call_attendance_source: 'zoom_participants', nudges: [
      { seq: 'booked_no_signup', step: 0, email: 'sent', sent_at: new Date(Date.now() - 4 * D).toISOString() },
      { seq: 'booked_no_signup', step: 1, email: 'sent', sent_at: new Date(Date.now() - 3 * D).toISOString() }
    ] });
    testUtils.__seedSiteEnquiriesForTest([stale]);
    await get(CRON, AUTH);
    expect(waSends(TEMPLATE).length).toBe(0);
    expect(dbRow(stale.id).metadata.consult.wa_skipped.post_call_onboard.reason).toBe('window_passed');
  });

  it('a lead with no phone is ruled out instead of re-examined every run', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedAttendedLead(15 * M, { call_attended: true, call_attendance_source: 'zoom_participants' }, { phone: '' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await get(CRON, AUTH);
    expect(waSends(TEMPLATE).length).toBe(0);
    expect(dbRow(lead.id).metadata.consult.wa_skipped.post_call_onboard.reason).toBe('no_phone');
  });

  it('a doctor who replied to an earlier note (stopped:replied), then booked and attended, still gets the note', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const lead = seedAttendedLead(15 * M, { call_attended: true, call_attendance_source: 'zoom_participants', stopped: 'replied' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await get(CRON, AUTH);
    expect(waSends(TEMPLATE).length).toBe(1);
  });

  it('a consultation completed before the attendance gate keeps its email drip without a verdict (grandfathered)', async () => {
    resendCaptured.length = 0; dtCaptured.length = 0;
    const ago = Date.now() - (leadLib.CONSULT_ATTENDANCE_GATE_SINCE_MS - D);
    const old = seedAttendedLead(ago, {});
    testUtils.__seedSiteEnquiriesForTest([old]);
    await get(CRON, AUTH);
    expect(emailsWithSubject('Great speaking with you').length).toBe(1);
    expect(waSends(TEMPLATE).length).toBe(0); // the WhatsApp has its own 48h window
  });
});
