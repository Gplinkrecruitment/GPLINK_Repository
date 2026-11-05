# CEO dashboard — Overview rebuild handover (2026-11-05)

## 1. What is live

The **Overview** master tab of `pages/ceo-dashboard.html` is now the owner's "run the company"
page, built from mockup E (chosen 4 Nov from four localhost options):

1. **Brief** — a written paragraph ("Since yesterday: 2 new leads … and 0 Hayley calls because
   Retell credit ran out …"), generated on the server from the numbers (no model call).
2. **Four status lights** with their fix buttons — Meta ads (live ads, paused since, drafts →
   Relaunch drawer, Ads Manager link), Hayley (credit-out detection, not-rung leads → "Ring the N
   waiting", Retell link), Consults (today / this week / next → consults drawer, Meetings tab),
   Registration (urgent regulator emails, escalations, documents to review → Review queue).
3. **Funnel** for 7 or 30 days — Meta spend → Leads → Hayley spoke to → Consult booked →
   Attended → App account → Placed. Each stage opens a drawer of the people in it with Ring /
   Open / Zoom buttons.
4. **Needs you · Doctors & placements · Last 14 days** — WhatsApp replies waiting for a human
   (Call now / Not a GP / Done), flagged contracts, escalations, urgent emails; sign-ups,
   onboarding, jobs, placements with Nudge / Nudge all; two 14-day bar charts and two tiles.

Everything the old Overview showed (registration KPIs, pipeline funnel, trends, conversion
funnel, sources, waitlists, blockers, task health, RSO workload, velocity, placements, activity,
tickets, completions, the period filter, drilldowns) is **unchanged** and lives under
**Registration → Pipeline** (third sub-tab). Its 30 s / 5 min timers only run while that sub-tab
is on screen (`overviewActive()` now means `activeTab === 'rso' && regSubActive === 'pipeline'`).

## 2. Files

| File | Role |
|---|---|
| `lib/ceo-overview.js` | Pure `buildOverview(input)` — every number, list, state and the brief. Re-filters every date window itself; the DB `gte` is only a cap. Returns a deep copy (sendJson redacts shared references as `[redacted-circular]`). |
| `server.js` `GET /api/ceo/overview?window=7d\|30d` | One `Promise.all` over site_enquiries (90 d), lead_calls (31 d), scheduled_calls (consultations), user_profiles, registration_cases, escalated registration_tasks, user_documents (uploaded/under_review), career_roles, practices, placements, career_contracts, urgent unresolved incoming_email_todos, the latest `ad_reviews` snapshot + review, `ad_drafts`, and `ceoHazelStatus`. Every fetch degrades to empty. |
| `server.js` `POST /api/ceo/leads/:id/callback-done` | Stamps `consult.call_back_done_at` / `call_back_done_by: 'ceo'` (the "Done" button on a reply row). Regex is now `(call\|hazel\|callback-done)`. |
| `js/ceo-overview.js` | The page module: `window.loadOverviewTab(opts)`, 60 s polling only while the tab is visible, quiet re-entry never blanks, every failure paints Retry. `window.loadRegistrationTab` delegates to it. |
| `css/ceo-overview.css` | `ov-*` classes only (ad-blocker rule), plus the `#regSub-pipeline` rules that used to target `#panel-registration`. |
| `js/ceo-ats-leads.js` | `window.CeoLeads.open(id)` so the Overview can open a lead drawer. |
| `tests/ceo-overview.test.js` | 18 unit + 7 route tests (emulator). `tests/ceo-overview-wiring.test.js` pins tags, loaders, endpoints and the no-`ad-` rule. `tests/ceo-dashboard-perf.test.js` updated for the new gating. |
| `docs/superpowers/specs/2026-11-05-overview-e-spec.md` | The contract this was built to. |

## 3. Decisions (don't "fix" these back)

- **Deterministic brief, not a model.** It must load in well under a second every time the tab
  opens; the daily Opus ads review stays on the Social tab.
- **Hayley red = credit out**: newest `lead_calls` row with `disconnection_reason` of
  `credit_exhausted` or `no_valid_payment` that is as new as the last connected call. Retell
  reports an empty balance both ways.
- **Funnel is a cohort**: leads *created* in the window, then what happened to them. "Attended"
  therefore differs from "consults held this week" (shown in the stage caption).
- **Zoho imports are excluded** from the funnel cohort (their created_at is the import time).
- **Live Meta ad sets cannot be paused from the app** (no route) — the button is a link to Ads
  Manager. Retell top-up is a link to Retell.
- **The old payload still loads once at boot** (`refreshDashboard({force:true})`) because the
  header escalation badge and the review queue hang off it; it then idles until the Pipeline
  sub-tab opens.
- `css/ceo-ats.css` was left at `?v=20261030a` because `tests/ceo-review-queue.test.js` pins it;
  the moved selectors live in `ceo-overview.css` instead.

## 4. Verified

- `npx vitest run` full suite on 2026-11-05 (see the commit message for counts).
- Real page rendered end-to-end in headless Chrome (CDP) against the real server booted on a
  seeded in-memory PostgREST emulator with an admin cookie: Overview, Relaunch drawer, funnel
  drawer, 30-day toggle, Registration → Pipeline, back to Overview. Harness lived in the job's
  tmp dir (`verify/run.cjs`), not in the repo; rebuild from the recipe in
  `2026-10-30-leads-tab-hazel-handover.md` if needed (plus `process.chdir(worktree)` before
  importing server.js — static files resolve from cwd).

## 5. Still open

- "Cancel the test bookings" from the mockup was not built (no Calendly cancel route).
- Status headlines are server copy; if the owner wants different wording, edit
  `lib/ceo-overview.js` (`status.*.headline/detail`) — the page prefers server copy when present.
- `tests/ceo-dashboard-perf.test.js` note from the build: it was passing on origin/main (the
  earlier "known failure" note in session memory is stale).

## 6. Same day, second commit — origins and the Review docs button (owner report 2026-11-05 17:53)

- **"Review docs" did nothing.** Two causes: the count (19) was every `user_documents` row in
  `uploaded`/`under_review`, which is not what needs the owner, and the button handed off to the
  review-queue modal, which had no such items and so closed itself. Now the number is the review
  queue's own definition — open `doc_review` / `flagged_doc` tasks (`ATS_DOC_REVIEW_OPEN_FILTER`),
  fetched as `doc_review_tasks` — and the button opens an Overview drawer listing them
  (`registration.docs_list`, newest 12) with Review → `#candidate=<case_id>&focus=docs`. The button
  is hidden when nothing is waiting.
- **Every "Needs you" row opens where it came from** (click the row text; the hover tooltip says
  where): WhatsApp replies → the DoubleTick chat (`GET /api/ceo/leads/:id/whatsapp-link` asks
  DoubleTick's embed API once for the number via `fetchDoubleTickCustomerId`, stores the answer in
  `consult.doubletick_url`, and the page opens it in a new tab; a lead with no chat yet gets a toast
  and the lead drawer instead); escalations → `registration_tasks.doubletick_conversation_url`, else
  the Gmail thread (`gmail_thread_id` / `source_gmail_message_id` / `gmail_message_id`), else the
  GP file's Tasks tab under Registration → RSOs (`openGpDetail`, opened with `setActiveTab('rso',
  true)` so the roster loader does not repaint over it); urgent regulator emails → the Gmail message
  (`incoming_email_todos.gmail_message_id`); contracts → the Contracts tab. The payload carries
  `origin {kind, url}` on escalations, `gmail_url` + `case_id` on urgent emails, `doubletick_url` on
  replies, and `case_id` on recent sign-ups and the funnel's account rows.
- Candidate deep links now pass the registration **case id** (`atsOpenCandidate` takes a case id;
  user ids were only working through its fallback).
- Cache busters: `ceo-overview.js` / `.css` → `?v=20261105b`.

## 7. Same day, third commit — "today" is the owner's day (owner report 2026-11-05 18:39)

The owner asked why the Consults light said "None today" when he had one. Both the table and
Calendly's own emails showed the only candidate (Mercy, 11:30pm Sydney that night) had been
cancelled by the invitee ("Rebook") and moved to the next night, so the data was right — but the
page was printing Sydney times to an owner whose clock is UTC+8, and "today" was the Sydney day.
Now `js/ceo-overview.js` sends `&tz=<Intl.DateTimeFormat().resolvedOptions().timeZone>` and the
route uses it (validated with `Intl.DateTimeFormat`; junk falls back to the ad account's zone) for
the brief's "since yesterday", "today"'s consults, the 14-day series and every printed time, and
echoes it as `tz`. `?v=20261105c`.

## 8. Same day, fourth commit — Zoom is the truth for consult times (owner report 2026-11-05 19:04)

The owner's "consultation today" was Vishal Chaudhary: booked through Calendly for Sunday 1 Nov
(Zoom meeting 865 2610 5611), missed because he was unwell, then **moved to Thursday by hand in
Zoom**. Calendly never sends anything for that, so `scheduled_calls` still said "Sunday, completed"
and the lead still carried `call_completed_at` + `call_attended: false`. Fix: `lib/zoom-reconcile.js`
(`planZoomReconcile`) compares the host's upcoming Zoom meetings (`listZoomUpcomingMeetings`,
`GET /users/me/meetings?type=upcoming`) with the rows that carry those `zoom_meeting_id`s and
moves any row whose Zoom start differs by a minute or more: `scheduled_at` → Zoom's time,
`status` → `booked`, `completed_at`/`no_show_at` cleared when it was judged already, the lead's
`call_at` restamped (`ensureLeadBookedCallAt`) and its `call_completed_at` / `call_attended` /
`call_attendance_*` cleared (`clearLeadConsultOutcome`) so the post-call WhatsApp and drip judge
the new slot. A `cancelled` row is never resurrected. Runs first thing in `/api/cron/detect-no-shows`
(every 10 min; result under `zoomReconcile`) and, throttled to once per 10 min and capped at 4 s,
when `/api/ceo/overview` loads. Tests: `tests/zoom-reconcile.test.js` (planner) and two route
cases in `tests/ceo-overview.test.js` (the emulator there now understands `ilike`).
Known gap: a consult the owner *deletes* in Zoom is not cancelled here (Calendly still owns
cancellations); and a reschedule done in Calendly keeps working as before.
