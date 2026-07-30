// Interview booking band + doctor chase (owner call 2026-07-31).
//
// Three problems shipped together here, all found from one screenshot:
//   1. A doctor could sit at Interview with times on the table and nobody
//      chasing them — the booking invite is one-shot and the reminder cron
//      only fires for interviews that are ALREADY booked.
//   2. Staff recording a practice acceptance by hand left the case with no
//      times requested and no next step (the practice's own approval screen
//      cannot do this — it validates windows first).
//   3. The kanban drag could drop a card with no job straight into Interview,
//      producing a doctor at interview stage with nothing that could book.
//
// These are source-level pins, not a booted-server test: they assert the gates
// exist and are wired the right way round. The behaviour they protect is
// destructive when wrong (unsolicited email to real doctors), so each gate is
// pinned individually rather than as one blob.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-candidates.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');

// The chase function, sliced once and shared — every gate below lives in it.
const NUDGE = srv.slice(
  srv.indexOf('async function sendInterviewBookingNudge'),
  srv.indexOf('// G6: congratulate the GP on their OWN in-app acceptance')
);

describe('The doctor booking chase', () => {
  it('exists, and is capped and spaced', () => {
    expect(NUDGE.length).toBeGreaterThan(0);
    expect(srv).toContain('var INTERVIEW_NUDGE_MAX = 3;');
    expect(srv).toContain('var INTERVIEW_NUDGE_INTERVAL_MS = 48 * 60 * 60 * 1000;');
  });

  // Each of these is a distinct way to email someone who should not be emailed.
  it('never chases a doctor who has already booked', () => {
    expect(NUDGE).toMatch(/interviewBookingIsBooked\(id\)[\s\S]{0,80}already_booked/);
  });

  it('never chases before the one-shot invite has actually gone out', () => {
    expect(NUDGE).toMatch(/booking_invite_sent_at[\s\S]{0,60}no_invite_yet/);
  });

  it('never chases past the cap', () => {
    expect(NUDGE).toMatch(/count >= INTERVIEW_NUDGE_MAX[\s\S]{0,60}cap_reached/);
  });

  it('never chases when every offered time has already passed', () => {
    // Chasing here is pointless — the practice has to re-offer, and the band
    // says so instead. Guards the "expired" state.
    expect(NUDGE).toMatch(/interviewWindowsHaveFuture\(windows\)[\s\S]{0,60}windows_expired/);
    expect(srv).toContain('function interviewWindowsHaveFuture(windows)');
  });

  it('never chases when there are no times to book at all', () => {
    expect(NUDGE).toMatch(/windows\.length[\s\S]{0,60}no_windows/);
  });

  it('respects the 48h spacing on the automatic path only', () => {
    // A human clicking "Nudge doctor" has a reason; the cron does not.
    expect(NUDGE).toMatch(/if \(!manual\)[\s\S]{0,400}too_soon/);
  });

  it('has a kill switch that still reports what it would have sent', () => {
    expect(srv).toContain('function interviewNudgeSendingEnabled()');
    expect(srv).toContain('INTERVIEW_NUDGE_ENABLED');
    expect(NUDGE).toMatch(/interviewNudgeSendingEnabled\(\)[\s\S]{0,220}sending_disabled/);
    expect(NUDGE).toContain('would_send: true');
  });

  it('stamps before sending, and rolls the stamp back if the send dies', () => {
    // Two concurrent cron runs must not both email the same doctor; a failed
    // send must not burn one of the three chances.
    expect(NUDGE.indexOf('booking_nudge_count: count + 1')).toBeLessThan(NUDGE.indexOf('sendGpNotificationEmail'));
    expect(NUDGE).toMatch(/send failed, rolling back stamp[\s\S]{0,220}booking_nudge_count: count/);
  });

  it('sends the doctor to the picker, not to a generic page', () => {
    expect(NUDGE).toContain('/pages/secure-interview?applicationId=');
  });
});

describe('The nightly chase pass', () => {
  it('rides the existing daily interview cron rather than adding one', () => {
    // Vercel Hobby allows DAILY crons only (docs/deployment-pathway.md), and
    // the 48h spacing is enforced per application anyway.
    const cron = srv.slice(srv.indexOf("pathname === '/api/cron/interview-reminders'"));
    expect(cron).toContain('sendInterviewBookingNudge(nudgeCandidates[nI].id, { manual: false })');
    expect(cron).toContain('booking_nudges_sent');
  });

  it('bounds its own query and cannot break the time-critical reminders', () => {
    const cron = srv.slice(srv.indexOf("pathname === '/api/cron/interview-reminders'"));
    expect(cron).toMatch(/booking_nudge_count=lt\.' \+ INTERVIEW_NUDGE_MAX/);
    expect(cron).toContain('&limit=200');
    // A thrown chase must never stop a 1h "your interview is soon" reminder.
    expect(cron).toMatch(/cron pass failed \(ignored\)/);
  });

  it('has the columns it counts on', () => {
    const mig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260731090000_interview_booking_nudge.sql'), 'utf8');
    expect(mig).toContain('booking_nudge_count');
    expect(mig).toContain('booking_nudge_last_at');
    // Separate from the one-shot invite stamp on purpose.
    expect(mig).not.toMatch(/alter[\s\S]*booking_invite_sent_at[\s\S]*drop/i);
  });
});

describe('Recording a practice acceptance never dead-ends', () => {
  it('asks the practice for times when the invite skipped for want of them', () => {
    const accept = srv.slice(srv.indexOf("pathname === '/api/ats/application/accept'"));
    expect(accept).toMatch(/skipped === 'no_windows'[\s\S]{0,120}requestPracticeAvailabilityForApplication/);
    expect(srv).toContain('async function requestPracticeAvailabilityForApplication');
  });

  it('will not overwrite times we already hold, or re-ask a practice we are waiting on', () => {
    const fn = srv.slice(
      srv.indexOf('async function requestPracticeAvailabilityForApplication'),
      srv.indexOf('async function atsGetDocFlagsProd')
    );
    expect(fn).toMatch(/existingWindows[\s\S]{0,120}already_have_windows/);
    expect(fn).toMatch(/'requested'[\s\S]{0,160}already_requested/);
    expect(fn).toContain("practice_availability_status: 'requested'");
  });
});

describe('A card cannot reach Interview without a job', () => {
  it('gates the kanban stage PATCH, which was the only ungated route', () => {
    const patch = srv.slice(srv.indexOf("pathname === '/api/ats/application' && req.method === 'PATCH'"));
    expect(patch).toContain("var apJobGatedStages = ['interview', 'offer', 'hired'];");
    expect(patch).toMatch(/!apGateRow\.career_role_id[\s\S]{0,200}job_required/);
  });

  it('leaves the early lanes and the exit alone', () => {
    // Closing a broken card must always work, and a shortlisted/applied card
    // with no job yet is a normal working state — so the gated list is exactly
    // these three and nothing else. Asserted on the literal, not on a window of
    // source, because the surrounding comment names the excluded stages too.
    const literal = srv.match(/var apJobGatedStages = \[[^\]]*\]/)[0];
    expect(literal).toBe("var apJobGatedStages = ['interview', 'offer', 'hired']");
    expect(literal).not.toContain('not_proceeding');
    expect(literal).not.toContain("'applied'");
    expect(literal).not.toContain("'shortlisted'");
  });
});

describe('The interview band', () => {
  it('derives who we are waiting on server-side, not in the browser', () => {
    expect(srv).toContain('function atsInterviewCardState(app, ivRow)');
    for (const state of ['waiting_practice', 'waiting_doctor', 'booked', 'past', 'expired', 'blocked']) {
      expect(srv).toContain("'" + state + "'");
    }
  });

  it('checks "booked" before "blocked", so a real booking never reads as broken', () => {
    const fn = srv.slice(srv.indexOf('function atsInterviewCardState'), srv.indexOf('function buildCareerLockAdminView'));
    expect(fn.indexOf('if (booked)')).toBeLessThan(fn.indexOf("state = 'blocked'"));
  });

  it('costs ONE bulk read for the page, never a query per row', () => {
    // Same rule the action strip follows (2026-07-29 DB-load handover).
    const list = srv.slice(srv.indexOf('var ivAppIds = []'), srv.indexOf('r.live_apps = atsCandidateLiveApps(byUser2[r.user_id], liveRoleMap, ivRowMap)'));
    expect((list.match(/supabaseDbRequest\(/g) || []).length).toBe(1);
    expect(list).toContain('meeting_kind=eq.interview&application_id=in.(');
    // and it is skipped entirely when nobody on the page is at interview
    expect(list).toContain('if (ivAppIds.length) {');
  });

  it('is rendered for interview-stage applications, alongside the submit band', () => {
    expect(js).toContain('function interviewBandHtml(a)');
    expect(js).toMatch(/isSubmitEligible\(a\)[\s\S]{0,140}interviewBandHtml\(a\)/);
  });

  it('shows the booked time in the doctor\'s timezone as well as ours', () => {
    // A 10:30 Sydney slot is 1:30am in the UK — correct on this screen, and an
    // interview the doctor was never going to attend.
    expect(js).toContain('function ivWhen(iso, doctorTz)');
    expect(js).toMatch(/timeZone: doctorTz[\s\S]{0,80}for the doctor/);
    expect(srv).toContain('doctor_tz:');
  });

  it('shows the nudge history so nobody double-chases', () => {
    expect(js).toMatch(/nudged ' \+ iv\.nudge_count \+ '×/);
    expect(js).toMatch(/iv\.nudge_count >= \(iv\.nudge_max \|\| 3\)/);
  });

  it('offers the RIGHT action per state, and never Withdraw over a live booking', () => {
    const fn = js.slice(js.indexOf('function interviewBandHtml'), js.indexOf('var STRIP_STAGE_TONE'));
    expect(fn).toMatch(/waiting_practice[\s\S]{0,260}ats-iv-request/);
    expect(fn).toMatch(/waiting_doctor[\s\S]{0,700}ats-iv-nudge/);
    expect(fn).toMatch(/state !== 'booked'[\s\S]{0,200}ats-strip-withdraw/);
  });

  it('surfaces the server\'s refusal verbatim instead of "could not send"', () => {
    // A 409 here is the server explaining why chasing is wrong right now.
    expect(js).toMatch(/nudgeDoctorToBook[\s\S]{0,600}res\.message \|\| res\.error/);
    expect(srv).toContain("cap_reached: 'Already chased '");
    expect(srv).toContain('no_windows: \'No interview times on file yet — chase the practice, not the doctor.\'');
  });

  it('gets its booking link from the server, which knows the doctor app\'s host', () => {
    expect(srv).toContain('booking_url: APP_BASE_URL');
    expect(js).toContain('data-booking-url');
  });

  it('has styles for every tone it can render', () => {
    for (const tone of ['wait-practice', 'wait-doctor', 'booked', 'overdue']) {
      expect(css).toContain('.cr-strip.iv-band.' + tone);
    }
    expect(css).toContain('.cr-who');
    expect(css).toContain('.cr-facts');
  });
});
