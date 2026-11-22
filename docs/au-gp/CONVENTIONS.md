# Australian GP build: shared conventions

Written by WP-02. Every later package reads this before writing code, reuses
what is here, and adds to it when it creates something another package will
need. `AGENT-RULES.md` is the law; this file is the map.

**In one paragraph.** A doctor has a *pathway*. It is stored on their profile
and only the server can write it. Nothing recorded means "overseas doctor on
today's journey", always. One function answers "what pathway is this doctor
on?" (`resolveCandidatePathway`), one function writes it (`setCandidatePathway`),
and one function decides whether a doctor is limited to DPA roles
(`computeDpaRestricted`). With the `AU_PATHWAY_ENABLED` switch off none of them
touch the database and every doctor is an overseas doctor.

Contents: [1 Pathways](#1-pathway-values-and-segments) ·
[2 The switch](#2-the-switch) · [3 Helpers](#3-helpers) ·
[4 Reading new columns](#4-rule-for-reading-new-columns) ·
[5 Migrations](#5-migrations) · [6 Ahpra source of truth](#6-ahpra-registration-data-one-source-of-truth-dat-09) ·
[7 How a page learns the switch](#7-how-a-page-learns-the-switch-and-the-doctors-pathway) ·
[8 Staff endpoints and who may call them](#8-staff-endpoints) ·
[9 Audit log](#9-audit-log) · [10 Tests](#10-tests) ·
[11 New-column inventory](#11-new-column-inventory) ·
[12 Notes for the next packages](#12-notes-for-the-next-packages) ·
[13 Preview send lock](#13-preview-send-lock) ·
[14 Stage ladders](#14-stage-ladders-wp-03) ·
[15 Scheduled jobs and sweeps](#15-scheduled-jobs-and-sweeps-wp-04) ·
[16 Australian onboarding](#16-australian-onboarding-wp-05) ·
[17 Staff tools](#17-staff-tools-wp-06) ·
[18 Documents](#18-documents-wp-07) ·
[19 Role eligibility, role fields, caps](#19-role-eligibility-role-fields-caps-and-matching-wp-08) ·
[20 Practice introduction, Australian WhatsApp templates, consent](#20-practice-facing-introduction-australian-whatsapp-templates-and-consent-wp-09) ·
[21 Fix bundle FB-1: eligibility version, limits, invite sign-in](#21-fix-bundle-fb-1) ·
[22 Time zones and interview windows](#22-time-zones-and-interview-windows-wp-10) ·
[23 Placement branch and pre-start](#23-placement-branch-and-pre-start-wp-11) ·
[24 The GP app for an Australian doctor](#24-the-gp-app-for-an-australian-doctor-wp-12) ·
[25 Commencement, invoice and guarantee tracking](#25-commencement-invoice-and-guarantee-tracking-wp-13) ·
[26 Segment B: visa transfer, supervision, AHPRA mail](#26-segment-b-visa-transfer-supervision-ahpra-mail-wp-14) ·
[27 Lead segment and the /start first question](#27-lead-segment-and-the-start-first-question-wp-15) ·
[28 Lead and consult copy, the go-live rule and quiet hours](#28-lead-and-consult-copy-the-go-live-rule-and-quiet-hours-wp-16) ·
[29 Lifecycle messages: the catalogue, the role label, staff defaults](#29-lifecycle-messages-the-catalogue-the-role-label-staff-defaults-wp-17) ·
[30 WhatsApp templates: which one each Australian message uses](#30-whatsapp-templates-which-one-each-australian-message-uses-wp-18)

---

## 1. Pathway values and segments

Stored in `user_profiles.candidate_pathway` (mirrored to
`registration_cases.pathway`). Constants: `lib/candidate-pathway.js`.

| Value | Segment | Meaning | Launched? |
| --- | --- | --- | --- |
| `overseas_esp` | `overseas` | Expedited Specialist Pathway. **The default: NULL reads as this.** | yes (today's product) |
| `overseas_pep` | `overseas` | Practice Experience Pathway | yes (today's product) |
| `au_vr` | `A` | In Australia, vocationally registered GP | **yes** |
| `au_restricted` | `B` | In Australia, restricted (19AB moratorium, sponsor-tied visa) | no: built, gated, flagged to staff |
| `au_non_vr` | `C` | In Australia, not vocationally registered | no |
| `au_registrar` | `C` | In Australia, GP registrar | no |

`candidate_basis` is `overseas` or `australia`: where the doctor is based. It
drives the fee tier (`feeBasisFor`). NULL follows the pathway.

Rules that never bend:

- **NULL, empty or unreadable is `overseas_esp`.** Never an Australian value.
- **Switch off is `overseas_esp`**, whatever is stored.
- `launched` is false **only** for an Australian pathway that is not launched
  (B and C). `if (p.isAu && !p.launched)` is the test for "hold this doctor
  safely and flag them to staff".
- `confirmed` is true only when a pathway is stored **and** staff confirmed it
  (`pathway_confirmed_at`). A doctor's own onboarding answer is stored with
  `pathway_set_by = 'self'` and no confirmation.
- `needsStaffReview` is true for B and C, for an unconfirmed Australian
  pathway, and when an Ahpra condition, undertaking or notation is flagged
  **and no person has reviewed it yet** (WP-08: the reviewed stamp, section 19).
  It is never true for an overseas doctor.

## 2. The switch

```js
const { isAuPathwayEnabled } = require('./lib/au-pathway-flag.js');
if (isAuPathwayEnabled()) { /* Australian behaviour */ }
```

Env `AU_PATHWAY_ENABLED`. On for localhost, tests and Vercel previews; off in
production unless explicitly set. **Call it at request time. Never store the
answer in a module-level constant.** In `server.js` it is already required as
`auPathwayFlag`.

### Deliberate exceptions to switch-off parity

The rule is "with the switch off the product behaves exactly as `main` does".
There are three places where that is knowingly not true. Do not add a third
without the lead's say-so, and list it here if you do.

| What | Behaviour with the switch OFF | Why |
| --- | --- | --- |
| **Hazel never rings an Australian-segment lead** (WP-04, on the lead's instruction; owner decision 7). `auHazelBlocked` (`lib/au-lead.js`), `leadCallDecision` including the "no country on file but would be dialled as Australian" skip (`lib/lead-calls.js`), `placeLeadCall` and `ceoLeadCallNow` (`server.js`). | An Australian-segment lead is skipped with reason `au_segment`, exactly as with the switch on. On `main` the lead was diallable in principle. | WP-01 put the block behind the switch, so in production the only thing stopping Hazel ringing an Australian lead with the script for doctors moving country was that no Australian from-number (`RETELL_FROM_NUMBER_AU`) is configured. In production today no such number exists, so no call is placed either way; the block protects against the UK script ringing Australian leads if a number is ever added. What a person can see change: the Leads tab says "Australian GP: Hazel does not ring Australian leads", and "ring now" on such a lead answers 409 with that reason, where it used to answer that the Australian number was missing. New Zealand leads share that number and are **not** affected. The Australian copy that replaced the interim hold on emails and WhatsApps (`auCopyApplies`, WP-16) still follows the switch. |
| **`applyVerifiedStageToGp` skips the case write for `placement`** (WP-03, section 14). | The staff "verified stage" control, set to the overseas override value `placement`, no longer attempts to write `stage = 'placement'` on the case row. | The live CHECK constraint always rejected that write, so the case row never changed. WP-03 widens the constraint (for the Australian ladder), which would have turned the silent failure into a real write on an overseas doctor's case. The guard keeps the outcome what it has always been. No observable change. |
| **A case whose STORED stage is an Australian-ladder value is never handed to the overseas stage code** (WP-06, carry-over F1). `_auStageModeFor` answers `{ mode: 'hold', strandedAuStage: true }` for a case stored at `placement`, `prestart`, `commenced` or `guarantee` whenever the doctor does not read as Australian: with the switch off, and with the switch on when the pathway is overseas / not recorded. | The state sync (`processRegistrationTaskAutomation`), the bulk case sync, the staff verified-stage control (`applyVerifiedStageToGp`), Reset GP (409 `au_stage`) and the registration-granted flow all leave such a case exactly where it is, write no overseas flags onto the doctor's state, and send none of the overseas stage messages for it. `resolveGpJourneyPosition` reports it as on the Australian ladder, so the stalled-GP chase and the stage reminder stand down. No query is added: the answer comes from the `stage` already in hand. | Found on the Phase 1 walk-through: an Australian case at `prestart`, switch turned off, the doctor opened the app, and the overseas derivation rewrote the stage to `myintealth`. The Australian ladder only moves forward, so it could never be put back. On production today no such row can exist (the live CHECK rejects those four values), so nothing changes there. The one thing that still moves such a case onto the overseas ladder is a staff pathway change (`syncCaseToPathway`, switch on). **Not covered with the switch off** (the doctor is otherwise an overseas doctor by design): jobs that key on the doctor rather than the case (onboarding and drop-off nudges, document AI review, register auto-verify), and jobs that read the inert sweep index (`excludesCase` stays false with the switch off, so the 5-day SLA task, the intent score and the AI summary still run for that case). |

### Switch-ON behaviour that also reaches overseas doctors

The other rule is "a doctor with nothing recorded sees and triggers exactly
what they do today, switch on or off". One thing is knowingly not so with the
switch **on**, and it concerns practices, not doctors:

| What | With the switch ON | Why |
| --- | --- | --- |
| **The practice-reminder weekend skip is judged on the practice's own clock** (WP-10, COM-27). `/api/cron/practice-decision-reminders`, both passes (no decision yet; silence after an interview). `auTimezone.practiceWeekendNow`. | For **every** candidate's practice, Australian or overseas, the reminder is held on that practice's Saturday and Sunday (zone from the role's state / city; Sydney when unknown). Before, the day was the UTC day, so in Australian time a reminder could go out on Saturday morning and Monday morning's was skipped. With the switch **off** the UTC day decides, exactly as on `main`. | It is a bug on `main`, not an Australian feature, but fixing it changes when existing practice reminders go out, so it sits behind the switch until launch. Every practice is an Australian practice, so there is no "overseas practice" to keep on the old rule. `PRACTICE_REMINDER_SKIP_WEEKENDS=false` still turns the skip off in both states. Owner-visible: see WP-10's owner actions. |
| **A brand-new sign-up's welcome email waits for their answer to the first onboarding question** (WP-17, COM-08). `auWelcomeDecision`, `auHoldWelcome`, `auReleaseHeldWelcome`, `runAuHeldWelcomeBackstop` (section 29). | A doctor about whom nothing is known at the welcome moment (no pathway, no finished onboarding, no saved answer, no lead on file) is sent **nothing** when they verify their email. The moment a saved onboarding answer shows they are on today's (overseas) wizard, they get today's welcome, byte for byte; if they say they are Ahpra-registered and working in Australia they get the Australian welcome (N04) instead. A welcome nobody answered within an hour goes as today's welcome from the hourly job. Every doctor who is known at that moment (onboarding finished, already part-way through the wizard, an overseas lead on file) is welcomed at once, exactly as before. It also costs one small read of `gp_nudge_log` on the first onboarding save that carries an answer. With the switch **off** the welcome goes at verification as it always has. | The overseas welcome says "your pathway to practising medicine in Australia ... the MyIntealth step" (or invites the doctor to a call about their move). At the moment it is sent the server cannot know whether a brand-new sign-up is an overseas doctor or one already registered here, and the build's rule is that those words never reach an Australian doctor. Holding the welcome until the first answer is the only way to honour both. The words an overseas doctor receives are unchanged; only the moment can move, by minutes for anyone who opens the wizard. |

## 3. Helpers

### `lib/au-pathway-flag.js` (build setup, before WP-01)

| Helper | Contract |
| --- | --- |
| `isAuPathwayEnabled(env?) → boolean` | The one switch. Reads `process.env` at call time; `env` is injectable for tests. |

### `lib/au-lead.js` (WP-01): the lead funnel (`site_enquiries` rows)

`lead` is a row (`{ metadata: { consult } }`) or the consult object itself.
`opts.auPathwayEnabled` (boolean) overrides the switch for pure callers.

| Helper | Contract |
| --- | --- |
| `isAuSegmentLead(lead) → boolean` | The fact. Since WP-15: the segment recorded on the lead (`consult.segment` starting `au_` → true, `overseas` → false); a lead with no segment recorded (every row from before WP-15) is judged the old way, `consult.country === 'au'`. Does not look at the switch. The segment helpers (`deriveLeadSegment`, `leadSegmentFor`, …) are in section 27. |
| `auPathwayOn(opts?) → boolean` | The switch, honouring `opts.auPathwayEnabled`. |
| `auHazelBlocked(lead, opts?) → boolean` | **Permanent and unconditional** (owner decision 7): Hazel never rings an Australian-segment lead. Since WP-04 it does **not** look at the switch (`opts` is ignored): see "Deliberate exceptions to switch-off parity" in section 2. |
| `auCopyApplies(lead, opts?) → boolean` | **WP-16.** This lead gets the Australian copy: switch on **and** Australian-segment. The question every former hold site asks (section 28). False when the switch is off. |
| `auMessagesHeld(lead, opts?) → boolean` | **Retired in WP-16.** It was WP-01's interim blanket hold on every automated email and WhatsApp to an Australian-segment lead. It has **no call site** (a test checks); the name is kept only so older notes resolve. Do not call it. |
| `AU_NO_CALL_REASON`, `AU_MESSAGES_HELD_REASON` | `'au_segment'`: the Hazel skip reason shown on the Leads tab. (`AU_MESSAGES_HELD_REASON` is no longer returned by anything: the message skips now name their own reasons, section 28.) |

### `lib/candidate-pathway.js` (WP-02): pathway rules. Pure, no I/O.

| Helper | Contract |
| --- | --- |
| `PATHWAY`, `ALL_PATHWAYS`, `AU_PATHWAYS`, `OVERSEAS_PATHWAYS`, `LAUNCHED_AU_PATHWAYS`, `DEFAULT_PATHWAY` | The six values and their groupings. |
| `BASIS`, `ALL_BASES`, `SEGMENT`, `MORATORIUM_19AB`, `DPA_REASON` | Other constants (bases, segments, 19AB answers, the reason strings). |
| `normalisePathway(value) → string` | Anything → one of the six. Null / unknown / garbage → `overseas_esp`. Never invents an Australian value. |
| `isValidPathway(value) → boolean`, `isValidBasis(value) → boolean` | Exactly one of the stored values? Used by writers to refuse anything else. |
| `isAuPathway(p) → boolean` | True only for the four Australian values. |
| `isOverseasPathway(p) → boolean` | `!isAuPathway(p)`: unknown counts as overseas. |
| `segmentOf(p) → 'overseas' \| 'A' \| 'B' \| 'C'` | Segment for a pathway (unknown → `'overseas'`). |
| `isLaunchedAuPathway(p) → boolean` | True only for `au_vr` (owner decision 1). |
| `defaultBasisFor(p) → 'overseas' \| 'australia'` | The basis a pathway implies when none is stored. |
| `computeDpaRestricted({ pathway, credentials, legacyDpaExempt }) → { dpaRestricted, reason }` | **The single place the DPA rule lives.** See below. |
| `staffConfirmed19ab(credentials) → 'yes' \| 'no' \| null` | The staff-confirmed 19AB answer; counts only with a name and a timestamp against it. |
| `hasRegistrationFlags(credentials) → boolean` | A condition, undertaking or notation is flagged. |
| `resolvePathwayFromRecords({ profile, credentials, flagEnabled, legacyDpaExempt, readFailed }) → result` | The pure resolver. `flagEnabled` defaults to the switch, read at call time. |
| `overseasDefault({ flagEnabled?, legacyDpaExempt? }) → result` | The answer for "switch off" or "nothing recorded". |
| `feeBasisFor(result) → 'australia' \| 'overseas'` | Fee tier of the existing agreement (owner decision 3). No prices live here. Unknown → `'overseas'`. |
| `publicPathwayView(result) → { pathway, segment, isAu, launched }` | The only part a doctor's browser may see. |
| `derivePathwayFromOnboarding(answers) → { pathway, segment, launched, reasons }` | **WP-05. The one place onboarding answers become a pathway** (APP-07). Always one of the four Australian values; fail-safe (section 16). |

The resolver result:

```js
{ pathway, basis, segment, isAu,
  dpaRestricted, dpaRestrictedReason,
  confirmed, needsStaffReview, launched,
  recorded,      // false = nothing valid stored; this is the default
  flagEnabled,
  schemaMissing, // only when true: the migration is not applied here
  readFailed,    // only when true: the rows could not be read
  // WP-08, on an AUSTRALIAN result only (an overseas result has none of them):
  roleFit,              // { vr, registrar, supervised }: which roles the doctor fits
  hasRegistrationFlags, // a condition / undertaking / notation is on file
  flagsReviewed }       // a person has reviewed it (section 19)
```

**`dpaRestricted` replaces "country = Australia unlocks non-DPA roles".**
`false` lets the doctor see the identifying details of, and apply for, roles
that are not in a DPA. The rule (regulatory assumption **not yet confirmed**;
correct it in `computeDpaRestricted` and nowhere else):

| Doctor | Result |
| --- | --- |
| Overseas pathway (incl. NULL / unknown) | Exactly today's answer: `!legacyDpaExempt`. The caller passes `legacyDpaExempt = _resolveGpJobsProfile(userId).australiaTrained`. Not passed → restricted. Credentials are ignored. |
| Any Australian pathway, staff confirmed 19AB does **not** apply | not restricted |
| Any Australian pathway, staff confirmed 19AB applies | restricted |
| Doctor says 19AB applies | restricted |
| Doctor says it does not apply, staff have not confirmed | **restricted** (fail closed) |
| `unsure`, blank, or no credentials row | **restricted** (fail closed) |
| Rows could not be read (`readFailed`) | **restricted**, even for an overseas doctor |

For Australian pathways `legacyDpaExempt` is ignored: being trained in
Australia must never unlock a moratorium doctor. A 19AB end date that has
passed does not lift the restriction by itself; staff confirm it.

### `lib/gp-credentials.js` (WP-02): credentials and preferences. Pure, no I/O.

| Helper | Contract |
| --- | --- |
| `sanitiseCredentialsPatch(patch, { source, actor, now, existing, markVerified }) → { clean, rejected }` | Cleans a `gp_credentials` patch. Unknown columns and wrong-shaped values go to `rejected`. `source: 'self'` (the doctor) can never set a staff-only column, and a doctor **changing** their 19AB answer clears the staff confirmation. `source: 'staff'` stamps who and when on a 19AB confirmation. |
| `sanitisePreferencesPatch(patch) → { clean, rejected }` | Cleans candidate preference columns. Rejects every pathway column. |
| `readAhpraRegistration({ pathway, credentials, caseRow }) → { source, number, type, expiry, hasConditions, ... }` | **The read rule for Ahpra data** (section 6). |
| `isSupervisedRegistrationType(type) → boolean` | `provisional` or `limited` (the placement-hook matrix's "supervised" test). |
| `CREDENTIAL_FIELDS`, `STAFF_ONLY_CREDENTIAL_FIELDS`, `CREDENTIAL_COLUMNS` | The table's columns and what each holds. |
| `PATHWAY_PROFILE_COLUMNS`, `PREFERENCE_FIELDS`, `PREFERENCE_COLUMNS` | The new `user_profiles` columns. |
| `AHPRA_REGISTRATION_TYPES`, `SUPERVISED_REGISTRATION_TYPES`, `FELLOWSHIP_TYPES`, `VR_STATUSES`, `WORK_RIGHTS`, `SUPERVISION_LEVELS`, `BILLING_PREFERENCES`, `AU_STATES` | Allowed values. |

### `server.js` (WP-02): reading and writing. Search for the function name.

All are exported on `require('./server.js').__testUtils`. `userId` is the
Supabase `user_id`; **in local JSON mode it is the doctor's email** (that is how
the local store is keyed).

| Helper | Contract |
| --- | --- |
| `resolveCandidatePathway(userId, { legacyDpaExempt?, credentials? }) → Promise<result>` | **The question every package asks.** Switch off: overseas default, nothing queried. Switch on: two separate small reads, memoised per HTTP request. Migration not applied: overseas default + `schemaMissing: true` (logged once). Other read failure: overseas default + `readFailed: true`, `dpaRestricted` forced true. `credentials: false` skips the `gp_credentials` read. Never throws. |
| `resolveCandidatePathwayForSession(session, opts?) → Promise<result>` | The same for a signed-in doctor's session (works out the user key in both modes). |
| `readCandidatePathwayRecords(userId, { credentials? }) → Promise<{ profile, credentials, profileFound, schemaMissing, readFailed }>` | The raw rows the resolver uses. Switch-on callers only. |
| `setCandidatePathway(userId, { pathway, basis?, setBy, confirmed? }) → Promise<{ ok, reason?, pathway, basis, confirmed, mirroredCases, caseMirror }>` | **The only writer of a pathway.** Writes the six profile columns and mirrors `registration_cases.pathway` on every case the doctor has. `pathway: null` clears. `confirmed: true` = staff-confirmed. Switch off: `{ ok: false, reason: 'feature_off' }`, nothing queried. |
| `upsertGpCredentials(userId, patch, { source, actor?, markVerified? }) → Promise<{ ok, reason?, credentials, rejected }>` | Insert or update the doctor's `gp_credentials` row; only the columns sent change. Cleaned by `sanitiseCredentialsPatch`. |
| `setCandidatePreferences(userId, patch) → Promise<{ ok, reason?, preferences, rejected }>` | Write preference columns. Cannot touch the pathway. |
| `readCandidatePreferences(userId) → Promise<object \| null>` | Read preference columns in their own query. Null when off or unreadable. |
| `ensureAuPathwayStaffAccess(adminCtx, userId, res) → Promise<boolean>` | The staff permission check (section 8). Sends the 403 itself. |
| `buildAuPathwayStaffView(userId) → Promise<{ found, schemaMissing, view }>` | What the staff endpoints return for one doctor. |

### `lib/journey-ladders.js` (WP-03): the two stage ladders. Pure, no I/O, no switch.

Pass the pathway from `resolveCandidatePathway` (which already honours the
switch). Unknown / not recorded is the overseas ladder. Full rules: section 14.

| Helper | Contract |
| --- | --- |
| `OVERSEAS_STAGES`, `AU_STAGES`, `AU_ONLY_STAGES`, `ALL_CASE_STAGES` | The stage keys. `AU_ONLY_STAGES` = `placement, prestart, commenced, guarantee` (`complete` is on both). |
| `OVERSEAS_LADDER`, `AU_LADDER` | Rows `{ key, label, gpLabel }`. `label` is for staff; `gpLabel` is what a doctor may see (no word from AGENT-RULES section 4, and never "guarantee"). |
| `ladderIdFor(pathway) → 'overseas' \| 'au'` | `'au'` only for the four Australian pathways. |
| `ladderFor(pathway) → [{ key, label, gpLabel, index }]`, `stagesFor(pathway) → string[]` | The ladder for a pathway. |
| `initialStageFor(pathway)` | `myintealth` overseas, `placement` for every Australian pathway. |
| `stageIndex(pathway, stage) → number` | Order index, `-1` when the stage is not on that ladder. |
| `isStageOnLadder(pathway, stage)`, `isAuOnlyStage(stage)`, `isKnownStage(stage)` | Membership tests. Never throw on odd input. |
| `compareStages(pathway, a, b) → number \| null` | Negative / 0 / positive; `null` when either is not on that ladder. |
| `isForwardMove(pathway, from, to)` | A `from` on the other ladder counts as "before the start". |
| `nextStage(pathway, stage)` | The next rung, or `null`. |
| `stageLabel(stage, pathway?, fallback?)`, `gpStageLabel(...)` | A label for **any** stage value. Unknown comes back as itself. Use these instead of a new label map. |
| `sortIndexAny(stage) → number` | One sort key for a mixed list: overseas stages, then Australian, then unknown. |
| `auStageFromFacts({ currentStage, placementSecured, pathway })` | The Australian derivation: `placement`, or `prestart` once a placement is on record; never demotes. No state flag is an input. |
| `auPlacementTargetStage(pathway)` | Where a case goes when a placement is recorded: `prestart` for every Australian pathway. **Decided in WP-14** (section 26): a supervised segment B doctor also goes to `prestart`, never onto the overseas ladder. |
| `callStagesFor(pathway)`, `OVERSEAS_CALL_STAGES`, `AU_CALL_STAGES`, `ALL_CALL_STAGES_DB` | What an assistance call may be about. Australian: `prestart` only (the database allows all four; opening another is a one-line change). |
| `AU_STAGE_OVERSEAS_EQUIV_INDEX` | An Australian stage on the overseas 0..6 scale, for the ATS intent "registration progress" signal. WP-27 may retune it. |

### `server.js` (WP-03): moving an Australian case. Search for the function name.

All on `__testUtils`. The three movers return `{ ok, moved, from?, to?, reason? }`,
never throw, and with the switch off return `reason: 'feature_off'` without a query.

| Helper | Contract |
| --- | --- |
| `advanceAuCaseStage(caseId, toStage, actor, { reason? })` | **The only writer of an Australian stage.** Forward-only along the Australian ladder, one `stage_change` timeline entry (`metadata: { from_stage, to_stage, ladder: 'au', pathway }`), compare-and-set so a double call moves once. Never touches `user_state`. Refuses an overseas doctor (`not_au_pathway`), a stage not on the ladder (`invalid_stage`), a backward move (`backward_move`) and an unreadable pathway. |
| `syncCaseToPathway(userId, { actor?, reason? })` | Puts the case on the ladder that matches the pathway. `setCandidatePathway` calls it after every write (its result is returned as `caseStage`), so **WP-05 / WP-06 do not call it themselves**. Section 14 lists what it does in each case. |
| `auMoveCaseOnPlacement(userId, { source?, actor?, caseRow?, mode? })` | "A placement may have been recorded": an Australian case at `placement` moves to `prestart` if a placement is on record. Idempotent; an overseas doctor is never touched. |
| `_auStageModeFor(userId, caseRow) → { mode, pathway }` | `'overseas'` (today's code; always with the switch off), `'au'`, or `'hold'` (pathway unreadable and the case looks Australian: write no stage). Branch on this inside stage-related code. |
| `_auPlacementSecuredFact(userId) → boolean` | An active `placements` row, or a `gp_applications` row whose `status` is placement-secured. Never the doctor's own `gp_career_state`, and not a kanban card merely dragged to Hired. |
| `buildAuJourneyView(userId, pathwayResult)`, `resolveAuJourneyForSession(session, pathwayResult?)` | The doctor-facing stage and ladder (section 7). `null` for an overseas doctor and with the switch off. |
| `checkVerifiedStageForCase(caseId, stageValue) → null \| { status, message }` | The staff stage-setter guard (section 14). |
| `auStaffActionBlock(userId) → null \| 'au' \| 'unknown'` | For a staff action that must be refused for an Australian doctor (Reset GP, stage rollback). Reuse it for the next one. |

### `lib/au-sweeps.js` + `server.js` (WP-04): scheduled jobs and sweeps

Full rules in section 15; the job-by-job table is `scheduled-jobs.md`.

| Helper | Contract |
| --- | --- |
| `auSweepPathwayIndex(jobName) → Promise<index>` (`server.js`) | **Call once per job run.** The doctors on an Australian pathway, **plus (WP-05) the doctors part-way through the Australian onboarding branch** (section 16). Switch off: the inert index, nothing queried. Switch on: two reads of its own (`user_state` for the branch-started marker, then `user_profiles?select=user_id,candidate_pathway&candidate_pathway=in.(…)`, paged). Column missing: empty + one log line. Any other failure: `unreadable` (every doctor is held this run). Never throws. |
| `index.excludesUser(userId) → boolean` | **The predicate** for a doctor-keyed row. True for a doctor on any Australian pathway, and for everyone when the index is `unreadable`. |
| `index.excludesCase(caseRow) → boolean` | The predicate for a case row (`{ id, user_id, stage?, pathway? }`). Also true when the row itself says Australian (mirrored pathway, or an Australian-only stage). |
| `auSweepExcludesCaseId(index, caseId) → Promise<boolean>` (`server.js`) | For a job with only a case id in hand. Reads the Australian doctors' case ids once per run, and only when there are any. |
| `index.isAuUser(id)`, `index.reasonForUser(id)`, `index.reasonForCase(row)` | The bare fact, and `'au_pathway'` / `'pathway_unreadable'` / `null`. These do not count towards the summary. |
| `index.enabled`, `.size`, `.unreadable`, `.schemaMissing`, `.summary()` | State, and counts for the job's log line (`auSweepLog(index)` writes it). |
| `auOverseasActionBlock(userId) → Promise<null \| 'au_pathway' \| 'pathway_unreadable'>` (`server.js`) | The single-doctor form, for event-driven code (a state change, a document landing) with no job run to load an index for. Switch off: `null`, nothing queried. |
| `auSweeps.buildAuSweepIndex({ enabled, userIds, unreadable, schemaMissing, job })`, `inertAuSweepIndex(job)`, `caseRowLooksAustralian(row)` | The pure builders, for tests. |
| `auSweeps.auCaseAgeAnchor(caseRow, placementRow) → { at, basis, stage }`, `auCaseAgeDays(caseRow, placementRow, nowMs)` | **ADM-04:** the date an Australian case is aged from (never the doctor's last activity). WP-13's lifecycle job uses it. |

Typical call in a request handler:

```js
const jobs = await _resolveGpJobsProfile(userId);          // today's country answer
const p = await resolveCandidatePathway(userId, { legacyDpaExempt: jobs.australiaTrained });
if (p.readFailed) { /* do not know: do nothing an Australian doctor must not get */ }
if (p.isAu) { /* Australian branch */ } else { /* today's code, unchanged */ }
```

**Finding APP-18** ("write pathway and country explicitly at onboarding
completion"): for an Australian doctor, WP-05 calls
`setCandidatePathway(userId, { pathway, setBy: 'self', confirmed: false })` when
onboarding completes. Today's overseas onboarding writes nothing: NULL stays
NULL.

## 4. Rule for reading new columns

Until a migration is applied to a database, that database does not have the new
columns, and PostgREST **fails the whole query** (400) when a `select=` names a
column that is not there.

1. Never add a new column to an existing `select=` list that an overseas
   feature depends on. Read new columns in **their own query**.
2. Only run that query when the switch is on.
3. Tolerate the failure: treat a 400 / 404 as "not migrated, so nobody is
   Australian here" and carry on with the overseas answer.
   `resolveCandidatePathway` already does all three; prefer calling it to
   writing a new read.
4. The same applies to writes (`PATCH` / `POST` bodies naming a new column) and
   to filters (`&pathway=eq.au_vr`).

`tests/au-wp02-switch-off-no-new-queries.test.js` runs doctor and staff flows
against a stub that fails any request naming a new column, with the switch off.
**When your package adds columns or tables, add their names** to
`WP02_NEW_COLUMN_NAMES` / `WP02_NEW_TABLES` in `tests/helpers/au-fixtures.js`
(or pass your own list to `wp02NewNameViolation`) and add your flows to that
test.

**New values count too (WP-03).** A widened CHECK is not applied in production
either, so with the switch off nothing may write one of the new stage values
into `registration_cases.stage` or `scheduled_calls.stage`:
`wp03NewStageViolation(request)` is the rule, and the same test runs the
WP-03 flows against it. With the switch **on** and the migration not applied,
an Australian write is refused by the database: `_ensureRegCase` then falls
back to today's case, `advanceAuCaseStage` returns `write_failed`, and the
doctor is still told `placement` (never `myintealth`).

## 5. Migrations

- A file under `supabase/migrations/`, timestamp prefix, **`au_gp` in the
  name**: `20261120100000_au_gp_wp02_pathway_credentials.sql`.
- Additive and idempotent: `add column if not exists`, `create table if not
  exists`, nullable, no default on an existing table, nothing dropped / renamed
  / narrowed, no `update`.
- A CHECK on an existing table is added `not valid` inside a
  `pg_constraint`-guarded `do $$` block, then `validate constraint` on its own
  line. When widening an existing constraint, start from the **live** list in
  `ENVIRONMENT.md` section 9, not the migration files.
- Schema-qualify everything (`public.user_profiles`, `pg_catalog.…`,
  `public.set_updated_at()`), and no `begin` / `commit`: production runs
  migrations through `public.exec_sql(query text)`, which has an empty
  search path and cannot run transaction control.
- New service-only tables: `enable row level security`, one
  `<table>_service_all` policy `for all using ((select auth.role()) =
  'service_role')`, and `revoke all … from anon, authenticated`.
- End the file with a commented rollback note.
- Applied **locally** by `scripts/au-local/apply-migrations.sh`. **Never applied
  to any Supabase project by an agent.** The lead asks the owner once, at the end.

## 6. Ahpra registration data: one source of truth (DAT-09)

Three places hold a registration number. They are not merged and nothing was
moved.

| Where | What it is | Who reads it |
| --- | --- | --- |
| `gp_credentials.*` | **The source of truth for a doctor who already holds Ahpra registration**: number, type, conditions, undertakings, notations, expiry, last staff check. | Every Australian pathway, and only this. |
| `registration_cases.ahpra_registration_*` | What the overseas "registration granted" handler recorded when Ahpra granted registration. Still written by that handler, unchanged. | Overseas pathways. WP-14 may copy it forward into `gp_credentials`; until then it is never used for an Australian pathway. |
| `user_profiles.register_*` | The onboarding identity check against a public register (GMC, MCNZ, IMC, Ahpra): a number and a "verified" stamp. Not a registration record. | The existing register-verification flow, unchanged. |

Read it through **`readAhpraRegistration({ pathway, credentials, caseRow })`**
(`lib/gp-credentials.js`). It returns `source: 'gp_credentials' |
'registration_case' | 'none'`. An Australian pathway with no credentials row
gets `'none'`; it does not fall back to the case.

Spelling: "Ahpra" in new Australian-facing copy. Existing overseas copy that
says "AHPRA" stays byte-identical.

## 7. How a page learns the switch and the doctor's pathway

Never hard-code the switch on in a page. Load the helper:

```html
<script src="/js/au-pathway.js?v=20261122a"></script>
```

```js
GPAuPathway.init().then(function (au) {
  if (au.enabled() && au.mine().isAu) { /* Australian screen */ }
});
```

| Call | Returns |
| --- | --- |
| `GPAuPathway.init({ force? })` | A promise that always resolves (never rejects) with `GPAuPathway`. One request is shared by every caller. |
| `GPAuPathway.enabled()` | Is the switch on? `false` until `init()` has resolved, and on any failure. |
| `GPAuPathway.mine()` | `{ pathway, segment, isAu, launched }` for the signed-in doctor. Overseas until `init()` says otherwise, and on any failure. |
| `GPAuPathway.ready()` | Has `init()` finished? |
| `GPAuPathway.hinted()` | **WP-07.** Did this device last belong to a doctor on an Australian pathway? Available before `init()`. A hint for "paint nothing yet", never a reason to show an Australian screen. `init()` keeps it up to date (`localStorage gp_au_pathway_hint`). |

Where it gets them:

- `GET /api/public/features` → `{ ok, auPathwayEnabled }`. No sign-in. For site
  pages, sign-in and the first onboarding screens.
- `GET /api/auth/session` → with the switch **on** carries two extra keys,
  `auPathwayEnabled: true` and `auPathway: { pathway, segment, isAu, launched }`.
  With the switch **off** the response is byte-identical to before.

- **WP-03:** for a doctor on an Australian pathway (switch on) the same response
  carries a third key, `auJourney`:

  ```js
  { ladder: 'au', pathway: 'au_vr',
    stage: 'prestart', stageLabel: 'Pre-start checks', stageIndex: 1,
    stageKnown: true,   // false = the case could not be read; stage is then the first rung
    stages: [ { key: 'placement', label: 'Secure placement', index: 0, state: 'done' },
              { key: 'prestart',  label: 'Pre-start checks', index: 1, state: 'current' },
              { key: 'commenced', label: 'Started',          index: 2, state: 'upcoming' },
              { key: 'guarantee', label: 'Settling in',      index: 3, state: 'upcoming' },
              { key: 'complete',  label: 'Complete',         index: 4, state: 'upcoming' } ] }
  ```

  An overseas doctor's response has no `auJourney` key. The stage is never
  `myintealth` (a case not yet moved onto the Australian ladder reads as
  `placement`). It is deliberately not on `GET /api/state` (that endpoint is
  hot; this costs a query). **WP-12:** the block also carries `steps` (the four
  steps a doctor is shown) and `entryRoute`; pages read it through
  `js/au-doctor.js` (`info.journey`), not `js/au-pathway.js` (section 24).
  After a step that changes the stage call `GPAuDoctor.whenKnown({ force: true })`.

- **FB-1:** for a doctor on an Australian pathway the same response carries a
  fourth key, `auDoctor` (section 21). `js/au-pathway.js` does not expose it:
  the careers screens read it through `js/au-doctor.js`.

The browser never receives the DPA flag, its reason, or anything staff
recorded. Server code that renders HTML can call `resolveCandidatePathway`
directly. Bump the `?v=` on every change to `js/au-pathway.js` and update this
section; `tests/au-wp02-client-helper-and-migration.test.js` pins that the two
match. `/api/auth/session` is cached by `js/gp-cache.js` (stale-while-
revalidate), so after a pathway change a page may show the old value for one
load; call `GPAuPathway.init({ force: true })` after a step that changes it.

## 8. Staff endpoints

`GET  /api/admin/candidate/pathway?user_id=…`
→ `{ ok, user_id, pathway: <resolver result>, feeBasis, record, credentials, ahpra, case, preferences }`

`POST /api/admin/candidate/pathway`
`{ user_id, pathway?, basis?, confirmed?, moratorium_19ab_confirmed?, moratorium_19ab_end_date?, note? }`
→ the same view after the change, plus `caseMirror` and `mirroredCases`.

- `pathway`: one of the six, or `null` to clear. A pathway set here is
  staff-confirmed unless `confirmed: false`.
- `moratorium_19ab_confirmed`: `'yes'`, `'no'` or `null`. `'no'` is the only
  thing that lifts the DPA restriction for an Australian pathway.
- Everything is validated before anything is written: a bad field is a 400 and
  nothing changes.
- **Switch off: 404**, as if the route did not exist.
- Migration not applied: 503 `{ code: 'schema_missing' }`.

Who may call them (`ensureAuPathwayStaffAccess`):

| Role | Access |
| --- | --- |
| CEO / super admin | Any doctor. |
| Consultant | Any candidate. This follows the existing ATS model (consultants share the whole ATS surface through `requireAtsSession`) and owner decision 6: the placing consultant owns an Australian GP until placement. |
| RSO (role `admin` / `staff`) | Only doctors whose case is assigned to them (`ensureAdminCaseAccess`). No case, or someone else's: 403. |

The admin onboarding override `POST /api/admin/seed-onboarding` (super admin,
non-production only) accepts `country: 'AU'` plus `pathway` when the switch is
on (DAT-19). Australia without an Australian pathway is refused, so a doctor is
never left looking Australian with no pathway behind it.

## 9. Audit log

Use the existing admin audit helper for every staff action:

```js
await logAdminAction(req, adminCtx, 'admin_set_candidate_pathway', {
  targetType: 'user', targetId: userId,
  detail: { before: {...}, after: {...}, note }
});
```

It writes to `public.admin_audit_log`, never throws, is awaited (a detached
promise is lost when the serverless function freezes), and is a no-op in local
JSON mode. Pass `success: false` for a refused or failed attempt. Keep `detail`
small (it is capped at 4,000 characters) and free of personal data beyond the
user id. New Australian actions use the prefix `admin_` and a stable verb.

## 10. Tests

**Switching the flag.** It is read at call time, so one booted server can serve
both states in one file:

```js
process.env.AU_PATHWAY_ENABLED = 'false';   // off
process.env.AU_PATHWAY_ENABLED = 'true';    // on (also the default under NODE_ENV=test)
```

`h.setSwitch(true | false)` on the harness does this and restores the old value
on `close()`. Every package tests three things: the Australian behaviour, the
unchanged overseas behaviour with the switch **on** (nothing recorded), and the
switch **off**.

**Fixtures: `tests/helpers/au-fixtures.js`.** Six standard doctors, every row in
the shape the server stores it. All identities are obviously fake.

| `buildAuDoctor(kind)` | Who |
| --- | --- |
| `'au_vr'` | Segment A. Staff-confirmed, FRACGP, staff-confirmed "19AB does not apply": the launched, unrestricted happy path. |
| `'au_restricted'` | Segment B. 19AB applies (doctor and staff), visa tied to a sponsor. |
| `'au_non_vr'` | Segment C. Not VR, 19AB unsure, self-declared. |
| `'au_registrar'` | Segment C. Registrar; says 19AB does not apply, staff have not confirmed. |
| `'overseas_null'` | An existing overseas doctor with nothing recorded. **The regression doctor.** |
| `'overseas_explicit'` | An overseas doctor whose pathway staff recorded as `overseas_esp`. |

Each returns `{ kind, userId, caseId, email, name, profile, credentials,
caseRow, state, expected }`. `expected` is what the resolver should say.
Overrides: `buildAuDoctor('au_vr', { credentials: {...}, profile: {...},
caseRow: {...}, state: {...}, selfDeclared: true, noCase: true, idSuffix: '2' })`.
Also `buildAllAuDoctors()`, `buildAuFixtureDb(doctors)` (tables for the
emulator), `buildAuLocalDb(doctors)` (the local JSON file), `STAFF_EMAIL`,
`FIXED_NOW`, `WP02_NEW_COLUMN_NAMES`, `WP02_NEW_TABLES`.

A fixture case sits where the server would put it: `placement` for the four
Australian doctors, `myintealth` for the two overseas ones. Override with
`{ caseRow: { stage: 'prestart' } }`. `WP03_NEW_STAGE_VALUES` and
`wp03NewStageViolation(request)` are the switch-off rule for stage values
(section 4).

**Database stub: `tests/helpers/au-supabase-emulator.js`.**
`startAuSupabaseEmulator({ tables, missingColumns, missingTables, failTables })`
is an in-memory PostgREST. It records every request (`emu.requests`), can
pretend the migration is not applied (`missingColumns`, `missingTables` answer
the way PostgREST really does), and `emu.forbid(fn)` fails and records
(`emu.violations`) any request `fn` objects to. `wp02NewNameViolation(request,
{ columns, tables })` is the ready-made rule for "names a new column".

**Server boot: `tests/helpers/au-server-harness.js`.**
`bootAuTestServer({ name, tables })` (emulator mode) or
`bootAuTestServer({ name, mode: 'local', localDb })` boots the real server once
per test file and returns `h.get / post / put`, `h.gpCookie(email, userId)`,
`h.superAdmin()`, `h.consultant()`, `h.rso(email?)` (each `{ cookie, host }`),
`h.setSwitch`, `h.emu`, `h.testUtils`, `h.readLocalDb()`, `h.close()`. Outbound
fetch to anything but `127.0.0.1` is answered with an empty 200, and no sending
keys are set.

Run one file: `npx vitest run tests/au-wp02-pathway-server.test.js`. Node is at
`~/gplink-tools/node-v22/bin`.

## 11. New-column inventory

Everything `20261120100000_au_gp_wp02_pathway_credentials.sql` adds. After it is
applied, each row here should exist. All columns are nullable with no default
except where noted. 20 columns on `user_profiles`, 1 on `registration_cases`,
35 on the new table `gp_credentials`.

| Table | Column | Type | Notes |
| --- | --- | --- | --- |
| `user_profiles` | `candidate_pathway` | text | CHECK `user_profiles_candidate_pathway_check`: NULL or one of the six |
| `user_profiles` | `candidate_basis` | text | CHECK `user_profiles_candidate_basis_check`: NULL, `overseas`, `australia` |
| `user_profiles` | `pathway_set_by` | text | staff email, or `self` |
| `user_profiles` | `pathway_set_at` | timestamptz | |
| `user_profiles` | `pathway_confirmed_at` | timestamptz | NULL with a pathway set = self-declared, pending staff |
| `user_profiles` | `pathway_confirmed_by` | text | |
| `user_profiles` | `current_suburb` | text | |
| `user_profiles` | `current_state` | text | NSW, VIC, QLD, WA, SA, TAS, ACT, NT (validated in code) |
| `user_profiles` | `current_postcode` | text | four digits (validated in code) |
| `user_profiles` | `current_latitude` | double precision | |
| `user_profiles` | `current_longitude` | double precision | |
| `user_profiles` | `commute_radius_km` | integer | |
| `user_profiles` | `notice_period_weeks` | integer | |
| `user_profiles` | `available_from` | date | |
| `user_profiles` | `sessions_wanted` | numeric(4,1) | sessions a week |
| `user_profiles` | `billing_preference` | text | bulk, mixed, private, any (validated in code) |
| `user_profiles` | `special_interests` | text[] | house style: `career_roles.tags` is `text[]` |
| `user_profiles` | `open_to_locum` | boolean | locum work is out of scope; recorded only |
| `user_profiles` | `open_to_relocate` | boolean | |
| `user_profiles` | `timezone` | text | IANA name, for WP-10 |
| `registration_cases` | `pathway` | text | mirror of the profile; CHECK `registration_cases_pathway_check`; partial index `idx_registration_cases_pathway` |
| `gp_credentials` | `user_id` | uuid | PRIMARY KEY, references `public.user_profiles(user_id)` on delete cascade |
| `gp_credentials` | `ahpra_number` | text | three letters + ten digits (validated in code) |
| `gp_credentials` | `ahpra_registration_type` | text | general, specialist, general_and_specialist, provisional, limited, non_practising (validated in code) |
| `gp_credentials` | `specialist_gp` | boolean | on the specialist register as a GP |
| `gp_credentials` | `has_conditions` | boolean | |
| `gp_credentials` | `conditions_text` | text | |
| `gp_credentials` | `has_undertakings` | boolean | |
| `gp_credentials` | `undertakings_text` | text | |
| `gp_credentials` | `has_notations` | boolean | |
| `gp_credentials` | `notations_text` | text | |
| `gp_credentials` | `registration_expiry` | date | partial index `idx_gp_credentials_registration_expiry` |
| `gp_credentials` | `fellowship_type` | text | CHECK: fracgp, facrrm, both, other, none |
| `gp_credentials` | `fellowship_detail` | text | free text when `other` |
| `gp_credentials` | `fellowship_year` | integer | |
| `gp_credentials` | `vr_status` | text | CHECK: vr, non_vr, unsure |
| `gp_credentials` | `moratorium_19ab_status` | text | the doctor's answer. CHECK: yes, no, unsure |
| `gp_credentials` | `moratorium_19ab_end_date` | date | |
| `gp_credentials` | `work_rights` | text | CHECK: citizen, pr, visa |
| `gp_credentials` | `visa_subclass` | text | |
| `gp_credentials` | `visa_expiry` | date | |
| `gp_credentials` | `visa_sponsor_tied` | boolean | visa tied to a sponsoring employer |
| `gp_credentials` | `visa_sponsor_name` | text | |
| `gp_credentials` | `supervision_level` | text | none, level_1 to level_4 (validated in code) |
| `gp_credentials` | `indemnity_provider` | text | |
| `gp_credentials` | `indemnity_expiry` | date | |
| `gp_credentials` | `ahpra_last_checked_at` | timestamptz | staff only |
| `gp_credentials` | `ahpra_last_checked_by` | text | staff only |
| `gp_credentials` | `moratorium_19ab_confirmed_status` | text | staff only. CHECK: yes, no |
| `gp_credentials` | `moratorium_19ab_confirmed_by` | text | staff only |
| `gp_credentials` | `moratorium_19ab_confirmed_at` | timestamptz | staff only |
| `gp_credentials` | `staff_verified_at` | timestamptz | staff only |
| `gp_credentials` | `staff_verified_by` | text | staff only |
| `gp_credentials` | `self_declared_at` | timestamptz | stamped when the doctor's own answers are saved |
| `gp_credentials` | `created_at` | timestamptz | NOT NULL default `now()` (new table, so no backfill) |
| `gp_credentials` | `updated_at` | timestamptz | NOT NULL default `now()`; trigger `trg_gp_credentials_updated_at` |

Also created: RLS on `gp_credentials` with policy `gp_credentials_service_all`
(service role only; `anon` and `authenticated` grants revoked).

Added by `20261120130000_au_gp_wp08_role_fields.sql` (WP-08, section 19). All
nullable, no default. (Written as `table.column` so the WP-02 inventory above
stays exactly the WP-02 migration.)

| Column | Type | Notes |
| --- | --- | --- |
| `career_roles.vr_requirement` | text | CHECK `career_roles_vr_requirement_check`: vr_required, vr_preferred, non_vr_accepted |
| `career_roles.accepts_registrars` | boolean | |
| `career_roles.accepts_supervised` | boolean | |
| `career_roles.engagement_type` | text | CHECK `career_roles_engagement_type_check`: permanent, contract |
| `career_roles.sessions_min` | numeric(4,1) | CHECK `career_roles_sessions_range_check` (0 to 14, min not above max) |
| `career_roles.sessions_max` | numeric(4,1) | |
| `career_roles.special_interests` | text[] | |
| `career_roles.dpa_status` | text | CHECK `career_roles_dpa_status_check`: yes, no, unknown. Beside the unchanged `dpa` boolean |
| `user_profiles.preferred_locations` | text[] | server-written from validated onboarding answers |
| `gp_credentials.flags_reviewed_at` | timestamptz | staff only |
| `gp_credentials.flags_reviewed_by` | text | staff only |

Added by `20261120140000_au_gp_wp09_profile_share_consent.sql` (WP-09, section
20). All nullable, no default.

| Column | Type | Notes |
| --- | --- | --- |
| `gp_applications.profile_share_consent_at` | timestamptz | NULL = no consent on file |
| `gp_applications.profile_share_consent_version` | text | which wording was shown (`CONSENT_VERSION`) |
| `gp_applications.profile_share_consent_source` | text | CHECK `gp_applications_profile_share_consent_source_check`: doctor, staff_verbal |
| `gp_applications.profile_share_consent_by` | text | `self`, or the staff member's email |
| `gp_applications.profile_share_consent_role_id` | text | the role the consent covers (`career_role_id` as text) |

Existing columns deliberately **reused, not duplicated**:

| Need | Existing column used | Why |
| --- | --- | --- |
| Where the doctor wants to work | `user_profiles.preferred_city` | Already drives job ranking. `current_suburb` etc. are where the doctor lives now, a different fact. |
| Country trained in | `user_profiles.qualification_country`, `registration_country` | Unchanged. Pathway and basis are now explicit, so these no longer need to stand in for them. |
| Public-register identity check | `user_profiles.register_*` | Unchanged (section 6). |

Not reused: `target_arrival_date` (free text, and about arriving from overseas)
versus the new `available_from` (a real date for a doctor already here).

## 12. Notes for the next packages

- **WP-03 (stages, case creation).** When a case is created, copy the profile's
  `candidate_pathway` into `registration_cases.pathway` (`setCandidatePathway`
  only mirrors onto cases that already exist). The case column is a filter
  convenience; decide from `resolveCandidatePathway`, not from the case.
- **WP-03 is done** (section 14). The note above is kept for history: cases are
  created at `placement` with the pathway copied on, and `setCandidatePathway`
  now moves an existing case onto the right ladder.
- **WP-04 (sweeps), from WP-03.** Nothing in WP-03 filters a sweep. What is
  already safe: `resolveGpJourneyPosition` returns the Australian stage with
  `ladder: 'au'`, and `sendStalledNudgeForPosition` skips the overseas stage
  reminder for it (`{ skipped: 'au_pathway' }`). **Still yours:**
  `chaseStalledCase` still opens the chase *task* for an Australian case
  (titled "GP stalled … on placement"); the weekly, SLA, chase and stuck-case
  sweeps are unfiltered; the overseas stage messages inside
  `processRegistrationTaskAutomation` (MyIntealth welcome WhatsApp, "AMC
  stage", "Career stage", "Visa stage", `_maybeNotifyAhpraDocsReady`) still
  fire if an Australian doctor's browser writes those state keys. Branch them
  on the `auStage` constant already computed at the top of that function
  (`auStage.mode !== 'overseas'`). The MyIntealth page-open WhatsApp (on your
  list) is not gated by WP-03; the page itself is no longer served to an
  Australian doctor. An onboarding-phase Australian doctor
  still gets the onboarding step email from `sendStalledNudgeForPosition`.
- **WP-04 (sweeps).** Filtering a sweep with `&pathway=…` names a new column:
  switch-on only, and remember NULL is overseas (`pathway=is.null` or the two
  overseas values), not "no pathway to worry about".
- **WP-04 is done** (section 15, `scheduled-jobs.md`). The two notes above are
  kept for history. No sweep was given a `&pathway=` filter: every job filters
  in memory against one index. Everything on WP-03's hand-over list is closed
  except the placement cascade, which was always WP-11's.
- **Everyone, from WP-04: a new scheduled job or sweep.** If it can message a
  doctor, open a task on a case, or score / stamp a doctor, load
  `auSweepPathwayIndex('<job>')` once and apply `excludesUser` / `excludesCase`
  before acting, then add a row to `scheduled-jobs.md`. If it is genuinely the
  same for an Australian doctor, say so in that table instead. If your package
  gives a job real Australian behaviour, replace that job's one `excludes…`
  call with your branch (the list of hooks is in `scheduled-jobs.md`).
- **Everyone, from WP-04: a custom database stub.** The index reads
  `user_profiles` with a `candidate_pathway=in.(…)` filter. A hand-rolled test
  stub that ignores unknown filters returns every profile; the index checks
  each row's own `candidate_pathway` as well, so such a stub does not turn
  everyone Australian. A stub that answers that query with a 500 makes the
  index `unreadable` and every pathway-aware job holds: answer it with `[]`,
  or a 400 (column missing).
- **WP-11, from WP-04. Done in WP-11 (section 23):** the block is gated by
  `placementHooksFor`, so none of this is created or sent for a doctor on an
  Australian pathway. What it said before: the "Career secured" block of
  `processRegistrationTaskAutomation` creates the SPPA-00 / Section G /
  supervisor CV tasks and sends the practice-pack email for an Australian
  doctor. WP-04 removed only the "AHPRA step unlocked" WhatsApp and email from
  that block. Once you stop those tasks being created, the three exclusions
  that exist only to cope with them (Section G sweep, SPPA backfill scan, SPPA
  practice chase) become belt and braces.
- **WP-14, from WP-04.** Three gates treat every Australian pathway alike and
  are yours to open for segment B if it needs them: the registration-granted
  flow (`handleAhpraRegistrationGranted` returns `skipped: 'au_pathway'`), the
  AHPRA officer chase, and the visa bell item (`pushVisaNotificationToOwner`).
- **WP-14 is done** (section 26). The note above is kept for history. Decided:
  the grant flow still does nothing for every Australian pathway (a segment B
  outcome is recorded by a person from the Segment B card); the officer chase
  still leaves every Australian doctor alone (a segment B doctor's AHPRA mail
  never stores an officer on the case, so there is nobody to chase); the visa
  bell follows `visaBellAllowed`.
- **WP-05 (onboarding).** Write the pathway with `setCandidatePathway(userId,
  { pathway, setBy: 'self', confirmed: false })` and the doctor's answers with
  `upsertGpCredentials(userId, patch, { source: 'self' })` and
  `setCandidatePreferences`. Do not add pathway fields to `USER_STATE_KEYS`,
  `sanitizeProfileInput` or the onboarding-complete profile payload.
- **WP-05 is done** (section 16). The note above is kept for history.
- **WP-06 (staff tools).** The Ahpra check writes through
  `upsertGpCredentials(userId, patch, { source: 'staff', actor, markVerified: true })`
  with `ahpra_last_checked_at / _by`. The pathway control posts to
  `/api/admin/candidate/pathway`. Decide whether a consultant should be allowed
  to staff-confirm 19AB; today any role that passes the access check can.
- **WP-06 is done** (section 17). Decided: a consultant **may** record the
  staff 19AB answer (they own an Australian GP until placement and do the
  register check). The audit row names who did it.
- **Everyone, from WP-06: new names in the switch-off guard.** WP-06 adds one
  column (`registration_cases.placing_consultant`) and eleven task-type values.
  `WP06_NEW_COLUMN_NAMES`, `WP06_NEW_TASK_TYPES` and `wp06NewNameViolation(request)`
  are in `tests/helpers/au-fixtures.js`; combine the rule with
  `wp02NewNameViolation` / `wp03NewStageViolation` in a switch-off test.
- **WP-08 (eligibility).** Rewire the four call sites of
  `gpQualifiesForRole(..., { australiaTrained })` and AI matching's
  `dpaEligible` to `!p.dpaRestricted`, passing
  `legacyDpaExempt: jobsProfile.australiaTrained`. That keeps overseas doctors
  byte-identical and closes ADM-07 / APP-17. WP-02 did not touch those sites.
- **WP-08 is done** (section 19). The note above is kept for history. Every
  former country-test site asks `roleEligibility.roleEligibilityFor`, and
  WP-05's interim guard inside `_resolveGpJobsProfile` is removed.
- **Everyone, from WP-08: new names in the switch-off guard.** WP-08 adds
  eleven columns. `WP08_NEW_COLUMN_NAMES` and `wp08NewNameViolation(request)`
  are in `tests/helpers/au-fixtures.js`; combine the rule with the WP-02 /
  WP-03 / WP-06 ones in a switch-off test (the "WP-08 flows" case in
  `tests/au-wp02-switch-off-no-new-queries.test.js` shows how).
- **WP-09 is done** (section 20).
- **Everyone, from WP-09: new names in the switch-off guard.** WP-09 adds five
  columns to `gp_applications`. `WP09_NEW_COLUMN_NAMES` and
  `wp09NewNameViolation(request)` are in `tests/helpers/au-fixtures.js`; the
  "WP-09 flows" case in `tests/au-wp02-switch-off-no-new-queries.test.js`
  shows how to combine it with the earlier rules.
- **Everyone, from WP-09: a new Australian WhatsApp.** Add a row to
  `lib/au-whatsapp-templates.js` (not approved) and to
  `docs/au-gp/whatsapp-templates.md`, and ask `auWhatsAppTemplate(key)` before
  sending. Not approved means email or nothing. Never reuse an existing
  template for an Australian message.
- **Everyone, from WP-09: text a practice reads about an Australian doctor.**
  Run it through `careerIntro.auPracticeTextViolations(text)` in a test. An
  Australian doctor's `POST /api/career/apply` now needs
  `shareConsent: { agreed: true, version }` (section 20): a test that applies
  an Australian doctor must send it.
- **WP-11 (placement cascade), from WP-03. Done in WP-11 (section 23);** the
  rest of this note describes the state before it. The cascade is untouched: an
  Australian placement still creates the SPPA-00 / Section G / supervisor CV
  tasks and sends the practice-pack email, in the "Career secured" block of
  `processRegistrationTaskAutomation` and in `finalizeInAppPlacement` steps
  5 and 8. WP-03 only added the stage move (`auMoveCaseOnPlacement`, called at
  the end of the automation pass and as step 6b of `finalizeInAppPlacement`).
  `handleAhpraRegistrationGranted` is not gated either, but its stage move is
  now refused for an Australian doctor (`applyVerifiedStageToGp` returns
  `ok: false`); the rest of that handler (visa case, tasks) is yours / WP-14's.
- **WP-12 (GP app), from WP-03.** Render the journey from `auJourney` (section
  7). The four overseas step pages are already refused server-side for an
  Australian doctor (302 to `/pages/index`, list: `AU_BLOCKED_PAGE_STAGES`);
  the client stage lists (`js/journey-stages.js`, `js/app-shell.js`,
  `js/state-sync.js`, `pages/index.html`) are untouched and still draw the
  overseas journey.
- **WP-13 (commencement), from WP-03.** Move the case with
  `advanceAuCaseStage(caseId, 'commenced' | 'guarantee' | 'complete', actor,
  { reason })`. It is forward-only: an "undo commencement" needs a decision and
  its own function. To allow check-in calls about `commenced` / `guarantee`,
  add them to `AU_CALL_STAGES` (the database already allows them).
- **WP-14 (segment B), from WP-03.** `auPlacementTargetStage(pathway)` is the
  hook for "prestart or ahpra". `ahpra` is not on the Australian ladder, so
  that branch also needs a decision on which ladder such a case is on. The
  AHPRA step page is blocked for every Australian pathway
  (`AU_BLOCKED_PAGE_STAGES`). **Decided in WP-14: `prestart`** (section 26).
  The AHPRA page stays blocked; the visa address serves one doctor's transfer
  page.
- **WP-26 (dashboards), from WP-03.** The server refuses, with a plain message,
  an overseas stage on an Australian case, Reset GP and stage rollback (all
  `code: 'au_pathway'` or `'stage_not_allowed_for_pathway'`). The pages still
  offer them: the "VA Verified Stage" dropdowns (`pages/admin.html`,
  `pages/ceo-dashboard.html`) list the overseas stages only, and the journey
  rail on both pages is the overseas one (an Australian case shows no current
  step past `placement`). Stage pills fall back to the raw key (`prestart`).
  The candidate profile endpoint already returns the Australian rail. The
  assistance-call emails and reminders label an Australian call with the raw
  key except the first invite (label maps near `buildZoomCallInviteEmailHtml`
  callers): switch them to `journeyLadders.stageLabel`.
- **WP-27 (metrics), from WP-03.** An Australian case is excluded from the
  overseas funnel (`lib/ceo-metrics.js _caseInStage`) and from stage velocity;
  no Australian funnel exists. `atsRegStageIndex` maps Australian stages onto
  the overseas scale (`AU_STAGE_OVERSEAS_EQUIV_INDEX`).
- **Everyone.** `p.readFailed` means "the rows could not be read": hold off on
  anything an Australian doctor must not receive. `p.schemaMissing` means the
  migration is not applied to this database, so nobody there is Australian.

## 13. Preview send lock

Written by WP-00S. **Read this before adding anything that sends a message or
writes to an outside account.**

**The rule.** The Vercel preview shares the production database and the
production Resend, DoubleTick, Gmail, Google Calendar and Calendly keys. So on
a preview nothing may reach a person who is not in `NOTIFY_TEST_RECIPIENTS`,
and if that list is not set, nothing is sent at all.

"Preview" means `VERCEL_ENV` is set and is not `production`. Never use
`NODE_ENV` for this (Vercel sets it to `production` on previews). The lock is
not tied to `AU_PATHWAY_ENABLED`: it protects every preview, whatever is being
tested. On production, on localhost and under the test runner the lock is off
and everything behaves as it always has (localhost still has the older
opt-in `NOTIFY_TEST_RECIPIENTS` allow-list for Resend and DoubleTick only).

| Where | List unset | List set |
| --- | --- | --- |
| Production (`VERCEL_ENV=production`) | unrestricted | Resend + DoubleTick limited to the list (unchanged) |
| Localhost / tests (no `VERCEL_ENV`) | unrestricted | Resend + DoubleTick limited to the list (unchanged) |
| **Preview** | **everything blocked** | every channel limited to the list |

### The helper

`lib/preview-send-lock.js`. Pure, takes `env` or a lock built from one. In
`server.js` get the lock with **`currentSendLock()`** at the moment of sending.
Never store it in a module-level constant.

| You are adding | Use | On a preview |
| --- | --- | --- |
| An email through Resend | `sendEmail(...)` (it ends in `guardedNotifyFetch('email', …)`). Never a raw `fetch` to Resend | Filtered to the list; blocked result is `{ ok:false, skipped:true, blocked:true, error:'blocked_by_test_allowlist' }` |
| A WhatsApp through DoubleTick | `guardedNotifyFetch('whatsapp', url, init)` or one of the existing senders. Never a raw `fetch` to `/whatsapp/message/…` | Filtered; a block is a 403 response with `error:'blocked_by_test_allowlist'` |
| An email through the Gmail API | `sendGmailEmail(...)`. Never call `gmail.users.messages.send` anywhere else | to/cc filtered to bare listed addresses; nobody left returns `{ ok:false, error:'blocked_by_preview_send_lock' }` |
| A calendar event | `gcalCreateEvent` / `gcalDeleteEvent`. A new update path must call `previewSendLock.calendarChangeSendUpdates(currentSendLock())` | Unlisted attendees dropped; `sendUpdates=none` if any were dropped or no list; deletes are always `none` |
| A write to an outside account that is not a message (assign, tag, rename) | `if (previewSendLock.blocksAccountWrites(currentSendLock())) return <the caller's harmless no-op shape>;` | Skipped and logged |
| Something that makes a third party email one person (a Calendly booking) | `previewSendLock.permitsEmailTo(currentSendLock(), email)` | Only for a listed address |
| A phone call | `placeLeadCall` only | Only numbers in `LEAD_CALLS_TEST_NUMBERS` |
| A brand-new channel (SMS, push, another provider) | Add a function to `lib/preview-send-lock.js` with unit tests, call it at the single place the network call is made, and add a row here | Must fail closed |

Other rules:

- **Log with `previewSendLock.mask(recipient)`**, never the full address or
  number. Prefix `[preview-send-lock]`.
- **Return the shape the caller already treats as "not sent"**. Never throw,
  and never return something a retry loop would keep retrying.
- **One choke point per channel.** If you need a second place that talks to a
  provider, route it through the existing function instead.
- **Tests.** `tests/preview-send-lock.test.js` (rules) and
  `tests/preview-send-lock-server.test.js` (the real server with a recording
  `fetch`). A new send path needs a case in the second file proving: preview
  blocks it with no network call, and `VERCEL_ENV=production` / unset behaves
  as before. Tests flip `process.env.VERCEL_ENV` and
  `process.env.NOTIFY_TEST_RECIPIENTS` between cases; that works because the
  lock is read at call time. Test hooks: `__testUtils.__setGmailClientForTest`
  and `__testUtils.__setGoogleAccessTokenForTest`.
- **Checking a deployment.** `GET /api/health` on a preview carries
  `previewSendLock: 'allowlist' | 'block_all'`. Production never has the field.
  The server also logs the mode once at start-up.

Not covered by the lock (see `ENVIRONMENT.md`, "What changed since this
audit"): web push (no keys anywhere), Gmail drafts (nothing is sent), Zoom and
Twilio (no keys on preview), Facebook/Instagram publishing and Meta ads tools
(staff-triggered, no doctor or practice is contacted), and anything
**production** itself sends about a test doctor.

## 14. Stage ladders (WP-03)

**In one paragraph.** A case is on one of two ladders, chosen by the doctor's
pathway. The overseas ladder is worked out from what the doctor has ticked off
in the app, exactly as it always was. The Australian ladder is never worked out
from those ticks: it starts at `placement`, moves to `prestart` when a
placement is recorded, and from there only moves when staff say so. With the
switch off there is only the overseas ladder.

| Ladder | Pathways | Stages |
| --- | --- | --- |
| overseas | `overseas_esp`, `overseas_pep`, nothing recorded, anything unknown | `myintealth → amc → career → ahpra → visa → pbs → commencement → complete` |
| au | `au_vr`, `au_restricted`, `au_non_vr`, `au_registrar` | `placement → prestart → commenced → guarantee → complete` |

### What each Australian stage means, and who moves a case into it

| Stage | Meaning | Who moves the case here |
| --- | --- | --- |
| `placement` | No placement recorded yet. | The server, when the case is created (`_ensureRegCase`) or when a pathway is set on a doctor who already has a case (`syncCaseToPathway`). |
| `prestart` | A placement is recorded; pre-start checks are under way. | The server, automatically, when a placement is on record (`auMoveCaseOnPlacement`). Staff may also set it with the verified-stage control. |
| `commenced` | Staff confirmed the doctor started work. Lasts the first week. | "Confirm commenced" (`auCommencement.confirmCommencement`, section 25). |
| `guarantee` | The placement-guarantee period is running (shown from week 1; the period itself runs from commencement). | The daily lifecycle job at the week-1 check-in, or "Confirm commenced" when it is recorded more than a week late (section 25). |
| `complete` | The guarantee period ended, or the doctor left; the case is finished. | The daily lifecycle job the day after the period ends, the CEO's "Close case", or "Doctor left during the guarantee" (section 25). |

Rules:

- **Forward only.** Every Australian stage write goes through
  `advanceAuCaseStage`. Nothing demotes an Australian case, including the staff
  control (409). **One exception (WP-13):** a commencement recorded in error
  returns the case to `prestart` through the same function's `undoCommencement`
  option, CEO only, with a reason, marked on the timeline (section 25).
- **Facts, not flags.** "A placement is recorded" means an active `placements`
  row or an application whose status is placement-secured
  (`_auPlacementSecuredFact`). The doctor's own `gp_career_state` is a mirror
  their browser can write, so it never moves an Australian case. A kanban card
  merely dragged to Hired does not count either: staff can drag it back, and an
  Australian stage cannot go back. EPIC, AMC,
  AHPRA and visa flags are never read for an Australian doctor's stage.
- **No overseas keys are stamped.** For an Australian doctor the state sync
  writes no `gp_registration_return_overrides`, `gp_admin_stage_override` or
  `gp_stage_override_at`.
- **Unknown fails closed.** Pathway unreadable and the case looks Australian
  (`pathway` on the row, or an Australian-only stage): no stage is written at
  all. Pathway unreadable at case creation: today's case.
- **The old state-sync guard is untouched.** `PUT /api/state` still compares
  the overseas-derived stage before and after to stop a blank progress object
  undoing real progress. It only ever restores keys in the doctor's state; it
  never writes the case, so it is harmless for an Australian doctor and was
  left exactly as it was for everyone.

### Where a placement moves the case (the entry points)

| Entry point | How it reaches `auMoveCaseOnPlacement` |
| --- | --- |
| `finalizeInAppPlacement`, i.e. all three places a placement is recorded: `POST /api/ats/placement` (staff "Mark placement secured"), `POST /api/admin/ops/record-placement`, and `POST /api/career/contract/finalize-signed` (the signed contract) | Step 5 (the automation pass) and step 6b (directly, so it still happens when the state read fails). |
| The state-change path (`PUT /api/state` → `processRegistrationTaskAutomation`), the ops replay (`/api/admin/ops/replay-career-secured`), a Zoho-synced placement | The Australian branch at the end of `processRegistrationTaskAutomation`, which re-checks the placement fact on every pass while the case is at `placement`. |
| The bulk case sync (`POST /api/admin/cases/sync`) | Directly, instead of the overseas derivation. |

### What `syncCaseToPathway` does

| Pathway now | Case is at | Result |
| --- | --- | --- |
| Australian | an overseas stage (`myintealth`, …) | Moved once to `placement` (or `prestart` if a placement is on record). |
| Australian | an Australian stage | Nothing. Calling again is a no-op. |
| Overseas / nothing recorded | an Australian-only stage (staff corrected AU → overseas) | Put back at the stage `_deriveStageFromState` gives for the doctor's state. |
| Overseas / nothing recorded | an overseas stage | Nothing, ever. |
| any | no case | Nothing (it does not create one). |

### The staff stage setter, Reset GP and rollback (ADM-05)

- `PUT /api/admin/case` and `PUT /api/admin/ops/case` with `gp_verified_stage`
  are checked by `checkVerifiedStageForCase` **before anything is written**.
  Australian doctor: only an Australian ladder stage or blank (400 otherwise),
  only forwards (409). The move is `advanceAuCaseStage`; nothing is written to
  the doctor's state. Overseas doctor: as before, except `prestart`,
  `commenced` and `guarantee` are refused (400).
- `placement` is also an **overseas override value** (index 0, "reset
  everything"). The live CHECK always rejected it as a case stage, so that
  control never changed the case row for it. `applyVerifiedStageToGp` now skips
  the case write for it explicitly, so widening the CHECK does not change what
  happens to an overseas doctor.
- `POST /api/admin/reset-gp` and `POST /api/admin/registration-return-overrides`
  answer 409 `{ code: 'au_pathway' }` for an Australian doctor (and 409
  `pathway_unreadable` when the pathway cannot be read), and audit the refusal.
- `POST /api/admin/calls/schedule`: an Australian doctor's call must be about a
  stage in `AU_CALL_STAGES`; an overseas doctor's is unchanged.

### Stage-enumerating sites and unknown values

Do not add another list of stage names. Use `lib/journey-ladders.js`. Every
existing list was checked for the four new values; the ones that needed a code
change are `_ensureRegCase`, `processRegistrationTaskAutomation`,
`applyVerifiedStageToGp`, `resolveGpJourneyPosition`, the bulk case sync, the
call-schedule validation, `atsRegStageIndex` / `atsRailLabel` / the candidate
rail, the page gate, and `lib/ceo-metrics.js _caseInStage`. The rest fall back
safely (an unknown stage shows as its raw key and sorts after the known ones).

### Migration

`20261120110000_au_gp_wp03_stages.sql` adds no column. It widens
`registration_cases_stage_check` (adds `placement, prestart, commenced,
guarantee`) and `scheduled_calls_stage_check` (adds the same four). Each is a
drop and re-add inside one `do $$` block (atomic), skipped when already
widened. Applied to the local test database only.

## 15. Scheduled jobs and sweeps (WP-04)

**In one paragraph.** A scheduled job never decides for itself whether a
doctor is Australian. It loads one index per run and asks it. A doctor on an
Australian pathway is left alone by every job that would treat them like a
doctor moving country, and by every job that judges a case by how recently the
doctor used the app. With the switch off the index is never read. The
job-by-job table, with every hook a later package replaces, is
`docs/au-gp/scheduled-jobs.md`. WP-04 adds no column, table or migration.

```js
const au = await auSweepPathwayIndex('my-job');          // once, at the top of the run
for (const row of rows) {
  if (au.excludesUser(row.user_id)) continue;            // or au.excludesCase(caseRow)
  // today's code, unchanged
}
auSweepLog(au);                                          // one log line if anyone was left out
```

Rules:

- **Reads of its own.** The index's reads (the pathway column, and since WP-05 the branch-started marker) are the only queries added. Never add
  `candidate_pathway` or `pathway` to a job's existing `select=` or filter:
  filter in memory against the index.
- **Any Australian pathway, confirmed or not.** A self-declared `au_non_vr`
  doctor is left out just like a staff-confirmed `au_vr` one. NULL and the two
  overseas values are overseas doctors.
- **Four jobs ask per doctor instead (WP-14).** The SPPA-00 practice chase,
  the SPPA backfill scan, the Section G sweep and the "documents complete"
  notifier ask `auSupervisedSweepVerdict` (section 26): a supervised segment B
  doctor legitimately has those tasks and is included; A and C are still left
  out; not known is held. Every other job keeps `excludesUser` / `excludesCase`.
- **A doctor parked at `myintealth` is still Australian.** The index is built
  from the profile, not the case, so a doctor whose pathway is set but whose
  case has not moved onto the Australian ladder is caught. `excludesCase` also
  catches a case row that says Australian by itself.
- **Unknown fails closed, but a missing column is not unknown.** Column
  missing: nobody is Australian, the job runs normally. Any other read
  failure: every doctor is held for that run and the job tries again next
  time. Only do this for jobs that send or write; a staff **view** (the
  stuck-case buckets) uses `isAuUser` and merely flags the outage.
- **Event-driven code** (no job run) asks `auOverseasActionBlock(userId)`, or
  branches on the `auStage.mode !== 'overseas'` value already computed at the
  top of `processRegistrationTaskAutomation` (`auNoOverseasStageMsgs`).
- **Leave no trace when you exclude.** An excluded doctor gets no reminder
  row, no "checked" stamp and no score, so the package that later gives them
  real behaviour starts from a clean slate. (The cost: a job that reads a
  capped, ordered batch before filtering can be crowded by excluded rows. The
  two places this could matter are noted in `scheduled-jobs.md`.)
- **Ageing an Australian case** uses `auSweeps.auCaseAgeAnchor`, never
  `last_gp_activity_at` (ADM-04).

Tests: `tests/au-wp04-sweeps-lib.test.js` (the rules),
`tests/au-wp04-sweeps-server.test.js` (every job against 21 Australian
doctors, plus overseas parity with the switch on and off), and the WP-04 case
in `tests/au-wp02-switch-off-no-new-queries.test.js` (switch off: no job makes
the pathway read). A new job needs a line in the `JOBS` table of the second
file.

## 16. Australian onboarding (WP-05)

**In one paragraph.** With the switch on, the onboarding wizard first asks "Are
you already registered with Ahpra and working in Australia?". "No" is today's
wizard, untouched. "Yes" is a short branch of its own screens, then the
wizard's existing identity step, then Careers. The server checks every answer,
works out the pathway itself, and stores it as the doctor's own unconfirmed
answer for staff to confirm. With the switch off there is no first question and
nothing below is reached.

### The screens (in order)

| # | Screen | Asks |
| --- | --- | --- |
| 0 | First question (`#auFirstQuestion`) | Yes / No |
| 1 | `where` | Preferred locations (multi-select: 13 cities, 7 "Regional <state>", "Anywhere in Australia"), sessions a week (optional) |
| 2 | `when` | Available from (no minimum), notice period, state (required), suburb and postcode (optional), current practice (optional, "We never contact your current practice"), how they heard of us (optional) |
| 3 | `registration` | Ahpra number (`MED` + 10 digits, text keyboard, letters kept), registration type, fellowship, a required tick box confirming the details |
| 4 | `details` | Conditions / undertakings / notations (yes / no + optional detail), 19AB (yes / no / not sure), right to work (+ subclass and valid-until when temporary) |
| 5 | `review` | The answers |
| 6 | identity | The wizard's own step 4, unchanged |

The Australian slides are extra `.slide` elements placed **after** the five
existing ones (and `hidden` until the branch is entered). The wizard's step
number is a slide's position in the DOM, so the existing steps 0 to 4 have not
moved. Do not put a slide before them.

### Client

| Thing | Where | Contract |
| --- | --- | --- |
| `GPOnboardingAu` | `js/onboarding-au.js?v=20261121a` | Pure, no page code, loadable with `require` in tests. `STEPS`, the answer lists, `defaultAnswers()`, `normaliseAhpraNumber`, `validateAhpraNumber`, `validateStep(stepKey, answers)`, `firstIncompleteStep(answers)`, `reviewRows(answers)`. Mirrors `lib/au-onboarding.js`; `tests/au-wp05-onboarding-lib.test.js` keeps them in step. **Change both together**, and bump the `?v=` (onboarding page, `sw.js`). |
| The branch itself | `js/onboarding.js`, between `AU BRANCH: START` and `AU BRANCH: END` | Does its own navigation while `auActive`; `nextBtn` / `backBtn` hand over to `auNext()` / `auBack()`. Learns the switch from `GPAuPathway.init()` (`auSwitchPromise`); a failure or no answer in four seconds means "off". |
| Markers | `AU-BRANCH:START` / `AU-BRANCH:END` (HTML), `AU-BRANCH-CSS:START` / `END` (styles) | Everything between them, and all of `js/onboarding-au.js`, is scanned for the AGENT-RULES section 4 words (`tests/au-wp05-onboarding-copy.test.js`), **comments and identifiers included**. That is why the browser says `temporary` / `permitSubclass` / `permitExpiry`: the server maps them to `work_rights = 'visa'`, `visa_subclass`, `visa_expiry`. |
| Where the answers live | `state.auBranch = 'yes'`, `state.au = {...}` on the wizard blob (`gp_onboarding`) | Only added once the doctor says "yes", and removed if they change to "no", so an overseas doctor's blob is the shape it always was. A "no" is remembered on that device only (`localStorage gp_onboarding_au_question`). |
| Who is asked | `auTakeOver(params)` | Not asked: docs-only mode, a `?reupload=` or `?step=` link, a doctor already part-way through today's wizard, a device that answered "no". `?au=1` (the waitlist invite) always asks. |
| Sign-in | `pages/signin.html`, last script | Swaps three lines for neutral copy when `GPAuPathway.enabled()`. The markup's default text is unchanged. |

### Server

| Helper (`server.js` unless noted) | Contract |
| --- | --- |
| `auOnboarding.isAuOnboardingPayload(body)` (`lib/au-onboarding.js`) | `body.auBranch === 'yes'`. |
| `auOnboarding.validateAuOnboarding(body, { now? }) → { ok, errors, answers, credentialsPatch, preferencesPatch, register, preferredCity, derivation }` | Checks every answer against the lists; builds the patches for the WP-02 writers. Never reads a pathway from the browser. |
| `candidatePathway.derivePathwayFromOnboarding(answers)` (`lib/candidate-pathway.js`) | The rule, in one place. See below. |
| `completeAuOnboarding({ session, email, body }) → { status, payload }` | What `POST /api/onboarding/complete` runs for an Australian payload with the switch on. Order: pathway **first** (nothing else is written if it fails), credentials, preferences, profile, state, then a case on the Australian ladder, then the hook. Reply adds `auPathway` (`publicPathwayView`), `auNext: 'careers' \| 'team_review'`, `auCaseStage`. Sends no email. |
| `onAuOnboardingCompleted(userId, pathwayResult, { derivation }) → { handled, needsStaffReview }` | **WP-06 hook.** Called after every completed Australian onboarding with the freshly resolved pathway (`needsStaffReview`, `launched`, `confirmed` are on it). Today it only logs. WP-06: open the staff "confirm on the Ahpra register" task here and flag B / C doctors; return `handled: true`. |
| `auOnboarding.reconcileAuBranchMarker(state, blob)` | Keeps `state.gp_au_branch_started_at` in step with a saved blob. Called by `/api/onboarding/save` (switch on). |
| `releaseEligibilityWaitlistForAu({ userId?, email? }, { sendInvite? }) → { ok, reason?, userId, wasWaitlisted, released, waitlist, invite }` | Clears `user_state.gp_eligibility_waitlist`. Sets no pathway, does not complete onboarding, leaves the `candidate_leads` row. Idempotent. Refuses a doctor who already finished onboarding. |
| `sendAuWaitlistInviteEmail(userId)`, `auOnboarding.buildAuWaitlistInviteEmail({ appBaseUrl })` | The invite, through `sendGpNotificationEmail` → `sendEmail` (preview send lock and local outbox apply). Link: `/pages/onboarding?au=1`. |
| `POST /api/admin/eligibility-waitlist/release` `{ user_id? \| email?, send_invite? }` | CEO / super admin and consultants. RSO: 403 (a waitlisted doctor has no case to be assigned). Switch off: 404. Audited as `admin_release_eligibility_waitlist`. → `{ ok, user_id, was_waitlisted, released, invite: { sent, reason } \| null }`. **WP-06's "Eligibility waitlist" tab calls this.** |

### The pathway rule (`derivePathwayFromOnboarding`)

Regulatory detail is not confirmed; correct it in that function and nowhere
else. Checked in this order:

| Answers | Pathway |
| --- | --- |
| Limited or provisional registration, **or** a condition / undertaking / notation, **or** a temporary right to work, **or** the doctor says 19AB applies | `au_restricted` (B) |
| Anything missing or unclear: registration type "not sure" or non-practising, no fellowship answer, conditions or right to work not answered, 19AB not answered | `au_restricted` (B) |
| GP registrar (in training) | `au_registrar` (C) |
| Specialist (GP) registration + FRACGP / FACRRM / both + no conditions + citizen or permanent resident | `au_vr` (A) |
| Everything else (no fellowship, another fellowship, general registration only) | `au_non_vr` (C) |

19AB "not sure" does not change the segment, and the doctor's own 19AB "no"
unlocks nothing: `computeDpaRestricted` keeps every self-declared doctor limited
to DPA roles until staff confirm.

### What is stored where

| What | Where |
| --- | --- |
| Pathway (self-declared) | `user_profiles.candidate_pathway`, `candidate_basis = 'australia'`, `pathway_set_by = 'self'`, `pathway_confirmed_at = NULL`; mirrored on the case |
| Country, explicitly (APP-18) | `user_profiles.registration_country = 'Australia'`, `qualification_country = 'AU'`, `user_state.gp_selected_country = 'Australia'` |
| Register number | `user_profiles.register_body = 'ahpra'`, `register_number`, `register_status = 'pending_verification'` (never downgraded once settled) **and** `gp_credentials.ahpra_number` |
| Registration, fellowship, conditions, 19AB, right to work | `gp_credentials` (`ahpra_registration_type`, `specialist_gp`, `has_conditions`, `conditions_text`, `fellowship_type`, `fellowship_detail`, `vr_status`, `moratorium_19ab_status`, `work_rights`, `visa_subclass`, `visa_expiry`, `self_declared_at`). `has_undertakings` / `has_notations` are left for the staff check: the doctor is asked one combined question. |
| Where they live, notice, availability, sessions | `user_profiles.current_suburb / current_state / current_postcode / notice_period_weeks / available_from / sessions_wanted` |
| Where they want to work | First **city** chosen → `user_profiles.preferred_city` (ranks roles by exact city match). The full list → `user_state.gp_onboarding.au.locations`. |
| Current practice | `user_state.gp_onboarding.au.currentPractice` only |
| Complete | `user_profiles.onboarding_completed_at`, `user_state.gp_onboarding_complete = true` |
| Case | `registration_cases.stage = 'placement'`, `pathway` |

`gp_onboarding` is a key a browser can rewrite (it is in `USER_STATE_KEYS`, and
`js/state-sync.js` re-sends it as a JSON **string**), so the two values that
live only there (the full location list, the current practice) are not
authoritative. **WP-08:** the full location list is now also stored, from the
validated answers, in the server-owned column `user_profiles.preferred_locations`
(`auWritePreferredLocations`, called by `completeAuOnboarding`). Read that
(`auReadPreferredLocations`), never the blob. The current practice still lives
only in the blob. A package that needs them for matching or conflict checks should
add a server-owned column and write it from `completeAuOnboarding`.
WP-05 added no column, table or migration.

### The "started the Australian branch" marker (COM-07)

`user_state.state.gp_au_branch_started_at` (an ISO time; constant
`auOnboarding.AU_BRANCH_MARKER_KEY`). Server-owned: it is **not** in
`USER_STATE_KEYS`, so a browser can neither read nor write it. It is not a
pathway and nothing but the sweep index reads it.

- Set by `/api/onboarding/save` when the saved blob says `auBranch: 'yes'` and
  is not complete; removed when the blob stops saying so, and by both branches
  of `/api/onboarding/complete`.
- `auSweepPathwayIndex` reads the doctors who have it and treats them like a
  doctor on an Australian pathway, so every job that uses `excludesUser` leaves
  them alone. The single-doctor forms (`auOverseasActionBlock`,
  `auStaffActionBlock`, `resolveCandidatePathway`) do **not** look at it: a
  part-way doctor has no pathway and is not Australian to them.
- WP-17: when the onboarding reminders get Australian copy, branch on
  "has the marker" (Australian reminder) instead of excluding. **Done in
  WP-17** (section 29): the hourly job sends these doctors N05.

### Hooks for later packages

- **WP-06.** `onAuOnboardingCompleted` (staff task, B / C flag). The waitlist
  tab calls `POST /api/admin/eligibility-waitlist/release`. Doctors who finished
  before the hook was filled are found by `pathway_set_by = 'self'` and
  `pathway_confirmed_at IS NULL`. The staff check should also record training
  country if it matters (the branch does not ask it) and
  `has_undertakings` / `has_notations`.
- **WP-08.** The careers DPA gate. Because the branch writes the country as
  Australia, and `_resolveGpJobsProfile().australiaTrained` is today's "may see
  roles outside a DPA", WP-05 added an interim guard inside that function: for
  a doctor on an Australian pathway (switch on, and only when the country
  already says Australia) `australiaTrained` is `!dpaRestricted` from
  `resolveCandidatePathway`. An overseas doctor, and every doctor with the
  switch off, is answered exactly as before with no extra query. When you
  rewire the four call sites to `!p.dpaRestricted` you can delete that guard.
  A doctor in an unlaunched segment
  (`auPathway.launched === false` on the session) is shown the "our team will
  confirm your details" screen by the wizard, but nothing yet stops them opening
  the rest of the app by typing an address.
  **Done by WP-08** (section 19): the guard is removed, and a doctor in an
  unlaunched segment is held on Careers (no roles, an honest message) and
  refused by the apply endpoint. Other pages are still reachable by address:
  WP-12.
- **WP-12.** An Australian doctor landing on Careers still gets the existing
  welcome slideshow and the overseas home page.
- **WP-17.** Reminder copy and step labels (`lib/onboarding-nudge.js`); the
  "profile complete" email (none is sent on this branch today); the invite
  wording in `buildAuWaitlistInviteEmail`. **Done in WP-17** (section 29):
  N05 has its own words and step labels in `lib/au-messages.js` (the overseas
  file is untouched), `completeAuOnboarding` now sends N08, and the invite
  wording was reviewed and left as it is.
- **WP-22.** A job id carried from "Apply now" through sign-up: on success the
  branch goes to `/pages/career` (`#auSuccessContinueBtn`); change that one
  target to the carried job.
- **Legal review.** The consent lines on the `registration` and `details`
  screens are the DRAFT wording from `legal-draft/consent-wording.md` B2 / B3.

## 17. Staff tools (WP-06)

**In one paragraph.** With the switch on, the CEO and consultants can add a
candidate who has no account yet, find doctors parked on the eligibility
waitlist, see and filter every candidate by pathway, and record what the public
Ahpra register shows for an Australian doctor. Saving that check is what
confirms the pathway, closes the check task and tells the doctor. An Australian
case belongs to the placing consultant until placement and has no RSO before
pre-start. With the switch off none of the routes exist and the dashboard is
what it was.

### Routes

All four ATS routes: CEO / super admin and consultants (`requireAtsSession`).
An RSO has no ATS session. Switch off: 404, nothing read.

| Route | What it does |
| --- | --- |
| `POST /api/ats/candidate` `{ first_name, last_name, email, phone?, pathway, ahpra_number?, state?, notes?, consultant? }` | Creates the sign-in account (no password), the profile, the pathway, the case and the invite in one call. 201 `{ user_id, case_id, pathway, pathway_confirmed: false, case_stage, placing_consultant, ahpra_check_task_id, invite: { sent, expires_at } }`. An email that already has an account: 409 `{ code: 'candidate_exists', user_id, case_id }`, never a second account. A staff email is refused. If anything after the account fails, the account is deleted again. Audited as `admin_create_candidate`. |
| `POST /api/ats/candidate/invite` `{ user_id }` | Sends the set-password invite again. Audited as `admin_resend_candidate_invite`. |
| `GET /api/ats/candidate/options` | What the form offers: pathways, states, consultants, `me`. |
| `GET /api/ats/candidate/tasks?case_id=` (or `user_id=`) | **Read-only** task list for a case whose doctor is on an Australian pathway: `id, task_type, title, status, priority, due_date, stage, stage_label, open, created_at, completed_at, completed_by`. No description, attachment, email text or document. An overseas doctor, or a pathway that cannot be read: 403. |
| `POST /api/ats/candidate/register-verification`, action **`ahpra_check`** | The Ahpra register check (below). With the switch on the old one-click `verified` / `mismatch` actions answer 409 `use_ahpra_check` for a doctor on an Australian pathway; an overseas doctor's are unchanged. |
| `GET /api/admin/eligibility-waitlist` | Doctors still parked on the eligibility waitlist: `{ items: [{ user_id, name, email, country, waitlisted_at }] }`. CEO and consultants; RSO 403. Released with WP-05's `POST /api/admin/eligibility-waitlist/release`. |

`GET /api/ceo/candidates` gains, switch on only: `au_pathway_enabled: true`,
`pathway_filters`, one `au` object per row (`pathway, label, is_au, recorded,
confirmed, needs_review, set_by_staff, stage_label`) and the `?pathway=` filter
(`overseas`, the four Australian values, `needs_review`). A doctor on an
Australian pathway, and any candidate staff added, stays in the list before
onboarding is finished. `GET /api/ceo/candidate` gains a `candidate.au` block
(`buildAuCandidateStaffBlock`). **This is how the Candidates tab learns the
switch**: it makes no request of its own until one of those keys says so.

### The invite

The existing mechanism, nothing new: a row in `password_setup_tokens` and the
`GET /api/auth/welcome-setup?token=` bridge, which swaps the token for a fresh
Supabase recovery link and lands on the app's "set new password" screen. The
link works for 72 hours (`auStaffTools.INVITE_LINK_HOURS`). The email goes
through `sendGpNotificationEmail` → `sendEmail`. Copy:
`auStaffTools.buildCandidateInviteEmail`.

### The Ahpra register check

`recordAhpraRegisterCheck({ userId, body, actor })`. Body: `outcome`
(`verified` / `not_matched` / `pending`), `ahpra_number?`, `registration_type`,
`specialist_gp`, `has_conditions` / `conditions_text`, `has_undertakings` /
`undertakings_text`, `has_notations` / `notations_text`, `registration_expiry`,
`fellowship_type?`, `work_rights?`, `moratorium_19ab_confirmed?` (`yes` / `no`),
`note?`. Validated by `auStaffTools.validateAhpraCheckInput` before anything is
written. Staff check the public register by hand
(`auStaffTools.AHPRA_PUBLIC_REGISTER_URL`, a plain link). Nothing in the build
requests that site.

| Outcome | What is written |
| --- | --- |
| `verified` | `gp_credentials` through `upsertGpCredentials(..., { source: 'staff', actor, markVerified: true })` with `ahpra_last_checked_at / _by`; the profile's `register_*` columns read `verified`; the pathway is derived by `candidatePathway.derivePathwayFromRegisterCheck` and stored **staff-confirmed**; the check task closes. Segment A with nothing flagged: N06 "verified". A condition, undertaking or notation, or segment B / C: a `segment_review` task (N07) and the doctor is told nothing. |
| `not_matched` | The profile reads `mismatch`; the last-checked stamp is kept; any earlier verification stamp, pathway confirmation and 19AB confirmation are withdrawn (fail closed); the check task closes; N06 "we could not match that number". |
| `pending` | What was found so far is saved. Nothing else changes and the task stays open. |

**One pathway rule.** `derivePathwayFromRegisterCheck({ credentials,
currentPathway })` turns the credentials row (the doctor's own answers with the
staff findings written over the top) back into the answers
`derivePathwayFromOnboarding` takes and asks that function. Correct the rule
there and nowhere else. A re-check derives the pathway again; if a person had
decided differently they set it again with the pathway control.

**Staff pathway wins at onboarding.** When a doctor finishes the Australian
onboarding branch and staff had already recorded an Australian pathway for
them, that pathway is kept; if the doctor's own answers point to a different
one, a `segment_review` task is raised. Facts staff verified on the register
are not overwritten by the doctor's answers.

### Tasks

| Type | Raised by | Closed by |
| --- | --- | --- |
| `ahpra_register_check` | `auRaiseAhpraCheckTask(userId, { reason, actor })`: an Australian doctor finishes onboarding (`onAuOnboardingCompleted`), staff add an Australian candidate, staff set an Australian pathway by hand, the Ahpra number changes, the yearly re-check. **One open task per doctor** (a read first; partial unique index `uniq_open_ahpra_register_check_task` behind it). Due in 2 days; a re-check in 14. | Saving the check as `verified` or `not_matched`. |
| `segment_review` (N07) | `auRaiseSegmentReviewTask`. One open task per case. | Staff setting a confirmed pathway with `POST /api/admin/candidate/pathway` (`auAfterStaffPathwayChange`). |

The task-type CHECK **already allows** the types later packages need, so WP-11
and WP-13 need no further constraint change: `dpa_19ab_check`,
`reference_check`, `restraint_check`, `start_date_tracking`,
`provider_number_new_location`, `credentialing_pack`, `invoice_due`,
`indemnity_certificate`, `guarantee_checkin`. No behaviour is built for them.

### What the doctor is told (N06)

`auNotifyAhpraCheckResult(userId, 'verified' | 'not_matched', { number })`:
one email and one bell item, each at most once through the existing once-ever
ledger `gp_nudge_log` (keys `au_n06_ahpra_verified`, and
`au_n06_ahpra_not_matched:<number>` so a corrected number that still does not
match is told again). The claim is made before sending; an email that could not
be sent gives its claim back. `auMaybeNotifyAhpraVerified(userId)` sends the
"verified" message only when the doctor is fully cleared (number verified,
launched pathway, staff-confirmed, nothing flagged), so it is also called after
a person sets a pathway or confirms 19AB. **WP-17 restyles the copy** in
`auStaffTools.buildAhpraVerifiedMessage` / `buildAhpraNotMatchedMessage`.

### Ownership (ADM-09, owner decision 6)

- `registration_cases.placing_consultant` (text, an email; NULL = nobody). Read
  with `auReadPlacingConsultant(caseId)`, written by
  `auApplyCaseOwnership(userId, { consultant, actor })`.
- Staff create: the creating staff member, or the consultant chosen in the form.
  Staff setting an Australian pathway by hand: that staff member, if nobody is
  recorded and they are a consultant or the CEO.
- Self sign-up: **nobody is recorded** (there is no "default consultant" in the
  code). The case is visible to every consultant and the CEO.
- **No RSO before pre-start.** A new Australian case is created without
  `assigned_va` / `assigned_rso`; an account made before the pathway was known
  has the launch default RSO removed while the case is still at `placement`. An
  RSO a person assigned on purpose is left alone. Overseas cases keep the
  default RSO exactly as before.
- **`assignRsoForPrestart(caseId, { actor?, rsoUserId? })`: the WP-11 hook.**
  Nothing calls it yet. It fills an empty assignment with `rsoUserId` or the
  launch default RSO and does not run the reassign side effects (DoubleTick
  owner, Gmail labels, RSO welcome).

### Scheduled

- `register-auto-verify` never attempts an Ahpra row (switch on), pathway or no
  pathway: `attemptAutomaticRegisterVerification` returns `manual_only` with
  `staffCheckOnly: true` and stamps nothing.
- `runAuAhpraRecheckSweep({ now?, limit? })`: the yearly re-check, called from
  the daily `sla-sweep` job. `auStaffTools.ahpraRecheckDue(credentials, now)` is
  the rule (last checked more than 12 months ago, or expiry within 60 days).
  WP-13's lifecycle job may call it instead.

### Carry-over fixes

- **F1**: section 2, third exception.
- **F2**: `auGatePageKey(pathname)` normalises a path the way the static handler
  finds the file. The Australian page gate uses it; the overseas stage gate
  still keys on the raw path (unchanged, and it has the same hole).
- **F3**: `PUT /api/admin/case` re-reads the row after an Australian stage move.

Tests: `tests/au-wp06-staff-tools-lib.test.js`,
`tests/au-wp06-staff-tools-server.test.js`, `tests/au-wp06-candidates-ui.test.js`.
The database stub can emulate the Auth admin calls with `emulator: { auth: true }`
(`emu.authUsers`, `emu.authRequests`, `emu.authFail`).

## 18. Documents (WP-07)

**In one paragraph.** A doctor on an Australian pathway has their own document
set. It is decided by the pathway, never by a country field. The files are
stored in the same table as everyone else's, under a code of their own, and
checked by rules of their own. An overseas doctor, and every doctor with the
switch off, gets exactly what they got before, including the old habit of
treating an unreadable country as the UK, which now lives in one named place.
WP-07 adds no column, table or migration.

### `user_documents.country_code`: every meaning (DAT-21, APP-24)

The column is part of the table's unique key (`user_id, document_key,
country_code`). Two features using one code for different things would
overwrite each other.

| Code | What is filed under it |
| --- | --- |
| `uk` / `ie` / `nz` | Overseas registration documents: "You prepare" uploads, onboarding qualification scans (`onboarding_*`), institution rows, AHPRA s80 uploads. Lower case. |
| `AU` | Careers-profile documents **for every doctor**: `career_cv`, `career_cover_letter`, legacy `cv_signed_dated`. It does not mean "an Australian doctor". |
| `zz` | The onboarding identity document (`identity`). |
| `GB` / `IE` / `NZ` | Legacy upper-case rows from before 2026-07. Still read, never written by new code. |
| empty / NULL | Rows delivered by staff with no country (`offer_contract`, alternate supervisor CV placeholders). |
| **`au_reg`** | **New.** An Australian GP's registration and pre-start documents. Every key under it starts `au_`. |

`au_reg` differs from `AU` in every casing, is not a value
`normalizeDocumentCountry` produces, and its keys are used nowhere else.
`tests/au-wp07-documents-lib.test.js` pins all three.

### `lib/document-country.js`: the one resolver (DAT-07, ADM-08, APP-23)

| Helper | Contract |
| --- | --- |
| `resolveDocumentCountry(profile, pathwayResult, { strict? }) -> { code, set, supported, isAu, legacyFallback, upper }` | **Ask this, never write `\|\| 'uk'`.** `profile` is a country string, a list in precedence order, `{ candidates }` or a row. Australian pathway (the result already honours the switch): `au_reg`. Otherwise today's answer: `uk` / `ie` / `nz`, and for an unknown country the legacy `uk` with `supported: false, legacyFallback: true`. `strict: true` gives `code: ''`, `set: null` for unknown: **new code must pass it.** |
| `legacyOverseasCode(...candidates)`, `legacyOverseasUpper(...)` | Shorthand for overseas-only call sites (`'uk'` / `'GB'` forms). |
| `LEGACY_OVERSEAS_FALLBACK` | `'uk'`. The single home of the default. Changing overseas behaviour to "unknown shows nothing" is this one constant plus the page constant below; it is an owner decision because it changes what an existing overseas doctor with a blank country sees. |
| `AU_DOCUMENT_COUNTRY`, `CAREERS_DOCUMENT_COUNTRY`, `IDENTITY_DOCUMENT_COUNTRY`, `COUNTRY_CODE_SCHEME`, `isAuDocumentCountry(code)`, `upperCountryCode(code)`, `normalizeOverseasCountry(v)` | Constants and small tests. A country field can never produce `au_reg`. |

In `server.js`: `resolveGpDocumentCountryForUser(userId)` answers `au_reg` for a
doctor on an Australian pathway; `auDocumentContextForUser(userId)` returns the
pathway result for such a doctor and `null` otherwise (switch off: nothing
queried). Use the second to branch.

### The Australian set (`lib/document-requirements.js`)

`auDocumentRequirements(pathwayResult, { phase }) -> { set, pathway, phase,
items, youProvide, weProvide, requiredKeys }`. `phase` is `'apply'`,
`'prestart'` or left out for everything. Anything that is not an Australian
pathway gets an **empty** set. Each item: `key, label, staffLabel, short, help,
provider ('you' | 'we'), phase, required, expiryTracked, expiryLabel, storage,
aiReview, staffSlot, stage`.

| Item | Key | Phase | Required | Who | Expiry |
| --- | --- | --- | --- | --- | --- |
| CV | `career_cv` (the careers CV, stored under `AU`; never asked for twice) | apply | all | you | no |
| Ahpra registration certificate or register extract | `au_ahpra_certificate` | prestart | all | you | yes |
| Fellowship certificate (FRACGP / FACRRM) | `au_fellowship_certificate` | prestart | A only (offered to B, not shown to C) | you | no |
| Indemnity certificate of currency | `au_indemnity_certificate` | prestart | all | you | yes |
| Right to work | `au_right_to_work` | prestart | all | you | no |
| Working with Children Check | `au_wwcc` | prestart | all | you | yes |
| Provider and prescriber numbers (letter or screenshot) | `au_provider_number_letter` | prestart | optional | you | no |
| Immunisation record | `au_immunisation_record` | prestart | optional | you | no |
| Supervision plan and reports (B only) | `au_supervision_plan` | prestart | B | you | no |
| Immigration grant notice (B only; staff label "Visa grant notice") | `au_immigration_grant_notice` | prestart | B | you | yes |
| Section 19AB exemption letter (B only) | `au_19ab_exemption_letter` | prestart | optional | you | yes |
| Offer and contract | `offer_contract` (the existing delivered document) | prestart | no | we | no |
| Reference checks (two referees) | `au_references` | prestart | all | we | no |

Decisions: **nothing new blocks applying** (the only `apply` item is the CV the
Careers page already asks for); everything else is asked for at pre-start and
may be uploaded earlier. **Referees are details, not uploads**: the doctor gives
two names (WP-12 collects them), staff file the completed checks in the
`au_references` slot. Which items are required is decided in `AU_DOCUMENT_ITEMS`
and nowhere else (regulatory detail unconfirmed). `label`, `short` and `help`
are what a doctor reads and are scanned for the AGENT-RULES section 4 words;
`staffLabel` is for the dashboards only and must never be sent to a doctor.

Other helpers: `AU_REG_DOCUMENT_KEYS`, `AU_UPLOADABLE_DOCUMENT_KEYS`,
`AU_EXPIRY_TRACKED_KEYS`, `isAuRegDocumentKey`, `auDocumentItem`,
`auDocumentLabel(key, { staff? })`, `auDocumentStage(key)` (`placement` or
`prestart`: the stage a review task is filed under, never `ahpra`).

### Routes

All exist only with the switch on. Doctor routes answer 404 for a doctor who is
not on an Australian pathway.

| Route | What it does |
| --- | --- |
| `GET /api/gp/au-documents` | `{ ok, set, youProvide, weProvide, accept }`: the set with the state of each item (`status`: `pending`, `uploaded`, `under_review`, `approved`, `rejected`; `fileName`, `updatedAt`, `expiresAt`, `note`, `canUpload`, `downloadUrl`, `manageUrl`). |
| `PUT /api/gp/au-documents` `{ key, fileName, mimeType, fileSize, fileDataUrl, expiresAt? }` | Upload or replace. Stored at `users/<id>/prepared-documents/au_reg/<key>/current` through the existing row writer; clears any previous verdict; opens one `doc_review` task under the Australian stage. |
| `POST /api/gp/au-documents/expiry` `{ key, expiresAt }` | For expiry-tracked items. |
| `GET /api/gp/au-documents/download?key=` | The doctor's own file. |
| `GET /api/gp/document-requirements` | For a doctor on an Australian pathway: `{ au: true, country: 'au_reg', requirements: { institution: [], prepared: [...] } }`, whatever `?country=` says. Everyone else: unchanged. |
| `PUT /api/prepared-documents` | Refuses a doctor on an Australian pathway (409 `au_pathway`): that route runs the overseas review. |
| `GET /api/ats/candidate-au-doc?case_id=&key=` | CEO and consultants: the file's bytes for the dashboard's own viewer. Audited (`ats_au_document_viewed`). |
| `POST /api/ats/candidate/document` with `slot: 'au:<key>'` | Staff file a document for the doctor: stored approved, attributed in `review_notes`, `ai_review_state = 'staff_filed'`. Only into the doctor's own set. |
| `POST /api/admin/candidate-doc/sign-upload`, `/finalize` | Accept an `au_*` key for a doctor whose documents are the Australian set, and an overseas key only for one whose are not. |
| `GET /api/admin/gp-documents` | For an Australian doctor: `au: true`, `documentSet: 'au_reg'`, `directToAhpra: []`, the Australian cards under `preparedByCandidate`, only `offer_contract` under `preparedByGpLink`. Does not create practice-pack rows. |

`GET /api/ceo/candidate` gains `candidate.au.doc_slots` (`key, slot, label,
required, has, status, file_name, expires_at`). `getUserQualificationSnapshot`
answers `{ country: 'AU', document_set: 'au_reg', ... }` for an Australian
doctor.

### The page

`pages/my-documents-au.html` + `js/my-documents-au.js?v=20261121a`
(`GPMyDocumentsAu.mount(el)`). The server sends that file **at the ordinary
`/pages/my-documents` address** to a doctor on an Australian pathway, with
`Cache-Control: private, no-store` so the service worker never keeps it. The
standard page (`pages/my-documents.html`) asks `GPAuPathway`; a clear "this
doctor is on an Australian pathway" makes it hide itself and ask the server
again at an address its saved copy does not answer to. Anything else leaves it
exactly as it was. Both files are scanned whole for the section 4 words.
`LEGACY_OVERSEAS_DOC_COUNTRY = "uk"` in the standard page is the browser's twin
of `LEGACY_OVERSEAS_FALLBACK`.

### Automatic review (COM-17)

`lib/au-document-review.js`: `AU_REVIEW_RULES`, `reviewRulesFor(row,
isQualificationKey) -> 'au' | 'overseas' | 'none'` (the one routing rule),
`buildAuReviewPrompt`, `interpretAuReview`. A row under `au_reg` with an
Australian key is judged by these rules and only these; every other row by the
existing rules, unchanged; an Australian key under another code, or an overseas
key under `au_reg`, by neither. The verdict policy is still
`lib/doc-ai-review.js`. The server checks for itself: the name (the existing
matcher, untouched), that cover or registration is still current, that the
Ahpra number matches `gp_credentials`, that a Working with Children "check" is
not just an application receipt. The model's own description of a file is never
repeated to the doctor. A model outage rejects nothing. Test hook:
`__testUtils.__setAuDocumentVerifierForTest(fn)`.

### Drive (DAT-26)

`lib/drive-doc-folders.js` maps every `au_*` key to a folder. No link-public
copy is made for an Australian document: the approval path does not call
`uploadDocumentToDrive` (which shares with anyone who has the link; that
behaviour is unchanged for overseas documents pending the owner's decision).
The existing `reconcileGpDrive` mirror, which uploads with team-only sharing,
picks up approved Australian documents, and the organise sweep files them.

### Hooks for later packages

- **WP-11 (pre-start requests).** `auDocumentRequirements(p, { phase: 'prestart' })`
  is the list to ask for; `requiredKeys` is what to chase. Still yours: the
  overseas practice pack (SPPA-00 and friends) is still created by the
  placement cascade for an Australian doctor; the Documents pane hides those
  cards for them and shows the files under "Other Files".
- **WP-12 (GP app).** Show pre-start uploads from `GET /api/gp/au-documents`
  (filter `phase === 'prestart'`), or mount `GPMyDocumentsAu`. Collect the two
  referees' details (none are stored yet). The provider-number step can read
  whether `au_provider_number_letter` is on file. The qualification scan modal
  (`js/qualification-scan.js`) still has its own "unknown is GB" default: do not
  render a scan trigger for an Australian doctor. The app shell still shows the
  existing welcome slideshow over My Documents on first visit.
- **WP-14 (segment B).** The three B items exist and are staff-fileable; they
  have no automatic review rule (`aiReview: false`), so they always go to a
  person.
- **WP-17 (messages).** Document emails for Australian types reuse the existing
  templates (approved, re-upload, verified, expiry) with the Australian label.
- **WP-26 (dashboards).** The Documents pane hides the "Direct to AHPRA"
  section when `gpDocs.au` and retitles the candidate section; cards and the
  drawer slots are functional, not polished. `staffSlot: false` items
  (immunisation record) show in the pane but not the drawer.

## 19. Role eligibility, role fields, caps and matching (WP-08)

**In one paragraph.** One function decides whether a doctor may see, identify
and apply for a role: `roleEligibilityFor(pathwayResult, role)` in
`lib/role-eligibility.js`. Every place that used to test "is the doctor's
country Australia?" asks it. An overseas doctor gets exactly the answer they
always got. A doctor on an Australian pathway is judged on 19AB (through
`dpaRestricted`) and on what the role says it accepts. A doctor in a segment
that is not launched is held: shown nothing, refused if they try to apply, and
flagged to staff, who may still put them forward by hand when the role fits.
With the switch off none of the new columns is named and nothing extra is read.

### The rule

`roleEligibilityFor(pathwayResult, role) → { visible, identifiable, canApply, eligible, hold, reasons[], legacyReason }`

| Doctor | Answer |
| --- | --- |
| Overseas (nothing recorded, `overseas_esp`, `overseas_pep`, switch off) | Today's rule on today's boolean: a role with `dpa === true` is open; any other role is open only when `dpaRestricted === false` (the caller passed `legacyDpaExempt`). The role fields are never read. A role they cannot have is `visible` but not `identifiable` (the blurred stub). |
| `au_vr` (A) | Any role, subject to DPA. |
| `au_non_vr` (C) | Only a role with `vr_requirement = 'non_vr_accepted'`, subject to DPA. |
| `au_registrar` (C) | Only a role with `accepts_registrars = true`, subject to DPA. |
| `au_restricted` (B), limited / provisional registration, a supervision level, or no registration type on file | Only a role with `accepts_supervised = true`, subject to DPA. |
| `au_restricted` (B), general or specialist registration | As VR or non-VR per `gp_credentials` (`vr_status = 'vr'`, or specialist GP with FRACGP / FACRRM). |
| **DPA, any Australian pathway** | A doctor with `dpaRestricted !== false` gets only roles **known** to be in a DPA: `dpa_status = 'yes'`, or no status recorded and `dpa = true`. A role whose status is `unknown` is not offered to them (reason `role_dpa_unknown`; staff are told to ask the practice). |
| **Not launched (B, C)** | `hold: true`. `visible`, `identifiable`, `canApply` are all false whatever the role. `eligible` still says whether the role fits: that is what staff act on. |
| `readFailed`, `schemaMissing`, or no result | Restricted: DPA roles only, even when the country reads Australia. Never treated as Australian (no hold, no role fields). |

Reasons: `dpa_restricted`, `role_dpa_unknown`, `vr_required`,
`registrars_not_accepted`, `supervised_not_accepted`, `pathway_on_hold`,
`pathway_unreadable`. `eligibilityMessage(verdict, 'doctor' | 'staff')` turns
the first into a sentence. A role that does not fit an Australian doctor at all
is not listed (`visible: false`); a DPA-only mismatch is listed blurred, as it
always has been.

**The hold is one function:** `shouldHoldSelfService(pathwayResult)`. Launching
segment B or C is one change: add the pathway to `LAUNCHED_AU_PATHWAYS` in
`lib/candidate-pathway.js`. The role rule does not change when that happens (a
non-VR doctor still cannot have a VR-only role).

### Where it is asked (every former country-test site)

| Site | How |
| --- | --- |
| `GET /api/career/roles` (`_applyGpRoleVisibilityGate`) | Verdict per role; a held doctor gets `{ roles: [], auHold: { held, message } }` with `no-store`. |
| `GET /api/career/role` | The blurred stub when `!canApply`; for a held doctor the stub plus `auHold`. |
| `POST /api/career/apply` | 403. Overseas: today's body. Australian: `{ error: 'not_qualified', code: <reason>, message }`. Held: `{ error: 'pathway_on_hold', code: 'au_hold', message }`. |
| `aiCandidateJobMatch.checkMatchEligibility` | Asks the rule through `gp.pathway` (falls back to the old `dpaEligible` boolean when a caller has no pathway). Blocks: `dpa_ineligible` (unchanged string), `role_dpa_unknown`, `vr_required`, `registrars_not_accepted`, `supervised_not_accepted`, `pathway_on_hold`. A job object with `jobAgnostic: true` applies only the hold. |
| `atsBuildGpMatchInputs` (`dpaEligible`) | `!pathway.dpaRestricted`, from a batch pathway read (`auBatchPathwayRecords`). Unreadable: every doctor in the batch is restricted. |
| `redirectOthersForJob` (alternatives after a role is filled) | `roleEligibilityFor(gp.pathway, job).canApply`. |
| `practicePipeline.gpQualifiesForRole` | No server caller is left; it answers through the same rule for anything still holding `{ australiaTrained }`. |
| Staff manual submit: `POST /api/ats/application`, `POST /api/ats/job/candidate` | `auManualSubmitBlock`: 409 `not_eligible_for_role` when the doctor is on an Australian pathway and `eligible` is false. Overseas doctors: as open as before. |

`_resolveGpJobsProfile().australiaTrained` is once more only "the country
reads as Australia". It is handed to the resolver as `legacyDpaExempt`
(`resolveRoleEligibilityContext(userId, email) → { jobsProfile, pathway }`) and
is ignored for an Australian pathway. Do not branch on it.

### Role fields (`career_roles`)

| Column | Values | NULL means |
| --- | --- | --- |
| `vr_requirement` | `vr_required`, `vr_preferred`, `non_vr_accepted` | VR required (owner decision 5) |
| `accepts_registrars` | boolean | no |
| `accepts_supervised` | boolean | no |
| `engagement_type` | `permanent`, `contract` (no locum: owner decision 10) | not stated |
| `sessions_min`, `sessions_max` | numeric(4,1), sessions a week | not stated |
| `special_interests` | text[] | none |
| `dpa_status` | `yes`, `no`, `unknown` | not recorded: an Australian doctor's rule falls back to the boolean |

**Reused, not duplicated:** the billing model is `career_roles.billing_model`
(free text: `mixed`, `Mixed Billing`, `bulk`, ...) with the two legacy
booleans; read it through `normaliseBillingModel(role) → 'bulk' | 'mixed' |
'private' | ''`. MMM is `career_roles.mmm`; metro / regional is
`areaFromRole(role)` (MM1 = metro, else the existing booleans).

**The existing `dpa` boolean is unchanged** and is all the overseas rules
read. The job editor keeps the two in step: setting `dpa_status` sets the
boolean (`yes` → true, anything else → false), and answering the existing DPA
yes / no question records the status. A role created from a practice intake
records `dpa_status` from what the practice actually answered (`unknown` when
they did not say: DAT-13) and `accepts_supervised = true` only when they said
supervision is available. The GP-types question itself is WP-23.

Helpers: `readRoleFields(role)` (defaults applied), `sanitiseRoleFieldsPatch(body)`
(the job editor), `roleFieldsEditorView(role)`, `publicRoleFacts(role)`
(APP-19 data: billing model, VR requirement, sessions, MMM, area, DPA;
`afterHours` and `restraintRadiusKm` are `null` because nothing stores them
yet). Server: `atsJobForEligibility(jobRow)`, and `auAttachRoleFields(rows)` for
job rows read with a fixed column list (its own query, switch on only).

Where the fields show up: `GET / PATCH /api/ats/job` → `editor.au_role_fields`
(switch on only; that key is also how `js/ceo-ats-jobs.js` learns to draw the
"Who this role is open to" section); a doctor on an Australian pathway gets
`auFacts` and `distanceKm` / `withinCommute` on each role of
`/api/career/roles` and `auFacts` on `/api/career/role`. An overseas doctor's
payloads have none of these keys.

### Staff

`GET /api/ats/candidate/role-eligibility?user_id=&career_role_id=` (CEO and
consultants; switch off: 404) → `{ pathway, hold, caps, roles: [{ career_role_id,
title, practice_name, fields, eligible, can_self_apply, hold, reasons: [{ code,
message }] }] }`. Without `career_role_id`: every open role. No dashboard
screen calls it yet (WP-26).

A held doctor opening Careers, a role page or trying to apply raises the WP-06
`segment_review` task if none is open (`auFlagHeldDoctor`; at most one attempt
per doctor every ten minutes per server instance).

### The reviewed stamp

`gp_credentials.flags_reviewed_at` + `flags_reviewed_by` (staff only). Stamped
by `auAfterStaffPathwayChange` when a person sets a **confirmed** Australian
pathway for a doctor who has a condition, undertaking or notation on file (the
action that closes the `segment_review` task). From then on
`needsStaffReview` is false for that doctor (if launched and confirmed), so
N06 "verified" goes, once. Cleared automatically when any flag or its text
changes (`sanitiseCredentialsPatch`, both sources), so a new condition is
looked at again. A re-check that re-derives the pathway does not stamp: only a
person's decision does.

### Caps (`lib/application-caps.js`)

| | Active | A month | Interviews a month | Strike lock |
| --- | --- | --- | --- | --- |
| Overseas (and switch off, and unreadable) | 2 | 3 | 3 | 3 |
| Any Australian pathway (default) | 4 | 6 | 6 | 3 |

`capsForPathway(pathwayResult)`; server: `auCapsForUser(userId)`. The overseas
numbers are constants and cannot be changed by the environment. The Australian
ones can: `AU_APPLICATION_CAPS_JSON`, for example `{"active":5}` (all four
pathways) or `{"au_vr":{"monthly":8}}` (one). A bad value is ignored. The
three-strike lock keeps its mechanism and threshold for Australian doctors (it
counts interviews that went nowhere and late withdrawals, which cost a practice
the same wherever the doctor lives); it is in the config so it can be changed.

### Re-entry after a placement (APP-22)

`roleEligibility.auReentryAllowed({ placements, caseStage })`, server
`auPlacedReentryAllowed(userId)`. Australian pathways only. Allowed once every
placement has started or ended: `commenced_at` or `ended_at` on the
`placements` row (**WP-13 adds those columns**; the row is read with
`select=*`, so they are used the day they exist), or an ended status, or, until
then, the case being at `commenced` / `guarantee` / `complete`. Applied in
`POST /api/career/apply` and in the matching inputs (`placed`). The careers
page itself still locks a placed doctor to the placement view: WP-12.

### Matching (`lib/ai-candidate-job-match.js`)

A doctor on an Australian pathway carries an `au` block on their match input
(`auBuildMatchBlock`): segment, `vr`, `registrar`, `supervised`, a registration
**flag** (never its text), current suburb and state, commute radius, preferred
locations, sessions wanted, availability, notice period, earliest start,
special interests, billing preference, and distances to the jobs in the
request. Its presence selects `AI_MATCH_SYSTEM_PROMPT_AU` and the Australian
prompt shapes; such doctors are ranked in their own calls. The overseas prompt
and shapes are untouched (`tests/au-wp08-matching-intent.test.js` compares
every byte with a snapshot taken before WP-08).

Reasons (owner decision 9): the Australian branch may name the billing model.
`sanitiseAuMatchReasons(reasons)` drops any reason carrying `$`, `%`, "per
cent", a figure like "300k", a split like "70/30", salary / income / earnings
words, a registration flag, or a word from AGENT-RULES section 4. It runs when
the model replies, when reasons are stored on a match, and again where they
are shown to the doctor (`auReasonsForGp`). Overseas reasons keep today's rule
exactly (the word "billing" itself is still banned there). **WP-20** owns the
prompt wording.

Tags: `filterTagsForPathway(tags, pathwayResult)` drops the visa tag for
segments A and C and the DPA tag for segment A.

**Distance (DAT-11).** `rankRolesByDistance`. Home is the doctor's stored
coordinates, else their suburb looked up in `career_suburb_geo_cache` (suburbs
this app has already geocoded for its practices). **No outside geocoding
service is called.** With no coordinates the order is same suburb, then same
state, then the rest.

### Start date (COM-13)

`auEarliestStart({ available_from, notice_period_weeks })`; server
`auStartDateForUser(userId)` (null for anyone not on an Australian pathway) and
`auIntroTargetDate(userId, profileRow, fallback)`. Used by the two placement
payloads and the two practice-facing introductions. Never the arrival date.

### Migration

`20261120130000_au_gp_wp08_role_fields.sql`: eight columns on `career_roles`,
`user_profiles.preferred_locations`, two on `gp_credentials`, four CHECKs on
the new columns. Applied to the local test database only. Each new column is
read or written in its own query or through `select=*`; a database without
them answers as "not stated" (the closed answer) and loses nothing else.

### Hooks for later packages

- **WP-09 (intro chips).** `auIntroTargetDate` already feeds the availability
  date into `careerIntro.buildCandidateIntro`. The intro's own wording
  ("internationally trained", the pathway label) is untouched: yours.
- **WP-12 / WP-22 (job page, filters).** Render from `auFacts`. The
  overseas-framed rows are composed in the page: `pages/job.html` lines 2602
  ("Yes — open to overseas-trained GPs") and 2609 ("Visa: Sponsorship
  available"). Not changed here. The placement payload's "Relocation package"
  quick stat (`server.js`, search `thirdQuickStat`) still goes to an Australian
  doctor. `mapCareerRoleRowToClient`'s `filterTokens` and the "DPA-aligned
  pathway" benefit are unchanged. Careers shows the holding card
  (`#au-hold-state`, between the `AU-HOLD` markers in `pages/career.html`); the
  page's filter bar is still drawn above it.
- **WP-13 (commencement).** Add `commenced_at` / `ended_at` to `placements`;
  re-entry reads them with no further change here.
- **WP-20 (prompts).** `AI_MATCH_SYSTEM_PROMPT_AU`, `_gpForPromptAu`,
  `_jobForPromptAu`.
- **WP-23 (intake).** Store the GP-types answer on the practice / intake and
  set the role fields in `createPendingJobFromIntake` (next to the
  `dpa_status` write).
- **WP-26 (dashboards).** A screen for `/api/ats/candidate/role-eligibility`;
  the matching board shows the new block strings raw.
- **WP-27 (metrics).** The Australian intent numbers (section 15, row 15 of
  `scheduled-jobs.md`) are a first cut.

## 20. Practice-facing introduction, Australian WhatsApp templates and consent (WP-09)

**In one paragraph.** When staff submit a doctor to a practice, the practice
gets an introduction: an email, a WhatsApp, and a decision page. For a doctor
on an Australian pathway all three now come from one Australian builder that
says only what is on file. The WhatsApp goes only through an approved
Australian template, and none is approved yet, so today it is email only. And
an Australian doctor cannot be sent to a practice until they have agreed to it
for that role. An overseas doctor (nothing recorded, or the switch off) gets
exactly what they always got: `tests/au-wp09-overseas-intro-parity.test.js`
compares every byte with a snapshot taken before WP-09.

### The builder (`lib/career-intro.js`)

| Helper | Contract |
| --- | --- |
| `buildCandidateIntro(opts)` | The overseas builder. **Unchanged.** |
| `auIntroFactsFromRecords({ pathwayResult, credentials, profile, now })` | The only place the stored rows are read. Copies out booleans and short codes (never a number, a suburb, an employer or a condition's text). `null` for anything that is not an Australian pathway. |
| `buildAuCandidateIntro({ gpName, facts })` | `{ audience: 'au', paragraph, facts, pathwayLabel, startDateLabel, nextSteps, confidentialityNote }`. Same first four keys as the overseas builder, so the email and page code is shared. |
| `auPracticeTextViolations(text)` | The banned phrases found in a practice-facing string (`AU_PRACTICE_BANNED`: AGENT-RULES section 4, "internationally trained", "Expedited Specialist", "registration process", `$`, `%`). `[]` = clean. Use it in tests. |
| `auSafeRecommendation(text)` | The AI "why we recommend" blurb, or `''` if it carries a banned phrase. |
| `auFellowshipSpecialtyLabel(type)` | `FRACGP — General Practice` etc. for staff screens (`atsSpecialtyFromOnboarding(ob, fellowshipType)`). |

Server: **`auPracticeIntroFor(userId, profileRow, gpName)`** → `null` (not
Australian, or switch off: build the overseas intro), `{ unreadable: true }`
(hold off: never fall back to the overseas wording) or `{ intro, pathway }`.
Called by `POST /api/admin/career/application/submit-to-practice` and
`GET /api/practice/application/decision-context`. Any new place that describes
a candidate to a practice must ask it first.

What is said, and when:

| Fact | Said when | Otherwise |
| --- | --- | --- |
| "vocationally registered GP" | pathway `au_vr` **and** staff confirmed the pathway | self-declared `au_vr`: "has told us they are vocationally registered; we are confirming this". Never for B or C. |
| Fellowship "(FRACGP)", "(FACRRM)", "(FRACGP and FACRRM)" | on `gp_credentials.fellowship_type`, once the pathway is staff-confirmed or the registration staff-verified | left out (`other`, `none`, or not yet confirmed) |
| "GP Link has verified … Ahpra registration on the public register" | `gp_credentials.staff_verified_at` set **and** `user_profiles.register_status = 'verified'` **and** no unreviewed flag | number on file: "on file and verification is in progress". No number, or a mismatch: Ahpra is not mentioned. |
| "so there is no registration wait" (N10) | verified, confirmed `au_vr`, no flag, no supervision | left out |
| "based in <State>" | `user_profiles.current_state` | "based in Australia". Never the suburb, postcode or current practice. |
| Availability | `available_from` (a future date: "available from 15 January 2027") or `notice_period_weeks` ("about 4 weeks' notice") | nothing |
| 19AB chip | every Australian pathway unless staff confirmed it does not apply (`dpaRestricted === false`): "19AB applies: DPA locations only", or "19AB status being confirmed" | no chip |
| Supervision chip | registrar, limited / provisional registration, or a supervision level | no chip |
| "Registration conditions: details on request" | a flag on file that a person has reviewed (section 19, the reviewed stamp) | not reviewed: "Registration details being confirmed". Never the text. |
| The Ahpra number | never (owner decision pending: OWNER-ACTIONS 17B) | |

Australian extras on the wire: the decision-context `candidate` object gains
`audience: 'au'`, `nextSteps` (four lines) and `confidentialityNote`; the
submit response gains `au_introduction: { whatsapp: { sent, reason | template } }`;
the email gains one confidentiality line (html and text). An overseas doctor's
payloads have none of these keys.

### Australian WhatsApp templates (`lib/au-whatsapp-templates.js`)

> **Superseded in part by section 30 (WP-18).** The two practice-introduction
> rows now point at the existing templates (their live wording was read and is
> neutral) and are on. Read section 30 for what "approved" means today.

**The one place that says whether an Australian WhatsApp may be sent.**
`AU_WHATSAPP_TEMPLATES` maps a key to `{ templateName, language, approved }`;
every row starts `approved: false`. `auWhatsAppTemplate(key)` adds anything
listed in env `AU_WHATSAPP_APPROVED_TEMPLATES` (comma-separated keys or
template names). `auPracticeIntroWhatsAppPlan()` answers
`{ send: false, reason: 'au_template_not_approved' }` or `{ send: true,
templateNames: { text, cv } }`, which `buildPracticeSubmissionWaMessage`
takes as `templateNames`. The proposed wording is in
`docs/au-gp/whatsapp-templates.md`. A skipped WhatsApp is logged, written on
the case event and returned to the staff member.

### Consent before a profile goes to a practice (`lib/profile-share-consent.js`)

Australian pathways only, switch on only. The wording is a draft for legal
review (`docs/au-gp/legal-draft/consent-wording.md` section C, without the
registration number; D3 for the line the practice sees).

| Step | What happens |
| --- | --- |
| Role page | `GET /api/career/role` carries `role.auShareConsent` (`doctorConsentSheet`: title, body, tick label, footnote, `version`) when the practice's name is on the payload. `pages/job.html` shows it on the apply sheet; the button is disabled until the box is ticked. |
| Apply / accept | `POST /api/career/apply` and `POST /api/career/match/respond` (accept) need `shareConsent: { agreed: true, version: CONSENT_VERSION }` for an Australian doctor. Without it: 400 `{ code: 'consent_required', message, shareConsent }` and nothing is created. With it: the five `profile_share_consent_*` columns are written in their own request after the row is saved (`auRecordProfileShareConsent`). |
| Staff submit | `auShareConsentGate(applicationRow)`: no consent for **this** role → 409 `{ code: 'profile_share_consent_required', can_record_verbal_consent, verbal_consent_prompt }`, nothing is read, built or sent, and the refusal is audit-logged (`admin_submit_to_practice_refused_no_consent`). |
| Verbal consent | `POST /api/admin/career/application/share-consent { applicationId, note }` (the same staff who may submit; a note of 5+ characters is required). Writes the consent with source `staff_verbal` and the staff email, audit-logs `admin_record_profile_share_consent` (with the note), and adds a case event. Switch off: 404. Overseas doctor: 409. |

`consentOnFile(row)` is the test: a timestamp, a version, a known source, and
`profile_share_consent_role_id` equal to the row's own role. Changing the
wording means changing `CONSENT_VERSION`. Migration not applied: an
Australian doctor's consent cannot be stored, so staff are refused (fail
closed) and the verbal route answers 503 `schema_missing`.

### Hooks for later packages

- **WP-22 (job page).** The sheet is drawn from `role.auShareConsent`; the
  match popup (`js/match-popup.js`) has no tick, so an Australian doctor
  accepting there is told to open the role. `pages/career.html`'s unreachable
  in-list accept sheet is untouched.
- **WP-20 (prompts).** `generateCandidateRecommendation` (the CV blurb sent to
  practices) is unchanged; only `auSafeRecommendation` sits under it.
- **WP-23.** The confidentiality line (D3) is in place for Australian
  introductions only.
- **WP-26.** The staff drawer does not yet show whether a consent is on file;
  staff find out when they submit. The application rows already carry the
  columns (`select=*`).

## 21. Fix bundle FB-1

**In one paragraph.** Fixes for what a tester found walking the app as a new
Australian GP (`walk-findings.md` D9 to D26). Three things later packages will
reuse: the session tells an Australian doctor's browser their own limits and
an "eligibility version"; one small browser file (`js/au-doctor.js`) reads
them and is only ever loaded for an Australian doctor; and a doctor whose
pathway is on record is steered by the server (onboarding branch, Careers
gate, invite). An overseas doctor's screens, requests and stored data are what
they were.

### `auDoctor` on `GET /api/auth/session`

Present only with the switch on and only for a doctor on an Australian pathway
(`resolveAuDoctorSessionBlock`, built by `lib/au-doctor-session.js`):

```js
auDoctor: {
  eligibilityVersion: '6534c5981c507f7b',                 // opaque, 16 hex
  limits: { active: 4, monthly: 6, interviewsMonthly: 6 }, // lib/application-caps.js
  onboardingComplete: true                                 // user_profiles.onboarding_completed_at
}
```

- **`eligibilityVersion`** changes whenever anything that decides which roles
  the doctor may see changes: pathway, launched, the DPA answer, staff
  confirmation, needs-review, role fit, registration flags, the caps. It is an
  HMAC keyed with `AUTH_SECRET` and mixed with the doctor's id, so it reveals
  nothing (the browser still never learns the DPA flag) and two doctors never
  share one. **If you add an input to `roleEligibilityFor` that comes from the
  doctor's own record, add it to `eligibilityVersion` too**, or a browser can
  keep a role list the server has moved on from.
- It costs an Australian doctor's session one extra read (their own
  `gp_credentials` row) and one of `onboarding_completed_at`. An overseas
  doctor's session reads nothing extra and has no such key.
- **Caching.** `/api/career/roles` and `/api/career/role` are `no-store` for a
  doctor on an Australian pathway (their eligibility can be withdrawn at any
  moment). The 60-second private cache, and the deliberate `no-store` split on
  `/api/career/role`, are unchanged for everyone else. No GET was added to
  `js/gp-cache.js`.

### `js/au-doctor.js?v=20261122a` (`window.GPAuDoctor`)

| Call | What it does |
| --- | --- |
| `cached()` | The doctor's details from the session this tab already holds (`gpc:/api/auth/session`). No request. `null` unless the session clearly says "switch on, Australian pathway". |
| `refresh()` | Asks the server past every cache; resolves `{ ok, info }`; writes the answer where `js/gp-cache.js` keeps the session; keeps the device hint. |
| `syncEligibility(info)` | Compares `info.eligibilityVersion` with `localStorage gp_au_eligibility_version`. Different, none stored, or none sent: removes `gp_career_roles_cache`, every `gp_career_role_detail:*` and every `gpc:/api/career/role*` entry and stores the new version. Returns `{ changed, purged }`. |
| `limitsCopy(limits)` | Every sentence that names an application limit, from the three numbers. `null` when they are not all known. |
| `formatDate(value, options?)` | `20 Nov 2026` (`en-AU`). `LOCALE` is exported for `toLocaleDateString` calls that need other options. |

**WP-12** added the journey, the entry route, the role label and the shared
wording to this file, and the same loader now also writes `js/au-localise.js`
(section 24 has the current loader line and the list of pages that carry it).

**It is never loaded with a plain `<script src>`.** A page adds it only when
the device already knows the doctor is Australian: the hint
`gp_au_pathway_hint`, or `"isAu":true` in the saved session. The exact inline
loader is in `pages/career.html` and `pages/job.html` between the `AU-FB1`
markers (copy it as it is; `tests/au-fb1-client.test.js` pins it), and the
shell does the same inside `auLimitsNote()` (`js/gp-walkthrough-shell.js`).
It is not in the service worker's precache, on purpose: precaching would make
every browser request it. A device that does not yet know (first visit in a
new browser) learns from the session the careers page already reads
(`auDoctorLateStart`).

On Careers, `auDoctorBoot()` runs once per page load before the role list is
read: `refresh()`, `syncEligibility()`, the onboarding check, the limits copy.
If the server cannot be asked the list is read from the network rather than
from a saved copy. `pages/job.html` never uses its 10-minute saved copy of a
role for an Australian doctor.

### A pathway on record steers the doctor (D12, D13, D14)

- **Onboarding.** `auTakeOver` enters the Australian branch whenever
  `GPAuPathway.mine().isAu` (`auServerRecorded`): no first question, no way
  back to it, "No" does nothing. `POST /api/onboarding/complete` refuses a
  non-Australian payload from such a doctor with 409 `{ code: 'au_pathway',
  auBranchRequired: true }` and writes nothing (503 `pathway_unreadable` when
  the pathway cannot be read). This costs every completion one pathway read
  with the switch on.
- **`GET /api/onboarding/au-prefill`** (switch on, Australian pathway on
  record; 404 otherwise) → `{ ok, pathway, onboardingComplete, answers: { state,
  ahpraNumber } }`. The branch fills empty answers from it.
- **Careers.** A doctor on an Australian pathway who has not finished
  onboarding is sent to `/pages/onboarding`: a 302 from the server for
  `/pages/career` (any spelling, `auGatePageKey`), and the same check in the
  page, because the service worker can serve a saved copy of the page. A
  self sign-up who has not answered the first question has no pathway and is
  not caught (neither is an overseas sign-up today).
- **The invite.** The link carries `&invite=1`; the bridge passes it to the
  password screen, where it changes the wording only. After Supabase accepts
  the recovery token and sets the password, `auCompleteInvitePasswordSetup`
  marks the address verified (`app_metadata.email_verified_at`) and issues
  the session **only when** the switch is on, staff created the account
  (`app_metadata.created_by_staff`), the address has never been verified, the
  recorded pathway is Australian and the account is not archived. The reply
  then carries `signedIn: true, redirectTo: '/pages/onboarding'`. Anything
  else, including a second use of the same token, gets the ordinary reply.
  **The set-password link itself is not single-use** (unchanged: it stays
  valid for its 72 hours so that a mail scanner opening it cannot lock the
  doctor out); what is once-only is the verify-and-sign-in step.
- `auSplitStaffPhone` splits the phone staff typed at a known dial code.

### One CV for an Australian doctor (D16)

`GET /api/account/career-documents` answers `au: true` and maps the `cv` card
to the `career_cv` row; `PUT` with `type: 'cv'` is refused for them (409
`au_pathway`), and `pages/account.html` sends their CV to
`POST /api/career/profile/cv`, the same request the apply step makes. A cover
letter is unchanged. Overseas doctors keep both stores (`cv_signed_dated` from
Account, with its AHPRA-stage review task; `career_cv` from Careers).

### Copy

The promise about a doctor's current practice is, everywhere an Australian
doctor reads it, "We never contact your current practice without asking you
first" (`tests/au-fb1-client.test.js` scans the Australian sources).
`CONSENT_VERSION` moved to `au-share-consent-draft-2026-11-21` because the
sheet's footnote changed.

Tests: `tests/au-fb1-server.test.js`, `tests/au-fb1-client.test.js`. The
database stub's auth emulation now merges metadata on an admin `PUT` and
answers `PUT /auth/v1/user` for a token mapped with `emu.authTokens[token] =
userId`.

## 22. Time zones and interview windows (WP-10)

Written by WP-10. **Read this before showing anyone a time, sending anything
on a timer, or offering an interview slot.**

**In one paragraph.** "Which clock is this person on?" has one answer, from
`lib/au-timezone.js`: the zone they booked in, then the zone their browser
reported, then their Australian state, then their phone's dial code, then the
country on file. It is used for **Australian-segment leads and doctors on an
Australian pathway only, switch on**. Every other lead and doctor, and
everyone with the switch off, keeps exactly the zone the code computed before
(country guess; unknown is London): the helpers answer `null` for them and the
caller falls through to its old line. `tests/au-wp10-overseas-parity.test.js`
holds a snapshot taken before any code changed and fails if an overseas zone,
calling window, interview slot or time label moves.

### The resolver (`lib/au-timezone.js`, pure)

| Helper | Contract |
| --- | --- |
| `resolveZone({ bookerZone, browserZone, state, phone, country }) → { zone, source, certain }` | The precedence above. `source`: `booker`, `browser`, `state`, `dial_code`, `country`, `default`. `certain` is false when all that is known is "Australia" (a +61 number, or country `au` with no state): the zone is Sydney as a last resort. Never say "your local time" on an uncertain answer; every label names the city ("Sydney time"). |
| `validZone(value) → zone \| ''` | **The only gate for a zone from a browser or a booking tool.** Must look like `Region/City`, be known to `Intl`, and not be `UTC` / `GMT` / `Etc/…` (a privacy browser or a script reports UTC, which says nothing). Never store or use a raw client zone. |
| `AU_STATE_TZ`, `zoneForAuState(state)`, `normaliseAuState(state)` | The single state → IANA table is `interviewMeetings.AU_STATE_TZ` (the practice side has always used it); this module re-exports it. Codes and full names are accepted. NSW / ACT → `Australia/Sydney`, VIC → Melbourne, TAS → Hobart, SA → Adelaide (these four observe daylight saving); QLD → Brisbane, NT → Darwin, WA → Perth (these never do). |
| `auLeadZone(lead, { phone, bookingZone, auPathwayEnabled }) → result \| null` | For a `site_enquiries` row or its consult object. `null` unless the switch is on **and** `isAuSegmentLead(lead)`. |
| `auDoctorZone({ profile, viewerZone, bookingZone, phone }) → result` | For a doctor the caller has already established is on an Australian pathway. `profile` needs `timezone` and `current_state`. |
| `localHourFor(leadOrProfile, nowMs, { kind?, isAu?, phone?, bookingZone?, viewerZone?, country?, auPathwayEnabled? }) → { hour, minute, minutes, weekday, zone, source, certain }` | **The hook for WP-16's quiet hours.** A lead row / consult object, or a `user_profiles` row (pass `isAu: true` from `resolveCandidatePathway` for an Australian doctor; say `kind: 'lead' \| 'doctor'` if the shape is ambiguous). Australian subjects are resolved; everyone else gets the zone the product has always used, with `source: 'legacy'`. |
| `auZoneLabel(zone)`, `AU_ZONE_LABELS`, `auZoneAbbreviation(zone, at)` | "Perth time", "Sydney time" (the style `lib/consult-reminders.js` already used for "UK time"); `AWST` / `AEDT` for places that print an abbreviation. |
| `withLeadZone(consult, zone, 'calendly' \| 'browser')`, `withLeadState(consult, state)` | Return a new consult object, or the **same** object when there is nothing to write. A browser zone never replaces a Calendly one. |
| `timezoneToStoreForState({ newState, previousState, storedTimezone })` | What to put in `user_profiles.timezone` when a state is written (below). |
| `practiceWeekendNow(nowMs, { auPathwayEnabled, practiceTz })` | COM-27 (section 2). |

In `server.js`: `auZoneFactsForUser(userId)` and `auInterviewFacts(appCtx)`
(both `null` unless switch on and Australian pathway; two reads, the second
is the preference columns in their own query), `interviewGpZone(appCtx,
viewerTz, rowTz)`, `interviewPracticeZone(appCtx)`, `auPracticeWindowsError(appCtx,
windows, viewerTz)`, `storeConsultLeadBrowserZone(consult, body)`.

### What is stored where

| What | Where | Written by |
| --- | --- | --- |
| A doctor's zone | `user_profiles.timezone` (WP-02 column) | Australian onboarding: the browser's zone (`browserTz` on `POST /api/onboarding/complete`, sent by `js/onboarding.js` for the Australian branch only), else derived from the state. The slot picker: `GET /api/career/interview/slots?viewer_tz=` refreshes it for an Australian doctor when the device zone changed (the request already carried the zone; no new request was added). `setCandidatePreferences`: a write that sets `current_state` without a zone sets the zone from the state when none is stored, or when what is stored is just the previous state's zone. **A zone a browser reported is never overwritten by a state.** |
| A doctor's state | `user_profiles.current_state` | Unchanged (WP-05 onboarding, WP-06 staff). |
| A lead's zone | `site_enquiries.metadata.consult.timezone` + `timezone_source` (`calendly` / `browser`) | The `/start` form sends the browser zone on every submit (hidden field `cfTz`, body key `tz`); the Calendly webhook records the invitee's zone (`ensureLeadBookedCallAt`'s sixth argument, `captureCalendlyDirectBookerLead`). Switch on only, for every lead (so a lead tagged Australian later already has it); **used** only for Australian-segment leads. |
| A lead's state | `site_enquiries.metadata.consult.state` | **Since WP-15 the `/start` form sends it** for a doctor who says they are Ahpra-registered (section 27). The original note: when the form asks, send it as `state` on `POST /api/public/consult-lead`; `storeConsultLeadBrowserZone` already validates and stores it (`'WA'`, `'wa'`, `'Western Australia'` → `'WA'`). Elsewhere call `auTimezone.withLeadState(consult, answer)`. Note `site_enquiries.state` (the column) holds the **country**, as it always has. |

No column, table or migration was added.

### Where the resolver is used

| Site | For whom |
| --- | --- |
| `consultReminderRules.consultLeadTimeZone(consult, phone, { bookingZone })` | Australian-segment leads: booking confirmation, the day-before / one-hour / starting reminders (email and WhatsApp), the owner's "a lead replied" page. The reminders cron passes the booking's own `scheduled_calls.timezone`. |
| No-show rescue email (`maybeRunConsultNoShowRescue`) | Same. |
| `leadCalls.leadCallZone(row, country)` / `isWithinLeadCallWindow(row, nowMs, windows)` | Calling hours on the lead's own clock. **Hazel still never rings an Australian-segment lead**: `leadCallDecision` returns `au_segment` first, unconditionally. The zone feeds what still reads it: the Leads tab's local time, an inbound call's prompt variables, the tools, and WP-16. |
| `_interviewComputeSlots`, `_bookInterviewSlot`, `resendInterviewConfirmation`, `/api/cron/interview-reminders` | Doctors on an Australian pathway: the doctor's side of every interview time. |

Send times anchored on a meeting (consult and interview reminders) are the same
instants as before; only the stated local time and its label change.

### Interview windows for an Australian candidate (DAT-22, COM-19)

The numbers live in `auTimezone.AU_INTERVIEW_DEFAULTS` /
`auInterviewConfig(env)`, read at call time:

| | Default | Environment override |
| --- | --- | --- |
| Practice hours, on the **practice's** clock, Monday to Friday | 08:00 to 19:30 (an interview must end by the close; the last 30-minute start is 19:00) | `AU_INTERVIEW_PRACTICE_HOURS="08:00-19:30"` |
| Doctor's reasonable hours, on the **doctor's** clock | 07:00 to 21:00 | `AU_INTERVIEW_GP_HOURS="07:00-21:00"` |
| Weekends | closed | `AU_INTERVIEW_WEEKENDS=true` (same practice hours) |

They replace, for a candidate on an Australian pathway with the switch on, the
overseas set in `lib/interview-meetings.js` (host 11:00 to 02:00 Sydney,
practice evenings and weekends, doctor 06:00 to 23:00), which stays untouched
for everyone else. `auInterviewParties(practiceTz, gpTz)` returns the three
scheduler parties; the owner's diary is still subtracted (clash prevention and
the gap either side are unchanged), and times a practice chose are still the
only bookable ones.

Where it is enforced: the slot computation (the doctor's pickers, the CEO
tool's slots, "use default times", and the server's re-check of a submitted
pick, which answers 409 for anything outside); `POST
/api/practice/application/decision` and `.../availability` answer 400
`windows_outside_hours` (`auInterviewWindowError`: judged on the practice's
clock even when the contact's device is elsewhere); a pasted reply is trimmed
to the hours; `GET /api/practice/application/decision-context` sends
`candidate.interviewWindow` (Australian candidates only) and the page offers
only those hours. The interview-times request (P06) uses
`auInterviewTimesAsk`. **Not constrained, on purpose:** a time staff type on
"Practice accepted" (`parseManualInterviewTime`): they are recording what was
agreed on the phone.

### Hooks for later packages

| Package | What to do |
| --- | --- |
| WP-15 (segment and state on the lead form) | Send the state as `state` with the form (stored already), or call `withLeadState`. When `isAuSegmentLead` starts reading `consult.segment`, every site above follows with no change: they all ask `auLeadZone`. This is what moves a UK-trained GP living in Australia onto Australian time; until then they are an overseas lead on UK time, by design. |
| WP-16 (lead messages, quiet hours) | **Done** (section 28): the gate is `auQuietHours.auQuietHoursAllow`, built on `localHourFor`. Australian copy labels a zone by its city through `formatLeadCallTime(iso, zone, { cityLabel: true })`, so a doctor abroad reads "London time", never "UK time". |
| WP-17 and anything that emails a doctor a time | `auZoneFactsForUser(userId)` then `auTimezone.auDoctorZone({ profile, viewerZone })`; fall back to the old expression when it answers `null`. |

Tests: `tests/au-wp10-timezone-lib.test.js`, `tests/au-wp10-leads-server.test.js`,
`tests/au-wp10-interviews-server.test.js`, `tests/au-wp10-overseas-parity.test.js`
(+ `tests/helpers/au-wp10-parity.js`, `tests/fixtures/au-wp10-overseas-parity.snapshot.json`).
The database stub does **not** evaluate `ilike`, `like`, `gt/gte/lt/lte`
filters (it lets every row through): seed one lead at a time when a test
depends on a lookup by email.

---

## 23. Placement branch and pre-start (WP-11)

Written by WP-11. **Read this before touching anything a placement sets in
motion, adding a task for an Australian case, or sending an Australian doctor
or their practice a message about a placement.**

**In one paragraph.** What a placement sets in motion is decided in one pure
function, `placementHooksFor` (`lib/placement-hooks.js`): the placement-hook
matrix of the review report, one named answer per row. Every place a placement
is recorded asks it. An overseas doctor (nothing recorded, the switch off, the
migration not applied) gets exactly the cascade they always got:
`tests/au-wp11-overseas-parity.test.js` compares every task, timeline line,
document, email, WhatsApp, bell item and Drive call with a snapshot taken
before WP-11 changed any code. A doctor on an Australian pathway gets none of
the overseas pack; `auRunPlacementHooks` does the Australian work instead, on
the **fact** that a placement is on record, once per placement. When the
pathway cannot be read the pathway-dependent steps are **held** and run by
themselves once it reads. WP-11 adds no column, table or migration.

### The decision (`lib/placement-hooks.js`, pure)

`placementHooksFor(pathwayResult, credentials) → hooks`. `pathwayResult` is
what `resolveCandidatePathway` returned; `credentials` is the `gp_credentials`
row (read only for segment B). Every row answers `'fire'` (today's thing),
`'skip'`, `'variant'` (the Australian version), `'review'` (segment B or C: not
known, a person decides) or `'hold'` (pathway unreadable).

| Row (`hooks.…`) | Overseas | A `au_vr` | B `au_restricted` | C `au_non_vr`, `au_registrar` | Hold |
| --- | --- | --- | --- | --- | --- |
| `offerAccepted`, `hired`, `placementRow`, `jobFilled` | fire | fire | fire | fire | fire |
| `practiceConfirmedEmail` | fire | variant (N12) | variant (N12) | variant (N12) | hold |
| `contractTask` | fire | fire | fire | fire | fire |
| `positionDescriptionTask` | fire | skip | fire if registration is supervised **or** the right to work is tied to a sponsor; skip if both are known not to be; else review | review (the matrix says "variant"; nobody has confirmed what the variant is) | hold |
| `supervisorCvTask`, `sppa00Task` | fire | skip | fire if registration is limited, provisional or a supervision level is on file; skip for general / specialist; no registration type on file: review | skip | hold |
| `sectionGTask`, `sectionGDelivery` | fire | skip | exactly as `sppa00Task` | skip | hold |
| `practicePackEmail` | fire | skip | skip | skip | hold |
| `gpPlacementMessage` (the "placement secured" message) | fire | variant (N11) | variant (N11 + one line) | variant (N11 + one line) | hold |
| `gpPrestartChecklist` | skip | fire | fire | fire | hold |
| `driveFolder` | fire | fire | fire | fire | fire |
| `driveDocumentCopy` | fire (the link-shared copy) | variant (team-only mirror) | variant | variant | hold |
| `ahpraStageWhatsApp`, `ahpraUnlockedEmail` | fire | skip | skip | skip | hold |
| `caseStage` | `ahpra` | `prestart` | `auPlacementTargetStage(pathway)` (`prestart`) | `prestart` | `null` |
| `ahpraGrantedHandler`, `visaCase` | fire | skip | skip (`visaTransferMayApply` is exposed for WP-14) | skip | hold |
| `medicarePbsModule` / `medicarePbsVariant` | fire / `overseas` | variant / `provider_number_new_location` | variant / `provider_number_plus_19ab_check` | variant / `provider_number_plus_program_approval` | hold |
| `commencementChecklist` / `commencementVariant` | fire / `overseas` | variant / `no_travel_items` | fire / `australian` | fire / `australian` | hold |
| `invoicePrompt` / `invoiceVariant` | skip (none exists) | variant / `on_commencement` | variant | variant | hold |
| `prestartTasks`, `assignRsoForPrestart` | skip | fire | fire | fire | hold |

Also on the result: `column` (`overseas` / `A` / `B` / `C` / `hold`), `isAu`,
`hold`, `holdReason`, `overseasCascade` (true only for the overseas column),
`practicePackKeys` (the pack tasks to create now, in the cascade's order),
`supervised` (segment B: `true` / `false` / `null` = not known) and
`staffReview` (`null`, or `{ reasons }` when a person must decide). The last
three rows of the matrix are **exposed, not built**: WP-12 and WP-13 read them.

Rules that never bend:

- **`readFailed` is `hold`.** Never the overseas pack at a doctor who may be
  Australian, never skipped for a doctor who may be overseas.
- **`schemaMissing` and switch off are `overseas`**, as everywhere else.
- **`null` means not known.** `supervisionFacts(credentials)` answers
  `true` / `false` / `null` for "supervised" and "a visa change is needed"; a
  `null` becomes `'review'`, never a guess.
- Regulatory detail is unconfirmed. Correct it in this file and nowhere else.

In `server.js` ask through **`auPlacementHooksForUser(userId) → { hooks,
pathway, credentials }`**. Switch off: the overseas column, nothing queried.
Overseas doctor: one pathway read. Segment B: also their `gp_credentials` row.

### The entry points, and how each asks

| Entry point | How it consults the decision |
| --- | --- |
| The "Career secured" block of `processRegistrationTaskAutomation` (the state-change path `PUT /api/state`, and `POST /api/admin/ops/replay-career-secured`) | Asks once when the block is about to run. Overseas: every step runs as before. A / B / C: **nothing in the block runs**. Hold: the neutral steps run (close job-search tasks, the contract task, the Drive folder and team-only mirror) and the hold is recorded. |
| The Australian branch at the end of `processRegistrationTaskAutomation` | `auMoveCaseOnPlacement` while the case is at `placement`; `auRunPlacementHooks(userId, { light: true })` once it is at `prestart` (a cheap "already done?" check after the first time). |
| `finalizeInAppPlacement`, i.e. `POST /api/ats/placement`, `POST /api/admin/ops/record-placement` and `POST /api/career/contract/finalize-signed` | Asks at the top. Step 5 (the automation pass) is the block above. Step 6b: `auAfterPlacementRecorded` (Australian: the runner; hold: the hold). Step 8: the doctor's "placement secured" message and the practice's "Placement confirmed" email go only when their rows say `fire`; an Australian doctor gets N11 / N12 from the runner. |
| `POST /api/admin/cases/sync` | The stage move, then `auRunPlacementHooks` for each Australian case. An overseas case: unchanged (this route never ran the cascade). |
| The daily `sla-sweep` job | `runAuPrestartSweep`: held placements, unfinished steps, N13 reminders. |
| Staff set a pathway (`auAfterStaffPathwayChange`), or save an Ahpra register check | `auRunPlacementHooks(userId, { force: true })`: a held or undecided placement is completed with what is now on file. |

**Facts, not flags.** The Australian work starts from `_auActivePlacementFor`
(an active `placements` row, else an application whose status is
placement-secured): the same two facts as `_auPlacementSecuredFact`. The
doctor's own `gp_career_state` and a kanban card at Hired never start it.

### `auRunPlacementHooks(userId, { source?, actor?, force?, silent?, light? })`

Idempotent, serialised per doctor, never throws. An overseas doctor, or no
placement on record: nothing happens. Steps, each driven by its row:

1. case to pre-start (`auMoveCaseOnPlacement`);
2. an RSO (`assignRsoForPrestart`: only an empty assignment is filled; **no**
   RSO-welcome WhatsApp, chat-owner change or mail-label transfer);
3. the open job-search tasks close (the cascade's own sweep);
4. the contract task (closed at once when the contract was signed in the app),
   and for segment B the pack tasks its rows allow;
5. Drive folder and team-only mirror; Section G only with SPPA-00, with no
   email to the doctor;
6. the pre-start tasks;
7. a staff decision task when `staffReview` is set (closed again once the
   hooks stop asking);
8. completion conditions and the credentialing-pack trigger;
9. N11 and N12.

When everything succeeded it writes the timeline line
`Australian placement steps completed [<placement key>]`, with what was
created and what was sent or skipped and why. Until that line exists every
call tries again; after it, a call does nothing more (`force` re-runs the
steps; nothing is ever created or sent twice). **The placement key is the
application id**: tasks carry it as `metadata.placement_key`, and the
once-ever ledger keys end with it, so a doctor placed a second time gets a
second set.

### The task set (`lib/au-prestart.js`)

All use task types the WP-06 migration already allows. Owner, due rule and
"done when" live in `TASK_INFO` and `DUE_RULES` and nowhere else.

| Row | Type | Owner | Raised | Due (in `DUE_RULES`) | Done when |
| --- | --- | --- | --- | --- | --- |
| 2 | `dpa_19ab_check` | consultant | an application reaches shortlisted or applied, segments B and C; one per application | 2 days | staff mark it complete |
| 3 | `reference_check` | consultant | submitted to practice, every Australian pathway; **one per case** | 5 days | the completed checks are filed in the `au_references` slot (automatic), or staff mark it complete. The doctor gives two referees on the pre-start page (WP-12, section 24); staff read them on `GET /api/admin/au/prestart`. |
| 4 | `restraint_check` | consultant | offer stage, every Australian pathway; one per application | 3 days | staff mark it complete |
| 5 | `practice_pack_child` / `offer_contract` | (existing engine) | placement recorded | 28 days (existing rule) | the signed file lands; closed at once when the contract was signed in the app |
| 6 | `start_date_tracking` | consultant, then RSO | placement recorded | 3 days after the placement | a confirmed start date is saved: `auConfirmStartDate` |
| 7 | `indemnity_certificate` | RSO | placement recorded | 14 days before the start date, else 14 days after the placement | the doctor's `au_indemnity_certificate` document is approved (automatic: `auOnAuDocumentApproved`, called by the automatic review, a person's review and staff filing) |
| 8 | `provider_number_new_location` | RSO | placement recorded | 21 days before the start date, else 7 days after the placement | the number is recorded: `auRecordProviderNumber` |
| 9 | `credentialing_pack` | RSO | **only once** the Ahpra register check is done (no open `ahpra_register_check` task and `gp_credentials.staff_verified_at` set) **and** the indemnity task is complete: `credentialingPackTrigger` | 7 days before the start date, else 7 days after it is raised | staff mark it complete once the pack has gone to the practice |

- A due date is never less than 2 days away when the task is raised
  (`MIN_LEAD_DAYS`). Saving the confirmed start date re-anchors the other open
  pre-start tasks that are still on their automatic date
  (`metadata.due_auto`).
- **One of each per placement.** `_auEnsurePlacementTask` reads first, then
  claims `au_task:<type>:<placement key>` in the once-ever ledger
  (`gp_nudge_log`, channel `task`) so two requests racing cannot both insert.
- Each task's `metadata` carries `au: true`, `owner`, `owner_then`,
  `what_to_do`, `done_when`, `checklist_row`, `placement_key`. The dashboards
  draw the card line from `what_to_do`.
- **Three tasks are finished by a fact, not a tick.** `PUT /api/admin/task`
  with `status: 'completed'` answers 409 `au_task_needs_its_action` for a
  provider-number task with no number, a start-date task with no confirmed
  date, and any indemnity task.
- The doctor's other required pre-start documents get **no task** (owner rule:
  a document not yet uploaded shows as outstanding, it is not chased by a
  task). They are chased by N13.
- `auSyncPrestartTasks(userId)` keeps all of this in step and is safe to call
  any time. **`auPrestartComplete(caseId) → { ok, complete, missing, open,
  placementKey }`** is true when all four pre-start tasks exist and are
  completed. It sends nothing: **WP-17** sends N16 from it, **WP-13** checks
  it before commencement.

**The provider number (changed by WP-12, ADM-21).** Its home is now the
doctor's `medicare_provider` row in `pbs_applications`, with the location in
the `au_location_*` columns; the task keeps a copy and says where the home copy
went (`stored_in`). Section 24 has the rule, the one writer and the one reader.

### Staff routes

Switch off: 404. CEO / super admin and consultants: any Australian doctor. RSO:
only a doctor whose case is assigned to them (`ensureAuPathwayStaffAccess`). An
overseas case: 409 `not_au_pathway`. Every write is audit-logged.

| Route | What it does |
| --- | --- |
| `GET /api/admin/au/task-types` | `{ task_types: [{ task_type, label, owner, owner_then, what_to_do, done_when, default_due_days, default_stage }], stages, practice_request_items, gp_request_items }`. **How `pages/admin.html` learns the switch**: a 404 leaves the manual task form exactly as it was. |
| `GET /api/admin/au/prestart?case_id=` | `{ stage, assigned_rso, placement, prestart_complete, missing, open, tasks: [...] }` |
| `POST /api/admin/au/prestart/provider-number` `{ case_id, provider_number, location_name?, task_id? }` | Records the number, closes the task. 400 `invalid_provider_number`. |
| `POST /api/admin/au/prestart/start-date` `{ case_id, start_date, notice_period_weeks?, task_id? }` | Saves the date on the placement, closes the task, re-anchors the other due dates. |
| `POST /api/admin/au/prestart/request-item` `{ case_id, items: [...] }` | N13. `items` are keys of `GP_REQUEST_ITEMS` or of the doctor's own pre-start documents. Once per item set per day. |
| `POST /api/admin/au/prestart/practice-request` `{ case_id, items: [...], note? }` | N14. `items` are keys of `PRACTICE_REQUEST_ITEMS` (fixed wording). A note carrying a banned phrase is refused (400 `note_not_allowed`). Once per item set per day. |
| `POST /api/admin/tasks` with an Australian `task_type` | ADM-10. Australian case only (400 `not_au_pathway`); defaults from `buildManualAuTask`; a pre-start type the placement already has: 409 `task_exists`. **Switch off: 502 "Failed to create task." with nothing written**, which is what the live database answers today. |

### Messages (`lib/au-placement-messages.js`)

First-cut copy. **WP-17 owns the wording: change it in that file.** Each
builder returns the ledger key, so each goes at most once.

| | To | Channels | Sent by | Once per |
| --- | --- | --- | --- | --- |
| N11 "Your placement is secured: your pre-start checklist" | doctor | email, bell; WhatsApp only through the approved Australian template `placement_secured` (not approved: skipped, reason on the timeline) | `auSendPlacementSecuredToGp` (the runner) | placement |
| N12 "Placement confirmed: Dr X" | practice | email | `auSendPlacementConfirmedToPractice` (the runner) | placement |
| N13 "Needed before you start" | doctor | email, bell | `auSendPrestartItemRequest`: staff (`request-item`), and the daily pass at 3 and 7 days for required documents still missing | request |
| N14 "what we need from your practice" | practice | email | `auSendPracticeFormNeeded`: staff (`practice-request`) | request |

- All sends go through `sendGpNotificationEmail` / `sendEmail` /
  `sendDoubleTickTemplateTo`, so the preview send lock applies.
- N12 says about the guarantee only what `assets/legal/src/agreement-2026.html`
  says (a 12-week guarantee period for permanent placements, from
  commencement, clause 7). No credit figures, no fee.
- Tests scan every builder's output for the AGENT-RULES section 4 words and
  `careerIntro.auPracticeTextViolations`. Dates are calendar dates; no clock
  time is sent, so no time-zone label is needed.

### Bell items that survive an open browser

**A general weakness, reported, not fixed for overseas doctors.** The bell list
(`gp_link_updates`) is a blob the browser owns: every save from an open page
sends its own copy and `PUT /api/state` stores it whole. An item the server
added after that page loaded is not in the page's copy, so the page's next
save wipes it. This is true today for every server-pushed item ("Your
placement is secured", document verdicts, practice decisions); it is pinned in
`tests/au-wp11-staff-actions-server.test.js`.

For the Australian messages: `auPushDurableBell(userId, id, bell)` adds the
entry **and** keeps a copy in `user_state.state.gp_au_bell_pending`, a
server-owned key (not in `USER_STATE_KEYS`: a browser can neither read nor
write it). `PUT /api/state` (switch on, and only for a doctor who has that key)
puts back any pending entry the incoming list lacks, and forgets an entry once
a browser has sent it back. After that the browser owns it (the doctor can
clear it). The browser keeps only `type, title, detail, ts, target, category`
of an entry, so an entry is recognised by `ts` + `title`
(`bellIdentity`). **New Australian bell items should use `auPushDurableBell`.**

### Held placements

`user_state.state.gp_au_placement_hold` (server-owned) =
`{ at, reason, application_id, commencement_date, placement_confirmed,
notices_pending }`. Written when a placement is recorded and the pathway cannot
be read, with a timeline line and **one** staff task (type `manual`, source
`au_placement_pathway_hold`, "Confirm pathway before pre-start / registration
pack", filed under no stage so the cascade's sweep cannot close it).
`auReleasePlacementHold` runs at the top of every state sync for a doctor
carrying the key (so it costs nothing for anyone else) and in the daily pass.
Overseas doctor: the placement is finalised again as a resume, which replays
the block and sends the two held notices. Australian doctor: the runner.

### ADM-11: no "hired" Australian doctor without a placement

- `PATCH /api/ats/application` with `stage: 'hired'` answers 409
  `{ code: 'au_placement_required', case_id, application_id, offer_status,
  placement_form, message }` for a doctor on an Australian pathway whose
  placement is not recorded (`auBareHiredMoveRefusal`). Overseas: unchanged.
- `POST /api/ats/placement` and `POST /api/admin/ops/record-placement` answer
  400 `start_date_required` for an Australian doctor with no start date (the
  commencement date, or the offer's start date).
- The signed-contract path cannot ask the doctor for a date: the placement is
  recorded with the offer's start date if there is one, else none, and the
  start-date task is raised at high priority.
- `js/ceo-ats-jobs.js` (`auHiredRefused`) and `js/ceo-ats-candidates.js`
  (`window.atsOpenPlacementForm`) open the placement form on that refusal; the
  form says "Start date (required)" for an Australian doctor.

### D8: overseas practice actions on an Australian case

`auRefuseOverseasPracticeAction(req, res, adminCtx, subject, action, { text })`
sends 409 with a plain message and audits it
(`admin_overseas_action_refused_au_pathway`); `subject` is `{ userId }`,
`{ caseId }`, `{ taskId }` or `{ task }`. The rule is
`placementHooksLib.overseasActionVerdict(hooks, action)`: codes `au_pathway`
(the matrix says skip), `needs_staff_decision` (`review`),
`pathway_unreadable`. Segment B with supervised registration keeps what its
rows allow. Guarded:

| Endpoint | Action |
| --- | --- |
| `POST /api/admin/email/send` (with a `taskId` or `caseId`) | by the task it belongs to, then by what the subject and body ask for (`overseasRequestBlockedInText`: supervisor CV, SPPA / supervised practice plan, Section G, position description). **This is the composer behind "Email the practice requesting the Supervisor CV".** An email with neither id cannot be tied to a case and is not checked. |
| `POST /api/admin/va/task/<id>/sppa-*` (every SPPA-00 action) | `sppa` |
| `POST /api/admin/va/task/<id>/alt-cv-*` | `alt_supervisor_cv` |
| `POST /api/admin/va/task/<id>/ahpra-*` | `ahpra_letter` |
| `POST /api/admin/redeliver-section-g` | `section_g` |
| `POST /api/admin/va/task/generate-position-description` | `position_description` |
| `POST /api/admin/practice-doc/upload` | by document key (the contract is allowed for everyone) |
| `POST /api/admin/tasks` with a practice-pack type | by type and document key |
| `POST /api/admin/ahpra/ingest-manual` ("Log AHPRA letter"), `/ahpra/release`, `/ahpra/item/practice-request`, `/ahpra/item/officer-reply` | `ahpra_letter` (refused for every Australian segment; WP-14 opens what segment B needs) |
| `POST /api/admin/ahpra/registration-granted`, `/registration-granted/send-practice-email`, `/send-gp-request` | `registration_granted` |

**A new staff action that sends an overseas-style request must call it.** The
pages still show the buttons (WP-26); the two dashboards' `getGuidedAction`
no longer offers "Email Practice" on a review task about an Australian
doctor's own document.

### Hooks for later packages

| Package | What to do |
| --- | --- |
| **WP-12 (GP app)** | The doctor's pre-start page: read `GET /api/gp/au-documents` (WP-07) for uploads; there is **no doctor-facing route for the tasks yet**: build one from `auSyncPrestartTasks` / `auPrestartStaffView` (never send `what_to_do` or `staffLabel` to a doctor). The provider-number step: move the number from the task's metadata into `pbs_applications` once it has a location (ADM-21), and let the doctor enter it (call `auRecordProviderNumber`). Referee details: collect two names; the `reference_check` task and the `au_references` slot are waiting. N11's and N13's button goes to `/pages/my-documents`: point it at the new page. `hooks.medicarePbsVariant` says which Medicare variant applies. |
| **WP-13 (commencement)** | `auPrestartComplete(caseId)` before "Confirm commenced"; `hooks.commencementVariant` and `hooks.invoiceVariant` (`on_commencement`); the `invoice_due` and `guarantee_checkin` task types are allowed and unused. `runAuPrestartSweep` is the daily pre-start pass: add the lifecycle reminders beside it. Add `commenced_at` to `placements`; `_auActivePlacementFor` reads the row with `select=*`. |
| **WP-14 (segment B)** | `auPlacementTargetStage` is still `prestart` for everyone; if it ever answers `ahpra`, the state sync's runner call (which keys on `prestart`) and `runAuPrestartSweep` (which reads `stage=eq.prestart`) need the other stage too. Segment B's supervision tasks are created (`practice_pack_child`, under `prestart`) but WP-04's three exclusions (Section G sweep, SPPA backfill scan, SPPA practice chase) still skip every Australian doctor, so nothing drives them forward: open those for a B doctor whose hooks say `fire`. `hooks.visaTransferMayApply`. The `ahpra_letter` and `registration_granted` actions are refused for every Australian segment. |
| **WP-17 (copy)** | `lib/au-placement-messages.js`, and the proposed WhatsApp template `placement_secured` in `whatsapp-templates.md`. N16 from `auPrestartComplete`. |
| **WP-26 (dashboards)** | The overseas buttons are still drawn on an Australian case and answer 409. `GET /api/admin/au/prestart` has no screen. Recording a provider number or a start date is a `window.prompt` on the RSO dashboard. N13 / N14 requests have no button. The Australian task card is one line. |

### What staff see

- **RSO dashboard (`pages/admin.html`).** `auTaskMeta(task)` reads the card
  text from the task's `metadata`; nothing is hard-coded per type on the page.
  The Ops Queue card (`renderOpsGeneric`) shows what to do and the owner. The
  three tasks finished by a fact have no "Mark Complete": the provider-number
  card has **Record number**, the start-date card has **Save start date**
  (`data-ops-au-action`, both prompt and post to the routes above), the
  indemnity card says to approve the certificate on its own review task. A
  review task for an Australian doctor's own document (`related_document_key`
  starting `au_`) opens the review window, never the overseas "email the
  practice" action. Every other task's card is byte for byte what it was
  (pinned in `tests/au-wp11-dashboard-ui.test.js`).
- **CEO dashboard.** The Candidates stage picker and the Jobs board both
  answer a refused "Hired" move by opening the placement form with the start
  date marked required.
- **Known gap for WP-26:** the Ops Queue owner chip still shows the assigned
  RSO's name for every task, including the consultant-owned ones; the owner
  line inside the card is the true one.

---

## 24. The GP app for an Australian doctor (WP-12)

Written by WP-12. **Read this before changing any screen a doctor sees, adding
a doctor-facing string, or touching the provider number.**

**In one paragraph.** A doctor on an Australian pathway is shown four steps
(Secure placement, Pre-start checks, Medicare provider number, Start date),
worked out on the server from the stage their case is on. Three screens are
their own files, served by the server at the ordinary address and to nobody
else: Home, the pre-start checklist and the provider-number step. Every other
screen is shared with overseas doctors; on those, a small guard that only an
Australian doctor's browser ever loads swaps the wording that has an
Australian equivalent and removes any sentence that still carries a word from
AGENT-RULES section 4. An overseas doctor, and everyone with the switch off,
is served and shown exactly what they were (`tests/au-wp12-overseas-parity.test.js`
compares with a capture taken before WP-12 changed anything).

### The stage-name mapping (APP-08)

The case ladder (`lib/journey-ladders.js`) is unchanged. A **doctor** is shown
four steps; the mapping lives in `lib/au-gp-app.js` `doctorSteps(stage, facts?)`
and nowhere else on the server.

| Case stage | Secure placement | Pre-start checks | Medicare provider number | Start date |
| --- | --- | --- | --- | --- |
| `placement` (and anything not on the Australian ladder) | current | locked | locked | locked |
| `prestart` | done | current | open | open |
| `commenced`, `guarantee`, `complete` | done | done | done | done |

`facts` (`prestartDone`, `providerNumberRecorded`, `startDateConfirmed`) are
known only where the pre-start rows were read (`GET /api/gp/au-prestart`); they
refine the `prestart` row so that one step is "current".

- **Session.** `auJourney` gained two keys: `steps` (the four, from the stage
  alone: no extra read) and `entryRoute`. The five-rung `stages` list is still
  there for staff-facing uses.
- **Browser.** `js/au-doctor.js` reads it: `info.journey = { stage, placed,
  started, steps, entryRoute }`, `stepsFor(stage, facts?)` (the browser's copy
  of the mapping; a test keeps the two equal), `stageStates(info)` (the same
  four in the row shape `GPJourneyStages.getStageStates` returns).
- **Every consumer of the stage list** goes through `js/journey-stages.js`:
  `getStageStates()` answers the Australian rows when `GPAuDoctor.cached()`
  recognises the doctor, and today's rows otherwise. Also `isAuDoctor()`,
  `stagesForDoctor()`, `entryRoute()`. The shell's registration menu
  (`auRegistrationRows`), phase (`computePhase`: a placed Australian doctor is
  in the full app even on a fresh device) and nav (no Scan tab) use it.

### The entry route (APP-09)

"Where does *start / continue* lead?" is answered in one place per layer:

| Layer | Where | Answer for an Australian doctor |
| --- | --- | --- |
| Server | `auPageRouteDecision(key, { isAu, placed })` (`server.js`, pure, on `__testUtils`) | see the table below |
| Shell | `auRemapRouteUrl` inside `resolveRouteUrlForNavigation` (`js/app-shell.js`) | an address of the other journey → `/pages/prestart` once placed, `/pages/career` before |
| Any page | `GPJourneyStages.entryRoute()` / `GPAuDoctor.entryRoute(info)` | `/pages/prestart` once placed, `/pages/career` before; `/pages/myinthealth` for everyone else |

`GPAuDoctor.isOtherJourneyRoute(path)` is the list of addresses that are not an
Australian doctor's (MyIntealth, AMC, AHPRA, visa, the registration
introduction, commencement).

| Address | Australian doctor, placed | Australian doctor, not placed | Anyone else / switch off |
| --- | --- | --- | --- |
| `/pages/index` | `pages/index-au.html` | `pages/index-au.html` | today's page |
| `/pages/pbs` | `pages/pbs-au.html` (the overseas stage gate is not asked) | 302 `/pages/career` | today's page and gate |
| `/pages/prestart` | `pages/prestart.html` | 302 `/pages/career` | 302 `/pages/index` |
| `/pages/registration-intro`, `/pages/commencement` | 302 `/pages/prestart` | 302 `/pages/career` | today's behaviour |
| `/pages/index-au`, `/pages/pbs-au` (typed directly) | 302 to the ordinary address | same | 302 `/pages/index` |

"Placed" is `_auPlacementSecuredFact` (a fact, never the doctor's own state).
The three Australian files are `Cache-Control: private, no-store`, so the
service worker never keeps them. `pages/index.html` and `pages/pbs.html` carry
one inline line: **only** when the device hint says "Australian doctor" do they
hide themselves and load `js/au-page-handover.js`, which asks the server again
at an address a saved copy does not answer to.

### `GET /api/gp/au-prestart` and the doctor's actions (APP-13)

Switch off, signed out, or not on an Australian pathway: 404 and nothing read
(`auDoctorRouteContext`). The GET is **read only**.

`GET /api/gp/au-prestart` → `{ ok, placed, stage, stageLabel, launched,
teamLabel, entryRoute, steps[4], items[], complete, counts: { done, total },
practiceName, roleTitle, startDate, startDateConfirmed, providerNumber:
{ recorded, number, locationName }, providerStep, details }`.

Each `items[]` entry: `{ key, title, status: done | todo | waiting | attention,
statusLabel, who, whoLabel (You / GP Link / The practice / GP Link and the
practice), whatToDo, action?, documentKey?, note? }`. Composed by
`gpApp.buildPrestartChecklist` from: the WP-11 tasks for this placement, the
WP-07 documents (`phase: prestart`, `provider: you`, required), the
credentials row (`staff_verified_at` + no open check task = register check
done), `au_gp_doctor_details`, and the provider number.

| Item `key` | Done when |
| --- | --- |
| `register_check` | staff have verified the doctor and no `ahpra_register_check` task is open |
| `notice` | the doctor recorded it for **this** placement |
| `start_date` | the `start_date_tracking` task is complete with a confirmed date |
| `indemnity` | the `au_indemnity_certificate` document is approved |
| `provider_number` | a number is recorded for this placement |
| `referees` | the `reference_check` task is complete or `au_references` is approved (`waiting` once two referees are given) |
| `credentialing` | the `credentialing_pack` task is complete |
| `doc_<key>` | one per other required pre-start document: approved |

**Never sent to a doctor:** a task's title, `what_to_do`, `done_when`, owner
fields or notes, a document's `staffLabel`. The view's two private keys
(`_caseId`, `_placementKey`) are removed by `auPrestartPublicView`.

| Route | Body | Does |
| --- | --- | --- |
| `POST /api/gp/au-prestart/notice` | `{ given: true, date }` | `au_gp_doctor_details.notice_*` for this placement; a timeline line. |
| `POST /api/gp/au-prestart/referees` | `{ referees: [2 × { name, role, relationship, phone?, email?, agreedToContact: true, atCurrentPractice: true \| false }] }` | Stored for staff; a timeline line that says how many are at the current practice. The `reference_check` task is still closed by staff (or by the `au_references` slot). |
| `POST /api/gp/au-prestart/provider-details` | `{ existingProviderNumbers?: [{ number, location }], prescriberNumber?, newLocationProviderNumber? }` | The numbers already held go to `au_gp_doctor_details`. A new-location number goes through `auRecordProviderNumber(..., { source: 'doctor' })`: stored, and the staff task closes. |

All three: 409 `no_placement` before a placement; 400 `{ code: 'invalid',
errors }` and **nothing written** when a value is wrong; unknown keys are
ignored (there is no staff column in that table). Cleaners:
`lib/au-doctor-details.js` (`sanitiseReferees`, `sanitiseNotice`,
`sanitiseExistingNumbers`, `doctorView`, `staffView`).

Staff read what the doctor recorded on `GET /api/admin/au/prestart`:
`doctor_details` and `provider_number` were added to that response.

### Provider-number storage (ADM-21)

- **Home:** the doctor's `medicare_provider` row in `pbs_applications`:
  `provider_number` plus `au_location_practice_id`, `au_location_name`,
  `au_location_placement_key`, `au_location_recorded_by` (a staff email or
  `doctor`), `au_location_recorded_at`.
- **Limit, on purpose.** The live table is `UNIQUE (user_id, application_type)`.
  A second row for a second location cannot exist without dropping that rule,
  which this build does not do. So **one new-location number is held per
  doctor**; a second placement overwrites the location on the row, and the
  earlier number survives only on the earlier placement's task. Holding several
  at once is an owner decision (OWNER-ACTIONS).
- **One writer:** `auRecordProviderNumber(caseId, { providerNumber,
  locationName?, taskId?, source? }, actor)`. It writes the row
  (`_auWriteNewLocationProviderNumber`), then the task (a **copy** in
  `metadata.provider_number`, with `stored_in: 'pbs_applications'` and
  `pbs_application_id`), then completes the task. The copy exists only so the
  WP-11 staff card and the "this task needs its action" check need no second
  read. A database without the columns answers 400: the number is then kept on
  the task alone (`stored_in: 'task_metadata'`), as WP-11 left it. Any other
  failed write fails the action (502) and nothing is marked recorded.
- **One reader:** `auReadNewLocationProviderNumber(userId, placementKey,
  taskRows)`: the row when it carries a number for this placement, else the
  task copy.
- `GET /api/registration/can-proceed` for an Australian doctor answers
  `{ auPathway: true, steps: { career, prestart, pbs } }`: the provider-number
  step is `accessible` once a placement is on record (APP-11). Everyone else:
  today's body, byte for byte.

### `au_gp_doctor_details` (new table)

One row per doctor, service role only: `referees` (jsonb, two objects),
`referees_submitted_at`, `notice_given`, `notice_given_date`,
`notice_placement_key`, `notice_recorded_at`, `existing_provider_numbers`
(jsonb), `prescriber_number`. Read / written by `auReadDoctorDetails` /
`auWriteDoctorDetails` (its own query; switch on only). Migration:
`20261121100000_au_gp_wp12_prestart_details.sql` (applied to the local test
database only). Guard names for switch-off tests: `WP12_NEW_COLUMN_NAMES`,
`WP12_NEW_TABLES`, `wp12NewNameViolation(request)` in
`tests/helpers/au-fixtures.js`.

### Account (APP-26)

`GET / POST /api/account/au-details` (same 404 rule). The view is read from
the server-owned columns (`gp_credentials`, the preference columns,
`preferred_locations`, `au_gp_doctor_details`), never the onboarding blob.
POST takes any of `ahpraNumber, registrationType, fellowshipType,
fellowshipDetail, workRights (citizen | pr | temporary), noticePeriodWeeks,
availableFrom, currentState, currentSuburb, currentPostcode,
preferredLocations, existingProviderNumbers, prescriberNumber`. Everything is
checked first (a bad value: 400, nothing written). **The pathway is not an
input and is never re-derived**: a change to the number, registration type,
fellowship or right to work is saved through `upsertGpCredentials(..., { source:
'self' })`, logged on the case, and re-opens the register check
(`auStaffTools.CHECK_REASON.DETAILS_CHANGED`). The Ahpra number cannot be
changed once `staff_verified_at` is set. Page: `js/account-au.js`
(`GPAccountAu.mount`), loaded by `pages/account.html` only for an Australian
doctor.

### The neutral role label (D19)

One helper, two copies kept equal by a test: `gpApp.teamLabel(placed)` (server)
and `GPAuDoctor.teamLabel(placed)` / `TeamLabel(placed)` (browser):
**"your GP Link consultant"** before a placement, **"your GP Link team"**
after it. **WP-17:** use `gpApp.teamLabel` for the server-side messages; do
not write "Registration Support Officer" to an Australian doctor.

### The phrase guard on shared screens (`js/au-localise.js`)

`GPAuLocalise` starts by itself when loaded. It (1) replaces the phrases in
`PHRASES` (the other journey's job title, "about your move", "Relocation
package", "Start my registration", ...) and (2) removes any sentence that still
carries a banned word, on everything the page draws now or later (a
`MutationObserver`). It never touches what a person typed (inputs, text areas,
editable regions) or a region marked **`data-au-raw`** (the support thread).
While the device believes the doctor is Australian but the session has not
answered, the page is not painted; a session that says "not Australian" shows
the page untouched.

**The loader.** A page adds `js/au-doctor.js` and `js/au-localise.js` only
behind this exact inline line (copy it as it is; tests pin it):

```html
<script>(function(){try{var au=localStorage.getItem("gp_au_pathway_hint")==="1";if(!au){var raw=sessionStorage.getItem("gpc:/api/auth/session");au=!!raw&&raw.indexOf('"isAu":true')!==-1;}if(au)document.write('<script src="/js/au-doctor.js?v=20261122a"><\/script><script src="/js/au-localise.js?v=20261121a"><\/script>');}catch(e){}})();</script>
```

It is on: Careers, the job page, application detail, offer review, secure
interview, confirm call, area guide, Account, Support, and the shell (whose
copy sets `window.__gpAuShell` first so the shell itself is never held back).
A device that does not know yet (a sign-in in a new browser) learns from the
session the shell reads (`auOnSession`) and starts the shell again once.
**A new shared page a doctor can reach needs the loader**, and its file belongs
in `SHARED_PAGES` in `tests/au-wp12-banned-words.test.js`.

**Server twin:** `lib/au-doctor-text.js` (`BANNED_WORDS`, `violations`,
`scrubText`, `scrubRolePayload`). `auDecorateClientRole` and
`auScrubCareerPayloadFor` run every role, application and placement payload an
Australian doctor is sent through it. Tests import the list from
`tests/helpers/au-banned-words.js`.

### The shared job-facts renderer (WP-22)

`js/au-job-facts.js` → `GPAuJobFacts.rows(auFacts, { showDpa? })` returns
`[{ key, label, value }]` (billing, registration, sessions, location type,
engagement, special interests, registrars, and DPA only when asked);
`GPAuJobFacts.html(...)` returns a ready `<dl class="au-job-facts">`. No
dependency, no page code. The in-app job page uses `rows()` inside
`buildPracticeFactsHtml` when the role carries `auFacts`. **WP-22:** load the
same file on the public job page with a plain `<script src>` and call it with
`roleEligibility.publicRoleFacts(role)`.

### Other pieces

- **Slides.** `ctx.auWelcomeSlides` / `ctx.auPlacedSlides` replace the decks in
  `js/gp-intro-slides.js` (built by `GPAuDoctor.welcomeSlides` /
  `placedSlides`). One welcome slide; no deck for a held doctor; no careers
  tutorial, Home tour, tab tour or "start here" pointer for an Australian
  doctor (`auDoctorOnPage` in `js/gp-walkthrough.js`, `auCandidate` in
  `js/gp-walkthrough-shell.js`).
- **Careers.** Step 4 of the strip is "Pre-start" (`deriveCareerStep(apps,
  pathway)`). A held doctor: `html[data-au-hold="true"]` is set before paint
  and hides everything but the holding card, which is the first thing in the
  view. `auRegistrationPending: true` on `/api/career/roles` (a launched
  Australian doctor whose pathway staff have not confirmed) draws "More roles
  may open once we have confirmed your registration." No CV gate on arrival
  for an Australian doctor (the job page asks at apply).
- **Support.** `js/support-au.js` (`GPSupportAu`): categories (labels only; the
  values are ones the server already accepts), five short answers, five
  articles. `pages/messages.html` draws from them through `supportFaqItems()` /
  `supportArticles()` / `applySupportPathway()`.
- **Cache-busters moved:** `au-doctor.js` 20261121b, `my-documents-au.js`
  20261121a (new `keys` / `onChange` / `emptyHtml` mount options),
  `journey-stages.js`, `app-shell.js`, `career-step-strip.js`,
  `gp-walkthrough.js` 20261121a, `gp-intro-slides.js`,
  `gp-walkthrough-shell.js` 20261121b, `onboarding.js` 20261121c; `sw.js`
  VERSION 20261121d.

### Hooks for later packages

| Package | What to do |
| --- | --- |
| **WP-13 (commencement)** | The pre-start page is where "you have started" belongs: add items in `gpApp.buildPrestartChecklist` (the card with `key: 'start_date'` has the anchor `#start-date`), and once the case is `commenced` `doctorSteps` already shows all four done. `view.complete` is the doctor-side twin of `auPrestartComplete`. The notice date the doctor recorded is `au_gp_doctor_details.notice_given_date` (for the notice countdown). |
| **WP-14 (segment B)** | `providerNumberStep(variant)` already takes `provider_number_plus_19ab_check` / `..._plus_program_approval` (it only adds "please wait to hear from us"): write the real wording there. The B-only documents appear on the checklist when `required`. |
| **WP-17 (messages)** | `gpApp.teamLabel(placed)` for the role label. N11 and N13 now open `/pages/prestart`. N16 ("cleared to start") can read `view.complete`. Email wording must pass `auDoctorText.violations`. The confirmation a doctor gets after giving referees / notice is on screen only: no message is sent. |
| **WP-22 (public job page)** | `js/au-job-facts.js`, above. `lib/au-doctor-text.js` for a banned-word test of the public page. |
| **WP-26 (dashboards)** | `GET /api/admin/au/prestart` now carries `doctor_details` (two referees with "at current practice", notice date, existing numbers) and `provider_number` (with `stored_in`): no screen shows them yet. The `reference_check` task text still says to ask the doctor for names. `pages/admin-pbs.html` does not show the `au_location_*` columns. |

---

## 25. Commencement, invoice and guarantee tracking (WP-13)

Written by WP-13. **Read this before touching a placement's commercial
columns, anything that happens after a doctor starts, the daily Australian
job, or any text that mentions a fee, an invoice, the guarantee or a credit.**

**In one paragraph.** When an Australian doctor actually starts work, a
consultant or the CEO presses **Confirm commenced**. That stamps the day on the
placement, works out the fee from the agreement the practice signed, sets the
invoice due date and the end of the 12-week guarantee period, raises one
invoice task for the CEO and the check-ins for the consultant, and moves the
case on. From then one daily job does the reminders. If the doctor leaves, one
action records it and works out the credit from the agreement's schedule, or
records none and asks the CEO when it cannot be sure. **Nothing talks to Xero:
the "invoice" is a staff task and three dates a person types in.** An overseas
placement, and every placement with the switch off, is never read or written
by any of it.

### Where things live

| File | What |
| --- | --- |
| `lib/au-placement-fees.js` (pure) | **The agreement's terms as code**, each number with the source file and line beside it: fee tiers, full-time definition, invoice timing and terms, guarantee period, credit schedule, part-time uplift window. `placementFeeFor`, `signedAgreementVariantFor`, `guaranteeEndsOn`, `guaranteeCheckinDays`, `upliftReminderDays`, `guaranteeCreditFor`. **No other file may state a fee, a credit percentage or a guarantee length.** `tests/au-wp13-fees-lib.test.js` re-reads the two agreement HTML sources and fails if a figure here is no longer in them. |
| `lib/au-lifecycle.js` (pure) | `validateCommencement`; the staff task builders; `prestartRemindersDue` / `commencedRemindersDue` (what the daily job owes a placement on a given day); `commercialState`, `commercialSummary`; the export columns. Every timing rule is a constant at the top. |
| `lib/au-commencement.js` | The reads and writes. `createAuCommencement(ctx)` is given `server.js`'s guarded helpers; `server.js` holds the one instance, `auCommencement`. |
| `lib/au-placement-messages.js` | N18, N19, N20 (first-cut copy; WP-17 owns the wording). |
| `js/au-commencement.js` | The staff card, `GPAuCommencement.mount(el, { caseId, onChange })`. |

### The fee (owner decisions 3 and 4)

`placementFeeFor({ basis, sessionsPerWeek, variant, variantKnown?, variantReason? })`
→ `{ tier, amountExGst, variant, basis, source: 'agreement', known, reason, invoiceTiming, sessionsPerWeek }`.

| Based in Australia | `standard` | `discounted-2026` |
| --- | --- | --- |
| Full-time (8 or more sessions a week) | $21,000 | $19,000 |
| Part-time (fewer than 8) | $18,000 | $17,000 |

All exclusive of GST, invoiced in full on commencement. Sources:
`assets/legal/src/agreement-2026.html:182-185, :204, :237, :333, :343` and
`assets/legal/src/agreement-2026-discounted.html:218, :251, :348, :358`.

- `basis` is `candidatePathway.feeBasisFor(pathwayResult)`. Anything but
  `australia`: nothing is computed (`not_australian_basis`). **Overseas-based
  fees are not computed or changed anywhere in this build.**
- `sessionsPerWeek` is the **numeric** `placements.sessions_per_week_numeric`
  (DAT-16). The free-text `sessions_per_week` is never interpreted; the staff
  form offers it as a suggestion only when it is a bare number.
- **Which variant a practice signed:** `signedAgreementVariantFor(practiceRow)`.
  Known only for an e-signature on file (`agreement_status = 'signed'` and
  `agreement_signed_at`) dated on or after the day the 2026 agreement went live
  (`AGREEMENT_2026_LIVE_FROM`, 2026-07-16), with `metadata.agreement_variant`
  absent (standard: that is what the sign endpoint stamps) or a real variant.
  **Not known:** no practice on the placement, not signed, a paper agreement
  uploaded by hand, an earlier agreement, an unrecognised or draft key.
- **Fail closed.** Sessions or variant not known → `known: false`,
  `amountExGst: null`. The invoice task is then titled "Confirm
  sessions/agreement before invoicing" and no dollar figure appears anywhere.

### `placements`: new columns (migration `20261121110000_au_gp_wp13_placement_commercials.sql`)

All nullable, no default. Applied to the local test database only. The same
file creates the partial unique index `uniq_au_lifecycle_task` on
`registration_tasks` (see "The idempotency rule" below); it covers only tasks
whose metadata has a `lifecycle_kind`, which no task has before this package,
so it cannot fail on existing rows.

| Column | Type | Meaning |
| --- | --- | --- |
| `candidate_basis` | text | `australia` / `overseas` (CHECK). Only `australia` is written. |
| `fee_tier` | text | `full_time` / `part_time` (CHECK) |
| `fee_amount_ex_gst` | numeric(10,2) | From the agreement; NULL when not knowable. A CEO may type the invoiced amount on "Mark invoice sent" **only** when this is NULL. |
| `agreement_variant` | text | The variant the fee was read from |
| `commenced_at` | date | The day the doctor actually started |
| `commencement_confirmed_by` | text | Staff email |
| `invoice_due_at` | date | = `commenced_at` |
| `invoice_sent_at`, `invoice_paid_at` | date | Typed by the CEO |
| `invoice_reference` | text | The invoice number |
| `guarantee_ends_at` | date | `commenced_at` + 84 days |
| `ended_at` | date | Last working day, when the doctor left |
| `end_reason` | text | `<code>: <staff note>`; codes in `fees.EXIT_REASON` |
| `credit_pct` | numeric(5,2) | From the schedule, or a CEO decision; NULL = not decided (CHECK 0 to 100) |
| `sessions_per_week_numeric` | numeric(4,1) | DAT-16 |

**Reused, not duplicated:** `start_date` stays the *planned* date;
`sessions_per_week` (free text) is untouched; `status` (`active` / `ended` /
`cancelled`, the live CHECK) is what an early exit sets to `ended`.
`_auActivePlacementFor` gained `commencedAt`, and no longer brings an ended
placement back to life from its still-"secured" application.

Guard names for switch-off tests: `WP13_NEW_COLUMN_NAMES`,
`wp13NewNameViolation(request)` in `tests/helpers/au-fixtures.js` (scoped to
the `placements` table: several of the names are ordinary words other tables
use).

### Staff routes

`GET /api/admin/au/commencement?case_id=` and `POST /api/admin/au/commencement/<action>`
`{ case_id, ... }`. Switch off: 404, nothing read. An overseas doctor's case:
409 `not_au_pathway`. Every write is audit-logged (`admin_au_*`). A successful
POST answers the action's result plus `view` (the GET body).

| Action | Who | Body | Does |
| --- | --- | --- | --- |
| `confirm` | CEO, consultant | `commenced_at`, `sessions_per_week?`, `sessions_unknown?`, `override?`, `override_reason?` | See below |
| `early-exit` | CEO, consultant | `last_working_day`, `reason`, `conditions_confirmed?` (`yes` / `no` / `unknown`), `note?` | See below |
| `correct` | CEO | `commenced_at?`, `sessions_per_week?`, `reason` | Re-dates the invoice due date, the guarantee end and every derived task still open; recomputes the fee when the sessions change (refused once an invoice is recorded as sent) |
| `undo` | CEO | `reason` | "Commencement recorded in error": see the undo rule |
| `invoice-sent` | CEO | `sent_at`, `reference`, `amount_ex_gst?` (only when the fee is not on file); or `{ clear: true, reason }` | Records it and completes the invoice task |
| `invoice-paid` | CEO | `paid_at`; or `{ clear: true, reason }` | Records it; closes an "invoice overdue" reminder |
| `credit-decision` | CEO | `credit_pct` (0 to 100), `reason` | The credit a person decided |
| `close` | CEO | none | Case → `complete` once the guarantee period has ended (409 `guarantee_not_ended` before) |

An RSO may read the view for a case assigned to them and has no buttons.
`PUT /api/admin/task` with `status: 'completed'` on the invoice task answers
409 `au_task_needs_its_action`: it is finished by "Mark invoice sent".

### Confirm commenced, step by step

1. Checks: an active placement row; the date is a real day, **not after today
   on the practice's own clock** (`auTimezone.zoneForAuState(practice.location_state)`,
   Sydney when unknown) and not before the day the placement was recorded;
   sessions a week as a number (asked for unless on file; "not known yet" is
   allowed and leaves the fee unknown); the pre-start checklist complete
   (`auPrestartComplete`) **or** `override: true` with a reason of at least 10
   characters, which goes on the timeline and in the audit row.
2. Writes the placement with a compare-and-set (`commenced_at=is.null`), so two
   people pressing it produce one commencement: the date and who, the fee
   facts, `invoice_due_at`, `guarantee_ends_at`, the numeric sessions.
3. Tasks, one of each per placement (`ensureTask`: see "The idempotency
   rule" below): **one `invoice_due`** (CEO), **three `guarantee_checkin`**
   dated weeks 4, 8, 12 (consultant), and the first-week check-in (a `manual`
   task, consultant). The reminders from before the start (start date reached,
   notice, pre-start at risk) close.
4. Stage: `prestart → commenced`, and `→ guarantee` at once if the first week
   is already over.
5. Sends nothing. The same request again changes nothing and creates nothing;
   a different date is refused (409 `already_commenced`).

Every WP-13 task carries `metadata.lifecycle_kind` (`auLifecycle.KIND`),
`placement_key`, `owner`, `what_to_do`, `done_when`, and `mark` where there is
more than one (`w4`, `m6`). Lifecycle reminders are `manual` tasks with
`source_trigger: 'au_lifecycle'`. **`followup` is deliberately not used**: the
`reconcile-followups` job hands those to an AI check that closes or escalates
them. `AU_CALL_STAGES` was left as it is: the check-ins are tasks, not booked
calls.

### The calendar-date rule

**Read this before comparing, adding to or displaying any date in this area.**

1. **These are calendar dates, not instants:** the commencement day, the last
   working day, the invoice date and its due date, the guarantee end, a
   check-in day, the planned start date. Each is a `YYYY-MM-DD` value with no
   time and no zone (a `date` column; a string in code). They are the practice's
   own days: "started on Monday 1 February" means Monday there.
2. **"Today" is today's calendar date at the practice.** One function turns an
   instant into a date: `auLifecycle.localDay(nowMs, zone)`, with the zone from
   the practice's state (`auTimezone.zoneForAuState(practice.location_state)`,
   WP-10's table). **Fallback, always the same:** no practice on the placement,
   no state on the practice, or a state that is not Australian →
   `auLifecycle.FALLBACK_ZONE`, `Australia/Sydney`. Lists that span practices
   (the exports, `auPlacementCommercialSummary`) judge each row on its own
   practice's date (`auCommencement.practiceDays`).
3. **Days between two dates are counted on the dates** (`fees.daysBetween`,
   `fees.addDays`, `fees.addMonths`: midnight UTC of each date, which no zone
   or daylight-saving change can touch). Never a difference of two instants
   divided by 24 hours: fifty 24-hour steps back from 00:37 on 22 November in
   Sydney land on 2 October, not 3 October, because the clocks went forward in
   between.
4. **Never** `new Date('YYYY-MM-DD')`, `toISOString().slice(0, 10)` or
   `Date.now()` to get or compare one of these dates. `lib/au-placement-fees.js`
   reads no clock at all: "today" (`asOf`) is passed in, and without it an
   unpaid invoice is "not known", never judged against the server's day.
5. **Elapsed time since an instant** (how long ago a placement was recorded) is
   also counted in calendar days at the practice: the date the instant fell on
   there, then rule 3.

**The daily job.** It runs at 20:30 UTC, which is 07:30 (daylight time) or
06:30 in the eastern states, 06:00 or 07:00 in Adelaide, 06:30 in Brisbane,
06:00 in Darwin and 04:30 in Perth: **the next calendar day in every Australian
zone, on every day of the year** (a test checks 400 days). So one run sees the
same date for every practice: the run of Saturday 20:30 UTC is "Sunday" for
all of them. On that run a guarantee period that ended on Saturday is closed
(the period includes its last day), a start date of Sunday is "reached", a
commencement of the previous Sunday gets its week-1 check-in, and an invoice
dated the Saturday before last (payable for seven days, to this Saturday) is
overdue. One that falls a day later waits for the next run. If the job ever
runs at another hour it still judges each practice on its own date.

**Perth and Sydney on the boundary day.** For two hours every evening (three
in summer: 13:00 to 16:00 UTC, which is midnight to 03:00 in Sydney and 21:00
to midnight in Perth) the two are on different dates. In that window, for the
same dates on file:

| | Sydney practice (already tomorrow) | Perth practice (still today) |
| --- | --- | --- |
| "Confirm commenced" with tomorrow's date | accepted | refused: "that date is in the future at the practice" |
| "Doctor left" with tomorrow as the last working day | accepted | refused |
| "Close case" when the guarantee period's last day is today | allowed | refused until Perth's midnight |
| An invoice whose seventh day is today, not paid | shown as overdue; an exit recorded now is "forfeited" | still "sent"; an exit recorded now leaves the credit for the CEO to decide |
| Days left in the guarantee period | one fewer | one more |

Each practice's own answer is the same whoever asks and wherever they sit: a
staff member in Sydney recording an exit for a Perth practice gets Perth's
day. Nothing depends on the browser's or the server's time zone.

**In tests.** No WP-13 test reads the real clock: `pinWp13Clock(vi)`
(`tests/helpers/au-wp13-clock.js`) fakes `Date` for the whole file (the server
runs in the test process, so its clock moves too), and gives `dayAt(n)` as a
calendar date. `WP13_TEST_NOW=<ISO instant>` re-runs the same files at any
moment. `tests/au-wp13-calendar-days.test.js` asks the commencement, early-exit
and close-case questions at fifteen instants (either side of midnight in UTC,
Sydney and Perth, and of both daylight-saving changes) for a practice in every
zone and requires identical calendar answers.

### The idempotency rule for everything a placement derives

**Read this before adding a task, a reminder or a multi-step write to this
area.** Two people press the same button at the same moment; the daily job
runs while a person is acting; two runs of the job overlap; a request dies
half-way. Each of those must leave exactly one of everything.

| What | What makes it once | Where |
| --- | --- | --- |
| **Every WP-13 task** (invoice, check-ins, first-week, every lifecycle reminder, "replacement or credit") | **The database.** Partial unique index `uniq_au_lifecycle_task` on `registration_tasks (case_id, metadata->>'placement_key', metadata->>'lifecycle_kind', coalesce(metadata->>'mark',''))`, for rows that have a `lifecycle_kind` and are not `undone`. `ensureTask` reads, inserts, and treats the refused insert (PostgREST 409, SQLSTATE 23505) as "already there". No ledger claim, no waiting, nothing to take over. | `lib/au-commencement.js` `ensureTask`; `server.js` `_auInsertLifecycleTask`; the WP-13 migration |
| **A placement's commercial columns** (commencement, correction, undo, invoice sent / paid and their "clear", early exit, credit decision) | **Compare-and-set**: the `PATCH` filters on the value this request read (`commenced_at=is.null`, `ended_at=is.null`, `invoice_sent_at=is.null`, `credit_pct=is.null`, or `=eq.<what it read>`). Only the request whose write returns a row does the follow-on work (tasks cancelled, timeline line). The other answers `already` / `unchanged` when the stored result is the one it asked for, else 409. | each action in `lib/au-commencement.js` |
| **A stage move** | Compare-and-set inside `advanceAuCaseStage` (WP-03). Timeline lines that describe a move are written only by the call that moved it. | `server.js` |
| **A reminder message** (N18, N19, N20) | One **owner**: `sendOnce` claims `au_lc:<kind>:<placement>:<mark>` in the once-ever ledger (channel `lifecycle`; atomic through `gp_nudge_log_unique`), sends every part and writes the one timeline line. The claim is handed back if the doctor's email did not go, so the next run tries again; each part (email, bell, practice email, WhatsApp) still has its own ledger key underneath, so a part never goes twice. | `lib/au-commencement.js` `sendOnce` |
| **The provider-number escalation** | A ledger claim (same key shape) before the task is touched. | the daily job |

**Dying half-way.** Nothing has to be cleaned up, because nothing is claimed
ahead of the task it stands for. A commencement whose stamp is on the
placement but whose tasks or stage move are missing is completed by whoever
looks next: a second press of "Confirm commenced" (the "already" path
re-ensures the five tasks and the stage), and the daily job, which while the
guarantee period is running checks every commenced placement for its five
tasks and raises what is missing (`derived_tasks_repaired` in the job's
result). Both are safe to run at once.

**Why not the WP-11 pattern.** `_auEnsurePlacementTask` (pre-start tasks) reads,
claims `au_task:<type>:<placement>` in the ledger, and, when the claim is held
by someone else and no task has appeared after 250 ms, **takes the claim
over** and inserts. If the first request's insert is merely slow (more than
250 ms to reach the database), both insert. WP-13 used it at first; the lead's
review caught a duplicate check-in, and a probe showed 6 to 9 tasks where 5
were due once inserts were slowed, even with the ledger's unique index
enforced. WP-13 no longer calls it. **It is still how the WP-11 pre-start
tasks are created** (two overlapping placement passes with a slow insert can
duplicate a pre-start task): a fix for that belongs to WP-11's code and would
be the same index idea keyed on `task_type` + `placement_key`.

**The index and the columns are one migration file**, so they are never
applied apart. On a database with the columns but without the index the
actions still work and the read-then-insert is simply not atomic.

**In tests.** The database stub does not enforce any unique index unless
asked: boot it with `emulator: { unique: PRODUCTION_UNIQUE_RULES }`
(`tests/helpers/au-supabase-emulator.js`; the ledger's index and this one).
`emu.jitterMs` delays every answer by a random amount and `emu.hold =
(request) => ms` keeps a request in flight before the database sees it: use
both, in a loop, for anything that can overlap
(`tests/au-wp13-concurrency.test.js`).

### Stages after the start (decided here)

| Stage | When |
| --- | --- |
| `commenced` | Confirm commenced. **Not momentary: it lasts the doctor's first week.** |
| `guarantee` | The day of the week-1 check-in (the daily job), or at once when commencement is confirmed more than 7 days late. |
| `complete` | The day **after** `guarantee_ends_at` (the period includes its last day): the daily job, or the CEO's "Close case". Also at once on an early exit. |

The guarantee **period** always runs from `commenced_at`
(`placements.guarantee_ends_at`): the stage is what people are shown, never
what a date is worked out from.

### The undo rule

The ladder still only goes forward for everything else. **One** backward move
exists: `advanceAuCaseStage(caseId, 'prestart', actor, { undoCommencement:
true, reason })`, from `commenced` or `guarantee` only, written to the timeline
as `Stage returned to prestart (commencement recorded in error)` with
`metadata.correction`. Only `auCommencement.undoCommencement` (CEO, reason
required) passes that flag, after it has cleared the commencement columns and
cancelled the derived tasks (marked `metadata.undone`, which takes them out
of the unique index so a later, correct commencement makes a fresh set). Refused when
it would lose something real: an invoice recorded as sent (clear that record
first), a placement that has ended, a case already `complete`. Messages
already sent (N18 / N19) are not sent again for the same placement.
**Do not pass `undoCommencement` from anywhere else.**

### Early exit and the credit (commercial issue 5)

`guaranteeCreditFor({ commencedAt, lastWorkingDay, reason, invoiceSentAt,
invoicePaidAt, conditionsConfirmed, asOf })` → `{ creditPct, known, reason,
daysWorked, band, scheduleBandPct, forfeited, needsDecision }`. Sources:
clause 7 (`agreement-2026.html:589-640`) and clause 6.5 (`:548-551`).

| Situation | Result |
| --- | --- |
| Last working day up to 4 weeks / 4 to 8 / 8 to 12 after commencement, the doctor resigned or was let go for performance, the invoice paid within 7 days of its date, staff confirm the other clause 7.2 conditions | 80 / 50 / 35 |
| The placement's invoice paid late, or unpaid past its 7 days | 0, `forfeited_invoice_overdue` |
| Staff say the clause 7.2 conditions were not met | 0, `conditions_not_met` |
| Last working day after the 12 weeks | 0, `outside_guarantee_period` |
| **Anything not knowable from what is on file:** no invoice recorded as sent; sent, not yet paid, not yet due; the other conditions not confirmed; a reason on the practice's side (clause 7.2(i) excludes some, clause 7.3 leaves any credit to GP Link's discretion); a reason not recorded; a last working day exactly 4, 8 or 12 weeks after commencement (the schedule's wording does not settle those edges) | **`creditPct: null`**, never a guess |

The action records `ended_at`, `end_reason`, `credit_pct` (or NULL) and
`status = 'ended'`, cancels the check-ins still to come, raises **one**
`replacement_or_credit` task for the CEO (titled "Decide the guarantee
credit, then replacement or credit" when the credit is NULL), and completes
the case. WP-08's re-entry rule then lets the doctor apply again (it reads
`ended_at`). Nothing is sent to the doctor or the practice.

**Known limit, for a later package.** The Australian ladder has no way back to
`placement`, so a doctor who is placed a **second** time keeps a case at
`complete`: the placement, its tasks and the commercial tracking all work off
the new placement row, but the stage does not restart, the pre-start pass
(which reads `stage = prestart`) does not see the case, and "Confirm
commenced" cannot move the stage. Restarting the ladder for a re-entering
doctor is a decision that belongs with the re-entry work.

### The daily job (COM-40)

`runAuLifecycleSweep(nowMs)` (`server.js`, on `__testUtils`), called once a day
from `/api/cron/sla-sweep` (switch on only). It now also makes the two calls
that job used to make itself: `runAuAhpraRecheckSweep` (WP-06) and
`runAuPrestartSweep` (WP-11); their results keep their response keys. The
table of reminders is in `scheduled-jobs.md`. Rules:

- Doctors on an Australian pathway only: a row whose doctor does not read as
  Australian is skipped before anything else about it is read.
- **Once each**, by the idempotency rule above: a reminder **task** is unique
  in the database (`uniq_au_lifecycle_task`); a reminder **message** has one
  owning run (`sendOnce`, key `au_lc:<kind>:<placement key>[:<mark>]` in
  `gp_nudge_log`, channel `lifecycle`) and each of its parts its own ledger key
  (`au_n18_…`, `au_n19_checkin_w4_…`, `au_n20_…`) through
  `_auSendDoctorMessage` / `_auSendPracticeMessage`. The job also completes a
  commencement whose tasks are missing.
- **Ageing** is from `auSweeps.auCaseAgeAnchor(caseRow, placementRow)` (ADM-04:
  the placement milestone, never the doctor's activity), counted in calendar
  days at the practice (not `auCaseAgeDays`, which counts elapsed 24-hour
  periods).
- A day is the **practice's** calendar day (the calendar-date rule above).
- A message is not sent long after its moment (`MESSAGE_LATE_DAYS`, 14;
  a check-in is dropped once the next is due). The staff tasks still exist.
- **Quiet hours (WP-16, section 28):** the three messages (N18, N19, N20) are
  only sent between 08:00 and 20:00 on the practice's clock. The host job runs
  at 20:30 UTC, early morning in Australia, so there they are deferred (nothing
  sent, nothing claimed; the run fires `deferred_quiet_hours`) and they go on
  the in-hours run, `runAuLifecycleInHoursPass`, hosted by the hourly
  `onboarding-nudge` cron at 00:00 and 01:00 UTC. Tasks, stage moves and
  repairs are never held.

### Messages

| | To | Channels | When | Once per |
| --- | --- | --- | --- | --- |
| N18 "How was your first week?" | doctor; practice | doctor: email, bell, WhatsApp only through the approved Australian template `commencement_checkin`; practice: email, WhatsApp only through `commencement_checkin_practice` (neither is approved: skipped, reason logged) | 7 days after commencement | placement |
| N19 "Checking in: N weeks" | doctor; practice | email (+ bell for the doctor) | weeks 4, 8, 12 | placement and week |
| N20 "Twelve weeks in: thank you" | doctor | email, bell | the day after the guarantee period ends | placement |

**Nothing commercial ever reaches the doctor**: no fee, invoice, credit,
percentage, and not the word "guarantee" (their stage label for that period is
"Settling in"). The practice is told only what the agreement says (a 12-week
guarantee period, clause 7), with no figure. N20 offers no reward. Tests scan
every builder and every email the walk sends.

### What the doctor sees

`GET /api/gp/au-prestart` gained `started`, `startedOn`, and, when the
placement has ended, `placementEnded` + `endedPracticeName` (with no items).
`gpApp.buildPrestartChecklist({ ..., commencedAt })`: the `start_date` item
becomes "You have started" (still the `#start-date` anchor), and a notice item
the doctor never filled in reads as done. `js/au-prestart.js?v=20261121b`
draws the "You have started" card on the pre-start page and Home, and one
plain card for an ended placement (no reason, a way back to roles). The
"position secured" slide deck is not shown to a doctor who has already started
(`ctx.auStarted` in `js/gp-walkthrough-shell.js?v=20261122a`).

### What staff see

`js/au-commencement.js?v=20261121a` is **fetched the first time an Australian
case is opened** and mounted (a) in the CEO dashboard's candidate profile, in
the Australian block only (`auMountCommencement` in
`js/ceo-ats-candidates.js?v=20261121d`), and (b) on the admin case page for a
case whose own pathway is Australian or whose stage is Australian-only
(`auCaseLooksAustralian` in `pages/admin.html`; no such case can exist with
the switch off). Neither page has a script tag for it, so nothing extra is
loaded for anyone else. The card draws only what the server's view says,
including which buttons (`can`).

### Exports (ADM-30)

`GET /api/admin/export?entity=placements|gps&format=csv` (CEO only, as before).
Switch on: today's columns first, unchanged, then
`auLifecycle.PLACEMENT_EXPORT_COLUMNS` / `GP_EXPORT_COLUMNS` (pathway, basis,
sessions, fee tier and amount, agreement variant, actual commencement, invoice
due / sent / reference / paid, guarantee end, ended, end reason, credit).
Switch off: the loaders are called exactly as before and the bytes are
today's. `tests/admin-export.test.js` now states the switch explicitly.

### Hooks for later packages

| Package | What to do |
| --- | --- |
| **WP-14 (segment B)** | Decision 3 stands: a segment B doctor is `basis: australia`, so the same four fees apply. Nothing here branches on segment. |
| **WP-16 (quiet hours)** | **Done** (section 28): `quietAllows(practice, item, userId)` in `runLifecycleSweep` gates N18, N19 and N20 on the practice's clock, and the job has a second, in-hours run. |
| **WP-17 (copy; N15, N16)** | The five builders in `lib/au-placement-messages.js` (`buildCommencementCheckinGpMessage`, `…PracticeMessage`, `buildWeekCheckinGpMessage`, `…PracticeMessage`, `buildReferralAskMessage`). Keep the two rules above; the tests enforce them. N15 / N16 are not sent by WP-13. The proposed WhatsApp wording for N18 is in `whatsapp-templates.md`. |
| **WP-26 (dashboards)** | The card is plain (one definition list, one task list, inline forms). The admin page still draws the overseas stepper under it for an Australian case. The Ops Queue shows the WP-13 tasks through `auTaskMeta` (`what_to_do`, `owner`); the invoice task there has a generic "Mark Complete" that the server answers with 409 and a plain message: give it a "Mark invoice sent" button instead. "Doctor left during the guarantee" stays offered after the period has ended (the server then records no credit). The doctor's pre-start page after commencement still lists documents never uploaded as "To do". |
| **WP-27 (metrics)** | `auPlacementCommercialSummary(nowMs?)` (`server.js`, on `__testUtils`) → `{ ok, today, invoicesDue[], inGuarantee[], guaranteeEndingSoon[], counts: { invoicesDue, invoicesOverdue, inGuarantee, guaranteeEndingSoon } }`; each item: `placement_id, application_id, user_id, practice_name, commenced_at, guarantee_ends_at, guarantee_days_left, invoice (due / sent / overdue), invoice_due_at, invoice_sent_at, fee_tier, fee_amount_ex_gst`. Switch off: empty, nothing queried. No tile was built. `lib/ceo-review-queue.js` was not touched: the review items are yours. |

Tests: `tests/au-wp13-fees-lib.test.js`, `tests/au-wp13-lifecycle-lib.test.js`,
`tests/au-wp13-server.test.js`, `tests/au-wp13-concurrency.test.js` (overlapping
requests, in loops), `tests/au-wp13-calendar-days.test.js` (the calendar-date
rule, at a table of instants and zones), `tests/au-wp13-ui.test.js`, the "WP-13 flows"
case in `tests/au-wp02-switch-off-no-new-queries.test.js`, and the switch
cases in `tests/admin-export.test.js`. To pin "today" for the staff actions:
`__testUtils.__setAuCommencementClockForTest(ms)` (the daily job takes its
clock as an argument).

**Cache-busters moved:** `ceo-ats-candidates.js` and `ceo-ats.css` 20261121d,
`au-prestart.js` 20261121b, `gp-walkthrough-shell.js` 20261121c,
`au-commencement.js` 20261121a (new); `sw.js` VERSION 20261121e.

---

## 26. Segment B: visa transfer, supervision, AHPRA mail (WP-14)

Written by WP-14. **Read this before touching the visa module, a job that
handles supervised-practice paperwork, AHPRA mail, the banned-word list, or
anything a segment B doctor could be shown or sent.**

**In one paragraph.** Segment B (`au_restricted`) is a doctor already in
Australia whose registration is supervised, whose right to work is tied to a
sponsoring employer, or who is under the 19AB moratorium. It is **built, not
launched** (owner decision 1): the doctor is still held on the "our team will
confirm your details" screen (`shouldHoldSelfService`), so everything here is
staff machinery. The regulatory rules behind it are **not confirmed** (owner
decision 2), so nothing is decided by a rule alone: a placement raises staff
**decision** tasks, and a visa case, a message or a registration record exists
only after a person confirms. A segment A doctor (`au_vr`, citizen or
permanent resident, not supervised) gets none of it. With the switch off none
of it is reached and nothing is queried. WP-14 adds seven columns to
`visa_applications` and nothing else to the database.

### Where things live

| File | What |
| --- | --- |
| `lib/au-segment-b.js` (pure) | **The rules, one function each:** `visaStageFor`, `supervisedSweepVerdict`, `ahpraMailRouteFor`; the task builders; the staff input validators; `doctorTransferView`. The unconfirmed regulatory assumptions are listed at the top of the file. |
| `server.js`, search "WP-14" | The reads and writes: `auVisaStageForUser`, `auEnsureSegmentBPlacementTasks`, `auDecideVisaTransfer`, `auRecordSegmentBAhpraOutcome`, `auComplete19abCheck`, `auSendSegmentBN21`, `auSegmentBStaffView`, `auSupervisedSweepVerdict`, `auFileAhpraMailForAuDoctor`. All on `__testUtils`. |
| `lib/au-placement-messages.js` | N21 (doctor and practice), and the supervised-practice reminder to a practice. |
| `lib/migration-agent-reply.js` | The "nomination transfer" twins of the five migration-agent builders. |
| `lib/registration-granted-emails.js` | `buildSegmentBPracticeOutcomeEmail` (the two visa variants of the practice draft). |
| `js/au-segment-b.js` | The staff card, `GPAuSegmentB.mount(el, { caseId, onChange })`. |
| `pages/visa-transfer-au.html` | The doctor's transfer page. |

### The unconfirmed regulatory assumptions (each lives in ONE place)

| # | Assumption | Lives in | What happens when unknown |
| --- | --- | --- | --- |
| R1 | A visa tied to a sponsoring employer needs a "transfer of nomination" when the doctor changes employer. | `visaStageFor` (`lib/au-segment-b.js`) | A staff decision task. Never a case. |
| R2 | A citizen or permanent resident never has a visa step. | `visaStageFor` | (not "unknown": a recorded fact) |
| R3 | Limited, provisional or supervised registration needs new supervision paperwork lodged for a new practice. | `supervisionFacts` (`lib/placement-hooks.js`, WP-11), read through `supervisedSweepVerdict` | WP-11's placement review task; the supervised-practice jobs hold. |
| R4 | The 19AB moratorium limits a doctor to DPA locations until staff confirm it does not apply. | `computeDpaRestricted` (`lib/candidate-pathway.js`, WP-02) | Restricted. |
| R5 | What Ahpra requires for a change of practice (which forms, whether Section G applies). | Not encoded. The tasks and messages say what GP Link needs from the practice and the doctor, never what the regulator's process is. | n/a |
| R6 | Whether a doctor may start before a transfer is approved. | Not encoded. The doctor's page and N21 say "do not start until we confirm, unless the migration agent has told you in writing". | n/a |

Correct a rule in its one function. Do not add a second test of the same fact.

### The visa stage (APP-29, ADM-22)

`visaStageFor(pathwayResult, credentials) → { mode, reason }`; server:
`auVisaStageForUser(userId)` (switch off: `overseas`, nothing queried).

| Doctor | `mode` | What exists |
| --- | --- | --- |
| Overseas (nothing recorded, switch off, migration not applied) | `overseas` | Today's visa module, unchanged. |
| **Any Australian pathway, citizen or permanent resident** | `none` | **Nothing: no case, no task, no page, no bell item.** |
| Segments A and C, whatever is on file | `none` | Nothing. |
| B, `work_rights = 'visa'` and `visa_sponsor_tied = true` | `transfer` | A staff decision; a transfer case once confirmed. |
| B, on a visa that is not employer-tied | `none` | Nothing. |
| B, right to work or the sponsor tie not on file | `unknown` | A staff decision. Nothing shown. |
| Pathway or credentials unreadable | `hold` | Nothing this time. |

Enforced on the server, at every site:

| Site | For `none` / `unknown` / `hold` |
| --- | --- |
| `POST /api/visa/update` creating a case (`auVisaCaseCreationBlock`) | 409 `au_no_visa_stage` (or `au_use_transfer_decision` for a sponsor-tied B doctor; 503 on `hold`). Audited as `admin_visa_case_refused_au_pathway`. |
| The doctor-facing visa API (`AU_GP_VISA_API_ROUTES`: status, documents, timeline, updates, dependants, questionnaire) | 404 `au_pathway` for **every** doctor on an Australian pathway (a transfer has its own route). |
| `processVisaTaskAutomation` | Returns before creating a task. |
| `pushVisaNotificationToOwner` | `visaBellAllowed`: never for A or C; for a sponsor-tied B doctor only once segment B is launched. |
| `handleAhpraRegistrationGranted` | Still does nothing for any Australian pathway (WP-04), and now says where a segment B outcome is recorded. |
| `/pages/visa` | 302 to `/pages/index`, except the one doctor below. |

**A new place that opens a visa case, a visa task or a visa message must ask
`auVisaStageForUser` first.**

### The nomination-transfer case

`visa_applications.case_type = 'nomination_transfer'` (NULL = today's fresh
sponsored application). Migration
`20261121120000_au_gp_wp14_visa_transfer.sql`, applied to the local test
database only.

| New column | Meaning |
| --- | --- |
| `case_type` | `new_application` / `nomination_transfer` (CHECK); only the second is written |
| `current_sponsor_name` | the employer the visa is tied to today |
| `current_visa_expiry` (date), `current_visa_subclass` | the visa the doctor holds |
| `transfer_placement_key` | the placement it is for (the application id) |
| `transfer_decided_by`, `transfer_decided_at` | the staff member who confirmed |

**Reused, not duplicated:** `stage` (the live CHECK: `nomination, lodgement,
processing, granted, refused`, read as being prepared / lodged / being
assessed / approved / not approved), `sponsor_name` and `sponsor_contact` (the
NEW employer), `grant_date` (the day the new nomination was approved),
`reference_number`, `notes`. `visa_subclass` is left NULL: it is the subclass
of a visa being applied for. Guard names for switch-off tests:
`WP14_NEW_COLUMN_NAMES`, `WP14_NEW_NAMES`, `wp14NewNameViolation(request)` in
`tests/helpers/au-fixtures.js`.

**How it comes to exist.** Never automatically.

1. A placement is recorded for a segment B doctor. Step 7b of
   `auRunPlacementHooks` (`auEnsureSegmentBPlacementTasks`) raises **one**
   `visa_stage` task, "Visa: confirm whether a nomination transfer is needed
   for the new employer" (worded "confirm this doctor's right to work" when
   the facts are not on file). Nothing else.
2. A person chooses on the Segment B card: **Not needed** (a reason is
   required; the task closes; nothing is created) or **Confirm: transfer
   needed** with the current sponsor and the visa expiry.
3. `auDecideVisaTransfer` then records those facts on `gp_credentials` as
   staff-confirmed, opens one transfer case, and raises its four tasks,
   reusing the existing visa task types: `sponsor` (the new employer
   confirms), `migration_agent` (brief the agent), `visa_doc` (file the
   current grant notice; closes when staff file `au_immigration_grant_notice`),
   `visa_stage` (track it; closes on "Nomination approved").

Nothing is sent to the doctor or the practice at any step. A "Mark complete"
on the decision, the supervision task, the tracking task or the grant-notice
task answers 409 `au_task_needs_its_action`.

**Once only.** The tasks use WP-13's database rule (section 25): each carries
`metadata.lifecycle_kind` (`auSegmentB.KIND`), `placement_key` and `mark`, so
the index `uniq_au_lifecycle_task` makes them one each. The case has its own
partial unique index, `uniq_visa_nomination_transfer (user_id,
transfer_placement_key) where case_type = 'nomination_transfer'`: two people
confirming at once produce one case (the second insert is refused and the
first is read back), and a request that died half-way is finished by pressing
confirm again. None of the task types is one the WP-13 commencement card
reads, so they do not appear in the commercial view. In tests boot with
`emulator: { unique: PRODUCTION_UNIQUE_RULES }` (it now carries this index).

### The doctor's transfer page

Served **at `/pages/visa`** (file `pages/visa-transfer-au.html`,
`private, no-store`) to one kind of doctor only: `visaStageFor` says
`transfer` **and** a transfer case exists (`auDoctorTransferPageView`).
Everyone else on an Australian pathway is still redirected. It shows a
transfer (where it is up to, the current sponsor, the new employer, the
expiry) and no fresh-application flow: nothing to lodge, no passports, no
dependants, no questionnaire. `GET /api/gp/au-visa-transfer` → `{ ok,
transfer }`, 404 for everyone else. The page does **not** load
`js/au-localise.js` (it would remove the sentences the page exists to show).
The app shell still remaps the visa address for an Australian doctor
(`isOtherJourneyRoute`), so today the page is reached by address or by staff
"View as GP": a nav entry is launch work.

### The stage decision for a supervised segment B doctor

`auPlacementTargetStage(pathway)` answers **`prestart` for every Australian
pathway, including a supervised segment B doctor.** The matrix's "prestart or
ahpra" is settled as `prestart`: `ahpra` is not on the Australian ladder, an
Australian case never goes on the overseas ladder, and the supervision work is
a set of pre-start items. Those items are WP-11's pack tasks (filed under
`prestart`) plus one umbrella task per placement (checklist row 11):
`practice_pack`, "Supervision: lodge the new supervised practice arrangement
and file the Ahpra approval". It is **done when the Ahpra approval is filed**:
staff file it in the doctor's `au_supervision_plan` slot
(`auOnSegmentBDocumentFiled`; the doctor's own upload of a plan does not
count), or record it with "Record Ahpra outcome". It does not block "Confirm
commenced": `auPrestartComplete` is unchanged (launch work, below).

### The supervised-practice jobs: one predicate per doctor

WP-04 left every Australian doctor out of four jobs that only exist for
supervised-practice paperwork. WP-11 then created that paperwork for a
supervised segment B doctor. So those four no longer ask "is this doctor
Australian?" but:

```js
const verdict = await auSupervisedSweepVerdict(index, userId, auSegmentB.SWEEP_ROW.SPPA_PRACTICE_CHASE);
// or, with only a case id: auSupervisedSweepVerdictForCase(index, caseId, row)
if (verdict === 'exclude' || verdict === 'hold') continue;
const segmentB = verdict === 'include';   // use the Australian wording
```

| Verdict | Who | The job |
| --- | --- | --- |
| `overseas` | not an Australian doctor (and everyone with the switch off) | today's code, unchanged |
| `include` | segment B whose hooks row says `fire` (registration supervised) | works, with wording for a doctor already here changing practice |
| `exclude` | A, C, a B doctor known not to be supervised, a doctor part-way through Australian onboarding | leaves them alone |
| `hold` | B with no registration type on file; pathway or credentials unreadable | nothing this run |

The rule is `supervisedSweepVerdict(hooks, row)`: it asks `placementHooksFor`,
so the jobs and the matrix cannot drift. One hooks read per Australian doctor
per run (memoised on the index). **Every other job still uses
`excludesUser` / `excludesCase`**: the activity-based sweeps, the nudges and
the stage messages are wrong for a segment B doctor too. `scheduled-jobs.md`
has the job-by-job table.

### AHPRA mail (ADM-14, COM-10)

`auAhpraMailRouteForCase(caseRow)` → `overseas` / `segment_b` /
`plain_triage` (rule: `ahpraMailRouteFor`). Asked in the Gmail pipeline once
the email has been matched to a case, and again inside `_processAhpraEmail`.

| Route | What happens |
| --- | --- |
| `overseas` | Today's pipeline: the six-mode card, the request tray, the conflict letter, the grant flow. |
| `segment_b` | **One** `ahpra_correspondence` card on the case (`source_trigger: 'au_segment_b_ahpra_mail'`, `metadata.au_segment_b`), titled "confirm the outcome" when the letter reads like a decision. An inbound message row. Nothing else: the officer is not stored on the case, no conflict letter, no request tray, no AI call, no stage move, no visa case. |
| `plain_triage` (A, C, or unreadable on a case that looks Australian) | An ordinary `email_triage` card. Nothing else. |

The matcher's candidate list (`stage=in.(ahpra,career,…)`) now also carries
segment B doctors whose case is on the Australian ladder
(`auSegmentBAhpraMailCandidates`); A and C are deliberately not candidates, so
their unmatched mail stays unmatched for a person.

**Recording a decision.** `POST /api/admin/au/segment-b/ahpra-outcome`
(`auRecordSegmentBAhpraOutcome`): saves the registration type, supervision
level, expiry and conditions on `gp_credentials` as staff-confirmed; when
approved, closes the supervision task and the supervision pack tasks still
open (so no reminder goes to a practice for paperwork no longer needed); and
takes one of two visa variants: `transfer_of_nomination` (makes sure the
decision task exists; opens no case) or `no_visa_action`. It returns a
**draft** for the practice in the matching variant
(`buildSegmentBPracticeOutcomeEmail`). Nothing is sent (handover 2026-11-05,
section 2), and `registration_cases.ahpra_registration_*` is not written
(section 6: `gp_credentials` is the source of truth for an Australian
pathway).

### College mail (ADM-23)

`resolveEmailRouting` takes `auPathway: { isAu: true, stage }` (the server
passes it only for a matched email whose doctor is on an Australian pathway:
`auEmailRoutingPathwayFor`). For such a doctor RACGP and ACRRM mail is
`category: 'college'`, filed under the case's **own Australian stage**, and no
regulator or government email is filed under `amc`, `ahpra`, `visa` or `pbs`.
An overseas doctor's routing, and unmatched mail, are byte for byte what they
were.

### The migration-agent "transfer" variant

Each of the five builders in `lib/migration-agent-reply.js` hands over to a
transfer twin when, and only when, `params.caseType === 'nomination_transfer'`.
The server sets that from the card's own metadata (`visa_case_type`, written
only by `auDecideVisaTransfer`) through `_migrationAgentTransferParams`; for
every other card it adds nothing and the prompt is byte for byte what it was
(`tests/au-wp14-lib.test.js` compares with a snapshot taken from the commit
WP-14 started from). The transfer wording never says "registration has been
granted", "relocation", "new visa" or "passports", and tells the model to
state no legal requirement. `buildTransferPracticeRequestDraft` is the first
email to the new practice.

**Known limit.** The RSO card's send / reply-pickup automation for a
`migration_agent` task is keyed on `metadata.registration_granted` and
`metadata.outbound_email`, which only the overseas grant flow writes. A
transfer card is a plain task; staff copy the two drafts on the Segment B card
into the email composer. Wiring the card's automation for a transfer is launch
work.

### N21 and the banned-word exception

N21 (segment B flagged → the doctor and the practice: the 19AB result, what
supervision paperwork is needed, whether a transfer is in progress) is sent
**only** by `auSendSegmentBN21`, when a staff member ticks "I have checked each
outcome" and chooses the recipients. It cannot be sent while any part is
unconfirmed (`n21Ready`): no staff 19AB answer, a registration no person has
checked on the register, or an undecided visa decision. A given set of
outcomes goes to each recipient at most once. Email only: no bell, no
WhatsApp.

**The one named exception to AGENT-RULES section 4**
(`auDoctorText.SPONSOR_TIED_B_EXCEPTION`, `sponsorTiedVisaException`,
`violationsFor`; the practice twin is the second argument of
`careerIntro.auPracticeTextViolations`):

| | |
| --- | --- |
| Who | a doctor on `au_restricted` whose `gp_credentials` row says `work_rights = 'visa'` **and** `visa_sponsor_tied = true` |
| Where | message N21 (to the doctor, and to their practice) and the doctor's transfer page |
| What | the word "visa" only ("nomination" was never banned) |

Everywhere else, and for everyone else (segment A, segment C, a segment B
doctor who is a citizen or permanent resident, or whose sponsor tie is not a
confirmed "yes"), the full list applies. Every other banned word still applies
inside the exception. A context name alone unlocks nothing: the caller must
pass the doctor's own pathway and credentials. For a doctor outside the
exception N21 leaves the visa part out whole. **Do not widen it without the
lead's say-so.**

### The 19AB + DPA check (checklist row 2)

`POST /api/admin/au/segment-b/dpa-19ab { case_id, applies: 'yes' | 'no',
end_date?, note }` (`auComplete19abCheck`). It writes
`moratorium_19ab_confirmed_status` (and the end date) through
`upsertGpCredentials(..., { source: 'staff' })`: the same writer and columns as
`POST /api/admin/candidate/pathway`, which is exactly what
`computeDpaRestricted` and `roleEligibilityFor` read. Then it closes the open
`dpa_19ab_check` tasks on the case. No new rule. If the answer cannot be
saved, no task is closed and the doctor stays limited to DPA roles. The
exemption letter is filed in the `au_19ab_exemption_letter` slot (WP-07); the
card shows whether one is on file. Available for segments B and C.

### Staff routes

`GET /api/admin/au/segment-b?case_id=` and
`POST /api/admin/au/segment-b/<action>` `{ case_id, ... }`. Switch off: 404,
nothing read. Not an Australian pathway: 409. CEO and consultants: any
Australian doctor; an RSO: only a case assigned to them
(`ensureAuPathwayStaffAccess`). Every write is audit-logged (`admin_au_*`,
codes and dates only). A successful POST answers the result plus `view`.

| Action | Body | Does |
| --- | --- | --- |
| `visa-transfer/decision` | `decision: 'confirm' \| 'not_needed'`, `current_sponsor`, `visa_expiry`, `visa_subclass?`, `note` | above |
| `visa-transfer/update` | any of `current_sponsor`, `visa_expiry`, `visa_subclass`, `new_sponsor_contact`, `reference_number` | corrects the case (and the credentials) |
| `visa-transfer/nomination-approved` | `approved_on` | stage → `granted`; closes the tracking task |
| `ahpra-outcome` | `outcome`, `visa_action`, `registration_type?`, `supervision_level?`, `registration_expiry?`, `note`, `task_id?` | above |
| `dpa-19ab` | `applies`, `end_date?`, `note` | above |
| `n21-preview` | none | what would be sent, and what is missing |
| `n21-send` | `to: ['gp', 'practice']`, `confirm: true` | sends N21 |

The view carries `applies` (segment B), `moratorium`, `visa` (mode, decision,
transfer case, tasks, drafts), `supervision`, `placement`, `can`. For segments
A and C it carries only `moratorium`.

### What staff see

`js/au-segment-b.js?v=20261121a` is **fetched the first time an Australian
case is opened**, like the commencement card: in the CEO dashboard's candidate
profile (`auMountSegmentB` in `js/ceo-ats-candidates.js?v=20261121e`) and on
the admin case page (`auMountSegmentBCard` in `pages/admin.html`). Neither page
has a script tag for it. The card shows nothing for a segment A doctor with no
19AB check task. **Cache-busters moved:** `ceo-ats-candidates.js` and
`ceo-ats.css` 20261121e, `au-segment-b.js` 20261121a (new), `sw.js` VERSION
20261121f.

### What is automatic, and what a person confirms

| Automatic (staff-facing only) | A person confirms |
| --- | --- |
| The visa decision task, on placement | Whether a transfer is needed; the current sponsor and the expiry |
| The supervision umbrella task, on placement, when registration is supervised | The Ahpra outcome; filing the approval |
| The supervised-practice reminder to a practice (the existing chase, in segment B wording) | The 19AB result |
| A "supervision paperwork complete" line on the case | Sending N21 |
| A staff card for a regulator email | Everything the card asks |
| Closing a decision that is no longer needed (a citizen recorded later) | |

Nothing in the left column reaches the doctor. One thing reaches a practice
without a person choosing it at that moment: the reminder about a supervised
practice agreement a staff member already sent them.

### What launching segment B would still need

1. The owner or the RSO team confirms R1 to R6 in writing, and the wording
   above is corrected to match.
2. Add `au_restricted` to `LAUNCHED_AU_PATHWAYS` (`lib/candidate-pathway.js`):
   the hold lifts, and `visaBellAllowed` then lets a transfer's bell items
   through.
3. A way to reach the transfer page from the app (the shell's
   `isOtherJourneyRoute` remap; a card on the pre-start page).
4. Whether the supervision approval and the nomination approval must block
   "Confirm commenced" (`auPrestartComplete` does not look at them today).
5. The `migration_agent` card's send and reply automation for a transfer.
6. The SPPA-00 engine's own staff-sent emails and the generated form are the
   overseas ones (D8 lets staff use them for a supervised segment B doctor):
   review that wording and the form's answers for a doctor already in
   Australia.
7. WhatsApp templates for N21 if wanted (none exists; it is email only).
8. N11 already goes automatically to a segment B doctor on placement (WP-11,
   the matrix's "variant" row): decide whether that should wait for launch.

### Hooks for later packages

| Package | What to do |
| --- | --- |
| **WP-17 (copy)** | `buildSegmentBOutcomeGpMessage`, `buildSegmentBOutcomePracticeMessage`, `buildSupervisionPracticeReminder` (`lib/au-placement-messages.js`); `TRANSFER_STAGE_COPY` and `doctorTransferView` (`lib/au-segment-b.js`). Keep the exception as narrow as it is; the tests enforce it. |
| **WP-20 (prompts)** | The transfer prompt twins in `lib/migration-agent-reply.js` (`buildTransferReplyMessages`, `buildTransferNudgeMessages`). |
| **WP-26 (dashboards)** | The card is plain (definition lists, a task list, inline forms, drafts in a `<pre>`). The admin Ops Queue shows the WP-14 tasks through `auTaskMeta` with a generic "Mark Complete" that the server answers with 409 and a plain message: give them their real buttons. The `ahpra_correspondence` card for a segment B email is drawn by the overseas renderer (`renderOpsAhpraActionItem`), whose buttons are refused for an Australian case. `pages/admin-visa.html` lists a transfer case like any other and does not show the new columns. |
| **WP-27 (metrics)** | A transfer case sits in `visa_applications` with `case_type`; nothing counts them yet. |

Tests: `tests/au-wp14-lib.test.js`, `tests/au-wp14-segment-b-server.test.js`,
`tests/au-wp14-sweeps-mail-server.test.js`, the "WP-14 flows" case in
`tests/au-wp02-switch-off-no-new-queries.test.js`, and the overseas parity
snapshots `tests/fixtures/au-wp14-overseas-parity.snapshot.json` and `tests/fixtures/au-wp14-grant-parity.snapshot.json` (`tests/au-wp14-grant-parity.test.js`: an overseas final notice, on the real server)
(+ `tests/helpers/au-wp14-parity.js`).

---

## 27. Lead segment and the `/start` first question (WP-15)

Written by WP-15. **Read this before writing copy for a lead (WP-16), building
the Australian landing page (WP-21) or reporting leads to an ad platform
(WP-24).**

**In one paragraph.** With the switch on, the `/start` booking form first asks
"Are you currently registered with Ahpra?". "Yes" qualifies the doctor whatever
country they trained in, asks four quick follow-ups (state, vocational
registration, 19AB, right to work) and records a **segment** on the lead. "No"
is the form as it always was, with the same screening. The segment is the
doctor's own description: it drives copy, reporting, the time zone and the
Hazel block, and it is **never a pathway** (`candidate_pathway` is still set
only by onboarding or by staff). With the switch off the page, the payload, the
stored row, screening, the Meta webhook, the Leads tab and the owner alert are
what they were (`tests/au-wp15-overseas-parity.test.js` holds a snapshot taken
before the code changed).

### The lead fields (`site_enquiries.metadata.consult`, no column, no migration)

| Key | Values | Notes |
| --- | --- | --- |
| `segment` | `overseas`, `au_vr`, `au_restricted`, `au_non_vr`, `au_registrar`, `au_unknown` | `au_unknown`: Australian-segment, detail not known yet. Absent on every row stored before WP-15 and on a lead from a form that does not ask. |
| `ahpra_registered` | `true`, `false`, absent (not asked) | Their answer to the first question. |
| `location_country` | `au`, `uk`, `ie`, `nz`, `other`, absent | Where they are **now**. `consult.country` (and the `site_enquiries.state` column) is where they **trained**. |
| `state` | `NSW` … `NT`, absent | WP-10 validates it and uses it for the time zone. "Outside Australia at the moment" stores no state and `location_country: 'other'`. |
| `vr_status` | `yes`, `no`, `registrar`, `unsure` | |
| `restriction_19ab` | `yes`, `no`, `unsure` | |
| `visa_status` | `citizen_pr`, `temporary`, `unsure` | Right to work. The browser key is `rightToWork` (the page may not use the banned word). |
| `consent` | `{ wording_version, shown_at, ai_call: 'not_asked' }` | Which wording was under the button. `overseas_v0` = today's line; `au_a1_draft_2026_11` = the WP-25 draft for an Australian audience. A new wording gets a new key in `LEAD_CONSENT_VERSIONS`; never edit one in place. |
| `country_source: 'none'` | | An Ahpra-registered doctor left "where did you train" blank (it is optional for them): `consult.country` is `'other'` and the `state` column is null. |

Every value is checked against a fixed set (`auLead.readLeadFormAnswers`); a
value the form never offered is a 400 and nothing is stored. Rows are never
rewritten in bulk.

### `lib/au-lead.js` (additions)

| Helper | Contract |
| --- | --- |
| `isAuSegmentLead(lead)` | **The new rule.** A recorded `segment` starting `au_` → true; a recorded `overseas` → false; nothing recorded → the old test, `consult.country === 'au'`. Still does not look at the switch. Every site that asked this (Hazel, the message hold, the time zone) follows with no change. |
| `deriveLeadSegment({ ahpraRegistered, vrStatus, restriction19ab, visaStatus, country, auForm })` | **The one rule for a segment.** Pure, explicit answers only. **The phone is not an input** (COM-15). Order: "No" + trained in Australia → `au_unknown`; "No" → `overseas`; "Yes" + (19AB applies or temporary right to work) → `au_restricted`; registrar → `au_registrar`; not VR → `au_non_vr`; VR + 19AB no + citizen/PR → `au_vr`; any other "Yes" (a "not sure" or a gap) → `au_unknown`; not asked + Australian Meta form → `au_unknown`; not asked → `null` (record nothing). |
| `readLeadFormAnswers(body)` | `{ ok, asked, answers }` or `{ ok: false, error }`. `asked: false` when the body has no `ahpraRegistered` (an old cached page). |
| `leadFieldsFromAnswers(answers, { country, auForm, locationCountry, nowIso })`, `applyLeadFields(consult, fields)` | Builds and writes the keys above. A re-submission that says "No" removes Australian answers left by an earlier "Yes". |
| `leadSegmentFor(lead)` | **For WP-24 and anything that reports.** Always one of the six: the recorded segment; else `au_unknown` for an old Australian-trained row; else `overseas`. |
| `recordedLeadSegment(lead)` | `''` when nothing was recorded: use it when "they were never asked" must be told apart from "overseas". |
| `leadSegmentLabel(segment, short?)`, `leadAnswerLabels(lead)` | Staff-facing words (owner alert, Leads tab). Never show these to a doctor. |
| `metaFormSegmentConfig(env)`, `readMetaAuAnswers(map)` | Meta, below. |
| `LEAD_SEGMENTS`, `LEAD_VR_STATUSES`, `LEAD_19AB_ANSWERS`, `LEAD_VISA_STATUSES`, `LEAD_LOCATION_COUNTRIES`, `LEAD_STATE_OUTSIDE`, `LEAD_CONSENT_VERSIONS` | The fixed sets. `js/site-au-lead.js` mirrors the first four; `tests/au-wp15-start-page.test.js` keeps them in step. |

### Screening (`buildConsultLeadRow`, `server.js`)

`input.ahpraRegistered === true` is positive evidence and qualifies on its own
(unless they also said they are not a GP). It only **adds** a way to qualify:
`false` and absent leave the decline rule exactly as it was (a decline still
needs evidence: "not a GP", or a recognised country we do not serve). Two
things are new and both are narrower than they look:

- A lead from an **Australian Meta form** with no Ahpra answer is not declined
  on training country (it is evidence about a different fact). If nothing
  qualifies them they are `country_unknown`: the owner is told to look, and
  `/start` shows them the form, not the turndown.
- For that same lead, an answer we **did** read is never overridden by the
  phone rescue.

**The phone.** `segment` and `ahpra_registered` are never written from a phone
number. What remains is the old country rescue, untouched: a Meta answer we
could not read plus a served dial code qualifies the lead with
`country_inferred_from_phone`, and a `+61` number therefore gives
`country: 'au'`. With no segment recorded that row still reads as
Australian-segment through the fallback above. It is the restrictive direction
(Hazel does not ring, messages are held, the owner's alert says the answer
could not be read), and it never happens on the website form, where the country
comes from a fixed list.

### The form (`pages/site-start.html` + `js/site-au-lead.js?v=20261121a`)

- The page asks `GET /api/public/features`. Only when that says the switch is
  on does it load `js/site-au-lead.js` and mount the first question. A failure,
  the switch being off, or no answer in 2.5 seconds leaves today's form. The
  form is held back (the "Loading" line shows) until that is settled.
- `window.GPAuLeadForm.mount({ form, preset, onAnswer })` returns
  `{ answer(), isAu(), error(), extras(), setAnswer(v) }`. `extras()` is the
  set of body keys to add (`ahpraRegistered`, and for "Yes" `state`,
  `vrStatus`, `restriction19ab`, `rightToWork`, `consentVersion`).
- **WP-21 hook.** Mount the same module on the Australian landing page with
  `preset: 'au'`: the first question opens answered "Yes" (visible, and the
  doctor can change it). On `/start` the same thing happens with `?seg=au` on
  the address or `data-lead-segment="au"` on the `#book` section. The module
  expects the host form to have `#cfPhone`, `label[for="cfCountry"]` and
  `.book-consent` (all optional). The booking step (Calendly embed, the
  confirmed and turndown states) is still the inline script of
  `pages/site-start.html`; WP-21 either links to `/start?seg=au#book` or lifts
  that script into a file. The module does not submit anything itself.
- **Framing.** On "Yes" the page swaps the wording around the form for neutral
  Australian wording and hides the "Inside your free account" section and the
  Visa links (`AU_FRAMING` in the inline script, between `AU-FRAMING:START` and
  `AU-FRAMING:END`; `GPAuLeadForm.swapFraming(document, swaps, on)` does the
  swap and puts it back on "No"). A returning Australian-segment lead gets it
  too: the recognition answers carry `auSegment: true` (switch on only).
- **Wording rule.** All of `js/site-au-lead.js` (comments and names included)
  and every `text` / `html` value in `AU_FRAMING` are scanned for the
  AGENT-RULES section 4 words.
- **Consent.** The Australian branch shows the WP-25 draft A1 wording and the
  "use a personal email and mobile" hint. **No AI-call tick box is shown**, on
  either branch: Hazel never rings an Australian-segment lead, so asking
  permission for a call that cannot happen would mislead, and adding the tick
  to the overseas form would change who Hazel may ring (an owner decision with
  a legal question behind it). `consent.ai_call` is stored as `'not_asked'`.
- **The browser zone** (WP-10's `tz`) is now sent only with the switch on. With
  it off the payload is exactly the pre-build payload.
- A doctor who answered "Yes" is never routed to the turndown by the page,
  whatever the server answers.

### Meta lead forms

| Variable | Meaning |
| --- | --- |
| `FB_GP_LEAD_FORM_IDS` | Unchanged: forms whose leads are doctors. |
| `FB_AU_GP_LEAD_FORM_IDS` | **New.** Forms whose leads are Australian-segment. Not set anywhere today, and with it unset Meta handling is identical. |

- An Australian form is admitted to the doctor branch in **both** switch states
  (it must never fall through to the practice path); the segment and the
  Australian answers are read only with the switch on.
- With the switch on, an "Ahpra" question is read on **any** doctor form, so
  one combined form also works.
- A form id in both lists: treated as overseas, `console.error` with
  `CONFIGURATION ERROR` on every lead.
- Answers are read slug-flattened (`[^a-z0-9]+` → space), from the answer, by
  words in the question: `ahpra`; `which state` / `state or territory`;
  `vocationally registered` / `fracgp` / `facrrm`; `19ab` / `moratorium`;
  `right to work`; `where are you based` and similar. Contact fields are never
  read. The proposed form is `docs/au-gp/meta-au-lead-form.md`. **No real
  Australian Meta lead exists yet**: the test keys are the proposed wording
  slugged the way Meta slugs; replace them with a real stored row's keys when
  one arrives.

### Where the segment travels

| Place | What | Switch off |
| --- | --- | --- |
| The booking row | `scheduled_calls.notification_channels.lead = { segment, lead_id, state?, vr_status? }` (the JSON column that already holds the reminder markers; `auBookingLeadStamp(lead)`). Written when a booking is created from the public calendar and when an invited call is booked. `ensureLeadBookedCallAt` now returns the lead it found. | not written |
| Leads tab | `GET /api/ceo/leads` rows gain `segment`, `segment_label`, and for an Australian-segment lead `au_state`, `vr_status`, `tz_label` ("Perth"). `?seg=all\|au\|overseas\|uk\|ie\|nz\|other` filters; `segment_counts` and `seg` are in the answer. `js/ceo-ats-leads.js?v=20261121a` draws the chips only when `segment_counts` is present. The owner's own clock is still viewer-local. | no key, parameter ignored |
| Owner "New gp enquiry" email | For an Australian-segment lead: Segment, Ahpra registered, Australian state, VR status, 19AB, Right to work, Trained in. The old `State: <training country>` line is dropped for them only. | byte-identical |
| Owner WhatsApp page | `consultOwnerAlertSummary` adds `Segment · State · VR` to the free-text "answers" slot for an Australian-segment lead. The approved template wording is untouched. | unchanged |
| Onboarding | `GET /api/onboarding/au-prefill?lead=1`: a doctor whose email matches a lead who said "Yes" gets `{ ok, fromLead: true, segment, answers: { state, moratorium19ab, workRights } }` and the wizard starts in the Australian branch (`auAskOrStartFromLead` in `js/onboarding.js?v=20261121d`). Everyone else gets `{ ok: true, fromLead: false }` and the ordinary first question. Sets nothing. | 404 |
| CAPI / ads | **Not changed here.** WP-24: call `auLead.leadSegmentFor(row)`. |

### What WP-16 must know when writing copy

- Ask `isAuSegmentLead(lead)` for "Australian copy or not"; ask
  `leadSegmentFor(lead)` for which Australian copy.
- `au_unknown` is common and must read safely for **every** kind of Australian
  doctor: an old Australian-trained row, a Meta lead who answered only the
  first question, anyone who said "not sure". Write the `au_unknown` copy
  first; treat `au_vr` wording as the special case.
- `au_restricted`, `au_non_vr` and `au_registrar` are not launched segments
  (owner decision 1). Do not promise roles; do not use the banned words even
  though a restricted doctor's situation involves them.
- A segment says nothing about where they trained: an `au_vr` lead may have
  `country: 'uk'` or `'other'`. Never branch Australian copy on `country`.
- `location_country` can be `'other'` for an Ahpra-registered doctor who is
  abroad at the moment: use `localHourFor` (WP-10), never assume an Australian
  clock, and check `certain` before saying "your time".
- The hold you are replacing is `auMessagesHeld`; `auHazelBlocked` stays.
  (**Done in WP-16**: section 28. The hold has no call site left.)
- A lead who said "No" and trained in Australia is `au_unknown`, not overseas.

Tests: `tests/au-wp15-lead-segment-lib.test.js`, `tests/au-wp15-lead-server.test.js`,
`tests/au-wp15-booking-and-prefill.test.js`, `tests/au-wp15-start-page.test.js`,
`tests/au-wp15-overseas-parity.test.js` (+ `tests/helpers/au-wp15-parity.js`,
`tests/fixtures/au-wp15-overseas-parity.snapshot.json`), and the "WP-15 flows"
case in `tests/au-wp02-switch-off-no-new-queries.test.js`. Screenshots of the
local-stack walk: `docs/au-gp/screenshots/wp15/`.

---

## 28. Lead and consult copy, the go-live rule and quiet hours (WP-16)

Written by WP-16. **Read this before sending anything to a lead, sending
anything on a timer to an Australian doctor (WP-17), or reviewing WhatsApp
templates (WP-18).**

**In one paragraph.** An Australian-segment lead now gets real Australian
messages: a confidential conversation about a better-fitting practice (billing
mix, location, flexibility). The words live in one file. Two rules decide
whether a message goes: the **go-live rule** (a lead only enters a sequence if
the event that starts it happened after Australian messages went live, so
nobody from before gets a stale note) and **quiet hours** (a message that goes
because time has passed is only sent between 08:00 and 20:00 on the person's
own clock; outside that it waits, unmarked, for the next run). WhatsApp goes
only through an approved Australian template; none is approved, so today every
message is an email. WP-01's interim hold (`auMessagesHeld`) has no call site
left. With the switch off, and for every overseas lead, every message, send
time and marker is exactly what it was
(`tests/au-wp16-overseas-parity.test.js` holds a snapshot taken before the
code changed).

### Where things live

| File | What |
| --- | --- |
| `lib/au-lead-copy.js` | **The words.** `MESSAGES` (the table: every message, when, channel, which copy groups, how the two rules treat it), `plainEmail(id, group, ctx)`, `dripEmail(id, group, ctx)`, `messagePlan(id, segment)`, `segmentGroup(segment)`, `PROPOSED_WHATSAPP_TEMPLATES`, `CONFIDENTIALITY_LINE`. Pure. |
| `lib/au-lead-sends.js` | **The send rules.** `auSequenceAdmits({ anchorMs, liveFromMs })` (THE go-live rule), `anchorMsFor(id, lead)`, `quietModeFor(id, anchorMs, nowMs)`, the lead's own record (`withAuLog`, `describeAuLog`), `leadCopyState`. Pure. |
| `lib/au-quiet-hours.js` | **The gate.** `auQuietHoursAllow(leadOrProfile, nowMs, opts)`, `auQuietHoursAllowInZone(zone, nowMs)`, `allAustraliaWindowOpenedWithin`. Pure. |
| `lib/au-lead.js` | `auCopyApplies(lead, opts)`: switch on **and** Australian-segment. The question every former hold site asks. `auMessagesHeld` is retired (kept as a name only). `auHazelBlocked` is untouched. |
| `lib/au-whatsapp-templates.js` | Eleven `lead_*` rows (all `approved: false`) and `auLeadWhatsAppPlan(kind)`. |
| `server.js` | `auLeadCopyCtx(row)`, `auLeadCopyLiveFromMs({ create })`, `auLeadQuietGate(row, id, anchorMs)`, `auLeadLogWrite`, `auLeadWhatsAppSkipped`, `deliverAuConsultNudgeStep`, `sendAuBookingLinkEmail`, `auDoctorQuietHoursAllow(userId, nowMs)`, `runAuLifecycleInHoursPass(nowMs)`. |
| `docs/au-gp/au-lead-copy.md` | The copy deck for the owner: every message, when, to whom, the exact words. **Generated from the code**; a test fails if they differ. |

### The copy

Two wordings, chosen by `segmentGroup(leadSegmentFor(lead))`:

| Group | Segments | Rule |
| --- | --- | --- |
| `main` | `au_vr`, `au_unknown` | Written to be true for **any** Ahpra-registered doctor (it never says "as a VR GP"). The two segments read identical words. |
| `safe` | `au_restricted`, `au_non_vr`, `au_registrar`, and any Australian segment the table does not know | Not launched (owner decision 1). Promises nothing about roles: "we'll talk through what fits your registration". A message whose whole point is being matched to roles is **not sent** to this group (`MESSAGES[id].groups`): the step is recorded as skipped with `au_segment_not_launched`. |

Never branch Australian copy on `consult.country` (where they trained).

The existing builders take the Australian wording through one extra option,
and only when the caller passes it (the caller passes it only when
`auLeadCopyCtx(row)` is not null):

| Builder | Option | Message ids |
| --- | --- | --- |
| `consultNudgeCopy(seq, step, { au: { segment } })` | `au` | `n01_5m`, `n01_1h`, `n01_24h` |
| `buildBookerNudgeEmail(step, { au: { segment, whenText } })` | `au` | `n02_booked`, `n03_after_call`, `n03_week1`, `n03_week2`, `n03_week3` (returns `null` when not sent to that segment) |
| `buildConsultReminderEmail(window, { au: { segment } })` | `au` | `n02_reminder_day`, `n02_reminder_hour` |
| `noShowEmailCopy({ au: { segment } })` | `au` | `n02_noshow` |
| `sendConsultMagicLinkEmail` / `sendConsultGenericBookingLinkEmail` (`server.js`) | (branch inside) | `booking_link`, `booking_link_generic` |

Without the option every overseas string is byte-identical.

Rules every string keeps (`tests/au-wp16-copy-snapshot.test.js` scans every
message for every segment in seven time zones): none of the AGENT-RULES
section 4 words; no "move", "visa", "relocat" or "UK"; no `$`, no `%`; no
promise of a role or pay; the confidentiality line in its agreed wording
(`CONFIDENTIALITY_LINE`); "Ahpra"; nothing that only reads right at one time of
day (a note held overnight still makes sense at 8 am).

**Time labels.** `formatLeadCallTime(iso, zone, { cityLabel: true })` and
`formatLeadCallClock(...)` name the zone by its city for an Australian-segment
lead: "10:30 am (Perth time)", and "(London time)" for an Ahpra-registered
doctor who is abroad (never "UK time"). `auTimezone.zoneCityLabel(zone)` is the
label. Without the option the overseas labels are unchanged.

**The overseas day-7 email** ("The scary part, AHPRA, AMC, visa, is already
solved for you") is never sent to an Australian-segment lead. Its slot carries
the Australian `n03_week1` ("What happens after you create your account": the
five steps Booked, Account, Matched, Interview, Start date) for the main group
and nothing for the safe group.

### The message table

`auLeadCopy.MESSAGES` is the source; the copy deck prints it in full.

| Id | Report | Trigger | Channel today | Safe group | Quiet hours | Go-live measured from |
| --- | --- | --- | --- | --- | --- | --- |
| `booking_link` | N01 | Qualifies from a Meta lead form | email | careful wording | not held | not applied |
| `booking_link_generic` | N01 | Hazel's booking-link tool, no personal link (she never rings an Australian lead) | email | careful wording | not held | not applied |
| `n01_5m` | N01 | 5 minutes after qualifying, not booked | email (WhatsApp-only overseas; falls back to email, unless the booking-link email went in the last hour) | careful wording | held | qualified |
| `n01_1h` | N01 | 1 hour | email | careful wording | held | qualified |
| `n01_24h` | N01 | 24 hours | email | careful wording | held | qualified |
| `n02_booked` | N02 | Within 5 minutes of booking | email | careful wording | not held within 30 minutes of the booking, then held; never sent once the call time has passed | booked |
| `n02_reminder_day` | N02 | From 24 hours before the call | email | careful wording | not held | not applied |
| `n02_reminder_hour` | N02 | 70 to 30 minutes before | email | same words | not held | not applied |
| `n02_noshow` | N02 | 1 hour after a missed call | email | careful wording | held | the missed slot |
| `n03_after_call` | N03 | The attended call ends | email | careful wording | not held within 30 minutes, then held | attended |
| `n03_week1`, `n03_week2`, `n03_week3` | N03 | 7, 14, 21 days after the call | email | **not sent** | held | attended |

### The go-live rule (one place: `auLeadSends.auSequenceAdmits`)

WP-01's hold recorded nothing, so the elapsed-time logic would read every
Australian lead already in the database as "nothing sent, everything overdue".
The rule: **a lead only enters a sequence if the event that starts it happened
at or after the go-live instant.** Each message is measured from its own event
(the table above), so a lead who enquired before go-live and books after it
gets the booking messages, and never the old notes. Nothing is written on a
lead the rule leaves alone (no step, no stop): the owner follows up
personally, and the Leads tab marks the lead "Before go-live: follow up
personally".

| | |
| --- | --- |
| **The instant** | Env `AU_LEAD_COPY_LIVE_FROM` (an ISO instant) wins. Unset: `runtime_kv` key `au_lead_copy_live_from` = `{ at, set_by }` (the same store as the stalled-applications sentinel; `dbState.auLeadCopyLiveFrom` in local-JSON mode). |
| **Who records it** | Only `/api/cron/consult-nudge`, the first time it runs with the switch on (`auLeadCopyLiveFromMs({ create: true })`, insert with `resolution=ignore-duplicates`, then read back). The Leads tab reads it and never creates it. |
| **Unknown** | No readable instant admits **nobody** (fail closed). A set-but-unreadable env value logs an error and sends no Australian lead message. |
| **A Vercel preview** | Never writes it (a preview shares the production database, and writing would silently set production's go-live). It uses a per-process "now". Set `AU_LEAD_COPY_LIVE_FROM` on a preview to test. |
| **Switch off** | Not read, not written. |
| **Where it is applied** | `nextConsultNudge` (pass `auLiveFromMs`; without it no Australian step is handed out), `noShowRescueDecision` (same), the post-call WhatsApp pass, and again in `deliverAuConsultNudgeStep`. Not applied to the booking link (they just asked) or the call reminders (a call that is still ahead). |

**One step per run** is the existing schedule (`nextConsultNudge` hands out one
step and enforces a floor between steps: 40 minutes, then 12 hours, then a
week), plus `auLeadSends.sentSince(lead, runStartMs)`: the missed-call rescue
and the sequence share one job, and an Australian lead gets at most one of them
per run.

### Quiet hours (COM-22): the one gate

```js
const q = auQuietHours.auQuietHoursAllow(leadOrProfile, nowMs, { kind, isAu, phone, bookingZone, exempt });
if (!q.allow) { /* DEFER: send nothing, mark nothing; the next run inside the hours sends it */ }
```

- **08:00 to 20:00 on the person's own clock** (`localHourFor`: the zone they
  booked in, their browser's, their state). When the zone is not known
  (`certain: false`) the send must be inside the hours in **every** Australian
  zone at that instant (computed from the zones: 08:00 Perth to 20:00 Sydney,
  about 11:00 to 20:00 Sydney time in summer and 10:00 to 20:00 in winter).
- It applies to Australian-segment leads and doctors on an Australian pathway,
  switch on. For everyone else it answers `{ allow: true, applies: false }`.
- **Deferred, never dropped, never marked.** A later step's elapsed-time logic
  is unchanged: a 5-minute note held overnight goes at 08:00, the 1-hour note
  40 minutes after it.
- **Not gated:** a message anchored on a meeting (call reminders, interview
  reminders) and one that answers something the person just did (the booking
  link, a booking confirmation within 30 minutes, account verification).

Who calls it today:

| Sender | How |
| --- | --- |
| N01 notes, the drip, an owed WhatsApp leg | `deliverAuConsultNudgeStep` / the consult-nudge loop, through `auLeadQuietGate(row, messageId, anchorMs)`. The job answers `{ outcome: 'deferred' }` and its response carries `au.deferred_quiet_hours` and `au.deferred[]`. |
| Missed-call rescue | `maybeRunConsultNoShowRescue` (the marker is untouched while held). |
| The onboarding and post-call WhatsApp passes | the same gate (only reached once an Australian template is approved). |
| **WP-11 N13** (pre-start document reminders) | `runAuPrestartSweep`: `auDoctorQuietHoursAllow(userId, nowMs)` before `auSendPrestartItemRequest`; the once-ever key is not claimed while held; the result carries `deferred_quiet_hours`. |
| **WP-13 N18, N19, N20** (lifecycle messages) | `runLifecycleSweep` in `lib/au-commencement.js`: `quietAllows(practice, item, userId)` before each `sendOnce`, on the **practice's** clock (after commencement the doctor works there, and the practice gets the same message). Staff tasks, stage moves and repairs are never held. The run fires `deferred_quiet_hours`. |

**The lifecycle job now runs twice a day.** Its daily host (`sla-sweep`) runs at
20:30 UTC, early morning in Australia, so its messages are always deferred
there. `runAuLifecycleInHoursPass(nowMs)` runs the same idempotent job from the
hourly `onboarding-nudge` cron on the first two ticks after 08:00 has arrived
everywhere in Australia (00:00 and 01:00 UTC), and that is when N13 and N18 to
N20 go. No new cron; `vercel.json` is unchanged. Switch off: it returns `null`
and reads nothing.

**For WP-17.** Any elapsed-time message to a doctor on an Australian pathway
(onboarding nudges, drop-off nudges, N15, N16, the match final call) must call
`auDoctorQuietHoursAllow(userId, nowMs)` (in `server.js`; it reads the doctor's
zone facts and answers `applies: false` for an overseas doctor) or, with the
profile in hand, `auQuietHours.auQuietHoursAllow(profile, nowMs, { kind:
'doctor', isAu: true })`. Defer on `allow: false`: do not send, do not claim
the once-ever key, and make sure the job runs again inside the hours (hourly
jobs already do).

**Overseas nudges have no quiet hours and still do not** (parity). The report
notes a UK lead who submits at 23:00 gets a WhatsApp at 23:05. Giving overseas
leads quiet hours changes when existing messages go out, so it is an owner
decision (see WP-16's owner actions), not something this package did.

### WhatsApp

`auWhatsAppTemplates.auLeadWhatsAppPlan(kind)` (`kind` is the overseas consult
kind: `hello_5m`, `call_booked`, `call_reminder`, `call_missed`, ...) answers
`{ send: false, reason: 'au_template_not_approved' }` or `{ send: true,
templateName }`. Each Australian row takes the **same placeholders in the same
order** as the overseas template for the same touch, so
`buildConsultWaMessage` fills it and only the template name is swapped.

- Not approved: the named skip. `auLeadWhatsAppSkipped(row, kind, reason, key)`
  logs it and puts it on the lead's record once. Nothing is written to
  `consult.wa_skipped` (that would be a permanent ruling), so approving a
  template later turns the leg on for new sends, and for the not-booked notes
  of the last three days (`pendingConsultWaKinds`).
- Approved (set `approved: true` on the row, or list the key or the template
  name in `AU_WHATSAPP_APPROVED_TEMPLATES`): sent through that template.
- An Australian-segment lead is never sent a `gp_link_consult_*` template.

**Done by WP-18 (section 30).** Five lead rows now point at the existing
template for the same touch and are on: the one-hour and five-minute
reminders, the missed call, the after-the-call note and the set-up nudge. The
other six (hello, check-in, last note, call booked, day-before reminder,
sign-up welcome) still need a new Australian template: their existing
templates talk about visas, the UK or a move.

### The lead's own record, and the Leads tab

`consult.au_log = [{ id, ch: 'email' | 'whatsapp', out: 'sent' | 'skipped',
why?, key?, at }]` (newest last, at most 60), inside the existing
`site_enquiries.metadata` JSON. No column, no table, no migration. A skip is
written once per message, reason and key.

| Place | What (switch on, Australian-segment lead only) |
| --- | --- |
| `GET /api/ceo/leads` row | `au_copy_state` (`live`, `before_go_live`, `not_live`) and `au_copy_note`. The row shows an amber chip "Before go-live: follow up personally". |
| `GET /api/ceo/leads/:id` | `chase.au = { state, note, items: [{ at, text, out }] }`, in plain words: "Email sent: 1-hour note", "WhatsApp skipped: no approved Australian template (1-hour note)". The drawer lists these under "Messages sent and skipped" instead of the two overseas lists. |
| Switch off / overseas lead | neither key; the drawer is what it was. |

Skip reasons: `au_template_not_approved`, `au_segment_not_launched`,
`au_before_go_live` (never written on a lead; only a decision's reason),
`au_booking_link_just_sent`, `au_call_already_passed`, `email_bounced`.

### Every former `auMessagesHeld` site

| Site | Was | Now |
| --- | --- | --- |
| `nextConsultNudge` (`lib/consult-lead.js`) | `null` for every Australian lead | The same schedule, under the go-live rule (`auLiveFromMs`). |
| `pendingConsultWaKinds` | `[]` | Owed only when the Australian template for that kind is approved. |
| `noShowRescueDecision` (`lib/consult-noshow.js`) | `none('au_segment')` | Go-live rule on the missed slot; email due; `wa` only with an approved Australian template (`waSkipped` names the reason). |
| `maybeSendConsultWa` (`server.js`) | skipped, `au_segment` | The Australian template when approved; otherwise the named skip `au_template_not_approved`, recorded on the lead. |
| `deliverConsultNudgeStep` | skipped | `deliverAuConsultNudgeStep`: plan, quiet hours, Australian email, record. |
| `runConsultCallReminders` | WhatsApp skipped, day-before email skipped, one-hour email sent | Both emails in Australian wording; WhatsApp reminders through an approved Australian template only (named skip, once per reminder). |
| `sendConsultMagicLinkEmail`, `sendConsultGenericBookingLinkEmail` | not sent | The Australian booking-link email. |
| consult-nudge onboarding WhatsApp pass | `continue` | Named skip (no lookup, no marker); gated by quiet hours once a template is approved. |
| consult-nudge post-call WhatsApp pass | `continue` | Go-live rule, then the named skip when the note would otherwise have gone; quiet hours once approved. |

### Tests

`tests/au-wp16-overseas-parity.test.js` (+ `tests/helpers/au-wp16-parity.js`,
`tests/fixtures/au-wp16-overseas-parity.snapshot.json`: taken before the code
changed; never regenerate it), `tests/au-wp16-copy-snapshot.test.js` (+
`tests/helpers/au-wp16-copy.js`, `tests/fixtures/au-wp16-au-copy.snapshot.json`,
and the generated deck), `tests/au-wp16-quiet-hours.test.js`,
`tests/au-wp16-sends-lib.test.js`, `tests/au-wp16-lead-copy-server.test.js`,
`tests/au-wp16-reminders-and-golive-server.test.js`, the "WP-16 flows" case in
`tests/au-wp02-switch-off-no-new-queries.test.js`. Harness:
`tests/helpers/au-wp16-harness.js` (`bootLeadCopyServer`: the real server with
recording Resend and DoubleTick stubs).

In a server test: set `process.env.AU_LEAD_COPY_LIVE_FROM` (read at call time),
pin the quiet-hours clock with `__testUtils.__setAuQuietHoursClockForTest(ms)`
(only the gate reads it; the elapsed-time logic keeps the real clock), and
clear a stored instant with `__testUtils.__resetAuLeadCopyLiveFromForTest()`.
The lifecycle and pre-start jobs take their clock as an argument:
`tests/helpers/au-wp13-clock.js` gained `clock.atHours(n)` (an instant on that
calendar date inside the hours everywhere in Australia).

**Cache-busters moved:** `ceo-ats-leads.js` 20261122a; `sw.js` VERSION 20261122a.
Screenshots of the local-stack walk: `docs/au-gp/screenshots/wp16/`.

---

## 29. Lifecycle messages: the catalogue, the role label, staff defaults (WP-17)

Written by WP-17. **Read this before sending anything to a doctor on an
Australian pathway or to their practice, writing "Registration Support
Officer" anywhere a doctor can read it, or adding a WhatsApp template.**

**In one paragraph.** Every message an Australian doctor (or the practice
hiring one) gets after they have an account is listed in one registry,
`AU_MESSAGES` in `lib/au-messages.js`: N04 to N22, each with when it goes, to
whom, its channels, what each unlaunched segment gets, whether quiet hours
hold it, its once-ever key, its builder, its trigger and its tests. The words
of the ones WP-17 wrote live in that file; the builders earlier packages wrote
are re-exported from it, so it is the one module to import. `server.js` sends
each through the guarded helpers, every part claimed in the once-ever ledger
before it goes. An overseas doctor, and everyone with the switch off, is sent
exactly what they were (`tests/au-wp17-overseas-parity.test.js` holds a
snapshot taken before any behaviour changed).

### Where things live

| File | What |
| --- | --- |
| `lib/au-messages.js` | **The catalogue.** `AU_MESSAGES`, `MESSAGE_IDS`; the builders for N04, N05, N08, N15, N16, N17, N22; `roleLabelFor` / `applyRoleLabel` / `applyRoleLabelDeep` / `containsRoleLabel` (COM-23); `AU_NUDGE_TEMPLATES`, `resolveAuNudgeTemplate`, `AU_COMPOSER_TEMPLATES`, `composerTemplatesFor` (COM-18); `INTAKE_AU_LINE` (COM-20); `describeOutcome`, `outcomeFromSendResult`, `messageIdForLedgerKey` (what staff read); `LIFECYCLE_WHATSAPP_TEMPLATES`. Everything in `lib/au-placement-messages.js` is re-exported, plus the N06 builders from `lib/au-staff-tools.js`. Pure. |
| `server.js`, the block "WP-17: the lifecycle messages" | The senders and triggers below. |
| `docs/au-gp/au-lifecycle-copy.md` | The owner-readable deck: every message, when, to whom, channel, the exact words. **Generated from the registry**; a test fails if it differs. Regenerate with `WP17_WRITE_COPY=1 npx vitest run tests/au-wp17-copy.test.js`. |
| `tests/helpers/au-wp17-copy.js` | `everySample()`, `stringsOf(message)`, `copySnapshot()`, `renderDeck()`. |

**Adding a message.** Add its builder and its `AU_MESSAGES` row (with real
`trigger.fn` / `trigger.callers` and at least one test file that names it).
`tests/au-wp17-registry.test.js` fails until the builder exists, the trigger
function is defined and really called from the callers named, and the tests
exist. `tests/au-wp17-copy.test.js` then scans its words.

### The one sender

`auDeliverDoctorMessage(userId, msg, { buttons? })` sends whichever parts the
builder gave the message: the email always, a bell item when it has `bell`
(through `auPushDurableBell`), a WhatsApp leg when it has `whatsapp:
{ templateKey, placeholders }`. Each part is claimed in `gp_nudge_log` first
(channels `email`, `bell`, `whatsapp`); a part that could not be sent gives its
claim back. **One owner per message:** the caller that wins the email claim
sends every other part and writes the one timeline line (`result.owner`); a
caller that loses it (a double click, the daily pass overlapping the action)
does nothing at all, so two callers can never each send half and each write a
line. An email that could not be sent stops the rest, and the whole message is
tried again by the next pass. N15's practice email goes from the same owner;
the daily pass repairs a missing one only once the doctor's copy is more than
ten minutes old. The WhatsApp leg asks `auWhatsAppTemplates.auDoctorWhatsAppPlan`:
not approved means **skipped by name**, recorded once (channel
`whatsapp_skipped`). A practice email goes through `_auSendPracticeMessage`
(channel `practice_email`, keyed on the doctor). WP-11's `_auSendDoctorMessage`
is still what N11, N13 and N18 to N20 use (email and bell both required).

**What staff see (E).** `auLogMessageOutcome(userId, id, result, { caseId?,
suffix? })` writes one timeline line per message that actually sent or newly
skipped something: `Message N16 sent: Cleared to start (email, bell)` with the
detail `WhatsApp skipped: no approved Australian template`. A repeat that sent
nothing writes nothing. `auLogMessageSkipped` records a message deliberately
not sent (an unlaunched segment), once. N04 and N05 go before a case exists:
`auBackfillMessageTimeline(userId, caseId)` writes them to the case's timeline
when it is created (called by `completeAuOnboarding`).

### The triggers

| | Trigger | Sent by | Once per | Quiet hours |
| --- | --- | --- | --- | --- |
| **N04** welcome | The welcome moment (email verified), and the first onboarding save that answers the first question | `auSendWelcomeMessage`, from `sendWelcomeEmail` and `auReleaseHeldWelcome` | ever (`au_n04_welcome`) | not held |
| **N05** finish your profile | The hourly `onboarding-nudge` job, for a doctor in the sweep index (the branch marker, or an Australian pathway) who has not finished | `auOnboardingNudgeStep` → `sendAuOnboardingNudgeEmail` | reminder per spell away (the `onboarding_reminders` row, exactly as overseas) | held |
| **N08** profile complete | `completeAuOnboarding` | `auSendProfileCompleteMessage` | ever (`au_n08_profile_complete`) | not held |
| **N15** notice / start date | `POST /api/gp/au-prestart/notice`; `auConfirmStartDate` (through `auAfterPrestartChange`); the daily pass | `auSendNoticeStartMessages(userId, 'notice' \| 'start_date', { event? })` | notice date; confirmed start date (`au_n15_notice_gp:<placement>:<date>`, `au_n15_start_gp:…`, and the `_practice` twins) | notice: not held; start date: held |
| **N16** cleared to start | `auAfterPrestartChange`, called when a pre-start task closes (`auConfirmStartDate`, `auRecordProviderNumber`, `auOnAuDocumentApproved`, `PUT /api/admin/task` completing a pre-start type); the daily pass | `auMaybeSendClearedToStart` | placement (`au_n16_cleared_to_start:<placement>`) | held |
| **N17** stalled reminder | The daily pass; `sendStalledNudgeForPosition` for a position on the Australian ladder | `auSendStalledReminder` | mark (`au_n17_stalled:match:d14`, `au_n17_stalled:prestart:<placement>:d28`) | held |
| **N22** owner digest block | `sendOwnerDigestEmail` | `auOwnerDigestBlock` ← `auPipelineSnapshot` | week (the digest's own marker) | n/a |

N06, N07, N10 to N14 and N18 to N21 keep the triggers their own sections
describe (17, 20, 23, 25, 26).

**N15, N16 and N17 are derived from what is on file**
(`_auMessageFacts(userId)`: the placement, the start-date task, what the doctor
recorded), so the event and the daily pass send the same message and whichever
gets there first is the only one that sends (the idempotency rule of section
25: the ledger's unique index; nothing is claimed ahead of a send that is then
abandoned; a held message claims nothing).

**The daily pass.** `runAuMessagePass(nowMs)` is called by
`runAuLifecycleSweep` after WP-13's job, so it runs at the 20:30 UTC host
(where its messages are deferred by quiet hours) and again on the in-hours run
(`runAuLifecycleInHoursPass`). It reads per run, not per doctor (the request
budget, below): the index, the active `prestart` and `placement` cases, and
one batched read each of the placements, the pre-start tasks, what the doctors
recorded and the ledger; a sender is called only for a doctor who is owed
something. Result key:
`au_messages` on the lifecycle result. Switch off: `null`, nothing read.

### The daily job's request budget (read this before adding a read to it)

Every database request is a round trip to another region (about a quarter of
a second from Australia) and the daily job runs inside a serverless time
limit. **A job reads per run, never per doctor.**

- Decide who a pass concerns from the sweep index (`auSweepPathwayIndex`, two
  reads per run) and filter the case rows in memory. An overseas case must
  cost a pass nothing: no read may name an overseas doctor.
- Read what the pass needs for all of its doctors in one request per table
  (`_auBatchRead(table, select, column, ids, extra)`: `column=in.(...)`, a
  hundred ids at a time; `{ ok: false }` means "do nothing this run", never
  "nothing found"). Work out in memory, from those rows and the ledger,
  whether anything is owed. Only a doctor who IS owed something may cost
  more: the sender then reads what it needs and sends once.
- Inside one sender, read a doctor's facts once and pass them on
  (`_auSharedMessageFacts(userId, shared)`; `shared` is an object the caller
  keeps for one doctor and one run, never longer). Reads that do not depend on
  each other go in one `Promise.all`.
- `runAuMessagePass` is the worked example: 7 reads on a run with nothing to
  send, however many doctors there are (it was about 41 reads per pre-start
  doctor per run before this rule).
- **`tests/au-wp17-sweep-budget.test.js` pins it**: the message pass's quiet
  run (`MESSAGE_PASS_QUIET_BUDGET`), a quiet run of the whole daily job over a
  fixed set of doctors (`DAILY_JOB_QUIET_BUDGET`), that more doctors with
  nothing owed add no read to the pass, and that overseas doctors add no read
  to the pass or to the whole job. A package that adds a read to the daily job
  runs that file, and does not raise a number without measuring why.
- **Still per doctor, from before WP-17:** the pre-start pass
  (`runAuPrestartSweep`, WP-11) costs about 22 reads per pre-start doctor per
  run, and the lifecycle job (WP-13) reads per commenced placement. Both are
  inside the whole-job budget above as they stand; batching them is the same
  idea and is not done.

**Long tests carry their own time limit.** The suite's limit is 15 seconds
(`vitest.config.js`; do not raise it). A test that walks many steps through
the real server says so: `it(name, { timeout: 60000 }, async () => { ... })`
with a one-line comment giving how long it takes alone. A server test file
whose tests could overlap a neighbour's unfinished work waits for the database
to go quiet before each test (`serverQuiet()` in `tests/au-wp13-server.test.js`).
The placement rig (`tests/helpers/au-wp11-placement-rig.js` `place()`) does the
same after every placement: its fixed pause is a minimum, then it waits until
no new request, email or WhatsApp has appeared for a moment. Never read back
fire-and-forget work after a fixed sleep alone.

### N04: which welcome, and the hold (COM-08)

`auWelcomeDecision(userId)` answers at the welcome moment:

| Answer | When | What happens |
| --- | --- | --- |
| `au` | an Australian pathway on record; the saved wizard says "yes" to the first question; the address belongs to an Australian-segment lead (`auLead.auCopyApplies`) | N04. Careful wording when a segment B or C answer is already on file. |
| `overseas` | onboarding finished; the saved wizard shows progress in today's flow (`currentStep >= 1`); an overseas pathway on record; the address belongs to a lead recorded as `overseas` | Today's welcome, at once, byte for byte. |
| `hold` | nothing says either way (a brand-new sign-up who has not answered the first question), or the pathway / profile / state could not be read | Nothing is sent. A row `au_welcome_hold` (channel `hold`) is written to `gp_nudge_log`. |

A hold is released by `auReleaseHeldWelcome(userId, 'au' | 'overseas' |
'au_completed')`: by the first `POST /api/onboarding/save` that carries an
answer ("yes" → N04; progress in today's wizard → today's welcome), by
`/api/onboarding/complete`, and by the hourly job after one hour
(`runAuHeldWelcomeBackstop`, `AU_WELCOME_HOLD_MAX_MS`: nothing recorded is
overseas, so today's welcome goes then). The release claims
`au_welcome_released` first, so a double submit sends one welcome.

**This is a switch-on change for overseas doctors, on purpose** (it is in the
table in section 2): a brand-new sign-up who verifies before answering the
first onboarding question gets the same welcome a little later (when they
answer, or within the hour). It costs one read of `gp_nudge_log` on the first
onboarding save that carries an answer, and nothing on any other save.

### N05: the Australian reminders

Same reminder row, unsubscribe link, one-click headers, "email nudges"
preference and stop rules as the overseas reminders; the differences are the
words, the step labels (`AU_ONBOARDING_STEP_LABELS`, from `gp_onboarding.au.step`),
the schedule (`AU_ONBOARDING_NUDGE_SCHEDULE_MS`: 1 hour, 24 hours, 3 days, 7
days) and quiet hours. The button opens `/pages/onboarding` (the wizard
resumes the branch); **never a `?step=` link**, which opens the overseas
wizard. `enumerateIncompleteOnboardingGps` adds `auStep` to a row whose saved
wizard says "yes" (switch on only). The on-demand
`/api/cron/onboarding-step-followup` and the `dropoff-nudge` job still leave
Australian doctors out: N05 and N17 are their Australian equivalents.

### N17: only what the doctor can do

Aged from the placement milestone (`auSweeps.auCaseAgeAnchor`): the case
being opened for a doctor not yet placed, the placement being recorded for
pre-start. Marks at 14 and 28 days (`N17_MARK_DAYS`), each not later than 10
days after its day. What is "waiting on the doctor": before a placement, a
live match they have not answered; at pre-start, the items of their own
pre-start view (`buildAuPrestartDoctorView`) whose `who` is `you` and whose
status is `todo` or `attention`. Nothing of theirs outstanding: **no message**.
`sendStalledNudgeForPosition` now answers for the Australian ladder with this
(it used to return `skipped: 'au_pathway'`); `chaseStalledCase` still opens no
"GP stalled" task for an Australian case.

### The role label (COM-23)

One helper, used at every site: **`auRoleLabelText(userId, value)`**
(`server.js`), over `auMessages.applyRoleLabel`. `value` is a string or an
object of strings. For a doctor on an Australian pathway "your Registration
Support Officer" (any capitalisation, with or without "GP Link") becomes
`gpApp.teamLabel(placed)`: "your GP Link consultant" before a placement,
"your GP Link team" after. For anyone else the **same string** comes back.
Text without the label costs nothing; switch off: nothing is asked.

It is inside the three functions nearly every doctor notification passes
(`sendGpNotificationEmail`, `pushCareerNotificationToUser`,
`sendPushNotification`), so a new message through any of them is covered
without doing anything. The sites that send another way call it themselves
(the application-received email, the withdrawal confirmation, the interview
confirmation and its correction, the assistance-call invite, the "previously
withdrew" answers, the outstanding-actions list, the match-accepted WhatsApp
text, the AHPRA task emails). **A new doctor-facing string that names the role
outside those three senders must go through `auRoleLabelText`**: a source pin
in `tests/au-wp17-existing-messages-server.test.js` lists every line of
`server.js` that carries the label and fails on one it does not know.

Not changed, on purpose: staff-facing text (ops emails, the RSO's own copy of
a confirmation, the admin email-preview catalogue) and the AI prompts (WP-20).

### Existing doctor WhatsApp templates

> **Extended by WP-18 (section 30):** the keys now also include
> `account_released` and `interview_confirmed_practice` (the practice's copy,
> about an Australian candidate); `match_invitation` and `account_released`
> are on, through the existing templates, confirmed neutral.

`auExistingDoctorWhatsAppGate(userId, key)` stands in front of every existing
template a doctor is sent: `match_invitation`, `match_accepted`,
`contract_ready`, `interview_confirmed`, `interview_times_ready`,
`rso_welcome`. Not Australian, or switch off: `{ send: true }` and the existing
template goes exactly as before. Australian: only the Australian row of that
key, once approved (it takes the same variables in the same order); until then
the WhatsApp is skipped by name, logged, and written once on the case
timeline. The email, bell and push still go. **A new sender of an existing
doctor template must ask it.**

### Staff defaults (COM-18)

- **Nudge** (`POST /api/admin/va/nudge`): for a doctor on an Australian
  pathway the default title and message come from `AU_NUDGE_TEMPLATES`, keyed
  on an Australian stage; a stage a staff member types that is not on the
  doctor's ladder is replaced by the case's own, and the stored nudge carries
  that stage. The email footer is `AU_NUDGE_EMAIL_FOOTER`. A message the staff
  member typed is sent as typed.
- **Composer templates** (`GET /api/admin/email-templates`): with
  `?user_id=`, `?case_id=` or `?task_id=` naming a doctor on an Australian
  pathway the reply is `{ ok, templates, audience: 'au' }` with the
  overseas-only defaults (`OVERSEAS_ONLY_COMPOSER_KEYS`) left out and
  `AU_COMPOSER_TEMPLATES` added. Any other request: the reply is unchanged.
  `pages/admin.html` passes the case or the task (`fetchEmailTemplatesFor`),
  and only when the Australian routes exist (`loadAuTaskTypes`).

### Other pieces

- **Practice intake invite (COM-20).** `practicePipeline.buildIntakeEmailCopy({ …, auLine })`
  adds one paragraph when the caller passes it; the caller passes
  `auMessages.INTAKE_AU_LINE` only with the switch on. The intake **field** for
  which GP types a practice wants is WP-23's.
- **Assistance-call invite (F49).** `callStageDisplayLabel(stage)` names an
  Australian stage by its doctor-facing label ("Pre-start checks").
- **Match final call.** Only sent between 08:00 and 20:00 on an Australian
  doctor's clock (`/api/cron/match-lifecycle`): held unstamped outside.
- **N11's WhatsApp button** now opens `pages/prestart`.

### Hooks for later packages

| Package | What to do |
| --- | --- |
| **WP-18 (WhatsApp)** | `LIFECYCLE_WHATSAPP_TEMPLATES` and the WP-17 section of `whatsapp-templates.md`: three new templates and six rows standing in for existing ones. For each "stands in for" row read the live body; if neutral, point the row's `templateName` at the existing name and approve it. `welcome` / `lead_signed_up` and `onboarding_nudge` / `lead_onboarding_incomplete` are pairs for the same moment: approve one of each. |
| **WP-20 (prompts)** | The AI prompts still say "Registration Support Officer"; they are staff-facing drafts and were not touched. |
| **WP-23 (intake)** | The invite line says "if you would like to hear about them as well, just tell us": replace it with a pointer to the form field once the field exists. |
| **WP-26 (dashboards)** | Message lines are on the case timeline (`metadata.au_message`). No dedicated "messages" panel exists. The composer's per-doctor list is wired on the RSO dashboard only. |
| **WP-27 (metrics)** | `auPipelineSnapshot()` → `{ total, stages: { onboarding, placement, prestart, commenced, guarantee, complete }, segments: { A, B, C }, needsReview }`; the digest block is `auMessages.buildOwnerDigestBlock(counts)`. Rebuild or replace both freely: the block is one concatenation at the end of the digest body. |

Tests: `tests/au-wp17-registry.test.js` (completeness), `tests/au-wp17-copy.test.js`
(+ `tests/helpers/au-wp17-copy.js`, `tests/fixtures/au-wp17-au-copy.snapshot.json`,
and the generated deck), `tests/au-wp17-welcome-onboarding-server.test.js`,
`tests/au-wp17-prestart-messages-server.test.js`,
`tests/au-wp17-existing-messages-server.test.js`,
`tests/au-wp17-sweep-budget.test.js` (the request budget),
`tests/au-wp17-overseas-parity.test.js` (+ `tests/helpers/au-wp17-parity.js`,
`tests/fixtures/au-wp17-overseas-parity.snapshot.json`: taken before any
behaviour changed; never regenerate it), and the "WP-17 flows" case in
`tests/au-wp02-switch-off-no-new-queries.test.js`. Test hooks:
`__testUtils.__wp17` (the senders above and the existing ones the parity
snapshot drives).

No column, table or migration was added. No client script or stylesheet
changed (`pages/admin.html`'s inline script did), so no cache-buster moved and
`sw.js` VERSION is still `20261122a`.

## 30. WhatsApp templates: which one each Australian message uses (WP-18)

Written by WP-18. **Read this before adding a WhatsApp template, adding a
place that sends one, or changing which template an Australian message uses.**
It replaces what sections 20, 28 and 29 say about "every Australian row starts
not approved" and "point the row at the existing name": that work is done.

**In one paragraph.** On 22 November 2026 the approved wording of every
template in DoubleTick was read (`whatsapp-live-templates.md`: read-only, the
words are quoted there). Every one of the 42 names the code can send is now
classified in `lib/au-whatsapp-templates.js`. Nine Australian messages go
through an existing template whose wording is neutral. Five existing templates
that say "your Registration Support Officer" are off for Australian recipients
unless the owner lists a key. The other 26 can never reach one. Everything the
owner has to submit is one generated sheet, `whatsapp-templates.md`.

### Where things live

| File | What |
| --- | --- |
| `lib/au-whatsapp-templates.js` | **The one decision.** `AU_WHATSAPP_TEMPLATES` (key → `{ templateName, language, approved, source, confirmed?, ref?, supersedes? }`), `EXISTING_TEMPLATE_CLASS` (every existing name → `neutral` / `rso_wording` / `overseas_only`), `templateClass(name)`, `auWhatsAppTemplate(key, env)`, the three plans (`auPracticeIntroWhatsAppPlan`, `auDoctorWhatsAppPlan`, `auLeadWhatsAppPlan`), `describeSentVia(name)`. Pure. |
| `lib/au-whatsapp-submission.js` | What the owner types into DoubleTick: `SUBMIT` (category, body, a sample per variable, buttons), `REUSED`, `OWNER_CHOICE`, `SUPERSEDED`, `MESSAGE_TABLE`, `renderSheet()`. The bodies come from `auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES` and `auMessages.LIFECYCLE_WHATSAPP_TEMPLATES`; three are held here (placement secured, the two first-week check-ins). Pure. |
| `docs/au-gp/whatsapp-templates.md` | The owner's sheet. **Generated**: `WP18_WRITE_SHEET=1 npx vitest run tests/au-wp18-sheet.test.js`. A test fails if it differs from the code. |
| `server.js` | `auExistingDoctorWhatsAppGate` (WP-17, extended), `auNoteDoctorWhatsAppSkipped`, `auNoteDoctorWhatsAppVia`, `auBlocksOverseasTemplates`, `auBookingDoctorCtx`. |

### What "approved" means

A row is on only when one of these is true, and never for any other reason:

1. `source: 'existing-template-confirmed-neutral'`: it points at an existing
   template classed `neutral`, with `confirmed` (the date the live wording was
   read) and `ref` (where it is quoted). These rows have `approved: true`.
2. Its key (or template name) is listed in `AU_WHATSAPP_APPROVED_TEMPLATES`.
   That is how a new `gp_link_au_*` template is switched on once Meta approves
   it, and how the owner switches on an `_existing` row.

`AU_WHATSAPP_DISABLED_TEMPLATES` (same format) switches any row off, and wins.
A row whose template is classed `overseas_only`, or is not classified at all,
is never on, whatever a row or either setting says.

### The classification (42 names)

| Class | Names | For an Australian recipient |
| --- | --- | --- |
| `neutral` (11) | `gp_link_practice_candidate_intro`, `…_intro_cv`, `gp_link_consult_call_1h`, `gp_link_consult_call_starting_5m`, `gp_link_consult_missed_call`, `gp_link_consult_post_call_onboard_v3`, `gp_link_consult_onboarding_nudge`, `gp_link_app_match_invitation`, `gp_link_account_released`, `gp_link_khaleed_personal_checkin` (the owner's own sentences), `gp_link_owner_lead_alert` (goes to the owner) | Sent, with Australian values in the variables. |
| `rso_wording` (5) | `gp_link_interview_times_ready`, `gp_link_interview_confirmed_gp`, `gp_link_interview_confirmed_practice`, `gp_link_contract_ready`, `gp_link_app_match_accepted` | Off. Each has an `_existing` row (`interview_times_ready_existing`, …) the owner can list, and a neutral `gp_link_au_*` twin to submit. The twin wins once it is on (`auDoctorWhatsAppPlan` tries the message's own row first). |
| `overseas_only` (26) | The MyIntealth, AMC and AHPRA introductions, AHPRA docs complete, the two visa-passport ones, the staff welcome (`gp_link_app_rso_welcome`), the two `gp_link_reg_call_*`, the consult hello / check-in / day-after / sign-up welcome / call booked / day-before reminder, the four `gp_link_onboarding_step_*`, the three `gp_link_resume_onboarding_*`, `gp_link_start_practice_search`, `gp_link_upload_cv_nudge`, `gp_link_offer_signature_nudge`, `gp_link_reengage_hayley` | Never. No row points at one and none can. |

### THE RULE for any future template

- **A new template name** must be added to `EXISTING_TEMPLATE_CLASS` (or be a
  `gp_link_au_*` row) in the same commit. `tests/au-wp18-template-guard.test.js`
  greps `server.js`, `lib/` and `api/` for quoted `gp_link_*` names and fails on
  one it cannot place. Class it `overseas_only` unless its approved wording
  has been read and is safe for an Australian GP. Unknown counts as overseas.
- **A new place that sends a template** changes a pinned count in the same
  test. Before changing the number: the sender must ask
  `auExistingDoctorWhatsAppGate(userId, key)` (a doctor, or a practice about a
  doctor), `auLeadWhatsAppPlan(kind)` (a lead) or `auBlocksOverseasTemplates(userId)`
  (an overseas-only template with no Australian equivalent), and the path goes
  into the journey in `tests/helpers/au-wp18-rig.js`.
- **A new Australian message with a WhatsApp leg** gets a row, a `SUBMIT`
  entry and a `MESSAGE_TABLE` line; the sheet test fails until all three exist.
- **No template body starts or ends with a variable** (Meta rejects it), and a
  button has at most one variable, last, in a fixed address. The sheet test
  checks every entry to be submitted.
- **Never fall back to free text in the overseas wording.** A free-text
  fallback to an Australian doctor must go through `auRoleLabelText` and must
  not be sent if the label could not be put right (see
  `sendMatchAcceptedWhatsAppToGp`).

### What each gate does

| Recipient | Asked | Not approved |
| --- | --- | --- |
| A doctor on an Australian pathway (match invitation and accepted, contract ready, the two interview ones, the staff welcome, account released) | `auExistingDoctorWhatsAppGate(userId, key)` | `{ send: false, reason, au: true }`; logged; once per touch on the case timeline: "WhatsApp skipped: no approved Australian template". Sent through an existing template: once per touch, "WhatsApp sent via existing neutral template X". |
| The practice, about an Australian candidate (`gp_link_interview_confirmed_practice`) | the same gate, key `interview_confirmed_practice`; `sendInterviewWhatsappTemplate` takes the doctor's user id as its fifth argument for all three interview templates | the same; the note says "to the practice about this doctor". |
| The practice introduction | `auPracticeIntroWhatsAppPlan()` | `au_introduction.whatsapp = { sent: false, reason }` in the route's answer; the case event says so. Sent: a case event "WhatsApp sent via existing neutral template X". |
| An Australian-segment lead | `auLeadWhatsAppPlan(kind)` | The named skip on the lead (`auLeadWhatsAppSkipped`). Sent: the lead's log entry carries `tpl`, and the Leads tab reads "WhatsApp sent: … (sent via existing neutral template X)". |
| Any doctor, overseas-only templates with no Australian equivalent (the drop-off nudges) | `auBlocksOverseasTemplates(userId)` | `{ ok: false, skipped: 'au_no_overseas_template' }`. Unreadable pathway counts as blocked. |

A pathway that cannot be read: the gate answers `{ send: false, reason:
'pathway_unreadable' }`; nothing is sent and nothing is stamped.

### The staff welcome (T1)

`ensureRsoWelcomeSent` is the only sender, and the gate is inside it, so all
four callers are covered (`PUT /api/admin/case`, `PUT /api/admin/ops/case`,
`POST /api/admin/rso/bulk-reassign`, `POST /api/admin/ops/resync-dt-assignment`).
Handed no user id, it reads the case's own (switch on) and refuses if there is
none. A skip returns before the "RSO welcome started" timeline marker, so the
doctor is not recorded as welcomed and the welcome goes the first time a
template is approved. `assignRsoForPrestart` never calls it. (Unchanged for an
overseas doctor, including that an HTTP 200 from DoubleTick counts as sent.)

### Call reminders for a booking held by a doctor (T2)

`runConsultCallReminders` asks `auBookingDoctorCtx(call.user_id)` when a
reminder is due and the lead check found nothing (switch on only; it reads
the pathway, then `user_profiles.timezone, current_state`):

- **A call with a staff member** (`host_kind = 'rso'`): neither
  `gp_link_reg_call_*` template. The email `auMessages.buildStaffCallReminderMessage`
  goes instead (the day before, and as it starts), on the doctor's own clock,
  and stamps the same marker the WhatsApp would have, so it goes once. Email
  only: there is no Australian row for this message.
- **A call with the CEO** booked by an Australian doctor with no
  Australian-segment lead row behind them: treated as an Australian lead (the
  Australian emails; the WhatsApp through `lead_call_*` rows). Nothing is
  written to an overseas lead's row.
- Pathway unreadable: skipped this run, markers unstamped, tried again next run.
- Known limit: the whole job stands down when WhatsApp is switched off
  globally (`CONSULT_WHATSAPP_ENABLED=false` or no DoubleTick key) on the staff
  track, as it always has; the Australian email does not run then either.

### Buttons on the new Australian templates

`placement_secured`, `welcome` and `onboarding_nudge` have a **fixed-page**
button and `cleared_to_start` has none, so the senders pass no button value
(they used to pass a page path as the whole variable, which Meta does not
approve). `interview_times_ready` and `contract_ready` keep the application id
as the one variable at the end of a fixed address, as the existing ones do.

### Tests

`tests/au-wp18-template-guard.test.js` (the guard: inventory against a grep,
then the real senders, routes and jobs for Australian doctors at every stage
and segment, an Australian lead, a practice; the owner's switches; the
snapshot of the reused templates' values, `tests/fixtures/au-wp18-au-reused-whatsapp.snapshot.json`),
`tests/au-wp18-sheet.test.js` (the sheet is the code; every row in exactly one
section; nothing to submit would be rejected for a known reason),
`tests/au-wp18-overseas-whatsapp-parity.test.js` (+ `tests/helpers/au-wp18-rig.js`,
`tests/fixtures/au-wp18-overseas-whatsapp.snapshot.json`: taken before any
behaviour changed; never regenerate it), and the "WP-18 flows" case in
`tests/au-wp02-switch-off-no-new-queries.test.js`. Test hooks:
`__testUtils.__wp18`.

No column, table or migration was added. No client script or stylesheet
changed, so no cache-buster moved.
