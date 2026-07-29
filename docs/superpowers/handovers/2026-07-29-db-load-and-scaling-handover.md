# Handover — database load / scaling (2026-07-29, updated 2026-07-30)

**Status: fix 1 and fix 2 are IMPLEMENTED, MEASURED and SHIPPED.** The original
analysis (below, still accurate) was measured against the **production** Supabase
database with a local server and a real headless browser. The fix was measured the
same way, before and after, on the same port and the same page.

The owner's original question was *"200 GPs are using the app and hitting the
database continuously — won't this bring the app down?"*, later raised to
*"no crashes or long load times even if 1000 GPs are using the app at once"*.

---

## 0. What shipped, and what it actually bought

Measured A/B, same test GP, same `/pages/index` load, same server port, run
back-to-back against prod Supabase:

| Measurement | Before | After |
| --- | --- | --- |
| **`/pages/index` page load — DB queries** | **69** | **45** (−35%) |
| Duplicate share of those queries | 65% | 49% |
| `user_profiles?select=user_id&email=eq.…` per page load | **24×** | **not in the top repeats** |
| API calls for that same load | 22 | 22 (unchanged — see §A) |
| Fixed 13-endpoint replay, sequential | 33 queries (2.54/endpoint) | 27 (2.08) |
| Fixed 13-endpoint replay, parallel burst | 32 queries (2.46/endpoint) | 25 (1.92) |

At 1000 concurrent doctors this is a ~35% cut in database traffic for the same
user-visible behaviour, and it removes the single hottest query in the app.

**Full suite: 4198/4199 passing.** The one failure (`audit-breadth > manual
placement`) is pre-existing flakiness — verified by running it on unmodified
`origin/main`, where it also fails roughly 1 in 4 runs. It is a 30s timeout, not
an assertion failure.

### What was built

1. **`getSupabaseUserIdByEmail` is layered** (`server.js`, above `supabaseDbRequest`):
   request-scoped memo → 60s process TTL cache → in-flight coalescing → database.
   - **Negative results are NEVER cached.** During signup the row appears moments
     after the first miss; caching "no such user" would strand the doctor. There
     is a test for this.
   - **Invalidation is hooked onto the transports, not the call sites.** Any
     non-GET to `user_profiles` through `supabaseDbRequest` drops the whole cache;
     any non-GET to `admin/users` through `supabaseAuthAdminRequest` does too (auth
     deletes cascade to `user_profiles` without touching the DB transport); and the
     raw-fetch `supabaseAuthAdminDeleteUser` invalidates explicitly. Clearing
     broadly on a rare write is much cheaper than reasoning about which key went
     stale — and a stale identity cache is a cross-account data leak.
2. **`user_state` is memoized per request only** — `AsyncLocalStorage`, installed
   by wrapping `handleRequest` (both the local server and the Vercel export go
   through it). New `getSupabaseUserStateByUserId(userId)` does the work;
   `getSupabaseUserStateByEmail` delegates. Every caller gets its **own copy** of
   the state object, because callers routinely read-modify-write it.
   **There is deliberately no cross-request user_state cache. Do not add one.**
3. **Six unguarded call sites** now prefer `getSessionSupabaseUserId(session)`.
4. **`js/api-dedupe.js`** (new) — collapses duplicate **in-flight** API GETs per
   document. No storage, no TTL: the entry is dropped the moment the request
   settles, so a GET issued after a write can never be merged with one from
   before. Loaded by 21 pages + precached in `sw.js`.
5. **`tests/scale-identity-cache.test.js`** — 18 tests: source wiring, real
   extracted-function behaviour (caches positives, never negatives, coalesces,
   expires, invalidates, copies state), and guards that `api-dedupe.js` never
   grows into a cache.

---

## A. Why the API-call count did NOT move, and what to do next

This is the most important correction to the original analysis below.

The original §5.2 predicted that reading `user_state` once per request would remove
~22 queries per page load. **That was wrong, and the reason matters.** Measured:
a page load makes ~22 API calls and issues ~21 `user_state` reads — i.e. very close
to **one per request, in 21 different requests**. A request-scoped memo cannot
merge those; it only helps the handlers that read state 2–3× in a single request
(`POST /api/support/tickets` reads it 3×, `PUT /api/state` twice). Those are fixed,
but they are a small share.

**So the remaining `user_state` cost can only be reduced by making fewer API
calls.** Where the duplication actually comes from — verified by frame:

- `js/state-sync.js` and `js/updates-sync.js` are loaded by the **app shell**, the
  **visible iframe**, AND a **hidden warm-prefetch iframe**
  (`js/app-shell.js` `warmRoute()` → `#appShellFrameSecondary`). Each document
  independently runs its own timers, so `/api/state`, `/api/user/nudges` and
  `/api/gp/alerts/read-state` each fire ~3–4× per page load.
- `js/api-dedupe.js` is **per-document** and cannot see across frames, so it does
  not collapse these. It collapses same-document bursts, which under production
  latency (AU→US-East, 140–330ms per call — locally it is ~5ms, so a local test
  will show little) is where `/api/state` ×3-within-41ms and
  `/api/career/applications` ×2-within-17ms land.
- `/api/prepared-documents` ×3 and `/api/gplink-docs-status` ×2 are *within* the
  `my-documents` document — `bootDocumentModule()` runs three times per load.

**Highest-value next step:** stop the hidden warm iframe (and ideally embedded
pages generally) from running the background pollers, since the shell already
polls and an embedded page's own nav/bell is hidden. That is worth ~2/3 of those
calls. It was deliberately NOT done in this pass because it changes notification
behaviour and needs its own end-to-end verification of the bell/alerts UX.

**Do NOT solve this by routing more GETs through `js/gp-cache.js`.** Verified:
only two invalidation call sites exist in the whole codebase, both for
`/api/career/applications`. Every `/api/state` write is a raw `PUT` that
invalidates nothing, so giving `/api/state` a 30s cached tier would serve a doctor
their pre-write state. (`/api/gplink-docs-status` already has this latent bug — it
sits in the `state` tier and none of its writers invalidate it.)

---

## 1. The headline (original analysis — still correct)

**Continuous background polling is NOT the problem.** A logged-in doctor's app
polls 2 endpoints every 3 minutes, and only while the tab is visible
(`js/updates-sync.js`, 180000 ms). 200 doctors idling ≈ 2 requests/second.
Ignore polling; it is already well-behaved. Do not "optimise" it.

**Page loads are the problem, and it is duplication, not volume.** For one doctor
loading one page, the server asked the database *"which user is this email?"*
**twenty-four times**. The answer was identical every time. That is what §0 fixed.

---

## 2. What this means at scale — and what it does NOT mean

**No load test was run, so this document does not contain a breaking point.**
Do not let anyone quote one from it. What is predictable is the failure *shape*:

1. Pages get slower first. Each Supabase call measured **140–330 ms** of round trip
   from a dev laptop, and the calls run **sequentially** inside a request.
2. Then requests hit the **10-second abort** in `supabaseDbRequest`
   (`AbortController` + `setTimeout(..., 10000)`), surfacing as
   `502 Failed to reach Supabase database service`.
3. Then bursts fail — e.g. everyone opening the app after a broadcast email.

Second pressure point: **~22 API calls per page load** means ~22 Vercel function
invocations per render. It scales, but you pay for it, and cold starts parse a
**69,000-line `server.js`**. Cutting the cross-frame duplication in §A is the
lever that reduces *invocations*; §0 reduced *queries*.

---

## 3. Things that are already FINE — do not "fix" these

- **Indexes are fine.** `user_profiles.email` is `text not null unique` → unique
  index. The hot lookups were index hits. The database was never struggling; it
  was being asked the same thing repeatedly.
- **No connection-pool exhaustion.** `supabaseDbRequest` talks to PostgREST over
  HTTPS via `fetch`; there is no pg pool in this app to exhaust.
- **Polling cadence** — see §1. Leave it alone.
- **The consult-lead nudge cron's per-lead existence check**
  (`getSupabaseUserIdByEmail` inside the sweep loop) *looks* like an N-queries-per-
  tick bug and is not: it only runs when a nudge is actually due or once at
  exhaustion, and the sweep is time-boxed. The comments there explain it. Leave it.
- **Admin/CEO dashboards poll hard** (15s / 30s). That is a handful of staff, not
  1000 people. Lower priority than the GP path.

### Prior scale work — already done, do not redo

- **`1fe3825` chunked PostgREST id lists** (`SUPABASE_IN_CHUNK_SIZE = 200`,
  `supabaseDbRequestByIds`). Different problem — long `id=in.(…)` lists.
- **`js/perf-cache.js`** warms **STATIC ASSETS**, not API responses.

---

## 4. Root cause, precisely (as originally found)

```
getSupabaseUserIdByEmail(email)    → user_profiles?select=user_id&email=eq.<email>
getSupabaseUserStateByEmail(email) → calls the above  ← query #1
                                   → user_state?…     ← query #2
```

Every state read cost two queries, and most of the email lookups were generated by
state reads. The session cookie already carried the answer
(`getSessionSupabaseUserId`), and 83 call sites used it while 18 did not.

---

## 5. Remaining work, in order

1. **Cut the cross-frame duplicate pollers** (§A). Biggest remaining win; reduces
   Vercel invocations as well as queries. Needs bell/alerts UX verification.
2. **Collapse the page's API calls into a bootstrap endpoint** — one "everything
   this page needs" response instead of ~22 round trips. Bigger job, real
   front-end changes.
3. **Cache genuinely shared data** (role listings, practice rows — identical for
   every doctor). Safe for non-per-user data only. Read §8 first.
4. **Upgrade the Supabase plan** — last, as headroom. Paying more to serve traffic
   that shouldn't exist is the expensive way round.

---

## 6. How to reproduce the measurement (do this before AND after)

Harnesses used for this pass (rebuild them the same way; they live in the job tmp
dir, not the repo):

- **`probe.cjs`** — wraps global `fetch`, appends every `/rest/v1/` call to a log.
  Load with `node --require probe.cjs server.js`. It also parses `.env` itself,
  because `source .env` in zsh dies on an unquoted value containing a comma.
- **`replay.cjs`** — the deterministic one. Mints a session cookie, hits a fixed
  list of 13 page-load GET endpoints (sequential or parallel), counts probe lines.
  No browser, so no variance. **Use this for before/after.**
- **`measure.cjs`** — real headless Chrome via `puppeteer-core`, for the true
  page-load figure. Browser runs vary run-to-run (22–30 API calls) because the
  shell warms different secondary routes; do not read small deltas from it.

Boot: `PORT=<yours> RESEND_API_URL=http://127.0.0.1:9/none node --require probe.cjs server.js`
(the bogus Resend URL stops real emails — this is the **live** database; GETs are
safe, be careful with anything that writes).

---

## 7. Environment gotchas that cost time

- **No `node` on PATH.** Copy one into `$CLAUDE_JOB_DIR/tmp` and symlink the main
  checkout's `node_modules` into the worktree. `puppeteer-core` is **not** in
  `node_modules`; install it into the job dir, not the repo.
- **Pick a unique port.** Parallel background jobs run their own server on 3100.
  A second boot silently fails with `EADDRINUSE` and your "baseline" then measures
  the *other* job's server — this happened here and produced a run where baseline
  and after were byte-identical. Always confirm the boot log says
  "GP Link server running", and check `lsof -nP -iTCP:<port>` if the numbers look
  odd. Never `pkill -f server.js` — it kills other jobs' servers.
- **`git stash push <path>` fails silently if any pathspec is untracked** (the
  whole command aborts). Check `git stash list` grew before trusting a baseline.
- **New static files must live under an allowed directory.** `serveStatic` gates on
  `isPubliclyServablePath` → `PUBLIC_STATIC_DIRS`. `js/` is allowed. A file that
  404s in the browser but exists on disk usually means you are talking to the
  wrong server (see the port note).
- **Bump `sw.js` VERSION when page HTML changes**, or the service worker serves the
  old HTML one navigation late and your new `<script>` tag appears not to load.
- **Service-role key is in `.env`, not `.env.prod`.**
- **`users` is not a table.** Identity lives in `user_profiles`. `gp_applications`
  has no `email` and no `created_at`.
- **Session cookie** (`gp_session`), signed with `AUTH_SECRET`:
  `payload = base64url(JSON.stringify({ userProfile: { email, supabaseUserId, firstName, lastName }, expiresAt }))`
  then `cookie = payload + '.' + hmac_sha512_hex(AUTH_SECRET, payload)`.
  If the user has a positive `user_session_epoch`, include `epoch` in the claims.
- **`/api/health`** returns `commit` from `VERCEL_GIT_COMMIT_SHA` — the only
  reliable "did my push go out?" check.
- **`main` moves hourly.** Rebase, then `git diff --stat origin/main..HEAD` and
  confirm it lists only your files before pushing.

---

## 8. Deliberate decisions — do not reverse these

- **`/api/career/role` is `no-store` when the payload carries `match` or
  `matchAccepted`** (`PRIVATE_VOLATILE_HEADERS`), and `readCachedRoleDetail` in
  `pages/job.html` refuses any cached entry carrying match state. Both landed in
  `4e87aec` to fix a real owner-reported bug (accept a match → refresh → the accept
  buttons came back). Ordinary role payloads keep the 60s private cache
  deliberately — that split is the fix, not an oversight.
- **The 10-minute `localStorage` role cache stays.** The rule is *what* it may
  hold, not whether it exists.
- **No cross-request `user_state` cache**, and **`js/api-dedupe.js` stays
  in-flight-only**. Both are guarded by tests.

---

## 9. Where things live

| Thing | Location |
| --- | --- |
| Identity cache + request scope + invalidation hooks | `server.js`, immediately above `supabaseDbRequest` |
| Supabase HTTP layer (+ 10s abort) | `supabaseDbRequest` |
| Email → user id (was the 24× query) | `getSupabaseUserIdByEmail` |
| State by user id / by email | `getSupabaseUserStateByUserId` / `…ByEmail` |
| Request scope wrapper | `handleRequest` → `handleRequestInner` |
| Session-embedded user id | `getSessionSupabaseUserId` |
| Client in-flight coalescer | `js/api-dedupe.js` |
| Client SWR cache (careful — see §A) | `js/gp-cache.js` |
| Regression tests | `tests/scale-identity-cache.test.js` |
| GP nudge polling (3 min) | `js/updates-sync.js` |
