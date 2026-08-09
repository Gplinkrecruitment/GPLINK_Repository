import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/*
 * "It won't let me create a new test practice, there is an error saying could not
 * create." Reported 2026-08-09 while trying to test the sign-only link.
 *
 * `practices` carries a unique index on lower(name) — idx_practices_name_lower — so a
 * name that already exists in ANY casing comes back from PostgREST as a 409
 * (code 23505). atsInsertPracticeRow discarded that entirely and returned null, and
 * the endpoint turned null into a flat 502 "Could not create practice.": true, but it
 * told the staff member nothing, logged nothing, and left no way to find out. And
 * "Test Practice" already exists in prod, so the obvious name for a test always failed.
 *
 * Confirmed against the prod table: the same insert succeeds with a fresh name and
 * 409s with an existing one.
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

describe('atsInsertPracticeRow', () => {
  it('no longer throws the failure away', () => {
    expect(serverJs).toContain('_lastPracticeInsertError = { status: r.status, body: r.data };');
    expect(serverJs).toContain("console.error('[practices] insert failed (' + r.status + '):',");
    // The old body returned null without ever looking at the response.
    expect(serverJs).not.toContain("return (r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0] : null;\n  }\n  var local = Object.assign({ id: atsLocalId('prac_')");
  });

  it('resets the recorded error per call, so a later success cannot report a stale one', () => {
    const fn = serverJs.slice(serverJs.indexOf('async function atsInsertPracticeRow(row)'));
    const body = fn.slice(0, fn.indexOf('async function atsUpdatePracticeRow'));
    expect(body.indexOf('_lastPracticeInsertError = null;')).toBeLessThan(body.indexOf('if (isSupabaseDbConfigured())'));
  });

  it('keeps returning the row or null — nine call sites depend on that', () => {
    const calls = serverJs.match(/await atsInsertPracticeRow\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    const fn = serverJs.slice(serverJs.indexOf('async function atsInsertPracticeRow(row)'));
    expect(fn.slice(0, 900)).toContain('return r.data[0];');
  });
});

describe('POST /api/ats/practices', () => {
  const at = serverJs.indexOf('var createdP = await atsInsertPracticeRow(pracRow);');
  // Widened from 1500 when the duplicate branch grew a second case (a name
  // clashing with a practice sitting in the 12-month deleted archive).
  const block = serverJs.slice(at, at + 2600);

  it('names the clash instead of a bare "could not create"', () => {
    expect(block).toContain("code: 'duplicate_name'");
    expect(block).toContain('already exists. Pick a different name');
    // The staff member has to know it is the NAME, and that casing does not save them.
    expect(block).toContain('names are matched ignoring capitals');
  });

  it('recognises the duplicate three ways, not just by status', () => {
    // PostgREST returns 409 + code 23505; the constraint name is the belt-and-braces.
    expect(block).toContain('pcErr.status === 409');
    expect(block).toContain("pcBody.code === '23505'");
    expect(block).toContain("indexOf('idx_practices_name_lower')");
  });

  it('still surfaces any OTHER insert failure rather than hiding it', () => {
    expect(block).toContain("'Could not create practice: ' + pcBody.message");
  });

  it('returns 409 for a duplicate and 502 only for a genuine failure', () => {
    expect(block).toContain('sendJson(res, 409, { ok: false');
    expect(block).toContain('sendJson(res, 502, { ok: false');
    expect(block.indexOf('sendJson(res, 409')).toBeLessThan(block.indexOf('sendJson(res, 502'));
  });
});
