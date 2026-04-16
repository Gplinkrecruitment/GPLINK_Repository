# Practice Pack Phase 2 — Zoho Sign + AI Email Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Zoho Sign SPPA-00 end-to-end (VA sends → signers sign → VA reviews → delivered to GP MyDocuments) and upgrade Phase 1b to Sonnet 4.6 with added AI triage of inbound GP-related emails.

**Architecture:** All server logic added to `server.js` (monolith pattern), following the existing Zoho Recruit OAuth and Gmail webhook patterns. Admin UI added to `pages/admin.html`. Zoho Sign connection reuses the existing `integration_connections` table with `provider='zoho_sign'` (Sign-specific fields stored in `metadata` jsonb). Two new purpose-built tables: `zoho_sign_envelopes` and `processed_zoho_sign_events`. AI triage extends the existing Gmail pipeline.

**Tech Stack:** Node.js / vanilla JS / Supabase / Vercel / Zoho Sign REST API (AU region) / Anthropic Sonnet 4.6 / crypto (HMAC-SHA256)

**Design deviation from spec:** Spec section 8.1 proposed a new `zoho_sign_connection` singleton. This plan uses the existing `integration_connections` table with `provider='zoho_sign'` (same pattern as Zoho Recruit at server.js:7759-7807) and stashes Sign-specific fields (`webhook_secret`, `webhook_registered_at`, `org_name`, `template_id`) in the existing `metadata` jsonb column. Rationale: DRY with existing OAuth infrastructure, zero schema duplication, proven upsert helper already handles the edge cases.

**Spec reference:** `docs/superpowers/specs/2026-04-17-practice-pack-phase2-design.md`

---

## File Structure

### New files
- `supabase/migrations/20260417000000_zoho_sign_and_email_triage.sql` — DB migration
- `tests/zoho-sign.test.js` — Unit tests for HMAC validation, event-to-status mapping, correction prefill builder
- `tests/email-triage.test.js` — Unit tests for AI triage parsing + GP matching logic

### Modified files
- `server.js` — All Zoho Sign OAuth, API client, envelope lifecycle, webhook, email triage, endpoints (~1500 new lines, grouped by concern)
- `pages/admin.html` — Integrations card, SPPA-00 task card, VA Review panel, Correction modal, Incoming Questions panel
- `vercel.json` — Add Zoho Sign token refresh cron entry
- Memory files — Update `MEMORY.md` + add `project_practice_pack_phase2.md` after completion

---

## Tasks Overview

| # | Task | TDD? |
|---|---|---|
| 1 | DB migration | No (schema) |
| 2 | Zoho Sign env + accounts-server helpers | Yes |
| 3 | Zoho Sign connection getter/upsert/refresh | Yes |
| 4 | Zoho Sign API client (GET/POST/DELETE with auth refresh) | Yes |
| 5 | OAuth endpoints (auth-url, callback, disconnect, status) | No (integration) |
| 6 | Envelope helpers (create/get/void/download/update-recipient) | Yes (pure parts) |
| 7 | Webhook endpoint + HMAC + idempotency + event handler | Yes |
| 8 | Send SPPA-00 endpoint (auto on career-secure + manual) | No |
| 9 | VA Review endpoints (preview, approve, correction, resend) | Yes (correction prefill) |
| 10 | Task listing augmentation (join envelope status) | No |
| 11 | Admin UI — Integrations Zoho Sign card | No |
| 12 | Admin UI — SPPA-00 task card 5-stage chip + buttons | No |
| 13 | Admin UI — VA Review panel + Correction modal | No |
| 14 | Upgrade Phase 1b AI matching to Sonnet 4.6 + prompt caching | Yes |
| 15 | AI email triage — placed GPs context + Sonnet classifier | Yes |
| 16 | Triage pipeline wiring + Incoming Questions endpoints | Yes |
| 17 | Admin UI — Incoming Questions panel | No |
| 18 | Zoho Sign token refresh cron | Yes |
| 19 | Final infra: env vars, migration run, OAuth consent, memory updates | No |

---

## Task 1: DB migration — envelopes, events, email todos, registration_tasks extensions

**Files:**
- Create: `supabase/migrations/20260417000000_zoho_sign_and_email_triage.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Practice Pack Phase 2 — Zoho Sign + AI email triage
-- 2026-04-17

-- 1. Zoho Sign envelope lifecycle records
CREATE TABLE IF NOT EXISTS zoho_sign_envelopes (
  envelope_id           text PRIMARY KEY,
  task_id               uuid REFERENCES registration_tasks(id) ON DELETE SET NULL,
  user_id               uuid,
  case_id               uuid REFERENCES registration_cases(id) ON DELETE SET NULL,
  template_id           text NOT NULL,
  status                text NOT NULL,
  recipient_contact     jsonb,
  recipient_candidate   jsonb,
  sent_at               timestamptz,
  completed_at          timestamptz,
  decline_reason        text,
  previous_envelope_id  text,
  correction_sections   text[],
  correction_note       text,
  signed_pdf_drive_id   text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zoho_sign_envelopes_task_id
  ON zoho_sign_envelopes(task_id);
CREATE INDEX IF NOT EXISTS idx_zoho_sign_envelopes_case_id
  ON zoho_sign_envelopes(case_id);
CREATE INDEX IF NOT EXISTS idx_zoho_sign_envelopes_status
  ON zoho_sign_envelopes(status);

-- 2. Webhook idempotency
CREATE TABLE IF NOT EXISTS processed_zoho_sign_events (
  notification_id   text PRIMARY KEY,
  envelope_id       text,
  event_type        text,
  received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_zoho_sign_events_envelope
  ON processed_zoho_sign_events(envelope_id);

-- 3. AI email triage to-dos
CREATE TABLE IF NOT EXISTS incoming_email_todos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id  text NOT NULL UNIQUE,
  matched_user_id   uuid,
  sender_email      text NOT NULL,
  subject           text,
  ai_category       text,
  ai_urgency        text,
  ai_summary        text,
  ai_confidence     real,
  needs_triage      boolean NOT NULL DEFAULT false,
  resolved_at       timestamptz,
  resolved_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incoming_email_todos_unresolved
  ON incoming_email_todos(created_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incoming_email_todos_user
  ON incoming_email_todos(matched_user_id);

-- 4. Link registration_tasks to their envelope
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS zoho_sign_envelope_id text;
CREATE INDEX IF NOT EXISTS idx_registration_tasks_envelope
  ON registration_tasks(zoho_sign_envelope_id)
  WHERE zoho_sign_envelope_id IS NOT NULL;
```

- [ ] **Step 2: Commit the migration**

```bash
git add supabase/migrations/20260417000000_zoho_sign_and_email_triage.sql
git commit -m "feat(phase2): DB migration — Zoho Sign envelopes + email triage tables"
```

---

## Task 2: Zoho Sign env vars + accounts-server helpers

**Files:**
- Modify: `server.js` — add after the existing Zoho Recruit env block around line 60
- Create: `tests/zoho-sign.test.js` — initial test scaffold

- [ ] **Step 1: Add env var declarations to `server.js`**

Locate the Zoho Recruit env block at `server.js:57-67`. Append a new block immediately after it:

```javascript
// ── Zoho Sign ─────────────────────────────────────────────
const ZOHO_SIGN_CLIENT_ID = String(process.env.ZOHO_SIGN_CLIENT_ID || '').trim();
const ZOHO_SIGN_CLIENT_SECRET = String(process.env.ZOHO_SIGN_CLIENT_SECRET || '').trim();
const ZOHO_SIGN_ACCOUNTS_SERVER = String(process.env.ZOHO_SIGN_ACCOUNTS_SERVER || 'https://accounts.zoho.com.au').trim();
const ZOHO_SIGN_API_BASE = String(process.env.ZOHO_SIGN_API_BASE || 'https://sign.zoho.com.au/api/v1').trim();
const ZOHO_SIGN_REDIRECT_URI = String(process.env.ZOHO_SIGN_REDIRECT_URI || '').trim();
const ZOHO_SIGN_SPPA_TEMPLATE_ID = String(process.env.ZOHO_SIGN_SPPA_TEMPLATE_ID || '').trim();
const ZOHO_SIGN_SCOPES = [
  'ZohoSign.documents.ALL',
  'ZohoSign.templates.READ',
  'ZohoSign.account.READ'
];

function getZohoSignAccountsServer() {
  return normalizeUrlBase(ZOHO_SIGN_ACCOUNTS_SERVER, 'https://accounts.zoho.com.au');
}
function getZohoSignApiBase() {
  return normalizeUrlBase(ZOHO_SIGN_API_BASE, 'https://sign.zoho.com.au/api/v1');
}
function getZohoSignOauthRedirectUri() {
  if (ZOHO_SIGN_REDIRECT_URI) return ZOHO_SIGN_REDIRECT_URI;
  const base = String(process.env.PUBLIC_BASE_URL || 'https://www.mygplink.com.au').trim().replace(/\/$/, '');
  return `${base}/api/admin/integrations/zoho-sign/callback`;
}
```

- [ ] **Step 2: Create the test file with initial coverage**

```javascript
// tests/zoho-sign.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';

describe('Zoho Sign — accounts server resolution', () => {
  it('falls back to au region when env unset', async () => {
    delete process.env.ZOHO_SIGN_ACCOUNTS_SERVER;
    const { getZohoSignAccountsServer } = await import('../server.js');
    expect(getZohoSignAccountsServer()).toBe('https://accounts.zoho.com.au');
  });
});
```

> **Note for implementer:** `server.js` does not currently export its helpers. Option A: add a dedicated `module.exports` block at end of server.js guarded by `if (require.main !== module)` for test-only exports. Option B: extract the Zoho Sign helpers into `lib/zoho-sign.js` and import from there. Choose Option B — it matches the emerging pattern where new concerns get their own module. Create `lib/zoho-sign.js` and move the helpers there, then import into `server.js`. If `lib/` does not exist, create it.

- [ ] **Step 3: Extract helpers to `lib/zoho-sign.js`**

```javascript
// lib/zoho-sign.js
'use strict';

function normalizeUrlBase(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return String(fallback || '').trim().replace(/\/$/, '');
  return raw.replace(/\/$/, '');
}

const ZOHO_SIGN_SCOPES = [
  'ZohoSign.documents.ALL',
  'ZohoSign.templates.READ',
  'ZohoSign.account.READ'
];

function getZohoSignAccountsServer() {
  return normalizeUrlBase(process.env.ZOHO_SIGN_ACCOUNTS_SERVER, 'https://accounts.zoho.com.au');
}

function getZohoSignApiBase() {
  return normalizeUrlBase(process.env.ZOHO_SIGN_API_BASE, 'https://sign.zoho.com.au/api/v1');
}

function getZohoSignOauthRedirectUri() {
  const override = String(process.env.ZOHO_SIGN_REDIRECT_URI || '').trim();
  if (override) return override;
  const base = String(process.env.PUBLIC_BASE_URL || 'https://www.mygplink.com.au').trim().replace(/\/$/, '');
  return `${base}/api/admin/integrations/zoho-sign/callback`;
}

module.exports = {
  ZOHO_SIGN_SCOPES,
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri,
  normalizeUrlBase
};
```

- [ ] **Step 4: Update `tests/zoho-sign.test.js` to import from lib**

```javascript
import { describe, it, expect } from 'vitest';
import {
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri
} from '../lib/zoho-sign.js';

describe('Zoho Sign — URL helpers', () => {
  it('getZohoSignAccountsServer returns AU region by default', () => {
    delete process.env.ZOHO_SIGN_ACCOUNTS_SERVER;
    expect(getZohoSignAccountsServer()).toBe('https://accounts.zoho.com.au');
  });
  it('getZohoSignAccountsServer respects override', () => {
    process.env.ZOHO_SIGN_ACCOUNTS_SERVER = 'https://accounts.zoho.com/';
    expect(getZohoSignAccountsServer()).toBe('https://accounts.zoho.com');
    delete process.env.ZOHO_SIGN_ACCOUNTS_SERVER;
  });
  it('getZohoSignApiBase defaults to AU', () => {
    delete process.env.ZOHO_SIGN_API_BASE;
    expect(getZohoSignApiBase()).toBe('https://sign.zoho.com.au/api/v1');
  });
  it('getZohoSignOauthRedirectUri builds default callback URL', () => {
    delete process.env.ZOHO_SIGN_REDIRECT_URI;
    delete process.env.PUBLIC_BASE_URL;
    expect(getZohoSignOauthRedirectUri()).toBe('https://www.mygplink.com.au/api/admin/integrations/zoho-sign/callback');
  });
});
```

- [ ] **Step 5: Run tests and verify pass**

```bash
npx vitest run tests/zoho-sign.test.js
```

Expected: 4 passed.

- [ ] **Step 6: Import helpers into `server.js`**

Replace the inline declarations from Step 1 in `server.js` with:

```javascript
const {
  ZOHO_SIGN_SCOPES,
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri
} = require('./lib/zoho-sign.js');

const ZOHO_SIGN_CLIENT_ID = String(process.env.ZOHO_SIGN_CLIENT_ID || '').trim();
const ZOHO_SIGN_CLIENT_SECRET = String(process.env.ZOHO_SIGN_CLIENT_SECRET || '').trim();
const ZOHO_SIGN_SPPA_TEMPLATE_ID = String(process.env.ZOHO_SIGN_SPPA_TEMPLATE_ID || '').trim();
```

- [ ] **Step 7: Run full test suite to confirm nothing broke**

```bash
npm test
```

Expected: all previously passing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add lib/zoho-sign.js tests/zoho-sign.test.js server.js
git commit -m "feat(phase2): Zoho Sign env + URL helpers with tests"
```

---

## Task 3: Zoho Sign connection — getter, upsert, token refresh

**Files:**
- Modify: `server.js` — add helpers near the Zoho Recruit connection helpers (search for `getZohoRecruitConnection` at ~line 7759)
- Modify: `tests/zoho-sign.test.js` — add connection tests

**Design note:** Uses `integration_connections` row with `provider='zoho_sign'`. Sign-specific data (`webhook_secret`, `webhook_registered_at`, `org_name`, `template_id`) lives in the existing `metadata` jsonb column. `access_token` and `token_expires_at` also live in `metadata` — do NOT add new columns to `integration_connections`.

- [ ] **Step 1: Write the failing test — connection mapper shape**

Append to `tests/zoho-sign.test.js`:

```javascript
import { mapZohoSignConnectionRow } from '../lib/zoho-sign.js';

describe('Zoho Sign — connection mapper', () => {
  it('maps integration_connections row to a normalized connection object', () => {
    const row = {
      provider: 'zoho_sign',
      status: 'connected',
      accounts_server: 'https://accounts.zoho.com.au',
      api_domain: 'https://sign.zoho.com.au',
      refresh_token: 'rt-abc',
      scopes: ['ZohoSign.documents.ALL'],
      connected_email: 'admin@mygplink.com.au',
      metadata: {
        access_token: 'at-123',
        token_expires_at: '2026-04-18T00:00:00Z',
        webhook_secret: 'hmac-shhh',
        org_name: 'GP Link Org',
        template_id: 'tpl-xyz'
      }
    };
    const c = mapZohoSignConnectionRow(row);
    expect(c.status).toBe('connected');
    expect(c.accessToken).toBe('at-123');
    expect(c.refreshToken).toBe('rt-abc');
    expect(c.webhookSecret).toBe('hmac-shhh');
    expect(c.orgName).toBe('GP Link Org');
    expect(c.tokenExpiresAt).toBe('2026-04-18T00:00:00Z');
  });
  it('returns null-like fields when metadata is empty', () => {
    const c = mapZohoSignConnectionRow({ provider: 'zoho_sign', status: 'connected', metadata: null });
    expect(c.accessToken).toBe('');
    expect(c.webhookSecret).toBe('');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run tests/zoho-sign.test.js -t 'connection mapper'
```

Expected: FAIL — `mapZohoSignConnectionRow is not defined`.

- [ ] **Step 3: Implement `mapZohoSignConnectionRow` in `lib/zoho-sign.js`**

Append to `lib/zoho-sign.js`:

```javascript
function mapZohoSignConnectionRow(row) {
  if (!row) return null;
  const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  return {
    provider: 'zoho_sign',
    status: String(row.status || 'disconnected'),
    accountsServer: String(row.accounts_server || ''),
    apiDomain: String(row.api_domain || ''),
    refreshToken: String(row.refresh_token || ''),
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    connectedEmail: String(row.connected_email || ''),
    connectedByUserId: String(row.connected_by_user_id || ''),
    accessToken: String(meta.access_token || ''),
    tokenExpiresAt: meta.token_expires_at ? String(meta.token_expires_at) : '',
    webhookSecret: String(meta.webhook_secret || ''),
    webhookRegisteredAt: meta.webhook_registered_at ? String(meta.webhook_registered_at) : '',
    orgName: String(meta.org_name || ''),
    orgId: String(meta.org_id || ''),
    templateId: String(meta.template_id || ''),
    tokenLastRefreshedAt: row.token_last_refreshed_at || null,
    metadata: meta
  };
}

module.exports.mapZohoSignConnectionRow = mapZohoSignConnectionRow;
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run tests/zoho-sign.test.js -t 'connection mapper'
```

Expected: 2 passed.

- [ ] **Step 5: Add `getZohoSignConnection` and `upsertZohoSignConnection` to `server.js`**

Locate `upsertZohoRecruitConnection` in `server.js` (~line 7768). Immediately after its closing brace, add:

```javascript
// ── Zoho Sign connection helpers ──────────────────────────
const { mapZohoSignConnectionRow } = require('./lib/zoho-sign.js');

async function getZohoSignConnection() {
  const result = await supabaseDbRequest(
    'integration_connections',
    'select=*&provider=eq.zoho_sign&limit=1'
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return mapZohoSignConnectionRow(result.data[0]);
}

async function upsertZohoSignConnection(patch = {}) {
  const existing = await getZohoSignConnection();
  const existingMeta = (existing && existing.metadata) || {};
  const nextMeta = Object.assign({}, existingMeta);
  if (patch.accessToken !== undefined) nextMeta.access_token = String(patch.accessToken || '');
  if (patch.tokenExpiresAt !== undefined) nextMeta.token_expires_at = patch.tokenExpiresAt || null;
  if (patch.webhookSecret !== undefined) nextMeta.webhook_secret = String(patch.webhookSecret || '');
  if (patch.webhookRegisteredAt !== undefined) nextMeta.webhook_registered_at = patch.webhookRegisteredAt || null;
  if (patch.orgName !== undefined) nextMeta.org_name = String(patch.orgName || '');
  if (patch.orgId !== undefined) nextMeta.org_id = String(patch.orgId || '');
  if (patch.templateId !== undefined) nextMeta.template_id = String(patch.templateId || '');

  const payload = {
    provider: 'zoho_sign',
    status: patch.status !== undefined ? String(patch.status) : ((existing && existing.status) || 'connected'),
    accounts_server: patch.accountsServer !== undefined ? String(patch.accountsServer || '') : ((existing && existing.accountsServer) || getZohoSignAccountsServer()),
    api_domain: patch.apiDomain !== undefined ? String(patch.apiDomain || '') : ((existing && existing.apiDomain) || getZohoSignApiBase()),
    refresh_token: patch.refreshToken !== undefined ? String(patch.refreshToken || '') : ((existing && existing.refreshToken) || ''),
    scopes: Array.isArray(patch.scopes) ? patch.scopes : ((existing && existing.scopes) || ZOHO_SIGN_SCOPES),
    connected_by_user_id: patch.connectedByUserId !== undefined ? String(patch.connectedByUserId || '') : ((existing && existing.connectedByUserId) || ''),
    connected_email: patch.connectedEmail !== undefined ? String(patch.connectedEmail || '').toLowerCase() : ((existing && existing.connectedEmail) || ''),
    token_last_refreshed_at: patch.tokenLastRefreshedAt !== undefined ? patch.tokenLastRefreshedAt : ((existing && existing.tokenLastRefreshedAt) || null),
    connected_at: patch.connectedAt !== undefined ? patch.connectedAt : (existing ? undefined : new Date().toISOString()),
    metadata: nextMeta,
    updated_at: new Date().toISOString()
  };

  const result = await supabaseDbRequest(
    'integration_connections',
    'on_conflict=provider',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [payload]
    }
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return mapZohoSignConnectionRow(result.data[0]);
}

async function refreshZohoSignAccessToken(connection) {
  const c = connection || await getZohoSignConnection();
  if (!c || !c.refreshToken) {
    return { ok: false, status: 400, data: { message: 'Zoho Sign not connected.' } };
  }
  const accountsServer = c.accountsServer || getZohoSignAccountsServer();
  const refreshed = await zohoFormRequest(accountsServer, {
    grant_type: 'refresh_token',
    client_id: ZOHO_SIGN_CLIENT_ID,
    client_secret: ZOHO_SIGN_CLIENT_SECRET,
    refresh_token: c.refreshToken
  });
  if (!refreshed.ok || !refreshed.data || !refreshed.data.access_token) {
    await upsertZohoSignConnection({ status: 'error' });
    return refreshed;
  }
  const expiresInSec = Number(refreshed.data.expires_in || 3600);
  const expiresAt = new Date(Date.now() + (expiresInSec - 300) * 1000).toISOString();
  await upsertZohoSignConnection({
    accessToken: refreshed.data.access_token,
    tokenExpiresAt: expiresAt,
    apiDomain: String(refreshed.data.api_domain || c.apiDomain || getZohoSignApiBase()),
    tokenLastRefreshedAt: new Date().toISOString(),
    status: 'connected'
  });
  return refreshed;
}

async function getValidZohoSignAccessToken() {
  const c = await getZohoSignConnection();
  if (!c || !c.refreshToken) return { ok: false, connection: null, accessToken: '' };
  const now = Date.now();
  const expMs = c.tokenExpiresAt ? Date.parse(c.tokenExpiresAt) : 0;
  if (c.accessToken && expMs && expMs > now) {
    return { ok: true, connection: c, accessToken: c.accessToken };
  }
  const refreshed = await refreshZohoSignAccessToken(c);
  if (!refreshed.ok) return { ok: false, connection: c, accessToken: '' };
  const updated = await getZohoSignConnection();
  return { ok: true, connection: updated, accessToken: updated.accessToken };
}
```

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: previously passing tests still pass, new connection-mapper tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/zoho-sign.js tests/zoho-sign.test.js server.js
git commit -m "feat(phase2): Zoho Sign connection getter/upsert/refresh helpers"
```

---

## Task 4: Zoho Sign API client — GET / POST / DELETE with auto-refresh

**Files:**
- Modify: `server.js` — add API client helpers after the connection helpers from Task 3

- [ ] **Step 1: Add `zohoSignApiRequest` to `server.js`**

Append after `getValidZohoSignAccessToken`:

```javascript
async function zohoSignApiRequest(method, resourcePath, options = {}) {
  const { queryParams = {}, body = null, headers: extraHeaders = {}, retryOn401 = true } = options;
  const tokenRes = await getValidZohoSignAccessToken();
  if (!tokenRes.ok || !tokenRes.accessToken) {
    return { ok: false, status: 401, data: { message: 'Zoho Sign not connected or token refresh failed.' } };
  }
  const apiBase = (tokenRes.connection && tokenRes.connection.apiDomain) || getZohoSignApiBase();
  // apiDomain from Zoho is the bare host (e.g. https://sign.zoho.com.au). Ensure /api/v1 path segment is present.
  const base = /\/api\/v\d+$/.test(apiBase) ? apiBase : (apiBase.replace(/\/$/, '') + '/api/v1');
  const url = new URL(`${base}/${String(resourcePath || '').replace(/^\/+/, '')}`);
  Object.entries(queryParams).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    url.searchParams.set(k, String(v));
  });
  const hdrs = Object.assign({
    Authorization: `Zoho-oauthtoken ${tokenRes.accessToken}`,
    Accept: 'application/json'
  }, extraHeaders);
  if (body && !hdrs['Content-Type'] && typeof body === 'string') hdrs['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url.toString(), {
      method,
      signal: controller.signal,
      headers: hdrs,
      body: body || undefined
    });
    if (resp.status === 401 && retryOn401) {
      clearTimeout(timeout);
      await refreshZohoSignAccessToken(tokenRes.connection);
      return zohoSignApiRequest(method, resourcePath, Object.assign({}, options, { retryOn401: false }));
    }
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
      const buf = Buffer.from(await resp.arrayBuffer());
      return { ok: resp.ok, status: resp.status, data: buf, contentType };
    }
    const text = await resp.text();
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { message: 'Zoho Sign request failed: ' + err.message } };
  } finally {
    clearTimeout(timeout);
  }
}

function zohoSignApiGet(path, queryParams) { return zohoSignApiRequest('GET', path, { queryParams }); }
function zohoSignApiPostJson(path, body) { return zohoSignApiRequest('POST', path, { body: JSON.stringify(body || {}), headers: { 'Content-Type': 'application/json' } }); }
function zohoSignApiPostForm(path, formMap) {
  const form = new URLSearchParams();
  Object.entries(formMap || {}).forEach(([k, v]) => form.set(k, typeof v === 'string' ? v : JSON.stringify(v)));
  return zohoSignApiRequest('POST', path, { body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}
function zohoSignApiDelete(path) { return zohoSignApiRequest('DELETE', path); }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat(phase2): Zoho Sign API client with auto-refresh on 401"
```

---

## Task 5: OAuth endpoints — auth-url, callback, disconnect, status

**Files:**
- Modify: `server.js` — add endpoint handlers near the Zoho Recruit OAuth endpoints (~line 14738)

- [ ] **Step 1: Add the four OAuth endpoints**

In `server.js`, locate the Zoho Recruit callback handler (search for `/api/integrations/zoho-recruit/callback`). Immediately after that handler's final block, add:

```javascript
// ── Zoho Sign OAuth endpoints ──────────────────────────────
if (req.method === 'GET' && pathname === '/api/admin/integrations/zoho-sign/auth-url') {
  const admin = await requireIntegrationAdminSession(req, res);
  if (!admin) return;
  if (!ZOHO_SIGN_CLIENT_ID || !ZOHO_SIGN_CLIENT_SECRET) {
    sendJson(res, 503, { ok: false, message: 'ZOHO_SIGN_CLIENT_ID/SECRET not configured' });
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL(`${getZohoSignAccountsServer()}/oauth/v2/auth`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', ZOHO_SIGN_CLIENT_ID);
  authUrl.searchParams.set('scope', ZOHO_SIGN_SCOPES.join(','));
  authUrl.searchParams.set('redirect_uri', getZohoSignOauthRedirectUri());
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  // Stash state under the admin's session (reuse the same storage as Recruit if available)
  await supabaseDbRequest('integration_oauth_states', '', {
    method: 'POST',
    body: [{ state, provider: 'zoho_sign', admin_user_id: admin.id, created_at: new Date().toISOString() }]
  });
  sendJson(res, 200, { ok: true, authUrl: authUrl.toString(), state });
  return;
}

if (req.method === 'GET' && pathname === '/api/admin/integrations/zoho-sign/callback') {
  const qs = parsedUrl.searchParams;
  const state = qs.get('state') || '';
  const code = qs.get('code') || '';
  const errParam = qs.get('error') || '';
  if (errParam) {
    res.writeHead(302, { Location: '/admin.html?zoho-sign=error&reason=' + encodeURIComponent(errParam) });
    res.end();
    return;
  }
  // Validate state
  const stateRow = await supabaseDbRequest('integration_oauth_states',
    'select=admin_user_id&state=eq.' + encodeURIComponent(state) + '&provider=eq.zoho_sign&limit=1');
  if (!stateRow.ok || !stateRow.data || !stateRow.data[0]) {
    res.writeHead(302, { Location: '/admin.html?zoho-sign=error&reason=invalid_state' });
    res.end();
    return;
  }
  const adminUserId = stateRow.data[0].admin_user_id;
  // Exchange code for tokens
  const tokenRes = await zohoFormRequest(getZohoSignAccountsServer(), {
    grant_type: 'authorization_code',
    client_id: ZOHO_SIGN_CLIENT_ID,
    client_secret: ZOHO_SIGN_CLIENT_SECRET,
    redirect_uri: getZohoSignOauthRedirectUri(),
    code
  });
  if (!tokenRes.ok || !tokenRes.data || !tokenRes.data.access_token) {
    res.writeHead(302, { Location: '/admin.html?zoho-sign=error&reason=token_exchange_failed' });
    res.end();
    return;
  }
  const apiDomain = String(tokenRes.data.api_domain || getZohoSignApiBase()).replace(/\/$/, '');
  const expiresAt = new Date(Date.now() + ((Number(tokenRes.data.expires_in) || 3600) - 300) * 1000).toISOString();

  await upsertZohoSignConnection({
    status: 'connected',
    refreshToken: String(tokenRes.data.refresh_token || ''),
    accessToken: String(tokenRes.data.access_token || ''),
    tokenExpiresAt: expiresAt,
    accountsServer: getZohoSignAccountsServer(),
    apiDomain,
    scopes: ZOHO_SIGN_SCOPES,
    connectedByUserId: adminUserId,
    tokenLastRefreshedAt: new Date().toISOString(),
    templateId: ZOHO_SIGN_SPPA_TEMPLATE_ID
  });

  // Fire-and-forget: register webhook, fetch org info
  try { await registerZohoSignWebhook(); } catch (e) { console.error('[ZohoSign] webhook registration failed:', e.message); }
  try { await fetchAndStoreZohoSignOrgInfo(); } catch (e) { console.error('[ZohoSign] org info fetch failed:', e.message); }

  // Clean up state row
  await supabaseDbRequest('integration_oauth_states', 'state=eq.' + encodeURIComponent(state), { method: 'DELETE' });

  res.writeHead(302, { Location: '/admin.html?zoho-sign=connected' });
  res.end();
  return;
}

if (req.method === 'POST' && pathname === '/api/admin/integrations/zoho-sign/disconnect') {
  const admin = await requireIntegrationAdminSession(req, res);
  if (!admin) return;
  await upsertZohoSignConnection({
    status: 'disconnected',
    refreshToken: '',
    accessToken: '',
    tokenExpiresAt: null,
    webhookSecret: '',
    webhookRegisteredAt: null
  });
  sendJson(res, 200, { ok: true });
  return;
}

if (req.method === 'GET' && pathname === '/api/admin/integrations/zoho-sign/status') {
  const admin = await requireIntegrationAdminSession(req, res);
  if (!admin) return;
  const c = await getZohoSignConnection();
  if (!c) { sendJson(res, 200, { ok: true, connected: false }); return; }
  sendJson(res, 200, {
    ok: true,
    connected: c.status === 'connected',
    status: c.status,
    connectedEmail: c.connectedEmail,
    orgName: c.orgName,
    tokenExpiresAt: c.tokenExpiresAt,
    webhookRegistered: !!c.webhookSecret,
    templateId: c.templateId
  });
  return;
}
```

- [ ] **Step 2: Add helper `fetchAndStoreZohoSignOrgInfo`**

Below the OAuth endpoints, add:

```javascript
async function fetchAndStoreZohoSignOrgInfo() {
  const res = await zohoSignApiGet('account');
  if (!res.ok || !res.data) return;
  // Zoho Sign account API returns org info under data.organization or data.account
  const org = (res.data.organization || res.data.account || {});
  await upsertZohoSignConnection({
    orgName: String(org.org_name || org.organization_name || ''),
    orgId: String(org.org_id || org.organization_id || ''),
    connectedEmail: String(org.owner_email || '')
  });
}
```

> **Implementer note:** Exact Zoho Sign `/account` response shape may differ. Use WebFetch on `https://www.zoho.com/sign/api/documentation/account.html` to verify the response structure before finalizing. Adjust field extraction if needed.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(phase2): Zoho Sign OAuth endpoints (auth-url, callback, disconnect, status)"
```

---

## Task 6: Envelope helpers — create from template / get / get fields / void / download / update recipient

**Files:**
- Modify: `lib/zoho-sign.js` — add pure parse/builder helpers
- Modify: `server.js` — add envelope wrapper functions that call the API client
- Modify: `tests/zoho-sign.test.js` — tests for pure helpers

> **Implementer note:** Zoho Sign templates use `template_id` in URL path and require a `data` payload with `templates.field_data` and `templates.actions`. The exact payload shape is documented at `https://www.zoho.com/sign/api/documentation/request.html#create-document-using-template`. Use WebFetch during this task to verify the shape. The helpers below have explicit boundaries; the JSON body inside `createEnvelopeFromTemplate` must be confirmed against Zoho docs during implementation.

- [ ] **Step 1: Write the failing test — correction prefill builder**

Append to `tests/zoho-sign.test.js`:

```javascript
import { buildCorrectionFieldData } from '../lib/zoho-sign.js';

describe('Zoho Sign — correction prefill', () => {
  it('keeps fields outside flagged sections, blanks fields inside flagged sections', () => {
    const oldFields = [
      { field_label: 'practice_name', field_value: 'Acme Clinic', section: 'practice_details' },
      { field_label: 'start_date', field_value: '2026-05-01', section: 'commencement_terms' },
      { field_label: 'candidate_name', field_value: 'Jane Smith', section: 'candidate_details' }
    ];
    const result = buildCorrectionFieldData(oldFields, ['commencement_terms']);
    expect(result).toEqual([
      { field_label: 'practice_name', field_value: 'Acme Clinic', section: 'practice_details' },
      { field_label: 'start_date', field_value: '', section: 'commencement_terms' },
      { field_label: 'candidate_name', field_value: 'Jane Smith', section: 'candidate_details' }
    ]);
  });
  it('flags multiple sections', () => {
    const oldFields = [
      { field_label: 'a', field_value: 'x', section: 's1' },
      { field_label: 'b', field_value: 'y', section: 's2' },
      { field_label: 'c', field_value: 'z', section: 's3' }
    ];
    const r = buildCorrectionFieldData(oldFields, ['s1', 's3']);
    expect(r[0].field_value).toBe('');
    expect(r[1].field_value).toBe('y');
    expect(r[2].field_value).toBe('');
  });
  it('returns empty array for empty input', () => {
    expect(buildCorrectionFieldData([], ['any'])).toEqual([]);
    expect(buildCorrectionFieldData(null, ['any'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run tests/zoho-sign.test.js -t 'correction prefill'
```

Expected: FAIL — `buildCorrectionFieldData is not defined`.

- [ ] **Step 3: Implement `buildCorrectionFieldData`**

Append to `lib/zoho-sign.js`:

```javascript
/**
 * @param {Array<{field_label: string, field_value: string, section: string}>} oldFields
 * @param {string[]} flaggedSections
 * @returns {Array<{field_label: string, field_value: string, section: string}>}
 */
function buildCorrectionFieldData(oldFields, flaggedSections) {
  if (!Array.isArray(oldFields) || oldFields.length === 0) return [];
  const flagged = new Set((flaggedSections || []).map(String));
  return oldFields.map((f) => ({
    field_label: String(f.field_label || ''),
    field_value: flagged.has(String(f.section || '')) ? '' : String(f.field_value || ''),
    section: String(f.section || '')
  }));
}

module.exports.buildCorrectionFieldData = buildCorrectionFieldData;
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run tests/zoho-sign.test.js -t 'correction prefill'
```

Expected: 3 passed.

- [ ] **Step 5: Add envelope wrapper functions to `server.js`**

After the OAuth endpoints from Task 5, add:

```javascript
// ── Zoho Sign envelope operations ─────────────────────────
const { buildCorrectionFieldData } = require('./lib/zoho-sign.js');

/**
 * Create an envelope from a template and send to recipients.
 * @param {object} opts
 * @param {string} opts.templateId
 * @param {Array<{email: string, name: string, role: string, signing_order: number}>} opts.recipients
 *   role = 'Practice Contact' or 'Candidate' — must match the template role names in Zoho Sign.
 * @param {Array<{field_label: string, field_value: string}>} [opts.prefillFields] — optional
 * @param {string} [opts.note] — message shown to signers
 * @returns {Promise<{ok: boolean, envelopeId?: string, data?: object, error?: string}>}
 */
async function createEnvelopeFromTemplate(opts) {
  const tid = String(opts.templateId || '').trim();
  if (!tid) return { ok: false, error: 'templateId required' };
  // Build Zoho's templates payload. Confirm shape against:
  // https://www.zoho.com/sign/api/documentation/request.html#create-document-using-template
  const actions = (opts.recipients || []).map((r) => ({
    action_type: 'SIGN',
    recipient_email: String(r.email || ''),
    recipient_name: String(r.name || ''),
    role: String(r.role || ''),
    signing_order: Number(r.signing_order || 1),
    verify_recipient: false
  }));
  const payload = {
    templates: {
      field_data: {
        field_text_data: {},
        field_boolean_data: {},
        field_date_data: {},
        field_radio_data: {}
      },
      actions,
      notes: String(opts.note || '')
    }
  };
  // Attach prefill fields as text data keyed by label
  (opts.prefillFields || []).forEach((f) => {
    if (!f || !f.field_label) return;
    payload.templates.field_data.field_text_data[f.field_label] = String(f.field_value || '');
  });

  const res = await zohoSignApiPostForm(`templates/${encodeURIComponent(tid)}/createdocument`, { data: payload });
  if (!res.ok) return { ok: false, error: 'zoho_sign_create_failed', data: res.data };
  const envelopeId = String(
    (res.data && res.data.requests && res.data.requests.request_id) ||
    (res.data && res.data.request_id) || ''
  );
  if (!envelopeId) return { ok: false, error: 'no_envelope_id_returned', data: res.data };
  return { ok: true, envelopeId, data: res.data };
}

async function getEnvelope(envelopeId) {
  return zohoSignApiGet(`requests/${encodeURIComponent(envelopeId)}`);
}

async function getEnvelopeFieldValues(envelopeId) {
  const res = await zohoSignApiGet(`requests/${encodeURIComponent(envelopeId)}/fieldvalues`);
  if (!res.ok) return { ok: false, fields: [] };
  const fields = [];
  const fd = (res.data && res.data.field_data) || {};
  (fd.field_text_data || []).forEach((f) => fields.push({ field_label: f.field_label, field_value: f.field_value, section: f.section || '' }));
  (fd.field_boolean_data || []).forEach((f) => fields.push({ field_label: f.field_label, field_value: String(!!f.field_value), section: f.section || '' }));
  (fd.field_date_data || []).forEach((f) => fields.push({ field_label: f.field_label, field_value: f.field_value, section: f.section || '' }));
  (fd.field_radio_data || []).forEach((f) => fields.push({ field_label: f.field_label, field_value: f.field_value, section: f.section || '' }));
  return { ok: true, fields };
}

async function voidEnvelope(envelopeId, reason) {
  const params = new URLSearchParams();
  params.set('data', JSON.stringify({ reason: String(reason || 'Voided by GP Link') }));
  return zohoSignApiRequest('POST', `requests/${encodeURIComponent(envelopeId)}/cancel`, {
    body: params.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
}

async function downloadSignedPdf(envelopeId) {
  const res = await zohoSignApiRequest('GET', `requests/${encodeURIComponent(envelopeId)}/pdf`);
  if (!res.ok) return { ok: false, data: null };
  if (Buffer.isBuffer(res.data)) return { ok: true, buffer: res.data };
  return { ok: false, data: res.data };
}

async function updateEnvelopeRecipient(envelopeId, actionId, newEmail, newName) {
  return zohoSignApiPostForm(`requests/${encodeURIComponent(envelopeId)}/actions/${encodeURIComponent(actionId)}/update`, {
    data: { actions: [{ action_id: actionId, recipient_email: newEmail, recipient_name: newName || undefined }] }
  });
}
```

- [ ] **Step 6: Add webhook registration helper**

After the envelope helpers, add:

```javascript
async function registerZohoSignWebhook() {
  const secret = crypto.randomBytes(32).toString('hex');
  const publicBase = String(process.env.PUBLIC_BASE_URL || 'https://www.mygplink.com.au').trim().replace(/\/$/, '');
  const callbackUrl = `${publicBase}/api/webhooks/zoho-sign`;
  // Zoho Sign webhook registration endpoint:
  // POST /api/v1/notifications (body: data = { notification: { event_type: [...], callback_url, authentication } })
  const payload = {
    notification: {
      callback_url: callbackUrl,
      event_type: [
        'RequestSentToRecipient',
        'RequestRecipientSigned',
        'RequestCompleted',
        'RequestDeclined',
        'RequestVoided',
        'RequestExpired',
        'RequestRecipientEmailBounced',
        'RequestViewed'
      ],
      authentication: { method: 'HMAC', secret }
    }
  };
  const res = await zohoSignApiPostForm('notifications', { data: payload });
  if (res.ok) {
    await upsertZohoSignConnection({
      webhookSecret: secret,
      webhookRegisteredAt: new Date().toISOString()
    });
  }
  return res;
}
```

> **Implementer note:** Confirm Zoho Sign webhook registration endpoint and event_type names against `https://www.zoho.com/sign/api/documentation/webhooks.html`. Adjust event names if Zoho uses different canonical strings. If Zoho requires manual webhook setup via their UI, document that in the final infra task and remove this auto-registration call.

- [ ] **Step 7: Run full test suite**

```bash
npm test
```

Expected: correction-prefill tests pass, previously passing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add lib/zoho-sign.js server.js tests/zoho-sign.test.js
git commit -m "feat(phase2): Zoho Sign envelope helpers + webhook registration"
```

---

## Task 7: Webhook endpoint — HMAC + idempotency + 5-stage status mapper

**Files:**
- Modify: `lib/zoho-sign.js` — add pure `mapZohoSignEventToStatus` + `validateZohoSignSignature`
- Modify: `server.js` — add webhook endpoint wiring
- Modify: `tests/zoho-sign.test.js` — tests for pure helpers

- [ ] **Step 1: Write failing tests — event-to-status + HMAC**

Append to `tests/zoho-sign.test.js`:

```javascript
import crypto from 'crypto';
import { mapZohoSignEventToStatus, validateZohoSignSignature } from '../lib/zoho-sign.js';

describe('Zoho Sign — event-to-status mapping', () => {
  it('RequestSentToRecipient (1) -> sent_to_contact', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestSentToRecipient', recipient_index: 1 })).toBe('sent_to_contact');
  });
  it('RequestRecipientSigned (1) -> contact_signed', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestRecipientSigned', recipient_index: 1 })).toBe('contact_signed');
  });
  it('RequestSentToRecipient (2) -> sent_to_candidate', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestSentToRecipient', recipient_index: 2 })).toBe('sent_to_candidate');
  });
  it('RequestRecipientSigned (2) -> candidate_signed', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestRecipientSigned', recipient_index: 2 })).toBe('candidate_signed');
  });
  it('RequestCompleted -> awaiting_review', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestCompleted' })).toBe('awaiting_review');
  });
  it('RequestDeclined -> declined', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestDeclined' })).toBe('declined');
  });
  it('RequestVoided -> voided', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestVoided' })).toBe('voided');
  });
  it('RequestExpired -> expired', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestExpired' })).toBe('expired');
  });
  it('RequestRecipientEmailBounced -> recipient_delivery_failed', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestRecipientEmailBounced' })).toBe('recipient_delivery_failed');
  });
  it('RequestViewed -> null (no status change)', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestViewed' })).toBeNull();
  });
  it('unknown event -> null', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'Whatever' })).toBeNull();
  });
});

describe('Zoho Sign — HMAC signature validation', () => {
  const secret = 'test-secret-123';
  const body = '{"notification_id":"n-1","event_type":"RequestCompleted"}';
  const valid = crypto.createHmac('sha256', secret).update(body, 'utf-8').digest('hex');

  it('accepts a valid hex signature', () => {
    expect(validateZohoSignSignature(body, valid, secret)).toBe(true);
  });
  it('rejects a mismatched signature', () => {
    expect(validateZohoSignSignature(body, 'deadbeef', secret)).toBe(false);
  });
  it('rejects when secret is empty', () => {
    expect(validateZohoSignSignature(body, valid, '')).toBe(false);
  });
  it('rejects when signature header is empty', () => {
    expect(validateZohoSignSignature(body, '', secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/zoho-sign.test.js -t 'event-to-status'
npx vitest run tests/zoho-sign.test.js -t 'HMAC'
```

Expected: FAIL — helpers not defined.

- [ ] **Step 3: Implement the helpers in `lib/zoho-sign.js`**

Append to `lib/zoho-sign.js`:

```javascript
const crypto = require('crypto');

/**
 * Map a Zoho Sign webhook event to an internal envelope status.
 * Returns null for events that do not change status (e.g. RequestViewed).
 */
function mapZohoSignEventToStatus(event) {
  if (!event || !event.event_type) return null;
  const et = String(event.event_type);
  const idx = Number(event.recipient_index || 0);
  if (et === 'RequestSentToRecipient') return idx === 2 ? 'sent_to_candidate' : 'sent_to_contact';
  if (et === 'RequestRecipientSigned') return idx === 2 ? 'candidate_signed' : 'contact_signed';
  if (et === 'RequestCompleted') return 'awaiting_review';
  if (et === 'RequestDeclined') return 'declined';
  if (et === 'RequestVoided') return 'voided';
  if (et === 'RequestExpired') return 'expired';
  if (et === 'RequestRecipientEmailBounced') return 'recipient_delivery_failed';
  return null;
}

function validateZohoSignSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  try {
    const expected = crypto.createHmac('sha256', String(secret)).update(String(rawBody || ''), 'utf-8').digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signatureHeader));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

module.exports.mapZohoSignEventToStatus = mapZohoSignEventToStatus;
module.exports.validateZohoSignSignature = validateZohoSignSignature;
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/zoho-sign.test.js -t 'event-to-status'
npx vitest run tests/zoho-sign.test.js -t 'HMAC'
```

Expected: all passing.

- [ ] **Step 5: Add webhook endpoint to `server.js`**

After the envelope helpers from Task 6, add:

```javascript
// ── Zoho Sign webhook endpoint ────────────────────────────
const { mapZohoSignEventToStatus, validateZohoSignSignature } = require('./lib/zoho-sign.js');

async function handleZohoSignWebhook(req, res) {
  let rawBody;
  try { rawBody = (await readRawBody(req, 2 * 1024 * 1024)).toString('utf-8'); }
  catch (e) { sendJson(res, 413, { ok: false, error: 'body too large' }); return; }

  const connection = await getZohoSignConnection();
  const secret = connection && connection.webhookSecret;
  const sigHeader = String(req.headers['x-zs-webhook-signature'] || req.headers['x-zoho-sign-signature'] || '').trim();
  if (!validateZohoSignSignature(rawBody, sigHeader, secret)) {
    console.error('[ZohoSign webhook] signature validation failed');
    sendJson(res, 401, { ok: false, error: 'invalid signature' });
    return;
  }

  let payload = {};
  try { payload = JSON.parse(rawBody); } catch (e) { sendJson(res, 400, { ok: false, error: 'invalid json' }); return; }

  // Always 200 within 3 seconds. Process async.
  sendJson(res, 200, { ok: true });
  setImmediate(() => { processZohoSignWebhookEvent(payload).catch((e) => console.error('[ZohoSign webhook] processing error:', e.message)); });
}

async function processZohoSignWebhookEvent(payload) {
  const notificationId = String(payload.notification_id || payload.request_id || '');
  const eventType = String(payload.event_type || payload.operation_type || '');
  const envelopeId = String(payload.request_id || (payload.requests && payload.requests.request_id) || '');
  if (!notificationId || !envelopeId) {
    console.error('[ZohoSign webhook] missing notification_id or envelope_id');
    return;
  }
  // Idempotency
  const existing = await supabaseDbRequest('processed_zoho_sign_events',
    'select=notification_id&notification_id=eq.' + encodeURIComponent(notificationId) + '&limit=1');
  if (existing.ok && existing.data && existing.data[0]) return; // already processed

  // Determine recipient index
  let recipientIndex = 0;
  if (payload.actions && Array.isArray(payload.actions)) {
    const signedIdx = payload.actions.findIndex((a) => a && (a.action_status === 'SIGNED' || a.action_status === 'IN_PROGRESS'));
    recipientIndex = signedIdx >= 0 ? signedIdx + 1 : 0;
  }
  if (typeof payload.recipient_index === 'number') recipientIndex = payload.recipient_index;

  const newStatus = mapZohoSignEventToStatus({ event_type: eventType, recipient_index: recipientIndex });

  // Fetch existing envelope row (to detect voided_for_correction)
  const envRes = await supabaseDbRequest('zoho_sign_envelopes',
    'select=*&envelope_id=eq.' + encodeURIComponent(envelopeId) + '&limit=1');
  const envRow = (envRes.ok && envRes.data && envRes.data[0]) ? envRes.data[0] : null;

  const updates = { updated_at: new Date().toISOString() };
  if (newStatus) {
    // Don't overwrite voided_for_correction with plain voided
    if (newStatus === 'voided' && envRow && envRow.status === 'voided_for_correction') {
      // skip; correction flow already handled it
    } else {
      updates.status = newStatus;
    }
  }
  if (eventType === 'RequestCompleted') updates.completed_at = new Date().toISOString();
  if (eventType === 'RequestDeclined') updates.decline_reason = String(payload.action_comment || payload.reason || '');

  if (envRow) {
    await supabaseDbRequest('zoho_sign_envelopes',
      'envelope_id=eq.' + encodeURIComponent(envelopeId),
      { method: 'PATCH', body: updates });
  }

  // On completion, enqueue VA review to-do (just a console log + timeline for now; UI will pick it up via task listing)
  if (eventType === 'RequestCompleted' && envRow && envRow.case_id) {
    await supabaseDbRequest('case_events', '', {
      method: 'POST',
      body: [{
        case_id: envRow.case_id,
        event_type: 'sppa_ready_for_review',
        description: 'SPPA-00 signed by both parties — ready for VA review',
        created_at: new Date().toISOString()
      }]
    });
  }

  // Record processing
  await supabaseDbRequest('processed_zoho_sign_events', '', {
    method: 'POST',
    body: [{
      notification_id: notificationId,
      envelope_id: envelopeId,
      event_type: eventType,
      received_at: new Date().toISOString()
    }]
  });
}
```

Then in the request router (where other endpoints are dispatched), add:

```javascript
if (req.method === 'POST' && pathname === '/api/webhooks/zoho-sign') {
  await handleZohoSignWebhook(req, res);
  return;
}
```

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/zoho-sign.js server.js tests/zoho-sign.test.js
git commit -m "feat(phase2): Zoho Sign webhook endpoint with HMAC + idempotency + status mapper"
```

---

## Task 8: Send SPPA-00 endpoint — auto on career-secure + manual

**Files:**
- Modify: `server.js` — add send logic; hook into practice pack creation

- [ ] **Step 1: Add `sendSppa00Envelope` helper**

After the webhook handler, add:

```javascript
/**
 * Create + send the SPPA-00 envelope for a practice pack task.
 * @returns {Promise<{ok: boolean, envelopeId?: string, error?: string}>}
 */
async function sendSppa00Envelope(taskId) {
  if (!ZOHO_SIGN_SPPA_TEMPLATE_ID) {
    return { ok: false, error: 'ZOHO_SIGN_SPPA_TEMPLATE_ID not configured' };
  }
  const conn = await getZohoSignConnection();
  if (!conn || conn.status !== 'connected') {
    return { ok: false, error: 'Zoho Sign not connected' };
  }

  const taskRes = await supabaseDbRequest('registration_tasks',
    'select=id,case_id,related_document_key,zoho_sign_envelope_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
  if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) return { ok: false, error: 'task not found' };
  const task = taskRes.data[0];
  if (task.related_document_key !== 'sppa_00') return { ok: false, error: 'task is not SPPA-00' };

  const caseRes = await supabaseDbRequest('registration_cases',
    'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
  if (!caseRes.ok || !caseRes.data || !caseRes.data[0]) return { ok: false, error: 'case not found' };
  const userId = caseRes.data[0].user_id;

  // Fetch user profile for candidate info
  const profRes = await supabaseDbRequest('user_profiles',
    'select=first_name,last_name,email&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  const prof = (profRes.ok && profRes.data && profRes.data[0]) ? profRes.data[0] : {};
  const candidateName = ('Dr ' + (prof.first_name || '') + ' ' + (prof.last_name || '')).trim();
  const candidateEmail = String(prof.email || '').trim();

  // Fetch career state for practice contact
  const stateRes = await supabaseDbRequest('user_state',
    'select=state&user_id=eq.' + encodeURIComponent(userId) + '&key=eq.gp_career_state&limit=1');
  let careerState = {};
  if (stateRes.ok && stateRes.data && stateRes.data[0]) {
    try { careerState = typeof stateRes.data[0].state === 'string' ? JSON.parse(stateRes.data[0].state) : stateRes.data[0].state; }
    catch (e) {}
  }
  const secured = careerState.career_secured ? careerState : (Array.isArray(careerState.applications) ? careerState.applications.find(a => a && a.isPlacementSecured) : null);
  const placement = (secured && secured.placement) || secured || {};
  const pc = (placement.practiceContact) || {};
  if (!pc.email) return { ok: false, error: 'practice contact email missing' };
  if (!candidateEmail) return { ok: false, error: 'candidate email missing' };

  // Role names must match the SPPA-00 template roles in Zoho Sign
  const recipients = [
    { email: pc.email, name: pc.name || 'Practice Contact', role: 'Practice Contact', signing_order: 1 },
    { email: candidateEmail, name: candidateName, role: 'Candidate', signing_order: 2 }
  ];

  const result = await createEnvelopeFromTemplate({
    templateId: ZOHO_SIGN_SPPA_TEMPLATE_ID,
    recipients,
    note: 'Please sign the Supervisory Practice Placement Agreement for ' + candidateName
  });
  if (!result.ok) return { ok: false, error: result.error || 'create envelope failed' };

  // Persist envelope record
  await supabaseDbRequest('zoho_sign_envelopes', '', {
    method: 'POST',
    body: [{
      envelope_id: result.envelopeId,
      task_id: task.id,
      user_id: userId,
      case_id: task.case_id,
      template_id: ZOHO_SIGN_SPPA_TEMPLATE_ID,
      status: 'sent_to_contact',
      recipient_contact: { email: pc.email, name: pc.name || '' },
      recipient_candidate: { email: candidateEmail, name: candidateName },
      sent_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]
  });

  // Link envelope to task
  await supabaseDbRequest('registration_tasks',
    'id=eq.' + encodeURIComponent(task.id),
    { method: 'PATCH', body: { zoho_sign_envelope_id: result.envelopeId, status: 'in_progress', updated_at: new Date().toISOString() } });

  return { ok: true, envelopeId: result.envelopeId };
}
```

- [ ] **Step 2: Add manual send endpoint**

After `sendSppa00Envelope`, add request dispatch:

```javascript
if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/send-sppa')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const taskId = pathname.split('/')[5];
  const result = await sendSppa00Envelope(taskId);
  sendJson(res, result.ok ? 200 : 400, result);
  return;
}
```

- [ ] **Step 3: Wire auto-send into practice pack creation**

Locate the practice pack creation flow in `server.js` — search for where `related_document_key` is set to `sppa_00` during task generation. After the SPPA-00 task row is inserted, add:

```javascript
// Auto-send SPPA-00 if Zoho Sign is connected + practice contact email is present
try {
  const sppaTasks = (insertedTasks || []).filter(t => t.related_document_key === 'sppa_00');
  for (const t of sppaTasks) {
    const r = await sendSppa00Envelope(t.id);
    if (!r.ok) console.log('[SPPA-00 auto-send] skipped:', r.error);
  }
} catch (e) {
  console.error('[SPPA-00 auto-send] error:', e.message);
}
```

> **Implementer note:** Find the exact block that inserts practice-pack tasks (likely a helper named `createPracticePackTasks` or similar) and add the auto-send loop after the insertion returns. If the insertion uses Supabase `returning`, use those rows; otherwise fetch by case_id after insertion.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(phase2): send SPPA-00 envelope (auto on career-secure + manual)"
```

---

## Task 9: VA Review endpoints — preview PDF, approve, request correction, resend, update recipient

**Files:**
- Modify: `server.js` — add endpoints
- Modify: `tests/zoho-sign.test.js` — test correction recipient selection (pure helper)

- [ ] **Step 1: Write failing test — recipient selection for correction**

Append to `tests/zoho-sign.test.js`:

```javascript
import { pickCorrectionRecipient } from '../lib/zoho-sign.js';

describe('Zoho Sign — correction recipient selection', () => {
  const contact = { email: 'pc@acme.com', name: 'Pat Contact' };
  const candidate = { email: 'c@gp.com', name: 'Dr Jane' };

  it('picks contact for practice side', () => {
    const r = pickCorrectionRecipient('practice', contact, candidate);
    expect(r.role).toBe('Practice Contact');
    expect(r.email).toBe('pc@acme.com');
    expect(r.signing_order).toBe(1);
  });
  it('picks candidate for candidate side', () => {
    const r = pickCorrectionRecipient('candidate', contact, candidate);
    expect(r.role).toBe('Candidate');
    expect(r.email).toBe('c@gp.com');
    expect(r.signing_order).toBe(1);
  });
  it('throws on unknown side', () => {
    expect(() => pickCorrectionRecipient('neither', contact, candidate)).toThrow();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run tests/zoho-sign.test.js -t 'correction recipient'
```

Expected: FAIL.

- [ ] **Step 3: Implement `pickCorrectionRecipient`**

Append to `lib/zoho-sign.js`:

```javascript
function pickCorrectionRecipient(side, contact, candidate) {
  if (side === 'practice') {
    return { role: 'Practice Contact', email: String((contact && contact.email) || ''), name: String((contact && contact.name) || ''), signing_order: 1 };
  }
  if (side === 'candidate') {
    return { role: 'Candidate', email: String((candidate && candidate.email) || ''), name: String((candidate && candidate.name) || ''), signing_order: 1 };
  }
  throw new Error('Invalid correction side: ' + side);
}
module.exports.pickCorrectionRecipient = pickCorrectionRecipient;
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run tests/zoho-sign.test.js -t 'correction recipient'
```

Expected: 3 passed.

- [ ] **Step 5: Add the VA review endpoints**

After the send-sppa endpoint, add:

```javascript
const { pickCorrectionRecipient } = require('./lib/zoho-sign.js');

// Preview signed PDF
if (req.method === 'GET' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-pdf')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const taskId = pathname.split('/')[5];
  const taskRes = await supabaseDbRequest('registration_tasks',
    'select=zoho_sign_envelope_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
  const envelopeId = taskRes.ok && taskRes.data && taskRes.data[0] ? taskRes.data[0].zoho_sign_envelope_id : '';
  if (!envelopeId) { sendJson(res, 404, { error: 'no envelope' }); return; }
  const pdf = await downloadSignedPdf(envelopeId);
  if (!pdf.ok) { sendJson(res, 502, { error: 'could not fetch PDF' }); return; }
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="SPPA-00.pdf"' });
  res.end(pdf.buffer);
  return;
}

// Approve and deliver
if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-approve')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const taskId = pathname.split('/')[5];
  const taskRes = await supabaseDbRequest('registration_tasks',
    'select=id,case_id,zoho_sign_envelope_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
  if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) { sendJson(res, 404, { error: 'task not found' }); return; }
  const task = taskRes.data[0];
  const envelopeId = task.zoho_sign_envelope_id;
  if (!envelopeId) { sendJson(res, 400, { error: 'no envelope' }); return; }

  const envRes = await supabaseDbRequest('zoho_sign_envelopes',
    'select=*&envelope_id=eq.' + encodeURIComponent(envelopeId) + '&limit=1');
  const env = envRes.ok && envRes.data && envRes.data[0] ? envRes.data[0] : null;
  if (!env) { sendJson(res, 404, { error: 'envelope not found' }); return; }
  if (env.status !== 'awaiting_review') { sendJson(res, 400, { error: 'envelope not awaiting review' }); return; }

  const pdf = await downloadSignedPdf(envelopeId);
  if (!pdf.ok) { sendJson(res, 502, { error: 'PDF download failed' }); return; }

  // Deliver to user documents + Google Drive
  const delivery = await deliverToMyDocuments(env.user_id, env.case_id, 'sppa_00', 'SPPA-00 Signed.pdf', pdf.buffer, 'application/pdf');

  // Update envelope + task
  await supabaseDbRequest('zoho_sign_envelopes',
    'envelope_id=eq.' + encodeURIComponent(envelopeId),
    { method: 'PATCH', body: { status: 'approved', signed_pdf_drive_id: delivery.driveFile || null, updated_at: new Date().toISOString() } });
  await supabaseDbRequest('registration_tasks',
    'id=eq.' + encodeURIComponent(task.id),
    { method: 'PATCH', body: { status: 'completed', completed_by: admin.id, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() } });

  // Timeline events
  await supabaseDbRequest('case_events', '', {
    method: 'POST',
    body: [{ case_id: env.case_id, event_type: 'sppa_approved', description: 'VA approved signed SPPA-00', created_at: new Date().toISOString() }]
  });

  sendJson(res, 200, { ok: true, driveFileId: delivery.driveFile, userDocId: delivery.userDoc });
  return;
}

// Request correction
if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-request-correction')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const taskId = pathname.split('/')[5];
  const body = await readJsonBody(req);
  const side = String((body && body.side) || '').toLowerCase();
  const sections = Array.isArray(body && body.sections) ? body.sections : [];
  const note = String((body && body.note) || '');
  if (side !== 'practice' && side !== 'candidate') { sendJson(res, 400, { error: 'side must be practice or candidate' }); return; }
  if (sections.length === 0) { sendJson(res, 400, { error: 'sections required' }); return; }
  if (!note.trim()) { sendJson(res, 400, { error: 'note required' }); return; }

  const taskRes = await supabaseDbRequest('registration_tasks',
    'select=id,case_id,zoho_sign_envelope_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
  const task = taskRes.ok && taskRes.data && taskRes.data[0] ? taskRes.data[0] : null;
  if (!task) { sendJson(res, 404, { error: 'task not found' }); return; }
  const oldEnvelopeId = task.zoho_sign_envelope_id;
  if (!oldEnvelopeId) { sendJson(res, 400, { error: 'no envelope' }); return; }

  // Fetch old field values
  const fv = await getEnvelopeFieldValues(oldEnvelopeId);
  if (!fv.ok) { sendJson(res, 502, { error: 'could not fetch field values' }); return; }
  const prefill = buildCorrectionFieldData(fv.fields, sections);

  // Fetch old envelope row for recipients
  const oldEnvRes = await supabaseDbRequest('zoho_sign_envelopes',
    'select=*&envelope_id=eq.' + encodeURIComponent(oldEnvelopeId) + '&limit=1');
  const oldEnv = oldEnvRes.ok && oldEnvRes.data && oldEnvRes.data[0] ? oldEnvRes.data[0] : null;
  if (!oldEnv) { sendJson(res, 404, { error: 'envelope row missing' }); return; }
  const recipient = pickCorrectionRecipient(side, oldEnv.recipient_contact, oldEnv.recipient_candidate);

  // Void old envelope
  await voidEnvelope(oldEnvelopeId, 'Voided for correction: ' + note);
  await supabaseDbRequest('zoho_sign_envelopes',
    'envelope_id=eq.' + encodeURIComponent(oldEnvelopeId),
    { method: 'PATCH', body: { status: 'voided_for_correction', updated_at: new Date().toISOString() } });

  // Create new envelope to affected signer only
  const created = await createEnvelopeFromTemplate({
    templateId: oldEnv.template_id,
    recipients: [recipient],
    prefillFields: prefill,
    note: 'Please correct the flagged sections: ' + note
  });
  if (!created.ok) { sendJson(res, 502, { error: created.error || 'create envelope failed' }); return; }

  // Insert new envelope record
  await supabaseDbRequest('zoho_sign_envelopes', '', {
    method: 'POST',
    body: [{
      envelope_id: created.envelopeId,
      task_id: task.id,
      user_id: oldEnv.user_id,
      case_id: task.case_id,
      template_id: oldEnv.template_id,
      status: side === 'practice' ? 'sent_to_contact' : 'sent_to_candidate',
      recipient_contact: side === 'practice' ? oldEnv.recipient_contact : null,
      recipient_candidate: side === 'candidate' ? oldEnv.recipient_candidate : null,
      previous_envelope_id: oldEnvelopeId,
      correction_sections: sections,
      correction_note: note,
      sent_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]
  });

  // Re-link task
  await supabaseDbRequest('registration_tasks',
    'id=eq.' + encodeURIComponent(task.id),
    { method: 'PATCH', body: { zoho_sign_envelope_id: created.envelopeId, updated_at: new Date().toISOString() } });

  sendJson(res, 200, { ok: true, envelopeId: created.envelopeId });
  return;
}

// Resend on decline/void/expired
if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-resend')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const taskId = pathname.split('/')[5];
  // Clear the old envelope link, then trigger sendSppa00Envelope fresh
  await supabaseDbRequest('registration_tasks',
    'id=eq.' + encodeURIComponent(taskId),
    { method: 'PATCH', body: { zoho_sign_envelope_id: null, updated_at: new Date().toISOString() } });
  const result = await sendSppa00Envelope(taskId);
  sendJson(res, result.ok ? 200 : 400, result);
  return;
}

// Update recipient email on bounce
if (req.method === 'POST' && pathname.startsWith('/api/admin/va/task/') && pathname.endsWith('/sppa-update-recipient')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const taskId = pathname.split('/')[5];
  const body = await readJsonBody(req);
  const newEmail = String((body && body.email) || '').trim();
  if (!newEmail) { sendJson(res, 400, { error: 'email required' }); return; }

  // On live envelopes Zoho allows updateRecipient; simplest path is always void+recreate with new email.
  // For robustness, void the old envelope and send a fresh one via sendSppa00Envelope with an override.
  // For this implementation, do void + fresh send:
  const taskRes = await supabaseDbRequest('registration_tasks',
    'select=id,case_id,zoho_sign_envelope_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
  const task = taskRes.ok && taskRes.data && taskRes.data[0] ? taskRes.data[0] : null;
  if (!task || !task.zoho_sign_envelope_id) { sendJson(res, 400, { error: 'no envelope' }); return; }

  await voidEnvelope(task.zoho_sign_envelope_id, 'Recipient email update');
  await supabaseDbRequest('zoho_sign_envelopes',
    'envelope_id=eq.' + encodeURIComponent(task.zoho_sign_envelope_id),
    { method: 'PATCH', body: { status: 'voided', updated_at: new Date().toISOString() } });

  // Update practice contact in user_state so sendSppa00Envelope picks up the new email
  const caseRes = await supabaseDbRequest('registration_cases',
    'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
  const userId = caseRes.ok && caseRes.data && caseRes.data[0] ? caseRes.data[0].user_id : null;
  if (userId) {
    const stateRes = await supabaseDbRequest('user_state',
      'select=state&user_id=eq.' + encodeURIComponent(userId) + '&key=eq.gp_career_state&limit=1');
    if (stateRes.ok && stateRes.data && stateRes.data[0]) {
      let state = stateRes.data[0].state;
      if (typeof state === 'string') { try { state = JSON.parse(state); } catch (e) { state = {}; } }
      if (state && state.placement && state.placement.practiceContact) state.placement.practiceContact.email = newEmail;
      else if (state && Array.isArray(state.applications)) {
        const app = state.applications.find(a => a && a.isPlacementSecured);
        if (app && app.practiceContact) app.practiceContact.email = newEmail;
      }
      await supabaseDbRequest('user_state',
        'user_id=eq.' + encodeURIComponent(userId) + '&key=eq.gp_career_state',
        { method: 'PATCH', body: { state, updated_at: new Date().toISOString() } });
    }
  }

  await supabaseDbRequest('registration_tasks',
    'id=eq.' + encodeURIComponent(task.id),
    { method: 'PATCH', body: { zoho_sign_envelope_id: null, updated_at: new Date().toISOString() } });

  const result = await sendSppa00Envelope(task.id);
  sendJson(res, result.ok ? 200 : 400, result);
  return;
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/zoho-sign.js server.js tests/zoho-sign.test.js
git commit -m "feat(phase2): VA review endpoints — preview, approve, correction, resend, update-recipient"
```

---

## Task 10: Task listing augmentation — join envelope status into task payload

**Files:**
- Modify: `server.js` — find the VA task listing endpoint (the one admin.html calls to render task cards)

- [ ] **Step 1: Locate the VA task listing endpoint**

Search `server.js` for the endpoint that returns tasks to admin.html. Likely `/api/admin/va/tasks` or similar. Look for `select=*` + `registration_tasks` + admin session gating. Note the exact path and function name.

- [ ] **Step 2: Supplement response with envelope data**

After fetching tasks, before sending the response, for every task where `related_document_key === 'sppa_00'` and `zoho_sign_envelope_id` is set, fetch the envelope row and merge:

```javascript
// After fetching `tasks` in the listing handler:
const sppaTaskIds = tasks.filter(t => t.related_document_key === 'sppa_00' && t.zoho_sign_envelope_id).map(t => t.zoho_sign_envelope_id);
if (sppaTaskIds.length > 0) {
  const envsRes = await supabaseDbRequest('zoho_sign_envelopes',
    'select=envelope_id,status,sent_at,completed_at,decline_reason,recipient_contact,recipient_candidate&envelope_id=in.(' + sppaTaskIds.map(id => '"' + id + '"').join(',') + ')');
  const envMap = {};
  if (envsRes.ok && Array.isArray(envsRes.data)) {
    envsRes.data.forEach(e => { envMap[e.envelope_id] = e; });
  }
  tasks.forEach(t => {
    if (t.related_document_key === 'sppa_00' && t.zoho_sign_envelope_id) {
      const e = envMap[t.zoho_sign_envelope_id];
      if (e) {
        t.zoho_sign = {
          envelope_id: e.envelope_id,
          status: e.status,
          sent_at: e.sent_at,
          completed_at: e.completed_at,
          decline_reason: e.decline_reason,
          recipient_contact: e.recipient_contact,
          recipient_candidate: e.recipient_candidate,
          days_since_sent: e.sent_at ? Math.floor((Date.now() - Date.parse(e.sent_at)) / 86400000) : null
        };
      }
    }
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(phase2): augment VA task listing with Zoho Sign envelope status"
```

---

## Task 11: Admin UI — Zoho Sign integration card

**Files:**
- Modify: `pages/admin.html` — add section in the Integrations tab

- [ ] **Step 1: Locate the Integrations tab HTML**

Search `pages/admin.html` for `Zoho Recruit` to find the existing integration card. Copy its structure as a template. The card should sit immediately below the Zoho Recruit card.

- [ ] **Step 2: Add the Zoho Sign card HTML**

Insert after the Zoho Recruit integration card:

```html
<div class="integration-card" id="zoho-sign-card" style="margin-top:16px;">
  <div class="integration-header">
    <h3>Zoho Sign</h3>
    <span id="zs-status-chip" class="status-chip disconnected">Disconnected</span>
  </div>
  <div class="integration-body">
    <div id="zs-connected-info" style="display:none;">
      <div><b>Organization:</b> <span id="zs-org-name">—</span></div>
      <div><b>Connected email:</b> <span id="zs-connected-email">—</span></div>
      <div><b>Token expires:</b> <span id="zs-token-exp">—</span></div>
      <div><b>Webhook registered:</b> <span id="zs-webhook-status">—</span></div>
      <div><b>SPPA-00 template:</b> <span id="zs-template-id">—</span></div>
    </div>
    <div id="zs-disconnected-info" style="display:none;">
      <p>SPPA-00 sends are paused until Zoho Sign is connected.</p>
    </div>
    <div style="margin-top:12px;">
      <button id="zs-connect-btn" class="btn-primary">Connect Zoho Sign</button>
      <button id="zs-disconnect-btn" class="btn-secondary" style="display:none;">Disconnect</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add the JS for the Zoho Sign card**

Within the existing admin.html IIFE (search for `(function(){` at file top), add these functions AND assign to `window` before the IIFE closes (same pattern used for Gmail Setup button per `project_practice_pack_phase1b.md`):

```javascript
async function loadZohoSignStatus() {
  const r = await fetch('/api/admin/integrations/zoho-sign/status', { credentials: 'include' });
  const data = await r.json();
  const chip = document.getElementById('zs-status-chip');
  const connectedBox = document.getElementById('zs-connected-info');
  const disconnectedBox = document.getElementById('zs-disconnected-info');
  const connectBtn = document.getElementById('zs-connect-btn');
  const disconnectBtn = document.getElementById('zs-disconnect-btn');
  if (data && data.connected) {
    chip.textContent = 'Connected';
    chip.className = 'status-chip connected';
    connectedBox.style.display = '';
    disconnectedBox.style.display = 'none';
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = '';
    document.getElementById('zs-org-name').textContent = data.orgName || '—';
    document.getElementById('zs-connected-email').textContent = data.connectedEmail || '—';
    document.getElementById('zs-token-exp').textContent = data.tokenExpiresAt ? new Date(data.tokenExpiresAt).toLocaleString() : '—';
    document.getElementById('zs-webhook-status').textContent = data.webhookRegistered ? 'Yes' : 'No';
    document.getElementById('zs-template-id').textContent = data.templateId || '— (set ZOHO_SIGN_SPPA_TEMPLATE_ID)';
  } else {
    chip.textContent = 'Disconnected';
    chip.className = 'status-chip disconnected';
    connectedBox.style.display = 'none';
    disconnectedBox.style.display = '';
    connectBtn.style.display = '';
    disconnectBtn.style.display = 'none';
  }
}

async function zohoSignConnect() {
  const r = await fetch('/api/admin/integrations/zoho-sign/auth-url', { credentials: 'include' });
  const data = await r.json();
  if (data && data.authUrl) window.location.href = data.authUrl;
  else alert('Could not start Zoho Sign OAuth: ' + (data && data.message));
}

async function zohoSignDisconnect() {
  if (!confirm('Disconnect Zoho Sign? SPPA-00 sends will be paused.')) return;
  await fetch('/api/admin/integrations/zoho-sign/disconnect', { method: 'POST', credentials: 'include' });
  await loadZohoSignStatus();
}

// Wire up buttons on DOMContentLoaded
document.addEventListener('DOMContentLoaded', function () {
  const connectBtn = document.getElementById('zs-connect-btn');
  const disconnectBtn = document.getElementById('zs-disconnect-btn');
  if (connectBtn) connectBtn.onclick = zohoSignConnect;
  if (disconnectBtn) disconnectBtn.onclick = zohoSignDisconnect;
  if (document.getElementById('zs-status-chip')) loadZohoSignStatus();
});

// Export to window before IIFE closes (to match existing pattern)
window.loadZohoSignStatus = loadZohoSignStatus;
window.zohoSignConnect = zohoSignConnect;
window.zohoSignDisconnect = zohoSignDisconnect;
```

- [ ] **Step 4: Bump the cache buster on admin.html's script tag**

Find the `<script src="/js/admin-*.js?v=..."></script>` lines at the bottom of admin.html and bump any that contain newly-added code.

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat(phase2): admin UI — Zoho Sign integration card"
```

---

## Task 12: Admin UI — SPPA-00 task card (5-stage chip + days counter + buttons)

**Files:**
- Modify: `pages/admin.html:825-920` — the `renderDocTaskActions` function

- [ ] **Step 1: Replace the SPPA-00 branch in `renderDocTaskActions`**

Locate `renderDocTaskActions` (currently around line 825). In its body, replace the existing `if (dk === 'sppa_00')` branch with:

```javascript
if (dk === 'sppa_00') {
  var zs = task.zoho_sign || null;
  var statusLabel = {
    sent_to_contact: 'Sent to Contact',
    contact_signed: 'Contact Signed',
    sent_to_candidate: 'Sent to Candidate',
    candidate_signed: 'Candidate Signed',
    awaiting_review: 'Awaiting VA Review',
    approved: 'Approved',
    declined: 'Declined',
    voided: 'Voided',
    voided_for_correction: 'Sent for Correction',
    expired: 'Expired',
    recipient_delivery_failed: 'Email Bounced'
  };
  if (!zs) {
    return '<div class="doc-task-actions"><button class="btn-action" onclick="sendSppaEnvelope(\'' + task.id + '\')">Send SPPA-00</button></div>' +
           '<div class="doc-task-status"><span class="doc-task-badge pending-setup">Not yet sent</span></div>';
  }
  var label = statusLabel[zs.status] || zs.status;
  var badgeColor = '#dcfce7', badgeText = '#166534';
  if (['declined','voided','expired','recipient_delivery_failed'].includes(zs.status)) { badgeColor = '#fecaca'; badgeText = '#991b1b'; }
  else if (zs.status === 'awaiting_review') { badgeColor = '#fef9c3'; badgeText = '#854d0e'; }

  var daysChip = '';
  if (zs.days_since_sent !== null && zs.days_since_sent !== undefined) {
    var dColor = '#6b7280';
    if (zs.days_since_sent >= 14) dColor = '#dc2626';
    else if (zs.days_since_sent >= 7) dColor = '#ea580c';
    daysChip = '<span style="color:' + dColor + ';font-size:11px;margin-left:8px;">' + zs.days_since_sent + 'd since sent</span>';
  }

  var actions = '';
  if (zs.status === 'awaiting_review') {
    actions = '<button class="btn-action btn-review" onclick="openSppaReviewPanel(\'' + task.id + '\')">Review & Approve</button>';
  } else if (['declined','voided','expired'].includes(zs.status)) {
    actions = '<button class="btn-action" onclick="sendSppaResend(\'' + task.id + '\')">Re-send</button>';
    if (zs.decline_reason) actions += '<div style="color:#991b1b;font-size:11px;margin-top:4px;">Reason: ' + esc(zs.decline_reason) + '</div>';
  } else if (zs.status === 'recipient_delivery_failed') {
    actions = '<button class="btn-action" onclick="openSppaEditRecipient(\'' + task.id + '\')">Edit Email & Resend</button>';
  }

  var zohoLink = '<a href="https://sign.zoho.com.au/zs#/mydocuments/' + esc(zs.envelope_id) + '" target="_blank" rel="noopener" style="font-size:11px;margin-left:8px;">Open in Zoho ↗</a>';

  return '<div class="doc-task-status" style="margin-bottom:8px;">' +
           '<span class="doc-task-badge" style="background:' + badgeColor + ';color:' + badgeText + ';">' + label + '</span>' +
           daysChip + zohoLink +
         '</div>' +
         '<div class="doc-task-actions">' + actions + '</div>';
}
```

- [ ] **Step 2: Add top-level helper functions + `window` export**

Inside the IIFE, add:

```javascript
async function sendSppaEnvelope(taskId) {
  if (!confirm('Send SPPA-00 to practice contact?')) return;
  const r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/send-sppa', { method: 'POST', credentials: 'include' });
  const data = await r.json();
  if (data.ok) { alert('Sent. Envelope ID: ' + data.envelopeId); window.location.reload(); }
  else alert('Send failed: ' + (data.error || 'unknown'));
}

async function sendSppaResend(taskId) {
  if (!confirm('Re-send SPPA-00? A new envelope will be created.')) return;
  const r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-resend', { method: 'POST', credentials: 'include' });
  const data = await r.json();
  if (data.ok) { alert('Re-sent. New envelope: ' + data.envelopeId); window.location.reload(); }
  else alert('Re-send failed: ' + (data.error || 'unknown'));
}

async function openSppaEditRecipient(taskId) {
  const newEmail = prompt('Enter corrected recipient email:');
  if (!newEmail) return;
  const r = await fetch('/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-update-recipient', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail })
  });
  const data = await r.json();
  if (data.ok) { alert('Resent to ' + newEmail); window.location.reload(); }
  else alert('Failed: ' + (data.error || 'unknown'));
}

window.sendSppaEnvelope = sendSppaEnvelope;
window.sendSppaResend = sendSppaResend;
window.openSppaEditRecipient = openSppaEditRecipient;
// openSppaReviewPanel is defined in Task 13 and also exported there.
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat(phase2): admin UI — SPPA-00 task card with 5-stage status + buttons"
```

---

## Task 13: Admin UI — VA Review panel + Correction modal

**Files:**
- Modify: `pages/admin.html` — add modal HTML + handlers

- [ ] **Step 1: Add the review panel + correction modal HTML**

Insert near the bottom of `pages/admin.html`, just before the closing `</body>` tag:

```html
<div id="sppa-review-modal" class="modal" style="display:none;">
  <div class="modal-content" style="max-width:900px;">
    <div class="modal-header">
      <h3 id="sppa-review-title">SPPA-00 Review</h3>
      <button class="modal-close" onclick="closeSppaReviewPanel()">&times;</button>
    </div>
    <div class="modal-body">
      <div style="display:grid;grid-template-columns:1fr 320px;gap:16px;">
        <iframe id="sppa-review-pdf" style="width:100%;height:620px;border:1px solid #ddd;"></iframe>
        <div>
          <h4>Review checklist</h4>
          <label><input type="checkbox" class="sppa-check"> All fields complete</label><br>
          <label><input type="checkbox" class="sppa-check"> Candidate name matches user profile</label><br>
          <label><input type="checkbox" class="sppa-check"> Both signatures present</label><br>
          <label><input type="checkbox" class="sppa-check"> Dates are plausible (start date ≥ today)</label><br>
          <div style="margin-top:16px;">
            <button id="sppa-approve-btn" class="btn-primary" disabled onclick="approveSppa()">Approve &amp; Send to GP</button>
          </div>
          <div style="margin-top:8px;">
            <button class="btn-secondary" onclick="openSppaCorrectionModal()">Request Correction…</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="sppa-correction-modal" class="modal" style="display:none;">
  <div class="modal-content" style="max-width:540px;">
    <div class="modal-header">
      <h3>Request Correction</h3>
      <button class="modal-close" onclick="closeSppaCorrectionModal()">&times;</button>
    </div>
    <div class="modal-body">
      <div><b>Who needs to correct this?</b></div>
      <label><input type="radio" name="sppa-side" value="practice" checked> Practice Contact</label>
      <label style="margin-left:12px;"><input type="radio" name="sppa-side" value="candidate"> Candidate</label>

      <div style="margin-top:12px;"><b>Which sections?</b></div>
      <label><input type="checkbox" class="sppa-section" value="candidate_details"> Candidate details</label><br>
      <label><input type="checkbox" class="sppa-section" value="practice_details"> Practice details</label><br>
      <label><input type="checkbox" class="sppa-section" value="commencement_terms"> Commencement terms</label><br>
      <label><input type="checkbox" class="sppa-section" value="signatures"> Signatures</label><br>

      <div style="margin-top:12px;"><b>Note (will be emailed to signer):</b></div>
      <textarea id="sppa-correction-note" rows="4" style="width:100%;"></textarea>

      <div style="margin-top:16px;text-align:right;">
        <button class="btn-secondary" onclick="closeSppaCorrectionModal()">Cancel</button>
        <button class="btn-primary" onclick="submitSppaCorrection()">Submit Correction</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add the JS handlers inside the IIFE and export to window**

Add inside the IIFE:

```javascript
let currentSppaTaskId = null;

function openSppaReviewPanel(taskId) {
  currentSppaTaskId = taskId;
  document.getElementById('sppa-review-pdf').src = '/api/admin/va/task/' + encodeURIComponent(taskId) + '/sppa-pdf';
  document.querySelectorAll('.sppa-check').forEach(c => c.checked = false);
  document.getElementById('sppa-approve-btn').disabled = true;
  document.getElementById('sppa-review-modal').style.display = 'flex';
}
function closeSppaReviewPanel() {
  document.getElementById('sppa-review-modal').style.display = 'none';
  currentSppaTaskId = null;
}
document.addEventListener('change', function (e) {
  if (e.target && e.target.classList && e.target.classList.contains('sppa-check')) {
    const all = Array.from(document.querySelectorAll('.sppa-check')).every(c => c.checked);
    document.getElementById('sppa-approve-btn').disabled = !all;
  }
});
async function approveSppa() {
  if (!currentSppaTaskId) return;
  const btn = document.getElementById('sppa-approve-btn');
  btn.disabled = true;
  btn.textContent = 'Delivering...';
  const r = await fetch('/api/admin/va/task/' + encodeURIComponent(currentSppaTaskId) + '/sppa-approve', { method: 'POST', credentials: 'include' });
  const data = await r.json();
  if (data.ok) { alert('Delivered to GP MyDocuments + Google Drive'); closeSppaReviewPanel(); window.location.reload(); }
  else { alert('Approve failed: ' + (data.error || 'unknown')); btn.disabled = false; btn.textContent = 'Approve & Send to GP'; }
}
function openSppaCorrectionModal() {
  document.getElementById('sppa-correction-modal').style.display = 'flex';
}
function closeSppaCorrectionModal() {
  document.getElementById('sppa-correction-modal').style.display = 'none';
}
async function submitSppaCorrection() {
  if (!currentSppaTaskId) return;
  const side = (document.querySelector('input[name="sppa-side"]:checked') || {}).value;
  const sections = Array.from(document.querySelectorAll('.sppa-section:checked')).map(c => c.value);
  const note = document.getElementById('sppa-correction-note').value.trim();
  if (!side || sections.length === 0 || !note) { alert('Select side, at least one section, and enter a note.'); return; }
  const r = await fetch('/api/admin/va/task/' + encodeURIComponent(currentSppaTaskId) + '/sppa-request-correction', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ side, sections, note })
  });
  const data = await r.json();
  if (data.ok) { alert('Correction envelope sent. New envelope: ' + data.envelopeId); closeSppaCorrectionModal(); closeSppaReviewPanel(); window.location.reload(); }
  else alert('Correction failed: ' + (data.error || 'unknown'));
}

window.openSppaReviewPanel = openSppaReviewPanel;
window.closeSppaReviewPanel = closeSppaReviewPanel;
window.approveSppa = approveSppa;
window.openSppaCorrectionModal = openSppaCorrectionModal;
window.closeSppaCorrectionModal = closeSppaCorrectionModal;
window.submitSppaCorrection = submitSppaCorrection;
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat(phase2): admin UI — SPPA-00 review panel + correction modal"
```

---

## Task 14: Upgrade Phase 1b AI attachment matching to Sonnet 4.6 + prompt caching

**Files:**
- Modify: `server.js:524-565` — the `aiMatchEmail` function
- Create: `tests/email-triage.test.js` — test prompt caching application

- [ ] **Step 1: Write a failing test confirming Sonnet model + cache_control in the request body**

Create `tests/email-triage.test.js`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('Phase 1b AI matching — Sonnet + prompt cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts with model claude-sonnet-4-6 and cache_control on system block', async () => {
    const capturedBody = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('api.anthropic.com')) {
        capturedBody.push(JSON.parse(opts.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ text: '{"matches":[],"is_relevant":false,"summary":"x"}' }], usage: { input_tokens: 10, output_tokens: 10 } })
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { aiMatchEmail } = await import('../lib/ai-matching.js');
    await aiMatchEmail({ sender: 's@x.com', subject: 'x', body: 'x', attachments: [] }, [{ task_id: 't1', document_type: 'offer_contract', gp_name: 'Dr X' }]);
    expect(capturedBody.length).toBe(1);
    expect(capturedBody[0].model).toBe('claude-sonnet-4-6');
    expect(capturedBody[0].system).toBeDefined();
    const sysBlocks = Array.isArray(capturedBody[0].system) ? capturedBody[0].system : [capturedBody[0].system];
    expect(sysBlocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
npx vitest run tests/email-triage.test.js -t 'Sonnet + prompt cache'
```

Expected: FAIL — `lib/ai-matching.js` does not exist.

- [ ] **Step 3: Extract `aiMatchEmail` to `lib/ai-matching.js`**

Create `lib/ai-matching.js`:

```javascript
'use strict';

const AI_MATCH_SYSTEM_PROMPT = [
  'You are an assistant that classifies whether email attachments match an open Practice Pack task for a placed GP.',
  'You receive a list of open tasks (each with task_id, document_type, gp_name, practice details) and one inbound email with attachment filenames.',
  'Return JSON with this shape:',
  '{ "matches": [{"task_id": string, "attachment_filename": string, "confidence": number between 0 and 1, "reason": string}], "is_relevant": boolean, "summary": string }',
  'Confidence 0.7+ means high confidence; 0.4-0.7 means ambiguous; below 0.4 means do not match.',
  'Only claim a match if both the sender context and the attachment filename credibly correspond to a task.'
].join('\n');

function buildAIMatchUserPrompt(emailMeta, openTasks) {
  const emailSummary = {
    from: emailMeta.sender,
    subject: emailMeta.subject,
    date: emailMeta.date,
    body_snippet: String(emailMeta.body || '').slice(0, 3000),
    attachments: (emailMeta.attachments || []).map(a => a.filename)
  };
  return 'OPEN_TASKS:\n' + JSON.stringify(openTasks || [], null, 2) + '\n\nEMAIL:\n' + JSON.stringify(emailSummary, null, 2) + '\n\nReturn the JSON described in the system prompt only.';
}

function parseAIMatchResponse(text) {
  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) return { matches: [], is_relevant: false, summary: 'parse_fail' };
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return {
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      is_relevant: !!parsed.is_relevant,
      summary: String(parsed.summary || '')
    };
  } catch (e) {
    return { matches: [], is_relevant: false, summary: 'parse_error: ' + e.message };
  }
}

async function aiMatchEmail(emailMeta, openTasks, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { matches: [], is_relevant: false, summary: 'no api key' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: [{ type: 'text', text: AI_MATCH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildAIMatchUserPrompt(emailMeta, openTasks) }]
      })
    });
    if (!resp.ok) return { matches: [], is_relevant: false, summary: 'API error ' + resp.status };
    const data = await resp.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const parsed = parseAIMatchResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return { matches: [], is_relevant: false, summary: 'fetch error: ' + err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { aiMatchEmail, AI_MATCH_SYSTEM_PROMPT, buildAIMatchUserPrompt, parseAIMatchResponse };
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run tests/email-triage.test.js -t 'Sonnet + prompt cache'
```

Expected: 1 passed.

- [ ] **Step 5: Update `server.js` to import from `lib/ai-matching.js`**

In `server.js`, replace the existing `aiMatchEmail` function body (around lines 524-565) with:

```javascript
const { aiMatchEmail: aiMatchEmailImpl } = require('./lib/ai-matching.js');

async function aiMatchEmail(emailMeta, openTasks) {
  if (!checkAnthropicBudget()) {
    console.error('[Gmail AI] Daily Anthropic budget exceeded, skipping AI match');
    return { matches: [], is_relevant: false, summary: 'Budget exceeded' };
  }
  const result = await aiMatchEmailImpl(emailMeta, openTasks);
  if (result && result._usage) {
    recordAnthropicSpend(result._usage.input_tokens || 0, result._usage.output_tokens || 0,
      result._usage.cache_read_input_tokens || 0, result._usage.cache_creation_input_tokens || 0);
  }
  return result;
}
```

Also remove the now-unused helpers (`buildAIMatchPrompt`, `parseAIMatchResponse`) that were private to the old function — they have moved into `lib/ai-matching.js`.

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/ai-matching.js tests/email-triage.test.js server.js
git commit -m "feat(phase2): upgrade Phase 1b AI matching to Sonnet 4.6 + prompt caching"
```

---

## Task 15: AI email triage — placed GPs context + Sonnet classifier

**Files:**
- Create: `lib/email-triage.js`
- Modify: `tests/email-triage.test.js` — add triage tests
- Modify: `server.js` — add `getPlacedGPsForTriage` data fetcher

- [ ] **Step 1: Write failing tests for triage parsing and validation**

Append to `tests/email-triage.test.js`:

```javascript
import { parseTriageResponse, buildTriagePrompt } from '../lib/email-triage.js';

describe('Email triage — response parsing', () => {
  it('parses a well-formed triage response', () => {
    const text = JSON.stringify({
      matched_gp_user_id: 'u-1',
      confidence: 0.85,
      category: 'signing_question',
      urgency: 'high',
      summary: 'Contact asking about SPPA clause 4.2',
      needs_triage: false
    });
    const r = parseTriageResponse(text);
    expect(r.matched_gp_user_id).toBe('u-1');
    expect(r.confidence).toBe(0.85);
    expect(r.category).toBe('signing_question');
    expect(r.urgency).toBe('high');
    expect(r.needs_triage).toBe(false);
  });
  it('normalizes unknown category to "other"', () => {
    const text = JSON.stringify({ matched_gp_user_id: null, confidence: 0.2, category: 'banana', urgency: 'low', summary: 'x', needs_triage: true });
    const r = parseTriageResponse(text);
    expect(r.category).toBe('other');
  });
  it('marks needs_triage when confidence < 0.7', () => {
    const text = JSON.stringify({ matched_gp_user_id: 'u-2', confidence: 0.5, category: 'schedule_query', urgency: 'normal', summary: 'x', needs_triage: false });
    const r = parseTriageResponse(text);
    expect(r.needs_triage).toBe(true);
  });
  it('handles malformed JSON gracefully', () => {
    const r = parseTriageResponse('not-json');
    expect(r.needs_triage).toBe(true);
    expect(r.matched_gp_user_id).toBeNull();
  });
});

describe('Email triage — prompt building', () => {
  it('includes all placed GPs in user prompt', () => {
    const p = buildTriagePrompt(
      { sender: 's@x.com', subject: 'hi', body: 'body text', date: '2026-04-17' },
      [{ user_id: 'u-1', gp_name: 'Dr A', practice_name: 'A Clinic', contact_emails: ['a@x.com'] }]
    );
    expect(p).toContain('Dr A');
    expect(p).toContain('A Clinic');
    expect(p).toContain('s@x.com');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/email-triage.test.js -t 'triage'
```

Expected: FAIL — `lib/email-triage.js` does not exist.

- [ ] **Step 3: Create `lib/email-triage.js`**

```javascript
'use strict';

const VALID_CATEGORIES = new Set(['signing_question', 'document_request', 'schedule_query', 'status_update', 'other']);
const VALID_URGENCY = new Set(['low', 'normal', 'high']);

const TRIAGE_SYSTEM_PROMPT = [
  'You classify inbound emails related to placed GPs at GP Link.',
  'You receive a compact list of placed GPs and one inbound email.',
  'Return JSON:',
  '{',
  '  "matched_gp_user_id": string or null,',
  '  "confidence": number in [0,1],',
  '  "category": "signing_question" | "document_request" | "schedule_query" | "status_update" | "other",',
  '  "urgency": "low" | "normal" | "high",',
  '  "summary": string (one sentence),',
  '  "needs_triage": boolean',
  '}',
  'Set needs_triage=true when confidence < 0.7 or when the email is about a GP not in the provided list.',
  'Only match a GP if sender or subject or body clearly references that GP, their practice, their contact, or their signing envelope.'
].join('\n');

function buildTriagePrompt(email, placedGPs) {
  const emailSummary = {
    from: email.sender,
    subject: email.subject,
    date: email.date,
    body_snippet: String(email.body || '').slice(0, 4000)
  };
  return 'PLACED_GPS:\n' + JSON.stringify(placedGPs || [], null, 2) + '\n\nEMAIL:\n' + JSON.stringify(emailSummary, null, 2) + '\n\nReturn JSON only.';
}

function parseTriageResponse(text) {
  const defaults = { matched_gp_user_id: null, confidence: 0, category: 'other', urgency: 'low', summary: '', needs_triage: true };
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    const parsed = JSON.parse(text.slice(start, end + 1));
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : 'other';
    const urgency = VALID_URGENCY.has(parsed.urgency) ? parsed.urgency : 'low';
    const matchedUserId = parsed.matched_gp_user_id ? String(parsed.matched_gp_user_id) : null;
    const needsTriage = (confidence < 0.7) || !!parsed.needs_triage || !matchedUserId;
    return {
      matched_gp_user_id: matchedUserId,
      confidence,
      category,
      urgency,
      summary: String(parsed.summary || ''),
      needs_triage: needsTriage
    };
  } catch (e) {
    return defaults;
  }
}

async function triageEmailWithSonnet(email, placedGPs, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Object.assign(parseTriageResponse(''), { _error: 'no_api_key' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: [{ type: 'text', text: TRIAGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildTriagePrompt(email, placedGPs) }]
      })
    });
    if (!resp.ok) return Object.assign(parseTriageResponse(''), { _error: 'api_error_' + resp.status });
    const data = await resp.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const parsed = parseTriageResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return Object.assign(parseTriageResponse(''), { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { triageEmailWithSonnet, parseTriageResponse, buildTriagePrompt, TRIAGE_SYSTEM_PROMPT };
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/email-triage.test.js -t 'triage'
```

Expected: 5 passed.

- [ ] **Step 5: Add `getPlacedGPsForTriage` to `server.js`**

After the existing `getOpenPracticePackTasks` function (around `server.js:615`), add:

```javascript
/**
 * Returns a compact list of placed GPs for AI email triage.
 * Shape: { user_id, gp_name, practice_name, contact_emails: [string] }
 */
async function getPlacedGPsForTriage() {
  // Users with career_secured state
  const statesRes = await supabaseDbRequest('user_state',
    "select=user_id,state&key=eq.gp_career_state");
  if (!statesRes.ok || !Array.isArray(statesRes.data)) return [];
  const placed = [];
  for (const row of statesRes.data) {
    let state = row.state;
    if (typeof state === 'string') { try { state = JSON.parse(state); } catch (e) { state = {}; } }
    if (!state) continue;
    let placement = null;
    if (state.career_secured) placement = state.placement || state;
    else if (Array.isArray(state.applications)) {
      const app = state.applications.find(a => a && a.isPlacementSecured);
      if (app) placement = app;
    }
    if (!placement) continue;

    const profRes = await supabaseDbRequest('user_profiles',
      'select=first_name,last_name,email&user_id=eq.' + encodeURIComponent(row.user_id) + '&limit=1');
    const prof = (profRes.ok && profRes.data && profRes.data[0]) ? profRes.data[0] : {};
    const contactEmails = [];
    if (placement.practiceContact && placement.practiceContact.email) contactEmails.push(placement.practiceContact.email);
    if (prof.email) contactEmails.push(prof.email);

    placed.push({
      user_id: row.user_id,
      gp_name: ('Dr ' + (prof.first_name || '') + ' ' + (prof.last_name || '')).trim(),
      practice_name: placement.practiceName || placement.practice_name || '',
      contact_emails: contactEmails
    });
  }
  return placed;
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/email-triage.js tests/email-triage.test.js server.js
git commit -m "feat(phase2): AI email triage classifier with Sonnet 4.6"
```

---

## Task 16: Wire triage into Gmail pipeline + Incoming Questions endpoints

**Files:**
- Modify: `server.js` — extend Gmail message processing; add Incoming Questions endpoints

- [ ] **Step 1: Relax the pre-filter to allow no-attachment emails through**

Locate `preFilterEmail` in `server.js` (around line 459). Modify it so that "no attachments" is not an automatic reject — instead it returns `{ pass: true, reason: null, track: 'triage' }`:

```javascript
function preFilterEmail(emailMeta) {
  if (emailMeta.sender && emailMeta.sender.toLowerCase().endsWith('@mygplink.com.au')) {
    return { pass: false, reason: 'internal_sender' };
  }
  if (GMAIL_NOREPLY_PATTERNS.test(emailMeta.sender || '')) {
    return { pass: false, reason: 'marketing' };
  }
  if (emailMeta.headers && emailMeta.headers['list-unsubscribe']) {
    return { pass: false, reason: 'marketing' };
  }
  if (!emailMeta.attachments || emailMeta.attachments.length === 0) {
    return { pass: true, reason: null, track: 'triage' };
  }
  var hasDocAttachment = emailMeta.attachments.some(function (a) {
    return GMAIL_DOCUMENT_EXTENSIONS.test(a.filename || '');
  });
  if (!hasDocAttachment) {
    return { pass: true, reason: null, track: 'triage' };
  }
  return { pass: true, reason: null, track: 'attachments' };
}
```

- [ ] **Step 2: Add the triage branch in `processGmailNotification`**

Locate the section inside `processGmailNotification` that handles `preFilter.pass === true` (the existing attachment-matching branch). Wrap it in a switch on `track`:

```javascript
const filter = preFilterEmail(emailMeta);
if (!filter.pass) {
  await supabaseDbRequest('processed_gmail_messages', '', {
    method: 'POST',
    body: [{ gmail_message_id: messageId, email_address: emailAddress, sender: emailMeta.sender, subject: emailMeta.subject, processed_at: new Date().toISOString(), result: 'filtered', ai_summary: filter.reason }]
  });
  continue;
}

if (filter.track === 'attachments') {
  // Existing Phase 1b flow — unchanged
  const openTasks = await getOpenPracticePackTasks();
  const matchResult = await aiMatchEmail(emailMeta, openTasks);
  // ... existing matching + attachment-persistence code continues ...
} else if (filter.track === 'triage') {
  // New Phase 2 flow
  const { triageEmailWithSonnet } = require('./lib/email-triage.js');
  if (!checkAnthropicBudget()) {
    console.error('[Email triage] budget exceeded, skipping');
    await supabaseDbRequest('processed_gmail_messages', '', {
      method: 'POST',
      body: [{ gmail_message_id: messageId, email_address: emailAddress, sender: emailMeta.sender, subject: emailMeta.subject, processed_at: new Date().toISOString(), result: 'filtered', ai_summary: 'budget_exceeded' }]
    });
    continue;
  }
  const placedGPs = await getPlacedGPsForTriage();
  const triage = await triageEmailWithSonnet(emailMeta, placedGPs);
  if (triage && triage._usage) {
    recordAnthropicSpend(triage._usage.input_tokens || 0, triage._usage.output_tokens || 0,
      triage._usage.cache_read_input_tokens || 0, triage._usage.cache_creation_input_tokens || 0);
  }
  // Insert to-do (dedup on gmail_message_id)
  await supabaseDbRequest('incoming_email_todos', '', {
    method: 'POST',
    body: [{
      gmail_message_id: messageId,
      matched_user_id: triage.matched_gp_user_id || null,
      sender_email: emailMeta.sender || '',
      subject: emailMeta.subject || '',
      ai_category: triage.category,
      ai_urgency: triage.urgency,
      ai_summary: triage.summary,
      ai_confidence: triage.confidence,
      needs_triage: triage.needs_triage,
      created_at: new Date().toISOString()
    }]
  });
  await supabaseDbRequest('processed_gmail_messages', '', {
    method: 'POST',
    body: [{ gmail_message_id: messageId, email_address: emailAddress, sender: emailMeta.sender, subject: emailMeta.subject, processed_at: new Date().toISOString(), result: 'triaged', ai_summary: triage.summary }]
  });
}
```

> **Implementer note:** The existing attachment track code is extensive — do NOT rewrite it. Wrap the existing block in the `if (filter.track === 'attachments') { ... }` branch. Keep the unmatched-attachment path (which writes to `processed_gmail_messages` with `result='unmatched'`) unchanged so the existing Incoming Documents panel keeps working.

- [ ] **Step 3: Add Incoming Questions API endpoints**

After the VA review endpoints, add:

```javascript
// List unresolved incoming questions
if (req.method === 'GET' && pathname === '/api/admin/va/incoming-questions') {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const rows = await supabaseDbRequest('incoming_email_todos',
    'select=*&resolved_at=is.null&order=created_at.desc&limit=200');
  sendJson(res, 200, { ok: rows.ok, todos: rows.ok ? rows.data : [] });
  return;
}

// Manually assign a triage to a GP
if (req.method === 'POST' && pathname.startsWith('/api/admin/va/incoming-questions/') && pathname.endsWith('/assign')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const id = pathname.split('/')[5];
  const body = await readJsonBody(req);
  const userId = String((body && body.user_id) || '').trim();
  if (!userId) { sendJson(res, 400, { error: 'user_id required' }); return; }
  await supabaseDbRequest('incoming_email_todos',
    'id=eq.' + encodeURIComponent(id),
    { method: 'PATCH', body: { matched_user_id: userId, needs_triage: false } });
  sendJson(res, 200, { ok: true });
  return;
}

// Mark resolved
if (req.method === 'POST' && pathname.startsWith('/api/admin/va/incoming-questions/') && pathname.endsWith('/resolve')) {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const id = pathname.split('/')[5];
  await supabaseDbRequest('incoming_email_todos',
    'id=eq.' + encodeURIComponent(id),
    { method: 'PATCH', body: { resolved_at: new Date().toISOString(), resolved_by: admin.id } });
  sendJson(res, 200, { ok: true });
  return;
}
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(phase2): wire email triage into Gmail pipeline + Incoming Questions endpoints"
```

---

## Task 17: Admin UI — Incoming Questions panel

**Files:**
- Modify: `pages/admin.html` — add panel next to existing Incoming Documents panel

- [ ] **Step 1: Locate the Incoming Documents panel**

Search `pages/admin.html` for "Incoming Documents". Copy its structural pattern and insert a sibling panel immediately below.

- [ ] **Step 2: Add the Incoming Questions panel HTML**

```html
<div class="inbox-panel" id="incoming-questions-panel">
  <div class="inbox-panel-header">
    <h3>Incoming Questions <span id="iq-count" class="inbox-count">0</span></h3>
    <button class="btn-link" onclick="loadIncomingQuestions()">Refresh</button>
  </div>
  <div id="iq-list" class="inbox-list"></div>
</div>
```

- [ ] **Step 3: Add JS inside IIFE + window export**

```javascript
async function loadIncomingQuestions() {
  const r = await fetch('/api/admin/va/incoming-questions', { credentials: 'include' });
  const data = await r.json();
  const list = document.getElementById('iq-list');
  const countEl = document.getElementById('iq-count');
  if (!list) return;
  const todos = (data && data.todos) || [];
  countEl.textContent = String(todos.length);
  list.innerHTML = todos.map(t => {
    const urgencyColor = t.ai_urgency === 'high' ? '#dc2626' : t.ai_urgency === 'normal' ? '#ea580c' : '#6b7280';
    const confBadge = t.ai_confidence >= 0.7 ? '🟢' : t.ai_confidence >= 0.4 ? '🟡' : '⚪';
    const category = (t.ai_category || 'other').toUpperCase();
    return '<div class="iq-item" data-id="' + esc(t.id) + '" style="padding:8px;border-bottom:1px solid #eee;">' +
             '<div style="display:flex;gap:8px;align-items:center;">' +
               '<span style="color:' + urgencyColor + ';font-weight:bold;font-size:11px;">[' + category + ']</span>' +
               '<span>' + confBadge + '</span>' +
               '<span style="flex:1;">' + esc(t.ai_summary || '(no summary)') + '</span>' +
               '<span style="color:#6b7280;font-size:11px;">' + timeAgo(t.created_at) + '</span>' +
             '</div>' +
             '<div style="margin-top:4px;font-size:12px;color:#6b7280;">From: ' + esc(t.sender_email) + ' — Subject: ' + esc(t.subject || '') + '</div>' +
             '<div style="margin-top:4px;">' +
               (t.needs_triage ? '<button class="btn-action" onclick="assignIncomingQuestion(\'' + t.id + '\')">Assign to GP…</button>' : '') +
               '<button class="btn-action" style="margin-left:4px;" onclick="resolveIncomingQuestion(\'' + t.id + '\')">Dismiss</button>' +
             '</div>' +
           '</div>';
  }).join('');
}

async function assignIncomingQuestion(id) {
  const userId = prompt('Enter user_id of the GP to assign this to:');
  if (!userId) return;
  const r = await fetch('/api/admin/va/incoming-questions/' + encodeURIComponent(id) + '/assign', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId })
  });
  const data = await r.json();
  if (data.ok) loadIncomingQuestions(); else alert('Failed: ' + (data.error || 'unknown'));
}

async function resolveIncomingQuestion(id) {
  const r = await fetch('/api/admin/va/incoming-questions/' + encodeURIComponent(id) + '/resolve', { method: 'POST', credentials: 'include' });
  const data = await r.json();
  if (data.ok) loadIncomingQuestions(); else alert('Failed: ' + (data.error || 'unknown'));
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
  return Math.floor(mins / 1440) + 'd ago';
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.getElementById('iq-list')) loadIncomingQuestions();
});

window.loadIncomingQuestions = loadIncomingQuestions;
window.assignIncomingQuestion = assignIncomingQuestion;
window.resolveIncomingQuestion = resolveIncomingQuestion;
```

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat(phase2): admin UI — Incoming Questions panel"
```

---

## Task 18: Zoho Sign token refresh cron

**Files:**
- Modify: `server.js` — add cron endpoint
- Modify: `vercel.json` — add cron entry
- Modify: `tests/zoho-sign.test.js` — test cron auth

- [ ] **Step 1: Write failing test for cron auth rejection**

Append to `tests/zoho-sign.test.js`:

```javascript
import http from 'http';

describe('Zoho Sign token refresh cron — auth', () => {
  let server;
  let baseUrl;
  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const app = await import('../server.js');
    server = http.createServer(app.default || app.handler || app);
    await new Promise((res) => server.listen(0, res));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => server && server.close());

  it('rejects without bearer token', async () => {
    const r = await fetch(baseUrl + '/api/cron/refresh-zoho-sign-token');
    expect(r.status).toBe(401);
  });
  it('rejects with wrong bearer token', async () => {
    const r = await fetch(baseUrl + '/api/cron/refresh-zoho-sign-token', { headers: { Authorization: 'Bearer wrong' } });
    expect(r.status).toBe(401);
  });
});
```

> **Implementer note:** If `server.js` does not export a handler cleanly, this test may fail to bootstrap. In that case skip the HTTP-level test and instead unit-test a small `isCronAuthorized(req, secret)` helper extracted from the cron handler.

- [ ] **Step 2: Add the cron endpoint**

In `server.js`, alongside the Gmail watch renewal cron (around line 13016), add:

```javascript
if (req.method === 'GET' && pathname === '/api/cron/refresh-zoho-sign-token') {
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const authHeader = req.headers['authorization'] || '';
  if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  const c = await getZohoSignConnection();
  if (!c || !c.refreshToken) { sendJson(res, 200, { ok: true, skipped: 'not_connected' }); return; }
  const refreshed = await refreshZohoSignAccessToken(c);
  sendJson(res, 200, { ok: refreshed.ok, status: refreshed.status });
  return;
}
```

- [ ] **Step 3: Add cron entry to `vercel.json`**

Open `vercel.json` and append to the `crons` array:

```json
{ "path": "/api/cron/refresh-zoho-sign-token", "schedule": "*/30 * * * *" }
```

Resulting section:

```json
"crons": [
  { "path": "/api/cron/renew-gmail-watch", "schedule": "0 0 */6 * *" },
  { "path": "/api/cron/refresh-zoho-sign-token", "schedule": "*/30 * * * *" }
]
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server.js vercel.json tests/zoho-sign.test.js
git commit -m "feat(phase2): Zoho Sign token refresh cron (every 30 min)"
```

---

## Task 19: Final infrastructure — env vars, migration run, OAuth consent, memory updates

**Files:**
- Modify: `.claude/projects/.../memory/MEMORY.md` and create `project_practice_pack_phase2.md`

This task is operational: it requires access to the Vercel dashboard, Supabase dashboard, and Zoho Developer Console. Do NOT skip any step.

- [ ] **Step 1: Register Zoho Sign OAuth client**

Log in to `https://api-console.zoho.com.au`. Create a new Server-based Application:
- Name: `GP Link Zoho Sign`
- Homepage URL: `https://www.mygplink.com.au`
- Authorized redirect URI: `https://www.mygplink.com.au/api/admin/integrations/zoho-sign/callback`

Copy the Client ID and Client Secret.

- [ ] **Step 2: Set Vercel env vars**

In the Vercel dashboard (Project → Settings → Environment Variables), add for **all environments**:

| Variable | Value |
|---|---|
| `ZOHO_SIGN_CLIENT_ID` | (from Step 1) |
| `ZOHO_SIGN_CLIENT_SECRET` | (from Step 1) |
| `ZOHO_SIGN_ACCOUNTS_SERVER` | `https://accounts.zoho.com.au` |
| `ZOHO_SIGN_API_BASE` | `https://sign.zoho.com.au/api/v1` |
| `ZOHO_SIGN_REDIRECT_URI` | `https://www.mygplink.com.au/api/admin/integrations/zoho-sign/callback` |
| `ZOHO_SIGN_SPPA_TEMPLATE_ID` | (get from Zoho Sign template URL — e.g., `https://sign.zoho.com.au/zs#/templates/{{TEMPLATE_ID}}/...`) |

Redeploy after saving.

- [ ] **Step 3: Apply the Supabase migration**

Open Supabase SQL Editor. Paste the contents of `supabase/migrations/20260417000000_zoho_sign_and_email_triage.sql`. Run. Verify:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('zoho_sign_envelopes','processed_zoho_sign_events','incoming_email_todos');
```

Expected: 3 rows.

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'registration_tasks' AND column_name = 'zoho_sign_envelope_id';
```

Expected: 1 row.

- [ ] **Step 4: Connect Zoho Sign via admin UI**

1. Go to `https://www.mygplink.com.au/admin.html` → Integrations tab.
2. Click **Connect Zoho Sign**.
3. Approve the OAuth consent.
4. Verify the card flips to **Connected** and shows organization name + template ID.
5. Verify `Webhook registered: Yes` — if not, click **Disconnect → Connect** again to retry.

- [ ] **Step 5: Verify webhook received a test event**

In Zoho Sign UI, create a test template envelope. Immediately check Vercel logs for a `/api/webhooks/zoho-sign` POST and confirm 200 response.

If webhook auto-registration failed:
- Check Vercel logs for the error message from `registerZohoSignWebhook`.
- Manually register via the Zoho Sign API using the stored `webhook_secret` (read from the `integration_connections.metadata` jsonb).
- Worst case: add the webhook through the Zoho Sign UI (Settings → Webhooks → Add), URL `https://www.mygplink.com.au/api/webhooks/zoho-sign`, secret value from DB.

- [ ] **Step 6: Update memory**

Rewrite `/Users/khaleed/.claude/projects/-Users-khaleed-GP-LINK-APP--Visual-Studio-/memory/project_practice_pack_phase2.md`:

```markdown
---
name: Practice Pack Phase 2 — Zoho Sign + AI Email Triage
description: Phase 2 Zoho Sign SPPA-00 integration + AI email triage status. LIVE as of YYYY-MM-DD (update on connect).
type: project
---

## Status: LIVE in production

## What It Does
- Sends SPPA-00 via Zoho Sign (practice contact first, candidate second)
- 5-stage task card status: Sent to Contact → Contact Signed → Sent to Candidate → Candidate Signed → Awaiting VA Review
- VA reviews signed PDF against a checklist, then Approve → delivered to MyDocuments + Google Drive
- Request Correction sends new envelope ONLY to the flagged signer, prefilling all non-flagged sections from the voided envelope
- Email triage (Sonnet 4.6): classifies inbound emails with a matched GP + category + urgency, surfaces to Incoming Questions panel
- Phase 1b attachment matching upgraded from Haiku → Sonnet 4.6

## Infrastructure (all complete)
- Vercel env vars set: ZOHO_SIGN_CLIENT_ID/SECRET, ACCOUNTS_SERVER, API_BASE, REDIRECT_URI, SPPA_TEMPLATE_ID
- Supabase migration `20260417000000_zoho_sign_and_email_triage.sql` applied
- Zoho Sign OAuth connected via /admin.html Integrations tab
- Webhook registered (auto via OAuth callback)
- Token refresh cron every 30 minutes at `/api/cron/refresh-zoho-sign-token`

## Key Files
- `lib/zoho-sign.js` — pure helpers (URLs, mapper, correction prefill, event-to-status, HMAC)
- `lib/ai-matching.js` — Phase 1b Sonnet attachment matching
- `lib/email-triage.js` — Phase 2 Sonnet email triage
- `server.js` — OAuth, API client, envelope lifecycle, webhook, send/approve/correction endpoints
- `pages/admin.html` — Integration card, SPPA-00 task card, VA review modal, correction modal, Incoming Questions panel
- `supabase/migrations/20260417000000_zoho_sign_and_email_triage.sql`

## Design spec & plan
- Spec: `docs/superpowers/specs/2026-04-17-practice-pack-phase2-design.md`
- Plan: `docs/superpowers/plans/2026-04-17-practice-pack-phase2.md`

## Legal note (from spec)
Correction envelopes go only to the affected signer. The non-affected party's signature stays on the voided envelope and does not cover the correction. OK for typos; material changes should re-sign from both.

## Next steps
Run end-to-end test: real GP signs up, registration flow creates SPPA-00 task, VA reviews flow completes. See `project_testing_strategy.md` for the full test plan.
```

Then update the pointer entry in `MEMORY.md`:

```markdown
- [project_practice_pack_phase2.md](project_practice_pack_phase2.md) — Phase 2 Zoho Sign SPPA-00 + AI email triage: LIVE
```

And extend the "Env Vars (Vercel)" section in MEMORY.md with:

```markdown
- `ZOHO_SIGN_CLIENT_ID`, `ZOHO_SIGN_CLIENT_SECRET`, `ZOHO_SIGN_ACCOUNTS_SERVER`, `ZOHO_SIGN_API_BASE`, `ZOHO_SIGN_REDIRECT_URI`, `ZOHO_SIGN_SPPA_TEMPLATE_ID` - Zoho Sign (Phase 2)
```

- [ ] **Step 7: Final commit and push**

```bash
git add -A
git commit -m "docs(phase2): memory updates after Zoho Sign live"
git push origin main
```

- [ ] **Step 8: Announce completion**

Task #20 complete. Phase 2 is now live. End-to-end testing begins per `project_testing_strategy.md`.

---

## Spec Coverage Verification (self-review)

| Spec section | Covered in |
|---|---|
| 1. Architecture Overview | Tasks 2-7 (OAuth, API client, webhook) |
| 2.1 Auto-send trigger | Task 8 Step 3 |
| 2.2 Five-stage status | Task 7 (mapper), Task 12 (UI) |
| 2.3 Field pre-population | Task 6 (explicitly no server-side prefill on initial send) |
| 2.4 Reminders | Not implemented (per spec — Zoho native reminders) |
| 3. VA Review UI | Task 13 |
| 4.1 Approval → GP delivery | Task 9 Step 5 |
| 4.2 Correction flow | Task 9 Step 5 (per-section, signer-only) |
| 4.3 Decline/void/expiry | Task 12 (re-send button), Task 7 (status mapping) |
| 4.4 Recipient email bounce | Task 9 (update-recipient), Task 12 (edit button) |
| 5.1 Pipeline extension | Task 16 Step 2 |
| 5.2 Incoming Questions panel | Task 17 |
| 5.3 Model selection (Sonnet 4.6 both paths) | Tasks 14-15 |
| 5.4 GP identification logic | Task 15 Step 5 |
| 5.5 Cost control (prompt caching) | Tasks 14-15 |
| 6. OAuth Setup | Tasks 2-5 |
| 6.4 Webhook auto-registration | Task 6 Step 6 |
| 6.5 Graceful disconnect | Task 11 (disabled banner), Task 12 (Send button fallback) |
| 7. Webhook Handling | Task 7 |
| 8. Database Schema | Task 1 |
| 9. API Endpoints | Tasks 5, 8, 9, 16 |
| 10. Env Vars | Task 19 |
| 11. Operational Safeguards | Throughout; explicit in Tasks 11, 12, 14 |

All spec requirements are covered.

---

## Execution

This plan will be executed via **superpowers:subagent-driven-development** per the project's `CLAUDE.md` rule: *"ALWAYS USE SUBAGENTS. When executing implementation plans, always use subagent-driven development (one subagent per task). Never ask which execution approach to use."*

Next step: the controller invokes subagent-driven-development to dispatch a fresh implementer subagent for Task 1, with spec compliance review and code quality review between tasks.
