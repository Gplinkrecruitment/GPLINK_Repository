# CEO Phase 4 — Support under each RSO (separate build)

> Implement→review→fix. HARD CONSTRAINT: do NOT modify `pages/admin.html`. All UI in `pages/ceo-dashboard.html` (dark). New read as `GET /api/ceo/rso/:id/support`; reuse existing `/api/admin/*` action endpoints unchanged. SAFETY: NO live mutations/sends during build or verify — wire + code-trace + unit tests only. After each task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal:** In the CEO dashboard's RSO drill-in (`openRsoDetail`, ceo-dashboard.html), below the calls board, show that RSO's **case-linked support tickets** — grouped Open / Resolved — dark-themed, from a new `GET /api/ceo/rso/:id/support`. The CEO can **Resolve / Reopen** a ticket (reusing `PUT /api/admin/va/ticket/:id`).

**Verified facts:**
- Table `support_tickets`: `id`, `user_id`, `case_id` (nullable), `title`, `body`, `category`, `stage`, `substage`, `priority`, `status` (`open`|`closed`), `source`, `thread_json` (array of `{from,text,ts,attachments}`), `first_reply_at`, `resolved_at`, `resolved_by`, `created_at`, `updated_at`.
- Ownership path: `support_ticket.case_id → registration_cases.id → registration_cases.assigned_rso` (uuid = RSO user_id). Tickets with no `case_id` (or a case with no `assigned_rso`) → `'__unassigned__'`.
- The CEO `:id` route param is the RSO's **user_id** (same as `/ops`). Mirror the structure of `GET /api/ceo/rso/:id/ops` (server.js ~36783): path regex match for GET, `decodeURIComponent(id)`, `requireSuperAdminSession`, `isSupabaseDbConfigured` 503 guard, load rows, call the pure lib helper, enrich with GP name, `{ ok:true, rso_id:id, tickets:[...] }`.
- Resolve/reopen action endpoint (reuse, do NOT modify): `PUT /api/admin/va/ticket/:id` — JSON `{status:'open'|'closed'}`, `requireAdminSession` (super-admin passes). Patches `support_tickets` (status/updated_at/resolved_at/resolved_by) + mirrors to the legacy store. Returns `{ok, ...}`.
- **Reply is DEFERRED:** `POST /api/admin/tickets/:id/reply` keys off the legacy `gpLinkSupportCases` id (not `support_tickets.id`) and sends an email — wiring it reliably needs id-mapping clarification. Out of scope for Phase 4; tracked as a follow-up. (Case-linked WhatsApp/email-triage *tasks* are already actionable via the per-RSO ops board and the GP Tasks sub-tab.)

**Files:** `lib/ceo-metrics.js`, `tests/ceo-metrics.test.js`, `server.js`, `pages/ceo-dashboard.html`.

---

### Task 4.1: lib helper `supportTicketsForRso` + tests

**Files:** Modify `lib/ceo-metrics.js`; Modify `tests/ceo-metrics.test.js`.

- [ ] **Step 1 (test):** append a `describe('supportTicketsForRso')` block. Fixtures:
  ```js
  const caseById = { c1:{ id:'c1', assigned_rso:'rA' }, c2:{ id:'c2', assigned_rso:'rB' }, c3:{ id:'c3' } };
  const tickets = [
    { id:1, case_id:'c1' }, { id:2, case_id:'c2' }, { id:3, case_id:'c1' },
    { id:4, case_id:'c3' },      // case has no assigned_rso → unassigned
    { id:5, case_id:null },      // no case → unassigned
    { id:6 }                     // missing case_id → unassigned
  ];
  ```
  Assert: `supportTicketsForRso(tickets, caseById, 'rA').map(t=>t.id)` === `[1,3]`; `...'rB')` === `[2]`; `...'__unassigned__')` === `[4,5,6]`; `supportTicketsForRso(null, caseById, 'rA')` === `[]`. Run `-t "supportTicketsForRso"` → FAIL.

- [ ] **Step 2 (impl):** add + export in `lib/ceo-metrics.js` (mirror `opsTasksForRso`):
  ```js
  // Per-RSO support tickets: group by the assigned_rso of each ticket's linked case.
  // No case_id, or a case with no assigned_rso → '__unassigned__'.
  function supportTicketsForRso(tickets, caseById, rsoId) {
    var out = [];
    for (var i = 0; i < (tickets || []).length; i++) {
      var t = tickets[i];
      var c = t && t.case_id ? caseById[t.case_id] : null;
      var key = (c && c.assigned_rso) ? c.assigned_rso : '__unassigned__';
      if (key === rsoId) out.push(t);
    }
    return out;
  }
  ```
  Add to `module.exports`. Run the test → PASS.

- [ ] **Step 3:** `node --check lib/ceo-metrics.js`; `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): supportTicketsForRso lib helper`.

---

### Task 4.2: server `GET /api/ceo/rso/:id/support`

**Files:** Modify `server.js` (add beside `/api/ceo/rso/:id/ops` and `/calls`).

- [ ] **Step 1:** add a GET route matching `/^\/api\/ceo\/rso\/([^\/]+)\/support$/`; `decodeURIComponent` the id; `requireSuperAdminSession`; the same `isSupabaseDbConfigured` 503 guard as siblings.
- [ ] **Step 2:** load support tickets — `supabaseDbRequest('support_tickets', 'select=id,user_id,case_id,title,body,category,stage,priority,status,thread_json,first_reply_at,resolved_at,resolved_by,created_at,updated_at&order=created_at.desc')` (read the actual column names from the `support_tickets` reads already in server.js — e.g. `/api/admin/va/tickets` ~31666 — and match them exactly). Tolerate `!res.ok` by treating tickets as `[]`.
- [ ] **Step 3:** collect the non-null `case_id`s, load those cases — `supabaseDbRequest('registration_cases', 'select=id,user_id,assigned_rso,practice_name&id=in.(' + ids.join(',') + ')')` (guard against an empty id list). Build `caseById`.
- [ ] **Step 4:** `var rsoTickets = ceoMetrics.supportTicketsForRso(tickets, caseById, id);`
- [ ] **Step 5:** enrich each ticket with `gp_name` / `gp_email` from `user_profiles` (mirror how `/api/ceo/rso/:id/ops` fetches profiles by `user_id` and maps names) and with `practice_name` from its case. Return `{ ok:true, rso_id:id, tickets: rsoTickets }`.
- [ ] **Step 6:** `node --check server.js`; confirm no `/api/admin/*` change and `pages/admin.html` untouched. Commit `feat(ceo): GET /api/ceo/rso/:id/support — case-linked support tickets per RSO`.

---

### Task 4.3: CEO page — support board in the RSO drill-in

**Files:** Modify `pages/ceo-dashboard.html` (extend `openRsoDetail`; add `loadRsoSupport` like `loadRsoCalls`; dark CSS; resolve/reopen handlers + delegation).

- [ ] **Step 1:** after the calls board container in `openRsoDetail`, append a `<div id="ceoSupportBoard">` section; after setting innerHTML, call `loadRsoSupport(rsoId)` which fetches `/api/ceo/rso/:id/support` and renders tickets grouped into **Open** (`status==='open'`) and **Resolved** (`status==='closed'`). Each row: GP name, ticket `title`, a snippet of `body` (or last `thread_json` message), `category` + `priority` pills, `created_at` (formatted), and a status pill. Show a count in the section head. Handle loading/empty/error states like `loadRsoCalls`.
- [ ] **Step 2 (actions):** on each ticket row add **Resolve** (when open) or **Reopen** (when closed) → `data-ceo-support-action="resolve|reopen" data-ticket="<id>"`. Handler calls `PUT /api/admin/va/ticket/<id>` with `{status:'closed'}` (resolve) or `{status:'open'}` (reopen) via the page's `apiFetch` JSON helper; on success, toast + re-fetch `/api/ceo/rso/:id/support` and re-render the support board (store `rsoId` so the refresh targets the open RSO). Check `res.ok` AND parsed `{ok}`. Wire via event delegation on a stable parent (so it survives re-render).
- [ ] **Step 3:** add dark `.ceo-support-*` CSS reusing existing tokens (match `.ceo-ops-*`/`.ceo-calls-*`). No nav change in this phase (the standalone Support nav link is removed in Phase 5's nav cleanup).
- [ ] **Step 4:** inline `<script>` compiles; `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): per-RSO support board in RSO Oversight drill-in (view + resolve/reopen)`.

---

### Task 4.4: Phase 4 verification gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages.
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY.
- [ ] **Step 5:** report totals; note Reply is deferred; no commit.
