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
[15 Scheduled jobs and sweeps](#15-scheduled-jobs-and-sweeps-wp-04)

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
  pathway, and when an Ahpra condition, undertaking or notation is flagged. It
  is never true for an overseas doctor.

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
There are two places where that is knowingly not true. Do not add a third
without the lead's say-so, and list it here if you do.

| What | Behaviour with the switch OFF | Why |
| --- | --- | --- |
| **Hazel never rings an Australian-segment lead** (WP-04, on the lead's instruction; owner decision 7). `auHazelBlocked` (`lib/au-lead.js`), `leadCallDecision` including the "no country on file but would be dialled as Australian" skip (`lib/lead-calls.js`), `placeLeadCall` and `ceoLeadCallNow` (`server.js`). | An Australian-segment lead is skipped with reason `au_segment`, exactly as with the switch on. On `main` the lead was diallable in principle. | WP-01 put the block behind the switch, so in production the only thing stopping Hazel ringing an Australian lead with the script for doctors moving country was that no Australian from-number (`RETELL_FROM_NUMBER_AU`) is configured. In production today no such number exists, so no call is placed either way; the block protects against the UK script ringing Australian leads if a number is ever added. What a person can see change: the Leads tab says "Australian GP: Hazel does not ring Australian leads", and "ring now" on such a lead answers 409 with that reason, where it used to answer that the Australian number was missing. New Zealand leads share that number and are **not** affected. `auMessagesHeld` (the interim hold on emails and WhatsApps) still follows the switch. |
| **`applyVerifiedStageToGp` skips the case write for `placement`** (WP-03, section 14). | The staff "verified stage" control, set to the overseas override value `placement`, no longer attempts to write `stage = 'placement'` on the case row. | The live CHECK constraint always rejected that write, so the case row never changed. WP-03 widens the constraint (for the Australian ladder), which would have turned the silent failure into a real write on an overseas doctor's case. The guard keeps the outcome what it has always been. No observable change. |

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

The resolver result:

```js
{ pathway, basis, segment, isAu,
  dpaRestricted, dpaRestrictedReason,
  confirmed, needsStaffReview, launched,
  recorded,      // false = nothing valid stored; this is the default
  flagEnabled,
  schemaMissing, // only when true: the migration is not applied here
  readFailed }   // only when true: the rows could not be read
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
| `auSweepPathwayIndex(jobName) → Promise<index>` (`server.js`) | **Call once per job run.** The doctors on an Australian pathway. Switch off: the inert index, nothing queried. Switch on: one read of its own (`user_profiles?select=user_id,candidate_pathway&candidate_pathway=in.(…)`, paged). Column missing: empty + one log line. Any other failure: `unreadable` (every doctor is held this run). Never throws. |
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
<script src="/js/au-pathway.js?v=20261120a"></script>
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
- **WP-06 (staff tools).** The Ahpra check writes through
  `upsertGpCredentials(userId, patch, { source: 'staff', actor, markVerified: true })`
  with `ahpra_last_checked_at / _by`. The pathway control posts to
  `/api/admin/candidate/pathway`. Decide whether a consultant should be allowed
  to staff-confirm 19AB; today any role that passes the access check can.
- **WP-08 (eligibility).** Rewire the four call sites of
  `gpQualifiesForRole(..., { australiaTrained })` and AI matching's
  `dpaEligible` to `!p.dpaRestricted`, passing
  `legacyDpaExempt: jobsProfile.australiaTrained`. That keeps overseas doctors
  byte-identical and closes ADM-07 / APP-17. WP-02 did not touch those sites.
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

- **One read, of its own.** The index is the only query WP-04 added. Never add
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
