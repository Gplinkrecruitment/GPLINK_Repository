# Australian GP Placements: Systems Review and Build Plan

Nov 20, 2026 · @Khaleed

## Summary

GP Link cannot place an Australian GP through its systems today: they are accepted at the booking form, sent UK relocation messaging, told "Not yet eligible" at sign-up, and if placed by hand would trigger the overseas registration pack. The review found about 150 issues, 35 of them blockers, and those blockers trace back to six root causes.

| # | Root cause | Effect on an Australian GP | Fixed by |
| --- | --- | --- | --- |
| 1 | No field records what kind of candidate a doctor is. The only signal is a free-text country. | Every system treats them as an overseas mover. | WP-02 |
| 2 | Onboarding accepts only UK, Ireland and New Zealand. | "Not yet eligible" waitlist; cannot apply or be matched. | WP-05, WP-06 |
| 3 | One fixed journey: MyIntealth, AMC, AHPRA, visa, PBS. Every sign-up starts at MyIntealth. | Stuck at "MyIntealth" forever; chased by reminders about it. | WP-03, WP-04, WP-12 |
| 4 | Placement fires one unconditional cascade. | SPPA-00, Section G and supervisor CV tasks; AHPRA messages to doctor and practice. | WP-11 |
| 5 | Messaging is written for a doctor moving country, including the introduction sent to practices. | Relocation and visa emails; introduced to the practice as "internationally trained". | WP-01, WP-09, WP-15 to WP-20 |
| 6 | Nothing tracks commencement, invoices or the guarantee, and there are no non-DPA jobs. | The fee is due on commencement and nothing prompts it. All 54 open roles are DPA. | WP-13, WP-23, decision 11 |

### What already works

- The signed 2026 practice agreement covers Australian GPs: $21,000 full-time and $18,000 part-time, invoiced in full on commencement, with a 12-week guarantee.
- Matching, interview scheduling, offer review, contract signing and their messages are neutral and reusable.
- Lead screening, Ahpra number validation and the job eligibility gate already recognise Australia.
- The Medicare provider-number module and indemnity upload exist and can be reused for pre-start.

### Size of the gap by system

| System | Findings | Blockers | Headline |
| --- | --- | --- | --- |
| GP app interface | 28 | 10 | Blocked at onboarding; nothing after contract signing fits. |
| Admin dashboard and tasks | 30 | 7 | No pathway, wrong automation, no commercial tracking. |
| Website and lead funnel | 24 | 4 | Every page and ad speaks to overseas GPs; no lead segment. |
| Outbound messages and automations | 40 | 8 | About 150 messages audited; none of the scheduled jobs filters on pathway. |
| Data model and practice side | 30 | 6 | No candidate type; practice introduction is wrong; no non-DPA supply. |

Many findings across systems are the same root cause seen from different sides, so the 28 work packages are fewer than the findings.

### Recommended first moves

1. Ship WP-01 now. It stops Australian leads receiving relocation messages and UK-script calls, and is small.
2. Answer open decisions 1 and 2 (which segments launch; confirm the regulatory rules).
3. Start signing metro and non-DPA practices in parallel; without them there is nothing new to offer an unrestricted Australian GP.
4. Build Phases 1 to 4 behind a switch, then messaging and website.

## How the systems work today

The product is one journey built for a UK, Irish or NZ GP moving to Australia, and the only thing that distinguishes doctors is a free-text country field. The middle of the journey (match, interview, offer, contract) is neutral; the two ends are not.

Reviewed at live commit `2d35b94a`. The code is one server file (`server.js`, about 93,000 lines) plus static pages in `pages/`, scripts in `js/` and modules in `lib/`.

| Stage | What exists today | What an Australian GP hits | Ready? |
| --- | --- | --- | --- |
| 1. Website and ads | 12 public pages and 15 blog posts, all pitched at overseas GPs; one Meta campaign; ads hub with UK copy rules | "Take your GP career to Australia"; nothing addressed to them | No |
| 2. Lead capture and screening | `/start` form, Meta lead webhook, screening in `lib/consult-lead.js`; Australia is a served country | Qualifies, but with no segment recorded | Partly |
| 3. Consult booking and nurture | Calendly, reminders, no-show rescue, Hazel AI calls, 5-email sign-up drip | UK relocation copy, UK or Sydney clock, UK call script | No |
| 4. Sign-up | Email and password; +61 offered | Works | Yes |
| 5. Onboarding wizard | 5 steps: intro, plan your move, country and register number, review, identity | "Not yet eligible" waitlist at the country step | No |
| 6. Register verification | Automatic for GMC and MCNZ; staff one-click for others; Ahpra number format already validated on the server | Manual only; records nothing but the number | Partly |
| 7. Job board and matching | 54 open roles, DPA gate, AI matching, application caps | Sees every role, but all 54 are DPA; matching uses arrival date and "who is moving" | Partly |
| 8. Apply, submit to practice | CV gate, practice introduction email and WhatsApp, decision page | Introduced to the practice as "internationally trained" | No |
| 9. Interview, offer, contract | Scheduling, Zoom, offer review, AI contract review, in-app signing | Works; interview windows are UK-evening shaped | Yes |
| 10. Placement | `finalizeInAppPlacement` plus task automation | Overseas practice pack, Section G, AHPRA messages | No |
| 11. After placement (GP app) | MyIntealth, AMC, AHPRA, visa, PBS, commencement | Sent to MyIntealth; the Medicare step they need is locked behind AHPRA and visa | No |
| 12. Admin and CEO dashboards | Cases, 30 task types, sweeps, AI summaries, ATS, metrics | Sits at "MyIntealth" forever; chased by sweeps; shown as GB | No |
| 13. Commercials | Agreement prices Australian-based GPs at $21,000 / $18,000 on commencement | No commencement, invoice or guarantee tracking | Partly |

### Where "Australia" is already recognised

- Lead screening: `SUPPORTED_CONSULT_COUNTRIES = ['uk','ie','nz','au']` (`lib/consult-lead.js:18`).
- Hazel: an AU from-number setting and +61 dialling (`lib/lead-calls.js:25-29`).
- Register validation: an `ahpra` body with the `MED` + 10 digits format (`lib/register-verification.js:38-46`).
- Jobs: country = Australia unlocks non-DPA roles (`server.js:5315-5352`).
- Account page: an "AHPRA number" label (`pages/account.html:1098`).
- Practice agreement: a separate fee tier for Australian-based GPs.

### What every overseas assumption hangs on

- **Country resolvers that default to UK.** At least seven, with no shared function (`server.js:9815`, `:5296`, `:39310`, `:76234`, `:76604`, `:77331`, `:79966`).
- **One fixed stage ladder.** `myintealth, amc, career, ahpra, visa, pbs, commencement, complete`, enforced by a database constraint and derived in `_deriveStageFromState` (`server.js:21312`).
- **Every sign-up gets a registration case at `myintealth`** (`server.js:21524`).
- **One placement function** that fires the overseas cascade unconditionally (`server.js:25797-25925`).

## Findings: admin dashboard and admin tasks

Staff cannot place an Australian GP today without wrong automation firing. Every doctor is created as an overseas case at stage "MyIntealth", placement triggers the overseas practice pack, and inactivity sweeps would chase a local GP about steps that do not apply to them.

### Blockers

| ID | Where | Problem | Change needed |
| --- | --- | --- | --- |
| ADM-01 | `registration_cases` schema; `server.js:21312`, `:21524` | No concept of an onshore doctor. Every sign-up gets a case at `myintealth` that only advances on EPIC and AMC flags, so AU doctors sit at "MyIntealth" forever in every list, rail, summary and count. | Add `registration_cases.pathway` (`overseas`, `au_vr`, `au_restricted`, `au_nonvr`), mirrored on the profile. Add an AU stage set (placement, pre-start, commenced, guarantee, complete). Default existing rows to `overseas`. |
| ADM-02 | `js/onboarding.js:27-31`; `server.js:67649-67737`, `:87859-87866`; `pages/ceo-dashboard.html:2440-2449` | AU doctors cannot get in. No staff endpoint creates a candidate; "Add candidate" needs an existing account. Doctors who never finish onboarding are hidden from the candidate list (`server.js:90424`). | Add a staff "create candidate" endpoint that makes the account, profile and case and sends an invite. Add an "Eligibility waitlist" tab so existing AU sign-ups can be found. |
| ADM-03 | `server.js:25801-25937`, `:47834`, `:47936-47948` | Placement creates SPPA-00, Section G and Supervisor CV tasks, auto-delivers Section G, and sends AHPRA-stage messages to doctor and practice. False for segment A. | Branch on pathway. AU gets the pre-start checklist below and the contract task only. Segment B adds a supervision re-lodgement task. |
| ADM-04 | `server.js:53420`, `:26217`, `:53904`, `:26255`, `:77451` | Weekly, 5-day SLA, 14-day chase and stuck-case sweeps all key on GP inactivity. An AU doctor has nothing to do in the app and would be chased repeatedly. It also skews RSO workload routing. | Filter all sweeps by pathway. Age AU cases from placement milestones, not last GP activity. |
| ADM-05 | `server.js:23371-23392`, `:65384-65413` | The manual stage setter writes "EPIC verified / AMC verified / AHPRA verified" into the doctor's state. It is the only current workaround and it fabricates milestones. | Pathway-aware stage setter. Hide Reset GP and stage rollback for AU. |
| ADM-06 | `supabase/migrations/20260703092000_placements.sql:15-36`; `assets/legal/src/agreement-2026.html:184`, `:332-345`, `:589-595` | No fee, invoice, guarantee or actual-commencement tracking. The agreement invoices Australian GP placements in full on commencement, and nothing records commencement. | Add fee, commenced date, invoice dates, guarantee end and credit percentage to `placements`. Add a "Confirm commenced" action that raises an invoice task and schedules week 4, 8 and 12 check-ins. |
| ADM-07 | `server.js:5315-5350`, `:47024`; `lib/practice-pipeline.js` | DPA eligibility is derived from country. Right for segment A, wrong for segment B under 19AB. | Add explicit `moratorium_19ab` and end-date fields and compute DPA eligibility from them. |

### Required

| ID | Where | Problem | Change needed |
| --- | --- | --- | --- |
| ADM-08 | `server.js:76602-76604`, `:77327-77331`, `:25647-25667`, `:9815-9838` | Admin coerces unknown countries to GB. An AU doctor shows as GB with "0/3 docs" and their uploads are invisible in the Documents pane. | Add `au` to document-country handling and the required-document sets. Return an empty list for unknown countries, never GB. |
| ADM-09 | `server.js:21523-21525`, `:20185` | Every new case goes to the default RSO. Segment A has no registration journey, and consultants cannot open any admin route. | AU cases start with the placing consultant. Assign an RSO only at pre-start. Give consultants read access to AU pre-start tasks. |
| ADM-10 | task-type CHECK; `pages/admin.html:4528-4532`; `server.js:21544` | AU task types do not exist and the manual task modal cannot express them. | Add the task types in the checklist below, add them to the modal, and add due-date rules. Read the live constraint from the database first; it has drifted from migrations before. |
| ADM-11 | `server.js:87809-87837` vs `:88813`; `js/ceo-ats-candidates.js:1331` | Dragging a card to "Hired" is not a placement: no placement row, no start date, no checklist. On a fast AU placement staff will drag the card. | Make the drag open the placement form. Make commencement date mandatory for AU. |
| ADM-12 | `lib/register-verification.js:38-46`; `server.js:11165-11187`; `js/ceo-ats-candidates.js:2444` | Ahpra verification is half-wired. The drawer input is numeric-only, so a `MED` number cannot be typed. Type, conditions and expiry are captured only after an overseas grant. | Text input. Record type, conditions, expiry and specialist-GP flag into the existing `ahpra_registration_*` columns. Show a public-register check link. |
| ADM-13 | `js/ceo-ats-candidates.js:2563-2568`; `server.js:88500`, `:9741` | Document slots are CV, cover letter, primary degree and ID. | Pathway-aware slots: fellowship certificate, Ahpra certificate, indemnity, provider-number letter, references; plus visa grant and supervision approval for B. |
| ADM-14 | `server.js:22831-22832`, `:23450` | AHPRA email matching skips cases at `myintealth`, so a segment B doctor's mail will not match. If it did, a final notice would open a visa case. | Include AU stages in the filter and branch the grant handler by pathway. |
| ADM-15 | `server.js:73294` (approx.); `lib/registration-playbook.js:6-46` | AI case summary and suggested-reply playbook say GP Link "helps overseas GPs register" and know only the seven overseas stages. | Add AU playbook entries and a pathway-aware system prompt. |
| ADM-16 | `lib/ai-candidate-job-match.js:24-38`, `:178-205` | Matching is fed arrival date, who is moving and visa pathway. VR status, conditions, supervision need and notice period are absent. | Add those inputs, job fields `vr_required` and `accepts_supervised`, and blocks for segment C and supervised segment B doctors. |
| ADM-17 | `lib/ceo-overview.js:215`, `:438`; `lib/ceo-metrics.js`; `server.js:12150` | AU doctors would inflate MyIntealth and "cold" counts, and time-to-placement would blend weeks with months. | Split metrics by pathway. Add a "Commenced" metric and a commercial tile: invoices due, in guarantee, guarantee ending in 14 days. |
| ADM-18 | `server.js:646`; `lib/stalled-applications.js` | Gone-quiet threshold is 60 days for everyone. An AU placement should close in 2 to 6 weeks. | Per-pathway threshold; suggested 10 to 14 days for AU. The function already accepts the parameter. |
| ADM-19 | `js/ceo-ats-candidates.js:26-34`, `:719` | Candidate list has no pathway filter. | Add a pathway chip and filter, and a placement-stage pill for AU. |

### Should and nice-to-have

| ID | Where | Change needed |
| --- | --- | --- |
| ADM-20 | `pages/admin.html:12222`; `server.js:66793` | Assistance calls are limited to MyIntealth, AMC and AHPRA. Allow a pre-start call type. |
| ADM-21 | `pbs_applications`; `pages/admin-pbs.html` | Provider-number tracking is one row per doctor per type. Add a practice or location id so a new-location number can be held. |
| ADM-22 | `pages/admin-visa.html:422-426` | Add a nomination-transfer case type, current sponsor and visa expiry for segment B. |
| ADM-23 | `lib/email-triage.js:294-303` | RACGP and ACRRM mail is filed under `amc`. Route by pathway. |
| ADM-24 | `lib/ceo-review-queue.js` | Add review items for Ahpra conditions or expiry, 19AB mismatch and overdue pre-start items. |
| ADM-25 | `lib/ats-intent.js:113-142` | Intent score gives AU doctors zero for "registration progress". Neutralise it. |
| ADM-26 | `pages/admin.html:2293-2340` | GP list has no pathway badge and its filters are disabled. |
| ADM-27 | `server.js:70184-70250` | "View as GP" shows the overseas app until the GP app is pathway-aware. |
| ADM-28 | `js/ceo-ats-candidates.js:2240-2242` | Drawer labels "Target arrival" and "who's moving" become "Available from" and "Current location" for AU. |
| ADM-29 | `js/ceo-ats-leads.js:71` | Leads tab labels AU as "Sydney" and has no country filter. |
| ADM-30 | `server.js:35738` | Exports need pathway, fee, invoice and guarantee columns. |

### Proposed admin task checklist for an Australian GP placement

"Existing" means the current task engine can carry it; "New" needs a migration and code.

| # | Task | Owner | Trigger | Done when | Engine |
| --- | --- | --- | --- | --- | --- |
| 1 | Verify Ahpra registration on the public register (type, conditions, expiry) | Consultant or CEO | Candidate created on an AU pathway | Staff mark verified; details saved | New `ahpra_register_check` |
| 2 | 19AB and DPA check for the target location (B, C) | Consultant | Shortlisted or applied | Location eligibility confirmed | New `dpa_19ab_check` |
| 3 | Reference checks, two referees | Consultant | Submitted to practice | References filed | New `reference_check` |
| 4 | Restraint-of-trade check on current contract | Consultant | Offer stage | Outcome recorded | New `restraint_check` |
| 5 | Contract signed | Consultant | Offer accepted | Signed file lands | Existing |
| 6 | Notice period and confirmed start date | Consultant, then RSO | Placement recorded | Start date saved | New `start_date_tracking` |
| 7 | Collect indemnity certificate | RSO | Placement recorded | Document approved | New document key; review flow exists |
| 8 | Medicare provider number for the new location | RSO | Placement recorded | Number recorded | New type; PBS page reusable after ADM-21 |
| 9 | Practice credentialing pack | RSO | Tasks 1 and 7 done | Pack sent to practice | New `credentialing_pack` |
| 10 | Visa transfer or new nomination (B) | RSO and migration agent | Placement recorded, visa holder | Nomination approved | Existing, after ADM-22 |
| 11 | Ahpra change of circumstances or new supervision (B, C) | RSO | Placement recorded, supervised registration | Ahpra approval filed | Existing practice-pack tasks, gated by pathway |
| 12 | Confirm commenced | Consultant or CEO | Start date reached | Actual date confirmed | New action |
| 13 | Raise placement-fee invoice | CEO | Task 12 | Invoice sent, then paid | New `invoice_due` |
| 14 | Guarantee check-ins at weeks 4, 8 and 12 | Consultant | Task 12 | Each check-in logged | Existing `followup` |
| 15 | Close case, or replacement if the doctor leaves | CEO | Week 12 or early exit | Case complete, or credit recorded | New |

### Reusable as-is

- RSO scoping, reassignment, DoubleTick hand-off and Gmail label transfer.
- Task engine: timeline, notes, statuses, due dates, 3-day overdue escalation, generic Ops Queue card.
- Document review tools, inbox and registration email hub, guide panel.
- Application kanban, withdrawal, interview scheduling, offer and contract flow.
- Practice intake, job editor, waiting-on-practice tracker (days 3, 5, 7).
- `placements` table and the `ahpra_registration_*` case columns.

## Findings: GP app interface

An Australian GP cannot get past onboarding step 2 today: choosing "Australia" sends them to a "Not yet eligible" waitlist. Once that opens, browse, apply, interview, offer and contract work almost unchanged. Everything after contract signing is hard-wired to MyIntealth, AMC, AHPRA application, visa and PBS, and the app has no concept of a pathway.

Segments used below: **A** = Australian vocationally registered GP; **B** = already in Australia with restrictions (19AB, limited registration, sponsored visa); **C** = non-VR GP or registrar.

### Entry and onboarding

| ID | Severity | Where | Problem | Change needed |
| --- | --- | --- | --- | --- |
| APP-01 | Blocker | `js/onboarding.js:27-31`, `:42`, `:333-338`, `:2091`; `pages/onboarding.html:1241` | Australia sits in the "somewhere else" list and routes to the eligibility waitlist. | Add AU as a supported country. Stop using `COUNTRY_DOCS[country]` as the supported test. Update the off-ramp copy. |
| APP-02 | Blocker | `js/onboarding.js:143-147`, `:152`, `:749` | The wizard has no AHPRA number path and strips non-digits, destroying the `MED` prefix. The server already validates `MED` + 10 digits (`lib/register-verification.js:38-46`). | Add AU to the client register list, keep letters, use a text keyboard, reword the explainer. |
| APP-03 | Blocker | `pages/onboarding.html:1412-1416` | The wizard asks country of training, which cannot separate A from B. A UK-trained GP already working here would get the full overseas ladder. | Ask first: "Are you already registered with Ahpra and working in Australia?" Store a pathway value and collect registration type, fellowship, conditions, 19AB, work rights, current practice and notice period. |
| APP-04 | Blocker | `pages/onboarding.html:1325-1349`; `js/onboarding.js:1934-1936`, `:2079-2082` | "Plan your move" requires a target arrival date at least 5 months away. A local GP may start in four weeks. Cities are seven capitals only. | For AU pathways: "When could you start?" with no minimum, "Where do you want to work?" multi-select including regional. |
| APP-05 | Required | `pages/onboarding.html:1232`, `:1298-1300`, `:1425`; `pages/signin.html:999`; `lib/onboarding-nudge.js:18-24` | Copy is overseas-only ("Your fastest pathway to practising in Australia"). | Pathway-aware copy; neutral on sign-in where pathway is unknown. |
| APP-06 | Required | `server.js:11149`, `:11181-11184`; `lib/register-lookup.js:22-23` | AHPRA verification is manual-only (the public register blocks bots). For AU GPs the register entry is the whole credential check. | Staff check must record registration type, specialty, conditions, undertakings, notations and expiry. |
| APP-07 | Should | `server.js:11094-11123` | Nothing screens segment B or C conditions. | Derive the segment from the onboarding answers plus the staff register check. |

### Journey after placement

| ID | Severity | Where | Problem | Change needed |
| --- | --- | --- | --- | --- |
| APP-08 | Blocker | `js/journey-stages.js:16-59`, `:88-134`; `server.js:19486-19515`, `:21312-21328` | One fixed stage list. The server returns `myintealth` for anyone without EPIC verification, so a placed AU GP is permanently "at MyIntealth". | Per-pathway stage lists on client and server. Suggested for A: Secure placement, Pre-start checks, Medicare provider number, Start date. |
| APP-09 | Blocker | `pages/offer-review.html:1016`, `:1046`; `js/app-shell.js:11`; `js/gp-walkthrough.js:385-388` | After signing, the button is "Start my registration" and leads to MyIntealth. | Resolve the entry route from the pathway. |
| APP-10 | Blocker | `server.js:25816-25925`, `:47617-47621`, `:47928-47941` | Placement creates the overseas practice pack (SPPA-00, Section G, position description, supervisor CV), sends the "AHPRA stage" WhatsApp and AHPRA-unlocked email, and tells the practice our team "guides Dr X through the remaining AHPRA and Medicare steps". | Branch placement automation on pathway. AU task set: register check, provider number, indemnity, credentialing, notice and start date. |
| APP-11 | Blocker | `server.js:81349-81350`; `js/journey-stages.js:108`; `pages/index.html:1656` | Medicare/PBS is locked until AHPRA is done and the visa is granted. An AU GP never has either, so the one stage they need is unreachable. | For AU, unlock on placement secured. |
| APP-12 | Required | `pages/pbs.html:890-921`, `:1562-1563` | The page models provider number and prescriber number as two steps. A practising GP normally needs only a provider number for the new location. | Allow a provider-number-only case; collect existing numbers up front. |
| APP-13 | Required | `pages/commencement.html:555`, `:795-875`; `js/journey-stages.js:80` | Commencement is switched off for everyone and written for arrivals ("Book travel", "Bank account opened", "TFN obtained"). | Build the AU pre-start page from it. The indemnity upload is reusable. |
| APP-14 | Required | `server.js:21346-21386` | Every GP gets a registration case at stage `myintealth` at sign-up, which drives stall nudges. | Pathway-aware derivation; suppress overseas stage nudges for AU. |
| APP-15 | Required | `pages/index.html:997-2300`; `js/app-shell.js:632-741` | Home is built around the ladder: EPIC, AMC and AHPRA labels, "your 482 and 186 visa pathway", "Need help with your move?". | Render from the per-pathway stage list. |
| APP-16 | Required | `js/gp-intro-slides.js:44-114`; `js/gp-walkthrough.js:157`, `:181`; `pages/registration-intro.html:251-252`; `js/career-step-strip.js:26` | Intro slides and walkthrough say "Start with MyIntealth". | Pathway-aware copy; step 4 becomes "Pre-start" for AU. |

### Careers, documents and account

| ID | Severity | Where | Problem | Change needed |
| --- | --- | --- | --- | --- |
| APP-17 | Blocker for B, C | `server.js:5315-5352`, `:5597`, `:59835`, `:60891`, `:47055`; `lib/practice-pipeline.js:616-621`; `lib/ai-candidate-job-match.js:119` | The DPA gate treats country = Australia as unrestricted. A segment B doctor under the 19AB moratorium would be shown non-DPA roles they cannot legally take. | Replace the country test with an explicit `dpaRestricted` flag from the 19AB answer plus staff confirmation. Fail closed when unknown. |
| APP-18 | Required | `server.js:5335-5348`, `:67826`; `pages/account.html:672` | Country is read through a fallback chain across three fields. | Write pathway and country explicitly at onboarding completion. |
| APP-19 | Should | `pages/job.html:2599-2609` | Job facts are overseas-framed ("Yes, open to overseas-trained GPs", "Visa: Sponsorship available"). | Per-pathway rows: billing split, VR requirement, sessions, after-hours, restraint radius, MMM. |
| APP-20 | Should | `pages/career.html:8480-10632`; `pages/offer-review.html:923-1010` | Relocation framing throughout careers and offer review. | Pathway-aware strings. Keep the housing and schools explorer for interstate moves. |
| APP-21 | Should | `lib/interview-meetings.js:79` | Fallback time zone for Australia is Sydney; a Perth GP's emails could be wrong. | Store state or time zone on the profile. |
| APP-22 | Should | `server.js:60835-60847` | A placed GP can never apply again. An Australian GP is a repeat customer. | Allow re-entry once a placement has started or ended. |
| APP-23 | Blocker | `lib/document-requirements.js:17`; `server.js:9815-9839`; `pages/my-documents.html:1484-1506`, `:1683-1697` | With no AU document set, pages fall back to the UK list. An AU GP would be asked for a GMC Certificate of Good Standing, MRCGP and CCT. | Add an `au` requirement set and remove every client-side UK default. |
| APP-24 | Required | `server.js:9766`, `:10217-10305` | Documents are keyed by country code, and the careers CV already uses `AU`. | Choose the AU code deliberately and check for key collisions. |
| APP-25 | Should | `server.js:71502-71504`; `pages/myinthealth.html:2142-2144` | AU GPs skip the MyIntealth certificate step only by accident. | Make the skip explicit. |
| APP-26 | Should | `pages/account.html:695-740`, `:1098`, `:1512` | Account already labels the AHPRA number correctly, but has "Relocation Details" and no AU fields. | Add fellowship, registration type, provider numbers, work rights and notice period. |
| APP-27 | Nice | `pages/messages.html:788-949` | Support articles are all about moving from the UK. | Filter by pathway or add AU content. |
| APP-29 | Should for B | `pages/visa.html:995-1003` | The visa page models a fresh sponsored application. For B the event is a transfer to the new employer. | Add a transfer case type; hide the stage for citizens and permanent residents. |

### Proposed Australian document set

- **All AU pathways:** AHPRA registration certificate or register extract, FRACGP or FACRRM certificate, CV, indemnity certificate of currency, current provider and prescriber numbers, right-to-work evidence, Working with Children Check, immunisation record, two referees.
- **Segment B adds:** current supervision plan and reports, visa grant notice, 19AB exemption letter.

### Reusable as-is

- Sign-up, sign-in, password reset, email verification; +61 is already offered.
- Identity step (passport or driver's licence, name-matched).
- Careers CV upload and AI check.
- Roles list, map, saved jobs, masked and named practice tiers, apply, withdraw, application caps.
- AI matching, interview booking (uses the browser's time zone), offer review, contract signing.
- Medicare/PBS case page mechanics and the indemnity upload endpoint.
- Messages, updates bell, push notifications.

Regulatory statements here (19AB, provider and prescriber numbers, supervision re-lodgement, visa transfer) are the reviewers' working assumptions and need owner confirmation before build.

## Findings: website, lead capture and tracking

An Australian GP is accepted at the booking form today, then receives UK-mover messaging and is told "Not yet eligible" the moment they create an account. "Australia" has been a served country in lead screening since 15 Aug 2026, but nothing downstream was built for it.

### What happens to an Australian GP today

| Entry point | Result today |
| --- | --- |
| `/start` form, picks "Australia" | Qualified and shown the Calendly calendar. Then gets UK-mover emails and reminders, and could be rung by Hazel with the UK script. |
| `/start`, already in Australia but trained in UK/IE/NZ | Qualified as an overseas mover, on a UK, Irish or NZ clock. |
| `/start`, already in Australia, trained elsewhere | Turned down ("We're sorry, we can't take this one on"), although placeable. |
| Meta lead form | Qualified if the form id is allow-listed and an answer reads as Australia. Otherwise not saved and the owner is emailed. |
| Job board "Apply now" | Sent to sign-up with the job id dropped, then onboarding shows "Not yet eligible" and waitlists them. |
| Direct sign-up | Account created, then waitlisted at the training-country step. |

### Findings

| ID | Severity | Where | Problem | Change needed |
| --- | --- | --- | --- | --- |
| WEB-01 | Blocker | `js/onboarding.js:27-31`, `:333-338`; `pages/onboarding.html:1241`, `:1422` | Onboarding only accepts GB, IE, NZ. Every "Create free account" and "Apply now" ends at "Not yet eligible". Booked-lead nudges push qualified AU leads into this wall. | Add an "already registered in Australia" branch before the country picker. Until then, stop sign-up nudges for `country==='au'` leads. |
| WEB-02 | Blocker | `server.js:33558-33567`, `:33630-33662` | The lead has no segment field. Only training country is stored, so emails, calls, reminders and reporting cannot tell an Australian GP from an overseas mover. | Add `consult.segment` plus location, AHPRA-registered, VR status, 19AB restriction and visa status. Carry it to `scheduled_calls`, Leads tab, owner alert and CAPI. |
| WEB-03 | Blocker | `lib/lead-calls.js:335`, `:366`, `:372`; `lib/consult-reminders.js:72-76`; `lib/interview-meetings.js:75-81` | Calling hours and time zone come from training country. A UK-trained GP living in Australia is rung in UK hours from the UK number. All AU leads get Sydney time. | Derive time zone from Calendly invitee zone, then browser zone, then dial code, then country. Add state for AU leads; reuse the state map at `lib/interview-meetings.js:103-111`. |
| WEB-04 | Blocker | `config/retell/hazel-prompt.md:1`, `:40-58`; `lib/lead-calls.js:25` | Hazel's voice script opens "a UK GP who enquired about GP work in Australia" and covers visas and moving costs. AU leads are in scope for calls. | Skip AU segments in `leadCallDecision` until an AU script exists, then select prompt by segment. |
| WEB-05 | Required | `lib/consult-lead.js:808-848` | Nurture emails say "I help UK GPs work out whether a move to Australia is realistic". | Segment-keyed copy sets. AU version: confidential conversation, better percentage, location, flexibility. |
| WEB-06 | Required | `server.js:33679`; `lib/consult-reminders.js:202`; `lib/consult-noshow.js:212`; `lib/consult-whatsapp.js:168-180` | Magic-link, reminder and no-show copy talks about visas and "the move"; fallback label is "(UK time)". | Segment variants and AU state time labels. New WhatsApp templates need approval. |
| WEB-07 | Required | `pages/site-start.html:293-525` | The landing page for every ad says "For UK, Irish & NZ GPs" and "We run your registration, visa and paperwork". | Dedicated AU landing page reusing the same form and booking components. |
| WEB-08 | Required | `pages/site-start.html:446-447`; `lib/consult-lead.js:542` | "Where did you complete your GP training?" is the wrong first question. No way to say "I'm already registered here". | Ask "Are you currently registered with AHPRA?" first; yes qualifies regardless of training country. |
| WEB-09 | Required | `pages/site-job.html:7`, `:299`, `:320`; `server.js:32923`, `:32971` | Job pages pitch relocation in meta, sidebar and JSON-LD. "Apply now" drops the job id. | Carry `job=<id>` through sign-up. Make the "what GP Link handles" block audience-aware. Neutral meta and JSON-LD. |
| WEB-10 | Required | `server.js:32434`, `:32655-32671` | Job board filters are only search, state and billing. No VR / non-VR, DPA, MMM, billing split or metro/regional filter. | Add stored fields on `career_roles` and expose the filters. Fix the meta that still advertises "VR, non-VR and locum roles". |
| WEB-11 | Required | `pages/site-employers.html:6-415`; `pages/site-faq.html:171-188` | Employers page promises overseas GPs only. No mention of faster local starts or non-DPA practices. | Reposition to overseas-trained and Australian-registered GPs. Add a local-GP track. Rewrite the DPA FAQ. |
| WEB-12 | Required | `js/site-practice-lead.js:180-182`; `pages/practice-intake.html:348-525` | Practice lead form and intake treat DPA as the eligibility gate. | Tell non-DPA practices they can hire Australian-registered GPs. Add an intake question on GP types accepted. |
| WEB-13 | Required | `lib/meta-capi.js:31`, `:183-188`; `pages/site-start.html:541-542`; `pages/signin.html` | No way to attribute an AU campaign. UTMs are captured only on `/start`; sign-up pages have no pixel or GTM. | Persist UTMs and click ids site-wide and attach at sign-up. Segment in CAPI, separate Google conversion, AU Meta form ids. |
| WEB-14 | Required | `lib/meta-ads.js:29-37`; `lib/ads-review.js:29-65`, `:452-458` | Ads hub holds one campaign, hard-wired to UK copy rules ("the UK pain", "no QOF and no CQC"). | Make campaigns a list, each with audience, house context, form and landing link. Write an AU house context. |
| WEB-15 | Required | `site-home.html`, `site-gp-jobs.html`, `site-about.html`, `site-app.html`, `site-faq.html`, footer on every page | Core positioning is overseas-only: "Take your GP career to Australia"; footer "Helping overseas-trained GPs register, relocate and thrive". | Keep overseas pages for SEO. Add an audience split on the home hero, an "Australian GPs" nav item and a neutral footer. |
| WEB-16 | Should | `server.js:33602-33615`, `:59152` | Comments say an "Australia" answer is a final decline; the code qualifies it. | Correct the comments so nobody "fixes" the code back. |
| WEB-17 | Should | `server.js:35790-35833` | Owner "New gp enquiry" alert shows only country. | Add segment, state and VR status. |
| WEB-18 | Should | `pages/signin.html:845`, `:972`, `:999` | Sign-in copy: "Trusted by GPs relocating from the UK, Ireland, and New Zealand". | Neutral copy or vary by `?seg=`. |
| WEB-19 | Should | `pages/privacy.html:150`, `:244-250`; `pages/terms.html:142`; `site-start.html:454` | Privacy and terms describe a relocation platform. No mention of AI voice calls, call recording, Calendly or WhatsApp. Form consent does not cover phone or AI calls. | Add confidentiality from current employer, consent before a profile goes to a practice, a basis for calls to +61 numbers, and collection of AHPRA and provider numbers. |
| WEB-20 | Should | all `site-*.html`; `pages/blog.html:6-7` | No `Organization` or `FAQPage` schema. Blog has a generic title, no canonical, no pixel. | Add schema and fix blog head tags. |
| WEB-21 | Should | `site-jobs.html:6`; `site-home.html:311-315`; `site-faq.html:149` | Public numbers disagree: "1,400+ roles", "240 jobs", about 51 live roles in code comments. | Reconcile before running AU ads. |
| WEB-22 | Should | `site-home.html:495`; `site-employers.html:390` | All testimonials and imagery are overseas movers. | Add Australian GP and metro-practice proof. |
| WEB-23 | Nice | `site-exclusive.html:160` | `/exclusive-placements` is nearly neutral already. | Soften one line; use it as the AU hook for unadvertised roles. |
| WEB-24 | Nice | `js/site.js:346`; `server.js:58854` | An unused enquiry form and endpoint exist. | Could back a light "confidential enquiry" form for AU GPs. |

### Reusable as-is

- Screening engine with its decline-only-on-evidence rules; `au` is already a served country and dial code.
- `/start` mechanics: form, token and email recognition, Calendly embed, `/book` redirect.
- `scheduled_calls`, the Calendly webhook, and the reminder and no-show engines (logic, not copy).
- Hazel's plumbing: AU from-number setting, +61 dial code, call windows, do-not-call handling.
- Job board masking, map, per-job SEO head and sitemap.
- Practice lead form, DPA lookup and practice intake.
- CAPI stage feed, pixel and GTM install.

### New pages with no equivalent today

- AU GP landing page, and pages for VR GPs by state or city.
- Billing-percentage and earnings guide.
- 19AB, DPA and moratorium explainer for doctors already here.
- "Changing practices" content on notice periods and restraint clauses.
- Non-VR and registrar page, if that segment is in scope.

## Findings: outbound emails, WhatsApp, calls and automations

Of roughly 150 outbound messages, the interview, offer and contract messages are reusable; almost everything before and after them is written for a doctor moving country, and no scheduled job filters on pathway. An Australian lead today would get the UK relocation sequence, and a placed Australian GP would get the supervised-practice pack and AHPRA messages.

### Verdict by message group

| Group | Messages | Verdict for an Australian GP |
| --- | --- | --- |
| Lead and consult funnel: magic link, 5 min / 1 h / 24 h notes, reminders, no-show rescue | F01 to F19 | Needs AU variants. Booking confirmations and call reminders are fine once the time zone is right. |
| Hazel voice calls | F09, F19 | Suppress until an AU script exists. |
| Post-call sign-up drip, 5 emails | F20 to F24 | Variants. Suppress the day-7 email ("AHPRA, AMC, visa, already solved"). |
| Account: verify, password, email change, support reply | F29, F42 to F44 | OK. |
| Welcome and profile-complete emails | F30 to F32 | Variants. Profile-complete says "The next step is MyIntealth". |
| Onboarding nudges, 7 emails plus WhatsApp | F33 to F35 | Variants; suppress while AU GPs cannot finish onboarding. |
| PEP waitlist and eligibility off-ramp | F45, F46 | Suppress. |
| RSO welcome, staff nudges, assistance-call invite | F47 to F49 | Variants; defaults are MyIntealth-worded. |
| Match, shortlist, application, interview, offer, contract (GP-facing) | M01 to M26 | OK, with minor "Registration Support Officer" wording and two tags to hide. |
| "Your placement is secured" | M27 | Variant. |
| MyIntealth, AMC, AHPRA, visa stage emails and WhatsApp | R-E04 to R-E11, R-W01 to R-W07 | Suppress for A. Some apply to B. |
| Document approved, revision, expiry | R-E13 to R-E17 | OK, minor wording. |
| Practice: candidate introduction email, WhatsApp, decision page | P01 to P03 | Variant, and a blocker: it says "internationally trained". |
| Practice: decision reminders, interview, contract, withdrawal | P05, P07 to P13, P15 | OK. |
| Practice: "Placement confirmed", intake invite, interview-times ask | P14, P16, P06 | Variants. |
| Practice: SPPA-00, supervisor CV, AHPRA-approved-next-is-visa | P19, P20, R-P06 | Suppress for A; keep for B where supervised. |
| AHPRA officer, migration agent | R-T01 to R-T04 | Not applicable to A; migration agent needs a transfer variant for B. |
| In-app bell and push |  | Career, document and provider-number items OK. Visa and AHPRA items suppressed for A. |
| Owner digest, CEO funnel, stalled digest | S-01, S-02, S-09 | Variants: an AU pipeline block and faster thresholds. |

### Scheduled jobs that would mis-handle an Australian GP

No scheduled job filters on country or pathway, apart from the lead layer.

| Job | Schedule (UTC) | Who it targets | Risk |
| --- | --- | --- | --- |
| `onboarding-nudge` | hourly | Onboarding incomplete, no application (`server.js:16443`) | Swept in with "move to Australia" and GMC copy. |
| `dropoff-nudge` | hourly | Onboarded, active (`server.js:52306`) | Copy promises registration. |
| `consult-nudge` | every 5 min | Leads; AU qualifies | Full UK relocation sequence. |
| `lead-calls` | every 5 min | Qualified leads in uk/ie/nz/au | Hazel uses the UK script on a Sydney clock for all of Australia. |
| `weekly-sweep` | daily 22:00 | Cases at `myintealth` or `amc`, 14 days quiet (`server.js:53420`) | "We noticed you haven't made progress on MyIntealth." |
| `chase-nonresponders` | daily 21:00 | SPPA tasks, officer threads, stalled cases (`server.js:53904`) | SPPA and officer chases must not fire for A. |
| `sla-sweep` | daily 20:30 | Active cases 5 days quiet | AU cases raise false overdue tasks. |
| `reconcile-doc-tasks` | hourly | Practice documents complete | "AHPRA documents ready"; country defaults to UK. |
| `register-auto-verify` | hourly | Pending register checks (`server.js:49828`) | AU left out: Ahpra returns manual-only and retries forever. |
| `doc-ai-review` | every 10 min | New uploads | No AU document types; would reject them as wrong. |
| `meta-lead-stages` | hourly | All GP leads | AU leads train the UK campaign's "qualified GP" signal. |
| `stalled-applications` | daily 21:20 | No movement in 60 days | Too slow for AU. |
| `refresh-summaries` | hourly | Stale active cases | Summary prompt assumes overseas. |

Send-time gaps: onboarding, drop-off and consult nudges and the match final call have no quiet hours, so a lead submitting at 23:00 gets WhatsApp at 23:05. The practice-reminder weekend skip uses the UTC day, so it skips Monday morning and sends on Saturday in Australian time (`server.js:53624`).

### Findings

| ID | Severity | Where | Problem | Change needed |
| --- | --- | --- | --- | --- |
| COM-01 | Blocker | `server.js:21312-21328`, `:21517-21524` | No segment field; every GP is created on the overseas pathway. Every other comms finding depends on this. | Pathway field on profile and case; pathway-aware stage derivation. |
| COM-02 | Blocker | `server.js:53418-53440`, `:53899-53921`, `:42817-42830` | Stalled-GP jobs chase about MyIntealth and open stall and SLA tasks. | Exclude AU pathways or give them AU stages and copy. |
| COM-03 | Blocker | `server.js:25795-25935` | Placement launches the supervised-practice pack, Section G delivery and AHPRA WhatsApp and email. The practice then gets the 4-day SPPA chase. | Branch on pathway; pre-start checklist messages for A. |
| COM-04 | Blocker | `lib/career-intro.js:35-79`; `server.js:66134`, `:66350`, `:56891` | Practice is told every candidate is "an internationally trained GP ... via the Expedited Specialist Pathway". | Segment branch with VR, availability and restriction chips. |
| COM-05 | Blocker | `lib/consult-lead.js:808-848`; `lib/booker-nudge-email.js:70-214`; `lib/consult-noshow.js:212` | AU leads are admitted, then sent relocation copy ("your Australia move starts here"). | Branch copy on segment. Until AU copy exists, disable nudges for AU leads so only the owner alert fires. |
| COM-06 | Blocker | `config/retell/hazel-prompt.md:1-73`; `lib/lead-calls.js:25-436` | Hazel would pitch an Australian fellow a 482 visa, six supervised months and a DPA-only first role. | Skip AU in `leadCallDecision` now; build an AU prompt or second agent. Diff against the live agent before any update. |
| COM-07 | Blocker | `js/onboarding.js:116-146`; `server.js:16432-16470`; `lib/onboarding-nudge.js`; `lib/dropoff-nudges.js:79-106` | AU GPs cannot finish onboarding, then get up to seven nudges ("Add my GMC number"). Waitlisted users are not excluded. | AU wizard path; exclude waitlisted users; AU copy and step labels. |
| COM-08 | Blocker | `server.js:42732`, `:42744`, `:25744` | Welcome and profile-complete emails send them to MyIntealth; opening that page fires the MyIntealth WhatsApp. | AU variant with a jobs CTA; gate the WhatsApp on pathway. |
| COM-09 | Required | `server.js:25767-25790`, `:25975-25985`, `:26595-26682` | Remaining stage messages key only on state flags; an admin override or stray page visit can trip them. | Early return for AU in the two automation functions. |
| COM-10 | Required | `server.js:23450`; `lib/registration-granted-emails.js:119-196` | Registration-granted automation asks for a new 482 nomination and passports. | Pathway check; "transfer of nomination" and "no visa action" variants for B. |
| COM-11 | Required | `server.js:49828-49869`, `:88296-88390` | Ahpra checks wait on a staff click and no result reaches the GP. | Staff task on sign-up; capture type and conditions; send verified or not-matched message. |
| COM-12 | Required | `server.js:47939-47948`, `:47611-47615`, `:48089` | "Placement confirmed" and "placement secured" promise AHPRA steps. | AU variants: start date, provider number, indemnity, credentialing, guarantee check-ins. |
| COM-13 | Required | `server.js:62643`, `:63975`, `:66139`, `:56896` | Start date is taken from arrival date. | Add `available_from` and `notice_period_weeks` and prefer them for AU. |
| COM-14 | Required | `lib/interview-meetings.js:75-82`; `lib/consult-reminders.js:72-99`; `lib/lead-calls.js:366` | Whole of Australia on Sydney time; unknown falls to London. | State-to-zone mapping or booker's zone; review call windows. |
| COM-15 | Required | `lib/consult-lead.js:248-253` | A +61 phone can make a UK-trained GP look Australian. | Explicit segment from a qualifying question, never from the phone. |
| COM-16 | Required | `server.js:16085`, `:11097`, `:68060` | PEP waitlist logic could catch a pre-2007 Australian fellow once Ahpra checks are wired in. | Gate the PEP check to GB, IE and NZ. |
| COM-17 | Required | `lib/document-requirements.js`; `server.js:15835-15880`; `lib/doc-ai-review.js:30-34` | AI document review knows only UK/IE/NZ documents and would reject AU ones. | AU document set and review rules. |
| COM-18 | Required | `server.js:24079-24120`, `:77091-77160` | Staff "nudge" defaults are MyIntealth-worded. | AU nudge keys and pathway-aware defaults. |
| COM-19 | Required | `lib/interview-meetings.js:7-9`; `server.js:88937` | Interview scheduling assumes UK-evening overlap; 9 to 11am Sydney is excluded. | Business-hours windows and neutral copy for AU. |
| COM-20 | Required | `lib/practice-pipeline.js:705` | Practice intake invite describes only UK, Irish and NZ doctors. | Add the Australian-registered line and an intake field for which GP types they want. |
| COM-21 | Required | `lib/ceo-metrics.js:141`; `lib/ceo-overview.js:223`, `:438`; `server.js:12202-12258` | Dashboards and digest count AU GPs as MyIntealth. | AU pipeline: Matched, Interview, Contract, Pre-start, Commenced, Guarantee. |
| COM-22 | Should | nudge senders | No quiet hours on elapsed-time sends. | Local-hours gate, 08:00 to 20:00. |
| COM-23 | Should | `server.js:45129`, `:46308`, `:57499`, `:92530` and others | "Registration Support Officer" wording in GP messages. | One segment-aware role label helper. |
| COM-25 | Should | `server.js:45433-45434`, `:44708` | "Visa pathway aligned" and "DPA approved" tags. | Hide visa tag for A and C; hide DPA tag for A. |
| COM-27 | Should | `server.js:53624` | Weekend skip uses the UTC day. | Compute in the practice's zone. |
| COM-28 | Should | `server.js:52604`; `lib/meta-capi.js:96-99` | AU leads feed the UK conversion signal. | Skip AU or use a separate dataset. |
| COM-34 | Should | `docs/lead-calls/TWILIO-UK-SETUP.md:71` | Nothing covers the Do Not Call Register or Spam Act position for AI calls to +61 numbers. | Owner or legal decision before AU calling. |
| COM-40 | Nice | none exists | No AU lifecycle job: Ahpra renewal, provider number pending, indemnity expiry, notice countdown, guarantee check-ins. | New scheduled job once the fields exist. |

### New messages for the Australian GP journey

| # | Trigger | Channel | To | Purpose |
| --- | --- | --- | --- | --- |
| N01 | AU lead qualifies | WhatsApp and email at 5 min, 1 h, 24 h | Lead | "Looking for a better-fitting practice?" |
| N02 | Consult booked, reminder, no-show | Email | Lead | Roles, pay, billing mix and timing |
| N03 | Attended call, no account | WhatsApp and email drip | Lead | Booked, Account, Matched, Interview, Start date |
| N04 | AU sign-up | Email and WhatsApp | GP | Welcome: add Ahpra number, availability, notice period |
| N05 | Onboarding incomplete | Email and WhatsApp | GP | Nudges with AU step labels |
| N06 | Ahpra check complete | Email and bell | GP | Verified, or number not matched |
| N07 | Ahpra check shows conditions | Staff task | Staff | Decides segment A, B or C |
| N08 | Profile complete | Email | GP | "We're lining up matches" |
| N09 | Match | Existing email and WhatsApp | GP | Reuse with AU match reasons |
| N10 | Submit to practice | Email and WhatsApp | Practice | "VR GP, available in X weeks, no registration wait" |
| N11 | Placement secured | Email, WhatsApp, bell | GP | Pre-start checklist |
| N12 | Placement confirmed | Email | Practice | Start date, provider number, credentialing, guarantee |
| N13 | Pre-start item requested | Email and bell | GP | Provider number, indemnity, credentialing pack |
| N14 | Practice form needed | Email | Practice | What the practice must sign or supply |
| N15 | Notice given, start date agreed | Email and bell | GP and practice | Confirm notice period and start date |
| N16 | Pre-start complete | Email and WhatsApp | GP | "Cleared to start on {date}" |
| N17 | Stalled at match or pre-start | Email | GP | AU stalled reminder |
| N18 | Week 1 after start | WhatsApp and email | GP and practice | Commencement check-in |
| N19 | Weeks 4, 8, 12 | Email | GP and practice | Guarantee check-ins |
| N20 | End of guarantee | Email | GP | Referral ask |
| N21 | Segment B flagged | Email | GP and practice | 19AB result, supervision paperwork, visa transfer |
| N22 | Weekly | Owner digest block | Owner | AU pipeline counts |

### WhatsApp templates

Templates are created in DoubleTick, approved by Meta in 24 to 48 hours, and referenced by name. Template bodies are not in the code, so each verdict below needs checking against the DoubleTick dashboard.

- **New approvals needed:** AU consult hello, 1 h and 24 h; AU post-call onboard; AU onboarding step templates (Ahpra number instead of GMC); AU welcome and RSO welcome; AU placement secured; AU pre-start complete; commencement check-in.
- **Likely reusable:** call booked and the three call reminders, missed call, match invitation, interview templates, contract ready, account released, upload CV nudge, practice candidate introduction (only a placeholder changes).
- **Never send to segment A:** MyIntealth, AMC and AHPRA introductions, AHPRA docs complete, visa passports and its reminder.

### AI prompts needing an Australian branch

| Where | Purpose | Overseas premise |
| --- | --- | --- |
| `config/retell/hazel-prompt.md`; `lib/lead-calls.js:396-433` | Hazel voice call | "a UK GP"; six months; 482; DPA |
| `lib/ai-candidate-job-match.js:24-38`, `:163-174` | Match reasons shown to GPs | "who is moving with them"; "visa pathway" |
| `server.js:29794-29828` | Job-board practice profile | "for overseas General Practitioners relocating to Australia" |
| `lib/suggest-reply-prompt.js:22`; `lib/registration-playbook.js:6-45` | Staff reply drafts | "helping overseas GPs register" |
| `server.js:73274-73294` | Candidate summary | "helps overseas GPs register" |
| `server.js:66996` | Zoom call reason | "an international GP" |
| `server.js:15835-15880`; `lib/doc-ai-review.js:30-34` | Document verification | UK/IE/NZ documents; August 2007 rule |
| `lib/practice-nudge-draft.js:130`; `lib/practice-reply-followup.js:122`; `lib/ai-matching.js:5` | Practice chase drafts | "helps overseas GPs register" |
| `lib/migration-agent-reply.js:183-590` | Migration agent emails | 482 nomination |
| `lib/email-triage.js:16-120` | Inbound triage | Needs provider number, indemnity and credentialing categories |
| `lib/ads-review.js:29`, `:448-458`; `lib/ads-context.js:20`, `:325-336` | Ad review and copy | UK-only brief |

## Findings: data model, practice side and commercials

The signed practice agreement already covers and prices Australian GPs, but the database has no field for candidate type, the practice-facing introduction calls every doctor "internationally trained", and there are no non-DPA jobs to offer. Leads, the Hazel caller, Ahpra number validation and the DPA job gate already recognise Australia; onboarding, the registration case, placement hooks and practice-facing copy do not.

### Live data, 20 Nov 2026

| Measure | Count |
| --- | --- |
| Doctor profiles, total / onboarded | 43 / 20 |
| Profiles with country Australia or an Ahpra number | 0 |
| Profiles with a +61 phone | 5 |
| GP leads, total | 892 |
| GP leads recorded as Australia (both qualified) | 2 |
| GP leads with an Australian phone | 14 |
| Archived candidate leads with an Australian phone | 11 of 817 |
| Open approved roles: DPA / non-DPA / metro | 54 / 0 / 0 |
| Practices: total / DPA confirmed / DPA unknown | 20 / 2 / 18 |
| Practices and groups with a signed agreement | 3 practices, 1 group |
| Placements recorded | 3 |

Read-only aggregate counts; the +61 profiles may include staff or test accounts.

### Blockers

| ID | Where | Problem | Change needed |
| --- | --- | --- | --- |
| DAT-01 | `js/onboarding.js:28-147`, `:2091`; `server.js:67832-67855` | No path to onboarding-complete for an AU GP, which apply and matching both require. | AU onboarding branch. The server already stores `register_body='ahpra'` once country is AU. |
| DAT-02 | `server.js:5315-5352`, `:47055`; `lib/practice-pipeline.js:615-621` | "Australia-trained" is inferred from a free-text country. One boolean stands in for where they trained, where they are based (drives the fee tier) and whether 19AB restricts them. | Explicit pathway and basis columns and one resolver replacing the country test. |
| DAT-03 | `server.js:21312-21329`, `:21517-21541` | Registration case stage can never advance for an AU GP. Nudges, RSO queue, intent score and the CEO funnel all read it. | Add short-track stages to the stage constraint and branch stage derivation on pathway. |
| DAT-04 | `server.js:25797-25925` | Placement fires the full overseas pack unconditionally. The same block also runs when the app posts a state change (`server.js:72486`). | Branch on pathway per the matrix below. |
| DAT-05 | `lib/career-intro.js:58-79`; `server.js:56891`, `:66134`, `:49095` | The candidate introduction sent to practices says "an internationally trained GP ... coming to Australia via the Expedited Specialist Pathway". A false statement about an Australian GP. | Pathway-aware builder: "Australian vocationally registered GP (FRACGP), Ahpra registration verified, available from ...". |
| DAT-06 | `server.js:47936-47948` | Practice "Placement confirmed" email promises AHPRA steps and supervision forms. | Pathway variant: provider number for your location, indemnity, start date. |

### Required

| ID | Where | Problem | Change needed |
| --- | --- | --- | --- |
| DAT-07 | `server.js:9815-9839`, `:5296-5311`, `:39310`, `:76234`, `:79966` | Document country silently defaults to UK in at least seven resolvers. | Add `au` with its own list, or skip document cards for non-overseas pathways. Unknown must mean unsupported. |
| DAT-08 | `server.js:11183-11186`, `:88299-88390`, `:49828`; `lib/register-lookup.js:22` | Ahpra verification is manual, and "verified" records only the number. The hourly job re-stamps Ahpra rows without checking anything. | Extend the staff one-click to capture type, conditions, undertakings, notations and expiry. Add an annual re-check reminder. Do not build a scraper. |
| DAT-09 | `registration_cases.ahpra_registration_*`; `user_profiles.register_*` | Two competing homes for Ahpra registration data. | One source of truth for doctors who already hold registration; the grant handler copies into it. |
| DAT-10 | `lib/ai-candidate-job-match.js:23-37`, `:117`, `:163-175` | Matching compares country of training and visa pathway; inputs are arrival date and who is moving. The no-money rule also blocks "private billing" as a match reason. | Feed pathway, suburb, commute radius, sessions, availability, VR status and interests. Replace the DPA test with a restriction check. |
| DAT-11 | `lib/practice-pipeline.js:625-670` | Role ranking is preferred-city string equality. | Practices already have coordinates. Add candidate home coordinates and a distance sort. |
| DAT-12 | `career_roles` schema; `server.js:49606-49660` | Roles cannot say who they are open to: no VR-required, registrar or locum field. | Add `vr_requirement`, `accepts_registrars`, `engagement_type`, session range and special interests to schema, intake, job editor and public payload. |
| DAT-13 | `server.js:44321` | Unknown DPA is stored as "not DPA" on jobs. Harmless today; wrong once non-DPA roles are real. | Make DPA nullable or add a status, and treat unknown as "ask". |
| DAT-14 | live data | No non-DPA inventory: 54 of 54 open roles are DPA. A supply problem, not a code problem. | Practice acquisition in metro and non-DPA areas. Intake does not reject them today. |
| DAT-16 | `placements`, `ats_offers`; `server.js:23732`, `:12092` | No fee, invoice or guarantee tracking. `sessions_per_week` is free text, so full-time versus part-time cannot be computed. | Placement columns for basis, fee tier, amount, commenced date, invoice dates, guarantee end and numeric sessions. |
| DAT-17 | `lib/ats-intent.js:113-120`; `server.js:49072-49073` | Intent score costs an AU GP up to 18 of 100 points for having no registration stage and no degree upload. | Pathway-specific signals, or full marks when a verified Ahpra entry exists. |
| DAT-19 | `server.js:54622`, `:81148` | Sign-up and the admin force-complete override cannot set Australia. | Set pathway at onboarding; extend the admin override. |

### Should

| ID | Where | Change needed |
| --- | --- | --- |
| DAT-21 | `server.js:9781`, `:10613` | `user_documents.country_code` mixes meanings (`uk` set, `AU` careers, `zz` identity). Use a distinct key such as `au_reg`. |
| DAT-22 | `lib/interview-meetings.js:7`, `:79` | Interview host window is 11:00 to 02:00 Sydney, built for UK evenings. Use business hours and the candidate's state for local pathways. |
| DAT-23 | `server.js:46436-46443`, `:46551`, `:47069` | Caps of 2 active applications, 3 a month and a three-strike lock were tuned for overseas timelines. Make them pathway-configurable if the owner wants looser limits. |
| DAT-24 | `server.js:55646-55648`, `:47764` | The six-month identity purge anchors on status `hired`, but in-app placement writes `placement_secured`. Confirm before adding more identity data. |
| DAT-25 | `server.js:16833`, `:74081-74084`, `:88744` | Identity access differs between two routes. Decide one rule for provider numbers, indemnity and visa notices. |
| DAT-26 | `lib/drive-doc-folders.js:5-37` | Add Drive folders for provider number letter, Ahpra extract, work rights and 19AB exemption. |
| DAT-27 | `lib/ai-matching.js:5` | Email document matcher prompt says "overseas GPs"; update when pre-start document types are added. |

### Proposed data model

Pathway lives on `user_profiles`, server-owned, never synced from the app.

| Field | Values | Purpose |
| --- | --- | --- |
| `candidate_pathway` | `overseas_esp`, `overseas_pep`, `au_vr`, `au_restricted`, `au_non_vr`, `au_registrar` | Drives journey, tasks, messaging and matching. Null reads as `overseas_esp`. |
| `candidate_basis` | `overseas`, `australia` | Where the doctor is based. Drives the fee tier. |
| `pathway_set_by`, `pathway_set_at` | text, timestamp | Staff can override the self-declared value. |

A new service-role-only table `gp_credentials`, one row per doctor, holds: Ahpra number, registration type, conditions / undertakings / notations flags and text, expiry, last checked; fellowship and year; VR status; 19AB status and end date; work rights, visa subclass, expiry and sponsor tie; supervision level; indemnity provider and expiry.

Candidate preferences on the profile: current suburb, state, postcode and coordinates; commute radius; notice period and available-from date; sessions wanted; billing preference; special interests; open to locum; open to relocate.

Migration rule from past incidents: selecting a column that does not exist fails the whole query silently. Ship and confirm each migration in production before any read names the new columns.

### Placement-hook matrix

| Hook | Overseas | A: AU VR | B: AU restricted | C: non-VR / registrar |
| --- | --- | --- | --- | --- |
| Offer accepted, hired, placement row, job filled | Fire | Fire | Fire | Fire |
| Practice "Placement confirmed" email | Fire | Variant | Variant | Variant |
| Contract task | Fire | Fire | Fire | Fire |
| Position description task | Fire | Skip | Fire if an Ahpra or visa change needs it | Variant |
| Supervisor CV and SPPA-00 tasks | Fire | Skip | Fire if registration is limited, provisional or supervised | Skip |
| Section G task and auto-delivered PDF | Fire | Skip | Only with SPPA-00 | Skip |
| Practice-pack email to GP | Fire | Skip; send pre-start checklist | Variant | Variant |
| Drive folder and document copy | Fire | Fire | Fire | Fire |
| "AHPRA stage" WhatsApp and AHPRA-unlocked email | Fire | Skip | Skip, or change-of-circumstances variant | Skip |
| Case stage | `ahpra` | `prestart` | `prestart` or `ahpra` | Variant |
| AHPRA-granted handler and visa case | Fire | Skip | Skip unless visa transfer | Skip |
| Medicare / PBS module | Fire | Provider number for new location | Provider number plus 19AB check | Plus program approval |
| Commencement checklist | Fire | Fire, no travel items | Fire | Fire |
| Invoice prompt | None exists | New: on commencement | New: on commencement | New |

### Commercial and legal

The current agreement (`assets/legal/src/agreement-2026.html`) does cover Australian GPs. "Our candidate" is defined without reference to overseas, and it states: "For Australian-based GPs, the full fee is invoiced when the placed doctor commences work."

| Placement | Based overseas | Based in Australia |
| --- | --- | --- |
| Full-time (8+ sessions) | $25,000 in two payments of $12,500 | $21,000 on commencement |
| Part-time (under 8 sessions) | $21,000 in two payments of $10,500 | $18,000 on commencement |
| Locum | 20% of gross billings, weekly | Same |

The discounted variant is $19,000 full-time and $17,000 part-time for Australian-based GPs (`lib/agreement-variants.js:29`).

Issues to settle, ideally with the commercial lawyer who still owes the unfair-contract-terms review:

1. **"Based in Australia" versus "Australian GP".** A UK-trained doctor already working here (segment B) is priced at $21,000 on commencement even when GP Link runs a visa transfer and new supervision paperwork.
2. **A statement that fails for segment C:** "Most candidates already based in Australia will hold, or be immediately eligible for, specialist registration (VR)." Non-VR placements need a carve-out or per-candidate disclosure.
3. **Cash-flow exposure.** Nothing is payable until commencement; a 12-week notice period is three months of work at risk. The withdrawal fee (50%, clause 6.10) only applies after a contract is signed.
4. **Clause 7.4** refunds initial fees less $2,500; there is no initial fee for Australian-based GPs, so it does nothing.
5. **Guarantee:** 12 weeks, credit only (80/50/35%), forfeited if an invoice is overdue. Applies as written and is untracked.
6. **Part-time uplift:** the difference becomes payable if a part-time doctor goes full-time within 12 months. Common for local GPs and untracked.
7. **Positioning:** the cover and first three pages describe the overseas service ("6 to 9 months"). An AU-focused variant is one new row plus an HTML source.
8. **Earlier signers:** which practices signed the pre-July-2026 version, and what it says about Australian GPs, is unknown.
9. **Locum:** priced in the agreement, but there is no locum job type, timesheet or weekly billing in the system.

### Reusable as-is

- Practice intake, DPA and MMM lookup, agreement e-sign and variants.
- Job catalogue, editor, approval, AI job write-up and public board.
- Apply, team match and submit-to-practice mechanics; practice decision, offer and consent pages.
- Interview scheduling, Zoom, calendar invites; contract upload, AI review and in-app signing.
- Medicare / PBS module, commencement checklist and indemnity upload.
- Drive lifecycle folders, identity retention, admin audit log.

## Build plan for agents

The work is 28 packages in 8 phases; WP-02 (the pathway field) gates almost everything else, and WP-01 should ship first because it stops wrong messages reaching Australian leads today. Each package lists the findings it closes, so an agent can read the finding rows above for exact file and line references.

### Rules for every package

- Work from a fresh checkout of `origin/main`; the usual local checkout lags and gives false "doesn't exist" results. Read `CLAUDE.md` and `AGENTS.md` first.
- A null or missing pathway must behave exactly as today. No existing overseas doctor's experience may change; add a regression test proving it in every package.
- Ship each database migration and confirm the columns exist in production before any read names them. A missing column fails the whole query silently.
- Read the live `registration_cases.stage` and `registration_tasks.task_type` constraints from the database before editing them; they have drifted from the migration files.
- Bump the `?v=` cache-buster on any changed script or stylesheet, and update the tests that pin it.
- Never send a real email, WhatsApp or call while testing. Local environments cannot send email by design.
- Regulatory statements (19AB, provider numbers, supervision, visa transfer) are assumptions until the owner confirms them in the open decisions below.
- Put all Australian behaviour behind one switch (suggested `AU_PATHWAY_ENABLED`) until Phase 4 is complete, so a half-built journey is never visible to a doctor.

### Order and dependencies

| WP | Package | Phase | Depends on | Size |
| --- | --- | --- | --- | --- |
| 01 | Stop wrong messages to Australian leads now | 0 | none | S |
| 02 | Pathway and credentials data model | 1 | none | M |
| 03 | Australian stage ladder and case creation | 1 | 02 | M |
| 04 | Pathway filters on sweeps and scheduled jobs | 1 | 02, 03 | M |
| 05 | Australian onboarding branch | 2 | 02 | L |
| 06 | Staff: create candidate, Ahpra check, pathway controls | 2 | 02 | M |
| 07 | Australian document set; remove UK defaults | 2 | 02 | M |
| 08 | Job eligibility, role fields, matching and intent | 3 | 02, 06 | L |
| 09 | Practice-facing candidate introduction | 3 | 02 | S |
| 10 | Interview windows and time zones | 3 | 02 | S |
| 11 | Placement branch and pre-start task set | 4 | 03, 07 | L |
| 12 | GP app after placement | 4 | 03, 11 | L |
| 13 | Commencement, invoice and guarantee tracking | 4 | 11 | M |
| 14 | Segment B: visa transfer, supervision, AHPRA mail | 4 | 11 | M |
| 15 | Lead segment and `/start` question | 5 | 02 | M |
| 16 | Lead and consult copy for Australian GPs | 5 | 15 | M |
| 17 | GP and practice lifecycle messages | 5 | 05, 11, 13 | L |
| 18 | WhatsApp templates | 5 | 16, 17 | S + owner |
| 19 | Hazel Australian script | 5 | 15 | M |
| 20 | AI prompt branches | 5 | 02 | M |
| 21 | Australian GP landing page and site positioning | 6 | 15 | M |
| 22 | Job board filters, job page, apply carry-through | 6 | 08 | M |
| 23 | Employers page, practice lead form and intake | 6 | 08 | M |
| 24 | Attribution and multi-campaign ads hub | 6 | 15 | M |
| 25 | Privacy, terms and consent | 6 | owner / legal | S |
| 26 | Admin and CEO dashboard pathway UI | 7 | 02, 03, 11 | M |
| 27 | Metrics, digest, review queue, gone-quiet | 7 | 03, 13 | M |
| 28 | Australian agreement variant | 7 | owner / legal | S |

### Phase 0: stop the harm

**WP-01. Stop wrong messages to Australian leads now**

- Closes: WEB-04, WEB-16, COM-05 (interim), COM-06 (interim), COM-07 (interim), COM-16.
- Scope:
  - In `leadCallDecision` (`lib/lead-calls.js`), skip leads with `consult.country === 'au'` until WP-19 ships.
  - Set nudges off for `au` leads in the consult nudge path so only the owner alert fires, until WP-16 ships.
  - Exclude eligibility-waitlisted users from the onboarding nudge enumeration (`server.js:16432-16470`).
  - Gate `applyPepWaitlistGate` to GB, IE and NZ.
  - Correct the stale comments at `server.js:33602-33615`, `:59152` and `tests/lead-decline-requires-evidence.test.js:304`.
- Acceptance: an `au` lead fixture produces no Hazel call, no nudge email and no WhatsApp, and still raises the owner alert. A waitlisted user is absent from the nudge list. UK, IE and NZ fixtures are unchanged.

### Phase 1: foundation

**WP-02. Pathway and credentials data model**

- Closes: ADM-01 (field), DAT-02, DAT-09, DAT-19, COM-01 (field), WEB-02 (profile side), APP-18.
- Scope:
  - Migration: `user_profiles.candidate_pathway`, `candidate_basis`, `pathway_set_by`, `pathway_set_at`; mirror `pathway` on `registration_cases`.
  - Migration: new `gp_credentials` table and the candidate preference columns, as specified in "Proposed data model".
  - One resolver, `resolveCandidatePathway(userId)`, returning pathway, basis and a `dpaRestricted` flag. Null reads as `overseas_esp`. Fail closed (`dpaRestricted = true`) when 19AB status is unknown.
  - Staff endpoint to set or override pathway, with audit log.
  - Extend the admin force-complete onboarding override to accept Australia.
- Acceptance: migration confirmed in production. Resolver unit tests cover all six pathways plus null. No existing query changes result for existing rows.

**WP-03. Australian stage ladder and case creation**

- Closes: ADM-01 (stages), ADM-05, DAT-03, APP-08 (server), APP-14, COM-01.
- Scope:
  - Extend the stage constraint with `placement`, `prestart`, `commenced`, `guarantee`.
  - Branch `_ensureRegCase` and `_deriveStageFromState` on pathway, and the dependent lists: `PAGE_STAGE_MAP`, `positionGateFor`, `ATS_REG_STAGE_MAX`, `ceoMetrics.DB_STAGE_ORDER`, the `scheduled_calls.stage` constraint.
  - Pathway-aware manual stage setter; it must never write EPIC, AMC or AHPRA flags for an AU pathway. Hide Reset GP and stage rollback for AU.
- Acceptance: an `au_vr` case is created at `placement`, never reads as `myintealth`, and moves to `prestart` on placement. Overseas stage tests still pass unchanged.

**WP-04. Pathway filters on sweeps and scheduled jobs**

- Closes: ADM-04, COM-02, COM-09, DAT-20, and the scheduled-jobs table.
- Scope:
  - Add a pathway filter to `weekly-sweep`, `sla-sweep`, `chase-nonresponders`, stuck-case buckets, the manual weekly check-in, `reconcile-doc-tasks` and `register-auto-verify`.
  - Early return for AU pathways in `processRegistrationTaskAutomation` stage messages and `_maybeNotifyAhpraDocsReady`.
  - Gate the MyIntealth page-open WhatsApp (`server.js:25744`) on pathway.
  - Age AU cases from placement milestones, not last GP activity.
- Acceptance: with an `au_vr` fixture at every stage, none of these jobs creates a task or sends a message that names MyIntealth, AMC, AHPRA application, SPPA or visa.

### Phase 2: let Australian GPs in

**WP-05. Australian onboarding branch**

- Closes: WEB-01, WEB-08 (app side), APP-01 to APP-05, APP-07, DAT-01, COM-07.
- Scope:
  - New first question: "Are you already registered with Ahpra and working in Australia?"
  - AU steps: Ahpra number (`MED` + 10 digits, text keyboard, letters kept), registration type, fellowship, conditions yes/no, 19AB yes/no/unsure, work rights, current practice and notice period, available-from date (no minimum), preferred locations (multi-select, regional included), sessions wanted.
  - Keep the identity step. No certificate uploads at onboarding.
  - Server: write pathway (self-declared, pending staff confirmation), credentials and preferences in `/api/onboarding/complete`.
  - Release path for Australian GPs already on the eligibility waitlist, with an invite email.
  - Pathway-aware copy on onboarding; neutral copy on sign-in.
- Acceptance: an Australian GP completes onboarding in under five minutes and lands on Careers. Choosing a UK, IE or NZ route is unchanged. `register-onboarding-sync` and `eligibility-waitlist` tests updated.

**WP-06. Staff: create candidate, Ahpra check, pathway controls**

- Closes: ADM-02, ADM-09, ADM-12, ADM-19, APP-06, DAT-08, COM-11.
- Scope:
  - `POST /api/ats/candidate`: create account, profile and case with pathway; send a set-password invite.
  - Extend the register-verification action to record type, specialty, conditions, undertakings, notations, expiry and checked-by into `gp_credentials`; show a link to the public register; text input in the drawer.
  - On an AU sign-up, raise an `ahpra_register_check` task (N07). Staff confirmation sets the final pathway (A, B or C).
  - Stop `register-auto-verify` re-stamping Ahpra rows; add an annual re-check reminder.
  - Ownership: AU cases start with the placing consultant; RSO assigned at pre-start; consultants get read access to AU pre-start tasks.
  - "Eligibility waitlist" tab and pathway chip and filter on the candidate list.
- Acceptance: staff can create an Australian candidate, verify them and set the pathway without touching the database. The GP receives a verified or not-matched message (N06).

**WP-07. Australian document set; remove UK defaults**

- Closes: APP-23, APP-24, APP-25, ADM-08, ADM-13, DAT-07, DAT-21, DAT-26, COM-17.
- Scope:
  - Add the AU requirement set from "Proposed Australian document set", keyed distinctly (suggested `au_reg`) to avoid colliding with careers documents stored under `AU`.
  - Remove every client and server fallback to `uk`; unknown returns an empty list.
  - My Documents tabs become "You provide / We prepare" for AU.
  - AI document review rules for the AU types; Drive folders for the new types; pathway-aware document slots in the CEO drawer.
- Acceptance: an AU GP never sees a GMC, MRCGP or CCT request anywhere. An uploaded indemnity certificate passes AI review and appears in the admin Documents pane. `doc-requirements` tests still assert "unknown never maps to UK".

### Phase 3: match and submit

**WP-08. Job eligibility, role fields, matching and intent**

- Closes: APP-17, APP-19, APP-22, ADM-07, ADM-16, ADM-25, DAT-10 to DAT-13, DAT-17, DAT-23, WEB-10 (data), COM-13, COM-24, COM-25.
- Scope:
  - Replace the country test with `dpaRestricted` from WP-02 at all call sites (`server.js:5597`, `:59835`, `:60891`, `:47055`; `lib/practice-pipeline.js`; `lib/ai-candidate-job-match.js`).
  - Role fields: `vr_requirement`, `accepts_registrars`, `accepts_supervised`, `engagement_type`, session range, special interests, nullable DPA. Add to intake, job editor and payloads.
  - Matching inputs: pathway, suburb, commute radius, sessions, availability, VR status, interests; distance sort using practice coordinates.
  - Use `available_from` and notice period instead of arrival date for AU.
  - Intent score: pathway-specific signals.
  - Allow a previously placed GP to re-enter search after commencement; make application caps pathway-configurable.
- Acceptance: an `au_restricted` doctor with 19AB sees only DPA roles; an `au_vr` doctor sees all; unknown fails closed. A non-VR doctor cannot apply to a VR-only role. `career-dpa-gate` tests rewritten around the flag.

**WP-09. Practice-facing candidate introduction**

- Closes: DAT-05, COM-04, and the P01 to P03 rows.
- Scope: pathway-aware builder in `lib/career-intro.js`; add FRACGP and FACRRM to the specialty list (`server.js:49095`); availability from notice period; chips for VR, availability and, for B and C, 19AB or supervision. Apply to email, WhatsApp placeholder and the decision page.
- Acceptance: the words "internationally trained", "Expedited Specialist Pathway" and "managing the registration process" never appear for an AU pathway. Overseas output is byte-identical to today.

**WP-10. Interview windows and time zones**

- Closes: WEB-03, APP-21, DAT-22, COM-14, COM-19, COM-27, COM-38.
- Scope: store state and time zone on lead and profile; derive zone from booker zone, then browser, then state, then dial code, then country; business-hours interview windows for AU; neutral wording in the interview-times request; compute weekend skips in the practice's zone.
- Acceptance: a Perth GP sees Perth times in every email and is never called before 09:00 local.

### Phase 4: placement and pre-start

**WP-11. Placement branch and pre-start task set**

- Closes: APP-10, ADM-03, ADM-10, ADM-11, DAT-04, DAT-06, COM-03, COM-12 (triggers), and the placement-hook matrix.
- Scope:
  - Branch the career-secured block (`server.js:25797-25925`) and `finalizeInAppPlacement` (`server.js:47740-47977`) on pathway, exactly per the placement-hook matrix. Cover the second entry point where the app posts a state change (`server.js:72486`).
  - New task types by migration: `ahpra_register_check`, `dpa_19ab_check`, `reference_check`, `restraint_check`, `start_date_tracking`, `provider_number_new_location`, `credentialing_pack`, `invoice_due`. Add due-date rules and manual-modal options.
  - On AU placement, create tasks 6 to 9 of the admin checklist and assign an RSO.
  - Kanban drag to "Hired" opens the placement form; start date mandatory for AU.
- Acceptance: placing an `au_vr` fixture creates no SPPA-00, Section G, supervisor CV or position description task, delivers no Section G file and sends no AHPRA message. It creates the pre-start tasks. Placing an overseas fixture is unchanged (`career-secured-side-effects-once`, `practice-pack` tests pass untouched).

**WP-12. GP app after placement**

- Closes: APP-08 (client), APP-09, APP-11 to APP-13, APP-15, APP-16, APP-20, APP-26, APP-27, ADM-21, ADM-27.
- Scope:
  - Per-pathway stage lists in `js/journey-stages.js`; suggested for A: Secure placement, Pre-start checks, Medicare provider number, Start date.
  - New pre-start page built from the commencement page: register check result, provider number, indemnity upload, credentialing, notice given, start date confirmed.
  - Unlock the Medicare step on placement for AU; allow a provider-number-only case; let `pbs_applications` hold a location or practice id.
  - Resolve the post-signing route from pathway (no more "Start my registration" to MyIntealth).
  - Pathway-aware Home, intro slides, walkthrough, careers and offer-review copy; account page AU fields; support articles filtered by pathway.
- Acceptance: a placed `au_vr` doctor never sees the words MyIntealth, AMC, EPIC, visa or "your move" anywhere in the app, and can reach and complete the provider-number step. "View as GP" shows the same.

**WP-13. Commencement, invoice and guarantee tracking**

- Closes: ADM-06, ADM-30, DAT-16, COM-40.
- Scope:
  - `placements` columns: `candidate_basis`, `fee_tier`, `fee_amount_ex_gst`, `agreement_variant`, `commenced_at`, invoice due / sent / paid dates, `guarantee_ends_at`, `ended_at`, `credit_pct`, numeric sessions per week.
  - "Confirm commenced" action: stamps the date, raises `invoice_due`, schedules check-in tasks at weeks 4, 8 and 12, moves the case to `commenced` then `guarantee` then `complete`.
  - Daily lifecycle job: Ahpra renewal, provider number pending, indemnity expiry, notice countdown, guarantee ending in 14 days.
  - Part-time uplift reminder at months 6 and 12; exports gain pathway, fee, invoice and guarantee columns.
- Acceptance: confirming commencement on a fixture produces one invoice task with the right fee from the agreement variant, three dated check-ins and a guarantee end date 12 weeks out.

**WP-14. Segment B: visa transfer, supervision, AHPRA mail**

- Closes: APP-29, ADM-14, ADM-22, ADM-23, COM-10, and the segment B column of the matrix.
- Scope: nomination-transfer visa case type with current sponsor and visa expiry; hide the visa stage for citizens and permanent residents; supervision re-lodgement tasks fired only when registration is limited, provisional or supervised; AHPRA mail matching for AU stages; grant handler must not open a new visa case for AU pathways; migration-agent "transfer" variant.
- Acceptance: an `au_restricted` doctor with a sponsored visa gets a transfer case and supervision tasks; an `au_vr` citizen gets neither.
- Hold this package until open decisions 1 and 2 are answered.

### Phase 5: messaging

**WP-15. Lead segment and `/start` question**

- Closes: WEB-02, WEB-08, WEB-17, COM-15, ADM-29, COM-35.
- Scope: add `consult.segment`, `location_country`, state, `ahpra_registered`, `vr_status`, `restriction_19ab`, `visa_status`; first question "Are you currently registered with AHPRA?" on `/start`; map Meta form id to segment; never infer segment from the phone; carry segment into `scheduled_calls`, the Leads tab (with a filter) and the owner alert; send the browser time zone on every submit.
- Acceptance: an AHPRA-registered doctor trained anywhere qualifies and is tagged; the turndown is never shown to them.

**WP-16. Lead and consult copy for Australian GPs**

- Closes: WEB-05, WEB-06, COM-05, and rows F01 to F24.
- Scope: segment-keyed copy in `consultNudgeCopy`, `buildBookerNudgeEmail`, the magic-link email, reminders and no-show rescue (N01 to N03). AU angle: confidential conversation, better percentage, location, flexibility. Remove the WP-01 interim suppression once live. Add local quiet hours, 08:00 to 20:00 (COM-22).
- Acceptance: snapshot tests show no "move", "visa", "relocat" or "UK" in any AU-segment message.

**WP-17. GP and practice lifecycle messages**

- Closes: COM-08, COM-12, COM-18, COM-20, COM-23, COM-29 to COM-31, WEB-18, and messages N04 to N22.
- Scope: AU welcome, profile-complete, onboarding nudges, Ahpra result, placement secured (pre-start checklist), practice placement confirmed, pre-start requests, notice and start-date confirmation, cleared to start, week 1 check-in, guarantee check-ins, referral ask, AU stalled reminder. Pathway-aware staff nudge defaults, admin composer templates and one role-label helper replacing "Registration Support Officer".
- Acceptance: every N-row has a builder, a trigger and a test; each is idempotent through the existing once-ever nudge ledger.

**WP-18. WhatsApp templates**

- Closes: the WhatsApp templates list.
- Scope: read the live bodies of every existing template from DoubleTick and confirm the reusable list; draft the new AU templates; register their names in code behind fallbacks. Meta approval takes 24 to 48 hours and a template can only be edited 24 hours after its last edit.
- Owner action: submit the drafted templates for approval.
- Acceptance: each AU message has an approved template or an approved fallback; none of the MyIntealth, AMC, AHPRA or visa templates can be sent to segment A.

**WP-19. Hazel Australian script**

- Closes: WEB-04, COM-06, COM-34.
- Scope: second prompt or agent selected by segment: billing percentage, location, flexibility, confidentiality from the current employer, notice period, restraint clauses. Call windows by Australian state. Diff against the live Retell agent before publishing; publishing overwrites the draft and a published prompt cannot be edited.
- Hold until open decision 7 (consent for AI calls to +61 numbers) is answered.

**WP-20. AI prompt branches**

- Closes: ADM-15, DAT-27, COM-36, and the AI prompts table.
- Scope: pathway context in match reasons, candidate summary, suggest-reply and the registration playbook (add `prestart` and `commenced` entries), practice chase drafts, job-board practice profile, Zoom call reason, email triage categories (provider number, indemnity insurer, credentialing).
- Acceptance: prompt tests assert the overseas sentence is absent for AU pathways and present for overseas.

### Phase 6: website and marketing

**WP-21. Australian GP landing page and site positioning**

- Closes: WEB-07, WEB-15, WEB-20 to WEB-24.
- Scope: new landing page (suggested `/australian-gps`) reusing the `/start` form and booking components; home hero audience split; "Australian GPs" nav item; neutral footer tagline; neutral or sectioned About and App pages; `Organization` and `FAQPage` schema; reconcile the public job and location counts; add to the sitemap. Follow-on content: VR GP state pages, billing guide, 19AB explainer, changing-practices guide.
- Acceptance: an Australian GP can go from the home page to a booked call without reading the words "overseas" or "relocate".

**WP-22. Job board filters, job page, apply carry-through**

- Closes: WEB-09, WEB-10, APP-19, DAT-28.
- Scope: filters for VR / non-VR, DPA, MMM, billing split and metro or regional; audience-aware "what GP Link handles" block; neutral meta and JSON-LD; carry `job=<id>` through sign-up and onboarding to the application.
- Acceptance: "Apply now" on a job ends with that job open in Careers after onboarding.

**WP-23. Employers page, practice lead form and intake**

- Closes: WEB-11, WEB-12, DAT-14 (enablement), DAT-15, COM-20.
- Scope: reposition to overseas-trained and Australian-registered GPs; local-GP track ("start in weeks, no visa, no supervision, any location"); non-DPA result says "you can hire Australian-registered GPs"; intake question on GP types accepted (VR, non-VR, 19AB-restricted) feeding the WP-08 role fields.
- Acceptance: a non-DPA metro practice can complete intake and publish a role visible to `au_vr` doctors only.

**WP-24. Attribution and multi-campaign ads hub**

- Closes: WEB-13, WEB-14, COM-28.
- Scope: persist UTMs and click ids site-wide and attach at sign-up; pixel and GTM on sign-in and onboarding; segment in CAPI events or a separate dataset; separate Google Ads conversion; ads hub config becomes a list of campaigns with their own audience, house context, form and landing link; AU house context for the copy and review prompts.
- Acceptance: an AU lead and a UK lead on the same day appear under different campaigns in the ads hub and send different conversion events.

**WP-25. Privacy, terms and consent**

- Closes: WEB-19, DAT-25.
- Scope: draft updates covering AI voice calls and recording, WhatsApp, Calendly, confidentiality from the current employer, consent before a profile goes to a practice, and collection of Ahpra and provider numbers. Form consent line covering phone and AI calls. One access rule for identity and credential data across both candidate routes.
- Owner action: legal review before publishing.

### Phase 7: dashboards and commercial

**WP-26. Admin and CEO dashboard pathway UI**

- Closes: ADM-08, ADM-13, ADM-20, ADM-26, ADM-28, and the admin stage ladders.
- Scope: pathway badge and filter on the GP list and candidate list; AU journey rail in the case profile; drawer labels "Available from" and "Current location"; pre-start call type; manual task modal with AU types and document keys; AU folders in the guide panel.
- Acceptance: staff can run the whole admin checklist for an AU placement from the dashboard, and no AU doctor shows as GB or "MyIntealth".

**WP-27. Metrics, digest, review queue, gone-quiet**

- Closes: ADM-17, ADM-18, ADM-24, COM-21, COM-26.
- Scope: split overview and legacy metrics by pathway; AU pipeline (Matched, Interview, Contract, Pre-start, Commenced, Guarantee); commercial tile (invoices due, in guarantee, guarantee ending in 14 days); AU block in the weekly owner digest; review-queue items for Ahpra conditions or expiry, 19AB mismatch and overdue pre-start items; gone-quiet threshold of 10 to 14 days for AU.
- Acceptance: adding AU fixtures changes no overseas metric.

**WP-28. Australian agreement variant**

- Closes: commercial issues 1 to 7.
- Scope: new row in `lib/agreement-variants.js` plus an HTML source with AU-focused cover pages. Content depends on open decisions 3 to 5.
- Owner action: lawyer review before any practice is sent it.

## Open decisions and assumptions

Twelve decisions are the owner's to make; decisions 1 and 2 shape the data model and should be answered before WP-02 starts. Phases 0 to 3 can otherwise proceed on the recommendations below.

| # | Decision | Why it matters | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| 1 | Which segments launch first: A only (Australian VR GPs), or also B (already here with restrictions) and C (non-VR, registrars)? | B and C add visa transfer, supervision paperwork and VR gating. | Launch A. Build the fields for B and C in WP-02 but hold WP-14. | WP-14, WP-28 |
| 2 | Confirm the regulatory assumptions: 19AB moratorium and DPA for segment B; a new provider number per practice location; supervision re-lodged for a new practice; visa nomination transfer. | Reviewers used working knowledge, not a checked source. Wrong rules would put doctors in roles they cannot bill from. | Owner or RSO team confirms in writing; add the sources to the guide panel. | WP-08, WP-11, WP-14 |
| 3 | Fee for a segment B doctor. The agreement prices anyone "based in Australia" at $21,000 on commencement, even when GP Link runs visa and supervision work. | Same work as overseas, $4,000 less, paid later. | Define "Australian-based" precisely and price B separately. | WP-13, WP-28 |
| 4 | Take part of the fee at contract signing for Australian GPs? | Nothing is payable until commencement; a 12-week notice period is three months at risk. | Yes, a portion on signing. Lawyer to draft. | WP-28 |
| 5 | Will GP Link place non-VR GPs? The agreement states most Australian-based candidates hold or are eligible for VR. | Needs a carve-out or per-candidate disclosure. | Decide with decision 1. | WP-28 |
| 6 | Who owns an Australian GP day to day: the placing consultant or an RSO? | They have no registration journey, and consultants cannot open admin routes today. | Consultant until placement; RSO for pre-start. | WP-06 |
| 7 | May Hazel (AI voice) ring Australian mobiles? | No consent wording, Do Not Call Register or Spam Act position exists for +61 calls. | Keep AU calls off until legal advice. | WP-19, WP-25 |
| 8 | Application caps for Australian GPs. Today: 2 active, 3 a month, 3 interviews a month, three-strike lock. | Tuned for a six-to-nine-month overseas process. | Loosen for AU; make configurable. | WP-08 |
| 9 | May match reasons mention billing percentage or private billing? Money is banned from match reasons today. | It is the main draw for a metro VR GP. | Allow billing model, not dollar figures. | WP-08, WP-20 |
| 10 | Is locum work in scope? It is priced in the agreement (20% of billings, weekly) but there is no locum job type or timesheet. | A separate build. | Out of scope for this plan. | none |
| 11 | When to start signing metro and non-DPA practices. All 54 open roles are DPA and none are metro. | An unrestricted Australian GP has nothing new to look at until this changes. | Start now, in parallel with Phase 1; it is sales work, not code. | WP-23 |
| 12 | Review on localhost before each phase goes live, or ship to main as usual? | The Australian journey touches every doctor-facing surface. | Ship behind the `AU_PATHWAY_ENABLED` switch; owner reviews before it is turned on. | all |

### Not yet verified

- Production switches `LEAD_CALLS_ENABLED`, `RETELL_FROM_NUMBER_AU`, `CONSULT_WHATSAPP_ENABLED` and `FB_GP_LEAD_FORM_IDS`. These decide whether Australian leads are being rung or messaged today. WP-01 should check them first.
- Live DoubleTick WhatsApp template bodies, the live Retell agent prompt, the live Meta lead form questions and the Calendly event wording. None are in the code.
- The live database constraints on case stage and task type.
- Which practices signed the pre-July-2026 agreement and what it says about Australian GPs.
- Why there are 4 hired applications against 3 placement rows.
- Whether the six-month identity purge ever fires for in-app placements (DAT-24).
- Whether Ahpra's paid data service is worth using in place of the manual register check.

### How this review was done

Five review agents read the live code at commit `2d35b94a` on 20 Nov 2026, one each for the GP app, admin and CEO dashboards, website and lead funnel, outbound messages and automations, and data model plus practice side. Nothing was changed, sent or deployed. Live-data figures are read-only aggregate counts. Test lists were chosen by filename and search, and the test suite was not run.
