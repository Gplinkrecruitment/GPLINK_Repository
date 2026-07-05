// Task 3 — bulk pagers for Zoho Recruit modules (Job Openings, Clients,
// Candidates). Verifies the shared paging loop follows `more_records` and
// concatenates results, using a test-only fetcher seam so we don't need a
// live Zoho connection.
import { describe, it, expect, beforeAll } from 'vitest';

let U;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const mod = await import('../server.js');
  U = mod.__testUtils || (mod.default && mod.default.__testUtils);
});

describe('fetchAllZohoRecruitModule', () => {
  it('follows more_records across pages and concatenates', async () => {
    const pages = {
      1: { records: [{ id: '1' }, { id: '2' }], data: { info: { more_records: true } } },
      2: { records: [{ id: '3' }], data: { info: { more_records: false } } },
    };
    U.__setZohoRecordFetcherForTests(async (_paths, q) => pages[q.page] || { records: [], data: { info: { more_records: false } } });
    const all = await U.fetchAllZohoRecruitModule({}, ['Candidates']);
    expect(all.map(r => r.id)).toEqual(['1', '2', '3']);
    U.__setZohoRecordFetcherForTests(null);
  });
});

describe('upsertCandidateLeads filtering (pure part)', () => {
  it('skips hired and no-email candidates', async () => {
    // stub supabaseDbRequest via a captured seam
    const calls = [];
    U.__setSupabaseDbRequestForTests(async (path, q, opts) => { calls.push({ path, body: opts.body }); return { ok: true, status: 201 }; });
    const res = await U.upsertCandidateLeads([
      { id: '1', Full_Name: 'Keep Me', Email: 'keep@x.com', Phone: '040' },
      { id: '2', Full_Name: 'Hired One', Email: 'h@x.com', Candidate_Status: 'Hired' },
      { id: '3', Full_Name: 'No Email' },
    ]);
    expect(res).toEqual({ inserted: 1, skippedHired: 1, skippedNoEmail: 1 });
    expect(calls[0].body[0].email).toBe('keep@x.com');
    U.__setSupabaseDbRequestForTests(null);
  });
});

describe('captureZohoArchive', () => {
  it('pulls all three modules, archives, and builds leads', async () => {
    U.__setZohoAccessForTests(async () => ({ accessToken: 't', apiDomain: 'https://recruit.example', connection: {} }));
    const byPath = {
      JobOpenings: [{ id: 'j1' }], Clients: [{ id: 'c1' }],
      Candidates: [{ id: 'k1', Email: 'a@x.com', Full_Name: 'A' }, { id: 'k2', Email: 'b@x.com', Candidate_Status: 'Hired' }],
    };
    U.__setZohoRecordFetcherForTests(async (paths, q) => {
      const key = paths[0];
      return { records: q.page === 1 ? (byPath[key] || []) : [], data: { info: { more_records: false } } };
    });
    const writes = [];
    U.__setSupabaseDbRequestForTests(async (path, q, opts) => { writes.push({ path, n: opts.body.length }); return { ok: true }; });
    const res = await U.captureZohoArchive();
    expect(res.ok).toBe(true);
    expect(res.jobOpenings.fetched).toBe(1);
    expect(res.candidates.fetched).toBe(2);
    expect(res.leads).toEqual({ inserted: 1, skippedHired: 1, skippedNoEmail: 0 });
    U.__setZohoAccessForTests(null); U.__setZohoRecordFetcherForTests(null); U.__setSupabaseDbRequestForTests(null);
  });
});

describe('syncZohoRecruitRoles — Phase 1 decommission kill-switch', () => {
  it('resolves to the disabled contract immediately, without touching any Zoho/DB seam', async () => {
    // Deliberately NOT setting any seam stubs (no __setZohoAccessForTests, no
    // __setSupabaseDbRequestForTests, no __setZohoRecordFetcherForTests). If the
    // sync attempted any real I/O in this test env it would throw/reject with a
    // different shape (missing config, network error, etc). Resolving to exactly
    // this object proves it exits before any Zoho/DB call.
    const res = await U.syncZohoRecruitRoles();
    expect(res).toEqual({ ok: false, disabled: true, error: 'zoho_job_sync_decommissioned' });
  });
});
