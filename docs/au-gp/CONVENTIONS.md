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
[13 Preview send lock](#13-preview-send-lock)

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
| `auHazelBlocked(lead, opts?) → boolean` | **Permanent** (owner decision 7): Hazel never rings an Australian-segment lead. False when the switch is off. |
| `auMessagesHeld(lead, opts?) → boolean` | **Interim**: automated emails / WhatsApps to the lead are held until WP-16 ships Australian copy. WP-16 replaces its call sites. |
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

Fixture cases use today's default stage, `myintealth`. WP-03 gives Australian
cases their own ladder and should update `baseCase` then.

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
- **WP-04 (sweeps).** Filtering a sweep with `&pathway=…` names a new column:
  switch-on only, and remember NULL is overseas (`pathway=is.null` or the two
  overseas values), not "no pathway to worry about".
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
