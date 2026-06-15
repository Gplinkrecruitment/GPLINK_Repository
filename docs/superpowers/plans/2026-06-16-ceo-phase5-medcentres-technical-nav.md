# CEO Phase 5 — Medical Centres + Technical as company-wide dark tabs + nav cleanup

> Implement→review→fix. HARD CONSTRAINT: do NOT modify `pages/admin.html`. All UI in `pages/ceo-dashboard.html` (dark). FRONT-END ONLY — reuse existing endpoints (`/api/admin/medical-centres`, `/api/ceo/integrations`, `/api/ceo/technical/*`); NO server.js changes. SAFETY: read-only views; do NOT wire reconnect/sync (live external mutations) — defer them. After each task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal:** Finish the unified workspace so the CEO never bounces to Hazel's light admin page. Add **Medical Centres** and **Technical** as company-wide in-page dark tabs, and clean up the nav: the operational items (GPs, Support, Calls) now live under RSO Oversight, so their standalone bouncing links are removed; Guide opens in a new tab.

**Verified facts:**
- Nav markup: `pages/ceo-dashboard.html` ~line 1013 `<nav class="ceo-topnav" id="ceoTopNav">` with items: Overview (`data-tab="overview"`), RSO Oversight (`data-tab="rsos"`), then bouncing `<a href="/pages/admin?view=...">` links for GPs, Medical Centres, Support, Guide, Calls (`view=scheduled_calls`), Technical.
- Tab dispatcher ~line 2043: a click listener on `#ceoTopNav` that toggles `#mainContent` (overview) and `#rsoContent` (rsos) display and calls `loadRsoOversight()` for `rsos`. Panels: `<div class="content" id="mainContent">` (~1035), `<div class="content" id="rsoContent" style="display:none">` (~1041).
- **Medical Centres:** `GET /api/admin/medical-centres` (server.js ~24930), `requireAdminSession` (super-admin passes), query `status=open|filled|all`. READ the exact response wrapper key + per-centre fields from the handler's final `sendJson` (admin.html consumes them as `S.mc.centres` with fields: `practice_name`, `client_name`, `location`, `contact_name`, `contact_email`, `contact_phone`, `open_positions`, `job_openings[]`, `website`, `billing_type`, `work_type`, `address`). Read-only — no add/edit.
- **Technical:** `GET /api/ceo/integrations` (server.js ~37617), `requireCeoSession` (= super-admin), returns `{ ok, integrations:[{ key, name, status('connected'|'degraded'|'disconnected'|'configured'), details(object), can_reconnect, reconnect_action }] }`. Also `GET /api/ceo/technical/system-bugs?status=open` (~37976) → `{ ok, bugs:[], summary:{open,acknowledged,critical,high,medium,low} }` and `GET /api/ceo/technical/client-errors?status=open` (~38013) → `{ ok, errors:[], summary:{open,investigating,total_occurrences_24h} }`. admin.html `loadIntegrations` (~8437) renders integration cards (name + status badge + flattened detail fields + Reconnect/Sync buttons). **Reconnect/Sync are DEFERRED** (they trigger live external calls); Phase 5 is read-only display.
- `ceo-dashboard.html` has NO existing Technical/integrations rendering (the Technical nav is currently just a link to admin).
- Test guard `tests/ceo-standalone-ui.test.js` currently asserts the nav CONTAINS `href="/pages/admin?view=gps"`, `view=medicalcentres`, `view=technical`. These encode the OLD nav and MUST be updated when the links become in-page tabs / are removed.

**Files:** `pages/ceo-dashboard.html`, `tests/ceo-standalone-ui.test.js`.

---

### Task 5.1: Medical Centres in-page dark tab

**Files:** Modify `pages/ceo-dashboard.html` (nav item → `data-tab`; generalize the tab dispatcher; add `#mcContent` panel + `loadMedicalCentres` + render + dark CSS).

- [ ] **Step 1 (nav):** change the Medical Centres nav item from `<a href="/pages/admin?view=medicalcentres">` to `<div class="nav-item" data-tab="medical">Medical Centres</div>`.
- [ ] **Step 2 (panel):** add `<div class="content" id="mcContent" style="display:none"></div>` next to `#rsoContent`.
- [ ] **Step 3 (dispatcher):** generalize the `#ceoTopNav` click handler to use a panel registry so it scales. Replace the hard-coded toggles with:
  ```js
  var TAB_PANELS = { overview:'mainContent', rsos:'rsoContent', medical:'mcContent', technical:'techContent' };
  var TAB_LOADERS = { rsos: loadRsoOversight, medical: loadMedicalCentres, technical: loadTechnical };
  // ...on click: set currentTab, toggle active class, then:
  Object.keys(TAB_PANELS).forEach(function(k){ var el=document.getElementById(TAB_PANELS[k]); if(el) el.style.display=(k===tab)?'':'none'; });
  if (TAB_LOADERS[tab]) TAB_LOADERS[tab]();
  ```
  Guard every `getElementById` (panels/loaders added in later tasks may not exist yet — `techContent`/`loadTechnical` arrive in 5.2; reference them only via the guarded registry so a missing panel is a no-op and `TAB_LOADERS.technical` is `undefined` until defined). Keep `?tab=rsos` deep-link behavior working.
- [ ] **Step 4 (loader + render):** add `loadMedicalCentres()` (cache results in a module var so re-clicking the tab doesn't refetch): show spinner in `#mcContent`, fetch `/api/admin/medical-centres?status=open`, read the exact response key (e.g. `d.centres`), then `renderMedicalCentres(centres)` into `#mcContent` — a dark grid of practice cards each showing `practice_name` (linked to `website` if present), `contact_name`/`contact_email`(mailto)/`contact_phone`(tel) when present, and `open_positions` count. Add an Open/Filled toggle that refetches with `status=filled`. Handle loading/empty/error states like `loadRsoOversight`. (Read-only — no add/edit; do NOT replicate admin's drill-down/applications unless trivial.)
- [ ] **Step 5 (CSS):** add dark `.ceo-mc-*` CSS reusing existing tokens (grid + card, matching `.rso-grid`/`.ceo-ops-*`).
- [ ] **Step 6:** inline `<script>` compiles; `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): Medical Centres company-wide dark tab`.

---

### Task 5.2: Technical in-page dark tab (read-only)

**Files:** Modify `pages/ceo-dashboard.html` (nav item → `data-tab`; add `#techContent` panel + `loadTechnical` + render + dark CSS).

- [ ] **Step 1 (nav):** change the Technical nav item from `<a href="/pages/admin?view=technical">` to `<div class="nav-item" data-tab="technical">Technical</div>`.
- [ ] **Step 2 (panel):** add `<div class="content" id="techContent" style="display:none"></div>`. (The dispatcher registry from 5.1 already references `technical→techContent` and `loadTechnical`; this task defines them.)
- [ ] **Step 3 (loader + render):** add `loadTechnical()` (cache results): show spinner in `#techContent`, fetch `/api/ceo/integrations`. Handle 401/403 with a re-login message (mirror admin's `loadIntegrations`). Render a dark `.ceo-tech-cards` grid: per integration a card with `name`, a status badge (color by `status`: connected=green, degraded/configured=amber, disconnected=red), and the `details` object flattened to readable rows (`key.replace(/_/g,' ')` → value; render arrays like `mailboxes` as a small nested list; booleans as Yes/No). **Do NOT render Reconnect/Sync buttons** (deferred — leave a code comment noting they are a follow-up).
- [ ] **Step 4 (health panels):** below the integrations grid, fetch `/api/ceo/technical/system-bugs?status=open` and `/api/ceo/technical/client-errors?status=open` and render their `summary` objects as two small dark stat strips (e.g. "Open bugs: N (critical C / high H)" and "Client errors: open O / 24h occurrences X"). Read-only; if either fetch fails, show a muted "unavailable" note rather than breaking the tab.
- [ ] **Step 5 (CSS):** add dark `.ceo-tech-*` CSS reusing existing tokens (match admin's card concept but dark).
- [ ] **Step 6:** inline `<script>` compiles; `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): Technical company-wide dark tab (read-only integrations + health)`.

---

### Task 5.3: Nav cleanup — remove standalone bouncing links; Guide opens in a new tab; update test

**Files:** Modify `pages/ceo-dashboard.html` (nav); Modify `tests/ceo-standalone-ui.test.js`.

- [ ] **Step 1 (nav):** in `#ceoTopNav`, REMOVE the standalone bouncing links for **GPs** (`view=gps`), **Support** (`view=support`), and **Calls** (`view=scheduled_calls`) — their work now lives under RSO Oversight (per-RSO GPs/calls/support). Change **Guide** from a same-window link to open in a new tab: `<a class="nav-item" href="/pages/admin?view=guide" target="_blank" rel="noopener">Guide</a>` (so it never replaces the CEO workspace). Final nav order: Overview, RSO Oversight, Medical Centres, Technical, Guide.
- [ ] **Step 2 (test update):** in `tests/ceo-standalone-ui.test.js`, update the unified-menu test to the new approved nav. Replace the now-false assertions:
  - REMOVE `expect(ceo).toMatch(/href="\/pages\/admin\?view=gps"/)`, the `view=medicalcentres` link assertion, and the `view=technical` link assertion.
  - ADD: `expect(ceo).toMatch(/data-tab="medical"/)` and `expect(ceo).toMatch(/data-tab="technical"/)` (now in-page tabs); `expect(ceo).not.toMatch(/href="\/pages\/admin\?view=gps"/)`, `...view=support`, `...view=scheduled_calls` (no longer bounce); keep/confirm the existing `\/api\/ceo\/rso\/.../ops` wiring assertion and the admin.html executive-link assertions unchanged.
  - Keep `view=tools` (Ops Queue) still asserted absent.
- [ ] **Step 3:** inline `<script>` compiles; `npx vitest run tests/ceo-standalone-ui.test.js` PASS; `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): nav cleanup — ops areas under RSO Oversight, Guide opens in new tab`.

---

### Task 5.4: Phase 5 verification gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages.
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY.
- [ ] **Step 5:** report totals; confirm NO nav item navigates the CEO to the light admin page in the same window (Guide opens in a new tab); note Reconnect/Sync deferred; no commit.
