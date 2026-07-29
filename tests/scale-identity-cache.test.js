// Scale guard (2026-07-29) — identity lookups must not repeat per API call.
//
// Why this exists: measured against prod with a real headless browser, ONE
// logged-in page load cost 72 PostgREST queries and 64% of them were
// byte-identical repeats — `user_profiles?select=user_id&email=eq.<email>` ran
// 23 times and the matching `user_state` read ran 20 times, because every API
// call re-asked "which user is this email?" from scratch. The database was never
// struggling; it was answering the same question over and over.
//
// The fix is two layers (see the comment block above supabaseDbRequest):
//   1. a request-scoped memo (AsyncLocalStorage) — safe for volatile rows
//   2. a 60s process cache for email -> user UUID only
//
// This file locks in the parts that are easy to regress:
//  (A) Source wiring — the layers stay installed and the invalidation hooks stay
//      attached to the transport, so new write sites can't silently go stale.
//  (B) Behaviour — the real extracted functions, driven against a stub
//      supabaseDbRequest, must cache positives, NEVER cache negatives, coalesce
//      concurrent misses, expire, and invalidate.
//  (C) js/api-dedupe.js must stay an in-flight-only coalescer, never a cache.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'async_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const dedupeSrc = fs.readFileSync(path.join(ROOT, 'js', 'api-dedupe.js'), 'utf8');

function extractFn(name) {
  const marker = '\nasync function ' + name + '(';
  const plain = '\nfunction ' + name + '(';
  let from = serverSrc.indexOf(marker);
  if (from === -1) from = serverSrc.indexOf(plain);
  expect(from, 'function ' + name + ' should exist in server.js').toBeGreaterThan(-1);
  from += 1;
  const end = serverSrc.indexOf('\n}\n', from);
  expect(end).toBeGreaterThan(from);
  return serverSrc.slice(from, end + 2);
}

/* ── (A) Source wiring ─────────────────────────────────────────────── */

describe('identity cache — source wiring', () => {
  it('installs the request scope and wraps every request in it', () => {
    expect(serverSrc).toContain("require('async_hooks')");
    expect(serverSrc).toContain('function runInGpRequestScope(fn)');
    // Both entry points (local http server and the Vercel export) call
    // handleRequest, so wrapping it covers both.
    expect(serverSrc).toContain('return runInGpRequestScope(() => handleRequestInner(req, res));');
  });

  it('keeps the TTL cache short and bounded', () => {
    expect(serverSrc).toMatch(/SUPABASE_USER_ID_CACHE_TTL_MS\s*=\s*Number\(process\.env\.SUPABASE_USER_ID_CACHE_TTL_MS\s*\|\|\s*60000\)/);
    expect(serverSrc).toContain('SUPABASE_USER_ID_CACHE_MAX');
  });

  it('hooks invalidation onto the transports, not onto individual call sites', () => {
    // supabaseDbRequest: any write to these tables drops the matching cache.
    expect(serverSrc).toContain("if (pathname === 'user_profiles') invalidateSupabaseUserIdCache();");
    expect(serverSrc).toContain("else if (pathname === 'user_state') invalidateRequestUserStateCache();");
    // Auth-admin writes cascade to user_profiles without touching supabaseDbRequest.
    expect(serverSrc).toContain("String(pathname || '').startsWith('admin/users')");
    // The raw-fetch delete helper has to invalidate explicitly.
    const del = extractFn('supabaseAuthAdminDeleteUser');
    expect(del).toContain('invalidateSupabaseUserIdCache();');
  });

  it('never caches user_state across requests', () => {
    // Only the request-scoped map may hold user_state. A process-level user_state
    // cache would show a doctor stale progress after they complete a step.
    const stateFn = extractFn('getSupabaseUserStateByUserId');
    expect(stateFn).toContain('scope.userStateByUserId');
    expect(stateFn).not.toMatch(/expiresAt|TTL/);
  });

  it('prefers the session-embedded user id over a database lookup', () => {
    // The guarded idiom; regressing these back to an unguarded lookup costs a
    // query per request even with the cache warm.
    const guarded = serverSrc.match(/getSessionSupabaseUserId\(session\) \|\| \(email \? await getSupabaseUserIdByEmail\(email\) : null\)/g) || [];
    expect(guarded.length).toBeGreaterThanOrEqual(5);
    // No GP-session handler should use the bare form any more.
    expect(serverSrc).not.toContain('const userId = email ? await getSupabaseUserIdByEmail(email) : null;');
  });
});

/* ── (B) Behaviour of the real extracted functions ─────────────────── */

function buildHarness({ ttlMs = 60000 } = {}) {
  const calls = { userProfiles: 0, userState: 0 };
  let now = 1000000;
  let profileRow = [{ user_id: 'uid-1' }];

  const src = [
    extractFn('getSupabaseUserIdByEmail'),
    extractFn('_cloneUserStateRow'),
    extractFn('getSupabaseUserStateByUserId'),
    extractFn('getSupabaseUserStateByEmail'),
    'return { getSupabaseUserIdByEmail, getSupabaseUserStateByUserId, getSupabaseUserStateByEmail };'
  ].join('\n');

  const store = new AsyncLocalStorage();
  const cache = new Map();
  const inflight = new Map();

  const scopeApi = {
    getGpRequestScope: () => store.getStore() || null,
    _supabaseUserIdCache: cache,
    _supabaseUserIdInflight: inflight,
    SUPABASE_USER_ID_CACHE_TTL_MS: ttlMs,
    SUPABASE_USER_ID_CACHE_MAX: 5000,
    Date: { now: () => now }
  };

  async function supabaseDbRequest(table, query) {
    if (table === 'user_profiles') {
      calls.userProfiles++;
      return { ok: true, data: profileRow };
    }
    if (table === 'user_state') {
      calls.userState++;
      return { ok: true, data: [{ state: { step: 1 }, updated_at: '2026-07-29T00:00:00Z' }] };
    }
    return { ok: false, data: null };
  }

  const factory = new Function(
    'supabaseDbRequest', 'getGpRequestScope', '_supabaseUserIdCache',
    '_supabaseUserIdInflight', 'SUPABASE_USER_ID_CACHE_TTL_MS',
    'SUPABASE_USER_ID_CACHE_MAX', 'Date',
    src
  );

  const api = factory(
    supabaseDbRequest, scopeApi.getGpRequestScope, cache, inflight,
    ttlMs, 5000, scopeApi.Date
  );

  return {
    api, calls, cache, store,
    advance: (ms) => { now += ms; },
    setProfileRow: (r) => { profileRow = r; },
    runScoped: (fn) => store.run({ userIdByEmail: new Map(), userStateByUserId: new Map() }, fn)
  };
}

describe('getSupabaseUserIdByEmail — caching behaviour', () => {
  it('asks the database once for repeated lookups of the same email', async () => {
    const h = buildHarness();
    for (let i = 0; i < 10; i++) {
      expect(await h.api.getSupabaseUserIdByEmail('Doc@Example.com')).toBe('uid-1');
    }
    expect(h.calls.userProfiles).toBe(1);
  });

  it('normalises the email so casing/whitespace share one cache entry', async () => {
    const h = buildHarness();
    await h.api.getSupabaseUserIdByEmail('doc@example.com');
    await h.api.getSupabaseUserIdByEmail('  DOC@Example.COM  ');
    expect(h.calls.userProfiles).toBe(1);
  });

  it('NEVER caches a miss — a signup that creates the row moments later must resolve', async () => {
    const h = buildHarness();
    h.setProfileRow([]);                                   // profile not created yet
    expect(await h.api.getSupabaseUserIdByEmail('new@example.com')).toBe(null);
    h.setProfileRow([{ user_id: 'uid-new' }]);             // signup completes
    expect(await h.api.getSupabaseUserIdByEmail('new@example.com')).toBe('uid-new');
    expect(h.calls.userProfiles).toBe(2);                  // it really re-asked
  });

  it('coalesces concurrent misses into one query', async () => {
    const h = buildHarness();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.api.getSupabaseUserIdByEmail('doc@example.com'))
    );
    expect(results.every((r) => r === 'uid-1')).toBe(true);
    expect(h.calls.userProfiles).toBe(1);
  });

  it('expires after the TTL so a reassigned address cannot stick', async () => {
    const h = buildHarness({ ttlMs: 60000 });
    await h.api.getSupabaseUserIdByEmail('doc@example.com');
    h.advance(59000);
    await h.api.getSupabaseUserIdByEmail('doc@example.com');
    expect(h.calls.userProfiles).toBe(1);
    h.advance(2000);                                       // now past 60s
    await h.api.getSupabaseUserIdByEmail('doc@example.com');
    expect(h.calls.userProfiles).toBe(2);
  });

  it('re-reads after the cache is invalidated', async () => {
    const h = buildHarness();
    await h.api.getSupabaseUserIdByEmail('doc@example.com');
    h.cache.clear();                                       // what invalidate* does
    await h.api.getSupabaseUserIdByEmail('doc@example.com');
    expect(h.calls.userProfiles).toBe(2);
  });
});

describe('user_state — request-scoped only', () => {
  it('reads once per request no matter how many handlers ask', async () => {
    const h = buildHarness();
    await h.runScoped(async () => {
      for (let i = 0; i < 5; i++) await h.api.getSupabaseUserStateByEmail('doc@example.com');
    });
    expect(h.calls.userState).toBe(1);
    expect(h.calls.userProfiles).toBe(1);
  });

  it('does NOT carry state between requests', async () => {
    const h = buildHarness();
    await h.runScoped(() => h.api.getSupabaseUserStateByEmail('doc@example.com'));
    await h.runScoped(() => h.api.getSupabaseUserStateByEmail('doc@example.com'));
    expect(h.calls.userState).toBe(2);   // fresh read each request — this is the point
    expect(h.calls.userProfiles).toBe(1); // but identity was still cached
  });

  it('hands every caller its own copy so one handler cannot corrupt another', async () => {
    const h = buildHarness();
    await h.runScoped(async () => {
      const a = await h.api.getSupabaseUserStateByUserId('uid-1');
      a.state.step = 999;
      a.state.injected = true;
      const b = await h.api.getSupabaseUserStateByUserId('uid-1');
      expect(b.state.step).toBe(1);
      expect(b.state.injected).toBeUndefined();
    });
  });

  it('falls back to a direct read when there is no request scope (crons)', async () => {
    const h = buildHarness();
    const row = await h.api.getSupabaseUserStateByUserId('uid-1');
    expect(row.state.step).toBe(1);
    expect(h.calls.userState).toBe(1);
  });
});

/* ── (C) The client coalescer must never become a cache ────────────── */

describe('js/api-dedupe.js — in-flight only', () => {
  it('drops its entry as soon as the request settles, on success AND failure', () => {
    expect(dedupeSrc).toContain('function () { delete inflight[url]; }');
    // Two handlers: one for fulfilled, one for rejected.
    const drops = dedupeSrc.match(/delete inflight\[url\];/g) || [];
    expect(drops.length).toBeGreaterThanOrEqual(2);
  });

  it('has no TTL, no storage and no stale-while-revalidate', () => {
    // Check the CODE, not the prose — the header comment legitimately says "no TTL".
    const code = dedupeSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/sessionStorage|localStorage/);
    expect(code).not.toMatch(/setTimeout|maxAge|max_age|ttl\b/i);
  });

  it('only ever merges plain same-origin API GETs', () => {
    expect(dedupeSrc).toContain('if (methodOf(init) !== "GET") return false;');
    expect(dedupeSrc).toContain('if (init.signal) return false;');
    expect(dedupeSrc).toContain('if (init.headers) return false;');
    expect(dedupeSrc).toContain('if (init.body !== undefined && init.body !== null) return false;');
    expect(dedupeSrc).toContain('return path.indexOf("/api/") === 0;');
  });
});
