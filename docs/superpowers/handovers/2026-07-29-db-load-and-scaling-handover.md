# Handover — database load / scaling to ~200 concurrent GPs (2026-07-29)

**Status: analysis done and measured. No fix implemented yet.** Everything below
was measured against the **production** Supabase database with a local server and
a real headless browser — none of it is estimated, and none of it is from reading
code alone. The numbers are reproducible; §6 tells you exactly how.

The owner's question was: *"200 GPs are using the app and hitting the database
continuously — won't this bring the app down? What's the fix?"*

---

## 1. The headline

**Continuous background polling is NOT the problem.** A logged-in doctor's app
polls **2 endpoints every 3 minutes**, and only while the tab is visible
(`js/updates-sync.js:915`, 180000 ms). 200 doctors idling ≈ **2 requests/second**.
Ignore polling; it is already well-behaved. Do not "optimise" it.

**Page loads are the problem, and it is duplication, not volume.**

| Measured (one doctor, one page load) | Value |
| --- | --- |
| `/pages/index` | **35 API calls → 74–102 DB queries** |
| `/pages/career` | 36 API calls → 86 DB queries |
| `/pages/application-detail` | 19 API calls → 63 DB queries |
| Byte-identical repeats within ONE `/pages/index` load | **52 of 74 = 70%** |
| `user_profiles?select=user_id&email=eq.…` | **× 26** |
| `user_state?select=state,updated_at&user_id=eq.…` | **× 23** |

For one doctor loading one page, the server asks the database *"which user is this
email?"* **twenty-six times**. The answer is identical every time.

(74 vs 102 on `/pages/index` is normal run-to-run variance — background nudge
polling and state-sync pushes land differently. Both runs showed the same ~70%
duplication.)

---

## 2. What this means at 200 GPs — and what it does NOT mean

Assumption stated openly: active use ≈ one page load per doctor every ~30 s.
That gives ~7 page loads/sec → **~500–700 DB queries/sec, ~70% of it waste**.

**I did not run a load test, so I cannot tell you the exact number of users where
it breaks.** That depends on the Supabase plan, which I did not check. Do not let
anyone quote a breaking point from this document — it is not in here.

What *is* predictable is the failure shape. It does not crash suddenly:

1. Pages get slower first. Each Supabase call measured **140–330 ms** of round
   trip (from a dev laptop; from Vercel it will be lower but non-zero), and the
   calls run **sequentially** inside a request.
2. Then requests start hitting the **10-second abort** in `supabaseDbRequest`
   (`server.js:18506`, `AbortController` + `setTimeout(..., 10000)`), which
   surfaces as `502 Failed to reach Supabase database service`.
3. Then bursts fail — e.g. everyone opening the app after a broadcast email.

Second pressure point: **35 API calls per page load** means each page render is
~35 Vercel function invocations. 200 doctors navigating at once is thousands of
concurrent invocations. It scales, but you pay for it, and cold starts parse a
**69,000-line `server.js`**.

---

## 3. Things that are already FINE — do not "fix" these

Verified, so nobody burns a day re-investigating:

- **Indexes are fine.** `user_profiles.email` is `text not null unique`
  (`supabase/migrations/20260225014500_init_gp_link.sql:6`) → unique index.
  `user_state.user_id` must be unique too — the code upserts with
  `on_conflict=user_id`. The hot lookups are index hits on a 9-row table.
  **The database is not struggling. It is being asked the same thing repeatedly.**
- **No connection-pool exhaustion.** `supabaseDbRequest` talks to PostgREST over
  HTTPS via `fetch`; Node 18+/undici keeps connections alive per warm process.
  There is no pg connection pool in this app to exhaust.
- **Polling cadence** — see §1. Leave it alone.
- **Admin/CEO dashboards poll hard** (`pages/admin.html:9507` every 15 s;
  `pages/ceo-dashboard.html:3126` every 30 s). That is a handful of staff, not
  200 people. Lower priority than the GP path, but worth a look afterwards.

### Prior scale work — already done and on `main`, do not redo

- **`1fe3825 perf(scale): chunk PostgREST id lists + raise caps that silently
  truncated`** (from the `scale-to-700-gps` branch, already merged). That fixed a
  *different* problem — long `id=in.(…)` lists. See `SUPABASE_IN_CHUNK_SIZE = 200`
  (`server.js:32013`) and `supabaseDbRequestByIds`. It does **not** touch the
  duplication described here, and the two changes do not conflict.
- **`js/perf-cache.js`** is a **service worker warming STATIC ASSETS** (shell HTML
  and JS bundles) — not API responses, not data. Nobody should read "there's
  already a cache" and assume this problem is handled. It isn't.

---

## 4. Root cause, precisely

Two functions, and **the second one calls the first**, which is why the two
counts track each other:

```
server.js:26563  async function getSupabaseUserIdByEmail(email)
                   → user_profiles?select=user_id&email=eq.<email>&limit=1

server.js:26579  async function getSupabaseUserStateByEmail(email)
                   → calls getSupabaseUserIdByEmail(email)   ← query #1
                   → user_state?select=state,updated_at&…    ← query #2
```

So **every state read costs two queries**, and ~23 of the 26 email lookups are
generated by state reads. Fix the email lookup and you fix most of both.

Why it is called so often despite the session already knowing the answer: the
signed session cookie carries `userProfile.supabaseUserId`
(`getSessionSupabaseUserId`, `server.js:28165`). The correct pattern is used in
**70** places:

```js
const uid = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
```

but there are **102 occurrences** of `getSupabaseUserIdByEmail(` in `server.js`.
That leaves **31 unguarded call sites** (102 − 70 − 1 definition) that always hit
the database even when the session already has the ID. Sample:

```
server.js:3774, 13109, 13187, 27988, 35785, 35810, 37883, 42158, 46060, 49019
```

`getSupabaseUserStateByEmail` (26579) is the highest-traffic one by far.

---

## 5. The fix, in order — do 1 and 2 first

### 1. Memoize `getSupabaseUserIdByEmail` (biggest win, smallest diff)

An email → user UUID mapping. One function to change.
Expected: **removes ~26 of ~74 queries per page load on its own (~35%).**

**Correctness risk — this is the part to get right, do not skip it.** The mapping
is *not* immutable forever:

- Account deletion / purge exists (`supabase/migrations/20260614120000_account_deletion.sql`).
- An email could in principle be reassigned after a delete.

So: short TTL (**60 s is plenty** — it only needs to survive a single page load),
plus explicit cache invalidation on the account-deletion and any
email-change/user-creation paths. A permanent unbounded cache is **wrong** and
will produce a cross-account data leak, which is exactly the class of bug
`PRIVATE_METADATA_CACHE_HEADERS` (`server.js:11156`) was introduced to fix — read
that comment before designing this. Key the cache on the normalized
(trimmed, lowercased) email, same as the function already does.

Also worth doing in the same pass: fix the 31 unguarded call sites to prefer
`getSessionSupabaseUserId(session)` where a session is in scope. That is free —
no cache needed, no staleness possible.

### 2. Read `user_state` once per request

Expected: removes ~22 more queries per page load. Together with (1):
**~100 queries/page → ~25, roughly a 70% cut in DB traffic.**

**Important difference from (1):** `user_state` **does** change — `state-sync.js`
pushes updates and there are `POST user_state?on_conflict=user_id` writes. A
cross-request TTL cache here is **not safe**. Use **request-scoped** memoization
(e.g. a per-request context object, or `AsyncLocalStorage`) so a single request
reads it once, and every new request reads fresh. Do not copy the approach from
(1) blindly.

### 3. Collapse the 35 API calls per page into a bootstrap endpoint

One "everything this page needs" response (profile + state + nudges + cases)
instead of 35 round trips. Cuts function invocations 3–5×. Bigger job, real
front-end changes, do it after 1 and 2 land and are verified.

### 4. Cache genuinely shared data in memory

Role listings and practice rows are identical for every doctor but fetched per
person. Short-TTL process-level cache is safe here (no per-user data), but note
the app already has client-side caches with a 10-minute TTL — **read the
2026-07-29 fix first** (`readCachedRoleDetail` in `pages/job.html`, commit
`4e87aec`): volatile per-user state must **never** be served from a cache.
Static role copy may be; "have I accepted this match?" may not.

### 5. Upgrade the Supabase plan

Do this **last**, as headroom. Paying more to serve traffic that shouldn't exist
is the expensive way round.

---

## 6. How to reproduce the measurement (do this before AND after)

Get a real before/after number rather than trusting the change. There is no Node
on this machine's PATH — download one to `$CLAUDE_JOB_DIR/tmp` and symlink the
main checkout's `node_modules` into the worktree.

**Probe** — wraps global `fetch` and logs every PostgREST call. Load it with
`node --require probe.cjs server.js`:

```js
// probe.cjs
const fs = require('fs');
const LOG = process.env.PROBE_LOG || '/tmp/probe.log';
const orig = globalThis.fetch;
globalThis.fetch = function (url, opts) {
  try {
    const u = String(url && url.url ? url.url : url);
    if (u.includes('/rest/v1/')) {
      const table = u.split('/rest/v1/')[1].split('?')[0];
      fs.appendFileSync(LOG, ((opts && opts.method) || 'GET') + ' ' + table +
        ' :: ' + u.split('/rest/v1/')[1].slice(0, 150) + '\n');
    }
  } catch (e) {}
  return orig.apply(this, arguments);
};
```

**Run it:**

1. `cp "<main checkout>/.env" .env.local-test` — the service-role key lives in
   `.env`, **not** `.env.prod`. Delete `.env.local-test` when done; never commit it.
2. Boot: `PROBE_LOG=… PORT=3100 RESEND_API_URL=http://127.0.0.1:9/none \
   node --require probe.cjs server.js`
   (the bogus `RESEND_API_URL` stops real emails going out — this is the **live**
   database, GETs are safe, be careful with anything that writes).
3. Mint a session cookie for a test user. The local `AUTH_SECRET` works for the
   local server; it is **not** production's, so you cannot forge prod sessions.
   HMAC-SHA512 over the base64url payload — see §7 for the exact shape.
4. Drive it with headless Chrome at
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` via
   `puppeteer-core`. **The app pages run inside the app-shell iframe** — pick the
   frame whose URL matches `/pages/<name>` AND `gp_shell_static=1`, or you will
   silently query the shell and every element lookup returns null.
5. Truncate the log, load the page, wait ~4 s for background calls, then count
   total lines vs `new Set(lines).size` for the duplication figure.

**Suggested regression test:** assert the query count for a page load and fail if
it climbs. Without it this creeps straight back as features get added. The
existing suite is mostly static source greps plus real-HTTP tests — see
`tests/matching-job-unmask.test.js`, which already boots a server and can now
assert response headers (`httpReq` returns `headers` as of `4e87aec`).

---

## 7. Environment gotchas that cost time

- **No `node` on PATH.** Download one to `$CLAUDE_JOB_DIR/tmp`
  (`nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz`) and
  `ln -s "<main checkout>/node_modules" node_modules` in the worktree.
- **Service-role key is in `.env`, not `.env.prod`.**
- **`users` is not a table.** User identity lives in `user_profiles`
  (`select=user_id&email=eq.…`). `gp_applications` has **no** `email` and no
  `created_at` column — join via `user_id`, order by `applied_at`/`updated_at`.
- **Session cookie shape** (`gp_session`), signed with `AUTH_SECRET`:
  ```
  payload = base64url(JSON.stringify({
    userProfile: { email, supabaseUserId, firstName, lastName },
    expiresAt: <ms epoch>
  }))
  cookie  = payload + '.' + hmac_sha512_hex(AUTH_SECRET, payload)
  ```
- **`/pages/job.html` 302s to `/pages/job`**, and unauthenticated requests land on
  `/pages/signin?next=…`. You cannot verify a deploy by grepping an app page
  anonymously — use **`/api/health`**, which returns `commit` from
  `VERCEL_GIT_COMMIT_SHA` (`server.js:34218`). That is the only reliable
  "did my push go out?" check.
- **`main` moves hourly.** Always `git fetch origin main`, rebase, then
  `git diff --stat origin/main..HEAD` and confirm it lists **only** your files
  before pushing. A stale worktree once showed 46 files / 1379 deletions of other
  people's work.

---

## 8. Deliberate decisions — do not reverse these

- **`/api/career/role` is `no-store` when the payload carries `match` or
  `matchAccepted`** (`PRIVATE_VOLATILE_HEADERS`, `server.js:11167`), and
  `readCachedRoleDetail` in `pages/job.html` refuses any cached entry carrying
  match state. Both landed in `4e87aec` to fix a real owner-reported bug (accept a
  match → refresh → the accept buttons came back). **Any caching work in §5 must
  not re-cache these.** Ordinary role payloads keep the 60 s private cache
  deliberately — that split is the fix, not an oversight.
- **The 10-minute `localStorage` role cache stays.** It exists to make static role
  copy feel instant. The rule is *what* it may hold, not whether it exists.

---

## 9. Where things live

| Thing | Location |
| --- | --- |
| Supabase HTTP layer (+ 10 s abort) | `server.js:18506` |
| Email → user id (the 26× query) | `server.js:26563` |
| State by email (calls the above) | `server.js:26579` |
| Session-embedded user id | `server.js:28165` |
| Cache header constants | `server.js:11156` (cached) / `:11167` (no-store) |
| Deploy/commit check | `server.js:34218` → `GET /api/health` |
| GP nudge polling (3 min) | `js/updates-sync.js:915` |
| Admin poll (15 s) / CEO poll (30 s) | `pages/admin.html:9507`, `pages/ceo-dashboard.html:3126` |
| Client role caches | `pages/job.html` `readCachedRoleDetail` / `writeCachedRoleDetail` |

---

## 10. Suggested order of work

1. Reproduce the baseline (§6) and record the numbers. **Do not skip this** — you
   need your own before-figure to prove the after-figure.
2. Fix 1 — memoize the email lookup with a 60 s TTL + deletion-path invalidation;
   fix the 31 unguarded call sites.
3. Re-measure. Expect ~74 → ~48 queries on `/pages/index`.
4. Fix 2 — request-scoped `user_state`.
5. Re-measure. Expect ~25.
6. Add the query-count regression test.
7. Full suite (`npx vitest run`, 254 files / 4135 tests green as of `4e87aec`),
   then push to `main` — auto-deploys, verify via `/api/health`.
8. Only then consider §5.3–§5.5.
