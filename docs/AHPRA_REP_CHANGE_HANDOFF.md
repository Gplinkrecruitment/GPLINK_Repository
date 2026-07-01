# AHPRA Rep-Change (ANOM-00) + AHPRA Correspondence Task-Creation — Session Handover

**Date:** 2026-07-02
**Author session branch:** `worktree-ahpra-rep-change-anom00` (git worktree at `.claude/worktrees/ahpra-rep-change-anom00`, base `origin/main` @ `0a5fb5b`).
**Purpose:** Give a *parallel* session enough context to (a) understand the ANOM-00 change-of-representative feature being built here, and (b) independently **test AHPRA correspondence task creation** without stepping on this build.

> ⚠️ Two different "AHPRA task" systems exist — don't confuse them:
> 1. **`ahpra_correspondence`** — the EXISTING 6-card system (SHIPPED to prod). Created when an AHPRA officer *emails in*. This is what "AHPRA correspondence task creation" refers to.
> 2. **`ahpra_rep_change`** — the NEW task type this branch adds. Created when a mid-AHPRA doctor is *reassigned* to a new RSO. Not yet wired (Task 6 of the plan).

---

## 1. What THIS session is building (ANOM-00 rep-change)

When a doctor already mid-AHPRA (an AHPRA officer/rep is on the case) is **reassigned to a new RSO**, AHPRA still lists the old RSO as authorised representative. AHPRA requires a signed **ANOM-00** to change that. This feature automates it: auto-create a task for the new RSO → RSO pre-fills + signs Section B in-app → doctor completes Section A + signs on an in-app page → `pdf-lib` overlays both onto the official form → emailed to the doctor's **assigned AHPRA officer** → the per-case "pinned rep mailbox" flips to the new RSO only on AHPRA confirmation.

- **Spec:** `docs/superpowers/specs/2026-07-02-ahpra-rep-change-anom00-design.md`
- **Plan (9 TDD tasks):** `docs/superpowers/plans/2026-07-02-ahpra-rep-change-anom00.md`
- **Clickable prototype (UI source of truth):** `docs/mockups/anom00-rep-change-prototype.html` (open in a browser; deep-links `#s1`…`#s9`).

### Build progress (this branch)
- ✅ **Task 1** — data model migration (`supabase/migrations/20260702120000_ahpra_rep_change.sql`) + `ahpra_rep_change` task type + tests. **DDL NOT yet applied to prod** (deferred to ship time; re-derive the CHECK list from the LIVE constraint then).
- ✅ **Task 2** — `lib/anom00.js` pdf-lib fill engine + calibrated `ANOM00_FIELDS` + committed template `assets/anom00-template.pdf` + 7 unit tests.
- ⏳ **Tasks 3–9 pending:** signature pad, RSO onboarding, RSO task card, **auto-trigger on reassignment (Task 6)**, doctor email + page, pinned-mailbox wiring, full-suite + review.
- Baseline suite green at start: **894 tests**. Ledger: `.superpowers/sdd/progress.md`.

### OPEN owner decision (blocks only Task 7's final send)
How the finished form is emailed to AHPRA — a `mailto:` can't pre-attach a PDF. **Default:** server sends to the assigned officer from the new RSO's rep mailbox, Reply-To the doctor, CC doctor+RSO. Owner may prefer manual download+attach, and/or CC `authreps@ahpra.gov.au`.

---

## 2. How to test AHPRA **correspondence** task creation (the existing `ahpra_correspondence` 6-card system)

This is the SHIPPED prod system (see memory `ahpra-6card-source-of-truth`, and `docs/AHPRA_6CARD_HANDOFF.md`). It can be tested on `origin/main` OR on this branch (this branch hasn't touched it).

**Server anchors (grep, line numbers drift):**
- `_processAhpraEmail(emailMeta, sourceMsgId, preMatchedCase)` — the classifier/front door. Creates the `ahpra_correspondence` card (writes `description:`, not the old broken `detail:`), with idempotency on `source_gmail_message_id` / `gmail_thread_id`, a confidence gate (`ahpraConfidentMatch`), and stores `source_gmail_message_id`/`gmail_thread_id`/`email_sender`.
- `ahpraConfidentMatch(triage)` — exported in `__testUtils`.
- `lib/email-triage.js` — `triageAhpraEmail`, `AHPRA_RESPONSE_TYPES`, `parseAhpraTriageResponse` (the AI classifier: response_type, confidence, matched_gp_user_id, officer info, needs_triage).
- Dispatch site: inside the Gmail message loop, `await _processAhpraEmail(...)` (AWAITED). The legacy s80 auto-bundle no longer fires on inbound mail; inline `email_triage` skipped for AHPRA.
- Cron backstop: `GET /api/cron/process-gmail` — search `ahpraReconcile` (re-pulls open `ahpra_correspondence` threads).

**Preconditions for a card to be created:**
- A GP whose `registration_cases` row is `status in (active,in_progress)` and `stage in (ahpra,career,pbs,commencement)`.
- Sender `@ahpra.gov.au` OR in `TEST_WATCH_FROM_SENDERS`; mail lands in a watched mailbox.

**Test paths:**
- **Unit (offline, no creds):** `NODE=/tmp/node-v20.18.1-darwin-arm64/bin/node; $NODE node_modules/vitest/vitest.mjs run` — look for the ahpra-6card / email-triage tests. `$NODE node_modules/vitest/vitest.mjs run tests/ahpra-6card.test.js`.
- **DB check (read-only, REST — `exec_sql` returns void):** read `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env` (NOT `.env.prod`), then:
  ```bash
  curl -s "$SUPABASE_URL/rest/v1/registration_tasks?select=id,title,case_id,status,task_type&task_type=eq.ahpra_correspondence&order=created_at.desc&limit=10" \
    -H "apikey: $SVC" -H "Authorization: Bearer $SVC"
  ```
  Matched cards have `case_id NOT null` (pre-fix there were ZERO).
- **Live end-to-end (needs a real/allow-listed inbound `@ahpra.gov.au` email — NOT verifiable from this machine):** send an AHPRA-style email naming the GP → expect exactly ONE `ahpra_correspondence` card on the RSO Ops Queue, no duplicate. This is the one thing that can't be faked here.

---

## 3. How the NEW `ahpra_rep_change` task creation will work (this branch, once Task 6 lands)

- **Trigger:** `PATCH /api/admin/ops/case` when `assigned_va` changes AND the case is mid-AHPRA (`stage ∈ {ahpra,career,pbs,commencement}`) AND already has a rep/officer (`ahpra_officer_email` or `ahpra_auth_rep_email` set). Predicate: `shouldTriggerRepChange(prevCase, nextAssignedVa)` (will be in `__testUtils`). Idempotent via `_ensureRepChangeTask`.
- **Task shape:** `task_type:'ahpra_rep_change'`, assigned to the new RSO, `metadata.rep_change_state = 'awaiting_rso_sign'`, `prev_rso_user_id`, `new_rso_user_id`.
- **Constraint:** `ahpra_rep_change` must be in the live `registration_tasks_task_type_check` — the migration adds it but **prod apply is deferred**, so on prod today an insert of this type would 42703-fail until the DDL is applied. Apply the migration before live-testing rep-change task creation on prod.
- **Test now (offline):** `$NODE node_modules/vitest/vitest.mjs run tests/ahpra-rep-change.test.js` (Task 1 tests pass; trigger tests arrive with Task 6).

---

## 4. Environment / gotchas (both systems)

- **No system node/npm/gh/vercel CLI.** Temp node: `/tmp/node-v20.18.1-darwin-arm64/bin/node`. Vitest: `$NODE node_modules/vitest/vitest.mjs run`. Syntax: `$NODE --check server.js`.
- **This is a git worktree.** A different session working on the SAME feature should `cd` into `.claude/worktrees/ahpra-rep-change-anom00` (its `node_modules` is symlinked from the main checkout). A session testing the SHIPPED `ahpra_correspondence` flow can work on `origin/main` instead.
- **Repo is CommonJS** (`module.exports`); tests default-import lib modules (`import pkg from '../lib/x.js'`).
- **PDF rendering to view a filled ANOM-00:** no poppler / Chrome-PDF-screenshot / pdf.js-headless here. BUT the Read tool renders PDFs natively when called WITHOUT a `pages` arg (≤10 pages). Use that. A 50pt coordinate-grid overlay harness lives in the job tmp during the author session.
- **Supabase:** only REST creds in `.env` (service key). `rpc/exec_sql` returns void — verify via PostgREST REST. Live `registration_tasks_task_type_check` has DRIFTED from migration files before — read it live before rebuilding.
- **Push:** `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push`. Prod = push `origin/main` → Vercel auto-build.
- **Related memories:** `ahpra-6card-source-of-truth`, `ahpra-conflict-officer-letter`, `ahpra-s80-followup-tasks`, `sppa-alt-supervisor-cv-request` (task-type constraint drift).

---

## 5. TL;DR for the parallel session
- Want to test **AHPRA correspondence task creation** (the shipped 6-card system)? → §2. It's independent of this branch; safe to test on `origin/main`. The only un-fakeable part is a real inbound `@ahpra.gov.au` email.
- Want to test the **new rep-change** task creation? → §3, but apply the deferred DDL first, and it's only wired after plan Task 6.
- Don't merge/rebase this branch or apply its migration to prod without checking with the author session — the build is mid-flight (Tasks 3–9 pending).
