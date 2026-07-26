// Scale guard (2026-07-27) — PostgREST `in.(...)` id lists must be chunked.
//
// Why this exists: the CEO dashboard used to inline EVERY active case id into a
// single `case_id=in.(...)` URL. The whole list travels in the URL, so past a
// few hundred GPs Supabase rejected the request. Measured against prod that day:
//   650 UUIDs -> HTTP 200,  700 UUIDs -> HTTP 400 (~26KB URL)
// supabaseDbRequest turns a non-2xx into ok:false and every caller fell back to
// `[]`, so the CEO's task views would have silently rendered "no tasks" instead
// of erroring — the same silent-400 class as the schema-drift bug.
//
// Two halves:
//  (A) Source wiring — the six id-list sites stay chunked, caps stay shared.
//  (B) Behaviour — the extracted helpers actually chunk and sort correctly.
//      Both helpers are self-contained, so they're evaluated in isolation
//      rather than booting the server.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractFn(name) {
  const start = serverSrc.indexOf('\n' + (name.startsWith('async') ? '' : '') + 'async function ' + name + '(');
  const startPlain = serverSrc.indexOf('\nfunction ' + name + '(');
  const from = start !== -1 ? start + 1 : startPlain + 1;
  expect(from).toBeGreaterThan(0);
  // Function declarations sit at column 0, so the next line that is exactly "}"
  // closes it.
  const end = serverSrc.indexOf('\n}\n', from);
  expect(end).toBeGreaterThan(from);
  return serverSrc.slice(from, end + 2);
}

describe('id-list chunking — source wiring', () => {
  it('declares the chunk helper and the shared caps', () => {
    expect(serverSrc).toContain('const SUPABASE_IN_CHUNK_SIZE = 200;');
    expect(serverSrc).toContain('const CEO_OPEN_TASK_ROW_CAP = 50000;');
    expect(serverSrc).toMatch(/async function supabaseDbRequestByIds\(table, ids, buildQuery, opts\)/);
    expect(serverSrc).toMatch(/function _ceoOpenTaskSort\(rows\)/);
  });

  it('no query inlines a raw id array into an in.(...) filter', () => {
    // The exact shape that broke: `case_id=in.(' + someIds.join(',') + ')`.
    // Fixed-value lists (statuses, stages) are fine — they don't grow with GPs —
    // so this only guards *_id / *Ids variables.
    const offenders = [];
    const re = /(case_id|user_id|application_id|career_role_id)=in\.\(' \+ ([A-Za-z_]*(?:[Ii]ds|_ids))\.join\(','\)/g;
    let m;
    while ((m = re.exec(serverSrc)) !== null) {
      offenders.push(`${m[1]}=in.(' + ${m[2]}.join(',')`);
    }
    expect(offenders).toEqual([]);
  });

  it('routes every former offender through supabaseDbRequestByIds', () => {
    // 4 CEO task drilldowns + 2 profile lookups + 2 gp_applications-by-role.
    const calls = serverSrc.match(/supabaseDbRequestByIds\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(serverSrc).toContain("supabaseDbRequestByIds(\n            'gp_applications', allRoleIds,");
    expect(serverSrc).toContain("supabaseDbRequestByIds(\n        'gp_applications', roleIds,");
    expect(serverSrc).toContain("supabaseDbRequestByIds('registration_tasks', dCaseIds");
    expect(serverSrc).toContain("supabaseDbRequestByIds('registration_tasks', tActiveCaseIds");
    expect(serverSrc).toContain("supabaseDbRequestByIds('registration_tasks', rdCaseIds");
    expect(serverSrc).toContain("supabaseDbRequestByIds('registration_tasks', vaCaseIds");
    expect(serverSrc).toContain("supabaseDbRequestByIds('user_profiles', userIds");
  });

  it('keeps the KPI tile and its drilldown on the SAME row cap (F11a invariant)', () => {
    // If these ever diverge the tile count and the list it opens disagree.
    expect(serverSrc).toContain("&order=created_at.desc&limit=' + CEO_OPEN_TASK_ROW_CAP");
    expect(serverSrc).toMatch(/cap: CEO_OPEN_TASK_ROW_CAP/);
    expect(serverSrc).not.toMatch(/OPEN_TASK_STATUSES\.join\(','\) \+ '\)&limit=2000/);
  });

  it('the chunked tasks drilldown re-sorts in JS (chunks are only locally ordered)', () => {
    expect(serverSrc).toContain('_ceoOpenTaskSort(await supabaseDbRequestByIds(');
  });

  it('raises the caps that silently truncated', () => {
    // stage-duration metrics, onboarding-nudge candidates, AI summary scan
    expect(serverSrc).toContain('event_type=eq.stage_change&order=case_id.asc,created_at.asc&limit=20000');
    expect(serverSrc).toContain("&onboarding_completed_at=is.null&limit=10000");
    expect(serverSrc).toContain("process.env.SUMMARY_REFRESH_SCAN || 5000");
    expect(serverSrc).toContain("process.env.SUMMARY_REFRESH_CAP || 25");
  });
});

describe('supabaseDbRequestByIds — behaviour', () => {
  // Rebuild the helper in isolation with stubbed collaborators.
  function build(stub) {
    const src = extractFn('supabaseDbRequestByIds');
    const factory = new Function(
      'supabaseDbRequest', '_atsInList', 'SUPABASE_IN_CHUNK_SIZE',
      src + '\nreturn supabaseDbRequestByIds;'
    );
    return factory(stub, (ids) => ids.map((i) => `"${i}"`).join(','), 200);
  }

  it('splits a 1000-id list into 200-id requests and concatenates the rows', async () => {
    const seen = [];
    const fn = build(async (table, query) => {
      seen.push(query);
      return { ok: true, data: [{ id: seen.length }] };
    });
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    const rows = await fn('registration_tasks', ids, (inList) => `select=*&case_id=in.(${inList})`);
    expect(seen.length).toBe(5);
    expect(rows).toHaveLength(5);
    // Every request must stay far below the ~26KB wall that produced HTTP 400.
    seen.forEach((q) => expect(q.length).toBeLessThan(20000));
  });

  it('de-duplicates and drops empty ids before chunking', async () => {
    let calls = 0;
    const fn = build(async () => { calls++; return { ok: true, data: [] }; });
    await fn('t', ['a', 'a', 'b', null, undefined, ''], (l) => l);
    expect(calls).toBe(1);
  });

  it('makes no request for an empty id list', async () => {
    let calls = 0;
    const fn = build(async () => { calls++; return { ok: true, data: [] }; });
    expect(await fn('t', [], (l) => l)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('a failed chunk contributes nothing rather than throwing (matches old ok?data:[] fallback)', async () => {
    let n = 0;
    const fn = build(async () => (++n === 1 ? { ok: false, status: 400 } : { ok: true, data: [{ id: 'x' }] }));
    const ids = Array.from({ length: 400 }, (_, i) => `id-${i}`);
    const rows = await fn('t', ids, (l) => `in.(${l})`);
    expect(n).toBe(2);
    expect(rows).toEqual([{ id: 'x' }]);
  });

  it('URL-encodes the id list (quotes become %22, so raw quotes never reach the URL)', async () => {
    let seen = '';
    const fn = build(async (table, query) => { seen = query; return { ok: true, data: [] }; });
    await fn('t', ['a', 'b'], (l) => `in.(${l})`);
    expect(seen).toContain('%22a%22');
    expect(seen).not.toContain('"');
  });

  it('honours an overall cap and stops early', async () => {
    let calls = 0;
    const fn = build(async () => { calls++; return { ok: true, data: [1, 2, 3] }; });
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    const rows = await fn('t', ids, (l) => l, { cap: 5 });
    expect(rows).toHaveLength(5);
    expect(calls).toBeLessThan(5); // stopped once the cap was reached
  });
});

describe('_ceoOpenTaskSort — mirrors PostgREST order=priority.asc,created_at.desc', () => {
  function build() {
    const src = extractFn('_ceoOpenTaskSort');
    return new Function(src + '\nreturn _ceoOpenTaskSort;')();
  }

  it('sorts priority ascending (text column => alphabetical), then created_at descending', () => {
    const sort = build();
    const rows = [
      { id: 'n1', priority: 'normal', created_at: '2026-01-01T00:00:00Z' },
      { id: 'h2', priority: 'high', created_at: '2026-01-01T00:00:00Z' },
      { id: 'h1', priority: 'high', created_at: '2026-02-01T00:00:00Z' },
      { id: 'u1', priority: 'urgent', created_at: '2026-01-01T00:00:00Z' },
      { id: 'l1', priority: 'low', created_at: '2026-01-01T00:00:00Z' },
    ];
    // Alphabetical, NOT severity — this is what the single-query version did.
    expect(sort(rows).map((r) => r.id)).toEqual(['h1', 'h2', 'l1', 'n1', 'u1']);
  });

  it('puts NULL priority last, as Postgres does on ASC', () => {
    const sort = build();
    const rows = [
      { id: 'null1', priority: null, created_at: '2026-05-01T00:00:00Z' },
      { id: 'a1', priority: 'high', created_at: '2026-01-01T00:00:00Z' },
    ];
    expect(sort(rows).map((r) => r.id)).toEqual(['a1', 'null1']);
  });

  it('produces the same order as one big query would, given chunked input', () => {
    const sort = build();
    // Simulate two chunks each internally ordered, concatenated.
    const chunkA = [
      { id: 'a-high', priority: 'high', created_at: '2026-01-05T00:00:00Z' },
      { id: 'a-low', priority: 'low', created_at: '2026-01-04T00:00:00Z' },
    ];
    const chunkB = [
      { id: 'b-high', priority: 'high', created_at: '2026-03-01T00:00:00Z' },
      { id: 'b-low', priority: 'low', created_at: '2026-02-01T00:00:00Z' },
    ];
    const merged = sort(chunkA.concat(chunkB)).map((r) => r.id);
    expect(merged).toEqual(['b-high', 'a-high', 'b-low', 'a-low']);
  });
});
