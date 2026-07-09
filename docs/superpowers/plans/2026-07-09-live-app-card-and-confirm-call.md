# Live application card + Confirm-your-Zoom-call page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the GP home screen, replace the static "Application Submitted" card with a live status card that tracks the application and taps through to the right page for its stage; and replace the mis-routed "Zoom Assistance Call" card with a clearer-titled card that opens a new in-app "Confirm your Zoom call" page.

**Architecture:** Two features in the existing monolith. Feature 1 is client-side in `pages/index.html` plus a new pure routing helper `js/career-home-card.js` (unit-tested), fed by the existing `GET /api/career/applications`. Feature 2 adds one new GP endpoint (`GET /api/gp/assistance-call`), a title/deep-link override in `GET /api/gp/outstanding`, a new page `pages/confirm-call.html` built from the `secure-interview.html` template, and a shell route registration. No database migration.

**Tech Stack:** Vanilla Node.js (`server.js`, custom router — no Express), vanilla JS/HTML pages, Supabase/PostgREST (prod) with local-JSON fallback, vitest (ESM tests booting the real server against an in-memory PostgREST emulator).

## Global Constraints

- **Base branch:** `worktree-confirm-call-and-live-app-card` off `origin/main` (the live prod code — the plain local checkout is 184 commits behind; ignore it).
- **Never `git add -A`** — the parent checkout is a shared multi-session worktree. Stage only the exact files each task lists. (We are in an isolated worktree, but keep the habit.)
- **Cache-busters:** new/updated script tags use `?v=20260709a` (convention `?v=YYYYMMDD[letter]`).
- **Server data into the DOM:** use `textContent` for any server-derived string (never `innerHTML` with server data), matching `secure-interview.html`.
- **Never fabricate a Zoom link:** only render a "Join Zoom" button when a real `https://…` `zoomJoinUrl` exists; otherwise say it will follow.
- **Own-data only:** GP endpoints resolve the user from the session cookie — never accept a user id/email as a query param.
- **`npm test` (vitest) must stay green.** Run it after each task.
- **Commit after every task** (CLAUDE.md rule 6). Do not push until all tasks pass; final push + draft PR at the end.
- **Plain-English PR/commit summaries** (owner is non-technical) — lead with what changed for the user.

---

## File map

- **Modify** `server.js` — add `GET /api/gp/assistance-call` (Task 1); add `zoom_call` override inside `GET /api/gp/outstanding` (Task 2).
- **Create** `js/career-home-card.js` — pure `deriveCareerHomeCard(app)` routing/label helper (Task 3).
- **Modify** `js/updates-sync.js` — preserve `category` through `sanitizeUpdate` (Task 4).
- **Modify** `pages/index.html` — load the helper, fetch applications, render live card(s), suppress career updates (Task 4).
- **Create** `pages/confirm-call.html` — in-app "Confirm your Zoom call" page (Task 5).
- **Modify** `js/app-shell.js` — register `/pages/confirm-call` route (Task 6).
- **Create** tests: `tests/gp-assistance-call.test.js`, `tests/gp-outstanding-zoom-call.test.js`, `tests/career-home-card.test.js`, `tests/home-live-app-card.test.js`, `tests/confirm-call-page.test.js`.

**Test harness note (Tasks 1 & 2):** Copy the ENTIRE emulator harness verbatim from `tests/gp-outstanding.test.js` lines 13–231 (imports, `buildMatcher`, `readBody`, `startSupabaseEmulator`, `b64url`, `userCookie`, `httpReq`, the `beforeAll` env block, and `afterAll`). Only the `db` fixture and the `describe` blocks differ per task. That harness boots the REAL `server.js` (`createServer()`) with `SUPABASE_URL` pointed at an in-memory PostgREST server, and `userCookie(email, userId)` mints a valid `gp_session`.

---

## Task 1: `GET /api/gp/assistance-call` endpoint

**Files:**
- Modify: `server.js` — insert a new route immediately AFTER the `GET /api/gp/outstanding` route block closes (find it: `if (pathname === '/api/gp/outstanding' && req.method === 'GET') {` then its matching closing `}` before the next `if (pathname === …)`).
- Test: `tests/gp-assistance-call.test.js`

**Interfaces:**
- Produces: `GET /api/gp/assistance-call?stage=<myintealth|amc|ahpra>` → `{ ok:true, call: { id, stage, stageLabel, status, meetingReason, calendlyBookingUrl, scheduledAt, bookedAt, timezone, durationMinutes, zoomJoinUrl, rsoName } | null }`. Consumed by `pages/confirm-call.html` (Task 5).
- Consumes: existing helpers `requireSession`, `getSessionEmail`, `getSessionSupabaseUserId`, `getSupabaseUserIdByEmail`, `isSupabaseDbConfigured`, `supabaseDbRequest`, `sendJson`, and the route-scope `url` object (all already used by the adjacent `/api/gp/outstanding` route).

- [ ] **Step 1: Write the failing test** — `tests/gp-assistance-call.test.js`

Copy the harness from `tests/gp-outstanding.test.js` (lines 13–231) verbatim, then replace the `db` fixture and `describe` blocks with:

```js
const GP = { userId: 'u-ac-1', email: 'ac-gp@gplink-test.local' };
const OTHER = { userId: 'u-ac-2', email: 'ac-other@gplink-test.local' };
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Doctor' },
    { user_id: OTHER.userId, email: OTHER.email, first_name: 'Other', last_name: 'Doctor' }
  ],
  scheduled_calls: [
    // GP's INVITED MyIntealth consultation call (the one to confirm).
    { id: 'sc-1', user_id: GP.userId, meeting_kind: 'consultation', stage: 'myintealth',
      status: 'invited', meeting_reason: 'to sort out your MyIntealth registration',
      calendly_booking_url: 'https://calendly.com/hello-mygplink/30min?utm_content=call_abc',
      scheduled_at: null, booked_at: null, timezone: null, duration_minutes: 30,
      zoom_join_url: null, assigned_rso_name: 'Priya (GP Link)', created_at: NOW },
    // GP's BOOKED AMC consultation call — older; only returned when ?stage=amc.
    { id: 'sc-2', user_id: GP.userId, meeting_kind: 'consultation', stage: 'amc',
      status: 'booked', meeting_reason: null,
      calendly_booking_url: 'https://calendly.com/x?utm_content=call_def',
      scheduled_at: NOW, booked_at: NOW, timezone: 'Australia/Sydney', duration_minutes: 30,
      zoom_join_url: 'https://zoom.us/j/999', assigned_rso_name: null, created_at: '2000-01-01T00:00:00.000Z' },
    // An INTERVIEW (not a consultation) — must never be returned here.
    { id: 'sc-int', user_id: GP.userId, meeting_kind: 'interview', stage: null,
      status: 'invited', created_at: NOW },
    // A CANCELLED consultation — must never be returned.
    { id: 'sc-cx', user_id: GP.userId, meeting_kind: 'consultation', stage: 'ahpra',
      status: 'cancelled', created_at: NOW },
    // OTHER GP's consultation — must never leak.
    { id: 'sc-other', user_id: OTHER.userId, meeting_kind: 'consultation', stage: 'myintealth',
      status: 'invited', created_at: NOW }
  ],
  user_state: [], runtime_kv: []
};

describe('GET /api/gp/assistance-call', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call');
    expect([401, 403]).toContain(r.status);
  });

  it('returns the most recent non-cancelled consultation call by default', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.call).toBeTruthy();
    expect(r.body.call.id).toBe('sc-1');                 // newest created_at
    expect(r.body.call.stage).toBe('myintealth');
    expect(r.body.call.stageLabel).toBe('MyIntealth');
    expect(r.body.call.status).toBe('invited');
    expect(r.body.call.meetingReason).toContain('MyIntealth registration');
    expect(r.body.call.calendlyBookingUrl).toContain('calendly.com');
    expect(r.body.call.zoomJoinUrl).toBe(null);
    expect(r.body.call.rsoName).toBe('Priya (GP Link)');
  });

  it('honours ?stage and returns booked details incl. zoom link', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call?stage=amc', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.body.call.id).toBe('sc-2');
    expect(r.body.call.stageLabel).toBe('AMC');
    expect(r.body.call.status).toBe('booked');
    expect(r.body.call.zoomJoinUrl).toBe('https://zoom.us/j/999');
    expect(r.body.call.timezone).toBe('Australia/Sydney');
  });

  it('never returns interviews, cancelled calls, or another GP\'s call', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call?stage=ahpra', { cookie: userCookie(GP.email, GP.userId) });
    // ahpra consultation is cancelled -> no ahpra match -> falls back to newest non-cancelled (sc-1)
    expect(r.body.call.id).toBe('sc-1');

    const other = await httpReq('GET', '/api/gp/assistance-call', { cookie: userCookie(OTHER.email, OTHER.userId) });
    expect(other.body.call.id).toBe('sc-other');
  });

  it('returns call:null when the GP has no consultation call', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call', { cookie: userCookie('nobody@gplink-test.local', 'u-none') });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.call).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/gp-assistance-call.test.js`
Expected: FAIL — the endpoint 404s / returns HTML, so `r.body.call` is undefined (or route falls through to static and returns non-200).

- [ ] **Step 3: Implement the endpoint** — in `server.js`, immediately after the `/api/gp/outstanding` route's closing `}`:

```js
  // GET /api/gp/assistance-call — the CURRENT GP's MyIntealth/AMC/AHPRA Zoom
  // assistance call (scheduled_calls, meeting_kind='consultation'). Powers the
  // in-app "Confirm your Zoom call" page (pages/confirm-call.html). Own-data
  // only — the user is resolved from the session, never a query param.
  if (pathname === '/api/gp/assistance-call' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!isSupabaseDbConfigured()) { sendJson(res, 200, { ok: true, call: null }); return; }
    const acEmail = getSessionEmail(session);
    const acUserId = getSessionSupabaseUserId(session) || (acEmail ? await getSupabaseUserIdByEmail(acEmail) : null);
    if (!acUserId) { sendJson(res, 200, { ok: true, call: null }); return; }
    const AC_STAGE_LABELS = { myintealth: 'MyIntealth', myinthealth: 'MyIntealth', amc: 'AMC', ahpra: 'AHPRA' };
    const acStageParam = String(url.searchParams.get('stage') || '').trim().toLowerCase();
    try {
      const acRes = await supabaseDbRequest('scheduled_calls',
        'select=id,stage,status,meeting_reason,calendly_booking_url,scheduled_at,booked_at,timezone,duration_minutes,zoom_join_url,assigned_rso_name,created_at' +
        '&user_id=eq.' + encodeURIComponent(acUserId) +
        '&meeting_kind=eq.consultation&status=neq.cancelled&order=created_at.desc&limit=20');
      const acRows = (acRes.ok && Array.isArray(acRes.data)) ? acRes.data : [];
      if (!acRows.length) { sendJson(res, 200, { ok: true, call: null }); return; }
      let acRow = null;
      if (acStageParam) acRow = acRows.find((r) => String(r.stage || '').toLowerCase() === acStageParam) || null;
      if (!acRow) acRow = acRows[0];
      const acStage = String(acRow.stage || '').toLowerCase();
      sendJson(res, 200, { ok: true, call: {
        id: acRow.id,
        stage: acStage,
        stageLabel: AC_STAGE_LABELS[acStage] || (acStage ? acStage.toUpperCase() : ''),
        status: acRow.status || 'invited',
        meetingReason: acRow.meeting_reason || null,
        calendlyBookingUrl: acRow.calendly_booking_url || null,
        scheduledAt: acRow.scheduled_at || null,
        bookedAt: acRow.booked_at || null,
        timezone: acRow.timezone || null,
        durationMinutes: acRow.duration_minutes || 30,
        zoomJoinUrl: acRow.zoom_join_url || null,
        rsoName: acRow.assigned_rso_name || null
      } });
    } catch (e) {
      console.error('[GPAssistanceCall] failed:', e.message);
      sendJson(res, 200, { ok: true, call: null });
    }
    return;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/gp-assistance-call.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Syntax-check and commit**

```bash
node --check server.js
git add server.js tests/gp-assistance-call.test.js
git commit -m "feat(gp): GET /api/gp/assistance-call returns the GP's Zoom assistance call"
```

---

## Task 2: `zoom_call` override in `GET /api/gp/outstanding`

**Files:**
- Modify: `server.js` — inside `GET /api/gp/outstanding`, the generic "Anything else explicitly waiting on the GP" branch (find the comment `// Anything else explicitly waiting on the GP`, immediately after `if (t.status !== 'waiting_on_gp' || m.s80) return;`).
- Test: `tests/gp-outstanding-zoom-call.test.js`

**Interfaces:**
- Produces: for a `registration_tasks` row with `task_type='zoom_call'`, `status='waiting_on_gp'`, the outstanding item now has `title:'Confirm your Zoom call — <StageLabel>'` and `deepLink:'/pages/confirm-call.html?stage=<stage>'`. All other waiting tasks unchanged.
- Consumes: the existing `oaTasks.forEach` loop variables `t` (task row, includes `task_type`, `related_stage`, `title`, `priority`, `created_at`) and `items` array.

- [ ] **Step 1: Write the failing test** — `tests/gp-outstanding-zoom-call.test.js`

Copy the harness from `tests/gp-outstanding.test.js` (lines 13–231) verbatim, then use this fixture + describe:

```js
const GP = { userId: 'u-zc-1', email: 'zc-gp@gplink-test.local' };
const NOW = new Date().toISOString();

const db = {
  user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Doctor', registration_country: 'uk' }],
  registration_cases: [{ id: 'case-zc-1', user_id: GP.userId, status: 'active' }],
  registration_tasks: [
    // Unbooked zoom_call handed to the GP — must surface with the NEW title + deep link.
    { id: 't-zoom', case_id: 'case-zc-1', task_type: 'zoom_call', status: 'waiting_on_gp',
      title: 'Zoom Assistance Call — MyIntealth', priority: 'normal', related_stage: 'myintealth', created_at: NOW, metadata: {} },
    // A booked zoom_call becomes status='waiting' — must NOT surface as outstanding.
    { id: 't-zoom-booked', case_id: 'case-zc-1', task_type: 'zoom_call', status: 'waiting',
      title: 'Zoom Assistance Call — AMC', priority: 'normal', related_stage: 'amc', created_at: NOW, metadata: {} },
    // A non-zoom waiting task — keeps its stage-page deep link (unchanged behaviour).
    { id: 't-visa', case_id: 'case-zc-1', task_type: 'stage_task', status: 'waiting_on_gp',
      title: 'Confirm your visa appointment', priority: 'normal', related_stage: 'visa', created_at: NOW, metadata: {} }
  ],
  user_documents: [], user_nudges: [], user_state: [], runtime_kv: []
};

describe('GET /api/gp/outstanding — zoom_call card', () => {
  it('rewrites the zoom_call task to the confirm-call page with a clearer title', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.status).toBe(200);
    const zoom = r.body.items.find((i) => i.id === 'task-t-zoom');
    expect(zoom).toBeTruthy();
    expect(zoom.title).toBe('Confirm your Zoom call — MyIntealth');
    expect(zoom.deepLink).toBe('/pages/confirm-call.html?stage=myintealth');
    expect(zoom.stage).toBe('myintealth');
  });

  it('does not surface a booked zoom_call (status=waiting)', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.body.items.map((i) => i.id)).not.toContain('task-t-zoom-booked');
  });

  it('leaves non-zoom waiting tasks pointing at their stage page', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    const visa = r.body.items.find((i) => i.id === 'task-t-visa');
    expect(visa.deepLink).toBe('/pages/visa.html');
    expect(visa.title).toBe('Confirm your visa appointment');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/gp-outstanding-zoom-call.test.js`
Expected: FAIL — the zoom item currently has `title:'Zoom Assistance Call — MyIntealth'` and `deepLink:'/pages/myinthealth.html'`.

- [ ] **Step 3: Implement the override** — in `server.js`, replace the generic push branch. Change FROM:

```js
          // Anything else explicitly waiting on the GP (calls to rebook, stage
          // tasks handed to the GP, …) — deep link to its stage page.
          if (t.status !== 'waiting_on_gp' || m.s80) return;
          items.push({
            id: 'task-' + t.id,
            kind: 'registration_task',
            title: t.title || 'A task needs your attention',
            description: '',
            stage: t.related_stage || '',
            deepLink: oaStageLink(t.related_stage),
            createdAt: t.created_at || null,
            priority: (t.priority === 'high' || t.priority === 'urgent') ? 'high' : 'normal'
          });
```

TO (insert the `zoom_call` branch before the generic push):

```js
          // Anything else explicitly waiting on the GP (calls to rebook, stage
          // tasks handed to the GP, …) — deep link to its stage page.
          if (t.status !== 'waiting_on_gp' || m.s80) return;
          // Zoom assistance calls get an in-app confirm page + a clearer title
          // (the raw title 'Zoom Assistance Call — <Stage>' opened the stage's
          // registration page, which bounced to the registration intro).
          if (t.task_type === 'zoom_call') {
            const zcStage = String(t.related_stage || '').toLowerCase();
            const zcLabel = { myintealth: 'MyIntealth', myinthealth: 'MyIntealth', amc: 'AMC', ahpra: 'AHPRA' }[zcStage] || 'GP Link';
            items.push({
              id: 'task-' + t.id,
              kind: 'registration_task',
              title: 'Confirm your Zoom call — ' + zcLabel,
              description: '',
              stage: t.related_stage || '',
              deepLink: '/pages/confirm-call.html?stage=' + encodeURIComponent(zcStage),
              createdAt: t.created_at || null,
              priority: (t.priority === 'high' || t.priority === 'urgent') ? 'high' : 'normal'
            });
            return;
          }
          items.push({
            id: 'task-' + t.id,
            kind: 'registration_task',
            title: t.title || 'A task needs your attention',
            description: '',
            stage: t.related_stage || '',
            deepLink: oaStageLink(t.related_stage),
            createdAt: t.created_at || null,
            priority: (t.priority === 'high' || t.priority === 'urgent') ? 'high' : 'normal'
          });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/gp-outstanding-zoom-call.test.js tests/gp-outstanding.test.js`
Expected: PASS — new file green AND the existing `gp-outstanding.test.js` still green (regression guard).

- [ ] **Step 5: Syntax-check and commit**

```bash
node --check server.js
git add server.js tests/gp-outstanding-zoom-call.test.js
git commit -m "feat(gp): outstanding zoom_call card -> confirm-call page with clearer title"
```

---

## Task 3: `js/career-home-card.js` — pure routing/label helper

**Files:**
- Create: `js/career-home-card.js`
- Test: `tests/career-home-card.test.js`

**Interfaces:**
- Produces: global `window.deriveCareerHomeCard` (browser) AND `module.exports` (Node). Signature `deriveCareerHomeCard(app) -> null | { title, badgeClass, badgeLabel, iconType, href, ts }`.
  - `app` fields consumed (from `GET /api/career/applications`): `id` (string), `status` (string), `offerPending` (bool), `role` (`{ id }` or absent), `statusLabel` (string, optional), `statusTone` (string, optional), `appliedAt` (ISO string, optional).
  - `badgeClass`/`iconType` are one of the existing index.html card classes: `'success' | 'info'` (so no new CSS is needed). `href` is a bare shell route (e.g. `application-detail?id=…&role=…`, `offer-review?applicationId=…`, `career#secured`).
- Consumed by `pages/index.html` (Task 4).

- [ ] **Step 1: Write the failing test** — `tests/career-home-card.test.js`

```js
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const derive = require(path.join(__dirname, '..', 'js', 'career-home-card.js'));

const base = { id: 'app-1', role: { id: 'internal_ats:ats_9' }, appliedAt: '2026-07-01T00:00:00.000Z' };

describe('deriveCareerHomeCard', () => {
  it('returns null for missing app or closed applications', () => {
    expect(derive(null)).toBe(null);
    expect(derive({ ...base, status: 'withdrawn' })).toBe(null);
    expect(derive({ ...base, status: 'not_proceeding' })).toBe(null);
    expect(derive({ ...base, status: 'rejected' })).toBe(null);
  });

  it('applied/submitted/reviewing -> progress page, info tone', () => {
    const c = derive({ ...base, status: 'submitted' });
    expect(c.href).toBe('application-detail?id=app-1&role=internal_ats%3Aats_9');
    expect(c.badgeClass).toBe('info');
    expect(c.title).toBeTruthy();
  });

  it('uses server statusLabel for the default stage when present', () => {
    const c = derive({ ...base, status: 'reviewing', statusLabel: 'The practice is reviewing your profile' });
    expect(c.title).toBe('The practice is reviewing your profile');
  });

  it('interview stage -> application-detail (inline confirm-time), interview label', () => {
    const c = derive({ ...base, status: 'interview' });
    expect(c.href).toBe('application-detail?id=app-1&role=internal_ats%3Aats_9');
    expect(c.title).toContain('Interview');
    expect(c.badgeLabel).toBe('Interview');
  });

  it('offerPending -> offer-review page regardless of raw status', () => {
    const c = derive({ ...base, status: 'reviewing', offerPending: true });
    expect(c.href).toBe('offer-review?applicationId=app-1');
    expect(c.title).toContain('Offer');
    expect(c.badgeClass).toBe('success');
  });

  it('secured statuses -> My Practice (career#secured), success tone', () => {
    for (const s of ['hired', 'secured', 'placed', 'placement_secured', 'offer_accepted', 'contract_signed']) {
      const c = derive({ ...base, status: s });
      expect(c.href).toBe('career#secured');
      expect(c.badgeClass).toBe('success');
      expect(c.badgeLabel).toBe('Secured');
    }
  });

  it('statusTone=secured or the placement-by-association synthetic entry -> secured', () => {
    expect(derive({ ...base, status: 'x', statusTone: 'secured' }).href).toBe('career#secured');
    expect(derive({ id: 'placement-by-association', status: 'secured' }).href).toBe('career#secured');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/career-home-card.test.js`
Expected: FAIL — `Cannot find module '.../js/career-home-card.js'`.

- [ ] **Step 3: Implement the helper** — `js/career-home-card.js`

```js
// Pure helper: given one application object from GET /api/career/applications,
// return the home-screen "live application" card (title, badge tone, and the
// stage-correct deep link) — or null when there is nothing to show.
// UMD: usable both in the browser (window.deriveCareerHomeCard) and in vitest
// (require/import). No DOM, no browser globals — keep it pure.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.deriveCareerHomeCard = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  var SECURED = ['hired', 'secured', 'placed', 'placement_secured', 'offer_accepted', 'contract_signed'];
  var CLOSED = ['withdrawn', 'not_proceeding', 'rejected', 'offer_declined'];
  var INTERVIEW = ['interview', 'interview_scheduled', 'interview_confirmed', 'shortlisted'];

  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function card(title, badgeClass, badgeLabel, href, ts) {
    return { title: title, badgeClass: badgeClass, badgeLabel: badgeLabel, iconType: badgeClass, href: href, ts: ts || '' };
  }

  return function deriveCareerHomeCard(app) {
    if (!app || !app.id) return null;
    var status = normalize(app.status);
    var roleId = app.role && app.role.id ? app.role.id : '';
    var ts = app.appliedAt || '';
    if (CLOSED.indexOf(status) !== -1) return null;

    // 1. Secured placement -> "My Practice".
    if (SECURED.indexOf(status) !== -1 || app.statusTone === 'secured' || app.id === 'placement-by-association') {
      return card('Practice secured', 'success', 'Secured', 'career#secured', ts);
    }
    // 2. Reviewable in-app offer -> offer page.
    if (app.offerPending === true) {
      return card('Offer ready 🎉', 'success', 'Offer', 'offer-review?applicationId=' + enc(app.id), ts);
    }
    if (status === 'finalising_placement') {
      return card('Offer accepted — finalising placement', 'success', 'Offer',
        'application-detail?id=' + enc(app.id) + '&role=' + enc(roleId), ts);
    }
    // 3. Interview stage -> application-detail (shows the inline confirm-time control).
    if (INTERVIEW.indexOf(status) !== -1) {
      return card('Interview offered — confirm your time', 'info', 'Interview',
        'application-detail?id=' + enc(app.id) + '&role=' + enc(roleId), ts);
    }
    // 4. Default (applied / submitted / reviewing / under_review) -> progress page.
    var title = (app.statusLabel && String(app.statusLabel).trim()) ? String(app.statusLabel).trim() : 'Application under review';
    return card(title, 'info', 'In review',
      'application-detail?id=' + enc(app.id) + '&role=' + enc(roleId), ts);
  };
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/career-home-card.test.js`
Expected: PASS.

- [ ] **Step 5: Syntax-check and commit**

```bash
node --check js/career-home-card.js
git add js/career-home-card.js tests/career-home-card.test.js
git commit -m "feat(home): pure deriveCareerHomeCard helper for the live application card"
```

---

## Task 4: Wire the live application card into `pages/index.html`

**Files:**
- Modify: `js/updates-sync.js` — preserve `category` in `sanitizeUpdate`.
- Modify: `pages/index.html` — load the helper; add `loadLiveApplicationCards()`; make `renderUpdatesFeed()` suppress career updates and prepend live cards.
- Test: `tests/home-live-app-card.test.js` (static-source markers).

**Interfaces:**
- Consumes: `window.deriveCareerHomeCard` (Task 3), `GET /api/career/applications` (existing → `{ ok:true, applications:[…] }`), existing `renderUpdatesFeed`, `formatUpdateTimestamp`, `#gp-updates-list`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test** — `tests/home-live-app-card.test.js`

```js
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'pages', 'index.html'), 'utf8');
const updatesSync = fs.readFileSync(path.join(ROOT, 'js', 'updates-sync.js'), 'utf8');

describe('home live application card wiring', () => {
  it('loads the deriveCareerHomeCard helper', () => {
    expect(indexHtml).toContain('/js/career-home-card.js');
  });
  it('fetches the live applications list', () => {
    expect(indexHtml).toContain('/api/career/applications');
    expect(indexHtml).toContain('deriveCareerHomeCard');
  });
  it('suppresses career-category updates so the live card replaces them', () => {
    expect(indexHtml).toContain('liveAppsLoaded');
    expect(indexHtml).toMatch(/category[^\n]*===[^\n]*["']career["']/);
  });
  it('updates-sync preserves the category field through sanitizeUpdate', () => {
    expect(updatesSync).toMatch(/item\.category/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/home-live-app-card.test.js`
Expected: FAIL — none of these markers exist yet.

- [ ] **Step 3a: Preserve `category` in `js/updates-sync.js`** — in `sanitizeUpdate`, before `return out;`, add:

```js
    if (typeof item.category === "string" && item.category) out.category = item.category;
```

- [ ] **Step 3b: Load the helper script in `pages/index.html`** — add this line immediately after the `updates-sync.js` script tag (line ~13, `<script src="../js/updates-sync.js?v=...">`):

```html
  <script src="/js/career-home-card.js?v=20260709a" defer></script>
```

- [ ] **Step 3c: Suppress career updates + prepend live cards in `renderUpdatesFeed()`** (`pages/index.html`).

First, at the top of the big inline `<script>` that defines `renderUpdatesFeed` (just before `function renderUpdatesFeed()`), add module-scoped state:

```js
    var liveAppCards = [];
    var liveAppsLoaded = false;
```

Then inside `renderUpdatesFeed()`, right after `baseUpdates` is computed, drop career updates once the live cards have loaded:

```js
      const baseUpdatesFiltered = liveAppsLoaded
        ? baseUpdates.filter((u) => {
            const cat = u && typeof u.category === "string" ? u.category : "";
            const ttl = u && typeof u.title === "string" ? u.title : "";
            // Career notifications (all stamped category:'career' server-side) are
            // superseded by the single live application card. Legacy cached rows
            // that predate the category field are caught by the known titles.
            if (cat === "career") return false;
            if (["Application Submitted", "Profile Submitted to Practice", "Interview Scheduled", "Interview Cancelled"].indexOf(ttl) !== -1) return false;
            return true;
          })
        : baseUpdates;
```

Change the existing `const updates = [...baseUpdates, ...getPreparedDocReviewUpdates()]...` to spread `baseUpdatesFiltered` instead of `baseUpdates`.

Then, right after `listEl.innerHTML = "";` and BEFORE the `if (!displayItems.length)` empty-state check, prepend the live cards:

```js
      liveAppCards.forEach((c) => {
        const row = document.createElement("a");
        row.href = c.href;
        row.className = "update-item";
        row.innerHTML =
          '<div class="update-icon ' + c.iconType + '">' + (iconSvgs[c.iconType] || iconSvgs.info) + '</div>' +
          '<div class="update-content"><p class="update-title"></p><div class="update-ts"></div></div>' +
          '<span class="update-badge ' + c.badgeClass + '"></span>';
        row.querySelector(".update-title").textContent = c.title;         // textContent — never innerHTML with server data
        row.querySelector(".update-ts").textContent = formatUpdateTimestamp(c.ts || "");
        row.querySelector(".update-badge").textContent = c.badgeLabel;
        listEl.appendChild(row);
      });
```

> NOTE: `iconSvgs` and `typeLabel` are declared LOWER in the function than `listEl.innerHTML = ""`. Move the `const iconSvgs = {…}` declaration ABOVE the `listEl.innerHTML = ""` line (cut it from its current position and paste it just before the empty-state check) so the prepend loop can use it. The empty-state early-return must also account for live cards: change `if (!displayItems.length) {` to `if (!displayItems.length && !liveAppCards.length) {`.

Finally, add the loader as a new IIFE near `loadOutstandingActions` (after it), and call `renderUpdatesFeed()` once applications resolve:

```js
    (function loadLiveApplicationCards() {
      if (typeof window.deriveCareerHomeCard !== "function") return;
      fetch("/api/career/applications", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d || d.ok !== true || !Array.isArray(d.applications)) return; // leave the feed untouched on failure
          liveAppsLoaded = true;
          liveAppCards = d.applications
            .map((a) => window.deriveCareerHomeCard(a))
            .filter(Boolean)
            .slice(0, 3);
          if (typeof renderUpdatesFeed === "function") renderUpdatesFeed();
        })
        .catch(() => { /* never break the dashboard */ });
    })();
```

Ensure `liveAppCards`, `liveAppsLoaded`, `renderUpdatesFeed`, `iconSvgs`, and `formatUpdateTimestamp` are all in the SAME `<script>` scope. If `loadOutstandingActions` lives in a different trailing `<script>` block than `renderUpdatesFeed`, place `loadLiveApplicationCards` in the SAME block as `renderUpdatesFeed` (so it can call it and share `liveAppCards`).

- [ ] **Step 4: Run tests + syntax sanity**

Run: `npx vitest run tests/home-live-app-card.test.js`
Expected: PASS.
Also confirm no other index/updates tests broke: `npx vitest run tests/gp-outstanding.test.js tests/alerts-panel.test.js tests/alert-sync.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pages/index.html js/updates-sync.js tests/home-live-app-card.test.js
git commit -m "feat(home): live application card replaces static 'Application Submitted' + routes by stage"
```

---

## Task 5: `pages/confirm-call.html` — Confirm-your-Zoom-call page

**Files:**
- Create: `pages/confirm-call.html`
- Test: `tests/confirm-call-page.test.js`

**Interfaces:**
- Consumes: `GET /api/gp/assistance-call?stage=<stage>` (Task 1), reads `?stage=` from the URL, shell scripts (`nav-shell-bridge.js`, `auth-guard.js`, `native-bridge.js`), `css/gp-tokens.css`.

- [ ] **Step 1: Write the failing test** — `tests/confirm-call-page.test.js`

```js
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const p = path.join(ROOT, 'pages', 'confirm-call.html');

describe('pages/confirm-call.html', () => {
  const html = fs.readFileSync(p, 'utf8');
  it('is auth-gated + shell-aware (mirrors secure-interview head)', () => {
    expect(html).toContain('/js/auth-guard.js');
    expect(html).toContain('/js/nav-shell-bridge.js');
    expect(html).toContain('/css/gp-tokens.css');
  });
  it('reads the stage param and calls the assistance-call endpoint', () => {
    expect(html).toMatch(/params\.get\(['"]stage['"]\)/);
    expect(html).toContain('/api/gp/assistance-call');
  });
  it('opens Calendly in a new tab (CSP blocks embedding) and never fabricates a Zoom link', () => {
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toMatch(/indexOf\(['"]https:['"]\)|startsWith\(['"]https:/);
  });
  it('shows the confirm title', () => {
    expect(html).toContain('Confirm your Zoom call');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/confirm-call-page.test.js`
Expected: FAIL — `ENOENT` (file does not exist).

- [ ] **Step 3: Create `pages/confirm-call.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Confirm your Zoom call</title>
  <script src="../js/native-bridge.js?v=20260707a"></script>
  <script>try{if(window.self!==window.top){var d=document.documentElement;d.classList.add('gp-shell-embedded');var s=document.createElement('style');s.id='gp-embed-early';s.textContent='.gp-shell-embedded .desktop-topbar,.gp-shell-embedded .topbar,.gp-shell-embedded .mobile-nav,.gp-shell-embedded .nav-menu,.gp-shell-embedded .brand-logo,.gp-shell-embedded .app-shell-desktop,.gp-shell-embedded #appShellDesktop{display:none!important}';(document.head||d).appendChild(s)}}catch(e){document.documentElement.classList.add('gp-shell-embedded')}</script>
  <script src="/js/nav-shell-bridge.js?v=20260709a" defer></script>
  <script src="../js/auth-guard.js?v=20260706a" defer></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Source+Serif+4:wght@600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/gp-tokens.css?v=20260612" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--gp-canvas); color: var(--gp-text); font-family: var(--gp-font-body, "DM Sans", system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 24px 20px calc(40px + var(--gp-shell-bottom-clearance, 0px)); }
    .hidden { display: none !important; }
    .card { background: var(--gp-surface); border: 1px solid var(--gp-border); border-radius: var(--gp-r-lg, 18px); box-shadow: var(--gp-shadow-sm); padding: 22px; }
    h1 { font-family: var(--gp-font-display, "Source Serif 4", serif); font-size: var(--gp-fs-xl, 1.5rem); color: var(--gp-ink); margin: 0 0 6px; }
    .sub { color: var(--gp-muted); font-size: var(--gp-fs-sm, .95rem); margin: 0 0 18px; line-height: 1.5; }
    .row { display: flex; gap: 10px; align-items: baseline; margin: 10px 0; font-size: .95rem; }
    .row .k { color: var(--gp-muted); min-width: 86px; }
    .row .v { color: var(--gp-ink); font-weight: 600; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 14px 18px; border-radius: 14px; border: 0; background: var(--gp-blue, #2563eb); color: #fff; font-weight: 700; font-size: 1rem; text-decoration: none; cursor: pointer; margin-top: 18px; }
    .btn.secondary { background: transparent; color: var(--gp-blue, #2563eb); border: 1px solid var(--gp-border); margin-top: 10px; }
    .muted-note { color: var(--gp-muted); font-size: .85rem; margin-top: 14px; line-height: 1.5; }
    .spinner { width: 30px; height: 30px; border: 3px solid var(--gp-border); border-top-color: var(--gp-blue, #2563eb); border-radius: 50%; animation: spin .8s linear infinite; margin: 30px auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .icon { font-size: 34px; text-align: center; margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="loadingState"><div class="spinner"></div></div>

    <div id="inviteState" class="hidden">
      <div class="card">
        <h1 id="inviteTitle">Confirm your Zoom call</h1>
        <p class="sub" id="inviteReason"></p>
        <div class="row"><span class="k">With</span><span class="v" id="inviteWith">the GP Link team</span></div>
        <div class="row"><span class="k">Length</span><span class="v" id="inviteLen">30 minutes</span></div>
        <a id="chooseTimeBtn" class="btn" target="_blank" rel="noopener">Choose a time</a>
        <button id="refreshBtn" class="btn secondary" type="button">I've booked — refresh</button>
        <p class="muted-note">Picking a time opens our booking page in a new tab. Once you've chosen, come back here — this page updates automatically and shows your Zoom link.</p>
      </div>
    </div>

    <div id="bookedState" class="hidden">
      <div class="card">
        <div class="icon">✅</div>
        <h1>Your Zoom call is confirmed</h1>
        <p class="sub" id="bookedReason"></p>
        <div class="row"><span class="k">When</span><span class="v" id="bookedWhen"></span></div>
        <div class="row"><span class="k">Length</span><span class="v" id="bookedLen">30 minutes</span></div>
        <a id="joinZoomBtn" class="btn hidden" target="_blank" rel="noopener">Join Zoom</a>
        <p id="zoomPending" class="muted-note hidden">Your Zoom link will be emailed to you and will appear here shortly.</p>
      </div>
    </div>

    <div id="emptyState" class="hidden">
      <div class="card">
        <h1>No Zoom call scheduled</h1>
        <p class="sub">There's no Zoom assistance call waiting for you right now. If you were expecting one, please check your email or contact the GP Link team.</p>
        <a class="btn" href="/pages/index.html">Back to home</a>
      </div>
    </div>

    <div id="errorState" class="hidden">
      <div class="card">
        <h1>Something went wrong</h1>
        <p class="sub" id="errorMsg">We couldn't load your call just now. Please try again in a moment.</p>
        <a class="btn" href="/pages/index.html">Back to home</a>
      </div>
    </div>
  </div>

  <script>
    (function () {
      var params = new URLSearchParams(window.location.search);
      var stage = (params.get('stage') || '').trim().toLowerCase();
      var pollTimer = null, polls = 0;

      function showOnly(id) {
        ['loadingState', 'inviteState', 'bookedState', 'emptyState', 'errorState'].forEach(function (s) {
          var el = document.getElementById(s);
          if (el) el.classList.toggle('hidden', s !== id);
        });
      }
      function fmtWhen(iso, tz) {
        if (!iso) return '';
        try {
          var opts = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
          if (tz) opts.timeZone = tz;
          return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso)) + (tz ? ' (' + tz + ')' : '');
        } catch (e) { return iso; }
      }
      function renderInvite(call) {
        document.getElementById('inviteTitle').textContent = 'Confirm your Zoom call' + (call.stageLabel ? ' — ' + call.stageLabel : '');
        var reason = call.meetingReason && call.meetingReason.trim()
          ? call.meetingReason.trim()
          : ('to help you with your ' + (call.stageLabel || 'registration') + ' registration');
        document.getElementById('inviteReason').textContent = 'A quick video call ' + reason + '.';
        if (call.rsoName) document.getElementById('inviteWith').textContent = call.rsoName;
        document.getElementById('inviteLen').textContent = (call.durationMinutes || 30) + ' minutes';
        var btn = document.getElementById('chooseTimeBtn');
        if (call.calendlyBookingUrl && call.calendlyBookingUrl.indexOf('https:') === 0) {
          btn.href = call.calendlyBookingUrl;
          btn.classList.remove('hidden');
        } else {
          btn.classList.add('hidden');
        }
        showOnly('inviteState');
      }
      function renderBooked(call) {
        var reason = call.meetingReason && call.meetingReason.trim() ? call.meetingReason.trim() : '';
        document.getElementById('bookedReason').textContent = reason ? ('A video call ' + reason + '.') : '';
        document.getElementById('bookedWhen').textContent = fmtWhen(call.scheduledAt, call.timezone) || 'Time to be confirmed';
        document.getElementById('bookedLen').textContent = (call.durationMinutes || 30) + ' minutes';
        var zbtn = document.getElementById('joinZoomBtn');
        var pending = document.getElementById('zoomPending');
        if (call.zoomJoinUrl && call.zoomJoinUrl.indexOf('https:') === 0) {   // never fabricate a link
          zbtn.href = call.zoomJoinUrl;
          zbtn.classList.remove('hidden');
          pending.classList.add('hidden');
        } else {
          zbtn.classList.add('hidden');
          pending.classList.remove('hidden');
        }
        showOnly('bookedState');
      }
      function apply(call) {
        if (!call) { showOnly('emptyState'); stopPoll(); return; }
        if (call.status === 'booked' || call.status === 'completed') { renderBooked(call); stopPoll(); return; }
        renderInvite(call);
      }
      function load() {
        var q = stage ? ('?stage=' + encodeURIComponent(stage)) : '';
        return fetch('/api/gp/assistance-call' + q, { credentials: 'same-origin' })
          .then(function (r) {
            if (r.status === 401) { showOnly('errorState'); document.getElementById('errorMsg').textContent = 'Please sign in again to see your call.'; return null; }
            return r.ok ? r.json() : null;
          })
          .then(function (d) { if (d && d.ok) apply(d.call); else if (d !== undefined) showOnly('errorState'); })
          .catch(function () { showOnly('errorState'); });
      }
      function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
      function startPoll() {
        stopPoll(); polls = 0;
        pollTimer = setInterval(function () { polls++; if (polls > 40) { stopPoll(); return; } load(); }, 6000); // ~4 min
      }

      document.getElementById('refreshBtn').addEventListener('click', function () { load(); });
      window.addEventListener('focus', function () { load(); });
      load().then(startPoll);
    })();
  </script>
</body>
</html>
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/confirm-call-page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pages/confirm-call.html tests/confirm-call-page.test.js
git commit -m "feat(page): in-app 'Confirm your Zoom call' page for assistance calls"
```

---

## Task 6: Register `/pages/confirm-call` in `js/app-shell.js`

**Files:**
- Modify: `js/app-shell.js` — add `confirm-call` to `PAGE_PATHS` and `NAV_GROUPS`.
- Test: extend `tests/confirm-call-page.test.js` with a shell-registration assertion.

**Interfaces:**
- Consumes/Produces: makes the outstanding-actions deep link `/pages/confirm-call.html?stage=…` resolve through the shell (the deep link is emitted by Task 2). Being a new path, it is NOT hijacked by `shouldRouteThroughRegistrationIntro` (which only rewrites `/pages/myinthealth`).

- [ ] **Step 1: Add the failing assertion** — append to `tests/confirm-call-page.test.js`:

```js
import fs2 from 'fs';
describe('app-shell registers confirm-call', () => {
  const shell = fs2.readFileSync(path.join(ROOT, 'js', 'app-shell.js'), 'utf8');
  it('is a known page path and nav group', () => {
    expect(shell).toContain('"/pages/confirm-call"');
    expect(shell).toMatch(/"\/pages\/confirm-call":\s*\{\s*desktop:/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/confirm-call-page.test.js`
Expected: FAIL on the new "app-shell registers confirm-call" block.

- [ ] **Step 3: Register the route** — in `js/app-shell.js`:

In `PAGE_PATHS`, after the `"/pages/secure-interview": true,` line add:

```js
    "/pages/confirm-call": true,
```

In `NAV_GROUPS`, after the `"/pages/secure-interview": { desktop: "career", mobile: "/pages/career" },` line add (the call is a registration/home concern, so group it with home):

```js
    "/pages/confirm-call": { desktop: "home", mobile: "/pages/index" },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/confirm-call-page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
node --check js/app-shell.js
git add js/app-shell.js tests/confirm-call-page.test.js
git commit -m "feat(shell): register /pages/confirm-call route so the Zoom card resolves"
```

---

## Final verification (after all tasks)

- [ ] Full suite: `npm test` — expect all green (baseline plus the 5 new files).
- [ ] Syntax: `node --check server.js && node --check js/app-shell.js && node --check js/career-home-card.js && node --check js/updates-sync.js`.
- [ ] Manual smoke (describe honestly what was and wasn't checked): boot `npm start`, and — because the CSP + Calendly + Supabase data can't be fully exercised locally — at minimum confirm `pages/confirm-call.html` renders its loading→empty state without console errors, and that `GET /api/gp/assistance-call` returns `{ok:true,call:null}` when not signed in / no data. Note in the PR that the live Calendly booking → webhook → booked-state transition and the real application-status routing were validated by tests + code, not a live prod click-through (owner to verify in prod).
- [ ] Push branch + open a **draft PR** (do not push to main): `git push -u origin worktree-confirm-call-and-live-app-card` then `gh pr create --draft`.

## Self-review (completed by plan author)

- **Spec coverage:** Feature 1 dynamic card (Tasks 3+4), smart routing matrix (Task 3), suppress static career notification (Task 4 + updates-sync category), Feature 2 new endpoint (Task 1), outstanding title+deeplink override (Task 2), new page (Task 5), shell registration (Task 6), no DB migration (confirmed — all columns exist). All spec sections map to a task.
- **Placeholder scan:** none — every code/test step contains full code.
- **Type consistency:** `deriveCareerHomeCard(app) -> {title,badgeClass,badgeLabel,iconType,href,ts}` defined in Task 3 and consumed identically in Task 4. Endpoint shape `{ok,call:{…}}` defined in Task 1 and consumed by the Task 5 page fields (`stageLabel/status/meetingReason/calendlyBookingUrl/scheduledAt/timezone/durationMinutes/zoomJoinUrl/rsoName`). Deep link `/pages/confirm-call.html?stage=` emitted in Task 2, read in Task 5, resolved in Task 6.
