# CEO dashboard — Overview rebuild ("E") — build spec, 2026-11-05

Owner picked mockup E (`~/Downloads/gplink-ads-2026-10-refresh/overview-mockups/e-combined.html`):
a written brief on top, four status lights with their fix buttons, one lead→placement funnel whose
stages open a drawer of people with actions, then a three-column row: **Needs you · Doctors &
placements · Last 14 days**. Everything the old Overview showed (registration KPIs, pipeline,
trends, sources, waitlists, blockers, task health, RSO workload, velocity, placements, activity,
tickets, completions) moves — unchanged — to a new **Registration → Pipeline** sub-tab.

The caller is **Hayley** everywhere the owner reads (code keeps `hazel` keys/routes).
Never use an `ad-`/`ads-` class prefix or suffix (`-ad`, `-ads`): the owner's ad blocker hides them.
All new classes are `ov-*`.

## 1. Server

### 1.1 `GET /api/ceo/overview?window=7d|30d`  (server.js, next to `/api/ceo/dashboard`)
- `requireCeoSession`; 503 `{ok:false,message:'Requires Supabase.'}` when `!isSupabaseDbConfigured()` (same as dashboard).
- `window` defaults to `7d`; anything else → `7d`.
- Fetch everything in one `Promise.all` with `supabaseDbRequest` and SIMPLE filters only (eq / in / is.null / gte — never `or=`):

| table | query |
|---|---|
| site_enquiries | `select=id,created_at,name,email,phone,state,status,metadata&kind=eq.gp&created_at=gte.<now-90d ISO>&order=created_at.desc&limit=3000` |
| lead_calls | `select=id,enquiry_id,direction,status,outcome,disconnection_reason,started_at,duration_s,cost_cents,created_at&created_at=gte.<now-31d>&order=created_at.desc&limit=3000` |
| scheduled_calls | `select=id,invitee_email,scheduled_at,booked_at,completed_at,no_show_at,cancelled_at,status,meeting_kind,host_kind,zoom_join_url,created_at&meeting_kind=eq.consultation&order=scheduled_at.desc&limit=1000` |
| user_profiles | `select=user_id,first_name,last_name,email,created_at,onboarding_completed_at,account_status&order=created_at.desc&limit=3000` |
| registration_cases | `select=id,user_id,stage,status&limit=5000` |
| registration_tasks | `select=id,case_id,title,escalated_reason,escalated_at&status=eq.escalated&order=escalated_at.desc&limit=20` |
| user_documents | `select=id,status,created_at&status=in.(uploaded,under_review)&limit=2000` |
| career_roles | `select=id,job_status,is_active&limit=3000` |
| practices | `select=id,is_active&limit=3000` |
| placements | `select=id,practice_name,location,start_date,status,placed_at,created_at&order=created_at.desc&limit=200` |
| career_contracts | `select=id,user_id,status,contract_filename,ai_review,sent_to_gp_at,created_at&order=created_at.desc&limit=50` |
| incoming_email_todos | `select=id,sender_email,subject,ai_urgency,ai_summary,matched_user_id,created_at&resolved_at=is.null&ai_urgency=eq.urgent&order=created_at.desc&limit=10` |
| ad_reviews | via existing `adsListReviews({ withSnapshot: true, limit: 1 })` (snapshot) and `adsListReviews({ kinds:['daily','manual'], okOnly:true, limit:1 })` (review) |
| ad_drafts | via existing `adsListDrafts()` |
| runtime_kv | via existing `ceoHazelStatus(cfg)` with `cfg = await leadCallsConfig()` |

Every fetch degrades to `[]`/`null` on failure (never 500 because one table hiccuped).
Then `sendJson(res, 200, ceoOverview.buildOverview({...rows, nowMs, window, tz, hazelCfg, hazelStatus, noContactOutcomes: CEO_LEAD_NO_CONTACT_OUTCOMES, metaConfigured: !!metaAds.adsConfig(process.env).token }))`.
`tz` = `metaAds.adsConfig(process.env).accountTimeZone` (Australia/Sydney).

### 1.2 `lib/ceo-overview.js` — pure, exported `buildOverview(input)` + helpers (`localDayKey(date, tz)`, `briefSegments(...)`). Re-filter every date window inside the lib (the DB `gte` is only a cap).

Definitions (all "window" = rolling `7×24h` or `30×24h` back from `nowMs`; "local day" = calendar day in `tz` via `Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'})`):
- **Cohort leads** = site_enquiries created in window, `metadata.source !== 'zoho_import'`.
  - `leads_meta` source === `meta_lead_ad`; `leads_direct` source === `calendly_direct`; `leads_site` = everything else.
  - `hayley_rung` = cohort with `consult.ai_call` object; `hayley_spoke` = cohort where any `consult.ai_calls[]` entry has `duration_s > 0` and outcome not in `noContactOutcomes`.
  - `booked` = cohort with `consult.call_booked_at` (or `call_booked === true`); `attended` = cohort with `consult.call_completed_at`.
- **Consults** = scheduled_calls rows with `meeting_kind === 'consultation'` and `(host_kind || 'ceo') === 'ceo'`, `status !== 'cancelled'`.
  - `upcoming` = status `booked` and `scheduled_at > now`, ascending, cap 6: `{id, name, email, at, source, zoom_join_url}` — name = matching site_enquiries row by lower-cased email, else user_profiles by email, else the email's local part; source = lead's `consult.booked_via==='hazel'?'Hayley booked': source label` (`meta_lead_ad`→'Meta lead', `site_start_form`→'Website /start', `calendly_direct`→'Calendly direct', else source).
  - `today` = upcoming whose local day == today's local day. `next` = first upcoming.
  - `booked_window` = `booked_at` (fallback `created_at`) in window; `held_window` = `completed_at` in window; `no_show_window` = `no_show_at` in window.
- **Accounts** = user_profiles (account_status !== 'archived'); `accounts_window` = created in window; `onboarded_30d` = `onboarding_completed_at` in 30d; `incomplete` = no `onboarding_completed_at`; `incomplete_ids` cap 40 newest.
- **Hayley** (lead_calls, direction outbound unless noted):
  - window stats: `calls`, `spoke` (duration_s>0 and outcome not in noContact), `booked` (outcome booked), `callbacks` (outcome callback_requested), `voicemail`, `no_answer`, `mins` (Σduration_s/60, 1dp), `cost` (Σcost_cents/100, 2dp).
  - `last_call_at` = newest row with status in (ended, not_connected). `credit_exhausted_at` = newest row with `disconnection_reason==='credit_exhausted'`. `calls_24h`.
  - `not_rung` = cohort-7d leads with a phone, not `consult.stopped`, not booked, and (no `ai_call` OR `/402|credit/i.test(ai_call.error)`), cap 10: `{id,name,created_at,source,error}`.
  - `state`: `!configured`→`grey`; `!enabled`→`amber` ("switched off"); `credit_exhausted_at` newer than `last_call_at` and within 7d→`red`; `calls_24h===0` and `calls` (7d) > 0 → `amber`; else `green`. `headline` + `detail` strings per state (see §3).
- **Meta** (snapshot = latest ad_reviews row with a snapshot; review = latest ok daily/manual):
  - `live_ads = snapshot.live_ads` (number, null if no snapshot); `adsets = snapshot.adsets[]` → `{name,status,daily_budget,last_edit_at}`; `paused_since` = max `learning.last_edit_at` among PAUSED ad sets (null if none).
  - `totals = snapshot.totals` (pass `last_7d`, `last_30d`, `prior_7d`, `yesterday` through: spend, leads, cost_per_lead, reach, frequency, link_clicks, click_to_lead_pct).
  - `funnel7/30 = snapshot.funnel.d7/d30` (booked, signed_up, cost_per_booking) when present.
  - `review = {date: review.created_at, headline, summary (≤600 chars), actions_today[] {where, action, why}}`.
  - `drafts` = ad_drafts with status in (draft, ready, scheduled), newest 8: `{id, headline, angle, status, launch_at, has_image: !!(image_path||photo_path)}`; `drafts_ready` = count with has_image.
  - `state`: `!metaConfigured || !snapshot`→`grey`; `live_ads===0`→`red`; snapshot `fetched_at` older than 36h→`amber`; else `green`.
- **Registration**: `escalated` count + top 3 `{task_id, case_id, title, reason, at}`; `docs_to_review` = user_documents count; `docs_7d` = of those created in 7d; `urgent` = email todos top 3 `{id, who (profile name via matched_user_id, else sender domain), subject, summary (≤160), created_at, user_id}`; `cases = {active, by_stage:[[label,count]]}` using stage labels MyIntealth/AMC/Secure Placement/AHPRA/PBS & Medicare/Commencement (visa→PBS). `state`: urgent.length→`red`; escalated>0 or docs_to_review>0→`amber`; else `green`.
- **Needs**:
  - `replies` = site_enquiries (≤90d) with `consult.call_back_by` and no `consult.call_back_done_at`, newest first, cap 8: `{id, name, phone, quote, when, booked_at: consult.call_booked_at||'', call_at: consult.call_at||'', has_account: consult.stopped==='signed_up', not_gp_hint: /health ?care assistant|nurse|pharmac|not a (gp|doctor)/i.test(note)}`. `quote` = text inside the first "…" in `consult.call_back_note`, else the note (≤80 chars); `when` = `consult.replied_at || consult.zoho_wa_replied_at || created_at`.
  - `contracts` = career_contracts where `ai_review.overall` ∈ (major_discrepancies, discrepancies) and status ∉ (signed, withdrawn, archived), cap 3: `{id, who (profile name), status, sent_to_gp_at, summary (≤200)}`.
  - `escalations` = registration.top 3 (same objects).
- **Doctors**: `accounts_window, accounts_total, onboarded_30d, incomplete, incomplete_ids, open_jobs` (career_roles `job_status==='open' && is_active!==false`), `practices` (is_active!==false), `placements_active` (status active), `placements_window` (placed_at||created_at in window), `latest_placement {practice_name, location, start_date}`, `recent` = 6 newest profiles `{user_id, name, created_at, onboarded, stage}` (stage = case stage label, 'Signed up only' when no case), `docs_to_review, docs_7d`.
- **Funnel** = `{ spend, cpl (totals for window), leads, leads_meta, leads_site, leads_direct, hayley_rung, hayley_spoke, booked, cost_per_booking (spend/booked, null if 0), attended, consults_held (held_window), accounts (accounts_window), onboarded_30d, placed (placements_window), placements_active, open_jobs, people: { leads[], spoke[], booked[], attended[], accounts[] } }` — each people list ≤ 12 of `{kind:'lead'|'user', id, name, sub, phone?, zoom_join_url?}` (`sub` = e.g. "Today · Meta lead · Hayley: voicemail", "Thu 6 Nov 12:00 · Hayley booked", "Attended 2 Nov", "Mon 2 Nov · onboarding not finished · MyIntealth"). Dates formatted in `tz` as `Thu 6 Nov 23:00`.
- **Series**: 14 local days ending today: `days[]` labels (`'22 Oct'`, then `'23'`…, first-of-month as `'1 Nov'`), `leads[]`, `booked[]` (consult booked_at), `signups[]`.
- **Tiles**: `{ cost_per_booking, cost_per_booking_30d, hayley: {calls, spoke, booked, mins, cost} }`.
- **Brief** (`brief: { date_label, segments: [{t, k?}] }`, `k` ∈ `b` | `bad` | `good`), from `since = start of yesterday (local)`:
  1. `Since yesterday: ` + **N new lead(s)** (`+ ' (' + up to 2 names + ', ' + source + ')'`) + ` and ` + **H Hayley call(s)** [bad when 0] + reason: credit red → ` because Retell credit ran out at HH:MM on DAY`; `!enabled` → ` because the dialler is switched off`; else `.`
  2. **B consult(s) booked** ` and ` **A attended** (` since yesterday`) + `, none missed.` | `, M missed.` — or `No consults were booked or held since yesterday.` when all zero.
  3. Meta red: **No ads are running** [bad] + `: every ad set has been paused since DAY` + (yesterday spend>0 && leads==0 ? `, and yesterday's $X bought no leads before it stopped.` : `.`). Meta green/amber: `Ads spent $X yesterday for N lead(s).` Grey: `Meta is not connected.`
  4. `This week: ` + **L leads, B booked, A attended, S new app account(s)** [good] + ` on $SPEND of spend` + (both red: ` — but both engines that feed it are off right now.` | one red: ` — but Hayley is off right now.`/` — but the ads are off right now.` | `.`).
  Numbers: `$` with no decimals; plural helper.

Top level: `{ ok:true, now, window, tz, generated_in_ms, brief, status:{meta,hayley,consults,registration}, funnel, needs, doctors, series, tiles }`.

### 1.3 Small action routes
- Extend the per-lead regex to `/^\/api\/ceo\/leads\/([^/]+)(?:\/(call|hazel|callback-done))?$/` and add `ceoLeadCallbackDone(row, nowMs)`: `consult.call_back_done_at = ISO(now)`, `consult.call_back_done_by = 'ceo'`, persist via `updateSiteEnquiryRow(row.id, { metadata })`; 200 `{ok:true}`. Update `tests/ceo-leads-tab-wiring.test.js` (its regex assertion) accordingly.
- "Mark handled" for an urgent email uses the EXISTING `POST /api/admin/va/incoming-questions/:id/resolve` (requireAdminSession — the super admin passes it).
- Everything else already exists: `POST /api/ceo/leads/:id/call`, `POST /api/ceo/leads/:id/hazel {action}`, `POST /api/ceo/escalation/:id/resolve|respond`, `POST /api/ceo/ads/draft/launch-now {id}`, `POST /api/ceo/ads/review`, `POST /api/admin/va/nudge {user_id}`, `POST /api/ceo/owner-digest/send`.

### 1.4 Tests (`tests/ceo-overview.test.js`)
- Unit: `buildOverview` with a fixture set (≈8 leads incl. one with a 402 error + no `ai_call`, one call_back_by reply, one booked; lead_calls with a `credit_exhausted` row newer than the last ended call; 3 consults incl. 1 upcoming today in tz; profiles; a contract with `major_discrepancies`; an urgent todo; a snapshot with `live_ads:0` and a PAUSED ad set). Assert: funnel counts, people lists, hayley.state `red` + brief sentence contains `Retell credit`, meta.state `red` + brief contains `No ads are running`, replies quote extraction, series length 14, no `ip`/`user_agent` anywhere in `JSON.stringify(payload)`.
- Route: boot the real server against an in-memory PostgREST emulator (copy the harness from `tests/account-export.test.js`, add `gte`/`lte` to the matcher, seed the tables above incl. `ad_reviews`, `ad_drafts`, `runtime_kv`), super-admin cookie as in `tests/ceo-leads-endpoint.test.js`: 401/403 without cookie; 200 shape; `window=30d` respected; `POST /api/ceo/leads/:id/callback-done` stamps `call_back_done_at` (assert via emulator row).

## 2. Page

### 2.1 `pages/ceo-dashboard.html`
- `#panel-registration` becomes `<div class="master-panel ats-scope" id="panel-registration"><div id="overviewRoot"></div></div>`.
- The old `#timeFilterBar` + `<div class="content" id="mainContent">…pageLoading…</div>` move VERBATIM into a new `<div class="reg-subpanel" id="regSub-pipeline" style="display:none">` under `#panel-rso`, and a third sub-tab button `<button class="reg-subtab" data-regsub="pipeline" type="button">Pipeline</button>` goes between RSOs and Guides. `ensureRegSubnav` shows/hides it like the others; opening it calls `refreshDashboard({ force: true })` when `!dashboardData || dashboardStale`.
- `var regSubActive = 'rsos'` updated in the sub-nav click handler. `overviewActive()` → `return !!window.ATS && window.ATS.activeTab === 'rso' && regSubActive === 'pipeline';` (comment: the old Overview now lives there). `loadRsoTab` additionally catches up the pipeline when `regSubActive === 'pipeline'` (same rule the old loadRegistrationTab used).
- `window.loadRegistrationTab = function (opts) { if (typeof window.loadOverviewTab === 'function') window.loadOverviewTab(opts || {}); };`
- Boot (the `checkAuth().then` block): after the consultant check, keep the existing `Promise.all([...])` AND start the new Overview: poll up to 40×50 ms for `window.loadOverviewTab`, then `if (!window.ATS || window.ATS.activeTab === 'registration') window.loadOverviewTab();` and stamp `window.ATS.tabLoadedAt.registration = Date.now()`.
- `renderLoadError` keeps writing into `#mainContent` (now the Pipeline sub-tab) — fine; the watchdog is only about the old payload.
- Script tags: add `<script src="/js/ceo-overview.js?v=20261105a"></script>` right after `ceo-ats-contracts.js`; stylesheet `<link rel="stylesheet" href="/css/ceo-overview.css?v=20261105a" />` after `ceo-social.css`. Bump `ceo-ats-leads.js` to `?v=20261105a` (it gains `window.CeoLeads.open`).
- `css/ceo-ats.css` lines ~103–110: the `#panel-registration .time-filter-bar/.time-btn/.ceo-topnav` rules become `#regSub-pipeline …` (keep the old selector too).

### 2.2 `js/ceo-ats-leads.js`
Export `window.CeoLeads = { open: function (id) { … } }` — if the tab scaffold isn't mounted, mount it (`loadLeadsTab()`), then `openDrawer(id)`. Overview uses it after `window.ATS.showMaster('leads')`.

### 2.3 `js/ceo-overview.js` (IIFE, same style as `js/ceo-ats-leads.js`; uses `window.ATS` for `api/esc/escAttr/toast/setOverlay/showMaster/initials`)
State: `{ window: localStorage 'gp_ov_window' || '7d', data, loadedAt, inflight, timer }`.
`window.loadOverviewTab(opts)`: root = `#overviewRoot`; if `opts.quiet` and `data` fresh (< 2 min) → `render()` then background `fetch()`; else paint the skeleton (header + 4 grey status boxes + "Loading…") and `fetch()`. `fetch()` = `ATS.api('/api/ceo/overview?window=' + w)`; on `!ok` paint an honest error card with a Retry button (never an eternal spinner). Auto-refresh every 60 s and on `visibilitychange`, only while `window.ATS.activeTab === 'registration'` and the page is visible. After every mutation call `fetch()` and `window.CeoReviewQueue && CeoReviewQueue.refresh()`.

Layout (exactly mockup E; classes `ov-*`):
1. Toolbar: `Overview` h2 · window segmented control (7 days / 30 days) · "Email me this" (`POST /api/ceo/owner-digest/send`).
2. Brief card: `date_label` h2, the segments as `<b>`, `<b class="ov-bad">`, `<b class="ov-good">`; right-aligned mono note `from live data · refreshed HH:MM`.
3. Status strip (4 boxes, red/amber/green/grey border tints):
   - **Meta ads** — headline from state (`0 ads live · paused since D Mon` / `N ads live` / `Meta not connected` / `numbers N h old`), detail (`Yesterday $X for N leads. Review: <headline ≤ 110 chars>`), buttons: `Relaunch…` (drawer §2.4) · `Ads Manager ↗` (`https://adsmanager.facebook.com/`, new tab).
   - **Hayley (calls)** — headline per state (`Out of Retell credit since DAY HH:MM` / `Switched off` / `No calls in 24 h` / `N calls today · B booked this week`), detail (`calls_24h`, `not_rung.length` leads not rung, `callbacks` promised), buttons: `Top up Retell ↗` (`https://dashboard.retellai.com/`), `Ring the N waiting` (confirm, then sequential `POST /api/ceo/leads/:id/call`, toast per result) — hidden when nothing is waiting; when amber "switched off" show `Leads tab ›`.
   - **Consults** — `N today · B booked this week` (or `None today · next DAY`), detail `H held, M missed. Next: NAME, DAY HH:MM`, buttons: `Today's prep` / `Next consults` (drawer: upcoming with `Zoom ↗`, `Prep` → opens the lead) · `Meetings ›` (`ATS.showMaster('meetings')`).
   - **Registration** — headline (`1 AHPRA deadline · 10 escalations` style from urgent.length/escalated), detail (`docs_to_review` waiting, first urgent `who`), buttons: `Open doctor` (`location.hash='#candidate='+user_id` when urgent) · `Review docs (N)` (`CeoReviewQueue.show()`, else `ATS.showMaster('candidates')`) · `Registration ›` (`ATS.showMaster('rso')`).
4. Funnel card: 7 stages (Meta spend · Leads · Hayley spoke to · Consult booked · Attended · App account · Placed) with number, proportional bar (one hue; spend/placed in purple), caption, `open ›` on hover. Click → drawer listing `funnel.people[stage]` rows with actions: lead rows `Ring` (`/call`) + `Open` (`CeoLeads.open`); booked rows `Zoom ↗` + `Open`; account rows `Open profile` (`#candidate=`); footer link `See all in Leads tab`. Spend stage opens the Relaunch drawer; Placed opens `Matching board` / `Candidates` links.
5. Lower row (3 columns; 1 column under 1100px): 
   - **Needs you** (`N items` pill): reply rows (`NAME replied "QUOTE"` + auto note: `Consult already booked DAY` / `Has an account, onboarding not finished` / `Not a GP? mark not qualified` → buttons `Call now` or `Not a GP` (`/hazel {action:'do_not_call'}`, confirm) + `Done` (`/callback-done`, row fades)); contract rows (`Review` → `ATS.showMaster('contracts')`); escalation rows (`Resolve` → `/resolve`, `Reply` → prompt + `/respond`); urgent email rows (`Open doctor`, `Handled` → `/api/admin/va/incoming-questions/:id/resolve`). Empty state: `Nothing waiting on you.`
   - **Doctors & placements** (amber/green light): contract alert box when `needs.contracts.length`; 4 number boxes (New app accounts · Onboarded 30d / N stuck · Open jobs / practices · Placements active); `Sign-ups per day` 14-bar chart; `Signed up this week` rows (`Nudge` → `/api/admin/va/nudge {user_id}` or `Open` → `#candidate=`); `Waiting on you`: `N documents to review` (Review), `N accounts never finished onboarding` (`Nudge all` → confirm → sequential nudges over `incomplete_ids`, cap 25, progress toast), `Latest placement` (Board → `ATS.showMaster('matching')`).
   - **Last 14 days**: legend (Leads · Booked), two 14-bar charts (last bar in the accent colour, others grey, `<title>` per bar), then two tiles: `Cost per booking` (window vs 30d) and `Hayley: calls → booked` (`mins · $cost`).
Charts are inline SVG, bars ≤ 24px wide, 2px gaps, no axes clutter; one hue per chart (blue leads, purple booked, green sign-ups).
Numbers: `$` no decimals; `—` when null. Dates via `new Date(iso).toLocaleString('en-AU', { timeZone: data.tz, weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' })`.
Every mutation: disable the button, call, toast success/failure (`ATS.toast`), then `fetch()`.
Drawer: `ATS.setOverlay('<div class="ats-scrim open"></div><aside class="ats-drawer ov-drawer open">…</aside>')`, scrim/Esc/Close all clear the overlay (mirror `wireDrawer` in the leads module).

### 2.4 Relaunch drawer
Review headline + `actions_today` list (action + why), then draft rows (`headline`, angle, status pill, `has_image` ? `Launch now` (confirm → `POST /api/ceo/ads/draft/launch-now {id}`; on `ok` toast + refetch; on error show `message`) : `No photo yet`), buttons `Open Ads hub` (`ATS.showMaster('social')`), `Run review now` (`POST /api/ceo/ads/review`), note "Live ads can't be paused from here — the ad-set switch stays in Ads Manager."

### 2.5 `css/ceo-overview.css`
Port the mockup's `shared.css` component rules (status boxes, tiles, funnel stages, rows, drawer rows, number boxes, alert boxes, bars) under `ov-*` names, scoped to `#overviewRoot` / `.ov-drawer`, using the page's existing tokens (`--panel`, `--panel-border`, `--text-muted`, `--blue`, `--red`, `--amber`, `--green`, `--purple`, `--radius`, `--radius-lg`, `--mono`). Breakpoints: 1100px (lower row → 1 col, funnel 4 cols, status 2 cols) and 760px (funnel 2 cols, status 1 col).

### 2.6 Tests
- `tests/ceo-overview-wiring.test.js` (mirror `tests/ceo-leads-tab-wiring.test.js`): script + css tags at `?v=` ≥ `20261105a`; module defines `window.loadOverviewTab`, handles `opts.quiet`, paints its own failure ('hit an error while drawing'); page delegates `window.loadRegistrationTab` to it; page has `id="overviewRoot"`, `data-regsub="pipeline"`, `id="regSub-pipeline"`; every endpoint string the module calls exists in `server.js`; no class matches `/^ad-|-ad$|-ads$|^ads-/` in the module or stylesheet.
- Existing suites that must still pass: `tests/ceo-overview-ats-parity.test.js`, `tests/ceo-leads-tab-wiring.test.js`, `tests/ceo-ats-review-ui.test.js`, `tests/ceo-endpoints-smoke.test.js`, `tests/ceo-rso.test.js`, `tests/ceo-review-queue.test.js`. (`tests/ceo-dashboard-perf.test.js` already fails on origin/main — note its before/after state, don't chase it.)

## 3. Copy (status headlines)
- meta red: `0 ads live · paused since {D Mon}` / detail `Yesterday ${spend} for {n} lead(s). Review: {headline}`; amber: `{n} ads live · numbers {h} h old`; green: `{n} ads live · ${spend7} this week`; grey: `Meta not connected`.
- hayley red: `Out of Retell credit since {Day HH:MM}`; amber off: `Switched off (LEAD_CALLS_ENABLED)`; amber quiet: `No calls in 24 h`; green: `{calls_24h} calls today · {booked} booked this week`; grey: `Not configured`.
- consults: `{today} today · {booked_window} booked this week` / `None today · next {Day HH:MM}`.
- registration: `{urgent} AHPRA/regulator email(s) · {escalated} escalations` / `{escalated} escalations · {docs} docs to review` / `All clear`.
