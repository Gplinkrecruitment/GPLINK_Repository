// Security controls that were degrading as user count grew (2026-07-30).
//
// Three real holes, all verified against the running app before being fixed:
//
//  1. RATE LIMITING was a read-modify-write race. Measured against prod on the
//     OLD code: 40 simultaneous login attempts with a limit of 12 let **30**
//     through. On the fixed code: exactly 12. It ALSO failed OPEN — getRuntimeKv
//     returns null on a database error, indistinguishable from "no attempts
//     yet", so every auth rate limit switched off during exactly the database
//     stress that 1000 concurrent users makes routine.
//  2. ADMIN MFA failed OPEN and silently. getAdminMfaRecord returns null when
//     the read FAILS (supabaseDbRequest never throws), so the catch never fired,
//     adminMfaActive became false, and a full 8-hour admin session was issued on
//     the password alone with nothing logged.
//  3. /api/auth/set-password only verified the current password *if one was
//     supplied* — an empty string skipped the check, turning any stolen session
//     into a permanent account takeover. Verified: with a valid session and a
//     blank current password the endpoint returned 200 and changed the password;
//     it now returns 400.
//
// These are source-wiring guards. The behaviour was verified live (see the
// commit message); what this file prevents is someone quietly undoing it.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260730090000_atomic_rate_limit.sql'), 'utf8');

function extractFn(name) {
  let from = serverSrc.indexOf('\nasync function ' + name + '(');
  if (from === -1) from = serverSrc.indexOf('\nfunction ' + name + '(');
  expect(from, name + ' should exist').toBeGreaterThan(-1);
  from += 1;
  const end = serverSrc.indexOf('\n}\n', from);
  expect(end).toBeGreaterThan(from);
  return serverSrc.slice(from, end + 2);
}

describe('rate limiting — atomic and fail-closed', () => {
  it('ships the atomic counter as a single-statement upsert', () => {
    // One statement = one row lock = concurrent callers serialise. If this ever
    // becomes a SELECT followed by an UPDATE, the race is back.
    expect(migration).toContain('create or replace function public.rate_limit_hit');
    expect(migration).toContain('on conflict (key) do update');
    expect(migration).not.toMatch(/select\s+.*\s+from\s+public\.runtime_kv/i);
  });

  it('routes both limiters through the atomic counter', () => {
    expect(serverSrc).toContain('async function rateLimitHitAtomic(');
    const win = extractFn('checkRateLimitWindow');
    const basic = extractFn('checkRateLimit');
    expect(win).toContain('rateLimitHitAtomic(');
    expect(basic).toContain('rateLimitHitAtomic(');
  });

  it('DENIES when the counter cannot be reached', () => {
    // The whole point. `atomic.ok === false` and not merely "function missing"
    // must return false, or the limiter disables itself under database stress.
    const win = extractFn('checkRateLimitWindow');
    expect(win).toMatch(/if \(!atomic\.missing\) return false;/);
    const basic = extractFn('checkRateLimit');
    expect(basic).toMatch(/if \(!atomic\.missing\) return false;/);
  });

  it('still falls back when the function is absent, so a missing migration cannot lock everyone out', () => {
    const helper = extractFn('rateLimitHitAtomic');
    expect(helper).toContain('PGRST202');
    expect(helper).toMatch(/missing/);
  });
});

describe('admin MFA — fails closed', () => {
  it('separates "no second factor" from "could not check"', () => {
    const reader = extractFn('readAdminMfaRecord');
    expect(reader).toContain('if (!res.ok) return { ok: false, record: null };');
    expect(reader).toContain('return { ok: true, record: row };');
  });

  it('refuses the login rather than issuing an admin session when the check fails', () => {
    expect(serverSrc).toContain('let adminMfaLookup = { ok: false, record: null };');
    expect(serverSrc).toContain('readAdminMfaRecord(email)');
    // Must bail BEFORE setAdminSession, with a 503 rather than a silent pass.
    const idx = serverSrc.indexOf('if (!adminMfaLookup.ok)');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 400);
    expect(block).toContain('503');
    expect(block).toContain('return;');
    // The old silently-fail-open shape must not come back.
    expect(serverSrc).not.toContain("console.error('[MFA] lookup failed at login (failing OPEN — no lockout):'");
  });
});

describe('set-password — a session alone is not enough', () => {
  it('always requires the current password on the Supabase path', () => {
    // The bug was `if (currentPassword) { ...verify... }` — blank skipped it.
    expect(serverSrc).not.toContain('      if (currentPassword) {\n        const checkCurrent =');
    expect(serverSrc).toContain("sendJson(res, 400, { ok: false, message: 'Enter your current password to change it.' });");
    const idx = serverSrc.indexOf("message: 'Enter your current password to change it.'");
    expect(idx).toBeGreaterThan(-1);
    // The verification must be unconditional, immediately after that guard.
    const after = serverSrc.slice(idx, idx + 600);
    expect(after).toContain("supabaseAuthRequest('token?grant_type=password'");
    expect(after).toContain("message: 'Current password is incorrect.'");
  });

  it('rate-limits the endpoint, since it is now a password oracle', () => {
    expect(serverSrc).toMatch(/checkRateLimitWindow\(`set-password:\$\{sessionUserId\}`/);
  });

  it('the account page no longer tells the doctor the field is optional', () => {
    const account = fs.readFileSync(path.join(ROOT, 'pages/account.html'), 'utf8');
    expect(account).not.toContain('Current password (if already set)');
    expect(account).toContain('if (!current) { setPasswordActionStatus(');
  });
});

describe('payload size — queries that grew with doctor count', () => {
  it('the support-ticket update no longer reads every doctor\'s state blob', () => {
    // Was: select every user_profiles row + every user_state row (~6.5 KB of
    // JSONB each) to keep ONE. ~6 MB at 1000 doctors, against a 10s abort whose
    // failure mode is a silently skipped update.
    const fn = extractFn('persistSupportCaseUpdate');
    expect(fn).toContain('getSupabaseUserIdByEmail(scopedEmail)');
    expect(fn).toContain('user_id=eq.${encodeURIComponent(targetUserId)}&limit=1');
    // The unscoped scan must survive as an explicit fallback — one caller can
    // legitimately arrive with no scope at all.
    expect(fn).toContain("supabaseDbRequest('user_profiles', 'select=user_id,email')");
  });

  it('the CEO RSO tab selects only the columns its metrics read', () => {
    expect(serverSrc).toContain(
      "supabaseDbRequest('registration_cases', 'select=id,assigned_rso,status,last_gp_activity_at,updated_at,created_at&order=updated_at.desc')"
    );
  });

  it('those columns still cover everything lib/ceo-metrics.js touches', () => {
    // Guards against the silent-empty failure mode: if a metric starts reading
    // another column, this test fails instead of the tab quietly showing zeros.
    const metrics = fs.readFileSync(path.join(ROOT, 'lib/ceo-metrics.js'), 'utf8');
    const caseAge = metrics.slice(metrics.indexOf('function caseAgeMs'));
    expect(caseAge.slice(0, 200)).toContain('c.last_gp_activity_at || c.updated_at || c.created_at');
    const workload = metrics.slice(
      metrics.indexOf('function computeRsoWorkload'),
      metrics.indexOf('function computeRsoWorkload') + 1400
    );
    const touched = new Set((workload.match(/\bc\.[a-z_]+/g) || []).map((s) => s.slice(2)));
    for (const col of touched) {
      expect(['id', 'assigned_rso', 'status', 'last_gp_activity_at', 'updated_at', 'created_at'])
        .toContain(col);
    }
  });
});
