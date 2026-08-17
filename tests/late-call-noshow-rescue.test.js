// A call that runs LATE must not be destroyed by the no-show sweep (2026-08-17)
//
// Dr Asha booked a consultation for 12:00Z. The team joined her about two hours
// late. What the system did in between:
//
//   12:00:00Z  slot starts
//   13:30:29Z  detect-no-shows judged it (30m call + 60m settle = 90m), Zoom showed
//              no participants yet, so handleScheduledCallFailure struck it:
//              status -> 'invited', the booking cleared, and she was emailed
//              "please re-book" — WHILE the call was about to happen
//   15:04:24Z  the conversation actually ended; Zoom sent meeting.ended
//              ...which matched NOTHING, because the strike had nulled the
//              zoom_meeting_id that handleZoomMeetingEnded looks up
//
// So the call was never recorded as held, no summary was captured, and the doctor
// had been told to re-book a call she had just been on.
//
// handleZoomMeetingEnded already accepts an 'invited' row on purpose ("let a
// meeting that happened after all complete its call"). The only thing defeating
// that rescue was the strike destroying the lookup key 90 minutes earlier. Two
// fixes, both pinned here:
//   1. the first strike KEEPS zoom_meeting_id / zoom_meeting_uuid
//   2. the settle window is long enough that an ordinary late start is not judged
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

describe('the first strike keeps the key that can rescue the call', () => {
  const strike = extractFn(server, 'handleScheduledCallFailure');
  // Everything from the re-invite branch down to the end of that branch.
  const reinvite = strike.slice(strike.indexOf('// First strike'), strike.indexOf('const upd = await'));

  it('does NOT null zoom_meeting_id or zoom_meeting_uuid', () => {
    // These two are the only key handleZoomMeetingEnded matches on.
    expect(reinvite).not.toMatch(/patch\.zoom_meeting_id\s*=\s*null/);
    expect(reinvite).not.toMatch(/patch\.zoom_meeting_uuid\s*=\s*null/);
  });

  it('still clears the join details, because the booking really is gone', () => {
    expect(reinvite).toMatch(/patch\.zoom_join_url\s*=\s*null/);
    expect(reinvite).toMatch(/patch\.zoom_passcode\s*=\s*null/);
  });

  it('still clears the booking itself, so nothing shows a time that no longer exists', () => {
    expect(reinvite).toMatch(/patch\.scheduled_at\s*=\s*null/);
    expect(reinvite).toMatch(/patch\.booked_at\s*=\s*null/);
    expect(reinvite).toMatch(/patch\.calendly_invitee_uri\s*=\s*null/);
  });

  it('sets the row to invited, which is a state meeting.ended will still match', () => {
    expect(reinvite).toMatch(/patch\.status\s*=\s*'invited'/);
  });
});

describe('a late meeting.ended can still complete the call', () => {
  const ended = extractFn(server, 'handleZoomMeetingEnded');

  it('looks the call up by zoom_meeting_id, which the strike no longer destroys', () => {
    expect(ended).toMatch(/zoom_meeting_id=eq\.'\s*\+\s*encodeURIComponent\(meetingId\)/);
  });

  it('accepts an invited row, not only a booked one', () => {
    expect(ended).toMatch(/status=in\.\(booked,invited,completed\)/);
  });

  it('still refuses to resurrect a row that was genuinely closed as a no-show', () => {
    // meeting.ended fires even when only the host joined, so a real no_show must
    // stay a no_show. 'no_show' is the SECOND strike (auto-close), not the first.
    expect(ended).not.toMatch(/status=in\([^)]*no_show/);
    const strike = extractFn(server, 'handleScheduledCallFailure');
    expect(strike).toMatch(/patch\.status = \(kind === 'no_show'\) \? 'no_show' : 'cancelled'/);
  });
});

describe('the no-show verdict outlasts an ordinary late start', () => {
  const cron = server.slice(server.indexOf("pathname === '/api/cron/detect-no-shows'"));
  const graceLine = /const GRACE_MIN = ([^;]+);/.exec(cron);

  it('waits materially longer than the 90 minutes that struck a live call', () => {
    expect(graceLine).toBeTruthy();
    const dflt = /\|\|\s*(\d+)/.exec(graceLine[1]);
    expect(dflt, 'GRACE_MIN needs a numeric default').toBeTruthy();
    // 30m assumed call + grace. The real case ran ~3h past the booked start.
    expect(Number(dflt[1])).toBeGreaterThanOrEqual(180);
  });

  it('is tunable without a deploy, and cannot be set to something reckless', () => {
    expect(graceLine[1]).toMatch(/process\.env\.SCHEDULED_CALL_NOSHOW_GRACE_MIN/);
    expect(graceLine[1]).toMatch(/Math\.max\(\s*\d+/);
  });

  it('the same grace is what gates the per-call check, not a second hardcoded number', () => {
    expect(cron).toMatch(/isNoShowCandidate\(call, nowMs, GRACE_MIN\)/);
  });

  it('does NOT slow the zoomless completion path down with it', () => {
    // The same query feeds the zoomless branch, which completes on "enough time
    // has passed" and owes the practice a decision email promptly. Baking the
    // settle window into the prefilter delayed every zoomless completion by two
    // hours as a side effect of widening it. Each branch gates itself instead.
    const prefilter = /const cutoffIso = new Date\(nowMs - ([^)]+)\)/.exec(cron);
    expect(prefilter, 'the prefilter must exist').toBeTruthy();
    expect(prefilter[1], 'the prefilter must not depend on GRACE_MIN').not.toMatch(/GRACE_MIN/);
    expect(cron).toMatch(/const PREFILTER_MIN = 30 \+ 15;/);
  });
});

describe('isNoShowCandidate honours the grace it is given', () => {
  const { isNoShowCandidate } = require('../server-test-helpers.js');
  const slot = Date.parse('2026-08-17T12:00:00Z');
  const call = { status: 'booked', scheduled_at: '2026-08-17T12:00:00Z', duration_minutes: 30 };

  it('would have struck Dr Asha at 90 minutes under the old window', () => {
    expect(isNoShowCandidate(call, slot + 90 * 60000 + 1000, 60)).toBe(true);
  });

  it('leaves her alone at the same moment under the new one', () => {
    expect(isNoShowCandidate(call, slot + 90 * 60000 + 1000, 180)).toBe(false);
  });

  it('still judges a genuine no-show once the wider window passes', () => {
    expect(isNoShowCandidate(call, slot + (30 + 180) * 60000 + 1000, 180)).toBe(true);
  });

  it('never judges a call that already completed', () => {
    const done = Object.assign({}, call, { completed_at: '2026-08-17T15:04:24Z' });
    expect(isNoShowCandidate(done, slot + 10 * 3600 * 1000, 180)).toBe(false);
  });
});
