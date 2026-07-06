# GP Link — Full-App Completeness Audit (2026-07-07, head 2a201e3)

Six parallel domain audits (Fable 5). All read-only, evidence-backed with file:line. Ranked below.

## TIER 0 — CRITICAL / SECURITY (fix before any feature work)

- **C1 Backup exfiltrates ALL secrets.** Weekly backup copies entire `process.env` (Supabase service key, AUTH_SECRET, CRON_SECRET, Anthropic/OpenAI keys, Gmail OAuth refresh tokens, Zoom creds) into the gzip uploaded to Google Drive every Sun 3am, alongside 46 tables of PII. `server.js:24705-24748`; `scripts/restore-backup.js --show-env`. FIX: whitelist non-secret env keys or encrypt archive with a key not in Drive.
- **C2 Gmail webhook unauthenticated.** `GMAIL_WEBHOOK_SECRET` declared (`server.js:1892`) but never checked; handler `23600-23617` processes any POST. Anyone can force Gmail history processing on monitored inboxes. Every other webhook verifies. FIX: verify Pub/Sub OIDC JWT or shared secret.
- **C3 Backup skips ~15 newer tables** incl `placements` (revenue-of-record) + `practices`. `BK_TABLES` server.js:24643-24663 predates recent builds. FIX: add tables or enumerate dynamically.
- **C4 Account deletion doesn't erase files.** purge-accounts (`25591`→`10813`) deletes auth user + cascades DB rows, but never deletes Supabase Storage objects (`user_documents.storage_path`, bucket gp-link-documents) or Google Drive folders. Passports/CVs of "erased" doctors persist forever. FIX: enumerate + delete storage + Drive objects in purge.
- **C5 Two dead crons.** Vercel invokes crons with GET; `/api/cron/call-reminders` (24925, every 5min) + `/api/cron/call-summary-retry` (24855, daily) are POST-only → never fire. RSO pre-call reminders + Zoom summary retries silently dead. FIX: accept GET (like detect-no-shows 24880) + add a test asserting every vercel.json cron path answers GET.
- **C6 Zombie GitHub Action.** `.github/workflows/zoho-recruit-sync.yml` curls deleted `/api/integrations/zoho-recruit/cron-sync` every 15min, fails red. FIX: delete workflow.
- **C7 Legal pages bounce anonymous visitors.** Marketing footers link /pages/privacy + /pages/terms + /pages/blog; not in public allowlist (`server.js:46764-46770`) → auth gate bounces to sign-in. Live compliance breakage. FIX: add privacy/terms/blog to public allowlist + fix footer hrefs across 9 site pages.

## TIER 1 — HIGH (real functional/business gaps)

Business/revenue:
- **B1 No revenue/placement-fee tracking.** placements table has only text billing_split/compensation_range; no monetary column, no invoicing, no revenue KPI. Recruitment business can't answer "how much did we earn". Build: placement_fee column + revenue tile + per-practice invoice tracker.
- **B2 No owner digest email.** All KPIs require login. Build: weekly KPI+trends email to hello@.
- **B3 No CSV export anywhere** (GPs/practices/placements/enquiries/leads). Build: /api/admin/export?entity= + buttons.
- **B4 Archive data dark.** candidate_leads (815) + zoho_archive have zero runtime refs — write-only. Build: read-only browser + CSV export.
- **B5 Marketing-site stats hardcoded** (SITE_STATS server.js:16454; only jobsCount live). No editor. Build: editable site-stats KV + Website-tab form; derive gpsPlaced from placements.

Marketing/compliance:
- **B6 No unsubscribe / marketing-email infra.** candidate_leads.unsubscribed never read/written; no generic /unsubscribe, no suppression table. Emailing 815 leads today breaches Spam Act. Build: token unsubscribe + List-Unsubscribe headers + suppression (pattern exists at 7479-7500).
- **B7 FB lead webhook inert** — 503 until FB_LEAD_WEBHOOK_SECRET/VERIFY_TOKEN set (owner action, since 2026-07-05).

Practice experience (thinnest area — 100% one-way email post-signing):
- **P1 No practice accept/decline.** Intro email says "reply to this email"; accept is a manual admin click (45302). Build: token-signed Accept/Decline/Request-interview links → public token endpoint.
- **P2 AI candidate summary never delivered.** ai_handover_summary cached (34579+) but internal-only; intro email has name/country/qual/CV only. Build: append summary/masked profile link to submit-to-practice email.
- **P3 No "your job is live" email** after approval (45116-45136 sends nothing) though signed-agreement email promises it.
- **P4 No placement confirmation to practice.** finalizeInAppPlacement (22789) notifies GP+sender only.
- **P5 No practice status page.** Intake token could serve read-only "your listing: live / N candidates / interview booked"; dead-ends at sign-success.
- **P6 Practice interview gaps:** no practice reminder (cron GP-only), no .ics, no cancel email to practice, availability replies manually pasted.

Security:
- **S1 Admin MFA absent.** Admins impersonate GPs + download passports on password only. Build: TOTP step-up or enforce Supabase MFA for admin role.
- **S2 No server error capture.** No server_errors table, no process.on(unhandledRejection), 23 handlers leak e.message. Client telemetry good; server flies blind. Build: server errors → client_errors(source=server)/new table + surface on Technical tab.
- **S3 No CI test gate.** 1598 tests run only locally; nothing blocks a red suite reaching main. Build: GitHub Action running vitest on push/PR.
- **S4 No cron monitoring/heartbeat.** 14 crons, failures → console only; backup writes last_weekly_backup marker nothing reads. Build: per-cron last-run KV + Technical-tab table + overdue alert.

GP journey:
- **G1 No complete 7-stage overview.** Commencement invisible (absent from shell dropdown + index list); registration-stepper.js loaded but .render() never called. Two inconsistent partial surfaces. Build: one canonical 7-stage overview (wire the stepper) incl Commencement.
- **G2 Visa stage is a live stage with a placeholder page** (visa.html:468-510). Build: status tracking + doc checklist, or mark "handled by our team".
- **G3 Out-of-scope-country signup loop.** Countries GB/IE/NZ only; others sign up but trap forever between index.html:917 and unpassable onboarding step 1. Build: "not yet eligible" + waitlist capture.
- **G4 No unified GP task inbox.** Outstanding actions scattered per-stage-page. Build: aggregate s80 items/doc re-uploads/nudges into one surface.
- **G5 No document expiry tracking.** Police checks/CoGS/certified copies have validity windows; doc state stores only uploaded/fileName/status. Build: expiry date + renewal nudges.
- **G6 No notification preferences / broad unsubscribe** (GP-side). Build: prefs in account.html + List-Unsubscribe on all GP emails.

RSO ops:
- **R1 No SLA/stuck-cases dashboard for RSOs.** /api/admin/sla/check (43132) orphaned (no cron/UI); aging is CEO-only. Build: "Stuck cases" view + wire sla/check to cron.
- **R2 No auto-chasing of non-responders** (practices not returning SPPA, AHPRA officers not replying, GP doc stalls beyond myintealth/amc). Build: N-day no-response reminder scheduler.
- **R3 Built-but-no-UI server features:** visa questionnaire flow (41746+), RSO CRUD incl mailbox link (29738/29816), stage-rollback override (29099), sla/check. Build: wire into admin.html.
- **R4 No RSO team management / leave-coverage / bulk reassignment** UI. Build: Team tab + "reassign all A→B" + away flag.

## TIER 2 — MEDIUM

Platform: PWA manifest+icons absent (sw.js built, not installable); push pipeline dead 3 ways (no native app, gpRegisterPush native-only, legacy FCM API shut down 2024); media/videos 120MB in function bundle (250MB limit risk); migration ledger absent (silent 404-skip masks unapplied migrations); pending_hires dead table; 231 select=* / unbounded registration_cases+gp_applications CEO fetches; standardize 500 responses.
CEO: cron health card; 12-week trend chart (trends computed, 4 fields shown as arrows); cross-system conversion funnel + time-to-placement; GP acquisition/source attribution; PEP launch button (endpoint 43656, no UI).
Practice/site: per-job SEO JSON-LD JobPosting + sitemap enrichment (Google-for-Jobs); one-click convert-enquiry-to-practice+intake; corporation parent link + rollup (org_type flat, no parent_practice_id).
RSO: generic inbound email categories never branched (visa/Medicare/practice-enquiry collapse to one email_triage task); outbound template library (playbooks 6 stages, visa aliased to ahpra); GP list filters (stage/RSO/country/age); consistent admin audit coverage (doc approve writes no timeline row); targeted stage-rollback UI; per-RSO caseload view; structured call-outcome logging.
Security: audit-log breadth (CV/contract downloads, offer sends, consultant grant, status changes unlogged); email bounce/complaint webhook + suppression + send-failure retry; per-GP notification prefs/quiet hours; .env.example 78 vars behind; per-account admin lockout.
GP: persistent AI-rejection reason; in-app re-upload nudge; server-authoritative 3-fail escalation; API-failure/offline UX; cross-device alert feed; GDPR data export; self-serve email change; sign-out-all-devices; commencement lock explanation; server-side per-country doc requirements.

## TIER 3 — CONCRETE BUGS (broken, not just missing)

- Support nav → 404 (account.html:461 → nonexistent support.html).
- Support alert deep links land wrong (updates-sync emits #case-/#tab-cases; messages router only handles #ticket-/#tab-action).
- Visa + PBS can never show "Completed" (hard-coded done:false app-shell.js:688,697 + index.html:1494).
- CEO "Completed" trend arrow permanently "unchanged" (trendMap completed→'completions' but payload field is completions_done).
- Doc-approve writes no timeline row while reject does (audit under-records approvals; server.js:39546 vs 39641).
- admin.html interviews panel toggles a `data-view="interviews"` tab that doesn't exist (no tab highlights).
- Visa AI suggest-reply grounded on AHPRA playbook (registration-playbook.js:38 visa→ahpra alias).
- auth-guard fail modes both wrong: network fail → permanent "Under Review" overlay; unknown account_status → fail-open full access (auth-guard.js:190-207).
- Delete modal over-promises "signs you out of all devices" — no mechanism.
- CLAUDE.md says OTP login; shipped UI is password (OTP endpoints dead code).
- Interview booking Zoom→GCal→PATCH non-transactional (can orphan Zoom/GCal on partial fail).
- 23 handlers leak e.message in 500s.

## Non-findings (checked, OK)
Sessions HMAC-signed HttpOnly/SameSite=Strict/Secure + server expiry; rate limiting on OTP/login/admin-login; admin_audit_log table exists (thin coverage); RLS lockdown migration; refresh tokens hashed+rotated; HSTS+CSP+XFO+nosniff in prod; CEO Registration/Oversight tabs complete; all stage pages built (Visa the only deliberate stub); every GP-page fetch resolves (no 404 API calls); Zoho UI-side removal clean; client error telemetry + service worker solid.