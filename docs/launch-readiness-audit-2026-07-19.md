# GP Link — Launch-Readiness Audit & Fixes (19 Jul 2026)

**Plain-English summary:** I went through the whole app the way a real doctor, a
real practice, and your CEO dashboard would use it — from first sign-up all the
way to a placement — and I hunted for anything broken, any dead-ends, and any way
someone could attack or abuse it. I found and **fixed the two most serious
security holes** (one exposed your entire backend code to the public; one let a
booby-trapped name take over an admin's dashboard) plus a batch of real
flow-breakers in the practice sign-up and CEO dashboard. Everything I changed is
tested and the full test suite passes. A shortlist of smaller polish items is
left documented for a follow-up, and there's a **things-you-must-do-before-launch
checklist** at the end (mostly setting environment secrets).

Branch: `worktree-launch-readiness-audit`. All work is committed; nothing here
touches production data.

---

## 1. Journeys reviewed

| Journey | What was traced |
|---|---|
| **GP (doctor)** | signup/login → onboarding wizard → registration stages (MyIntealth→AMC→AHPRA→Visa→PBS) → document upload & qualification scan → career/job browse → apply → offer review → **accept → placement** read-back |
| **Practice (employer)** | FB lead → 5-step intake (incl. multi-clinic groups) → **e-sign agreement** → track-your-listing status page → job created → candidates → interview scheduling → first placement |
| **CEO / ATS** | Practices, Jobs, Candidates, Matching, Meetings, Leads, Offers tabs — plus cross-checking that GP/practice actions show up correctly |
| **Security** | auth, authorisation/IDOR, SQL/PostgREST injection, XSS, file upload, SSRF, open-redirect, rate-limiting, secrets exposure |
| **Every page** | all 50 pages in `pages/` — checked every referenced script/style/image/link resolves |
| **APIs / ops** | ~356 API endpoints inventoried; env vars, cron jobs, and integration health for launch |

The audit was run as a fan-out of specialist agents (all on the Fable 5 model, as
requested) plus my own hands-on verification against a locally-running server.

---

## 2. Issues found, grouped by severity

### 🔴 P0 — launch blockers (both FIXED)
- **Entire backend source code was publicly downloadable.** `GET /server.js`
  returned the full 3.2 MB of server code (200 OK); also `/lib/*`, `/package.json`,
  `/data/app-db.json`. Because Vercel bundles the server + libraries into the
  function, this leaked in **production**, handing an attacker every endpoint and
  validation rule.
- **Stored XSS → admin dashboard takeover.** A doctor's *first name* is shown in
  the admin dashboard inside HTML button attributes. The escaper didn't encode
  quotes, so a name like `x" onmouseover=…` broke out and ran attacker JavaScript
  in the admin origin (full admin/CEO access + every doctor's passport/visa) the
  moment a staff member's mouse passed over their queue.

### 🟠 P1 — major (FIXED)
- Rate-limit bypass: `getClientIp` trusted the client-controllable
  `X-Forwarded-For`, so an attacker could get a fresh limit bucket per request and
  defeat **every** per-IP limit (login, signup, intake, DPA lookup, enquiry).
- Failed-login email spray: any wrong-password/nonexistent-account login made GP
  Link send a branded "confirm your account" email to any address the attacker
  typed — a spam / sender-reputation abuse vector.
- Multi-clinic group sign only activated the **seed** clinic; sibling clinics were
  stuck in "Potential Clients" with no job forever, and the group was never marked
  signed.
- Renaming a practice detached it from its jobs and spawned a duplicate card.
- Leads tab silently truncated at 100 rows — older leads unreachable after the
  planned 800-GP marketing blast.
- Onboarding "get qualification help" support ticket wrote against a nonexistent
  `session.user_id`, so in production the ticket never landed on the doctor's row.
- 3 pre-existing failing tests on `main`.

### 🟡 P2 — real, lower-impact (FIXED)
- A freshly-signed practice's pending job was invisible on its own card (the page
  the notify email links to). *(Fix is Supabase-only — verify in preview.)*
- SSRF: a practice-supplied website URL is fetched server-side (AI write-up) with
  no block on internal/loopback/metadata hosts.
- The practice Edit modal silently stamped **QLD** onto any stateless practice on
  any edit.
- `secure-interview` / `confirm-call` lost the bottom nav on refresh / email link.
- An error response wiped the Leads chip counts.
- The Matching tab silently cleared its spinner on a failed AI ranking.

### 🟡 P2 / P3 — documented, NOT changed (see §4)
Several smaller ATS polish items and low-risk security hardening left for a
focused follow-up so this pass stayed "fix what's there, don't destabilise it."

---

## 3. Fixes implemented (all committed, all tested)

| # | Fix | Files | Test |
|---|---|---|---|
| 1 | Static-serve **allowlist** — only `pages/js/css/media/documents/assets` + `sw.js`/`manifest` are served; backend files 404 | `server.js` | `tests/static-allowlist.test.js` (16) |
| 2 | Admin dashboard **XSS**: both `esc()` helpers now encode `"` and `'` | `pages/admin.html` | `tests/admin-xss-escaping.test.js` (3) |
| 3 | `getClientIp` prefers Vercel's unspoofable client IP | `server.js` | existing rate-limit tests |
| 4 | No confirmation email on generic failed login | `server.js` | existing |
| 5 | Group e-sign promotes **all** clinics + one job each + marks group signed | `server.js` | `tests/practice-intake-endpoints.test.js` (+1) |
| 6 | Practice **rename cascades** onto its jobs | `server.js` | `tests/ats-endpoints.test.js` (+1) |
| 7 | Pending job now shows on a signed practice's card | `server.js` | *(Supabase-only; preview)* |
| 8 | Leads tab **"Show more"** pager + don't wipe counts on error | `js/ceo-ats-leads.js` | existing endpoint tests |
| 9 | Onboarding qualification-help ticket uses email lookup | `server.js` | `tests/support-grouping-and-names.test.js` |
| 10 | **SSRF** host guard on fetched practice URLs | `server.js` | `tests/ssrf-guard.test.js` (23) |
| 11 | Practice Edit state dropdown defaults blank, not QLD | `js/ceo-ats-practices.js` | `tests/ceo-practices-ui.test.js` |
| 12 | `secure-interview`/`confirm-call` registered as app-shell pages | `server.js` | existing |
| 13 | Leads tab hidden for consultants + matching-tab failure toast *(carried over)* | `pages/ceo-dashboard.html`, `js/ceo-ats-matching.js` | existing |
| 14 | 3 baseline test fixes + cache-buster bumps | tests + pages | — |

**Test status:** full suite green (3,180+ tests). The 3 previously-failing tests on
`main` are fixed. One slow test (`audit-breadth`) occasionally times out only under
full-parallel load; it passes in isolation (pre-existing, not caused here).

---

## 4. Unresolved issues (documented for a follow-up — none block launch)

**ATS — Practices tab**
- Manually uploading a signed PDF marks the agreement signed but doesn't advance
  the stage (practice stays a "Potential Client"). `server.js` ~`mcPatch`.
- Legal entity / ABN / signer captured at signing aren't shown anywhere in the
  detail panel (CEO can't verify who a contract binds without opening the PDF).
- "Add practice" creates rows in Mainstream (skips the intake pipeline) — no stage
  choice on the add form.
- `agreement_status='sent'` amber pill is a dead state nothing ever writes.
- `resend-intake` returns HTTP 200 `{ok:false}` when the real cause is a missing
  contact email; search matches name/city only (not the contact/email/phone shown
  on cards); candidate drill-in costs one guaranteed-failed request per click.

**ATS — Meetings tab**
- "Cancel & rebook" deletes the Zoom meeting but **not** the Google Calendar event,
  so the freed slot stays "busy" and can't be rebooked for 14 days.
- Cancelling always spawns a fresh "Invited" row that can't be cleared without
  booking-then-cancelling again.
- "Upcoming" is ordered by created-date, not call time; a Calendly booking with no
  Zoom details is skipped by the no-show cron and can sit "Upcoming" forever.
- The **legacy** `admin.html` career interview scheduler still writes to
  `career_interviews`, which the CEO Meetings tab can't see — two parallel systems.

**ATS — Leads tab**
- "Not qualified" conflates people who were *never screened* with real screen-outs
  (inflated count). Leads are view-only (no re-invite / mailto). No AEST/AEDT label.

**Security (hardening, not exploitable-now)**
- `/api/public/consult-lead/match` returns a lead's booking token + name/email for
  any email supplied (marketing data only, IP-rate-limited).
- One PostgREST filter (`body.case_id`, admin-gated) isn't URL-encoded like its
  siblings.
- SSRF fix doesn't cover DNS-rebinding / redirect-to-private-IP (needs a resolving
  fetch agent).
- The 3 sibling support-ticket handlers still return `ok:true` even if the write
  silently fails on a transient DB error (shared quirk across many handlers).

**GP journey (low)**
- `/api/registration/can-proceed` reports AHPRA "completed" off a truthy object
  (harmless today — no consumer reads it that way).
- A staff-created "commencement" task's action card can bounce to the dashboard
  (that stage is vaulted).

---

## 5. New pages / routes / APIs / DB changes / workflows

**None.** This was a fix pass, not a build pass — no new user-facing pages, routes,
API endpoints, database migrations, or workflows were created. The only new files
are **test files** (`static-allowlist`, `admin-xss-escaping`, `ssrf-guard`). Two
internal helper functions were added (`isPubliclyServablePath`,
`isBlockedSsrfHostname`) but they are not endpoints.

➡️ Because nothing new is user-facing, there is no new UI/page to sign off — the
preview checks below are all **verifications of fixes**, not new-feature reviews.

---

## 6. Areas requiring manual preview testing

1. **XSS fix (important):** register/set a doctor first name containing a `"` and
   an apostrophe, then open the admin dashboard queue — the name should render as
   text and **no** script should run. Also spot-check the admin dashboard generally
   renders fine (the escaping change touches every field it displays).
2. **Pending job on a signed practice's card** (Supabase-only): sign a practice,
   click "View in CEO dashboard" from the notify email — the pending job should
   appear on the card, not "No jobs yet".
3. **Multi-clinic group sign:** submit an intake with 2–3 clinics, sign once — all
   clinics should show **Active** with a pending job each in the Practices tab.
4. **Practice rename:** rename a practice that has jobs — the jobs should stay
   attached; no duplicate old-name card.
5. **Leads "Show more":** with >100 leads in a filter, confirm the pager loads
   older leads and the "Showing X of Y" count is right.
6. **Interview nav:** accept an offer → "Schedule your interview" → refresh the
   page → the bottom nav should still be there.
7. **Practice edit:** edit only the phone on a practice with no state — the state
   should stay blank (not flip to QLD).

---

## 7. Potential regression risks

- **Admin escaping change is pervasive** (every field in `admin.html`). Full suite
  is green and quotes render identically as text, but a visual spot-check of the
  admin dashboard is worthwhile.
- **Static allowlist:** if a *new* asset folder is added later, it must be added to
  the allowlist in `serveStatic` **and** to `vercel.json` `includeFiles`, or it
  will 404 (same class as the existing includeFiles gotcha).
- **Client-IP change** relies on Vercel setting `x-vercel-forwarded-for`. Verify in
  preview that legitimate users aren't over-rate-limited and limits still bite.
- **Group-sign loop / rename cascade** are best-effort bulk operations — verify
  against real Supabase data in preview (local-JSON mode can't fully exercise them).

---

## 8. Security improvements

**Made (code):** static-serve allowlist (source-leak); admin XSS quote-encoding;
trusted client-IP for rate limits; no failed-login email spray; SSRF host guard on
fetched URLs.

**Recommended (config / follow-up):**
- Set `GMAIL_WEBHOOK_SECRET` and `RESEND_WEBHOOK_SECRET` — those two webhooks
  currently **fail open** (accept unauthenticated POSTs) when the secret is unset.
- Add a Content-Security-Policy header on the admin host (defense-in-depth for XSS).
- Give `/api/ai/*` a shared per-user cap (like the CV-scan endpoint) and make the
  global AI budget an atomic increment — today one account could burn the whole
  daily AI budget.
- Add DNS-rebinding protection to the SSRF fix; URL-encode the `case_id` filter;
  reconsider returning tokens/emails from the consult-lead match endpoint.

---

## 9. Pre-launch checklist (things YOU still need to do)

**Environment variables (the app won't work right without these):**
- [ ] `AUTH_SECRET`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — the server refuses to boot in production without them.
- [ ] `RESEND_API_KEY` — without it **every email is silently not sent**.
- [ ] `CRON_SECRET` — without it **all 22 scheduled jobs return 401** (no Gmail processing, nudges, reminders, backups, purges). Confirm green via `/api/admin/cron-health`.
- [ ] `TEST_WATCH_FROM_SENDERS="*"` — otherwise real candidate email is parked as "unmatched".
- [ ] `GMAIL_WEBHOOK_SECRET` + `RESEND_WEBHOOK_SECRET` — currently fail-open; set them.
- [ ] Verify `CALENDLY_EVENT_URL` + the Calendly webhook secret (a missing secret makes bookings get silently dropped).
- [ ] Review `ANTHROPIC_DAILY_LIMIT_USD` (defaults to $100/day) before the 800-GP blast — AI silently halts when it's exhausted.
- [ ] Confirm `AUTH_DISABLED` and any test-bypass vars are **unset** in production.
- [ ] Populate the admin-host + super-admin-email allowlists (prod does **not** auto-trust its own host for super-admin).
- [ ] Google service-account trio + `GOOGLE_PUBSUB_TOPIC` + Drive/backup folder IDs (for Gmail pipeline, Drive, backups).

**Database:**
- [ ] Apply migrations `20260705100000` (practice pipeline) and `20260716120000`
  (practice groups) to prod — several practice fixes rely on these columns/tables.

**Deploy config:**
- [ ] Any new asset directory must be in `vercel.json` `includeFiles` **and** the
  new static allowlist.

**Then run the §10 scenarios on preview.**

---

## 10. Exact end-to-end scenarios to test after preview

1. **Full GP happy path:** sign up → complete onboarding (upload a qualification;
   try the name-change path) → confirm each registration stage is reachable →
   browse jobs → apply → (as CEO) send an offer → accept as the GP → the GP sees
   themselves placed / "My Practice".
2. **XSS safety:** set a GP first name with `"` and `'` → view the admin queue →
   no script runs, name shows as text.
3. **Practice group sign:** FB-lead/seed a practice → intake with 2+ clinics →
   sign once → all clinics show **Active** + a pending job each; the notify-email
   "View in CEO dashboard" link shows the job.
4. **Practice rename:** rename a practice with jobs → jobs stay attached, no
   duplicate card.
5. **Leads at scale:** with >100 leads, "Show more" reveals older leads; the
   count matches the chip.
6. **Source-leak closed:** `GET /server.js`, `/lib/anything.js`,
   `/data/app-db.json` → all 404; every real page still loads.
7. **Interview nav:** accept offer → secure-interview → refresh → bottom nav stays.
8. **State not clobbered:** edit only the phone of a stateless practice → state
   stays blank, not QLD.
