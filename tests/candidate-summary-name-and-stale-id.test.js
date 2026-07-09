// Regression tests for two GP-file display defects (reported 2026-07-09):
//
//  1. "Dr Unknown" in the AI candidate summary.
//     Root cause: the /api/admin/candidate-summary endpoint selected a column
//     `country` from user_profiles that does NOT exist (the real column is
//     `registration_country`). PostgREST 400s the whole query on an unknown
//     column, so `profile` fell back to {} and the candidate name resolved to
//     'Unknown' for EVERY GP (registration_cases has no gp_name/gp_email column
//     to catch it either).
//
//  2. A stale MyIntealth "ID: 123456" surfaced in the journey rail for a GP who
//     never started MyIntealth. The value was leftover test data whose
//     last-updated timestamp predated the GP's own registration case, so it
//     could not legitimately belong to this candidate.
//
// These are source-level guards (the same readFileSync style used elsewhere in
// this suite) so the exact regressions can't silently return. The live-DB
// behaviour of the corrected query was verified manually against Supabase.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

describe('candidate-summary: candidate name resolution', () => {
  it('selects the real registration_country column (not the non-existent country)', () => {
    // The exact select that builds the AI summary profile lookup.
    expect(SERVER).toContain(
      "select=first_name,last_name,email,phone_number,registration_country&user_id=eq.' + encodeURIComponent(userId)"
    );
  });

  it('never selects a bare `country` column from user_profiles', () => {
    // A bare `country` on user_profiles would 400 the query and reintroduce
    // the "Dr Unknown" fallback. (Location tables legitimately have `country`,
    // so we only assert the user_profiles selects are clean.)
    const badProfileSelects = SERVER.match(
      /supabaseDbRequest\('user_profiles',\s*'select=[^']*\bcountry\b[^']*'/g
    ) || [];
    const offenders = badProfileSelects.filter((s) => !/registration_country|country_of/.test(s));
    expect(offenders).toEqual([]);
  });
});

describe('dashboard: stale MyIntealth ID guard', () => {
  it('hides a MyIntealth ID whose update predates the GP registration case', () => {
    // The guard added alongside the existing admin-stage-override guard.
    const normalized = SERVER.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'if (visibleMyintealthId && visibleIdUpdatedAt && visibleCaseCreatedAt && visibleIdUpdatedAt < visibleCaseCreatedAt) { visibleMyintealthId = null; }'
    );
  });

  // Behavioural mirror of the guard so its intent is documented and locked in.
  function isMyintealthIdStale(idUpdatedAt, caseCreatedAt) {
    const idTs = Date.parse(idUpdatedAt || '') || 0;
    const caseTs = Date.parse(caseCreatedAt || '') || 0;
    return !!(idTs && caseTs && idTs < caseTs);
  }

  it('treats an ID saved before the account was created as stale', () => {
    // Helen Wazalski's real data: ID updated 2026-06-08, case created 2026-07-05.
    expect(isMyintealthIdStale('2026-06-08T07:50:58.427Z', '2026-07-05T11:53:52.774Z')).toBe(true);
  });

  it('keeps an ID legitimately entered after the account was created', () => {
    expect(isMyintealthIdStale('2026-07-10T09:00:00.000Z', '2026-07-05T11:53:52.774Z')).toBe(false);
  });

  it('does not treat a missing timestamp as stale (no false hiding)', () => {
    expect(isMyintealthIdStale('', '2026-07-05T11:53:52.774Z')).toBe(false);
    expect(isMyintealthIdStale('2026-06-08T07:50:58.427Z', '')).toBe(false);
  });
});
