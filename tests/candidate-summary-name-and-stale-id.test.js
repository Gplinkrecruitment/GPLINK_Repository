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

// ── 2026-08-19: the summary was cut off mid-JSON and blamed on the model ──────
//
// Owner reported "AI service error: ... no low surrogate in string" (a truncated emoji in our
// request — see tests/ai-text-safety.test.js). Fixing that JSON parse error exposed a SECOND
// failure that had been hidden behind it, because a parse error is raised before any other
// validation: the request now reached the model, and the model ran out of output budget.
//
// Verified against the live API on this very case: `max_tokens: 4096`, of which Sonnet 5 spent
// ~2,200 thinking, then began the JSON and stopped at the cap — stop_reason "max_tokens",
// 1,615 characters of half-written object. JSON.parse threw and the endpoint returned
// "AI returned invalid format", i.e. it blamed the model for our own under-budgeting.
// At 16,000 the same request returns stop_reason "end_turn" and parses.
describe('candidate summary output budget', () => {
  const summaryCall = SERVER.slice(
    SERVER.indexOf('var summarySystemPrompt'),
    SERVER.indexOf('var summary;'),
  );

  it('budgets enough output for the model to think AND write the JSON', () => {
    expect(summaryCall).toContain('max_tokens: 16000');
    expect(summaryCall).not.toContain('max_tokens: 4096');
  });

  it('says the output was cut off instead of calling a truncated answer invalid', () => {
    expect(summaryCall).toContain("anthropicData.stop_reason === 'max_tokens'");
    expect(summaryCall).toContain('cut off before it finished');
  });

  it('checks for truncation BEFORE trying to parse, so the honest error wins', () => {
    // Anchored on the parse of rawText specifically — there is an earlier JSON.parse in the
    // non-ok error branch that has nothing to do with this ordering.
    const stopAt = SERVER.indexOf("anthropicData.stop_reason === 'max_tokens'");
    const parseAt = SERVER.indexOf('summary = JSON.parse(rawText.trim());');
    expect(stopAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(stopAt);
  });

  it('collects only text blocks — a thinking block is not part of the answer', () => {
    expect(summaryCall).toContain("if (anthropicData.content[i].type === 'text') rawText += anthropicData.content[i].text;");
  });
});
