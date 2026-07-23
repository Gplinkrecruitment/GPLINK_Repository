// End-to-end (local-JSON mode) proof of the multi-GP opening gate: a practice
// that asked for 3 GPs keeps its opening open — and NOT full — until the third
// candidate reaches the Hired lane. Exercises the REAL atsJobFillState against
// the real dbState count, so a bug in the query or the parse would fail here.
//
// Runs with no Supabase configured, so server.js falls back to dbState. Loading
// server.js has side effects (it reads a DB file), which is why this uses the
// exported test-only seeders rather than touching internals.
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import path from 'path';

// Unique per-run ids + a private DB file so this never collides with other test
// files sharing data/app-db.json (they run in parallel).
const RUN = crypto.randomBytes(4).toString('hex');
const JID = 'role-3gp-' + RUN;
const JID1 = 'role-1gp-' + RUN;

let U;
beforeAll(async () => {
  // Force local-JSON mode against a private DB file, set BEFORE importing
  // server.js (it captures the path in a const at load time).
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.DB_FILE_PATH = path.join('/tmp', 'gplink-fillstate-' + RUN + '.json');
  const mod = await import('../server.js');
  U = mod.default.__testUtils || mod.__testUtils;
});

describe('multi-GP opening stays open until every seat is hired (real fill state)', () => {
  const JOB = {
    id: 'role-3gp-1', provider: 'internal_ats', job_status: 'open',
    details: { gps_needed: '3' }
  };
  const APPS = [
    { id: 'app-a', career_role_id: 'role-3gp-1', user_id: 'u-a', ats_stage: 'interview' },
    { id: 'app-b', career_role_id: 'role-3gp-1', user_id: 'u-b', ats_stage: 'interview' },
    { id: 'app-c', career_role_id: 'role-3gp-1', user_id: 'u-c', ats_stage: 'interview' },
    { id: 'app-d', career_role_id: 'role-3gp-1', user_id: 'u-d', ats_stage: 'reviewing' }
  ];

  beforeAll(() => {
    U.__seedAtsFillState(JOB, APPS);
  });

  it('reads the target of 3 from the intake free text', () => {
    expect(U.jobPositionsNeeded(JOB)).toBe(3);
  });

  it('is NOT full with zero, one, or two hired', async () => {
    let s = await U.atsJobFillState('role-3gp-1');
    expect(s).toMatchObject({ needed: 3, hired: 0, isFull: false });

    U.__setAtsAppStageForTest('app-a', 'hired');
    s = await U.atsJobFillState('role-3gp-1');
    expect(s).toMatchObject({ needed: 3, hired: 1, isFull: false }); // opening stays open

    U.__setAtsAppStageForTest('app-b', 'hired');
    s = await U.atsJobFillState('role-3gp-1');
    expect(s).toMatchObject({ needed: 3, hired: 2, isFull: false }); // still open
  });

  it('becomes full only when the third candidate is hired', async () => {
    U.__setAtsAppStageForTest('app-c', 'hired');
    const s = await U.atsJobFillState('role-3gp-1');
    expect(s).toMatchObject({ needed: 3, hired: 3, isFull: true, remaining: 0 });
  });

  it('a single-GP opening (no gps_needed) is full on the first hire', async () => {
    U.__seedAtsFillState(
      { id: 'role-1gp', provider: 'internal_ats', job_status: 'open', details: {} },
      [{ id: 'app-solo', career_role_id: 'role-1gp', user_id: 'u-solo', ats_stage: 'hired' }]
    );
    const s = await U.atsJobFillState('role-1gp');
    expect(s).toMatchObject({ needed: 1, hired: 1, isFull: true });
  });

  it('only counts the Hired lane, not candidates still interviewing', async () => {
    // app-d is still 'reviewing' on the 3-GP job; it must never count.
    const hired = await U.atsJobHiredCount('role-3gp-1');
    expect(hired).toBe(3); // a, b, c — not d
  });
});
