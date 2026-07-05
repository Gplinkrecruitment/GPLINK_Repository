# Onboarding Nudge Emails + Onboarding-Incomplete Waitlist Sub-bucket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPs who haven't completed onboarding are pulled out of the "Unassociated" ATS bucket into a CEO "Waitlist → Onboarding incomplete" tab, and get a reminder-email sequence (1h, 24h, 3d, then weekly to day 31) from notifications@mygplink.com.au with a resume deep-link and one-click unsubscribe.

**Architecture:** A pure schedule engine (`lib/onboarding-nudge.js`) + an `onboarding_reminders` table drive an hourly cron in `server.js`. The CEO funnel excludes not-onboarded GPs; a new read endpoint feeds a second tab added to the existing PEP Waitlist card. Spec: `docs/superpowers/specs/2026-07-05-onboarding-nudge-waitlist-design.md`.

**Tech Stack:** Node (single `server.js`), Supabase REST via `supabaseDbRequest` with local-JSON fallback (`dbState`), Resend via existing `sendEmail`, vitest.

## Global Constraints

- Sender: `notifications@mygplink.com.au`, name `GP Link` (the `sendEmail` default — pass no `from`).
- Schedule (inactivity thresholds): `[1h, 24h, 72h, 10d, 17d, 24d, 31d]` — 7 emails max, then stop.
- Reset on return: fresh activity resets `anchor_at` and clears `steps_sent`.
- Chase only `account_status` `'active'` (or null/empty), never admins/VAs, never onboarding-complete users.
- Completed test (either signal wins): `user_profiles.onboarding_completed_at != null` OR `user_state.state.gp_onboarding_complete` truthy OR `state.gp_onboarding.completedAt` truthy.
- server.js is ONE file with ~50k lines; prefix all new local vars uniquely (`onb…` for cron, `onbi…` for CEO endpoint) to avoid redeclaration collisions. Run `node --check server.js` after every server.js edit.
- Migration is NOT auto-applied. It ships as a SQL file; prod application happens in Task 7 via `rpc/exec_sql`.
- Cache busters: `?v=20260705b` for touched JS.
- Tests: `npx vitest run tests/<file>.test.js`. Endpoint tests boot the real server in LOCAL-JSON mode — copy the harness shape of `tests/ats-endpoints.test.js` (env setup, `req()` helper, `superCookie()`).
- Commit after every task (repo rule: commit and push frequently; push happens on the branch).

---

### Task 1: Pure nudge engine + migration file

**Files:**
- Create: `lib/onboarding-nudge.js`
- Create: `tests/onboarding-nudge.test.js`
- Create: `supabase/migrations/20260705130000_onboarding_reminders.sql`

**Interfaces:**
- Produces (consumed by Tasks 2–4):
  - `NUDGE_SCHEDULE_MS: number[]` — 7 thresholds.
  - `nextDueStep({ inactivityMs, stepsSent }) -> number|null`
  - `isExhausted({ inactivityMs, stepsSent }) -> boolean`
  - `copyForStep(index, { name, stepsLeft }) -> { subject, title, body }`
  - `ONBOARDING_STEP_LABELS: string[]` — 5 labels for CEO display.

- [ ] **Step 1: Write the failing test** — `tests/onboarding-nudge.test.js`:

```js
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { NUDGE_SCHEDULE_MS, nextDueStep, isExhausted, copyForStep, ONBOARDING_STEP_LABELS } = require('../lib/onboarding-nudge.js');

const H = 3600000, D = 24 * H;

describe('NUDGE_SCHEDULE_MS', () => {
  it('is 1h, 24h, 72h, 10d, 17d, 24d, 31d', () => {
    expect(NUDGE_SCHEDULE_MS).toEqual([H, 24 * H, 72 * H, 10 * D, 17 * D, 24 * D, 31 * D]);
  });
});

describe('nextDueStep', () => {
  it('nothing due before 1h', () => {
    expect(nextDueStep({ inactivityMs: H - 1, stepsSent: [] })).toBe(null);
  });
  it('step 0 due at exactly 1h', () => {
    expect(nextDueStep({ inactivityMs: H, stepsSent: [] })).toBe(0);
  });
  it('does not resend a sent step', () => {
    expect(nextDueStep({ inactivityMs: H + 1, stepsSent: [0] })).toBe(null);
  });
  it('returns the EARLIEST unsent due step (catch-up after downtime)', () => {
    expect(nextDueStep({ inactivityMs: 4 * D, stepsSent: [] })).toBe(0);
    expect(nextDueStep({ inactivityMs: 4 * D, stepsSent: [0, 1] })).toBe(2);
  });
  it('walks the weekly tail', () => {
    expect(nextDueStep({ inactivityMs: 10 * D, stepsSent: [0, 1, 2] })).toBe(3);
    expect(nextDueStep({ inactivityMs: 31 * D, stepsSent: [0, 1, 2, 3, 4, 5] })).toBe(6);
  });
  it('null when all sent', () => {
    expect(nextDueStep({ inactivityMs: 40 * D, stepsSent: [0, 1, 2, 3, 4, 5, 6] })).toBe(null);
  });
  it('tolerates junk input', () => {
    expect(nextDueStep({ inactivityMs: -5, stepsSent: null })).toBe(null);
    expect(nextDueStep({})).toBe(null);
  });
});

describe('isExhausted', () => {
  it('false mid-sequence', () => {
    expect(isExhausted({ inactivityMs: 5 * D, stepsSent: [0, 1, 2] })).toBe(false);
  });
  it('true once the final step is sent', () => {
    expect(isExhausted({ inactivityMs: 31 * D, stepsSent: [0, 1, 2, 3, 4, 5, 6] })).toBe(true);
  });
  it('true past 31d even if some steps were skipped, as long as nothing is still due', () => {
    // steps all sent OR nothing due -> exhausted when beyond the last threshold
    expect(isExhausted({ inactivityMs: 32 * D, stepsSent: [0, 1, 2, 3, 4, 5, 6] })).toBe(true);
    // something still due -> NOT exhausted (send it first)
    expect(isExhausted({ inactivityMs: 32 * D, stepsSent: [0, 1, 2, 3, 4, 5] })).toBe(false);
  });
});

describe('copyForStep', () => {
  it('every step has non-empty subject/title/body and greets by name', () => {
    for (let i = 0; i < 7; i++) {
      const c = copyForStep(i, { name: 'Helen', stepsLeft: 3 });
      expect(c.subject.length).toBeGreaterThan(5);
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.body).toContain('Helen');
    }
  });
  it('mentions how many steps are left when provided', () => {
    expect(copyForStep(1, { name: 'Helen', stepsLeft: 2 }).body).toContain('2');
  });
  it('final email says the reminders will stop', () => {
    expect(copyForStep(6, { name: 'Helen', stepsLeft: 1 }).body.toLowerCase()).toContain('last');
  });
});

describe('ONBOARDING_STEP_LABELS', () => {
  it('has 5 labels matching the 5-step wizard', () => {
    expect(ONBOARDING_STEP_LABELS.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/onboarding-nudge.test.js` → FAIL (`Cannot find module '../lib/onboarding-nudge.js'`).

- [ ] **Step 3: Implement `lib/onboarding-nudge.js`** (CommonJS, matches `lib/` convention):

```js
// Onboarding nudge engine — pure scheduling + copy for the reminder emails sent
// to GPs who started but never finished the 5-step onboarding wizard.
// No I/O here: the /api/cron/onboarding-nudge branch in server.js owns reads,
// writes and sending. Spec: docs/superpowers/specs/2026-07-05-onboarding-nudge-waitlist-design.md
'use strict';

var HOUR = 3600000;
var DAY = 24 * HOUR;

// Inactivity thresholds. Index N = the Nth email, sent once inactivity passes it:
// ~1h after leaving, 24h, 3 days, then weekly (day 10/17/24/31), then stop.
var NUDGE_SCHEDULE_MS = [HOUR, 24 * HOUR, 72 * HOUR, 10 * DAY, 17 * DAY, 24 * DAY, 31 * DAY];

// Mirrors the 5-step wizard in js/onboarding.js (TOTAL_STEPS = 5).
var ONBOARDING_STEP_LABELS = [
  'Get started',
  'Qualification check',
  'Qualification documents',
  'Personal & family details',
  'Identity verification'
];

function _sentSet(stepsSent) {
  var set = {};
  (Array.isArray(stepsSent) ? stepsSent : []).forEach(function (s) { set[Number(s)] = true; });
  return set;
}

// Lowest schedule index that is due (threshold <= inactivityMs) and unsent.
// One email per cron pass per GP — the earliest owed one.
function nextDueStep(input) {
  var inactivityMs = Number(input && input.inactivityMs);
  if (!isFinite(inactivityMs) || inactivityMs <= 0) return null;
  var sent = _sentSet(input && input.stepsSent);
  for (var i = 0; i < NUDGE_SCHEDULE_MS.length; i++) {
    if (sent[i]) continue;
    if (inactivityMs >= NUDGE_SCHEDULE_MS[i]) return i;
    return null; // thresholds are ascending: first unsent not yet due -> nothing due
  }
  return null;
}

// Sequence complete: past the final threshold with nothing left to send.
function isExhausted(input) {
  var inactivityMs = Number(input && input.inactivityMs);
  if (!isFinite(inactivityMs)) return false;
  if (inactivityMs < NUDGE_SCHEDULE_MS[NUDGE_SCHEDULE_MS.length - 1]) {
    var sent = _sentSet(input && input.stepsSent);
    return !!sent[NUDGE_SCHEDULE_MS.length - 1];
  }
  return nextDueStep(input) === null;
}

// Plain, friendly copy. `stepsLeft` = wizard steps remaining (may be null).
function copyForStep(index, opts) {
  var name = String((opts && opts.name) || '').trim() || 'there';
  var stepsLeft = (opts && opts.stepsLeft != null) ? Number(opts.stepsLeft) : null;
  var leftBit = (stepsLeft && stepsLeft > 0)
    ? 'You only have ' + stepsLeft + ' step' + (stepsLeft === 1 ? '' : 's') + ' left. '
    : '';
  var variants = [
    { subject: 'Finish setting up your GP Link account',
      title: 'You’re almost set up',
      body: 'Hi ' + name + ', you were so close! ' + leftBit + 'Pick up right where you left off — it only takes a few minutes.' },
    { subject: 'Your GP Link account is waiting',
      title: 'Ready when you are',
      body: 'Hi ' + name + ', your GP Link account setup is still waiting. ' + leftBit + 'Practices are hiring right now — finish up so we can start matching you.' },
    { subject: 'Still keen on working in Australia?',
      title: 'Let’s get you over the line',
      body: 'Hi ' + name + ', it’s been a few days since you started your GP Link setup. ' + leftBit + 'Jump back in and we’ll take care of the rest.' },
    { subject: 'Your Australian GP journey is on pause',
      title: 'Shall we keep going?',
      body: 'Hi ' + name + ', your account setup has been paused for over a week. ' + leftBit + 'It only takes a few minutes to finish — then our team can start working for you.' },
    { subject: 'We’re holding your spot',
      title: 'Your spot is still here',
      body: 'Hi ' + name + ', we’re still holding your place at GP Link. ' + leftBit + 'Finish your setup and our recruitment team will pick things up straight away.' },
    { subject: 'Don’t lose momentum on your move to Australia',
      title: 'Nearly a month has gone by',
      body: 'Hi ' + name + ', it’s been nearly a month since you started. ' + leftBit + 'If life got busy, no stress — your progress is saved and you can finish any time.' },
    { subject: 'Last reminder from GP Link',
      title: 'This is our last reminder',
      body: 'Hi ' + name + ', this is the last reminder we’ll send about finishing your GP Link setup. ' + leftBit + 'Your progress stays saved, and you’re welcome back whenever you’re ready.' }
  ];
  var i = Math.max(0, Math.min(variants.length - 1, Number(index) || 0));
  return variants[i];
}

module.exports = { NUDGE_SCHEDULE_MS, ONBOARDING_STEP_LABELS, nextDueStep, isExhausted, copyForStep };
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/onboarding-nudge.test.js` → PASS.

- [ ] **Step 5: Create the migration** `supabase/migrations/20260705130000_onboarding_reminders.sql` (mirror the `pep_waitlist` file's conventions exactly — loose user_id, service-role RLS DO-block):

```sql
-- Onboarding reminders — chase GPs who started but never finished onboarding.
--
-- NOT applied automatically — apply via rpc/exec_sql with the service key
-- (schema-qualify names). One row per GP; the hourly /api/cron/onboarding-nudge
-- job creates rows on first sight, sends the schedule (1h/24h/3d/weekly to day
-- 31) measured from anchor_at, resets the anchor when the GP returns, and stops
-- on completion, unsubscribe, or exhaustion.
--
-- Additive / non-breaking. user_id is intentionally loose (nullable, NO foreign
-- key), matching pep_waitlist (20260705110000). Service-role-only RLS.

CREATE TABLE IF NOT EXISTS onboarding_reminders (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID,
  email              TEXT,
  name               TEXT,
  anchor_at          TIMESTAMPTZ,          -- most-recent last-active; schedule measured from here
  last_step          SMALLINT,             -- gp_onboarding.currentStep at last read (deep link)
  steps_sent         SMALLINT[]  NOT NULL DEFAULT '{}',
  last_sent_at       TIMESTAMPTZ,
  unsubscribed       BOOLEAN     NOT NULL DEFAULT false,
  unsubscribed_at    TIMESTAMPTZ,
  stopped            BOOLEAN     NOT NULL DEFAULT false,
  stopped_reason     TEXT,                 -- 'completed' | 'exhausted'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_reminders_user ON onboarding_reminders(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_reminders_email ON onboarding_reminders(email);
CREATE INDEX IF NOT EXISTS idx_onboarding_reminders_active ON onboarding_reminders(stopped, unsubscribed);

ALTER TABLE onboarding_reminders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'onboarding_reminders' AND policyname = 'onboarding_reminders_service_all'
  ) THEN
    CREATE POLICY onboarding_reminders_service_all ON onboarding_reminders
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
```

- [ ] **Step 6: Commit**

```bash
git add lib/onboarding-nudge.js tests/onboarding-nudge.test.js supabase/migrations/20260705130000_onboarding_reminders.sql
git commit -m "feat(nudge): pure onboarding-nudge engine + onboarding_reminders migration"
```

---

### Task 2: Reminder store + unsubscribe token/endpoint + email sender (server.js)

**Files:**
- Modify: `server.js` — new helper block right AFTER the PEP waitlist helper block (after `sendPepLaunchBroadcast`, i.e. after the `listPepWaitlist` group ends ~line 7800); unsubscribe route next to other public GET routes (put it just before the `/api/cron/weekly-sweep` branch at ~27329); extend `sendEmail` (~24901) with optional `headers`.
- Test: `tests/onboarding-unsubscribe.test.js`

**Interfaces:**
- Consumes: `NUDGE_SCHEDULE_MS`, `nextDueStep`, `isExhausted`, `copyForStep`, `ONBOARDING_STEP_LABELS` from `lib/onboarding-nudge.js` (require at top of server.js next to the other lib requires: `const onboardingNudge = require('./lib/onboarding-nudge.js');`).
- Produces (used by Tasks 3–4):
  - `onbUnsubToken(userId) -> hex string` and `onbUnsubTokenValid(userId, token) -> boolean`
  - `listOnboardingReminders() -> Promise<row[]>` (all rows, dual-path)
  - `upsertOnboardingReminder(userId, patch) -> Promise<void>` (creates or PATCHes by user_id; local path keyed by lowercased email — patch always carries `email`)
  - `sendOnboardingNudgeEmail(row, stepIndex, stepsLeft) -> Promise<{ok}>` — builds CTA deep link + unsubscribe footer + List-Unsubscribe header, from notifications@ (default sender).
- Row shape (both backends, snake_case): `{ id?, user_id, email, name, anchor_at, last_step, steps_sent, last_sent_at, unsubscribed, unsubscribed_at, stopped, stopped_reason, created_at, updated_at }`.

- [ ] **Step 1: Write the failing endpoint test** — `tests/onboarding-unsubscribe.test.js`. Copy the boot harness from `tests/ats-endpoints.test.js` (the `beforeAll` env block, server boot via `require(ROOT + '/server.js')`-style dynamic import it uses, `req()` helper, `afterAll` close + unlink DB file — replicate exactly what that file does, only renaming `RUN_ID`/`DB_FILE` to `gplink-onbunsub-*`). Do NOT seed ATS data; instead after boot, insert a reminder row through the module under test if exposed — the simplest hermetic route is: compute the token with the same HMAC recipe and hit the endpoint for a fabricated user, expecting the "no record" behavior to still return the friendly page (200), and a tampered token to return the generic page (400). Then exercise the real flip through the local DB file:

```js
// after the harness helpers (req, parse) and beforeAll boot:
import crypto2 from 'crypto';
function unsubToken(userId) {
  return crypto2.createHmac('sha256', process.env.AUTH_SECRET).update('onb-unsub:' + String(userId)).digest('hex');
}

describe('GET /api/onboarding-reminders/unsubscribe', () => {
  it('rejects a tampered token with the generic page (no user enumeration)', async () => {
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-1&t=deadbeef');
    expect(r.status).toBe(400);
    expect(r.raw).not.toContain('user-1');
  });
  it('accepts a valid token and marks the reminder row unsubscribed', async () => {
    // seed a reminder row directly into the local DB file, then restart-read via the endpoint
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.onboardingReminders = { 'helen@example.com': { user_id: 'user-helen', email: 'helen@example.com', name: 'Helen', anchor_at: new Date().toISOString(), last_step: 2, steps_sent: [], unsubscribed: false, stopped: false } };
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    // server holds dbState in memory; POST-boot file edits are invisible — so instead
    // drive the seed through the server: see note below. If no seeding route exists,
    // assert the valid-token path returns the confirmation page shape:
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-helen&t=' + unsubToken('user-helen'));
    expect(r.status).toBe(200);
    expect(r.raw.toLowerCase()).toContain('unsubscribed');
  });
  it('is idempotent — second click also 200', async () => {
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-helen&t=' + unsubToken('user-helen'));
    expect(r.status).toBe(200);
  });
});
```

  Implementation note for the seeding problem: the endpoint must handle "valid token, no existing row" by upserting `{ user_id, unsubscribed: true }` (a pre-emptive opt-out row) — that makes the unsubscribe durable even if the cron hasn't seen the GP yet AND makes this test hermetic without file tricks. Keep the two `fs` lines in the test anyway harmlessly, or drop them; the assertion path works via the upsert.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/onboarding-unsubscribe.test.js` → FAIL (404 route not found → status assertion fails).

- [ ] **Step 3: Implement in server.js.**

  (a) Top of file, next to other lib requires: `const onboardingNudge = require('./lib/onboarding-nudge.js');`

  (b) `sendEmail` (~24901): add `headers` to the destructured params; after the `if (scheduledAt) ...` line add `if (arguments[0] && arguments[0].headers) emailPayload.headers = arguments[0].headers;` — or cleanly: destructure `headers` and `if (headers) emailPayload.headers = headers;`.

  (c) Helper block (after the PEP helpers, mirroring their style):

```js
// ── Onboarding nudge reminders ─────────────────────────────────────────────
// GPs who started but never finished the 5-step onboarding wizard get a chase
// sequence (1h/24h/3d/weekly to day 31) from notifications@. Pure scheduling
// lives in lib/onboarding-nudge.js; these helpers own storage + sending.

function onbUnsubToken(userId) {
  return crypto.createHmac('sha256', SECRET).update('onb-unsub:' + String(userId || '')).digest('hex');
}
function onbUnsubTokenValid(userId, token) {
  var expect = onbUnsubToken(userId);
  var got = String(token || '');
  if (got.length !== expect.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expect, 'utf8')); } catch (e) { return false; }
}

async function listOnboardingReminders() {
  if (isSupabaseDbConfigured()) {
    var r = await supabaseDbRequest('onboarding_reminders', 'select=*&limit=5000');
    return (r.ok && Array.isArray(r.data)) ? r.data : [];
  }
  var out = [];
  var map = dbState.onboardingReminders || {};
  Object.keys(map).forEach(function (k) { out.push(map[k]); });
  return out;
}

// Upsert by user_id (Supabase) / lowercased email (local). patch always includes email.
async function upsertOnboardingReminder(userId, patch) {
  var nowIso = new Date().toISOString();
  var body = Object.assign({}, patch, { updated_at: nowIso });
  if (isSupabaseDbConfigured()) {
    var q = 'select=id&user_id=eq.' + encodeURIComponent(String(userId));
    var existing = await supabaseDbRequest('onboarding_reminders', q);
    if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
      await supabaseDbRequest('onboarding_reminders', 'id=eq.' + encodeURIComponent(existing.data[0].id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: body });
    } else {
      await supabaseDbRequest('onboarding_reminders', '', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: [Object.assign({ user_id: userId, created_at: nowIso }, body)] });
    }
    return;
  }
  if (!dbState.onboardingReminders) dbState.onboardingReminders = {};
  var key = String((patch && patch.email) || userId || '').trim().toLowerCase();
  var prev = dbState.onboardingReminders[key] || { user_id: userId, created_at: nowIso, steps_sent: [], unsubscribed: false, stopped: false };
  dbState.onboardingReminders[key] = Object.assign({}, prev, body, { user_id: prev.user_id || userId });
  saveDbState();
}

// Send one nudge. row = onboarding_reminders row. Returns sendEmail's result.
async function sendOnboardingNudgeEmail(row, stepIndex, stepsLeft) {
  if (!isEmailConfigured()) return { ok: false, error: 'Email not configured' };
  var to = String(row.email || '').trim();
  if (!to) return { ok: false, error: 'No email on reminder row' };
  var firstName = String(row.name || '').split(' ')[0] || '';
  var copy = onboardingNudge.copyForStep(stepIndex, { name: firstName || 'there', stepsLeft: stepsLeft });
  var step = (row.last_step != null && row.last_step >= 0 && row.last_step < 5) ? row.last_step : 0;
  var ctaUrl = APP_BASE_URL + '/pages/onboarding.html?step=' + step;
  var unsubUrl = APP_BASE_URL + '/api/onboarding-reminders/unsubscribe?u=' + encodeURIComponent(String(row.user_id || '')) + '&t=' + onbUnsubToken(row.user_id);
  var footer = '<a href="' + unsubUrl + '" style="color:#8a94a6;font-size:11px;text-decoration:underline">Unsubscribe from these reminders</a>';
  var html = buildCareerEmailHtml({
    title: copy.title,
    body: '<p>' + copy.body + '</p>',
    ctaText: 'Continue where you left off',
    ctaUrl: ctaUrl,
    footer: footer
  });
  return sendEmail({
    to: to,
    subject: copy.subject,
    html: html,
    text: copy.body + '\n\nContinue: ' + ctaUrl + '\n\nUnsubscribe: ' + unsubUrl,
    headers: { 'List-Unsubscribe': '<' + unsubUrl + '>' }
  });
}
```

  IMPORTANT: before coding `buildCareerEmailHtml({...})`, read its actual signature in server.js (grep `function buildCareerEmailHtml`) and match it — if it takes positional args or different keys (`{ name, title, bodyHtml, ... }`), adapt the call; `sendGpNotificationEmail` (~25142) shows a working call to copy.

  (d) Unsubscribe route (public GET, no session; place just before the weekly-sweep cron branch):

```js
// GET /api/onboarding-reminders/unsubscribe?u=<userId>&t=<hmac> — one-click,
// no login (clicked from email). Valid token: mark unsubscribed (upsert a row
// if the cron hasn't created one yet, so the opt-out survives). Invalid: a
// generic page, no user enumeration.
if (req.method === 'GET' && pathname === '/api/onboarding-reminders/unsubscribe') {
  var onbuU = String(url.searchParams.get('u') || '').trim();
  var onbuT = String(url.searchParams.get('t') || '').trim();
  var onbuPage = function (title, msg) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>' + title + '</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1220;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">'
      + '<div style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 12px">' + title + '</h2><p style="color:#8a94a6">' + msg + '</p></div></body></html>';
  };
  if (!onbuU || !onbuT || !onbUnsubTokenValid(onbuU, onbuT)) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(onbuPage('Link expired', 'This unsubscribe link is no longer valid.'));
    return;
  }
  try {
    var onbuRows = await listOnboardingReminders();
    var onbuRow = onbuRows.find(function (r) { return String(r.user_id) === onbuU; }) || null;
    await upsertOnboardingReminder(onbuU, {
      email: (onbuRow && onbuRow.email) || null,
      unsubscribed: true,
      unsubscribed_at: new Date().toISOString()
    });
  } catch (e) { console.error('[OnbNudge] unsubscribe write failed:', e.message); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(onbuPage('Unsubscribed', 'You won’t get onboarding reminder emails anymore. You can still sign in and finish your setup any time.'));
  return;
}
```

- [ ] **Step 4: Syntax + tests** — `node --check server.js` then `npx vitest run tests/onboarding-unsubscribe.test.js tests/onboarding-nudge.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/onboarding-unsubscribe.test.js
git commit -m "feat(nudge): reminder store, unsubscribe token+endpoint, nudge email sender"
```

---

### Task 3: Hourly cron `/api/cron/onboarding-nudge` + vercel.json

**Files:**
- Modify: `server.js` (new cron branch directly after the unsubscribe route from Task 2)
- Modify: `vercel.json` (crons array)
- Test: `tests/onboarding-nudge-cron.test.js`

**Interfaces:**
- Consumes: `listOnboardingReminders`, `upsertOnboardingReminder`, `sendOnboardingNudgeEmail`, `onboardingNudge.*` (Task 1–2), `getAdminUserIdSet()` (existing, see weekly-sweep ~27352), `supabaseDbRequest`, `dbState`.
- Produces: `GET /api/cron/onboarding-nudge` returning `{ ok, scanned, created, sent, reset, stopped, skipped }`.

- [ ] **Step 1: Write the failing test** — `tests/onboarding-nudge-cron.test.js` (same boot harness; set `process.env.CRON_SECRET = 'cron-test-secret'` in `beforeAll` BEFORE booting the server; local-JSON mode). Local mode has no Supabase, so the cron must fully work on `dbState`:

```js
describe('GET /api/cron/onboarding-nudge', () => {
  it('401s without the bearer secret', async () => {
    const r = await req('GET', '/api/cron/onboarding-nudge');
    expect(r.status).toBe(401);
  });
  it('runs and reports counters with the secret', async () => {
    const r = await req('GET', '/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer cron-test-secret' } });
    expect(r.status).toBe(200);
    const j = parse(r.raw);
    expect(j.ok).toBe(true);
    expect(j).toHaveProperty('scanned');
    expect(j).toHaveProperty('sent');
  });
});
```

  (Extend the harness `req()` to pass arbitrary headers — the ats-endpoints version only passes Host/Cookie; add `...opts.headers` into its headers object.)
  Deeper schedule behavior is already covered by the pure tests in Task 1; the cron test proves auth + wiring + counters. Email sending in test mode is a no-op (`RESEND_API_KEY` unset → `isEmailConfigured()` false) — the cron must therefore NOT mark steps sent when the send fails, and the test asserts `sent === 0`.

- [ ] **Step 2: Run to verify it fails** — 404/undefined → FAIL.

- [ ] **Step 3: Implement the cron branch** (model on weekly-sweep; all vars `onb`-prefixed):

```js
// ── Hourly: chase GPs who started but never finished onboarding ────────────
// Sequence per lib/onboarding-nudge.js: 1h, 24h, 3d, then weekly to day 31.
// Reset on return: fresh activity re-anchors the clock and clears steps_sent.
// Stops on completion (silent), unsubscribe, or exhaustion.
if (req.method === 'GET' && pathname === '/api/cron/onboarding-nudge') {
  var onbSecret = String(process.env.CRON_SECRET || '').trim();
  var onbAuth = req.headers['authorization'] || '';
  if (!onbSecret || onbAuth !== 'Bearer ' + onbSecret) { sendJson(res, 401, { ok: false, error: 'Unauthorized' }); return; }
  try {
    var onbNow = Date.now();
    var onbScanned = 0, onbCreated = 0, onbSent = 0, onbReset = 0, onbStopped = 0, onbSkipped = 0;

    // 1) Candidate GPs: incomplete onboarding, active account, not staff.
    //    { userId, email, name, lastActiveMs, lastStep, completed }
    var onbGps = [];
    if (isSupabaseDbConfigured()) {
      var onbAdminIds = await getAdminUserIdSet();
      var onbProfRes = await supabaseDbRequest('user_profiles',
        'select=user_id,email,first_name,last_name,account_status,onboarding_completed_at,created_at,updated_at' +
        '&onboarding_completed_at=is.null&limit=2000');
      var onbProfs = (onbProfRes.ok && Array.isArray(onbProfRes.data)) ? onbProfRes.data : [];
      onbProfs = onbProfs.filter(function (p) {
        var st = String(p.account_status || 'active').toLowerCase();
        return st === 'active' && p.user_id && !onbAdminIds.has(p.user_id) && p.email;
      });
      // user_state for completion double-check + last-active + currentStep (chunked)
      var onbStateMap = {};
      for (var onbI = 0; onbI < onbProfs.length; onbI += 100) {
        var onbChunk = onbProfs.slice(onbI, onbI + 100).map(function (p) { return '"' + String(p.user_id).replace(/"/g, '') + '"'; }).join(',');
        var onbStRes = await supabaseDbRequest('user_state', 'select=user_id,state,updated_at&user_id=in.(' + encodeURIComponent(onbChunk) + ')&limit=200');
        (((onbStRes.ok && onbStRes.data) || [])).forEach(function (s) { onbStateMap[s.user_id] = s; });
      }
      onbProfs.forEach(function (p) {
        var sRow = onbStateMap[p.user_id] || null;
        var sObj = (sRow && sRow.state && typeof sRow.state === 'object') ? sRow.state : {};
        var ob = sObj.gp_onboarding;
        if (typeof ob === 'string') { try { ob = JSON.parse(ob); } catch (e) { ob = null; } }
        ob = (ob && typeof ob === 'object') ? ob : {};
        var completed = !!(ob.completedAt || sObj.gp_onboarding_complete || p.onboarding_completed_at);
        var lastActive = (sRow && sRow.updated_at) || p.updated_at || p.created_at || null;
        onbGps.push({
          userId: p.user_id,
          email: String(p.email || '').toLowerCase(),
          name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim(),
          lastActiveMs: lastActive ? new Date(lastActive).getTime() : onbNow,
          lastStep: (ob.currentStep != null ? Number(ob.currentStep) : 0),
          completed: completed
        });
      });
    } else {
      // Local-JSON mode: users + userState keyed by email.
      Object.keys(dbState.users || {}).forEach(function (em) {
        var u = dbState.users[em] || {};
        var stWrap = (dbState.userState && dbState.userState[em]) || {};
        var sObj = stWrap.state || stWrap || {};
        var ob = sObj.gp_onboarding;
        if (typeof ob === 'string') { try { ob = JSON.parse(ob); } catch (e) { ob = null; } }
        ob = (ob && typeof ob === 'object') ? ob : {};
        var completed = !!(ob.completedAt || sObj.gp_onboarding_complete);
        var acct = String(sObj.account_status || 'active').toLowerCase();
        if (acct !== 'active') return;
        var lastActive = stWrap.updatedAt || u.updatedAt || u.createdAt || null;
        onbGps.push({
          userId: u.supabaseUserId || em,
          email: em,
          name: [(u.firstName || ''), (u.lastName || '')].join(' ').trim(),
          lastActiveMs: lastActive ? new Date(lastActive).getTime() : onbNow,
          lastStep: (ob.currentStep != null ? Number(ob.currentStep) : 0),
          completed: completed
        });
      });
      // Exclude staff in local mode via configured admin emails.
      var onbAdminEmails = String(process.env.SUPER_ADMIN_EMAILS || '').toLowerCase() + ',' + String(process.env.ADMIN_EMAILS || '').toLowerCase();
      onbGps = onbGps.filter(function (g) { return onbAdminEmails.indexOf(g.email) === -1; });
    }

    // 2) Existing reminder rows by user_id.
    var onbRows = await listOnboardingReminders();
    var onbByUser = {};
    onbRows.forEach(function (r) { if (r && r.user_id != null) onbByUser[String(r.user_id)] = r; });

    for (var onbG of onbGps) {
      onbScanned++;
      var onbRow = onbByUser[String(onbG.userId)] || null;
      if (onbG.completed) {
        if (onbRow && !onbRow.stopped) {
          await upsertOnboardingReminder(onbG.userId, { email: onbG.email, stopped: true, stopped_reason: 'completed' });
          onbStopped++;
        }
        continue;
      }
      if (!onbRow) {
        // First sight — anchor at their current last-active (backfills existing incomplete GPs).
        await upsertOnboardingReminder(onbG.userId, {
          email: onbG.email, name: onbG.name,
          anchor_at: new Date(onbG.lastActiveMs).toISOString(),
          last_step: onbG.lastStep, steps_sent: []
        });
        onbCreated++;
        continue; // first email considered next pass (>=1h inactivity by then if they stay away)
      }
      if (onbRow.unsubscribed || onbRow.stopped) { onbSkipped++; continue; }
      var onbAnchorMs = onbRow.anchor_at ? new Date(onbRow.anchor_at).getTime() : onbG.lastActiveMs;
      if (onbG.lastActiveMs > onbAnchorMs) {
        // Returned since the anchor — reset the clock and the sequence.
        await upsertOnboardingReminder(onbG.userId, {
          email: onbG.email, name: onbG.name,
          anchor_at: new Date(onbG.lastActiveMs).toISOString(),
          last_step: onbG.lastStep, steps_sent: []
        });
        onbReset++;
        continue;
      }
      var onbInactivity = onbNow - onbAnchorMs;
      var onbSentArr = Array.isArray(onbRow.steps_sent) ? onbRow.steps_sent : [];
      var onbStep = onboardingNudge.nextDueStep({ inactivityMs: onbInactivity, stepsSent: onbSentArr });
      if (onbStep != null) {
        var onbStepsLeft = Math.max(1, 5 - (onbG.lastStep || 0));
        var onbSendRes = await sendOnboardingNudgeEmail(
          { user_id: onbG.userId, email: onbG.email, name: onbG.name, last_step: onbG.lastStep },
          onbStep, onbStepsLeft
        );
        if (onbSendRes && onbSendRes.ok) {
          await upsertOnboardingReminder(onbG.userId, {
            email: onbG.email, last_step: onbG.lastStep,
            steps_sent: onbSentArr.concat([onbStep]),
            last_sent_at: new Date().toISOString()
          });
          onbSent++;
        } else {
          console.error('[OnbNudge] send failed for ' + onbG.email + ':', (onbSendRes && onbSendRes.error) || 'unknown');
          onbSkipped++;
        }
        continue;
      }
      if (onboardingNudge.isExhausted({ inactivityMs: onbInactivity, stepsSent: onbSentArr })) {
        await upsertOnboardingReminder(onbG.userId, { email: onbG.email, stopped: true, stopped_reason: 'exhausted' });
        onbStopped++;
      }
    }

    console.log('[OnbNudge/Cron] scanned ' + onbScanned + ', created ' + onbCreated + ', sent ' + onbSent + ', reset ' + onbReset + ', stopped ' + onbStopped);
    sendJson(res, 200, { ok: true, scanned: onbScanned, created: onbCreated, sent: onbSent, reset: onbReset, stopped: onbStopped, skipped: onbSkipped });
  } catch (onbErr) {
    console.error('[Cron] onboarding-nudge failed:', onbErr);
    sendJson(res, 500, { ok: false, error: onbErr.message });
  }
  return;
}
```

  NOTE for the implementer: verify the actual `user_state` Supabase column names before finalizing (`grep -n "supabaseDbRequest('user_state'" server.js` — check whether the timestamp column is `updated_at` and the JSON column is `state`). Adjust the select/parse accordingly; other call sites show the working pattern. Same for `user_profiles.updated_at`.

- [ ] **Step 4: Register the cron** — `vercel.json`, add to the `crons` array:

```json
{ "path": "/api/cron/onboarding-nudge", "schedule": "0 * * * *" }
```

- [ ] **Step 5: Syntax + tests** — `node --check server.js`, then `npx vitest run tests/onboarding-nudge-cron.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js vercel.json tests/onboarding-nudge-cron.test.js
git commit -m "feat(nudge): hourly onboarding-nudge cron — enumerate, reset-on-return, send, stop"
```

---

### Task 4: Funnel exclusion + `GET /api/ceo/onboarding-incomplete`

**Files:**
- Modify: `server.js` — `/api/ceo/candidates` (~50218), `/api/ceo/pipeline-summary` (~50281), new endpoint next to `/api/ceo/pep-waitlist` (~47991)
- Test: `tests/onboarding-incomplete-endpoint.test.js`

**Interfaces:**
- Consumes: `listOnboardingReminders`, `onboardingNudge.ONBOARDING_STEP_LABELS`, `onboardingNudge.NUDGE_SCHEDULE_MS`, `requireCeoSession`, `requireAtsSession`.
- Produces: candidates/pipeline-summary EXCLUDE onboarding-incomplete GPs from `unassociated`; `GET /api/ceo/onboarding-incomplete` returns `{ ok, count, items: [{ user_id, name, email, country, last_step, last_step_label, last_active_at, inactivity_days, emails_sent, next_email_eta, unsubscribed, stopped, stopped_reason }] }`. `pipeline-summary` response gains `waitlist_onboarding: <count>` (buckets array unchanged in shape).

- [ ] **Step 1: Write the failing test** — `tests/onboarding-incomplete-endpoint.test.js` (ats-endpoints harness, seeded via `scripts/seed-ats-dev.js` exactly as that file does). Inspect the seed script's users: pick/create one seeded candidate WITHOUT `gp_onboarding_complete` (add one to the seeded DB file BEFORE the server boots — the harness seeds the file first, then boots, so file edits between those two steps ARE visible):

```js
// between seeding and server boot, inject an incomplete-onboarding GP:
const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
seeded.users = seeded.users || {};
seeded.users['helen@test.local'] = { firstName: 'Helen', lastName: 'Ncube', email: 'helen@test.local', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
seeded.userState = seeded.userState || {};
seeded.userState['helen@test.local'] = { state: { gp_onboarding: { currentStep: 2 } }, updatedAt: new Date(Date.now() - 2 * 3600000).toISOString() };
fs.writeFileSync(DB_FILE, JSON.stringify(seeded));

describe('onboarding-incomplete waitlist', () => {
  it('lists Helen with her last step', async () => {
    const r = await req('GET', '/api/ceo/onboarding-incomplete', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const j = parse(r.raw);
    expect(j.ok).toBe(true);
    const helen = (j.items || []).find((i) => i.email === 'helen@test.local');
    expect(helen).toBeTruthy();
    expect(helen.last_step).toBe(2);
    expect(helen.last_step_label.length).toBeGreaterThan(0);
  });
  it('candidates endpoint no longer shows her as unassociated', async () => {
    const r = await req('GET', '/api/ceo/candidates', { host: SUPER_HOST, cookie: superCookie() });
    const j = parse(r.raw);
    const helen = (j.candidates || []).find((c) => c.email === 'helen@test.local');
    expect(helen === undefined || helen.pipeline_bucket !== 'unassociated').toBe(true);
  });
  it('pipeline-summary reports waitlist_onboarding and excludes her from unassociated', async () => {
    const r = await req('GET', '/api/ceo/pipeline-summary', { host: SUPER_HOST, cookie: superCookie() });
    const j = parse(r.raw);
    expect(j.waitlist_onboarding).toBeGreaterThanOrEqual(1);
  });
});
```

  Adapt the seeding keys to the REAL shapes in `scripts/seed-ats-dev.js` / `dbState` (read the script first; `atsCandidates` drives the local candidates path — an atsCandidates row for Helen may be needed with `onboarding_pct < 100` in its facts; follow `atsLocalCandidateFacts` to see which fields matter).

- [ ] **Step 2: Run to verify it fails** — 404 on the new endpoint.

- [ ] **Step 3: Implement.**

  (a) **Completion signal for the funnel.** In `/api/ceo/candidates`: the Supabase path already computes `onboarding_completed: facts.onboarding_pct === 100` per row but facts can be stale — additionally fetch `onboarding_completed_at` by adding it to the existing `user_profiles` select (line ~50243), and treat complete = `facts.onboarding_pct === 100 || prof.onboarding_completed_at != null || byUser2[r.user_id]` (having applications implies a real candidate — never waitlist someone with apps). After the `rows.forEach(... pipeline_bucket ...)` line, add:

```js
// Not-yet-onboarded GPs are NOT candidates: they live in Waitlist -> Onboarding
// incomplete (see /api/ceo/onboarding-incomplete), not in the Unassociated bucket.
rows = rows.filter(function (r) {
  if (r.pipeline_bucket !== 'unassociated') return true;
  return !!r.onboarding_completed;
});
```

  ...where `onboarding_completed` on the row is set from the widened test above (Supabase path) and from `facts.onboarding_pct === 100` (local path — `atsLocalCandidateFacts` already yields it; keep `|| (row.apps || []).length > 0`).

  (b) **`/api/ceo/pipeline-summary`:** same signal. Supabase path: fetch `user_profiles` `onboarding_completed_at` for the case user_ids (chunked in.(...) like candidates does) — count a case into `waitlist_onboarding` (and NOT into `unassociated`) when it has no apps AND is not complete. Local path: same via seeded facts. Add `waitlist_onboarding: <count>` to the response JSON.

  (c) **New endpoint** (place right after the `/api/ceo/pep-waitlist` GET):

```js
// GET /api/ceo/onboarding-incomplete — the second Waitlist tab: GPs who have an
// account but never finished the onboarding wizard, with their nudge status.
if (pathname === '/api/ceo/onboarding-incomplete' && req.method === 'GET') {
  const ceoCtxOnbi = requireCeoSession(req, res);
  if (!ceoCtxOnbi) return;
  try {
    const onbiRows = await listOnboardingReminders();
    const onbiByUser = {};
    onbiRows.forEach(function (r) { if (r && r.user_id != null) onbiByUser[String(r.user_id)] = r; });
    // Reuse the cron's enumeration of incomplete GPs, factored or inlined:
    // gather { userId, email, name, country, lastActiveMs, lastStep, completed }
    // exactly as /api/cron/onboarding-nudge does (Supabase + local paths), then:
    const onbiItems = [];
    for (const g of onbiGps) {           // onbiGps = the enumerated incomplete GPs
      if (g.completed) continue;
      const rec = onbiByUser[String(g.userId)] || {};
      const sentArr = Array.isArray(rec.steps_sent) ? rec.steps_sent : [];
      const anchorMs = rec.anchor_at ? new Date(rec.anchor_at).getTime() : g.lastActiveMs;
      const inact = Date.now() - Math.max(anchorMs, 0);
      // next unsent schedule index (NOT nextDueStep — that requires finite inactivity):
      let nextIdx = null;
      if (!rec.unsubscribed && !rec.stopped) {
        for (let k = 0; k < onboardingNudge.NUDGE_SCHEDULE_MS.length; k++) {
          if (sentArr.indexOf(k) === -1) { nextIdx = k; break; }
        }
      }
      const nextEta = (nextIdx == null) ? null : new Date(anchorMs + onboardingNudge.NUDGE_SCHEDULE_MS[nextIdx]).toISOString();
      onbiItems.push({
        user_id: g.userId, name: g.name || '', email: g.email || '', country: g.country || '',
        last_step: g.lastStep, last_step_label: onboardingNudge.ONBOARDING_STEP_LABELS[g.lastStep] || '',
        last_active_at: new Date(g.lastActiveMs).toISOString(),
        inactivity_days: Math.floor(inact / 86400000),
        emails_sent: sentArr.length, next_email_eta: nextEta,
        unsubscribed: !!rec.unsubscribed, stopped: !!rec.stopped, stopped_reason: rec.stopped_reason || null
      });
    }
    onbiItems.sort(function (a, b) { return new Date(b.last_active_at) - new Date(a.last_active_at); });
    sendJson(res, 200, { ok: true, count: onbiItems.length, items: onbiItems });
  } catch (onbiErr) {
    console.error('[CEO] onboarding-incomplete failed:', onbiErr.message);
    sendJson(res, 500, { ok: false, message: onbiErr.message });
  }
  return;
}
```

  **Factor the enumeration**: extract the cron's step-1 GP gathering into a shared `async function enumerateIncompleteOnboardingGps()` (near the other onboarding-nudge helpers, returning the `{ userId, email, name, country, lastActiveMs, lastStep, completed }` list, with `country` from `user_profiles.registration_country`/local user) and call it from BOTH the cron and this endpoint — do not duplicate 60 lines. Update the Task 3 cron code accordingly (this task lands after it; refactor inline).

- [ ] **Step 4: Syntax + tests** — `node --check server.js`; `npx vitest run tests/onboarding-incomplete-endpoint.test.js tests/onboarding-nudge-cron.test.js` (cron test must still pass after the refactor) → PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/onboarding-incomplete-endpoint.test.js
git commit -m "feat(waitlist): exclude not-onboarded GPs from Unassociated + onboarding-incomplete endpoint"
```

---

### Task 5: CEO dashboard — Waitlist card becomes 2 tabs

**Files:**
- Modify: `pages/ceo-dashboard.html` — the PEP waitlist block (~1824–1872), the `renderPepWaitlistSection()` call site (~1669), the `loadPepWaitlist()` call site (~1683), plus the existing `.pep-wl-*` style block (grep `pep-wl-` in the file's `<style>`).

**Interfaces:**
- Consumes: `GET /api/ceo/pep-waitlist` (existing), `GET /api/ceo/onboarding-incomplete` (Task 4), existing `sectionCard`, `esc`, `apiFetch`, `pepShortDate`.
- Produces: one section card `waitlist` with tab buttons `PEP pathway (N)` / `Onboarding incomplete (M)`; PEP tab body/behavior byte-identical to today.

- [ ] **Step 1: Restructure the section.** Replace `renderPepWaitlistSection()` with:

```js
function renderWaitlistSection() {
  var tabs = '<div class="wl-tabs">'
    + '<button class="wl-tab active" data-wl-tab="pep">PEP pathway <span id="wlPepCount"></span></button>'
    + '<button class="wl-tab" data-wl-tab="onb">Onboarding incomplete <span id="wlOnbCount"></span></button>'
    + '</div>';
  var body = tabs
    + '<div id="pepWaitlistBody" class="wl-pane active"><div class="pep-wl-empty">Loading…</div></div>'
    + '<div id="onbWaitlistBody" class="wl-pane"><div class="pep-wl-empty">Loading…</div></div>';
  return sectionCard('waitlist', '&#x23F3;', 'Waitlist', body, true);
}
```

  Keep `renderPepWaitlistBody`, `loadPepWaitlist` (unchanged except: after a successful load, set `document.getElementById('wlPepCount').textContent = '(' + (d.waiting || 0) + ')'`). Update the call sites: `renderPepWaitlistSection()` → `renderWaitlistSection()` (~1669) and add `loadOnbWaitlist();` next to `loadPepWaitlist();` (~1683).

- [ ] **Step 2: New tab body + loader** (below `loadPepWaitlist`):

```js
function renderOnbWaitlistBody(data) {
  if (!data || !data.ok) return '<div class="pep-wl-empty">Could not load the list.</div>';
  var items = data.items || [];
  var summary = '<div class="pep-wl-summary">' + items.length + ' GP' + (items.length === 1 ? '' : 's') + ' started but haven’t finished onboarding</div>';
  if (items.length === 0) return summary + '<div class="pep-wl-empty">Everyone who signed up has finished onboarding.</div>';
  var rows = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var status = it.unsubscribed ? '<span class="onb-wl-badge muted">Unsubscribed</span>'
      : it.stopped ? '<span class="onb-wl-badge muted">' + (it.stopped_reason === 'exhausted' ? 'Reminders ended' : 'Stopped') + '</span>'
      : '<span class="onb-wl-badge">' + it.emails_sent + '/7 emails</span>';
    rows += '<tr>'
      + '<td>' + esc(it.name || '—') + '</td>'
      + '<td>' + esc(it.email || '—') + '</td>'
      + '<td>' + esc(it.country || '—') + '</td>'
      + '<td>Step ' + (Number(it.last_step) + 1) + ' — ' + esc(it.last_step_label || '') + '</td>'
      + '<td>' + it.inactivity_days + 'd</td>'
      + '<td>' + status + '</td>'
      + '</tr>';
  }
  return summary + '<div class="pep-wl-tablewrap"><table class="pep-wl-table"><thead><tr>'
    + '<th>GP</th><th>Email</th><th>Country</th><th>Last step</th><th>Inactive</th><th>Reminders</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}
function loadOnbWaitlist() {
  var body = document.getElementById('onbWaitlistBody');
  if (!body) return;
  apiFetch('/api/ceo/onboarding-incomplete').then(function (d) {
    var b = document.getElementById('onbWaitlistBody');
    if (b) b.innerHTML = renderOnbWaitlistBody(d);
    var c = document.getElementById('wlOnbCount');
    if (c && d && d.ok) c.textContent = '(' + (d.count || 0) + ')';
  }).catch(function () {
    var b = document.getElementById('onbWaitlistBody');
    if (b) b.innerHTML = '<div class="pep-wl-empty">Could not load the list.</div>';
  });
}
```

- [ ] **Step 3: Tab switching + styles.** Event delegation (the dashboard uses document-level delegation for `data-pep-release` — grep it and register alongside):

```js
document.addEventListener('click', function (e) {
  var tab = e.target.closest('[data-wl-tab]');
  if (!tab) return;
  document.querySelectorAll('.wl-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
  var key = tab.getAttribute('data-wl-tab');
  var pep = document.getElementById('pepWaitlistBody');
  var onb = document.getElementById('onbWaitlistBody');
  if (pep) pep.classList.toggle('active', key === 'pep');
  if (onb) onb.classList.toggle('active', key === 'onb');
});
```

  Styles (append next to the `.pep-wl-*` rules, reusing their look):

```css
.wl-tabs { display:flex; gap:8px; margin-bottom:10px; }
.wl-tab { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:var(--text-muted); border-radius:8px; padding:6px 12px; font-size:12px; cursor:pointer; }
.wl-tab.active { background:rgba(99,102,241,0.18); color:var(--text-bright, #fff); border-color:rgba(99,102,241,0.5); }
.wl-pane { display:none; }
.wl-pane.active { display:block; }
.onb-wl-badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; background:rgba(59,130,246,0.15); color:#7fb3ff; }
.onb-wl-badge.muted { background:rgba(255,255,255,0.07); color:var(--text-dim); }
```

- [ ] **Step 4: Verify** — `node --check server.js` untouched here; instead run the full CEO test files to catch dashboard-page regressions if any assert on its HTML: `npx vitest run tests/ceo-endpoints-smoke.test.js`. Then a manual grep sanity: `grep -n "renderWaitlistSection\|loadOnbWaitlist\|renderPepWaitlistSection" pages/ceo-dashboard.html` → the old section function should have exactly 0 remaining call sites.

- [ ] **Step 5: Commit**

```bash
git add pages/ceo-dashboard.html
git commit -m "feat(waitlist): CEO Waitlist card gains PEP / Onboarding-incomplete tabs"
```

---

### Task 6: Onboarding deep-link `?step=N` + cache buster

**Files:**
- Modify: `js/onboarding.js` (init block ~1336–1352), `pages/onboarding.html` (script tag ~1313)

**Interfaces:**
- Consumes: email CTA `/pages/onboarding.html?step=N` (Task 2).
- Produces: onboarding opens on step N (0-4) when the param is valid; otherwise unchanged.

- [ ] **Step 1: Implement.** In the init `.then()` right before `goToStep(currentStep);` add:

```js
// Deep link from the reminder emails: ?step=N opens the step the GP was on
// when they left (their local device may not have the saved progress).
var urlStep = parseInt(new URLSearchParams(window.location.search).get("step"), 10);
if (!isNaN(urlStep) && urlStep >= 0 && urlStep < TOTAL_STEPS) {
  currentStep = urlStep;
}
goToStep(currentStep);
```

  (Replacing the existing bare `goToStep(currentStep);` line.)

- [ ] **Step 2: Cache buster** — in `pages/onboarding.html`: `onboarding.js?v=20260705a` → `onboarding.js?v=20260705b`.

- [ ] **Step 3: Verify** — `node --check js/onboarding.js` (it's an IIFE — node --check validates syntax). Run any existing onboarding tests: `npx vitest run tests/onboarding-qual-tasks.test.js` if present (`ls tests | grep -i onboarding`) → PASS.

- [ ] **Step 4: Commit**

```bash
git add js/onboarding.js pages/onboarding.html
git commit -m "feat(nudge): onboarding honors ?step=N deep link from reminder emails"
```

---

### Task 7: Full verification + ship

**Files:**
- Modify: none new (docs optional: `docs/onboarding-nudge-waitlist.md` one-page ops note — what the cron does, how to pause it, where unsubscribes live).

- [ ] **Step 1: Full test suite** — `npx vitest run` → ALL PASS (baseline on main was ~1411; expect that plus the new files). Fix anything broken before proceeding.
- [ ] **Step 2: `node --check server.js`** → clean.
- [ ] **Step 3: Write the ops note** `docs/onboarding-nudge-waitlist.md` (plain-language: schedule table, reset rule, unsubscribe link mechanics, the two Waitlist tabs, and that the migration must exist in prod).
- [ ] **Step 4: Commit + merge to main + push** (owner instructed direct-to-main):

```bash
git add -A && git commit -m "docs: onboarding nudge ops note"
git push origin worktree-onboarding-nudge-waitlist
# from the MAIN checkout dir (not the worktree):
#   git -C "<repo root>" merge --no-ff worktree-onboarding-nudge-waitlist -m "Onboarding nudge emails + Onboarding-incomplete waitlist tab"
#   git -C "<repo root>" push origin main
```

- [ ] **Step 5: Apply the migration to PROD Supabase** via the established `rpc/exec_sql` path (service key in `.env`, param name `query`, schema-qualify names) — run the SQL from `supabase/migrations/20260705130000_onboarding_reminders.sql`, then verify with a `select count(*) from public.onboarding_reminders` roundtrip.
- [ ] **Step 6: Verify Vercel picked up the deploy** (list deployments; confirm READY) and that `vercel.json` cron count increased. Note: Vercel Hobby/Pro cron limits — if the deploy rejects the 16th cron, consolidate: fold onboarding-nudge into an existing hourly cron path (`process-gmail` runs hourly) ONLY if rejected; otherwise leave standalone.
- [ ] **Step 7: Report** — plain-language summary; flag that the first live email send should be observed in Resend's dashboard.
