// Auto-refresh of ai_handover_summary (the "background" that feeds matching).
// Unit-tests the change-detection selection (lib/summary-refresh.js) + a static
// check that the /api/cron/refresh-summaries endpoint and its vercel cron exist.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selectStaleSummaryCases, DEFAULT_FLOOR_MS } from '../lib/summary-refresh.js';

const H = 60 * 60 * 1000;
const T = Date.parse('2026-07-25T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const MISSING   = { id: 'missing' }; // no ai_handover_summary
const CHANGED   = { id: 'changed', ai_handover_summary: { generated_at: iso(T - 2 * H) }, updated_at: iso(T - 1 * H) }; // activity newer than summary
const FRESH     = { id: 'fresh',   ai_handover_summary: { generated_at: iso(T - 1 * H) }, updated_at: iso(T - 3 * H) }; // no new activity, recent summary
const AGED      = { id: 'aged',    ai_handover_summary: { generated_at: iso(T - 72 * H) }, updated_at: iso(T - 96 * H) }; // no new activity, 72h old — "aged" only against an explicit sub-72h floor

describe('selectStaleSummaryCases — change-detection', () => {
  it('picks missing, changed, and aged; skips fresh (no new activity within the floor)', () => {
    const out = selectStaleSummaryCases([FRESH, AGED, CHANGED, MISSING], T, { floorMs: 48 * H, cap: 10 }).map((c) => c.id);
    expect(out).toContain('missing');
    expect(out).toContain('changed');
    expect(out).toContain('aged');
    expect(out).not.toContain('fresh');
  });

  it('orders missing first, then freshest-activity first', () => {
    const out = selectStaleSummaryCases([AGED, CHANGED, MISSING], T, { floorMs: 48 * H, cap: 10 }).map((c) => c.id);
    expect(out).toEqual(['missing', 'changed', 'aged']); // missing → changed (activity T-1h) → aged (activity T-96h)
  });

  it('respects the per-run cap', () => {
    const out = selectStaleSummaryCases([AGED, CHANGED, MISSING], T, { floorMs: 48 * H, cap: 2 }).map((c) => c.id);
    expect(out).toEqual(['missing', 'changed']);
  });

  it('a GP matched 5x in a day with no new activity is refreshed at most once (not selected while fresh)', () => {
    // FRESH has a recent summary and no newer activity — repeated matching never re-selects it.
    expect(selectStaleSummaryCases([FRESH], T, { floorMs: 48 * H, cap: 10 })).toEqual([]);
  });

  it('is defensive about bad input', () => {
    expect(selectStaleSummaryCases(null, T)).toEqual([]);
    expect(selectStaleSummaryCases([{ /* no id */ }], T)).toEqual([]); // rows without an id are skipped
    // invalid dates are treated as epoch 0 → a summary with an unparseable generated_at counts as missing
    expect(selectStaleSummaryCases([{ id: 'x', ai_handover_summary: { generated_at: 'not-a-date' } }], T).map((c) => c.id)).toEqual(['x']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cost regression guards.
//
// `missing` and `changed` are self-limiting — each fires once and is satisfied
// until the GP does something again. `aged` is NOT: it re-fires on a fixed clock
// forever, on GPs where nothing happened. That makes the floor, not the per-run
// cap, the thing that sets this job's standing spend. At a 48h floor the queue
// never drained and the cron ran its full 50s time-box every 30 minutes, around
// the clock (~$6/day of Sonnet 5). These tests exist so that cannot come back.
describe('selectStaleSummaryCases — floor is the cost lever', () => {
  it('defaults to a 14-day floor, not 48h', () => {
    expect(DEFAULT_FLOOR_MS).toBe(14 * 24 * H);
  });

  it('does NOT re-select a quiet GP whose summary is days old (the old 48h floor did)', () => {
    // Same row that the 48h floor treated as stale — under the default it is left alone.
    expect(selectStaleSummaryCases([AGED], T, { cap: 10 })).toEqual([]);
    expect(selectStaleSummaryCases([AGED], T, { floorMs: 48 * H, cap: 10 }).map((c) => c.id)).toEqual(['aged']);
  });

  it('still re-syncs a quiet GP once past the floor (the backstop survives)', () => {
    const veryOld = { id: 'very-old', ai_handover_summary: { generated_at: iso(T - 15 * 24 * H) }, updated_at: iso(T - 20 * 24 * H) };
    expect(selectStaleSummaryCases([veryOld], T, { cap: 10 }).map((c) => c.id)).toEqual(['very-old']);
  });

  it('a real change is still picked up immediately, whatever the floor', () => {
    // The floor only governs no-change re-syncs; activity-driven refresh is untouched.
    expect(selectStaleSummaryCases([CHANGED], T, { cap: 10 }).map((c) => c.id)).toEqual(['changed']);
    expect(selectStaleSummaryCases([MISSING], T, { cap: 10 }).map((c) => c.id)).toEqual(['missing']);
  });
});

describe('/api/cron/refresh-summaries — registered + scheduled', () => {
  const serverSrc = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const vercelJson = JSON.parse(readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

  it('registers the cron endpoint with the CRON_SECRET bearer pattern', () => {
    expect(serverSrc).toContain("pathname === '/api/cron/refresh-summaries'");
    expect(serverSrc).toContain('if (!isValidCronSecret(getBearerToken(req))) { sendJson(res, 401,');
  });

  it('the candidate-summary generator also accepts cron auth (so the refresher can call it)', () => {
    expect(serverSrc).toContain("pathname === '/api/admin/candidate-summary'");
    // the admin-session gate is now skipped when the request carries a valid cron secret
    expect(serverSrc).toMatch(/if \(!isValidCronSecret\(getBearerToken\(req\)\)\) \{\s*const adminCtx = requireAdminSession/);
  });

  it('the admin-host guard exempts cron requests (so the self-call to candidate-summary is not 404d off the admin host)', () => {
    expect(serverSrc).toContain("if (pathname.startsWith('/api/admin/') && !isAllowedAdminHost(req) && !isValidCronSecret(getBearerToken(req)))");
  });

  it('has a vercel cron entry, hourly — and CRON_SCHEDULES agrees with it', () => {
    const entry = vercelJson.crons.find((c) => c.path === '/api/cron/refresh-summaries');
    expect(entry).toBeTruthy();
    // Hourly, not */30: summaries feed match ranking only, so nothing user-facing waits
    // on them and twice-hourly just doubled the ceiling on an already-saturated job.
    expect(entry.schedule).toBe('0 * * * *');
    // vercel.json is the real schedule; CRON_SCHEDULES only mirrors it for cron-health.
    // They drifted before (gmail-poll polls 4x its declared cadence) — assert they match.
    expect(serverSrc).toContain("'refresh-summaries': { schedule: '0 * * * *', cadenceMinutes: 60 }");
  });

  it('passes an explicit floorMs to the selector (so the cost lever cannot be silently dropped)', () => {
    expect(serverSrc).toContain('SUMMARY_REFRESH_FLOOR_HOURS');
    expect(serverSrc).toMatch(/selectStaleSummaryCases\(rsCases, Date\.now\(\), \{[^}]*floorMs: rsFloorMs/);
  });

  it('the daily Anthropic spend cap is a real backstop, not $100', () => {
    // Shared by every AI feature. At $100 it never fired while this job burned ~$6/day.
    expect(serverSrc).toMatch(/ANTHROPIC_DAILY_LIMIT_USD \|\| 25\)/);
  });
});
