# Update 1 — CEO Dashboard & Technical Hub

**Date:** 2026-05-12 to 2026-05-13
**Status:** Code complete on `main`, pending production deployment

---

## 1. CEO Command Centre Dashboard

New standalone dark-themed page at `/pages/ceo-dashboard.html` — accessible only to `khaleedmahmoud1211@gmail.com`.

### Features
- **6 KPI cards** — real-time pipeline health at a glance
- **Pipeline funnel** — Secure Placement > MyIntealth > AMC > AHPRA > PBS > Commencement with blocked counts per stage
- **Time filter** — Current / 7 days / 14 days / 30 days / All Time (cumulative funnel mode)
- **Blocker tracking** — surfaces GPs stuck at a stage with reasons
- **VA task accountability** — workload distribution, overdue tasks, response times
- **GP activity feed** — recent logins, document uploads, stage changes
- **Support ticket overview** — open/pending/resolved counts with response metrics
- **Completion tracking** — GPs who finished the pipeline, with fallback for pre-migration cases
- **Placement metrics** — unique GP count (deduplicated by user_id, not application count)
- **Velocity trends** — 12-week weekly trend charts
- **Auto-refresh** — dashboard every 30s, trends every 5 min

### Escalation System
- VAs can escalate tasks to CEO from admin dashboard (button + modal)
- Escalated tasks appear as a dedicated section on CEO dashboard
- CEO can respond to or resolve escalations inline
- Graceful fallback: if DB migration not yet applied, escalation saves as "blocked" status with escalation metadata in timeline

### Admin Integration
- New "Home Dashboard" tab in admin.html (CEO-only, loads ceo-dashboard.html in iframe)
- Escalation badge on tasks in admin task list

---

## 2. Technical Hub

New CEO-only "Technical" tab in admin.html with 3 sub-panels.

### 2a. Integration Status Monitor
Live status cards for all 7 integrations:
| Integration | Status checks |
|---|---|
| Gmail | Config + watch expiry + processed count |
| Zoho Recruit | Connection + last sync status + role count |
| Zoho Sign | Connection + token expiry + webhook status |
| Supabase | Config + ping test |
| Anthropic AI | API key + daily spend vs limit |
| DoubleTick | API key + webhook secret |
| Google Drive | Service account + root folder |

- Status badges: green (connected), red (disconnected), amber (degraded)
- Reconnect buttons for Gmail, Zoho Recruit, Zoho Sign

### 2b. System Bugs (AI Code Scanner)
- GitHub Action (`.github/workflows/ai-code-scan.yml`) runs daily at 2am UTC + on every push to main
- Scans changed files with Claude Sonnet for security and reliability issues
- Sunday full scan of critical files (server.js, auth-guard.js, state-sync.js)
- Findings ingested via `/api/ceo/technical/system-bugs/ingest` (CRON_SECRET auth)
- Admin panel: filter by status, update status (open/acknowledged/fixed/dismissed)

### 2c. User Bugs (Automatic Error Capture)
- `js/error-reporter.js` added to all 29 HTML pages
- Captures `window.onerror` and `unhandledrejection` events automatically
- Client-side rate limit (10/min) and session deduplication
- Shows subtle toast: "Something went wrong — we've been notified"
- Manual reporting: `window.gpReportError(msg, context)`
- Server deduplicates by SHA-256 hash of message + URL, tracks occurrence count
- Admin panel: filter by status, update status (open/investigating/resolved/ignored)

---

## 3. Database Migrations

### `20260511000000_ceo_dashboard.sql`
- Added `escalated` to task status CHECK constraint
- Added columns: `escalated_to`, `escalated_reason`, `escalated_at` on tasks
- Added `completed_at` on `registration_cases`
- Added `first_reply_at` on `support_tickets`
- New indexes for performance

### `20260512000000_technical_hub.sql`
- New `system_bugs` table (AI scan findings)
- New `client_errors` table (frontend error reports)
- Indexes on status, severity, scan_id, error_hash

---

## 4. Bug Fixes

### CEO Dashboard Fixes
- **GP login in iframe** — ceo-dashboard.html was caught by GP session guard; excluded it
- **Double admin header** — iframe `src=""` loaded parent page; changed to `src="about:blank"`
- **Auth stuck "Authenticating"** — session returns `profile.adminRole` not `profile.role`; check both
- **VA Workload "Unassigned"** — `case.assigned_va` is NULL; fallback to `task.assignee`
- **Applied includes Hired** — negative filter included secured+offer statuses; added exclusion Set
- **Wrong pipeline stages** — used database keys instead of user-facing journey order; reordered with labels
- **Withdrawn GPs counted** — no filter; now excludes withdrawn + 6-month inactive from all metrics
- **Velocity empty** — old timeline events lack metadata; parse title "Stage advanced to X" as fallback
- **Period filter incomplete** — only filtered cases, not tasks/apps/tickets; now filters all data
- **Drilldown ignores period** — added period parameter to all drilldown endpoints
- **Placed counts applications not GPs** — used Set of user_ids for unique count
- **Completions misses old cases** — `completed_at` NULL for pre-migration; fallback to `updated_at`

### Escalation Fixes
- **Task update fails** — escalation columns injected into every PATCH; separated escalation fields
- **Escalation fails** — `escalated` status rejected by DB constraint; fallback to `blocked` with silent escalation PATCH
- **Escalations invisible on dashboard** — searched only active case tasks; now searches ALL tasks
- **Escalation reason not shown** — reason was stripped before timeline log; captured before stripping

### Gmail Pipeline Fixes
- **Unmatched emails not creating tasks** — now creates tasks assigned to most recent active case with "Unmatched" prefix
- **Stale historyId recovery** — fetches last 5 inbox messages as fallback instead of returning empty
- **First-run processing** — falls through to process messages instead of just storing historyId

---

## 5. Server Endpoints Added

### CEO Dashboard API
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/ceo/dashboard` | CEO | All 9 dashboard sections + escalations |
| GET | `/api/ceo/drilldown/:section` | CEO | Detailed data for 8 sections |
| GET | `/api/ceo/trends` | CEO | 12-week weekly trend data |
| POST | `/api/ceo/escalation/:taskId/resolve` | CEO | Resolve an escalation |
| POST | `/api/ceo/escalation/:taskId/respond` | CEO | Respond to an escalation |

### Technical Hub API
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/errors/report` | Public (rate-limited) | Frontend error ingestion |
| GET | `/api/ceo/integrations` | CEO | 7 integration status cards |
| POST | `/api/ceo/integrations/:key/reconnect` | CEO | Reconnect Gmail/Zoho |
| GET | `/api/ceo/technical/system-bugs` | CEO | List AI scan findings |
| PUT | `/api/ceo/technical/system-bugs/:id` | CEO | Update bug status |
| GET | `/api/ceo/technical/client-errors` | CEO | List frontend errors |
| PUT | `/api/ceo/technical/client-errors/:id` | CEO | Update error status |
| POST | `/api/ceo/technical/system-bugs/ingest` | CRON_SECRET | GitHub Action posts findings |

---

## 6. Files Changed

### New Files
- `pages/ceo-dashboard.html` — CEO dashboard page (dark theme, 1797 lines)
- `js/error-reporter.js` — global error capture script (~67 lines)
- `.github/workflows/ai-code-scan.yml` — daily AI code scanning
- `supabase/migrations/20260511000000_ceo_dashboard.sql`
- `supabase/migrations/20260512000000_technical_hub.sql`

### Modified Files
- `server.js` — CEO auth, dashboard endpoints, technical hub endpoints, escalation handling, Gmail fixes
- `pages/admin.html` — Home Dashboard tab, Technical tab, escalation UI
- All 29 HTML pages in `pages/` — added error-reporter.js script tag

---

## 7. Deployment Note

All code is committed and pushed to `main`. Production deployment is blocked because the Vercel GitHub integration webhook is broken (since April 2026). The deploy hook redeploying from stale commit `2685559` instead of current HEAD `8f9eb6a`. Requires Vercel CLI (`vercel --prod`) or reconnecting the GitHub integration to deploy.
