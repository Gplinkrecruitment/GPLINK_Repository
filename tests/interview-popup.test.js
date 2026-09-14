// Owner 2026-09-07: "when the practice accepts and gives interview times then
// there should be a full page that shows the available times and has the gp
// choose a time for the interview or a small 'I'll choose later' that closes
// the page. it should be similar to the congratulations page for when we
// match a GP. also ensure the CTA changes accordingly."
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const P = require(path.join(process.cwd(), 'js', 'interview-popup.js'));

describe('interview popup — pure rules', () => {
  const NOW = Date.parse('2026-09-07T10:00:00Z');
  const iv = (over) => Object.assign({ applicationId: 'a1', practiceName: 'Sandbox Coastal Medical Centre', invitedAt: '2026-09-06T00:00:00Z', dismissedAt: null }, over);

  it('shows the newest pending interview and nothing for a locked / empty / failed response', () => {
    expect(P.pickPendingInterview(null, NOW)).toBeNull();
    expect(P.pickPendingInterview({ ok: true, locked: true, interviews: [iv()] }, NOW)).toBeNull();
    expect(P.pickPendingInterview({ ok: true, interviews: [] }, NOW)).toBeNull();
    const picked = P.pickPendingInterview({ ok: true, interviews: [iv({ applicationId: 'old', invitedAt: '2026-09-01T00:00:00Z' }), iv({ applicationId: 'new', invitedAt: '2026-09-06T00:00:00Z' })] }, NOW);
    expect(picked.applicationId).toBe('new');
  });

  it('"I\'ll choose later" hides it for 24 hours, then it comes back while unbooked', () => {
    expect(P.DISMISS_HOURS).toBe(24);
    expect(P.pickPendingInterview({ ok: true, interviews: [iv({ dismissedAt: '2026-09-07T09:00:00Z' })] }, NOW)).toBeNull();
    expect(P.pickPendingInterview({ ok: true, interviews: [iv({ dismissedAt: '2026-09-05T09:00:00Z' })] }, NOW)).not.toBeNull();
    // a dismissed one never shadows a fresh one
    const r = P.pickPendingInterview({ ok: true, interviews: [iv({ applicationId: 'd', dismissedAt: '2026-09-07T09:00:00Z', invitedAt: '2026-09-07T00:00:00Z' }), iv({ applicationId: 'f' })] }, NOW);
    expect(r.applicationId).toBe('f');
  });

  it('groups slots by the doctor\'s own day, keeping order within a day', () => {
    const g = P.groupSlotsByDay([{ startUtc: '2026-09-10T00:00:00Z' }, { startUtc: '2026-09-10T02:00:00Z' }, { startUtc: '2026-09-11T00:00:00Z' }, null], (iso) => iso.slice(0, 10));
    expect(g.map((x) => x.day)).toEqual(['2026-09-10', '2026-09-11']);
    expect(g[0].slots.length).toBe(2);
  });

  it('the page speaks like the match page: badge, serif headline, practice card, times, confirm, choose later', () => {
    const html = P.buildHtml({ applicationId: 'a1', practiceName: 'Sandbox Coastal Medical Centre', jobTitle: 'General Practitioner', locationCity: 'Merewether', locationState: 'NSW', website: 'https://coastal.example', headerImageUrl: 'javascript:alert(1)' }, { lastName: 'Miller' });
    expect(html).toContain('Interview invitation');
    expect(html).toContain('to meet you, Dr Miller');
    expect(html).toContain('<b>Sandbox Coastal Medical Centre</b> has confirmed their availability');
    expect(html).toContain('30 minutes on Zoom');
    expect(html).toContain('data-gpip-days');
    expect(html).toContain('data-gpip-confirm disabled>Confirm interview time');
    expect(html).toContain('data-gpip-later>I’ll choose later');
    expect(html).not.toContain('javascript:'); // unsafe image url dropped
    expect(html).toContain('https://coastal.example');
    const booked = P.buildBookedHtml({ practiceName: 'Sandbox Coastal Medical Centre' }, { scheduledAt: '2026-09-10T02:00:00Z' });
    expect(booked).toContain('Interview booked');
    expect(booked).toContain('data-gpip-done>Done');
  });
});

describe('wiring', () => {
  it('the shell loads it after the match popup and the service worker precaches it', () => {
    const shell = read('pages/app-shell.html');
    expect(shell.indexOf('/js/interview-popup.js?v=')).toBeGreaterThan(shell.indexOf('/js/match-popup.js?v='));
    const v = shell.match(/\/js\/interview-popup\.js\?v=([0-9a-z]+)/)[1];
    expect(read('sw.js')).toContain('"/js/interview-popup.js?v=' + v + '"');
    expect(read('js/match-popup.js')).toContain('window.gpLaunchLoopingConfetti = launchLoopingConfetti;');
  });
  it('server: pending-interviews feed and the "choose later" dismissal, both behind the GP session', () => {
    const s = read('server.js');
    const a = s.indexOf("if (pathname === '/api/career/interviews/pending' && req.method === 'GET') {");
    expect(a).toBeGreaterThan(0);
    const feed = s.slice(a, a + 5000);
    expect(feed).toContain('requireSession(req, res)');
    expect(feed).toContain("interviewMeetings.PRACTICE_AVAIL.RECEIVED || !!r.booking_invite_sent_at");
    expect(feed).toContain("String(ref.status || '') === 'booked') continue;");
    expect(feed).toContain('interview_popup_dismissed');
    const b = s.indexOf("if (pathname === '/api/career/interview/popup-seen' && req.method === 'POST') {");
    expect(b).toBeGreaterThan(0);
    const seen = s.slice(b, b + 2500);
    expect(seen).toContain("readUserStateForMerge(psUserId, 'interview-popup')");
    expect(seen).toContain('upsertSupabaseUserState(psUserId, psState)');
    expect(seen).toContain("String(psCtx.userId || '') !== String(psUserId)");
  });
  it('the CTA changes accordingly: card button, job-page bar, and the role payload that drives it', () => {
    const career = read('pages/career.html');
    expect(career).toContain('ctaLabel: when ? "See my interview" : (canOfferPicker ? "Choose an interview time" : "Open the timeline"),');
    const job = read('pages/job.html');
    expect(job).toContain('if (st === "interview" && role.applicationStatus.interviewBooked === false) return "interview_pick";');
    expect(job).toContain('interview_pick: "📅 Choose your interview time');
    const s = read('server.js');
    expect(s).toContain("roleClientPayload.applicationStatus.interviewBooked = ivRef ? (String(ivRef.status || '') === 'booked') : null;");
  });
});

// Owner 2026-09-08: "interview time was selected but caching then shows this"
// — the card kept offering the picker after the popup booking, because the
// shell's gp-cache served /api/career/applications from sessionStorage for
// ten minutes and nothing dropped it, and the slots endpoint happily listed
// times for an interview that was already booked.
describe('after a booking, every cached copy is dropped and the open page is told', () => {
  function fakeWindow() {
    const calls = { slotClear: [], invalidatePrefix: [], invalidate: [], session: {}, posted: [], events: [] };
    const frame = { contentWindow: { postMessage: (m, o) => calls.posted.push({ m, o }) } };
    return { calls, win: {
      gpInterviewSlotsCache: { clear: (id) => calls.slotClear.push(id) },
      gpCache: { invalidatePrefix: (p) => calls.invalidatePrefix.push(p), invalidate: (u) => calls.invalidate.push(u) },
      sessionStorage: { setItem: (k, v) => { calls.session[k] = v; } },
      document: { querySelectorAll: () => [frame, frame] },
      location: { origin: 'http://localhost:3000' },
      dispatchEvent: (ev) => calls.events.push(ev && ev.type)
    } };
  }
  it('afterBooking clears the slot cache, drops every career payload, flags the list dirty and posts to each frame', () => {
    const { calls, win } = fakeWindow();
    const detail = P.afterBooking(win, 'a1', { scheduled_at: '2026-09-12T04:00:00Z', zoom_join_url: '' });
    expect(detail).toEqual({ applicationId: 'a1', scheduledAt: '2026-09-12T04:00:00Z', zoomJoinUrl: '' });
    expect(calls.slotClear).toEqual(['a1']);
    expect(calls.invalidatePrefix).toEqual(['/api/career/']);
    expect(calls.invalidate.flat()).toEqual(expect.arrayContaining(['/api/career/applications', '/api/career/roles', '/api/state']));
    expect(calls.session.gp_career_apps_dirty).toBe('1');
    expect(calls.posted).toHaveLength(2);
    expect(calls.posted[0].o).toBe('http://localhost:3000');
    expect(calls.posted[0].m).toEqual({ type: 'gp-interview-booked', applicationId: 'a1', scheduledAt: '2026-09-12T04:00:00Z', zoomJoinUrl: '' });
    if (typeof CustomEvent !== 'undefined') expect(calls.events).toContain('gp-interview-booked');
  });
  it('a window with none of that is not an error (nothing to clear)', () => {
    expect(() => P.afterBooking({ document: null, location: null }, 'a1', null)).not.toThrow();
  });
  it('the popup uses it on confirm and when the server says the interview is already booked', () => {
    const src = read('js/interview-popup.js');
    expect(src).toContain('afterBooking(window, iv.applicationId, booked);');
    expect(src).toContain("if (res.status === 409 && res.body && res.body.error === 'already_booked') {");
    expect(src).toContain('afterBooking(window, iv.applicationId, b);');
    expect(src).not.toContain("new CustomEvent('gp-interview-booked', { detail: { applicationId: iv.applicationId } })");
  });
  it('the slots endpoint answers 409 already_booked with the confirmed time, before listing anything', () => {
    const s = read('server.js');
    const at = s.indexOf("pathname === '/api/career/interview/slots'");
    const handler = s.slice(at, s.indexOf("pathname === '/api/career/interview/book'", at));
    expect(handler).toContain('if (_interviewRowIsAlreadyBooked(ciInterviewRef)) {');
    expect(handler).toContain("error: 'already_booked',");
    expect(handler.indexOf("error: 'already_booked'")).toBeLessThan(handler.indexOf('_interviewSlotContext(ciAppId'));
    expect(s).toContain("'select=id,status,scheduled_at,zoom_join_url&application_id=eq.'");
  });
  it('the career page listens for the booking, flips the card quietly and re-reads the list from the server', () => {
    const career = read('pages/career.html');
    expect(career).toContain('if (!data || data.type !== "gp-interview-booked" || !data.applicationId) return;');
    expect(career).toContain('careerIvApplyBooking(String(data.applicationId), { scheduledAt: String(data.scheduledAt), zoomJoinUrl: data.zoomJoinUrl || "" }, { silent: true });');
    expect(career).toContain('loadRemoteApplications({ forceNetwork: true });');
    const load = (career.match(/function careerIvLoad\(appId\)[\s\S]*?\n    \}\n/) || [''])[0];
    expect(load).toContain('if (res.status === 409 && res.data && res.data.error === "already_booked") {');
    const apply = (career.match(/function careerIvApplyBooking\(appId, interview, opts\)[\s\S]*?\n    \}\n/) || [''])[0];
    expect(apply).toContain('window.gpCache.invalidatePrefix("/api/career/");');
    expect(apply).toContain('window.gpCache.invalidate(["/api/career/roles", "/api/state"]);');
    expect(apply).toContain('if (quiet) return;');
  });
  it('the job page, the application page and the secure-interview page say "already booked" instead of an error', () => {
    expect(read('pages/job.html')).toContain('} else if (res.status === 409 && data && data.error === "already_booked") {');
    expect(read('pages/job.html')).toContain('if (offerSlotsStatus === "booked") {');
    expect(read('pages/application-detail.html')).toContain("else if (status === 409 && data.error === 'already_booked') {");
    expect(read('pages/secure-interview.html')).toContain("if (status === 409 && data.error === 'already_booked') {");
  });
  it('the saved copy keeps server-backed applications across a roles refresh (no "No applications yet" flash)', () => {
    const career = read('pages/career.html');
    expect(career).toContain('.filter((job) => job && (job.id || roleIds.has(job.roleId) || job.isPlacementSecured === true))');
  });
  it('a failed applications lookup answers 503, never an empty success the page would cache and reconcile to', () => {
    const s = read('server.js');
    const at = s.indexOf("pathname === '/api/career/applications' && req.method === 'GET'");
    const handler = s.slice(at, at + 6000);
    expect(handler).toContain('if (isSupabaseDbConfigured() && !result.ok) {');
    expect(handler).toContain("sendJson(res, 503, { ok: false, message: 'Could not load your applications just now — please try again shortly.' });");
    expect(handler.indexOf('if (isSupabaseDbConfigured() && !result.ok) {')).toBeLessThan(handler.indexOf('const applications = result.ok && Array.isArray(result.data) ? result.data : [];'));
  });
  it('outbound connects get a realistic per-family attempt budget (Resend from AU needs > 250 ms)', () => {
    expect(read('server.js')).toContain("require('net').setDefaultAutoSelectFamilyAttemptTimeout(2500)");
  });
  it('a failed post-interview send rolls its stamp back with retries and shouts if it cannot', () => {
    const s = read('server.js');
    expect(s).toContain('for (var rbAttempt = 0; rbAttempt < 3 && !rolledBack; rbAttempt++) {');
    expect(s).toContain("console.error('[post-interview] could not clear post_interview_email_sent_at for application '");
    expect(s).toContain('return { ok: false, error: error, rollbackFailed: !rolledBack };');
  });
  it('every Resend send carries one Idempotency-Key across its retries, so a lost response cannot double-send', () => {
    const s = read('server.js');
    const at = s.indexOf('async function sendEmail({');
    const fn = s.slice(at, at + 12000);
    expect(fn).toContain('const idempotencyKey = crypto.randomUUID();');
    expect(fn).toContain("'Idempotency-Key': idempotencyKey");
    expect(fn.indexOf('const idempotencyKey = crypto.randomUUID();')).toBeLessThan(fn.indexOf('for (let attempt = 0; attempt < RESEND_MAX_SEND_ATTEMPTS && !delivered; attempt++) {'));
  });
  it('the popup script and the service worker moved to a new version together', () => {
    const shell = read('pages/app-shell.html');
    expect(shell).toContain('/js/interview-popup.js?v=20260910a');
    expect(read('sw.js')).toContain('"/js/interview-popup.js?v=20260910a"');
    expect(read('sw.js')).toContain('var VERSION = "20260915e"');
  });
});
