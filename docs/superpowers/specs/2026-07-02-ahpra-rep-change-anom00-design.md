# AHPRA Change-of-Representative (ANOM-00) — Design Spec

**Date:** 2026-07-02
**Branch:** `worktree-ahpra-rep-change-anom00` (base `origin/main` @ `0a5fb5b`)
**Status:** Approved via clickable prototype (localhost:4820). Ready for implementation planning.
**Prototype (source of truth for UI):** `$CLAUDE_JOB_DIR/tmp/anom00-proto/index.html` — 9 screens, faithful to app styling.

---

## 1. Plain-English summary

When a doctor who is **already mid-AHPRA** (an AHPRA officer/representative is already on their case) is **reassigned to a new registration officer (RSO)**, AHPRA's records still name the *old* RSO as the doctor's authorised representative. AHPRA requires a signed **ANOM-00 "Authorised representative nomination form"** to change that.

This feature automates the whole change:
1. On reassignment, the app **auto-creates a task** for the new RSO to complete + sign the ANOM-00.
2. The RSO's half (Section B) is **pre-filled** from their profile; they **draw a signature** on the task and click **Send to GP**.
3. The doctor gets an **email**, opens an **in-app page** with their half (Section A + authorisations) pre-filled, ticks the boxes, **draws their signature**, and the app **builds the finished PDF**.
4. The completed form is **submitted to the doctor's assigned AHPRA officer** (dynamic email per case).
5. When AHPRA confirms the change, the new RSO clicks **"Confirmed by AHPRA"**, and **only then** does the app switch this doctor's AHPRA "from" mailbox to the new RSO.

**Why the pin matters:** AHPRA only accepts correspondence from the exact mailbox tied to the representative's AHPRA account. Switching too early = mail from an address AHPRA doesn't recognise. So the pinned mailbox is per-case and flips only on confirmation. See related memory `ahpra-6card-source-of-truth`, and the earlier "mailbox refactor" discussion (out of scope here — see §3).

---

## 2. The ANOM-00 form (structure we must fill)

Official AHPRA form, **3 pages, A4 (595×842pt), NO fillable AcroForm fields** (flat print form → we overlay text + signature images by coordinate with `pdf-lib`). Effective 29 Oct 2025.

- **Part A / Section A** (applicant = doctor): Q1 name + DOB, Q2 registration (No — application in progress), Q3 contact.
- **Section B** (authorised rep = new RSO): Q4 "Do you have an AHPRA account?" (Yes), Q5 applicant legal name + rep contact details (org, address, phone, **email — "must be the same address used to create your authorised representative account"**), + **rep consent signature** ("I consent to act…") + date.
- **Part / Q6** (applicant = doctor): authorises the rep, 3 authorisation checkboxes, **applicant signature** + date.
- Printed footer: "submit … to authreps@ahpra.gov.au" (government text — we do **not** alter it; see §3 decision on where we actually send).

Company constants (from the real filed sample): `GP LINK RECRUITMENT AUSTRALIA PTY LTD`, `SUITE 3050, 780 THE ENTRANCE RD, WAMBERAL, NSW, AUSTRALIA`.

---

## 3. Scope, non-goals, and approved decisions

**In scope:** Components A–F below (RSO onboarding, signature pad, ANOM-00 PDF engine, the rep-change flow, the pinned rep mailbox, plumbing).

**Non-goals (explicitly deferred):**
- **The broader "mailbox refactor"** (deciding hub-vs-personal sender for the *whole* journey). This feature only (a) *sets/flips* the pinned AHPRA rep mailbox and (b) makes **AHPRA-officer** correspondence read it. Non-AHPRA steps are untouched.
- Re-enabling anything visa-related.

**Approved product decisions (from brainstorming):**
1. **Trigger:** auto on reassignment of a case that *already* has an AHPRA rep/officer.
2. **Doctor's half:** in-app guided completion (pre-filled + tick + sign), not manual PDF.
3. **Pin switch:** on AHPRA confirmation (manual "Confirmed by AHPRA"), old mailbox kept alive until then.
4. **RSO AHPRA account:** stored once on the RSO profile; a first-run onboarding step captures name + AHPRA-account confirmation; **company email is provisioned by GP LINK and shown locked/read-only** (RSO cannot edit).
5. **Submission recipient:** the doctor's **assigned AHPRA officer email** (dynamic, `registration_cases.ahpra_officer_email`), **fallback `authreps@ahpra.gov.au`** if no officer on file. The government PDF's printed footer is unchanged.

**OPEN implementation decision (flagged to owner — recommended default chosen so build can proceed; owner may veto):**
- **How the finished form is actually emailed to AHPRA.** A `mailto:` link *cannot* pre-attach a PDF, so "one-tap, from the doctor's own mailbox, with attachment" is not literally possible. **Recommended default:** the doctor taps "Send to AHPRA" → the **server sends** the email (To: assigned officer; PDF attached) **from the new RSO's rep mailbox** (the incoming authorised rep — a valid sender for a nomination), with **Reply-To: the doctor** and **CC: doctor + new RSO**, so the officer can reply to the doctor and everyone has a copy. Alternative if the owner insists the doctor literally sends from their own inbox: app offers "Download form" + a pre-filled `mailto:` (no attachment) with instructions to attach — more friction, less reliable. **Optional add-on:** CC `authreps@ahpra.gov.au` as a safety net (owner to confirm).

---

## 4. Components

### A. First-run RSO onboarding
- **What:** On first admin-dashboard load for an RSO whose profile is incomplete, show a one-time modal capturing **first name, last name**, and an **"I have created my AHPRA portal account"** checkbox. **Company email is displayed locked/read-only** (from `rso_team.company_email`, provisioned by GP LINK/super-admin).
- **Storage:** `rso_team` (see §5).
- **Gate:** the ANOM-00 "Send to GP" is blocked unless the assigned RSO has `ahpra_account_confirmed = true` and a valid `@mygplink.com.au` `company_email`. Screen **3b** in the prototype shows the blocked state.
- **Provisioning path:** super-admin sets `rso_team.company_email` (owner tells us the address → we set it). If absent, onboarding shows "pending — GP LINK is setting up your company email" and the AHPRA flow stays gated.

### B. Signature pad (reusable)
- **What:** New self-contained canvas component (`js/signature-pad.js` + minimal CSS) — draw with mouse/touch, Clear, outputs a trimmed PNG data URL. **No inline signature capture exists today** — built from scratch.
- **Used by:** the RSO task (Section B consent signature) and the doctor's in-app page (applicant signature).
- **Output:** PNG data URL posted to the server, stored on the task, and drawn into the PDF by Component C.

### C. ANOM-00 PDF engine (`lib/anom00.js`)
- **What:** Load the committed official template (`assets/anom00-template.pdf`), overlay typed values + both signature PNGs at calibrated coordinates using `pdf-lib` (`drawText`, `drawImage`), output the finished PDF bytes.
- **Coordinate map:** a config object `ANOM00_FIELDS = { page, x, y, size, maxWidth }` per field. Because the form is flat, positions are calibrated once with a preview harness (render → headless-Chrome screenshot → adjust) — reuse the prototype's screenshot approach.
- **Two build phases:** (1) RSO section only (Section B + rep signature) for the doctor to review; (2) full form (adds Section A prefilled + Q6 + applicant signature) at doctor submission.
- **Pure + unit-testable:** takes a plain data object + two PNG buffers, returns bytes. No DB/network inside.

### D. The rep-change flow
- **D1 — Auto-trigger:** hook the reassignment path (`PATCH /api/admin/ops/case`, `assigned_va` change, near server.js ~307–360). When the case `stage ∈ {ahpra, career, pbs, commencement}` AND has an existing rep/officer (`ahpra_officer_email` set OR a prior `ahpra_auth_rep_email`) AND the assignee actually changed → create one `ahpra_rep_change` task for the new RSO (idempotent on case + open task).
- **D2 — RSO task card** (admin.html, reuse ops-task patterns): shows pre-filled Section B (from profile + company constants), the **signature pad**, the account gate (3b), and **Send to GP**. On send: build phase-1 PDF, email the doctor, flip task → `waiting_on_gp`.
- **D3 — Doctor email:** reuse existing GP-notification send (shared `registration@` hub + RSO name, per §3 scope). Branded, deep-links to the in-app page (survives the sign-in bounce like `gp-document-delivery-email`).
- **D4 — Doctor in-app page** (`pages/ahpra-rep-change.html` or a section within ahpra.html): Section A **pre-filled** from profile (editable), 3 authorisation checkboxes, **signature pad**, "Build my form". On submit: build phase-2 (full) PDF, store it, advance to the send step.
- **D5 — Submit to AHPRA:** per §3 open decision — default server-sends to the assigned officer email (dynamic), PDF attached, Reply-To doctor, CC doctor + RSO; fallback `authreps@`. Flip task → `waiting_on_ahpra`. Doctor sees success (screen 8).
- **D6 — Confirm + pin flip:** RSO clicks "Confirmed by AHPRA" on the task (screen 4) → set `ahpra_auth_rep_email/_user_id/_confirmed_at` on the case → task → `completed`.

### E. The pinned rep mailbox
- **What:** New per-case field `ahpra_auth_rep_email` (+ `_user_id`, `_confirmed_at`). Written on the "Confirmed by AHPRA" click (D6). **Read** by the sender resolver **only for AHPRA-officer-directed correspondence** so those emails go from the pinned rep mailbox; everything else unchanged.
- **Wiring:** extend `resolveCaseSenderInfo(caseId, assignedVa, opts)` with an `opts.purpose` (e.g. `'ahpra_officer'`). When purpose is officer-correspondence and `ahpra_auth_rep_email` is set, use it; else current behaviour. Identify the AHPRA-officer send sites (6-card `_processAhpraEmail` replies, conflict-letter, s80 officer emails) and pass the purpose. **Kept-alive old mailbox** is an operational note (don't delete departed RSO Workspace mailboxes) — documented, not code.

### F. Plumbing
- New `task_type` `ahpra_rep_change` — **read the LIVE constraint via `exec_sql`** (it has drifted before — see `sppa-alt-supervisor-cv-request` memory), rebuild additively, and add a migration file for the record.
- Commit `assets/anom00-template.pdf` (the official form) — ensure Vercel `includeFiles` covers it (gp-tokens/includeFiles gotcha from memory).
- Persist generated PDFs to `task_documents` + Drive (reuse `fileDocOnDrive`/existing delivery funnel).

---

## 5. Data model changes

**`rso_team`** (add columns; keep existing `name`/`email`):
- `first_name text`, `last_name text` — captured in onboarding (display `name` kept in sync).
- `company_email text` — the `@mygplink.com.au` AHPRA-account mailbox (the locked field). Authoritative for the ANOM-00 + rep sending. Defaults from `email` when that is `@mygplink.com.au`.
- `ahpra_account_confirmed boolean default false`, `ahpra_account_confirmed_at timestamptz`.
- `onboarding_completed_at timestamptz`.

**`registration_cases`** (add columns):
- `ahpra_auth_rep_email text` — the pinned rep mailbox (governs AHPRA-officer "from").
- `ahpra_auth_rep_user_id uuid` — which RSO.
- `ahpra_auth_rep_confirmed_at timestamptz` — when AHPRA confirmed.

**`registration_tasks`**: new `task_type = 'ahpra_rep_change'`; rep-change lifecycle state in `metadata` (`rep_change_state ∈ {awaiting_rso_sign, waiting_on_gp, waiting_on_ahpra, completed}`, signatures refs, `source_reassignment`, `prev_rso_user_id`, `new_rso_user_id`). No new task columns.

All DDL applied to prod via `rpc/exec_sql` (service key) **and** committed as a migration; constraint rebuilt from the LIVE definition.

---

## 6. Endpoints (server.js)

- `GET  /api/admin/rso/onboarding-status` — does the current RSO need onboarding? returns locked `company_email`.
- `POST /api/admin/rso/onboarding` — save first/last name + `ahpra_account_confirmed`.
- `POST /api/admin/rso/company-email` — super-admin sets an RSO's `company_email` (provisioning).
- (trigger) inside `PATCH /api/admin/ops/case` — create `ahpra_rep_change` task on qualifying reassignment.
- `POST /api/admin/va/task/:id/anom00-send-to-gp` — validate gate, accept RSO signature PNG, build phase-1 PDF, email doctor, flip → `waiting_on_gp`.
- `GET  /api/ahpra/rep-change/:token` — doctor page data (prefilled Section A).
- `POST /api/ahpra/rep-change/:token/submit` — accept GP signature + auth flags, build full PDF, store, advance.
- `POST /api/ahpra/rep-change/:token/send` — submit to AHPRA (per §3 default), flip → `waiting_on_ahpra`.
- `POST /api/admin/va/task/:id/anom00-confirmed` — pin flip (D6), task → completed.

Reuse existing send infra (`/api/admin/email/send` patterns, `sendGpNotificationEmail`, attachment handling, `task_messages`, `task_documents`).

---

## 7. Error handling & edge cases

- **No officer email on file** at submit → fallback `authreps@ahpra.gov.au`; surface the target address on the RSO task and allow correction.
- **RSO not onboarded / no company email** → task shows gate 3b; Send to GP disabled.
- **Reassignment away then back / double reassignment** → idempotent task creation; the pinned mailbox never changes without an explicit "Confirmed by AHPRA".
- **Signature missing / empty canvas** → block the relevant action with a clear message.
- **Doctor opens a stale / already-completed link** → friendly "already submitted" state.
- **PDF template missing on Vercel** → fail loudly at build with a clear log (guard against the includeFiles gotcha).
- **Company email not `@mygplink.com.au`** → cannot be an AHPRA rep mailbox; block + prompt super-admin provisioning.

## 8. Testing

- **Unit (vitest):** `lib/anom00.js` (field-map fill produces expected text ops + embeds two images; phase-1 vs phase-2), onboarding-gate predicate, trigger predicate (only fires for qualifying reassignment), officer-email resolution + fallback, `resolveCaseSenderInfo` purpose routing (pinned rep used only for officer correspondence, unchanged otherwise).
- **Full suite** must stay green (current baseline ~894).
- **Node checks:** `node --check server.js` before every push.
- **Manual (documented, needs live creds):** end-to-end with a real reassignment; verify the generated PDF visually; verify the officer receives it; verify the pin flips only on confirm. Live email/Drive can't be verified from this machine (documented limitation).

## 9. Build order (subagent-driven, one task per unit)

1. **F/plumbing + §5 data model** (migrations + exec_sql; commit template asset).
2. **C — `lib/anom00.js`** + unit tests + coordinate calibration harness.
3. **B — signature pad** component.
4. **A — RSO onboarding** (endpoints + modal + locked email + gate).
5. **D2/D6 — RSO task card** (render, sign, Send to GP, Confirmed-by-AHPRA).
6. **D1 — auto-trigger** on reassignment.
7. **D3/D4/D5 — doctor email + in-app page + submit/send**.
8. **E — pinned-mailbox sender wiring**.
9. Full-suite + `node --check`; commit & push each step (per CLAUDE.md rule 6).

Each unit is independently testable and maps to the prototype screen(s) it implements.
