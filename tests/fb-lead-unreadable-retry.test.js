// What happens to a Facebook lead whose answers we cannot read.
//
// This file exists because ONE unreadable lead produced THIRTEEN identical
// "Facebook leads are being DROPPED" emails and made a solved outage look
// ongoing for two days. Two real incidents pull in opposite directions, and
// the policy has to serve both:
//
//   2026-08-17 09:51  lead 1432788012009668 dropped — the Page token had been
//                     overwritten with a social-posting token carrying no
//                     `leads_retrieval`. The token was replaced at 12:28 and
//                     Meta's OWN retry re-delivered the same lead at 12:54.
//                     It stored itself. Nobody re-entered anything.
//                     ⇒ retries are how a real doctor gets recovered. Keep them.
//
//   2026-08-17 17:52  lead 1033387905982548 (form 1957628845192779) — a test
//                     lead deleted before our webhook could fetch it. Meta
//                     retried it 8 times over 12 hours: 1m, 1m, 30m, 1h, 1.5h,
//                     3h, 6h, 12h. Every retry sent another email. The lead was
//                     never readable and never would be.
//                     ⇒ retries must be bounded, and must never re-alert.
//
// The resolution is a time window, not a cleverer reading of Meta's error.
// Meta's wording for a lead it will not hand over —"does not exist, cannot be
// loaded due to missing permissions, or does not support this operation"— is
// IDENTICAL for a deleted test lead and for a token missing a scope. Branching
// on it would have returned 200 during the 09:51 outage and thrown away the
// 12:54 recovery. So the code deliberately does not branch on it.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'test';

let decide;
let WINDOW_MS;
beforeAll(() => {
  const t = require('../server.js').__testUtils;
  decide = t.decideUnreadableLeadResponse;
  WINDOW_MS = t.FB_LEAD_UNREADABLE_RETRY_MS;
});

const T0 = '2026-08-17T17:52:56.000Z';
const at = (isoBase, msLater) => new Date(new Date(isoBase).getTime() + msLater);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('an unreadable Facebook lead', () => {
  it('alerts once on the first failure, and asks Meta to retry', () => {
    const d = decide(null, new Date(T0));
    expect(d.shouldAlert).toBe(true);
    expect(d.status).toBe(500);
    expect(d.action).toBe('lead_answers_unavailable');
  });

  // The whole point of the change: 13 emails for 2 leads is what happened.
  it('never emails again about the same lead, however many times Meta retries', () => {
    // Meta's actual observed backoff for lead 1033387905982548.
    const retries = [33 * 1000, 94 * 1000, 30 * MIN, 90 * MIN, 3 * HOUR, 5 * HOUR];
    for (const offset of retries) {
      const d = decide(T0, at(T0, offset));
      expect(d.shouldAlert).toBe(false);
    }
  });

  it('keeps asking Meta to retry while the recovery window is open', () => {
    const d = decide(T0, at(T0, 5 * HOUR));
    expect(d.status).toBe(500);
  });

  it('stops the retry storm once the window has closed', () => {
    const d = decide(T0, at(T0, WINDOW_MS + MIN));
    expect(d.status).toBe(200);
    expect(d.shouldAlert).toBe(false);
    expect(d.action).toBe('lead_answers_unavailable_abandoned');
  });

  // 🧨 The regression that matters most. Vishal Chaudhary's lead was recovered
  // 3h03m after it first failed, purely because we were still returning 500.
  // Any future shortening of this window has to consciously break this test.
  it('stays open long enough to have recovered the 2026-08-17 lead at +3h03m', () => {
    const realRecovery = 3 * HOUR + 3 * MIN;
    expect(WINDOW_MS).toBeGreaterThan(realRecovery);
    const d = decide(T0, at(T0, realRecovery));
    expect(d.status).toBe(500);
  });

  it('treats the boundary as still-open, not abandoned', () => {
    expect(decide(T0, at(T0, WINDOW_MS - 1)).status).toBe(500);
    expect(decide(T0, at(T0, WINDOW_MS)).status).toBe(200);
  });

  // A bad timestamp must fail towards keeping the lead alive. Reading an
  // unparseable value as "very old" would abandon a real doctor silently,
  // which is the one outcome this whole path exists to prevent.
  it('never abandons a lead because the stored timestamp is unusable', () => {
    for (const bad of ['not-a-date', '', undefined]) {
      const d = decide(bad || null, new Date(T0));
      expect(d.status).toBe(500);
    }
    expect(decide('nonsense', new Date(T0)).status).toBe(500);
  });

  it('never abandons a lead because of clock skew', () => {
    const d = decide(at(T0, 2 * HOUR).toISOString(), new Date(T0));
    expect(d.status).toBe(500);
    expect(d.shouldAlert).toBe(false);
  });

  it('accepts an explicit window so the policy can be tuned without editing callers', () => {
    expect(decide(T0, at(T0, 2 * HOUR), 1 * HOUR).status).toBe(200);
    expect(decide(T0, at(T0, 2 * HOUR), 9 * HOUR).status).toBe(500);
  });
});
