# Handover — AHPRA s80 "request for more information" improvements

**Date:** 2026-07-01
**Branch:** `worktree-ahpra-s80-improvements` (worktree at `.claude/worktrees/ahpra-s80-improvements`)
**Status:** ✅ All 5 phases COMPLETE, reviewed (whole-branch Opus review = **READY TO MERGE**), fully pushed. **NOTHING merged to prod.**
**HEAD:** `1067943` · **Merge-base with origin/main:** `e3229f8` · **34 commits on branch**

---

## 1. Plain-English summary (for the owner)

This branch upgrades the AHPRA "Notice to provide further information" (section 80) step so it is faster, clearer for the doctor, and lighter on the admin team. When AHPRA asks for more documents, the system now:

- **Reads the letter with AI** and splits it into individual to-do items, each with a confidence score the admin can see before releasing it.
- Lets the admin set, per item, **who does it** (the GP, or our team) and **how** (GP uploads a file / GP requests it from an institution / our team handles it).
- Gives the doctor a **clear AHPRA page**: a progress bar, a deadline countdown, plain status chips, and a big reminder that they **must CC our team** on any email to AHPRA (so we can track the reply).
- Lets the doctor **attach proof** that they've requested a document from an institution.
- **Watches the email thread** and auto-confirms when the institution replies, **chases** if it's quiet for a week, and lets admin **send the combined reply to AHPRA from inside the app** in one click.
- Has an **automation master-switch that is OFF by default** — none of the auto-actions fire until the owner turns it on.

---

## 2. Current status & what's NOT done

| Item | State |
|---|---|
| Phases 1–5 implemented | ✅ Done |
| Per-task reviews + per-phase Opus reviews | ✅ Clean |
| Whole-branch final Opus review | ✅ READY TO MERGE (no Critical/Important) |
| Tests | ✅ `tests/ahpra-s80.test.js` 43/43; `node --check` clean on server.js + lib |
| Pushed to remote | ✅ In sync with `origin/worktree-ahpra-s80-improvements` |
| Merged to `main` / deployed to prod | ❌ **NO** — preview branch only |
| Preview URL handed to owner | ❌ **PENDING** — needs Vercel authorization (see §6) |
| Smith Miller end-to-end test seeded | ❌ **PENDING** — see §6 (prod-DB caveat) |
| Branch rebased onto latest origin/main | ❌ **NOT done — branch is 184 commits behind** (see §7) |

---

## 3. The three design decisions the owner made (binding)

1. **Institution loop** — strongest option: proof upload + auto-chase + AI thread-watch. The doctor **must CC the admin/assigned-RSO** on any AHPRA email for the watch to work → this is made explicit on the AHPRA page (the CC banner).
2. **Automation** — "option 2 but AI has to be very confident, and always use the newest Claude model." → auto-actions gated behind a flag + a high confidence threshold (0.92); model = `claude-opus-4-8`.
3. **Reply sending** — "Send from the app." → one-click "Send to AHPRA" on the combined reply (and a gated scheduled auto-send).

---

## 4. What each phase delivered

- **Phase 1 — AI confidence:** s80 extraction now uses `ANTHROPIC_S80_MODEL` (default `claude-opus-4-8`, **no `temperature`**), returns a `confidence` (0–1) + one-line `reason` per item, stored in bundle metadata (`ai_confidence` / `ai_reason`) and shown as a badge in the admin tray. Pure `bundleAutoReleasable(items, threshold)` predicate added to `lib/ahpra-s80.js`.
- **Phase 2 — GP clarity:** AHPRA page gets a progress bar, deadline countdown, per-item status chips, and a read-only "Handled by our team" section (team items shown title-only for privacy). Helpers `s80DaysLeft`, `s80ProgressCount`, `s80StatusChip`.
- **Phase 3a — CC banner + proof:** "⚠️ always CC us" banner on the AHPRA page; per-item proof-upload control (`PUT /api/ahpra/more-info/proof`, view via `GET /api/admin/ahpra/item/proof-file`).
- **Phase 3b — thread-watch + chase:** `resolveS80CcAddress` resolves the case's **watched** RSO inbox (`va_gmail_accounts.watch_active=eq.true`, else falls back to `MASTER_ARCHIVE_EMAIL`). Reconcile cron (`GET /api/cron/reconcile-followups`) gained 3 s80 passes: thread-watch auto-confirm (Gmail + Opus 4.8, idempotent, budget-gated), auto-chase (claim-before-act on `last_chased_at`, default 7 days), auto-send (fires due `auto_send_at`).
- **Phase 4 — AI match check + send reply:** advisory `verifyS80FileMatch` on upload (never blocks; stores `metadata.upload.ai_match`); `_sendS80Reply` extracted; admin "📨 Send to AHPRA" button; blocks send if approved attachments can't all be loaded; rejects the placeholder recipient `officer@ahpra.gov.au`.
- **Phase 5 — automation (gated):** master flag `S80_AUTOMATION_ENABLED` (default **OFF**). When ON: auto-release high-confidence bundles (`bundleAutoReleasable`), auto-approve confidently-matched uploads (`ai_match.matches && confidence >= S80_AUTO_CONFIDENCE`), scheduled auto-send (10-min hold + admin "Cancel auto-send").

---

## 5. Key constants / env / model rules (operationally critical)

- **`S80_AUTOMATION_ENABLED`** — gates ALL auto-actions. Must equal the string `'true'`; **defaults OFF**. Set via Vercel env var to enable.
- **`S80_AUTO_CONFIDENCE = 0.92`**, **`S80_CHASE_DAYS = 7`**, **`S80_REPLY_HOLD_MINUTES = 10`** (server.js ~L201–208).
- **`ANTHROPIC_S80_MODEL`** + **`ANTHROPIC_SCAN_MODEL`** both default to **`claude-opus-4-8`** and **omit the `temperature` parameter**. ⚠️ **Opus 4.7/4.8 reject `temperature` with HTTP 400** — never add temperature to any s80 AI call. (The general `ANTHROPIC_MODEL` = `claude-opus-4-6` still uses temperature; don't conflate.)
- **CC-banner caveat:** the banner shows a live-monitored inbox only. If the case's assigned RSO has no `watch_active` Gmail account, it falls back to `MASTER_ARCHIVE_EMAIL` (hello@), which is the **never-watched** archive — so thread-watch won't fire for that case. (Smith Miller's case is assigned to "GP Link Admin / hello@" → would fall back. Reassign to a watched RSO like Hazel for a full demo.)

---

## 6. Pending task: preview URL + Smith Miller end-to-end test

The owner asked: *"give preview link and fill it with a test for smith miller so we can see the implementations from start to finish."* Two blockers:

**(a) Preview URL** — requires Vercel authorization from this headless session. Re-run the Vercel MCP `authenticate` flow, give the owner the authorize URL, have them paste the localhost callback back, then `complete_authentication` and read the preview URL for branch `worktree-ahpra-s80-improvements`. **Fallback:** owner reads it from Vercel dashboard → project → Deployments → newest deploy for that branch.

**(b) Smith Miller test** — ⚠️ **the preview reads the PRODUCTION Supabase DB** (same `SUPABASE_URL` in `.env`), so any test data is real (visible in the live admin) but reversible. Smith Miller test account facts:
- user_id `a505f0b8-fb62-490d-9d63-2c09f800366f`, email `smithmiller1234@gmail.com`
- case_id **`10a3c2d8-aefc-43c7-af3c-7ae5c014ea97`**, stage `myintealth`
- assigned_va `9c35e6f6-f7a2-4d33-afd7-06c59d9d4ae7` = **GP Link Admin / hello@ (never-watched archive)** → CC banner falls back; reassign to Hazel for a watched-inbox demo.
- `registration_tasks` has **no `user_id` column** — query by `case_id`. `registration_cases` has **no `gp_name` / `registration_country`** columns.

**Most faithful demo path:** owner pastes a notice via the preview admin "📨 Log AHPRA letter" button (runs the real `_createAhpraS80Bundle` ingest + real Opus 4.8 extraction). A ready-to-paste Smith Miller notice covering every Who/How combination (CGS + OET-confirmation → GP-requests-from-institution; reference letters → GP-uploads; PSV + SPPA-00 → team) was drafted in the prior turn — re-use or regenerate it. **Alternative:** seed directly via the Supabase service key (keys in `.env` at the MAIN checkout root) — but confirm the prod-DB write with the owner first and tag rows by a test `bundle_id` so they're cleanly removable.

---

## 7. ⚠️ Before merging to prod (do not skip)

- **Branch is 184 commits behind `origin/main`** (based at `e3229f8`). Many of those touch `server.js`. **Rebase or merge latest `origin/main` first, resolve conflicts, then re-run** `tests/ahpra-s80.test.js` + `node --check server.js` before merging.
- Deploy model for this repo: **push to `origin/main` → Vercel auto-builds prod.** (See memory `[[deploy-verification-admin-host]]`.) This branch is preview-only until then.
- After enabling automation in prod, set `S80_AUTOMATION_ENABLED=true` in Vercel env (see memory `[[vercel-api-access]]`).

---

## 8. Verification setup (no system Node on this Mac)

- Temp Node downloaded to `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node`.
- vitest run via a temp config that disables postcss/tailwind (which isn't vendored):
  `export default { css: { postcss: { plugins: [] } }, test: { include: ['tests/ahpra-s80.test.js'], environment: 'node', css: false } }`
- `node --check` for server.js / lib syntax; extract-and-run `.cjs` scripts for pure inline-JS helpers.
- Git push uses the SSH deploy key (background sessions can't use keychain): `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git push`. See memory `[[git-push-ssh-deploy-key]]`, `[[machine-environment-quirks]]`.

---

## 9. Files of record

- **Spec:** `docs/superpowers/specs/2026-06-21-ahpra-s80-improvements-design.md`
- **Plans:** `docs/superpowers/plans/2026-06-21-ahpra-s80-{improvements,phase2-gp-clarity,phase3a-cc-banner-proof,phase3b-threadwatch-chase,phase4-aicheck-sendreply,phase5-automation}.md`
- **Progress ledger:** `.superpowers/sdd/progress.md` (per-task commits + review verdicts + non-blocking follow-ups)
- **Code:** `server.js` (constants, `resolveS80CcAddress`, `GET/PUT /api/ahpra/more-info*`, reconcile cron 4 passes, `verifyS80FileMatch`, `_releaseS80Bundle`, `_sendS80Reply`, auto-paths), `lib/ahpra-s80.js` (`buildExtractionPrompt`/`normalizeItem` confidence+reason, `bundleAutoReleasable`), `pages/ahpra.html` (progress bar, countdown, chips, CC banner, proof control), `pages/admin.html` (confidence badge, AI-match line, proof view, Send-to-AHPRA + Cancel-auto-send), `tests/ahpra-s80.test.js` (43 tests).

---

## 10. Non-blocking follow-ups (carried from reviews)

- Store `ai_confidence = null` (not 0) when the model omits it, to distinguish "rated 0%" from "unscored" in the admin badge (auto-release already treats 0 as safe).
- Cron s80 queries use `limit=300` on `ahpra_action_item` — add pagination/count if the active backlog ever exceeds that.
- Auto-confirm RSO nudge uses `pushDocumentNotificationToUser(assigned_va)` (surfaces in GP shell, not admin) — consider a dashboard task for a stronger RSO-visible nudge; `_logCaseEvent` is the real RSO signal.
- Auto-send countdown uses `fmtD` (date only) — switch to `fmtDT` to show the time.
- Auto-release writes two timeline events — could suppress the inner one when `actor === 'system:auto_release'`.
- Reply sender is pinned to `MONITORED_VA_EMAILS[0]` (hazel@) regardless of case RSO — confirm intended before enabling auto-send.
- Team-card `opacity:.9` is WCAG-borderline for muted text in dark mode.
