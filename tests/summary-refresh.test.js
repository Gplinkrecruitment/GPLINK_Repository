// Auto-refresh of ai_handover_summary (the "background" that feeds matching).
// Unit-tests the change-detection selection (lib/summary-refresh.js) + a static
// check that the /api/cron/refresh-summaries endpoint and its vercel cron exist.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selectStaleSummaryCases } from '../lib/summary-refresh.js';

const H = 60 * 60 * 1000;
const T = Date.parse('2026-07-25T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const MISSING   = { id: 'missing' }; // no ai_handover_summary
const CHANGED   = { id: 'changed', ai_handover_summary: { generated_at: iso(T - 2 * H) }, updated_at: iso(T - 1 * H) }; // activity newer than summary
const FRESH     = { id: 'fresh',   ai_handover_summary: { generated_at: iso(T - 1 * H) }, updated_at: iso(T - 3 * H) }; // no new activity, recent summary
const AGED      = { id: 'aged',    ai_handover_summary: { generated_at: iso(T - 72 * H) }, updated_at: iso(T - 96 * H) }; // no new activity but > 48h floor

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

  it('has a vercel cron entry', () => {
    const entry = vercelJson.crons.find((c) => c.path === '/api/cron/refresh-summaries');
    expect(entry).toBeTruthy();
    expect(entry.schedule).toBeTruthy();
  });
});
