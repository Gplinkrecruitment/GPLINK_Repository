# Metrics and the Australian pathway (WP-27)

**The rule in one sentence.** With the Australian switch on, every number about
overseas registrations is worked out from the overseas doctors' rows only, so
it reads exactly the same whether or not an Australian doctor exists;
Australian doctors are counted in their own pipeline. With the switch off
nothing here runs and every response and email is what it was.

Who is "Australian" for a metric: a doctor on any of the four Australian
pathways, or part-way through the Australian onboarding branch (the sweep
index, `auSweepPathwayIndex`, CONVENTIONS section 15), plus any case whose own
row says Australian. A lead is Australian when `auLead.isAuSegmentLead` says so.

How it is done: one split per request (`auMetricsSplit(job)` in `server.js`),
two reads when the switch is on, none when it is off. Rows are filtered in
memory. Where an existing read did not name its doctor or case, the column is
added to the `select=` only with the switch on (and for the weekly series only
when there is at least one Australian doctor).

How it is proved: `tests/au-wp27-acceptance.test.js` captures every endpoint
below, the digest, the gone-quiet sweep and the review queue for an
overseas-only database and for the same database plus nineteen Australian
doctors, and fails, by path, on any difference that is not in the "everyone"
list of this file. `tests/au-wp27-parity-*.test.js` compare three snapshots
taken before the package (overseas-only switch on, overseas-only switch off,
overseas plus Australian switch off) byte for byte.

## Three kinds of metric

- **Overseas**: about the overseas registration journey by definition.
  Australian doctors are left out. An Australian counterpart exists where one
  makes sense.
- **Everyone**: true whoever the doctor is (a consult in the owner's diary, a
  document waiting for a person, a row in an export). Australian doctors are
  counted, on purpose.
- **Australian**: new, in the Australian pipeline only.

## The CEO Overview (`GET /api/ceo/overview`, `lib/ceo-overview.js`)

| Metric | Where shown | Definition | Who is counted | What changed |
| --- | --- | --- | --- | --- |
| Brief: new leads, Hayley calls, this week's leads / booked / attended / new accounts | Brief | Leads created since yesterday / in 7 days, and what happened to them | Overseas | Australian leads and accounts left out. The Australian section has its own sentence |
| Brief: consults booked / attended / missed since yesterday | Brief | The owner's own consult bookings | Everyone | Nothing |
| Meta ads light | Status strip | Ad account snapshot | Not about doctors | Nothing |
| Hayley light, "N leads not rung", Hayley tile | Status strip, tiles | Outbound calls and leads with a phone not yet rung | Overseas | An Australian lead is never rung (owner decision 7), so it is no longer listed as "not rung" and the "Ring the N waiting" button no longer counts it |
| Consults light: today, next, booked, held, missed; 14-day "booked" bars | Status strip, trend | The owner's consult bookings | Everyone | Nothing |
| Registration light: urgent regulator emails, escalations, documents to review | Status strip, Needs you | Things waiting on a person | Everyone | Nothing |
| Registration light: active cases, cases by stage | Status strip | Active cases per overseas stage | Overseas | Australian cases left out of the total (they were never in a stage row, but inflated "active") |
| Funnel: leads, Hayley spoke to, consult booked, attended | Funnel | A cohort: leads created in the window, then what happened to them | Overseas | Australian leads left out |
| Funnel: app accounts; Doctors: new accounts, total, onboarded, never finished, recent sign-ups; 14-day sign-up bars | Funnel, Doctors & placements | Profiles created / onboarded | Overseas | Australian doctors left out. "Nudge all" therefore sends no overseas nudge to an Australian doctor |
| Funnel: placed; Doctors: placements active, latest placement | Funnel, Doctors & placements | Placement rows | Overseas | Australian placements left out. "Latest placement ... starts" is now always an overseas placement |
| Open jobs, practices | Doctors & placements | Role and practice rows | Not about doctors | Nothing |
| Needs you: WhatsApp replies, flagged contracts, escalations | Needs you | Things waiting on the owner | Everyone | Nothing |
| Cost per booking | Tiles | Meta spend over cohort bookings | Overseas | Follows the cohort |
| **Australian GPs** | Its own card under the funnel | `au` in the payload: the pipeline below | Australian | New |

## Registration -> Pipeline (`GET /api/ceo/dashboard`, `/api/ceo/drilldown/*`, `lib/ceo-metrics.js`)

| Metric | Definition | Who is counted | What changed |
| --- | --- | --- | --- |
| KPI strip: Total GPs, Placed, Open tasks, Overdue, Blocked, Completed | Active cases and the tasks and secured applications on them | Overseas | Australian cases, their tasks and applications left out |
| Pipeline funnel (MyIntealth ... Commencement), cumulative and snapshot | Cases per overseas stage | Overseas | WP-03 already kept Australian stages out; Australian cases are now out of the population too |
| Hiring funnel strip under it (`ats_funnel`) | Applications per board stage | Overseas | Australian applications left out here (they are the Matched / Interview / Contract columns of the Australian pipeline) |
| Blockers | Blocked active cases | Overseas | Australian cases left out |
| Task health: open, in progress, overdue, completed this week, average days to resolve | Tasks on active cases | Overseas | Tasks on Australian cases left out (an Australian pre-start task has a different rhythm and was moving the average) |
| Velocity (average days between overseas stages) | Stage-change events | Overseas | Events on Australian cases left out |
| Placements & career: applied, submitted, interviewing, offers, secured | Applications of active doctors | Overseas | Australian applications left out |
| GP activity: active 7 d, inactive 7 to 14 d, **cold 14 d+**, the cold list | Days since the doctor last used the app | Overseas | Australian cases left out. An Australian doctor has nothing to do in the app between a match and the start, so they all read "cold" |
| Tickets: open, resolved this week, average hours | Support tickets of active doctors | Overseas | Australian doctors' tickets left out of the averages |
| Completions and recent milestones | Cases at `complete`, stage-change events | Overseas | An Australian `complete` (a finished placement) is not a completed registration |
| Trends, 12 weeks (`GET /api/ceo/trends`): new GPs, tasks created / completed, stage transitions, tickets, applications, placements secured, completions | Weekly counts | Overseas | Australian rows left out |
| Conversion funnel (`GET /api/ceo/conversion-funnel`): practice leads, practices signed, jobs live | Practice-side counts | Not about doctors | Nothing |
| Conversion funnel: GP applicants, placements; GP sign-ups, onboarding complete, placement secured | Doctor-side counts | Overseas | Australian doctors left out |
| Conversion funnel: interviews | The legacy `career_interviews` table | Overseas in practice | Nothing. No Australian flow writes that table |
| **Time to placement** (median and average days from sign-up and from first application) | Per placed doctor | Overseas | Australian placements left out: they close in weeks and were pulling the overseas figure down (36 days became 19 in the fixtures) |
| How GPs found us (`GET /api/ceo/source-attribution`) | The onboarding question | Overseas | Australian sign-ups are not counted as overseas sign-ups who skipped the question |
| Escalations (banner and header badge) | Escalated tasks | Everyone | Nothing |
| Documents waiting for review | Open document-review tasks | Everyone | Nothing |
| RSO workload (card, drilldown, `GET /api/ceo/rsos`, the RSO page's caseload strip) | Cases assigned to each RSO and their open tasks | Everyone **who is assigned** | An Australian case with nobody assigned is no longer counted in "Unassigned" (it has no RSO until pre-start). One assigned at pre-start counts as that RSO's work |
| **Australian pipeline** | Its own card beside the funnel | Australian | New (`GET /api/ceo/au-pipeline`) |

## The candidates board (shared by the CEO and consultants)

| Metric | Where | Who is counted | What changed |
| --- | --- | --- | --- |
| Pipeline buckets, board-stage counts (`GET /api/ceo/pipeline-summary`) | Candidates tab | Everyone | Nothing: the board lists every doctor, Australian ones badged (WP-26) |
| New applications, declined offers, interviews awaiting availability, waiting on practice (`GET /api/ats/attention` and the lists behind the tiles) | Needs attention strip | Everyone | Nothing: an application is an application |
| Onboarding waitlist (`GET /api/ceo/onboarding-incomplete`) | Candidates tab | Everyone | Nothing |
| **Gone quiet** (`stalled_applications`, `GET /api/ats/stalled-applications`, the daily email) | Tile, list, email | Everyone, each under their own threshold | 60 days for an overseas doctor (unchanged); 14 days for a doctor on an Australian pathway, behind a go-live guard. See below |
| Intent bands ("hot" ... "cold") on a candidate row | Candidates tab | Per doctor | Nothing here (WP-08 gave an Australian stage its place on the scale) |

## Staff pages and exports

| Metric | Where | Who is counted | What changed |
| --- | --- | --- | --- |
| Stuck cases (`GET /api/admin/stuck-cases`) | RSO page | Overseas | Nothing here (WP-04 left Australian cases out). The Australian view of "stuck" is time in stage in the pipeline, and the review queue |
| Legacy summary and "executive" numbers on `GET /api/admin/dashboard` (registered / EPIC / AMC funnel, stalled 7 and 14 days, verification backlog, average progress, applications) | Not drawn on any page today | Overseas | Australian doctors left out: they read as 0% and stalled for ever. The `candidates` and `tickets` lists are unchanged |
| `GET /api/admin/export?entity=gps|placements` | CSV | Everyone | Nothing: a row per doctor or placement, with a Pathway column (WP-13) |

## The emails

| Email | Sections | Who is counted | What changed |
| --- | --- | --- | --- |
| Weekly owner digest: the "this week" table, biggest movers, where things stand, registration funnel | Existing sections | Overseas | Identical with or without Australian doctors |
| Weekly owner digest: "Interviews booked" row | Existing | The legacy `career_interviews` table | Nothing. It reads a table the modern booking flow does not write, so it is 0 for overseas doctors as well: an existing fault, reported, not changed here |
| Weekly owner digest: **Australian GPs** | New block at the end (N22) | Australian | Pipeline counts, this week against last (leads, sign-ups, applications, interviews booked, placements, commenced), awaiting an Ahpra check, placements and commenced, typical time to placement, invoices due, in the guarantee period, guarantee ending, what needs the owner. Absent when there is no Australian doctor and no Australian lead |
| Daily gone-quiet email | One list | Everyone, each under their own threshold | An Australian section under the overseas list, with its own threshold in the heading. With no Australian item the email is exactly what it was |

There is no separate "CEO funnel" email in the code: the funnel is a section of
the weekly digest (above) and a card on the dashboard.

## The Australian pipeline (`lib/au-pipeline.js`)

**Matched -> Interview -> Contract -> Pre-start -> Commenced -> Guarantee**,
then **Complete** or **Ended**. Every Australian doctor is in exactly one group,
worked out from facts on file for their current placement cycle, never from a
stage someone typed.

| Group | A doctor is here when |
| --- | --- |
| Not counted | The account is archived, it is an owner test account, or the case is withdrawn |
| Finishing their profile | The profile is not finished and there is no application and no placement (includes a doctor part-way through the Australian onboarding questions) |
| Looking, not yet matched | The profile is finished; no open application; no current placement |
| **Matched** | There is at least one open application (applied, shortlisted, matched or submitted to the practice) and nothing further on |
| **Interview** | An open application is at the interview stage, has an interview booked, or has had one |
| **Contract** | An open application is at the offer stage (an offer or contract is out, or accepted with the placement not yet recorded) |
| **Pre-start** | The placement is recorded and the doctor has not started |
| **Commenced** | Staff confirmed the doctor started, fewer than 7 days ago |
| **Guarantee** | Started 7 or more days ago and the 12-week guarantee period is still running (its last day counts) |
| Complete | The guarantee period has finished, the doctor is still there and is not looking again |
| Ended | The doctor left, and is not looking again |
| **Needs review (not launched)** | The pathway is segment B or C (built, not launched) and there is no current placement. Shown apart, never in a pipeline column. Once staff record a placement for such a doctor they are in Pre-start onwards, marked with their segment |

- The furthest fact wins (an interview on one application and an offer on
  another is Contract).
- **One column per doctor per placement cycle.** A doctor whose first placement
  finished and who is looking again is counted once, in the new cycle's column.
  Placements, commencements and the commercial figures are per placement.
- A placement is judged on its own practice's calendar date.
- The placement half is `auLifecycle.caseStageFromPlacementFacts`, the function
  the daily job moves the case with.

Figures in the Australian section, all Australian-only:

| Figure | Definition |
| --- | --- |
| Count and list per group | The doctors in it, longest there first, with days in the group |
| Typical time in a column | Median days the doctors now in it have been there |
| New leads, sign-ups, applications, interviews booked, placements, **commenced** | In the window (7 or 30 days); "commenced" also as a total |
| Application to placement, sign-up to first placement, placement to commencement | Median and average **days**, per placement, shown as days or weeks |
| Latest placement | The newest placement and one truthful line: "starts 8 December 2026", "was due to start ... (start not yet confirmed)", "started ...", "ended ..." |
| Awaiting an Ahpra register check | Doctors with a pathway whose registration staff have never checked |
| **Commercial tile (the CEO only)** | `auPlacementCommercialSummary()`'s three lists: invoices due (and how many are unpaid past their terms), in the guarantee period, guarantee ending within 14 days, with the fee on each invoice |

**Who sees it.** The Overview, Registration -> Pipeline and the review queue
are CEO-only pages, as before. `GET /api/ceo/au-pipeline` also answers a
consultant, with the pipeline and no fee, invoice or credit figure and no
commercial review item; an RSO is refused.

## Gone quiet

| | Overseas | Australian |
| --- | --- | --- |
| Threshold | 60 days (`STALLED_APPLICATION_DAYS`, unchanged) | 14 days (`AU_STALLED_APPLICATION_DAYS`, never under 7) |
| Aged from | The application's own last movement | The same |
| Sentinel | `runtime_kv` `stalled_application_alerts` (unchanged) | `runtime_kv` `stalled_application_alerts_au` |
| Applies | Always | Only to an application that last moved at or after the go-live instant: env `AU_STALLED_LIVE_FROM`, else `runtime_kv` `au_stalled_live_from`, recorded by the daily job on its first run with the switch on. Before that, and when the instant cannot be read, the 60-day rule |

## The review queue (`lib/ceo-review-queue.js`, the one builder)

Existing kinds (register number pending or mismatched, account under review,
documents to review) are for everyone and are unchanged. Australian kinds, each
raised once and cleared by the fact that resolves it:

| Kind | Raised when | Cleared when | Opens |
| --- | --- | --- | --- |
| Ahpra conditions, undertakings or notations | Flagged and nobody has reviewed them | The reviewed stamp is recorded | Pathway card |
| Ahpra registration expiring / yearly re-check | Expires within 60 days (or has expired), or last checked over 12 months ago | Staff record a check | Ahpra check card |
| 19AB mismatch | The doctor's own answer and the staff-confirmed one disagree | The CEO presses "Mark reviewed" (comes back if staff confirm again), or they agree | Pathway card |
| 19AB doctor in a non-DPA role | A doctor limited to DPA roles is submitted to, or placed in, a role not known to be in a DPA | The application closes, the role is confirmed DPA, or staff confirm 19AB does not apply | Role eligibility card |
| Pre-start items overdue | An open pre-start task is past its due date (one item per case) | The tasks are done | Tasks card |
| On hold | A segment B or C doctor is on hold with an open segment review, or with none ever raised | The review is completed or the pathway changes | Pathway card |
| Start date reached | The start date has come and commencement is not confirmed | "Confirm commenced", or a new date | Commencement card |
| Invoice overdue | Not sent by its date, or sent and unpaid past its terms | Sent / paid | Commencement card |
| Credit to decide | The doctor left inside the guarantee period and the credit could not be worked out | The CEO records it | Commencement card |
