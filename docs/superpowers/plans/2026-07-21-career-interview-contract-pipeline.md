# Career Interview + Contract Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Withdrawn applications disappear from the career Roles/Saved tabs and can never be re-applied to; hero images load instantly on tab switches; accepting a practice invitation books an interview instead of instantly securing a placement; after the interview the practice is emailed to extend an offer (contract upload) or decline, the contract passes an AI + CEO review, the GP signs via upload or requests changes (change loop through CEO + practice email consent), and only a signed contract secures the placement.

**Architecture:** Monolithic `server.js` (all routes) + plain-HTML pages with inline JS. New pipeline state lives in a new `career_contracts` table; interview completion is detected via the existing Zoom `meeting.ended` webhook plus the existing `detect-no-shows` cron as fallback; practice actions are driven by signed HMAC purpose tokens in emails (GET = confirm page, POST = act). AI contract review mirrors the existing `diffContracts` Anthropic document-block pattern.

**Tech Stack:** Node (no framework), Supabase PostgREST + Storage, Vercel crons, Anthropic Messages API, vitest.

## Global Constraints

- **NEVER `git add -A`** — stage explicit paths only.
- After every changed `<script src>` target, bump cache busters to `?v=20260721a` (tests pin busters — update `tests/` pins in the same commit).
- Run `node --check server.js` before every commit that touches it.
- Commit after each task. Branch: `worktree-career-withdraw-offer-flow` (already checked out in this worktree). Do NOT push to main.
- All new endpoints follow existing patterns: `if (pathname === '/api/...' && req.method === 'POST')` branches in `server.js`; JSON bodies via `readJsonBody`; responses via `sendJson`.
- Emails: build HTML with `formatPlainTextEmailHtml`-style escaping (entity-escape gotcha) and send with `sendEmail`; sender identity rules stay as-is.
- Status keys are snake_case via `normalizeCareerApplicationStatusKey` (`server.js:18009`).
- Supabase writes from server code go through `supabaseDbRequest(table, query, opts)`.
- Prod schema drift kills queries silently (memory: gp_applications has NO `created_at` — use `applied_at`). Never select a column you haven't verified exists.
- New tables/columns: migration file in `supabase/migrations/` AND applied to prod via `rpc/exec_sql` (service key, param name `query`, schema-qualify).
- Plain-language explanations in the final report (owner is non-technical).

## Key existing symbols (verified, with locations)

| Symbol | Where | Fact |
|---|---|---|
| `isApplied(roleId)` | `pages/career.html:11615` | counts ANY application incl. withdrawn |
| `buildRoleCardHtml` | `pages/career.html:11580` | renders UNDER REVIEW ribbon when `isApplied` |
| `getFilteredRoles` | `pages/career.html:11634` | Roles list source |
| `buildApplicationRowHtml` | `pages/career.html:12324` | Offers panel row; WITHDRAWN ribbon already exists |
| `/api/career/apply` | `server.js:38439` | has `already_placed` 409 + "existing-application branch" |
| `/api/career/offer/accept` | `server.js:37935` | currently calls `finalizeInAppPlacement` (`server.js:38031`) |
| `finalizeInAppPlacement` | `server.js:30921` | offer→accepted, kanban→hired, status→placement_secured, placement row, job fill, redirect fan-out, congrats |
| `revealApplicationAndEnsureOffer` | `server.js:31502` | practice Approve → revealed + offer `sent` ("Practice accepted — interview invitation") |
| approve handler | `server.js:37116` / status write `server.js:37128` | sets `status:'interview'` |
| `atsOffersStore` | `lib/ats-offers.js` (instantiated `server.js:119`) | `saveAtsOffer`, `getAtsOfferByApplication`, `updateAtsOfferStatus(appId,status,extra)`; statuses `draft/sent/accepted/declined/withdrawn`; table `ats_offers` has `contract_document_key` |
| `ATS_STAGES` / `ATS_REJECT_STAGE` | `lib/ats-practices.js:7-8` | `['shortlisted','applied','submitted','reviewing','interview','offer','hired']` / `'not_proceeding'` |
| `PIPELINE_BUCKETS` / `bucketForApps` | `lib/ats-practices.js:137` / `:158` | CEO GP-level buckets incl. `not_proceeding` |
| Zoom webhook | `server.js:32258` → `handleZoomSchedulingWebhook` (`server.js:20104`) | `meeting.ended` → `handleZoomMeetingEnded` (`server.js:20186`); `meeting.summary_completed` → `handleZoomSummaryCompleted` (`server.js:20235`) |
| `fetchAndSaveZoomSummary` | `server.js:20272` | saves `meeting_summary` etc. onto `scheduled_calls` |
| `detect-no-shows` cron | `server.js:34712`, every 10 min | marks booked `scheduled_calls` completed/no_show ~90 min after `scheduled_at` |
| signed purpose tokens | `server.js:12402-12418` | `createSignedPurposeToken` / `parseSignedPurposeToken`; pattern used by `/api/practice/respond` (`server.js:36706` GET confirm, `:36773` POST act) |
| signed storage upload | `server.js:6590` (`supabaseStorageCreateSignedUploadUrl`), finalize pattern in `/api/admin/offer-contract/*` (`tests/admin-offer-contract-upload.test.js`) | browser PUTs file directly, bypasses 4.5 MB limit |
| `supabaseStorageCreateSignedUrl` | `server.js:6640` | download links |
| `diffContracts` | `server.js:2328` | Anthropic PDF document-block compare — mirror for AI review |
| `SUPABASE_DOCUMENT_BUCKET` | `server.js:76` | `gp-link-documents` |
| sw fetch handler | `sw.js:283-287` | bails on cross-origin — why hero images never cache |
| location concat bug | `server.js:41869,41874,41896,41897,42083` | `(city||'') + (state ? ', '+state : '')` → `", NSW"` |
| SECURED status keys | `server.js:18033` | includes `offer_accepted` (0 prod rows use it) |
| CEO pipeline summary | `server.js:62382` (buckets), `62239`/`62310` (`pipeline_bucket`) | iterates `PIPELINE_BUCKETS` |

**Helen's prod data (for Task 7):** user `811aae4c-fa08-4909-ace8-fbca1bd7de91`; SOP app `c61a2dd2-ba9d-4ba5-b772-5444b87372f5` (role 4) now `placement_secured`/`hired`; offer `88e6fe85-177c-429b-91fd-af58984b8c5d` `accepted`; placements row `338f4094-96ea-48ba-88b2-79b9953776e8`; `user_state.state.gp_career_state` (JSON **string** inside the state object) has the app entry with `isPlacementSecured:true` + `placement` payload. Withdrawn app `7d2e320f-1596-4223-b756-bef37181c56b` (role 93104) is correct as-is. Role 4 `job_status` is still `open` (verify unchanged after revert). smithmiller's app `98eb418c-28df-4f55-876a-b74abb85b852` stays `not_proceeding` (owner-approved).

---

# PHASE 1 — Correctness fixes + accept rewire (shippable alone)

### Task 1: Withdrawn applications vanish from Roles + Saved tabs

**Files:**
- Modify: `pages/career.html` (~11611-11634, `getFilteredRoles`, saved rendering)
- Test: `tests/career-withdraw-flow.test.js` (extend — it already loads career.html source; follow its existing style of source-regex assertions + jsdom if present)

**Interfaces:**
- Produces: client helper `isWithdrawnRole(roleId)` and `isActiveApplication(job)` used by Task 2's popup logic.

- [ ] **Step 1: Write failing tests** — in `tests/career-withdraw-flow.test.js` add a describe block asserting the career.html source contains the new guards:

```js
describe('withdrawn roles are hidden from Roles/Saved', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pages', 'career.html'), 'utf8');
  it('isApplied ignores terminal applications', () => {
    expect(src).toMatch(/TERMINAL_APPLICATION_STATUS_KEYS\s*=\s*\[\s*"withdrawn"/);
    expect(src).toMatch(/function isActiveApplication\(/);
  });
  it('getFilteredRoles drops withdrawn roles', () => {
    expect(src).toMatch(/isWithdrawnRole\(/);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/career-withdraw-flow.test.js` — expect the new assertions FAIL.

- [ ] **Step 3: Implement** in `pages/career.html`. Replace the `isApplied` function (`:11615`) with:

```js
    const TERMINAL_APPLICATION_STATUS_KEYS = ["withdrawn", "not_proceeding", "offer_declined"];

    function isActiveApplication(job) {
      if (!job) return false;
      const key = normalizeStatusKey(job.rawStatus || job.status);
      return !TERMINAL_APPLICATION_STATUS_KEYS.includes(key);
    }

    function isApplied(roleId) {
      return careerState.applications.some((job) => job && job.roleId === roleId && isActiveApplication(job));
    }

    // A role the GP withdrew from must never resurface in Roles/Saved —
    // it lives only in the Offers tab, marked WITHDRAWN (owner rule 2026-07-21).
    function isWithdrawnRole(roleId) {
      return careerState.applications.some(
        (job) => job && job.roleId === roleId && normalizeStatusKey(job.rawStatus || job.status) === "withdrawn"
      );
    }
```

(`normalizeStatusKey` already exists client-side — reuse it; check its exact name near `pages/career.html:12334`.)

In `getFilteredRoles` (`:11634`), immediately after the roles array is materialized (find where the list is first built from `careerState.roles`), add `roles = roles.filter((r) => r && !isWithdrawnRole(r.id));` — mind `qualifyingCount` if it is computed from the pre-filter list; filter BEFORE the count. In the saved-jobs render path (`careerState.showSavedOnly` / saved list building), apply the same filter to the displayed saved list (do NOT mutate `careerState.savedJobs` storage).

- [ ] **Step 4: Run** `npx vitest run tests/career-withdraw-flow.test.js` — PASS. Also `npx vitest run tests/career-page*.test.js` if present.

- [ ] **Step 5: Commit** `git add pages/career.html tests/career-withdraw-flow.test.js && git commit -m "fix(career): withdrawn applications no longer show as roles or UNDER REVIEW"`

### Task 2: Re-apply after withdrawal is blocked (server 409 + popup)

**Files:**
- Modify: `server.js` (`/api/career/apply` existing-application branch, ~38439-38700; and `/api/career/match/respond` accept path if it inserts applications — grep `acceptShortlistedMatchRow`)
- Modify: `pages/job.html` (apply handler — find the fetch to `/api/career/apply`; add 409 handling + modal)
- Test: `tests/career-withdraw-flow.test.js`

**Interfaces:**
- Produces: 409 response `{ ok:false, code:'previously_withdrawn', message:'You previously withdrew your application for this position, so it can\'t be applied for again. If this was a mistake, message your Registration Support Officer.' }`

- [ ] **Step 1: Failing test** (follow the file's existing server-spawn or source-assert style; if the file asserts source, assert both sides):

```js
it('apply endpoint rejects previously-withdrawn applications', () => {
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  expect(srv).toMatch(/previously_withdrawn/);
});
it('job page explains the block in a popup', () => {
  const job = fs.readFileSync(path.join(ROOT, 'pages', 'job.html'), 'utf8');
  expect(job).toMatch(/previously_withdrawn/);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement server side.** In `/api/career/apply`, locate the existing-application branch (comment "existing-application branch further down remains the authoritative"). Where the existing row for (user, role) is found, add BEFORE any reactivation/update:

```js
    if (normalizeCareerApplicationStatusKey(existingApp.status) === 'withdrawn') {
      sendJson(res, 409, {
        ok: false,
        code: 'previously_withdrawn',
        message: "You previously withdrew your application for this position, so it can't be applied for again. If this was a mistake, message your Registration Support Officer."
      });
      return;
    }
```

Apply the same guard in the match-respond accept path if it can create/reactivate an application for a role with a withdrawn row (search `acceptShortlistedMatchRow` callers, `server.js:39217` area).

**Implement client side** in `pages/job.html`: in the apply fetch handler add:

```js
      if (res.status === 409 && data && data.code === "previously_withdrawn") {
        showWithdrawnBlockModal(data.message);
        return;
      }
```

and add the modal (mirror the existing decline-confirm overlay markup/styles in job.html):

```html
<div class="ovl" id="withdrawnBlockOverlay" hidden>
  <div class="ovl-card">
    <h3>Application withdrawn</h3>
    <p id="withdrawnBlockMsg"></p>
    <button type="button" class="btn-primary" id="withdrawnBlockOk">OK, got it</button>
  </div>
</div>
```

```js
function showWithdrawnBlockModal(msg) {
  const o = document.getElementById("withdrawnBlockOverlay");
  document.getElementById("withdrawnBlockMsg").textContent = msg || "You previously withdrew your application for this position.";
  o.hidden = false;
}
document.getElementById("withdrawnBlockOk").addEventListener("click", () => {
  document.getElementById("withdrawnBlockOverlay").hidden = true;
});
```

- [ ] **Step 4: Run tests — PASS.** `node --check server.js`.
- [ ] **Step 5: Commit** `git commit -m "feat(career): block re-apply after withdrawal with explanatory popup"` (explicit paths).

### Task 3: Hero images cached — instant tab switches

**Files:**
- Modify: `sw.js` (fetch handler `:283-287`, VERSION const at top)
- Modify: `pages/career.html` (warm images after roles load)
- Test: `tests/career-image-cache.test.js` (new)

- [ ] **Step 1: Failing test:**

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(__dirname, '..');
describe('career hero image caching', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  it('sw caches career-hero-images cross-origin', () => {
    expect(sw).toMatch(/career-hero-images/);
    expect(sw).toMatch(/IMAGE_CACHE/);
  });
  it('career page warms role thumbnails', () => {
    const career = fs.readFileSync(path.join(ROOT, 'pages', 'career.html'), 'utf8');
    expect(career).toMatch(/warmRoleImages/);
  });
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** In `sw.js`: bump `VERSION`; add `var IMAGE_CACHE = "gp-link-images-" + VERSION;` and include it in `CACHE_NAMES`. In the fetch listener, BEFORE the same-origin bail:

```js
    // Practice hero images live on the Supabase storage origin — cache-first,
    // else every Roles/Saved/Offers tab switch re-downloads every thumbnail.
    if (request.method === "GET" && url && url.pathname.indexOf("/storage/v1/object/public/career-hero-images/") !== -1) {
      event.respondWith(
        caches.match(request).then(function (cached) {
          if (cached) return cached;
          return fetch(request).then(function (response) {
            if (!response || (response.status !== 200 && response.type !== "opaque")) return response;
            var copy = response.clone();
            caches.open(IMAGE_CACHE).then(function (cache) { cache.put(request, copy); });
            return response;
          });
        })
      );
      return;
    }
```

In `pages/career.html`, after roles data lands (find the success path of the roles fetch that assigns `careerState.roles`), add:

```js
    const warmedRoleImages = new Set();
    function warmRoleImages(roles) {
      (roles || []).slice(0, 24).forEach((role) => {
        const src = String((role && (role.headerImageUrl || role.heroImageUrl)) || "");
        if (!src || warmedRoleImages.has(src)) return;
        warmedRoleImages.add(src);
        const img = new Image();
        img.decoding = "async";
        img.src = src;
      });
    }
```

and call `warmRoleImages(careerState.roles)` there.

- [ ] **Step 4: Run tests — PASS.**
- [ ] **Step 5: Commit** `git commit -m "perf(career): cache hero images in service worker + warm thumbnails"`.

### Task 4: Kill the ", NSW" empty-suburb label

**Files:**
- Modify: `server.js:41869,41874,41896,41897,42083`
- Modify: `pages/application-detail.html:1227-1229`
- Test: `tests/career-location-label.test.js` (new)

- [ ] **Step 1: Failing test:**

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(__dirname, '..');
describe('location labels never render ", NSW"', () => {
  it('server concat sites use filtered join', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(srv).not.toMatch(/location_city \|\| ''\) \+ \(r\.location_state \? ', '/);
  });
  it('application-detail trims a leading comma', () => {
    const p = fs.readFileSync(path.join(ROOT, 'pages', 'application-detail.html'), 'utf8');
    expect(p).toMatch(/replace\(\/\^\[\\s,\]\+\//);
  });
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** At each of the five server sites replace the concat with a filtered join, e.g. `[r.location_city, r.location_state].filter(Boolean).join(', ')` (keep surrounding variable names). In `application-detail.html:1227` wrap: `var locationText = String(app.location || role.location || "").replace(/^[\s,]+/, "");`
- [ ] **Step 4: Run tests — PASS.** `node --check server.js`.
- [ ] **Step 5: Commit** `git commit -m "fix(career): location labels drop empty suburb instead of rendering ', NSW'"`.

### Task 5: Accepting an invitation books an interview — never a placement

**Files:**
- Modify: `server.js` `/api/career/offer/accept` handler (37935-38065), `SECURED_CAREER_APPLICATION_STATUS_KEYS` (`:18033`), new notifier near `notifyGpOfSelfAcceptedPlacement` (`:30871`)
- Modify: `pages/offer-review.html` (copy), `pages/job.html` (copy/toasts), `pages/career.html` (offer-row copy `:12377-12391`)
- Test: `tests/ats-accept-flow.test.js` (update expectations)

**Interfaces:**
- Produces: accept response `{ ok:true, accepted:true, interviewInvitation:true }`; application stays/becomes status `interview`, ats_stage `interview`. `finalizeInAppPlacement` remains UNTOUCHED for `/api/ats/placement` + kanban-hired paths.

- [ ] **Step 1: Update `tests/ats-accept-flow.test.js`** — change assertions: after POST `/api/career/offer/accept`, `gp_applications.status === 'interview'`, `ats_stage === 'interview'`, NO `placements` insert, NO job fill, NO redirect of other candidates, offer status `accepted`. Add a test that `/api/ats/placement` (staff path) STILL finalizes placement.
- [ ] **Step 2: Run — FAIL** (old behavior still live).
- [ ] **Step 3: Implement server.** In the accept handler, replace the `finalizeInAppPlacement(...)` call (`server.js:38031`) with:

```js
    // Accepting here accepts the INTERVIEW INVITATION — placement is secured
    // only when a signed contract lands (career_contracts flow). 2026-07-21.
    var acceptNowIso = new Date().toISOString();
    var acceptedOffer = acceptIsResume
      ? acceptOffer
      : ((await atsOffersStore.updateAtsOfferStatus(String(acceptTargetApp.id), 'accepted', { responded_at: acceptNowIso }))
        || Object.assign({}, acceptOffer, { status: 'accepted', responded_at: acceptNowIso }));
    var invStage = atsPracticeUtil.planAtsStageReconciliation(acceptTargetApp.ats_stage || '', 'interview');
    if (invStage) {
      try { await atsUpdateApplicationStageRow(acceptTargetApp.id, invStage, undefined, acceptEmail || 'gp_accept_invitation'); }
      catch (e) { console.error('[invite-accept] stage move failed:', e && e.message); }
    }
    if (isSupabaseDbConfigured()) {
      await supabaseDbRequest('gp_applications', 'id=eq.' + encodeURIComponent(acceptTargetApp.id), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { status: 'interview', updated_at: acceptNowIso }
      });
    } else {
      acceptTargetApp.status = 'interview'; acceptTargetApp.updated_at = acceptNowIso; saveDbState();
    }
    if (!acceptIsResume) {
      try { await notifyGpInterviewInvitationAccepted(acceptUserId, acceptTargetApp.id); } catch (e) {}
      try { await notifyOfferSenderOfDecision(acceptedOffer, 'accepted', {}); } catch (e) {}
    }
    sendJson(res, 200, { ok: true, accepted: true, interviewInvitation: true });
    return;
```

Add next to `notifyGpOfSelfAcceptedPlacement`:

```js
async function notifyGpInterviewInvitationAccepted(userId, applicationId) {
  if (!userId) return;
  var nextPath = '/pages/secure-interview?applicationId=' + encodeURIComponent(String(applicationId || ''));
  var title = 'Interview confirmed — pick your time';
  var body = 'Great news — you\'ve accepted the practice\'s interview invitation. Choose a time that suits you and we\'ll set everything up, including the meeting link.';
  await Promise.all([
    pushCareerNotificationToUser(userId, { type: 'success', title: title, body: body }).catch(function () {}),
    sendPushNotification(userId, { title: title, body: body, data: { type: 'career', action: 'interview_invitation_accepted', url: nextPath } }).catch(function () {}),
    sendGpNotificationEmail(userId, 'Interview confirmed — pick your time — GP Link', title, body, 'Choose interview time', APP_BASE_URL + nextPath,
      'Questions? Reply to this email or message us on WhatsApp at +61 494 391 968.').catch(function () {})
  ]);
}
```

Remove `'offer_accepted'` from `SECURED_CAREER_APPLICATION_STATUS_KEYS` (`server.js:18033`) — verified: zero prod rows use it. Check `notifyOfferSenderOfDecision` copy — if it says "placement", soften to "accepted the interview invitation".

**Client copy:** `offer-review.html`: accept button label → `Accept & choose interview time`; post-accept heading copy → interview framing (find "placement is secured"-style strings on that page and reword to "Interview locked in — the contract comes after you meet the practice."). `job.html`: toast `"Offer accepted 🎉 Unlocking the practice…"` → `"Invitation accepted — now pick your interview time"`. `career.html` offer rows (`:12378`): meta → `"The practice wants to interview you — confirm your interview time."`; CTA `"Review offer →"` → `"Review invitation →"` (`:12391`).

- [ ] **Step 4: Run** `npx vitest run tests/ats-accept-flow.test.js` — PASS. `node --check server.js`. Run FULL suite `npx vitest run` — fix any test asserting the old accept→hired behavior (expect `ai-matching-*`, `ats-*` touchpoints).
- [ ] **Step 5: Commit** `git commit -m "feat(career): accept = interview invitation only; placement moves to signed-contract flow"`.

### Task 6: CEO pipeline — remove "Not proceeding" segment

**Files:**
- Modify: `lib/ats-practices.js` (`PIPELINE_BUCKETS:137`, `PIPELINE_BUCKET_LABELS:139`, `bucketForApps:158`)
- Test: `tests/ats-pipeline-buckets.test.js` (new or extend existing bucket test — grep `bucketForApps` in tests/)

- [ ] **Step 1: Failing test:**

```js
import { describe, it, expect } from 'vitest';
import { PIPELINE_BUCKETS, bucketForApps } from '../lib/ats-practices.js';
describe('not_proceeding bucket removed', () => {
  it('is not a pipeline bucket', () => {
    expect(PIPELINE_BUCKETS).not.toContain('not_proceeding');
  });
  it('terminal-only GPs land in unassociated', () => {
    expect(bucketForApps([{ status: 'rejected', ats_stage: 'not_proceeding' }])).toBe('unassociated');
  });
});
```

(Match the module's real export style — CommonJS `module.exports` likely; adjust import accordingly.)

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:** remove `'not_proceeding'` from `PIPELINE_BUCKETS`; in `bucketForApps`, where the best bucket resolves to `not_proceeding`, return `'unassociated'` instead (GPs sit at their most advanced LIVE application; terminal-only → unassociated). Keep `ATS_REJECT_STAGE` and the kanban lane untouched (application-level views keep the lane; only the GP-level pipeline loses the segment). Verify `/api/ceo/pipeline-summary` (`server.js:62382`) needs no change (it iterates `PIPELINE_BUCKETS`).
- [ ] **Step 4: Run tests + full suite — PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(ceo): remove Not-proceeding pipeline segment; terminal-only GPs show as Not associated"`.

### Task 7: Revert Helen's accidental placement (PROD DATA — main session only)

**Executed by the MAIN session (not a subagent) via Supabase REST with the service key from the main checkout `.env`. Owner approved 2026-07-21 ("Revert both"; smithmiller stays).**

- [ ] PATCH `gp_applications?id=eq.c61a2dd2-ba9d-4ba5-b772-5444b87372f5` → `{ "status": "interview", "ats_stage": "interview", "updated_at": "<now>" }`
- [ ] PATCH `ats_offers?id=eq.88e6fe85-177c-429b-91fd-af58984b8c5d` → `{ "status": "draft", "responded_at": null }` — `draft` is invisible to BOTH old and new accept/my-offer endpoints (`server.js:38172` treats draft as no offer), so she cannot re-trigger placement while old code is still deployed; her Offers tab falls back to the interview-stage row with "Confirm time →" (application-detail scheduler).
- [ ] DELETE `placements?id=eq.338f4094-96ea-48ba-88b2-79b9953776e8`
- [ ] Patch `user_state` for user `811aae4c-...`: read `state`, parse `gp_career_state` (it is a JSON STRING inside the state object — re-stringify after editing), set the `c61a2dd2` entry to `{ status: "Interview stage", isPlacementSecured: false, placement: null }`, PATCH back.
- [ ] Verify: role 4 `job_status` still `open`; registration case untouched (stage `myintealth`); re-GET all four rows and print. Note for owner: Helen's congrats email + the practice's confirmation email + smithmiller's redirect email CANNOT be unsent.

---

# PHASE 2 — Post-interview offer → contract → signed placement

**New state machine (career_contracts.status):** `awaiting_upload` → `uploaded` → `sent_to_gp` → (`signed` | `changes_requested` → (`practice_review` → approve → NEW ROW v+1 `awaiting_upload` | decline → back to `sent_to_gp`)) ; `void` for superseded versions; practice post-interview decline → application `not_proceeding` (no contract row).

**gp_applications.status through the flow:** `interview` → (booked) `interview_scheduled` → (call completed) `interview_completed` → (CEO submits contract) `offer` → (GP signs) `placement_secured` via `finalizeInAppPlacement` (with `redirect_others` fan-out — THIS is now the only self-serve fill event). Practice decline → `not_proceeding`.

### Task 8: Migration — `career_contracts` + interview follow-up bookkeeping

**Files:**
- Create: `supabase/migrations/20260721150000_career_contracts.sql`
- Test: extend `tests/career-contracts-flow.test.js` (new file started here; asserts migration exists + column list)

- [ ] **Step 1: Write the migration:**

```sql
-- Post-interview contract pipeline (owner spec 2026-07-21):
-- interview happens -> practice extends offer by uploading a contract ->
-- CEO + AI review -> GP signs (upload) or requests changes -> signed = placement.
create table if not exists public.career_contracts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.gp_applications(id) on delete cascade,
  user_id uuid,
  career_role_id bigint,
  version integer not null default 1,
  status text not null default 'awaiting_upload'
    check (status in ('awaiting_upload','uploaded','sent_to_gp','changes_requested','practice_review','signed','void')),
  contract_bucket text,
  contract_path text,
  contract_filename text,
  contract_mime text,
  signed_bucket text,
  signed_path text,
  signed_filename text,
  ai_review jsonb,
  ai_review_status text not null default 'not_run'
    check (ai_review_status in ('not_run','running','done','error')),
  terms_context jsonb,
  change_request text,
  change_response text,
  ceo_note text,
  practice_contact_email text,
  practice_contact_name text,
  uploaded_at timestamptz,
  sent_to_gp_at timestamptz,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists career_contracts_app_idx on public.career_contracts (application_id, version desc);
create index if not exists career_contracts_status_idx on public.career_contracts (status);
alter table public.gp_applications add column if not exists post_interview_email_sent_at timestamptz;
alter table public.gp_applications add column if not exists interview_completed_at timestamptz;
```

- [ ] **Step 2: Apply to prod** via `rpc/exec_sql` (service key; param `query`; schema-qualified as written). Verify with a `select=id&limit=1` probe against `career_contracts` and a select of the two new gp_applications columns.
- [ ] **Step 3: Test asserting the migration file exists and contains `career_contracts`** (source assert, same style as other migration tests if any).
- [ ] **Step 4: Commit** `git commit -m "feat(contracts): career_contracts table + post-interview bookkeeping columns"`.

### Task 9: Interview completion → instant practice decision email

**Files:**
- Modify: `server.js` — `handleZoomMeetingEnded` (`:20186`), detect-no-shows completion path (`:34712` area), new helper `sendPostInterviewDecisionEmail(call, app)` near the other practice emails (~29800)
- Test: `tests/career-contracts-flow.test.js`

**Interfaces:**
- Produces: `sendPostInterviewDecisionEmail(applicationId)` — idempotent via `gp_applications.post_interview_email_sent_at`; sets `status:'interview_completed'`, `interview_completed_at`. Signed token purpose `'post_interview_decision'` (payload: applicationId) consumed by Task 10's endpoints.
- Consumes: `createSignedPurposeToken` (`server.js:12412` pattern — add `POST_INTERVIEW_TOKEN_PURPOSE = 'post_interview_decision'`).

- [ ] **Step 1: Failing test:** assert server source contains `post_interview_decision` and `sendPostInterviewDecisionEmail`, and that BOTH the zoom-ended handler and detect-no-shows call it (regex on function body order is brittle — assert call-site count `>= 2`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Helper (mirror `sendPracticeDecisionReminderEmail` shape `server.js:29797`):
  - Load app + role + practice contact (`practice_contact_email`/`practice_contact_name` on gp_applications; fall back to the role/practice row contact used by the submit-to-practice email — copy its resolution).
  - Idempotency: bail if `post_interview_email_sent_at` set; PATCH it + `status:'interview_completed'`, `interview_completed_at` first (write-then-send; a failed send can be re-triggered by the cron path since detect-no-shows re-runs — on send failure NULL the stamp back).
  - Two buttons linking `APP_BASE_URL + '/pages/practice-offer.html?token=' + createSignedPurposeToken(POST_INTERVIEW_TOKEN_PURPOSE, { applicationId })` with `&intent=offer` / `&intent=decline`.
  - Copy (plain, escaped): subject `How did the interview with Dr <LastName> go?`; body: thanks for meeting the candidate; two choices: **Extend an offer** — you'll be asked to upload your employment contract for our review; **Not proceeding** — we'll let the doctor down gently and keep searching for you.
  - Call sites: in `handleZoomMeetingEnded` after the call is marked completed, and in the detect-no-shows cron where an attended call flips to `completed` — both only when `call.meeting_kind === 'interview' && call.application_id`.
- [ ] **Step 4: Tests PASS; `node --check server.js`; full suite.**
- [ ] **Step 5: Commit** `git commit -m "feat(contracts): instant post-interview extend-offer/decline email to practice"`.

### Task 10: Practice decision + contract upload page

**Files:**
- Create: `pages/practice-offer.html` (mirror `pages/practice-decision.html` structure: token from URL, context GET, act POST; plus upload UI)
- Modify: `server.js` — 4 endpoints + `CONTRACT_UPLOAD_TOKEN_PURPOSE = 'contract_upload'`
- Test: `tests/career-contracts-flow.test.js`

**Interfaces (produced):**
- `GET /api/practice/offer/context?token=` → `{ ok, gpName, roleTitle, practiceName, state:'decide'|'upload'|'done', contractId? }` — accepts BOTH token purposes (`post_interview_decision` on the application, `contract_upload` on a contract row for re-uploads).
- `POST /api/practice/offer/decision` `{ token, action:'extend_offer'|'decline' }`:
  - `extend_offer` → insert `career_contracts` row (status `awaiting_upload`, version = 1 + max(existing), practice contact fields captured) → respond `{ ok, contractId, uploadToken }` where `uploadToken = createSignedPurposeToken('contract_upload', { contractId })`.
  - `decline` → application `status:'not_proceeding'`, ats_stage via `planAtsStageReconciliation(stage, ATS_REJECT_STAGE)` + `atsUpdateApplicationStageRow`, offer row → `updateAtsOfferStatus(appId,'withdrawn')`, gentle GP notification (mirror the existing not-proceeding GP copy in the redirect fan-out email), CEO in-app alert.
- `POST /api/practice/contract/sign-upload` `{ token, filename, mimeType }` → validates purpose `contract_upload`, contract status `awaiting_upload`, mime `application/pdf` or docx; returns `supabaseStorageCreateSignedUploadUrl(SUPABASE_DOCUMENT_BUCKET, 'contracts/' + applicationId + '/v' + version + '/' + safeName)` (mirror `/api/admin/offer-contract/sign-upload`).
- `POST /api/practice/contract/finalize` `{ token, path, filename, mimeType }` → verifies object exists (HEAD via storage API — copy the admin finalize's existence check), sets contract row `status:'uploaded'`, `uploaded_at`, file fields; fires Task 11's AI review (await, guarded); emails CEO (`hello@mygplink.com.au`): "Contract uploaded for Dr X — review it in the dashboard"; responds `{ ok:true }`.

- [ ] **Step 1: Failing tests** for: decline flips app to not_proceeding; extend creates `awaiting_upload` row; finalize refuses when no file uploaded (mirror `tests/admin-offer-contract-upload.test.js` style — it spins the real server; copy its harness).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** endpoints + page. Page states: `decide` (two big buttons; `intent` query preselects), `upload` (drag/drop file input → sign-upload → PUT file → finalize → thank-you), `done` (already handled). Handle 409 `{code:'withdrawn'}` like practice-decision.html does (`:250-258`). No login — token is the auth. GET never mutates (email-scanner-safe; POST only from button clicks).
- [ ] **Step 4: Tests PASS; `node --check server.js`.**
- [ ] **Step 5: Commit** `git commit -m "feat(contracts): practice extend-offer/decline page with direct-to-storage contract upload"`.

### Task 11: AI contract review vs Zoom-summary terms

**Files:**
- Modify: `server.js` — `aiReviewCareerContract(contractRow)` near `diffContracts` (`:2328`); wire into Task 10's finalize; `POST /api/ceo/contract/ai-check` re-run endpoint
- Test: `tests/career-contracts-flow.test.js`

**Interfaces:**
- Produces: `ai_review` JSONB: `{ overall:'aligned'|'minor_gaps'|'major_discrepancies'|'unreadable', summary, extracted_terms:{billing_split,base_or_guarantee,sessions_per_week,start_date,leave,restraint,other[]}, discrepancies:[{field, contract_says, expected, source:'interview_summary'|'job_listing'|'offer_record', severity:'info'|'warning'|'critical'}], interview_terms_available:boolean }`
- Consumes: contract file from storage (`supabaseStorageCreateSignedUrl` + fetch → buffer), `scheduled_calls.meeting_summary` (latest completed `meeting_kind='interview'` row for the application), `ats_offers` row terms, `career_roles` row + `source_payload.gpLink` public terms.

- [ ] **Step 1: Failing test:** assert server source has `aiReviewCareerContract` and that the prompt names interview-summary precedence (`supersede`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** mirroring `diffContracts` (`server.js:2328`): document block for the contract PDF/DOCX; system-style instruction in the user text block:

```
You are checking an employment contract a practice uploaded for a GP placement.
Compare the contract against (1) the terms discussed in the interview (the Zoom
meeting summary below) and (2) the advertised job terms. Where interview terms
and the advertised terms differ, THE INTERVIEW TERMS SUPERSEDE the listing.
If no interview summary is provided, compare against the advertised/offer terms
only and set interview_terms_available=false.
Respond with ONLY JSON matching: {overall, summary, extracted_terms:{...}, discrepancies:[...], interview_terms_available}
```

`model: ANTHROPIC_SCAN_MODEL, max_tokens: 1500, temperature: 0`, 90s AbortController; parse JSON defensively (strip code fences); on failure store `ai_review_status:'error'`. Set `terms_context` to `{ interview_summary, offer_terms, listing_terms }` used, so the CEO sees the inputs. Wire: finalize sets `ai_review_status:'running'` → await review → `done`. Re-run endpoint requires CEO session (mirror an existing `/api/ceo/*` auth check).
- [ ] **Step 4: Tests PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(contracts): AI review compares contract vs interview-summary terms (supersedes listing)"`.

### Task 12: CEO Contracts queue (review → submit to GP / return to practice)

**Files:**
- Modify: `pages/ceo-dashboard.html` (new "Contracts" section under the ATS/master-tab area — follow the existing tab registration pattern), `server.js` — `GET /api/ceo/contracts`, `POST /api/ceo/contract/decision`
- Test: `tests/career-contracts-flow.test.js`

**Interfaces:**
- `GET /api/ceo/contracts` → `{ ok, contracts:[{ id, applicationId, gpName, practiceName, roleTitle, version, status, ai_review, ai_review_status, change_request, uploaded_at, contractUrl (signed, 1h), signedUrl? }] }` — statuses `uploaded`,`changes_requested` first, then rest, newest first.
- `POST /api/ceo/contract/decision` `{ contractId, action:'submit_to_gp'|'return_to_practice', note? }`:
  - `submit_to_gp` → contract `status:'sent_to_gp'`, `sent_to_gp_at`, `ceo_note:note`; application `status:'offer'` + stage `offer` (forward-only reconciliation); GP notification trio (in-app + push + email): title `Your contract is ready to review 📄`, body "…review the contract, sign and upload it, or request changes", CTA → `/pages/offer-review?applicationId=...`.
  - `return_to_practice` → contract `status:'void'`; email practice with `note` + fresh `contract_upload` token link (new `awaiting_upload` row, version+1).
- CEO session auth: mirror existing `/api/ceo/*` guard.

- [ ] **Step 1: Failing tests** (list + submit_to_gp flips statuses; return_to_practice voids and creates v+1).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Dashboard section: table of pending contracts, AI verdict chip (`aligned` green / `minor_gaps` amber / `major_discrepancies` red / `unreadable` grey), expandable discrepancy list + terms context, View contract link (signed URL), buttons Submit to GP / Return to practice (+ note textarea), and for `changes_requested` rows the Task 14 buttons. Escape ALL interpolated strings (admin XSS memory).
- [ ] **Step 4: Tests PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(contracts): CEO contracts queue with AI verdicts and submit/return actions"`.

### Task 13: GP contract experience — view, sign via upload, request changes

**Files:**
- Modify: `pages/offer-review.html` (contract state UI), `server.js` — `GET /api/career/contract?applicationId=`, `POST /api/career/contract/sign-upload`, `POST /api/career/contract/finalize-signed`, `POST /api/career/contract/request-changes`; extend `/api/career/my-offer` response with `contract` summary; `pages/career.html` offer-row copy for contract stage
- Test: `tests/career-contracts-flow.test.js`

**Interfaces:**
- `GET /api/career/contract?applicationId=` (GP session; ownership check like withdraw does) → `{ ok, contract:{ id, status, version, contractUrl (signed 1h), change_request, change_response, sentToGpAt } }` for the latest non-void row.
- `POST /api/career/contract/sign-upload` `{ applicationId, filename, mimeType }` → contract must be `sent_to_gp` → signed upload URL under `contracts/<appId>/v<version>/signed/<safeName>`.
- `POST /api/career/contract/finalize-signed` `{ applicationId, path, filename, mimeType }` → verify object; contract `status:'signed'`, `signed_at`, signed file fields; **then placement**: reuse `finalizeInAppPlacement(app, offer, userId, email, {})` after flipping the ats_offers row to `sent` if it is `draft` (finalize expects a live offer; guard nulls) — this fires kanban→hired, placement row, job fill, redirect-others, congrats email. Then TWO extra emails with signed-URL links to the signed contract: practice contact ("Dr X has signed — here's the countersigned copy link") and CEO hello@. Response `{ ok:true, placementSecured:true }`.
- `POST /api/career/contract/request-changes` `{ applicationId, message }` (non-empty, ≤4000 chars) → contract `status:'changes_requested'`, `change_request:message`; CEO alert email + in-app.

**offer-review.html states** (drive off `contract.status` when present — contract UI wins over legacy offer UI):
- `sent_to_gp`: heading "Your contract is ready"; buttons: View contract (signed URL), **Upload signed contract** (file input → sign-upload → PUT → finalize-signed → confetti + "Placement secured 🎉"), **Request changes** (textarea + submit → "Sent to your GP Link team").
- `changes_requested`: "We're checking your requested changes with the practice" + the request text.
- `practice_review`: same as above ("with the practice now").
- `signed`: placement-secured state (existing post-accept UI).
- career.html offer-row: when `offerPending` AND contract `sent_to_gp` → meta "Your contract is ready to review and sign."; CTA "Review contract →" (same offer-review link, `:12391` area).

- [ ] **Step 1: Failing tests:** finalize-signed refuses when no file; request-changes stores text + flips status; finalize-signed on a `sent_to_gp` contract secures placement (assert placements insert + status `placement_secured`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (mirror admin sign-upload/finalize harness from `tests/admin-offer-contract-upload.test.js` for the storage bits).
- [ ] **Step 4: Tests PASS; full suite; `node --check server.js`.**
- [ ] **Step 5: Commit** `git commit -m "feat(contracts): GP views, signs-by-upload, or requests changes; signing secures the placement"`.

### Task 14: Change-request loop — CEO triage + practice email consent

**Files:**
- Modify: `server.js` — `POST /api/ceo/contract/change-decision`, `GET/POST /api/practice/contract/consent`, `CONTRACT_CONSENT_TOKEN_PURPOSE='contract_consent'`; `pages/ceo-dashboard.html` (buttons on `changes_requested` rows); Create: `pages/practice-consent.html`
- Test: `tests/career-contracts-flow.test.js`

**Interfaces:**
- `POST /api/ceo/contract/change-decision` `{ contractId, action:'release_to_practice'|'decline_change', note? }` (CEO session):
  - `release_to_practice` → contract `status:'practice_review'`; email practice contact: the GP's requested change (escaped), note, two buttons → `/pages/practice-consent.html?token=<contract_consent token>&intent=approve|decline`.
  - `decline_change` → contract back to `status:'sent_to_gp'`, `change_response:'declined_by_gplink'`; GP notified ("we checked — the contract stands; you can sign or talk to your RSO").
- `GET /api/practice/contract/consent-context?token=` → `{ ok, gpName, roleTitle, changeRequest, state }`.
- `POST /api/practice/contract/consent` `{ token, action:'approve'|'decline' }`:
  - `approve` → current contract `status:'void'`, `change_response:'approved'`; create v+1 row `awaiting_upload`; respond with `{ ok, uploadToken }` and the page immediately shows the SAME upload UI as practice-offer.html (share the upload widget code by copying it — pages are standalone); also email the re-upload link for later.
  - `decline` → contract `status:'sent_to_gp'`, `change_response:'declined_by_practice'`; GP notified ("the practice prefers the current terms — you can sign as-is or talk to your RSO"); CEO alerted.

- [ ] **Step 1: Failing tests** for both consent outcomes (approve → v+1 awaiting_upload; decline → back to sent_to_gp with change_response).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** endpoints + `pages/practice-consent.html` (clone practice-offer.html skeleton; GET confirm → POST act; token-auth only).
- [ ] **Step 4: Tests PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(contracts): change-request loop — CEO triage, practice email consent, re-upload chain"`.

### Task 15: Interview-status plumbing + fallback when Zoom is unconfigured

**Files:**
- Modify: `server.js` (`isCareerInterviewStatus:18026`, status presentation `:18083` area), `lib/ats-practices.js` (`deriveAtsStage:69`), `pages/career.html` + `pages/application-detail.html` (interview_completed labels)
- Test: `tests/career-contracts-flow.test.js`

- [ ] **Step 1: Failing test:** `deriveAtsStage({status:'interview_completed'})` → `'interview'`; server source maps `interview_completed` → label `Interview done — awaiting the practice's decision`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**
  - Add `interview_completed` to `isCareerInterviewStatus` and to `deriveAtsStage`'s interview mappings; presentation label + tone (`review`) in `buildInternalCareerStatusPresentation`; client timeline maps in `application-detail.html` (`:859`, `:945` — step index 2/3, label "Interview complete") and career.html status label fallbacks.
  - **Zoom-unconfigured fallback** (prod today has NO Zoom creds — Helen's booking had `zoom_meeting_id:""`): in the detect-no-shows cron, when a booked interview call's `scheduled_at + duration + 15min` has passed and `zoom_meeting_id` is empty (attendance unknowable), mark it `completed` and fire `sendPostInterviewDecisionEmail` — time-based completion instead of silence. Summary will be absent → AI review runs with `interview_terms_available:false`.
- [ ] **Step 4: Tests PASS; full suite.**
- [ ] **Step 5: Commit** `git commit -m "feat(contracts): interview_completed status + time-based completion when Zoom is absent"`.

### Task 16: Docs, cache busters, final sweep

**Files:**
- Create: `docs/career-contract-pipeline.md` (ops note: flow diagram in words, token purposes, statuses, what needs Zoom creds to light up, email inventory)
- Modify: any `<script src>` busters touched; `tests/` buster pins

- [ ] **Step 1:** Write the ops doc (plain language; include: to enable instant follow-ups + interview-terms AI, set `ZOOM_CLIENT_ID/SECRET/ACCOUNT_ID` + `ZOOM_WEBHOOK_SECRET` in Vercel and add the webhook URL `https://<domain>/api/webhooks/zoom` in the Zoom app with `meeting.ended` + `meeting.summary_completed` events).
- [ ] **Step 2:** `npx vitest run` — full suite green. `node --check server.js`.
- [ ] **Step 3:** Commit `git commit -m "docs(contracts): pipeline ops note + buster sweep"`.

## Self-Review checklist (done at plan time)

- Spec coverage: withdrawn visibility (T1), no re-apply + popup (T2), image caching (T3), ", NSW"/mismatch (T1+T4), accept≠placement (T5), Not-proceeding segment removal (T6), Helen revert (T7), post-interview email instantly (T9+T15), practice offer/decline + upload (T10), AI vs zoom summary w/ supersede rule (T11), CEO review + submit (T12), GP view/sign/request changes (T13), change loop + practice consent (T14), signed → copies + congrats + placement (T13), works without Zoom (T15), docs (T16). ✔
- Type consistency: token purposes `post_interview_decision`/`contract_upload`/`contract_consent`; contract statuses consistent across T8/T10/T12/T13/T14; `finalizeInAppPlacement` reused only in T13 + staff paths. ✔
- No placeholders. ✔
