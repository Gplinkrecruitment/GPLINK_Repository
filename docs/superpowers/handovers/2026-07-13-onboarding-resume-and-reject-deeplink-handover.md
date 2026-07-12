# Handover — Onboarding seamless resume + reflect RSO reviews + reject deep-link into onboarding

**For:** a fresh session (Fable 5) to implement.
**Date:** 2026-07-13. **Author:** previous session (Opus 4.8).
**App:** GP LINK — monolithic Node/vanilla-JS. All server logic in `server.js` (~50k lines). Pages are self-contained HTML with inline `<script>`/`<style>` in `pages/`. Client modules in `js/`.

---

## 0. START HERE — how to work in this repo

- **Working mode = SHIP TO MAIN.** The owner pushes directly to `origin/main`; Vercel auto-builds `app.mygplink.com.au` (~67s). Prod Supabase. The owner explicitly authorises direct-to-main pushes.
- **Owner is non-technical.** Explain in plain, everyday words. Lead with the plain-English summary.
- **CLAUDE.md rules:** never lie/fabricate; trace changes end-to-end (UI→API→DB→back); commit+push after changes; **use subagent-driven development** (one subagent per task) for implementation; explain in simple terms.
- **This is creative/behaviour-change work → BRAINSTORM FIRST** (superpowers:brainstorming), get the owner's approval on the design, write a spec, then implement via subagents. The owner had just agreed to fix this and we were entering brainstorming when they asked for this handover. The open design decisions are in §5.
- **Environment quirks:**
  - Node binary: `/tmp/node-v20.18.1-darwin-arm64/bin/node` (no system node/npm/gh).
  - Work in a git worktree. Symlink `node_modules` and `.env` from the main checkout into the worktree so vitest + scripts work: `ln -s "<main>/node_modules" node_modules; ln -s "<main>/.env" .env` (both gitignored).
  - Prod Supabase service key is `SUPABASE_SERVICE_ROLE_KEY` in `.env`. **`CRON_SECRET` in `.env` is EMPTY** — you cannot trigger prod cron endpoints; Vercel injects the real secret for the hourly runs. To run cron logic on demand, boot the server locally (it connects to prod via `.env`) — but note the local cron auth also needs a matching secret (empty → 401), so the reliable path is to let the hourly cron run, or invoke the underlying logic another way.
  - Push via SSH: `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git ...`. Never `git add -A` (stage specific files).
  - Commit trailers to append:
    ```
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01AYnFvXgjEpstCqPJQ98brP
    ```
    (Update the co-author line to your own model when you implement.)
  - `run node --check server.js` after every server.js edit.

---

## 1. What is ALREADY shipped this session (do NOT redo)

All merged to `main` and live:

1. **Flagged-doc routing + AMC name-change feature** (branch `worktree-flagged-doc-routing-namechange`, merged):
   - Reliable flagged-doc review tasks + an hourly reconcile sweep (`/api/cron/reconcile-doc-tasks`, `vercel.json`).
   - Least-loaded-RSO routing for **un-placed** GPs (task-level `registration_tasks.assignee`, case stays unassigned) surfaced in a separate "Document checks" section in `pages/admin.html`. Selector `pickLeastLoadedRso` in `lib/ceo-metrics.js`. Scoping predicate `taskVisibleToRso` in `server.js` (gated to `flagged_doc`/`doc_review` task types). Assignee-aware `ensureAdminTaskAccess` gate on `preview-document`.
   - Name-change flag: on RSO **approve** of a name-mismatched qual doc (`review-flagged-doc` handler), sets `user_profiles.name_change_detected` + `name_change_note`; served by `GET /api/gp/name-change-flag`; `pages/amc.html` shows a red notice + "Show me where" modal (`media/images/amc-name-change-reference.png`) on the Establishment (`upload_credentials`) tab.
   - Migration `supabase/migrations/20260712140000_user_profiles_name_change.sql` (applied to prod).
2. **Certified-copy fix** (branch `worktree-onboarding-cert-not-required`, merged): onboarding-collected quals are NOT held to AHPRA's "certified true copy" standard. Helper `isOnboardingCollectedDoc` in `server.js`.
3. **Reconcile-sweep bug fix:** the sweep was re-creating tasks every hour for docs that stay `status='under_review'` after approve/reject (the review handler never clears the doc status). Fixed: the sweep now skips a doc if **any** review task (open OR completed) exists for `(case, canonical doc key)` — see `server.js` `/api/cron/reconcile-doc-tasks`, the `rdtExisting` query. Verified end-to-end on Dr Mercy (see §4).

---

## 2. THE TASK (what you are implementing)

Fix the GP-side onboarding return experience + the reject email link, for Dr Mercy **and future GPs**. The owner's words:

> "yes fix these for dr mercy and future GPs. as onboarding needs to save the documents they uploaded so they can seamlessly resume. Also fix the link sent to dr mercy so that it redirects to the onboarding specific page along with all the fixes."

Three gaps to close:

- **Gap A — Onboarding wizard does not restore progress/documents from the server.** State is localStorage-only for *restore*, so a GP returning on a new device/browser (or after clearing cache) **starts over from step 0 with empty document slots.** The server already HAS the state — it just isn't read back. → Onboarding must resume seamlessly: restore step + uploaded docs + their statuses from the server.
- **Gap B — Onboarding wizard is blind to RSO approve/reject.** It never fetches `user_documents` statuses; there is no `approved`/`rejected`/`under_review` UI and no `rejection_reason` display. → An **approved** doc must show as saved/verified (no re-upload); a **rejected** doc must show the reason + a re-upload at that step; an **under_review** doc must show as pending.
- **Gap C — The reject email deep-links to `my-documents.html` (wrong page, mismatched keys), not onboarding.** For the MRCGP the link is `?reupload=specialist_qualification` but the My Documents card is keyed `mrcgp_certified` — they don't match, so the link doesn't resolve and the onboarding MRCGP's rejected status doesn't surface there (My Documents shows AHPRA-stage *certified copies*, a different document set). → For **onboarding-origin** rejections, the email CTA must deep-link back into the **onboarding page at the specific document/step**, with the reason.

Also: **fix the link already sent to Dr Mercy** — her reject email (sent ~2026-07-12) points at the broken My Documents link. Decide whether to re-send a corrected email once the flow works (see §5).

---

## 3. ARCHITECTURE FINDINGS (verified, with file:line) — read before designing

### 3a. Onboarding wizard — `js/onboarding.js`
- `STORAGE_KEY = "gp_onboarding"` (`js/onboarding.js:5`).
- `loadState()` reads **localStorage only** (`js/onboarding.js:78-84`); `state = loadState()` (`:41`); `currentStep = state.currentStep || 0` (`:56`); `defaultState()` = `{ currentStep:0, country:"", qualDocs:{} }` (`:59-76`).
- `qualDocs` shape: `{ [docKey]: { fileName, status, scanResult, retryCount, nameMatch } }` (`:64`). Doc keys used in-wizard: `primary_med_degree`, and a specialist key that maps to storage `onboarding_specialist_qualification` (see `getStorageKeyForDocKey` around `:746`).
- `saveState()` writes localStorage AND fire-and-forgets `POST /api/onboarding/save` (`:86-96`). Server stores the whole blob at `user_state.gp_onboarding` (`server.js:39511-39538`); `/api/onboarding/complete` also sets `gp_onboarding_complete:true` (`server.js:39541-39564`).
- **Init reads server state but IGNORES onboarding progress:** it fetches `/api/auth/session` (`:1483`) and `/api/state` (`:1501`) but only reads `d.state.gp_eligibility_waitlist` (`:1504`). It never reads `gp_onboarding` back, even though the server ships it to the client (`USER_STATE_KEYS` includes `'gp_onboarding'`, `server.js:6232`; `filterUserStateForClient` `server.js:24038-24059` / `:43416`). **This is the crux of Gap A** — the server copy exists; the wizard just doesn't use it.
- **Qual-doc slot renderer** (`:388-426`) only understands client-side AI-scan statuses: `verified`, `verified_name_pending`, `support_requested`, `failed`, `scanning`, `manual_review` (`:393-398`). **No branch for `approved`/`rejected`/`under_review`; no `rejection_reason` anywhere.** This is the crux of Gap B.
- `renderQualDocSlots` shows "Select a country first" when `country===""` (`:375`) — so a reset-to-default state renders no slots at all.
- Deep-link: `?step=N` (`:1516-1522`, used by reminder emails) only moves the pointer, does not repopulate `qualDocs`. `?reset=1` wipes state (`:14-17`). No `?route=`/`?next=` handling.
- The only `/api/onboarding-documents` call in the wizard is a **PUT** to store a file (`:868-890`) — there is **no GET** to read back statuses. NOTE: a `GET /api/onboarding-documents` endpoint DOES exist server-side (`server.js:~42741`) — check whether it returns onboarding doc statuses; it may be the right server surface to feed the wizard (verify before relying on it).

### 3b. The review handler — `server.js` `/api/admin/va/task/review-flagged-doc` (`server.js:49812`)
- UPSERTs `user_documents` with `status: approve?'approved':'rejected'` and `rejection_reason: reject? rfNote : ''` (`server.js:49875-49891`). NOTE: it sets the doc status here — but for onboarding docs the status stays `under_review` in practice per §1.3 unless this path runs; confirm which key it writes (canonical vs `onboarding_*`).
- Onboarding key map inside the handler: `primary_medical_degree → onboarding_primary_med_degree`, `specialist_qualification → onboarding_specialist_qualification` (`server.js:49850-49853`).
- **Approve email:** CTA "View Dashboard" → `APP_BASE_URL + '/pages/index.html'` (`server.js:49950-49954`).
- **Reject email:** CTA "Re-upload Document" → `APP_BASE_URL + '/pages/my-documents.html?reupload=' + related_document_key` (`server.js:49958-49964`), plus an in-app bell notification with the same target (`server.js:49967-49972`). `related_document_key` is the **canonical** key (`specialist_qualification` / `primary_medical_degree`). **This is where Gap C is rooted** — for onboarding-origin tasks (`rfTask.related_stage === 'onboarding'`) this should point into onboarding instead.

### 3c. The re-upload page today — `pages/my-documents.html`
- Loads doc state from the **server**: `GET /api/prepared-documents` (`:1839`), `GET /api/gp/document-requirements` (`:1473`, single source of truth = `lib/document-requirements.js`), `GET /api/gplink-docs-status` (`:2294`). So it survives device switches / days.
- UK requirement cards are keyed `primary_medical_degree` and **`mrcgp_certified`** (`pages/my-documents.html:1420-1421`; `lib/document-requirements.js:94`,`103`). These are AHPRA-stage **certified copies**, a different document set from the onboarding quals (`onboarding_*`).
- Rejected doc → Re-upload button (`:2167-2176`) + reason from `itemState.rejection_reason` (`:2187-2190`). `?reupload=<key>` opens the tab and scrolls/highlights the matching card (`:2247-2268`).
- Re-upload flow: change handler → `runPreparedDocumentClassificationCheck` (`:2664`) → `POST /api/ai/classify-document` (`:2676`) → `PUT /api/prepared-documents` status `under_review` (`:2697-2708`) → server PUT (`server.js:42972`) awaits `ensureDocReviewOnUpload` (`server.js:43072`) + fires `processDocumentUpload` (`server.js:43080`); quals filed under **`ahpra`** stage (`server.js:43071`).
- **The mismatch:** reject deep-link key `specialist_qualification` ≠ card key `mrcgp_certified`, and the onboarding MRCGP (`onboarding_specialist_qualification`) is not the same record as the `mrcgp_certified` prepared-doc → the onboarding rejection does not surface on this page. (Primary degree keys DO match: `primary_medical_degree` both sides.)

### 3d. Key namespaces (important)
- Onboarding upload keys: `onboarding_primary_med_degree`, `onboarding_specialist_qualification` (in `user_documents`).
- `canonicalQualKey()`: `onboarding_primary_med_degree → primary_medical_degree`; `onboarding_specialist_qualification → specialist_qualification`; `mrcgp_cert → specialist_qualification`.
- Onboarding vs AHPRA-stage/my-documents are **separate** document contexts with separate keys. Any fix must decide how they relate for the re-upload flow.

---

## 4. Dr Mercy's exact current state (prod)
- `user_id` = `9c785962-9908-4eef-8007-838b52644003`; `case_id` = `62e6775a-e51e-4358-9c39-7103efd817ec`; assigned RSO = **Hazel** (`7bed5eb8-f03d-40d6-b090-eb006cd02be7`, both `assigned_rso` and `assigned_va`). She is placed at The Doctors Werribee.
- **Primary Medical Degree** (`onboarding_primary_med_degree`): a Ukrainian MD diploma in her **former name "Biam Mercy Dzungwem"** vs account **"Mercy Obanimoh"**. Status set to `approved` (was approved by Khaleed via the real flow). **Name-change flag is SET** (`user_profiles.name_change_detected=true`, `name_change_note="Document name: Biam Mercy Dzungwem"`), so her AMC Establishment step already shows the name-change notice (verified live).
- **MRCGP / Specialist Qualification** (`onboarding_specialist_qualification`): status set to `rejected`, `rejection_reason="Please re-upload a clear scan of your MRCGP certificate with no shadows."` She received the reject email (~2026-07-12) with the (broken) My Documents CTA.
- **0 open tasks** currently (the 2 bogus sweep-created tasks were deleted; docs set to approved/rejected).
- The previous session **manually** set her doc statuses to `approved`/`rejected` during cleanup (the review handler leaves onboarding docs at `under_review`). Keep this in mind — her data reflects reality but was hand-corrected.

---

## 5. OPEN DESIGN DECISIONS (brainstorm these with the owner first)
1. **Server surface for onboarding resume (Gap A/B):** does the wizard read `gp_onboarding` back from `/api/state` (already shipped to client) AND/OR a new/existing GET for onboarding doc statuses (`GET /api/onboarding-documents` exists — verify it returns per-key `status`+`rejection_reason`)? Decide the single source of truth so localStorage and server don't fight. Consider: server should win for doc statuses (RSO decisions); localStorage can stay a fast cache.
2. **How the wizard renders each server status (Gap B):** `approved` → green "Verified/Saved", no re-upload; `under_review` → "Under review" pending; `rejected` → red with `rejection_reason` + a Re-upload control **at that document's step**, and resume the wizard at that step.
3. **Reject deep-link target (Gap C):** for onboarding-origin tasks (`rfTask.related_stage === 'onboarding'`), point the reject email CTA (and the bell notification) at the **onboarding page** at the specific qual step — determine the onboarding page URL (find where `js/onboarding.js` is loaded — likely `pages/onboarding.html` or via the app shell; NOT yet confirmed) and the step index / a `?reupload=<docKey>` param the wizard understands. Keep `my-documents.html` for genuine AHPRA-stage prepared-doc rejections.
4. **New-device empty-country case:** restoring must also restore `country` (so slots render) — otherwise §3a `:375` shows "Select a country first".
5. **Dr Mercy's already-sent broken link:** re-send her a corrected reject email once the flow works? Or guide her manually? (She's a live, placed GP — the owner will care.)
6. **Scope guard:** don't regress the shipped name-change flow or the reconcile sweep. The certified-copy fix means onboarding quals never need certification — keep that.

---

## 6. Suggested implementation shape (after design approval)
- Isolate in a fresh worktree off `main`. Symlink `node_modules` + `.env`.
- Likely files: `js/onboarding.js` (restore-from-server + status rendering + re-upload-at-step + deep-link handling), `server.js` (reject-email onboarding deep-link for onboarding-origin tasks; possibly a GET that returns onboarding doc statuses if `/api/onboarding-documents` GET is insufficient), maybe `pages/onboarding.html` (confirm the page).
- Use subagent-driven development (one subagent per task); write tests where logic is unit-testable (pure helpers); verify end-to-end by driving the real flow.
- Verify on Dr Mercy: after deploy, her onboarding should show the approved degree as saved and the rejected MRCGP with the reason + a working re-upload that lands on the right step; her reject link should open onboarding at the MRCGP step.

---

## 7. Useful commit history (on `main`)
Feature + fixes landed as: migration → `pickLeastLoadedRso` → routing → reconcile cron → scoping → name-change flag/state → admin.html Document checks → preview-scope fix → amc.html notice → review-fix wave (C1/I2/I3/M4) → reconcile re-creation fix. Design spec: `docs/superpowers/specs/2026-07-12-flagged-doc-review-and-amc-name-change-design.md`. Plan: `docs/superpowers/plans/2026-07-12-flagged-doc-review-and-amc-name-change.md`.
