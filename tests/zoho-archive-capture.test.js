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
