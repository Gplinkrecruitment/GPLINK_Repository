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

// Task 5 — server-side backfill runners: materializePracticesFromArchive
// (client archive -> practices rows) and backfillCareerRolesFromArchive
// (career_roles patched with dpa/masked_title/practice_id). Every DB call
// goes through the archiveDb seam, stubbed here via a small path+method router
// so we never touch a real Supabase instance.
function makeBackfillRouter() {
  const posts = [];
  const patches = [];
  let postN = 0;

  const archiveClients = [
    // Known corporation-group id (see lib/zoho-backfill.js CORPORATION_ZOHO_IDS)
    // — no existing practice matches it, so it should be INSERTed.
    {
      zoho_id: '11734000000817081',
      payload: { Client_Name: 'ForHealth Group', Client_Email: '', Billing_City: 'Sydney', Billing_State: 'NSW' },
    },
    // Matches the existing 'Bay village medical centre' practice by
    // case-insensitive/trimmed name (not by zoho_client_id, which is unset).
    {
      zoho_id: '999',
      payload: {
        Client_Name: 'Bay Village Medical Centre',
        Client_Email: 'zoho-contact@bayvillage.example',
        Billing_City: 'Perth', Billing_State: 'WA',
      },
    },
  ];

  const existingPractices = [
    {
      id: 'existing-bay-village',
      name: 'Bay village medical centre',
      zoho_client_id: null,
      contact_email: 'owner@bayvillage.example', // non-empty — must survive untouched
      contact_phone: '',
      contact_name: '',
      org_type: 'practice',
    },
  ];

  const archiveRoles = [
    {
      id: 'role-1',
      billing_model: '',
      nearest_city: 'Perth',
      location_state: 'WA',
      source_payload: {
        zoho: {
          DPA: 'Yes', City: 'Perth', Location: '12 Smith St', Zip_Code: '6000',
          Billing_Type: 'Bulk billing', Client_Name: { id: '999' },
        },
      },
    },
    // No `.zoho` key on source_payload -> not a Zoho-sourced row -> must be skipped.
    { id: 'role-2', billing_model: '', nearest_city: '', location_state: '', source_payload: {} },
  ];

  async function router(path, q, opts) {
    const method = (opts && opts.method) || 'GET';
    if (path === 'zoho_archive' && method === 'GET') return { ok: true, data: archiveClients };
    if (path === 'practices' && method === 'GET') return { ok: true, data: existingPractices };
    if (path === 'practices' && method === 'POST') {
      postN++;
      posts.push({ q, body: opts.body });
      return { ok: true, data: [{ id: 'new-uuid-' + postN }] };
    }
    if (path === 'practices' && method === 'PATCH') {
      patches.push({ table: 'practices', q, body: opts.body });
      return { ok: true };
    }
    if (path === 'career_roles' && method === 'GET') return { ok: true, data: archiveRoles };
    if (path === 'career_roles' && method === 'PATCH') {
      patches.push({ table: 'career_roles', q, body: opts.body });
      return { ok: true };
    }
    return { ok: false, status: 500, data: null };
  }

  return { router, posts, patches };
}

describe('materializePracticesFromArchive', () => {
  it('inserts a new corporation practice and links/fills an existing match by name without overwriting owner data', async () => {
    const { router, posts, patches } = makeBackfillRouter();
    U.__setSupabaseDbRequestForTests(router);

    const res = await U.materializePracticesFromArchive();

    expect(res.ok).toBe(true);
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);

    // (a) ForHealth INSERTed with org_type 'corporation'.
    expect(posts.length).toBe(1);
    expect(posts[0].body[0].org_type).toBe('corporation');
    expect(posts[0].body[0].zoho_client_id).toBe('11734000000817081');
    expect(res.byId['11734000000817081']).toBe('new-uuid-1');

    // (b) Bay Village matched by name gets zoho_client_id, but its non-empty
    // contact_email is NOT in the PATCH body (never overwrite owner data).
    const bayPatch = patches.find(p => p.table === 'practices');
    expect(bayPatch).toBeTruthy();
    expect(bayPatch.q).toBe('id=eq.existing-bay-village');
    expect(bayPatch.body.zoho_client_id).toBe('999');
    expect(bayPatch.body.org_type).toBe('practice');
    expect(bayPatch.body).not.toHaveProperty('contact_email');
    expect(res.byId['999']).toBe('existing-bay-village');

    U.__setSupabaseDbRequestForTests(null);
  });
});

describe('backfillCareerRolesFromArchive', () => {
  it('patches Zoho-sourced roles with dpa/masked_title/practice_id and skips non-Zoho rows', async () => {
    const { router, patches } = makeBackfillRouter();
    U.__setSupabaseDbRequestForTests(router);

    const res = await U.backfillCareerRolesFromArchive();

    expect(res.ok).toBe(true);
    expect(res.patched).toBe(1);
    expect(res.skipped).toBe(1);

    // (c) role-1 patch carries dpa/masked_title/practice_id, linked via the
    // practice materialized/matched for zoho_id '999' (Bay Village).
    const rolePatch = patches.find(p => p.table === 'career_roles' && p.q === 'id=eq.role-1');
    expect(rolePatch).toBeTruthy();
    expect(rolePatch.body.dpa).toBe(true);
    expect(typeof rolePatch.body.masked_title).toBe('string');
    expect(rolePatch.body.masked_title.length).toBeGreaterThan(0);
    expect(rolePatch.body.practice_id).toBe('existing-bay-village');

    // (d) role-2 has no source_payload.zoho -> no PATCH issued for it.
    const skippedPatch = patches.find(p => p.table === 'career_roles' && p.q === 'id=eq.role-2');
    expect(skippedPatch).toBeFalsy();

    U.__setSupabaseDbRequestForTests(null);
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
