# Technical Hub — Design Spec

**Date:** 2026-05-12
**Author:** Claude (brainstorming session with Khaleed)
**Status:** Approved for implementation

---

## 1. Purpose

A CEO-only "Technical" tab in admin.html with three sections: Integrations Status, System Bugs (AI-powered daily scan), and User Bugs (automatic frontend error capture). Gives the CEO full visibility into the health of every external service, proactive detection of codebase issues, and real-time awareness of errors users encounter.

---

## 2. Access Control

- **Tab visibility:** Only shown when `isSA()` returns true (same gate as Home Dashboard tab)
- **API endpoints:** All `/api/ceo/technical/*` endpoints use `requireCeoSession(req, res)`
- **Error reporting endpoint:** `POST /api/errors/report` is public (no auth required — must work for logged-out users hitting errors) but rate-limited to 10 requests/minute per IP

---

## 3. Database Changes (New Migration)

### 3.1 `system_bugs` table

```sql
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
```

### 3.2 `client_errors` table

```sql
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

The `error_hash` field is a SHA-256 of `error_message + page_url` — used to group duplicate errors. When the same error occurs again, `occurrence_count` is incremented and `last_seen_at` is updated instead of creating a new row.

---

## 4. Server-Side Changes (server.js)

### 4.1 `GET /api/ceo/integrations`

Returns the status of all 7 integrations in one response. Uses existing config check functions and database queries.

```json
{
  "ok": true,
  "integrations": [
    {
      "key": "gmail",
      "name": "Gmail (Auto-Parse)",
      "status": "connected",
      "details": {
        "monitored_email": "hazel@mygplink.com.au",
        "watch_expiry": "2026-05-18T00:00:00Z",
        "watch_active": true,
        "last_processed_at": "2026-05-12T08:30:00Z",
        "processed_count_24h": 5,
        "client_auth_ok": true,
        "client_error": null
      },
      "can_reconnect": true,
      "reconnect_action": "setup_watch"
    },
    {
      "key": "zoho_recruit",
      "name": "Zoho Recruit",
      "status": "connected",
      "details": {
        "connected_email": "hazel@mygplink.com.au",
        "last_sync_at": "2026-05-12T06:00:00Z",
        "last_sync_status": "success",
        "last_sync_error": null,
        "role_count": 47,
        "missing_scopes": [],
        "needs_reconnect": false
      },
      "can_reconnect": true,
      "reconnect_action": "oauth_redirect"
    },
    {
      "key": "zoho_sign",
      "name": "Zoho Sign",
      "status": "connected",
      "details": {
        "connected_email": "hazel@mygplink.com.au",
        "org_name": "GP Link",
        "token_expires_at": "2026-05-12T12:00:00Z",
        "webhook_registered": true,
        "template_configured": true,
        "envelope_count": 3
      },
      "can_reconnect": true,
      "reconnect_action": "oauth_redirect"
    },
    {
      "key": "supabase",
      "name": "Supabase (Database)",
      "status": "connected",
      "details": {
        "url_configured": true,
        "service_role_configured": true,
        "publishable_key_configured": true,
        "ping_ok": true,
        "ping_ms": 45
      },
      "can_reconnect": false,
      "reconnect_action": null
    },
    {
      "key": "anthropic",
      "name": "Anthropic AI",
      "status": "connected",
      "details": {
        "api_key_configured": true,
        "daily_spend_usd": 2.45,
        "daily_limit_usd": 100,
        "daily_call_count": 12,
        "budget_remaining_pct": 97.6
      },
      "can_reconnect": false,
      "reconnect_action": null
    },
    {
      "key": "doubletick",
      "name": "DoubleTick (WhatsApp)",
      "status": "connected",
      "details": {
        "api_key_configured": true,
        "webhook_secret_configured": true,
        "webhook_active": true
      },
      "can_reconnect": false,
      "reconnect_action": null
    },
    {
      "key": "google_drive",
      "name": "Google Drive",
      "status": "connected",
      "details": {
        "service_account_configured": true,
        "root_folder_configured": true,
        "root_folder_id": "1abc..."
      },
      "can_reconnect": false,
      "reconnect_action": null
    }
  ]
}
```

**Status logic per integration:**

| Integration | "connected" when | "disconnected" when | "degraded" when |
|-------------|-----------------|--------------------|--------------------|
| Gmail | `isGmailConfigured()` + watch not expired + client auth OK | config missing | watch expired OR client auth error |
| Zoho Recruit | connection exists + status='active' + no missing required scopes | no connection OR status='disconnected' | missing scopes OR needs_reconnect |
| Zoho Sign | connection exists + refresh_token present | no connection | token expired + refresh failed |
| Supabase | `isSupabaseDbConfigured()` + test query succeeds | config missing | test query fails |
| Anthropic | API key configured + budget > 0% | key missing | budget > 90% used |
| DoubleTick | API key + webhook secret configured | either missing | N/A |
| Google Drive | `isGoogleDriveConfigured()` | config missing | N/A |

### 4.2 `POST /api/ceo/integrations/:key/reconnect`

Triggers reconnection for integrations that support it. CEO-only.

| Key | Action |
|-----|--------|
| `gmail` | Calls `setupGmailWatch()` for each monitored email. Returns new watch expiry. |
| `zoho_recruit` | Returns the OAuth authorization URL for user to visit. Redirect goes to existing callback. |
| `zoho_sign` | Returns the OAuth authorization URL. Redirect goes to existing callback. |
| Others | Returns 400 — reconnection not supported (env var config). |

### 4.3 `GET /api/ceo/technical/system-bugs`

Returns system bugs from AI scans. Query params: `?status=open` (default), `?status=all`.

```json
{
  "ok": true,
  "bugs": [
    {
      "id": "uuid",
      "severity": "high",
      "category": "security",
      "file_path": "server.js",
      "line_number": 1234,
      "title": "Missing input validation on career apply endpoint",
      "description": "The /api/career/apply endpoint doesn't validate...",
      "suggestion": "Add validation for...",
      "status": "open",
      "scan_type": "daily",
      "commit_sha": "abc123",
      "created_at": "2026-05-12T02:00:00Z"
    }
  ],
  "summary": {
    "open": 3,
    "acknowledged": 1,
    "critical": 1,
    "high": 2,
    "medium": 0,
    "low": 0
  }
}
```

### 4.4 `PUT /api/ceo/technical/system-bugs/:id`

Update bug status. CEO-only. Body: `{ status: "acknowledged" | "fixed" | "dismissed" }`.

### 4.5 `GET /api/ceo/technical/client-errors`

Returns client errors grouped by error_hash. Query params: `?status=open` (default), `?status=all`.

```json
{
  "ok": true,
  "errors": [
    {
      "id": "uuid",
      "error_message": "Cannot read property 'stage' of undefined",
      "error_stack": "at renderStep (registration-stepper.js:45)...",
      "page_url": "/pages/amc.html",
      "occurrence_count": 12,
      "first_seen_at": "2026-05-10T14:00:00Z",
      "last_seen_at": "2026-05-12T09:30:00Z",
      "affected_users": ["smith@gmail.com", "jones@gmail.com"],
      "user_context": "Tried to submit AMC form but got blank screen",
      "status": "open",
      "browser_info": "Chrome 125 / macOS"
    }
  ],
  "summary": {
    "open": 5,
    "investigating": 1,
    "total_occurrences_24h": 23
  }
}
```

### 4.6 `PUT /api/ceo/technical/client-errors/:id`

Update error status. CEO-only. Body: `{ status: "investigating" | "resolved" | "ignored" }`.

### 4.7 `POST /api/errors/report`

Public endpoint (no auth) for frontend error reporting. Rate-limited to 10/min per IP.

Request body:
```json
{
  "message": "Cannot read property...",
  "stack": "at line 45...",
  "url": "/pages/amc.html",
  "email": "user@gmail.com",
  "userAgent": "Mozilla/5.0...",
  "context": "User typed: 'I was trying to upload my document'"
}
```

Logic:
1. Compute `error_hash = SHA256(message + url)`
2. Check if error_hash exists in `client_errors`:
   - If yes: `UPDATE SET occurrence_count = occurrence_count + 1, last_seen_at = now(), user_agent = $ua`
   - If no: `INSERT` new row
3. If user provided `context`, append to `user_context` field
4. Return `{ ok: true }`

---

## 5. GitHub Action — AI Code Scanner

### 5.1 Workflow file: `.github/workflows/ai-code-scan.yml`

**Triggers:**
- `schedule: cron: '0 2 * * *'` (daily at 2am UTC)
- `push: branches: [main]` (on every push)

**Steps:**
1. Checkout repo
2. Determine scan scope:
   - Push trigger: `git diff HEAD~1 --name-only` (changed files in last commit)
   - Schedule trigger: `git diff --name-only $(git log --since='24 hours ago' --format='%H' | tail -1)..HEAD` (changed in last 24h)
   - If Sunday: full scan of critical files (`server.js`, `js/auth-guard.js`, `js/state-sync.js`, `js/onboarding.js`)
3. For each changed file (or critical file on full scan):
   - Read file content
   - Send to Claude API with security+reliability focused system prompt
   - Parse structured JSON response (array of findings)
4. For each finding:
   - POST to `https://app.mygplink.com.au/api/ceo/technical/system-bugs/ingest` with auth secret
5. Post summary to GitHub Actions output

### 5.2 System prompt for AI scanner

```
You are a security and reliability auditor for a production Node.js web application
that handles GP (doctor) registration for migration to Australia. This is a real
application with real users and real data.

Analyze the provided code for:

SECURITY:
- Injection risks (SQL, command, XSS, header injection)
- Authentication/authorization bypasses
- Exposed secrets or credentials in code
- Unsafe input handling (missing validation, sanitization)
- CSRF vulnerabilities
- Insecure cookie/session handling

RELIABILITY:
- Unhandled promise rejections or missing try/catch
- Silent error swallowing (catch blocks that don't log or rethrow)
- Missing null/undefined checks that could crash
- Race conditions in async operations
- Data loss scenarios (writes without confirmation)
- Dead code paths that will never execute

DO NOT flag:
- Code style or formatting issues
- Missing TypeScript types
- Performance optimizations (unless causing timeouts)
- Test coverage gaps
- Documentation gaps

Return a JSON array of findings:
[
  {
    "severity": "critical|high|medium|low",
    "category": "security|reliability",
    "line": 123,
    "title": "Short description",
    "description": "Detailed explanation of the issue",
    "suggestion": "How to fix it"
  }
]

Return an empty array [] if no issues found. Be precise — no false positives.
Only flag real issues that could cause security breaches or production failures.
```

### 5.3 Ingest endpoint: `POST /api/ceo/technical/system-bugs/ingest`

Server-side endpoint called by the GitHub Action. Authenticated via `CRON_SECRET` (same as other cron endpoints).

Request body:
```json
{
  "scan_id": "daily-2026-05-12",
  "scan_type": "daily",
  "commit_sha": "abc123",
  "findings": [
    {
      "severity": "high",
      "category": "security",
      "file_path": "server.js",
      "line_number": 1234,
      "title": "Missing input validation",
      "description": "...",
      "suggestion": "..."
    }
  ]
}
```

Logic:
1. Verify `Authorization: Bearer <CRON_SECRET>`
2. For each finding, check if a matching open bug already exists (same file_path + line_number + title)
   - If yes: skip (don't create duplicate)
   - If no: INSERT into `system_bugs`
3. Return `{ ok: true, inserted: N, skipped: N }`

---

## 6. Frontend — `js/error-reporter.js`

A lightweight script (~30 lines) loaded on every page. No dependencies.

```javascript
(function() {
  var reported = {};
  var MAX_PER_MIN = 10;
  var count = 0;
  var resetAt = Date.now() + 60000;

  function report(msg, stack, url) {
    if (count >= MAX_PER_MIN) return;
    var hash = msg + '|' + url;
    if (reported[hash]) return;
    reported[hash] = true;
    count++;
    if (Date.now() > resetAt) { count = 0; resetAt = Date.now() + 60000; }

    var email = '';
    try { var s = localStorage.getItem('gp_session'); if (s) { var p = JSON.parse(s); email = p.email || ''; } } catch(e) {}

    var body = { message: String(msg).slice(0, 1000), stack: String(stack || '').slice(0, 2000), url: url || location.pathname, email: email, userAgent: navigator.userAgent };
    fetch('/api/errors/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function() {});
  }

  window.onerror = function(msg, source, line, col, err) {
    report(msg, err && err.stack, location.pathname);
  };
  window.addEventListener('unhandledrejection', function(e) {
    var msg = e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled promise rejection';
    var stack = e.reason && e.reason.stack;
    report(msg, stack, location.pathname);
  });

  // Expose for manual reporting with user context
  window.gpReportError = function(msg, context) {
    var body = { message: String(msg).slice(0, 1000), url: location.pathname, userAgent: navigator.userAgent, context: String(context || '').slice(0, 500) };
    try { var s = localStorage.getItem('gp_session'); if (s) { var p = JSON.parse(s); body.email = p.email || ''; } } catch(e) {}
    fetch('/api/errors/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function() {});
  };
})();
```

Added to every HTML page as: `<script src="/js/error-reporter.js?v=20260512a"></script>`

When an error occurs, shows a brief toast: "Something went wrong — we've been notified" with an optional "Tell us what happened" link that calls `gpReportError(errorMsg, userText)`.

---

## 7. Frontend — admin.html Technical Tab

### 7.1 Tab structure

New tab "Technical" in admin.html tab bar (after Ops Queue), hidden unless `isSA()`.

Sub-navigation within the Technical tab:
- **Integrations** (default) — integration cards
- **System Bugs** — AI scan findings
- **User Bugs** — client error reports

### 7.2 Integrations sub-panel

7 cards in a responsive grid (3 columns on desktop, 1 on mobile). Each card shows:
- Integration name + icon
- Status badge: green "Connected", red "Disconnected", amber "Degraded"
- Key detail lines (2-3 per integration)
- "Reconnect" button (for Gmail, Zoho Recruit, Zoho Sign)
- "Last checked: Xs ago" footer

Auto-refreshes every 60 seconds.

### 7.3 System Bugs sub-panel

- Filter bar: Open (default) | Acknowledged | Fixed | All
- Summary strip: X critical, Y high, Z medium bugs
- Bug list: severity badge, file:line, title, description (expandable), suggestion, scan date
- Actions per bug: Acknowledge, Mark Fixed, Dismiss
- Each action calls `PUT /api/ceo/technical/system-bugs/:id`

### 7.4 User Bugs sub-panel

- Filter bar: Open (default) | Investigating | Resolved | All
- Summary strip: X open errors, Y occurrences in 24h
- Error list: error message, page, occurrence count, first/last seen, affected users (count), user context (if provided)
- Expandable: full stack trace, browser info
- Actions per error: Investigate, Resolve, Ignore
- Each action calls `PUT /api/ceo/technical/client-errors/:id`

---

## 8. Files Created / Modified

| File | Action | Description |
|------|--------|-------------|
| `supabase/migrations/20260512000000_technical_hub.sql` | CREATE | system_bugs + client_errors tables |
| `server.js` | EDIT | Add /api/ceo/integrations, /api/ceo/technical/* endpoints, /api/errors/report |
| `js/error-reporter.js` | CREATE | Lightweight global error capture script |
| `pages/admin.html` | EDIT | Add Technical tab + sub-nav + 3 sub-panels |
| `.github/workflows/ai-code-scan.yml` | CREATE | Daily + push AI code scanning workflow |
| All HTML pages in `pages/` | EDIT | Add `<script src="/js/error-reporter.js">` tag |

---

## 9. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes (existing) | Used by GitHub Action for Claude API calls |
| `CRON_SECRET` | Yes (existing) | Auth for system bug ingest endpoint |
| `APP_URL` | Yes (new, in GitHub Action) | Base URL for ingest endpoint (https://app.mygplink.com.au) |

GitHub Action secrets needed:
- `ANTHROPIC_API_KEY` — for Claude API calls in the scanner
- `CRON_SECRET` — for authenticating the ingest endpoint
- `APP_URL` — production URL

---

## 10. What This Spec Does NOT Include

- No Slack/email alerting for critical bugs (can add later)
- No historical trend charts for error rates (v1 shows current state only)
- No auto-fix capability (AI finds bugs, humans fix them)
- No source map support for minified stack traces (not needed — no minification in this app)
- No error replay/recording (too complex for v1)

---

## 11. Success Criteria

1. CEO sees all 7 integrations with live status on the Technical tab
2. Gmail/Zoho reconnect buttons work and update status immediately
3. AI scanner runs daily and on push, findings appear in System Bugs panel
4. Frontend errors from any page are automatically captured and appear in User Bugs panel within seconds
5. CEO can acknowledge/resolve/dismiss bugs from the dashboard
6. Error reporter script adds < 1KB to page load and doesn't affect page performance
7. Duplicate errors are grouped (not creating thousands of rows)
