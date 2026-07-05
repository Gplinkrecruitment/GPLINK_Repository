# Handover — Practice Client Pipeline (2026-07-05)

**Status: MERGED to `main` and LIVE in production.** Nothing is blocked on code. What's left is owner-side config (Facebook webhook) and optional live click-testing.

## What this feature is (plain English)

A medical practice fills in a Facebook lead ad → appears on the CEO dashboard as a "Potential Client" → gets an email with a personal link → fills in a click-form (billing, DPA, suburb, earnings, etc.) → signs the Recruitment Services Agreement on the page → moves to "Mainstream Practices" with a job pending admin approval (blocked until a suburb photo is uploaded) → once approved, the job goes live to GPs with the practice name and exact address hidden → GPs see jobs ranked by preferred city, with non-DPA jobs blurred for overseas-trained GPs → when a practice accepts (or admin places a GP directly), the GP gets a confetti congrats page + email with "Secure My Interview," which books a real Zoom interview instantly via the existing 3-way scheduler.

Full spec/build history: `docs/superpowers/plans/2026-07-05-practice-client-pipeline.md`. Operations detail: `docs/practice-client-pipeline.md`.

## Where things stand right now

- **Branch:** `worktree-practice-client-pipeline`, merged into `main` via fast-forward `ea092a5 → c82dee8`. `main` on GitHub is at `c82dee8` (verified via `git ls-remote origin main`).
- **Tests:** 1401/1401 passing, 83 files (`node node_modules/vitest/vitest.mjs run`, run with the local Node at `/tmp/node-v20.18.1-darwin-arm64/bin/node`).
- **Database migration `supabase/migrations/20260705100000_practice_client_pipeline.sql`: APPLIED to prod** via `rpc/exec_sql` (HTTP 204, verified by reading back `intake_token`, `approval_status`, `revealed`/`origin` columns — all present).
- **DPA backfill: DONE.** Owner confirmed all current jobs are DPA-eligible. Ran `UPDATE career_roles SET dpa=true WHERE dpa IS DISTINCT FROM true` — verified all 55 rows now `dpa=true`. **The DPA gate currently blurs nothing** for any existing GP; it only affects future non-DPA pipeline jobs.
- **Deploy verified live** (not just "should be live" — actually checked):
  - `/api/public/jobs` — 0 of 24 live jobs leak `practice_name` (was 24/24 before this deploy).
  - `/pages/practice-intake?token=<bogus>` → 200 (page loads), and `/api/practice-intake?token=<bogus>` → 404 (correctly rejects invalid tokens).
  - `/pages/secure-interview` → 302 (correctly requires GP login).

## Owner correction made mid-session (after the initial build)

Two things the owner flagged and I fixed **before** merging:

1. **Removed a redundant onboarding question.** The original build added a NEW "Where did you complete your GP training? (Australia/Overseas)" question to the 5-step onboarding wizard. The owner pointed out onboarding already captures country (which drives qualification-document uploads), so this was duplicate. Fixed: the question is deleted from `pages/onboarding.html` + `js/onboarding.js`; the server now **derives** `australiaTrained` from `user_profiles.registration_country` (fallback `user_state.gp_selected_country`) via a new helper `_isAustraliaTrainedCountry()` in `server.js` near `_resolveGpJobsProfile` (~line 3312). The pure gate function `gpQualifiesForRole(role, {australiaTrained})` in `lib/practice-pipeline.js` was **not** touched — only how the boolean gets resolved changed. Dropped the now-unused `user_profiles.australia_trained` migration line (it was never applied to prod, so no cleanup needed there).
2. **DPA backfill applied per owner instruction** ("all the jobs we currently have are DPA") — see above.

Commit for this fix: `c82dee8` (`Derive Australia-trained flag from onboarding country, drop redundant question`).

## What's NOT done / needs the owner

1. **Facebook Lead Ads webhook is not wired up yet.** This is the only piece needing Vercel config:
   - Set env vars `FB_LEAD_WEBHOOK_SECRET` and `FB_LEAD_VERIFY_TOKEN` on Vercel.
   - Point the Facebook Lead Ads webhook (or Zapier/Make relay — flat-JSON fallback is supported) at:
     `https://app.mygplink.com.au/api/webhooks/facebook-lead?secret=YOUR_SECRET`
   - Until this is set, `handleFacebookLeadWebhook` (`server.js:8479`) returns 503 — the endpoint is intentionally disabled, not broken.
   - I cannot set Vercel env vars from this machine (per `memory/vercel-api-access.md` — no way to set env vars via MCP; CRON_SECRET etc. unreadable; owner must do this via the Vercel dashboard or by asking the admin dashboard to trigger a redeploy after adding vars).

2. **No live click-through test has been done yet** (of the practice intake form, e-sign, or GP acceptance flow in a real browser). Everything has been verified via curl / API reads + the automated test suite, not a human clicking through. See "How to test" below.

3. **Zoom / Google Calendar / Resend env vars should be double-checked** before anyone clicks "Accept" on a real application — if unset, the congrats email will contain a dead Zoom link. (Untested from this session; verify in Vercel env vars or ask the owner.)

## How to test the practice journey (for whoever picks this up)

**Part A — testable right now, no config needed:**
1. CEO dashboard → **Practices** tab → find a "Potential Client" (stage = `prospective`). **There is currently no admin UI to create one directly** — "Add practice" creates an *active* practice, not prospective, and the edit modal has no stage toggle. To get a testable prospective practice, either:
   - Wait for a real Facebook lead once Part B is wired up, or
   - Seed one directly in the database: insert/patch a `practices` row with `stage='prospective'` and a real `contact_email` you can access (needs Supabase service-key access — see `memory/prod-supabase-service-key-location.md`).
2. On the prospective card, click **"Resend intake email"** → hits `POST /api/ats/practice/resend-intake?id=` → sends a real email via Resend to the practice's contact address, containing `https://app.mygplink.com.au/pages/practice-intake?token=...`.
3. Open that link, fill in the intake form, draw/type a signature, submit.
4. Practice moves to `active`; a new `career_roles` job is created with `approval_status='pending'`, `is_active=false`.
5. CEO → Jobs tab → try to approve → **blocked** until a suburb header photo is uploaded (this is intentional — verify the exact 400 message: "Upload a suburb header photo before approving"). Upload → approve → job goes live, masked.
6. Check `/api/public/jobs` and the in-app GP jobs list — practice name/address should be absent everywhere until acceptance.
7. As a GP (or via admin "Add to a job"), accept the application → `POST /api/ats/application/accept` → GP gets confetti page + congrats email with "Secure My Interview" → verify a real Zoom link is generated (needs Zoom/GCal env vars — see caveat above) → book a slot → confirm it lands in `scheduled_calls`.

**Part B — one-time Facebook setup (owner action):** see item 1 in "What's NOT done" above.

## Key files if you need to touch this code again

- `lib/practice-pipeline.js` — all pure/testable logic (masking, DPA qualification, ranking, redacted stubs, email copy). Start here for logic changes.
- `server.js` — search `practicePipeline\.` and `/api/practice-intake`, `/api/webhooks/facebook-lead`, `/api/ats/application/accept`, `/api/career/interview/slots|book`, `_applyGpRoleVisibilityGate`, `_resolveGpJobsProfile`.
- `pages/practice-intake.html` — public intake + e-sign page.
- `pages/secure-interview.html` — GP-facing instant booking + confetti.
- `lib/practice-agreement-pdf.js` — pdf-lib stamping of the signed agreement.
- `js/ceo-ats-practices.js` — CEO Practices tab (Potential Clients cards, Resend intake, Add practice).
- `supabase/migrations/20260705100000_practice_client_pipeline.sql` — already applied to prod; if you need to add columns, add a NEW migration file, don't edit this one.
- Full memory entry: `memory/practice-client-pipeline-branch.md` (persistent cross-session notes — read this first if picking up later).

## Non-negotiables this session followed (see project `CLAUDE.md`)

Everything above was verified by actually reading back live API responses and DB rows — not assumed. Where something is unverified (Zoom/GCal env, real browser click-through), it's explicitly flagged above rather than claimed done.
