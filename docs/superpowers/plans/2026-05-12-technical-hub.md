# Technical Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build a CEO-only Technical tab in admin.html with integration status monitoring, AI-powered codebase scanning, and automatic frontend error capture.

**Architecture:** New tab in admin.html with 3 sub-panels (Integrations, System Bugs, User Bugs). Server-side aggregation endpoints under /api/ceo/technical/*. GitHub Action for daily AI code scanning. Lightweight error-reporter.js on all pages.

**Tech Stack:** Vanilla JS/HTML, Node.js server.js, Supabase, GitHub Actions, Claude API

**Spec:** `docs/superpowers/specs/2026-05-12-technical-hub-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260512000000_technical_hub.sql` | CREATE | system_bugs + client_errors tables + indexes |
| `js/error-reporter.js` | CREATE | Lightweight global error capture (~30 lines) |
| `server.js` | EDIT | /api/errors/report, /api/ceo/integrations, /api/ceo/technical/* endpoints |
| `pages/admin.html` | EDIT | Technical tab + sub-nav + Integrations/System Bugs/User Bugs panels |
| `.github/workflows/ai-code-scan.yml` | CREATE | Daily + push AI code scanning workflow |
| All `pages/*.html` files | EDIT | Add error-reporter.js script tag |

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260512000000_technical_hub.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Technical Hub: system_bugs + client_errors tables

CREATE TABLE IF NOT EXISTS system_bugs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  category TEXT NOT NULL DEFAULT 'reliability'
    CHECK (category IN ('security', 'reliability')),
  file_path TEXT NOT NULL,
  line_number INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggestion TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'fixed', 'dismissed')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  scan_type TEXT NOT NULL DEFAULT 'daily'
    CHECK (scan_type IN ('daily', 'push', 'weekly_full')),
  commit_sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_bugs_status ON system_bugs (status, severity);
CREATE INDEX IF NOT EXISTS idx_system_bugs_scan ON system_bugs (scan_id);

CREATE TABLE IF NOT EXISTS client_errors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  page_url TEXT,
  user_email TEXT,
  user_agent TEXT,
  browser_info TEXT,
  user_context TEXT,
  error_hash TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'investigating', 'resolved', 'ignored')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_client_errors_status ON client_errors (status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_hash ON client_errors (error_hash);
```

- [ ] **Step 2: Commit and push**

```bash
git add supabase/migrations/20260512000000_technical_hub.sql
git commit -m "feat: add system_bugs + client_errors tables for Technical Hub"
git push
```

---

### Task 2: Error Reporter Script + Server Endpoint

**Files:**
- Create: `js/error-reporter.js`
- Modify: `server.js` — add `POST /api/errors/report` endpoint

- [ ] **Step 1: Create js/error-reporter.js**

The script must:
- Add `window.onerror` and `unhandledrejection` listeners
- Rate limit to 10 reports/minute client-side
- Deduplicate by message+url hash within the session
- Extract user email from localStorage `gp_session` if available
- POST to `/api/errors/report` with: message, stack, url, email, userAgent
- Show a subtle toast "Something went wrong — we've been notified" on error
- Expose `window.gpReportError(msg, context)` for manual reporting with user context
- Use `var` not `const/let`, `function(){}` not arrows — match codebase style
- Keep under 50 lines, no dependencies

- [ ] **Step 2: Add POST /api/errors/report endpoint to server.js**

Add BEFORE the CEO DASHBOARD ENDPOINTS section (before line ~27128). This endpoint is PUBLIC (no auth) but rate-limited.

Logic:
1. Rate limit: `checkRateLimitWindow('error_report:' + getClientIp(req), 10, 60000)`
2. Read JSON body: message, stack, url, email, userAgent, context
3. Compute `error_hash = crypto.createHash('sha256').update((message || '') + '|' + (url || '')).digest('hex')`
4. Check if hash exists: `supabaseDbRequest('client_errors', 'select=id,occurrence_count&error_hash=eq.' + hash + '&limit=1')`
5. If exists: PATCH to increment `occurrence_count`, update `last_seen_at`, append `user_context` if provided
6. If not: INSERT new row with all fields
7. Return `{ ok: true }`

- [ ] **Step 3: Verify syntax and commit**

```bash
node -c server.js
git add js/error-reporter.js server.js
git commit -m "feat: add error-reporter.js + /api/errors/report endpoint"
git push
```

---

### Task 3: Integration Status + Technical Bug Endpoints

**Files:**
- Modify: `server.js` — add /api/ceo/integrations, /api/ceo/technical/* endpoints

- [ ] **Step 1: Add GET /api/ceo/integrations endpoint**

Add after the existing CEO escalation endpoints. Uses `requireCeoSession`. Aggregates status from:

| Integration | Status check | Key details |
|-------------|-------------|-------------|
| Gmail | `isGmailConfigured()` + query `gmail_watch_state` | watch_expiry, client auth, processed count |
| Zoho Recruit | `getZohoRecruitConnection()` | connected_email, last_sync_at, last_sync_status, role_count |
| Zoho Sign | `getZohoSignConnection()` | connected_email, org_name, token_expires_at, webhook_registered |
| Supabase | `isSupabaseDbConfigured()` + test query | ping_ok, config status |
| Anthropic | `ANTHROPIC_API_KEY` check + `_hydrateAiSpend()` | daily_spend_usd, daily_limit_usd, call_count |
| DoubleTick | `DOUBLETICK_API_KEY` + `DOUBLETICK_WEBHOOK_SECRET` | api_key_configured, webhook_configured |
| Google Drive | `isGoogleDriveConfigured()` | service_account, root_folder |

Status logic: "connected" = all checks pass, "disconnected" = config missing, "degraded" = partial failure.

- [ ] **Step 2: Add POST /api/ceo/integrations/:key/reconnect endpoint**

Handles reconnection for gmail (calls setupGmailWatch), zoho_recruit (returns OAuth URL), zoho_sign (returns OAuth URL). Returns 400 for non-reconnectable integrations.

- [ ] **Step 3: Add GET /api/ceo/technical/system-bugs endpoint**

Query `system_bugs` table. Default filter: `status=eq.open`. Accepts `?status=all` for everything. Returns bugs array + summary counts.

- [ ] **Step 4: Add PUT /api/ceo/technical/system-bugs/:id endpoint**

Update bug status. Body: `{ status: "acknowledged" | "fixed" | "dismissed" }`. Sets `resolved_by` and `resolved_at` when fixing/dismissing.

- [ ] **Step 5: Add GET /api/ceo/technical/client-errors endpoint**

Query `client_errors` table. Default filter: `status=eq.open`. Returns errors + summary with occurrence counts.

- [ ] **Step 6: Add PUT /api/ceo/technical/client-errors/:id endpoint**

Update error status. Body: `{ status: "investigating" | "resolved" | "ignored" }`.

- [ ] **Step 7: Add POST /api/ceo/technical/system-bugs/ingest endpoint**

Authenticated via CRON_SECRET (same as other cron endpoints). Called by GitHub Action. Accepts `{ scan_id, scan_type, commit_sha, findings: [...] }`. Deduplicates by file_path + line_number + title.

- [ ] **Step 8: Verify syntax and commit**

```bash
node -c server.js
git add server.js
git commit -m "feat: add integration status + technical bug endpoints"
git push
```

---

### Task 4: admin.html — Technical Tab

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add Technical tab to the tab bar**

After the Ops Queue tab (line ~825), add:
```html
<div class="view-tab" data-view="technical" id="technicalTab" style="display:none">Technical</div>
```

- [ ] **Step 2: Add the Technical panel div**

Before the `#escalateCeoModal` div, add the Technical panel with sub-navigation and 3 sub-panels:
- Sub-nav: Integrations | System Bugs | User Bugs
- `#techIntegrationsPanel` — integration cards grid
- `#techSystemBugsPanel` — bug list with filters
- `#techUserBugsPanel` — error list with filters

- [ ] **Step 3: Show Technical tab for SA users**

In the `if(isSA())` block (line ~5003), add:
```javascript
var techTab=document.getElementById("technicalTab");
if(techTab)techTab.style.display="";
```

- [ ] **Step 4: Update vaShowPanel to include technicalPanel**

Add `"technicalPanel":"technical"` to the panels object.

- [ ] **Step 5: Add tab click handler for technical view**

In the tab click handler, add:
```javascript
}else if(view==="technical"){
  loadTechnicalPanel();
}
```

- [ ] **Step 6: Implement loadTechnicalPanel + rendering functions**

JavaScript functions:
- `loadTechnicalPanel()` — loads integrations by default
- `loadIntegrations()` — fetch GET /api/ceo/integrations, render cards
- `loadSystemBugs(status)` — fetch GET /api/ceo/technical/system-bugs, render list
- `loadUserBugs(status)` — fetch GET /api/ceo/technical/client-errors, render list
- `reconnectIntegration(key)` — POST /api/ceo/integrations/:key/reconnect
- `updateBugStatus(id, status)` — PUT /api/ceo/technical/system-bugs/:id
- `updateErrorStatus(id, status)` — PUT /api/ceo/technical/client-errors/:id

Styling: Use existing admin.html CSS patterns (cards, badges, buttons, tables). Integration cards use a 3-column grid. Status badges: green=connected, red=disconnected, amber=degraded.

- [ ] **Step 7: Commit and push**

```bash
git add pages/admin.html
git commit -m "feat: add Technical tab in admin.html — integrations, system bugs, user bugs"
git push
```

---

### Task 5: Add error-reporter.js to All HTML Pages

**Files:**
- Modify: All 29 HTML files in `pages/`

- [ ] **Step 1: Add script tag to every HTML page**

Add `<script src="/js/error-reporter.js?v=20260512a"></script>` before the closing `</body>` tag (or before existing scripts) in every page that doesn't already have it. The tag should be one of the FIRST scripts loaded so it catches errors in subsequent scripts.

Pages to modify: account.html, admin-pbs.html, admin-signin.html, admin-visa.html, admin.html, ahpra.html, amc.html, app-shell.html, application-detail.html, area-guide.html, career.html, ceo-dashboard.html, commencement.html, inbox.html, index.html, interview-prep.html, job.html, messages.html, my-documents.html, myinthealth.html, offer-review.html, onboarding.html, pbs.html, privacy.html, registration-intro.html, signin.html, support-cases.html, terms.html, visa.html

- [ ] **Step 2: Commit and push**

```bash
git add pages/*.html js/error-reporter.js
git commit -m "feat: add error-reporter.js to all HTML pages for automatic error capture"
git push
```

---

### Task 6: GitHub Action — AI Code Scanner

**Files:**
- Create: `.github/workflows/ai-code-scan.yml`

- [ ] **Step 1: Create the workflow file**

The workflow must:
- Trigger on: `schedule: cron: '0 2 * * *'` (daily 2am UTC) and `push: branches: [main]`
- Checkout the repo
- Determine scan scope:
  - Push: `git diff HEAD~1 --name-only` for changed files
  - Schedule (weekday): `git log --since='24 hours ago' --format='%H' | tail -1` for diff base
  - Schedule (Sunday): full scan of critical files (server.js, js/auth-guard.js, js/state-sync.js)
- Filter to only .js and .html files (skip images, docs, etc.)
- For each file (max 5 per run to control costs):
  - Read file content (truncate to 50,000 chars for large files like server.js)
  - Call Claude API (claude-sonnet-4-20250514) with security+reliability system prompt
  - Parse JSON response for findings
- POST all findings to `$APP_URL/api/ceo/technical/system-bugs/ingest` with CRON_SECRET auth
- Uses secrets: `ANTHROPIC_API_KEY`, `CRON_SECRET`, `APP_URL`

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/ai-code-scan.yml
git commit -m "feat: add AI code scanner GitHub Action — daily + push security/reliability scan"
git push
```

---

## Dependency Graph

```
Task 1 (migration) ──┐
                      ├── Task 3 (server endpoints) ──┐
Task 2 (error-reporter + /api/errors/report) ─────────┤
                                                       ├── Task 4 (admin.html Technical tab)
                                                       │
Task 5 (add script to all pages) ─── depends on Task 2 │
                                                       │
Task 6 (GitHub Action) ─── depends on Task 3 ─────────┘
```

Tasks 1 + 2 can run in parallel. Task 3 depends on both. Task 4 depends on Task 3. Task 5 depends on Task 2. Task 6 depends on Task 3.
