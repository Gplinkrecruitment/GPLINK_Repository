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
