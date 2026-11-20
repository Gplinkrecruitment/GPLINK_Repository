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
[20 Practice introduction, Australian WhatsApp templates, consent](#20-practice-facing-introduction-australian-whatsapp-templates-and-consent-wp-09)

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
| **Hazel never rings an Australian-segment lead** (WP-04, on the lead's instruction; owner decision 7). `auHazelBlocked` (`lib/au-lead.js`), `leadCallDecision` including the "no country on file but would be dialled as Australian" skip (`lib/lead-calls.js`), `placeLeadCall` and `ceoLeadCallNow` (`server.js`). | An Australian-segment lead is skipped with reason `au_segment`, exactly as with the switch on. On `main` the lead was diallable in principle. | WP-01 put the block behind the switch, so in production the only thing stopping Hazel ringing an Australian lead with the script for doctors moving country was that no Australian from-number (`RETELL_FROM_NUMBER_AU`) is configured. In production today no such number exists, so no call is placed either way; the block protects against the UK script ringing Australian leads if a number is ever added. What a person can see change: the Leads tab says "Australian GP: Hazel does not ring Australian leads", and "ring now" on such a lead answers 409 with that reason, where it used to answer that the Australian number was missing. New Zealand leads share that number and are **not** affected. `auMessagesHeld` (the interim hold on emails and WhatsApps) still follows the switch. |
| **`applyVerifiedStageToGp` skips the case write for `placement`** (WP-03, section 14). | The staff "verified stage" control, set to the overseas override value `placement`, no longer attempts to write `stage = 'placement'` on the case row. | The live CHECK constraint always rejected that write, so the case row never changed. WP-03 widens the constraint (for the Australian ladder), which would have turned the silent failure into a real write on an overseas doctor's case. The guard keeps the outcome what it has always been. No observable change. |
| **A case whose STORED stage is an Australian-ladder value is never handed to the overseas stage code** (WP-06, carry-over F1). `_auStageModeFor` answers `{ mode: 'hold', strandedAuStage: true }` for a case stored at `placement`, `prestart`, `commenced` or `guarantee` whenever the doctor does not read as Australian: with the switch off, and with the switch on when the pathway is overseas / not recorded. | The state sync (`processRegistrationTaskAutomation`), the bulk case sync, the staff verified-stage control (`applyVerifiedStageToGp`), Reset GP (409 `au_stage`) and the registration-granted flow all leave such a case exactly where it is, write no overseas flags onto the doctor's state, and send none of the overseas stage messages for it. `resolveGpJourneyPosition` reports it as on the Australian ladder, so the stalled-GP chase and the stage reminder stand down. No query is added: the answer comes from the `stage` already in hand. | Found on the Phase 1 walk-through: an Australian case at `prestart`, switch turned off, the doctor opened the app, and the overseas derivation rewrote the stage to `myintealth`. The Australian ladder only moves forward, so it could never be put back. On production today no such row can exist (the live CHECK rejects those four values), so nothing changes there. The one thing that still moves such a case onto the overseas ladder is a staff pathway change (`syncCaseToPathway`, switch on). **Not covered with the switch off** (the doctor is otherwise an overseas doctor by design): jobs that key on the doctor rather than the case (onboarding and drop-off nudges, document AI review, register auto-verify), and jobs that read the inert sweep index (`excludesCase` stays false with the switch off, so the 5-day SLA task, the intent score and the AI summary still run for that case). |

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
| `isAuSegmentLead(lead) → boolean` | The fact: today `consult.country === 'au'`. WP-15 extends it to read `consult.segment`. Does not look at the switch. |
| `auPathwayOn(opts?) → boolean` | The switch, honouring `opts.auPathwayEnabled`. |
| `auHazelBlocked(lead, opts?) → boolean` | **Permanent and unconditional** (owner decision 7): Hazel never rings an Australian-segment lead. Since WP-04 it does **not** look at the switch (`opts` is ignored): see "Deliberate exceptions to switch-off parity" in section 2. |
| `auMessagesHeld(lead, opts?) → boolean` | **Interim**: automated emails / WhatsApps to the lead are held until WP-16 ships Australian copy. WP-16 replaces its call sites. Behind the switch (false when it is off). |
| `AU_NO_CALL_REASON`, `AU_MESSAGES_HELD_REASON` | `'au_segment'`: the reason strings recorded and shown on the Leads tab. |

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
| `auPlacementTargetStage(pathway)` | **WP-14 hook.** Where a case goes when a placement is recorded. `prestart` for everyone today; segment B's "prestart or ahpra" branch goes here. |
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
<script src="/js/au-pathway.js?v=20261120b"></script>
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
  hot; this costs a query). WP-12 renders from this and calls
  `GPAuPathway.init({ force: true })` after a step that changes the stage.
  `js/au-pathway.js` does not expose it yet: WP-12 adds the accessor.

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
- **WP-11, from WP-04.** Still yours: the "Career secured" block of
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
- **WP-11 (placement cascade), from WP-03.** The cascade is untouched: an
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
  (`AU_BLOCKED_PAGE_STAGES`).
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
| `commenced` | Staff confirmed the doctor started work. | WP-13's "Confirm commenced" action. Until then, staff with the verified-stage control. |
| `guarantee` | The placement-guarantee period is running. | WP-13. |
| `complete` | The guarantee period ended; the case is finished. | WP-13. |

Rules:

- **Forward only.** Every Australian stage write goes through
  `advanceAuCaseStage`. Nothing demotes an Australian case, including the staff
  control (409).
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
| `GPOnboardingAu` | `js/onboarding-au.js?v=20261120a` | Pure, no page code, loadable with `require` in tests. `STEPS`, the answer lists, `defaultAnswers()`, `normaliseAhpraNumber`, `validateAhpraNumber`, `validateStep(stepKey, answers)`, `firstIncompleteStep(answers)`, `reviewRows(answers)`. Mirrors `lib/au-onboarding.js`; `tests/au-wp05-onboarding-lib.test.js` keeps them in step. **Change both together**, and bump the `?v=` (onboarding page, `sw.js`). |
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
  "has the marker" (Australian reminder) instead of excluding.

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
  wording in `buildAuWaitlistInviteEmail`.
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

`pages/my-documents-au.html` + `js/my-documents-au.js?v=20261120b`
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
