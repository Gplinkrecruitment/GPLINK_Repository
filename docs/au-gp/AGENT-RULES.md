# Australian GP build: rules for every implementing agent

Read this whole file before touching anything. These rules are not optional
context. If anything in `CLAUDE.md` or `AGENTS.md` disagrees with this file,
**this file wins** (the owner has said so for this job).

The specification is `docs/au-gp/review-report.md`. Your brief names a work
package (WP-xx) and finding IDs. Read the WP text under "Build plan for agents"
and every finding row it closes **yourself**; the brief does not repeat them.

Line numbers in the report refer to commit `2d35b94a`. Treat each as a pointer
to search from and confirm the current location before editing. The same
assumption usually lives in several places (for example at least seven functions
default an unknown country to the UK): find **every** current site for each
finding, do not stop at the ones the report lists.

## 1. Branch rules (override CLAUDE.md rule 6)

- CLAUDE.md rule 6 says to commit and push straight to `main`. **For this job
  that is wrong.** Never push to `main`, never merge into `main`, never open a
  pull request, never run a production deploy, never force-push.
- You work in your own git worktree. Your first commands:
  `git fetch origin au-gp-testing` then `git reset --hard origin/au-gp-testing`
  (your worktree may have been created from `main`), then confirm this file
  exists. Then `ln -s "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/node_modules" node_modules`
  if `node_modules` is missing (it is git-ignored).
- Commit to your worktree's branch only. **Do not push at all.** The lead
  merges your branch into `au-gp-testing` after checking it. Report your branch
  name and commit hashes.
- Stage specific files by name. Never `git add -A` or `git add .`. Never commit
  `.env*` files, secrets, or test-account bypass entries (no `hello+alias`
  entries in `BYPASS_LOCK_EMAILS` / `TEMPORARY_BYPASS_LOCK_EMAILS`).
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`

## 2. Safety rules

- **One switch.** All Australian behaviour sits behind
  `require('./lib/au-pathway-flag.js').isAuPathwayEnabled()` (env
  `AU_PATHWAY_ENABLED`; on for localhost, tests and Vercel previews; off in
  production unless explicitly set). Call the function at request/run time,
  never cache it in a module-level constant. **With the switch off the product
  must behave exactly as `main` does today**: same screens, same messages, same
  tasks, same query results. This includes the interim suppressions in WP-01.
  Pages that need the flag get it from the server (see `docs/au-gp/CONVENTIONS.md`
  once WP-02 has written it); never hard-code it on in a page.
- **Existing doctors are untouched.** A doctor with no pathway recorded is an
  overseas doctor and must see, receive and trigger exactly what they do today,
  switch on or off. Every package needs a regression test proving this for the
  code it changed.
- **Unknown fails closed.** Regulatory rules are unconfirmed. Where a rule
  decides what a doctor may be shown or apply for, take the restrictive option
  when the answer is unknown (for example unknown 19AB status sees only DPA
  roles), and keep the rule in one place so it is easy to correct. An unknown
  pathway must never fall into the Australian path by accident, and an
  Australian doctor must never fall into the overseas path by accident.
- **Database changes are additive only**: new nullable columns, new tables,
  constraints widened to allow new values. Never drop, rename or narrow
  anything; never rewrite existing rows. Write migrations as files under
  `supabase/migrations/` (idempotent: `add column if not exists`, etc.).
  **Do not apply any migration to any Supabase project.** The lead asks the
  owner for that go-ahead once, at the end. Live constraint definitions for
  case stage and task type are recorded in `docs/au-gp/ENVIRONMENT.md` (they
  have drifted from the migration files before): widen from the LIVE list.
- **Missing columns fail whole queries silently.** Until the migrations are
  applied, production does not have the new columns. So: any PostgREST
  `select=` that names a new column must only run when the switch is on, and
  must not be added to a query that existing (overseas) features depend on
  when the switch is off. Prefer separate reads of new tables/columns over
  widening a hot existing `select=` list.
- **Send nothing real.** No real email, WhatsApp, SMS or phone call. No
  changes in DoubleTick, Retell, Meta Ads, Google Ads, Calendly, Zoom or Xero.
  No WhatsApp templates submitted. Do not call any production cron or admin
  endpoint. Tests use stubs. Things that need an outside service are written
  as files and listed as owner actions.
- **WhatsApp:** an Australian message with no approved template must fall back
  to email or be skipped, never sent through an overseas template.
- **Hazel (AI caller) must never ring an Australian-segment lead.** The AU
  script is a file only; nothing is published to Retell.
- Read-only access to production data is fine for checking shapes and counts.
  Never print personal data into reports, logs or files.
- Test identities must be obviously fake (e.g. `Dr Test Auvr`,
  `au.vr.test@gplink-test.local`, practice "Test Metro Practice (FAKE)").

## 3. Owner decisions that shape the build

1. Launch segment A (`au_vr`) completely. Build fields and safe gating for B
   (`au_restricted`) and C (`au_non_vr`, `au_registrar`). A doctor who lands in
   B or C must be handled safely and flagged to staff, never shown something
   wrong.
2. Regulatory rules unconfirmed: fail closed, one place per rule.
3. Fees: the tiers already in the 2026 practice agreement
   (`lib/agreement-variants.js`). No separate price for segment B.
4. Payment timing unchanged: the Australian fee is invoiced on commencement.
5. Non-VR placements gated off by default (a role must explicitly accept non-VR).
6. Ownership: the placing consultant owns an Australian GP until placement; an
   RSO is assigned for pre-start.
7. Hazel must not ring Australian-segment leads.
8. Application caps for Australian GPs: configurable per pathway; defaults 4
   active applications, 6 a month, 6 interviews a month.
9. Match reasons may mention the billing model (bulk, mixed, private). Never
   dollar figures or percentages.
10. Locum work is out of scope.
11. Signing metro practices is the owner's sales work.
12. Nothing goes live.

## 4. Words an Australian doctor must never see or be sent

MyIntealth, AMC, EPIC, visa, relocate / relocation, "your move", overseas,
internationally trained, GMC, SPPA, Section G, supervisor CV, "Not yet
eligible". Any of these reaching a segment A doctor (screen, email, WhatsApp,
push, bell) is a defect. Practices must never be told an Australian GP is
"internationally trained" or on the "Expedited Specialist Pathway".

Spelling: the regulator is written "Ahpra" in new Australian-facing copy.
Existing overseas copy that says "AHPRA" stays byte-identical.

## 5. What "done" means for a package

- Every finding it closes is fixed at **every** site, or explicitly deferred
  with a reason.
- The change works end to end: screen, API, database, read-back.
- New tests cover the Australian behaviour **and** the unchanged overseas
  behaviour (null pathway, switch on; and switch off).
- Existing tests that pinned the old behaviour are updated deliberately, never
  deleted or loosened to make them pass. Say which and why.
- The full suite passes, judged by the runner's own exit code. Run
  `npx vitest run > /path/to/log 2>&1; echo EXIT=$?` and read the log; piping
  to `tail` hides failures. **Known baseline on untouched main: exactly one
  failing test**, `tests/server-observability.test.js > GET /api/admin/cron-health (S4) > covers every vercel.json cron...`
  (two old `zoho-*` crons). Leave it alone; anything else red is yours.
- Every page's inline script still parses (there are tests for this; if you
  edit a page with inline script, also sanity-check it).
- `?v=` cache-buster versions are bumped on changed scripts and stylesheets,
  along with the tests that pin them (some pins are regex-escaped; grep for the
  old value across `tests/`). Known trap: the ATS css buster must be >= the
  candidates js buster.
- Add or update your rows in `docs/au-gp/coverage.md` (one row per finding ID
  and per new message N01-N22: WP, status `done` / `deferred` / `n/a`, commit,
  reason if deferred). Nothing may be silently skipped.
- Your final report to the lead, in plain English: what changed, files
  touched, tests added/changed, anything you could not do or verify, anything
  the next package needs to know, and any owner action you created. Never claim
  something works that you did not run. Say "checked by reading" vs "ran it".

## 6. Tooling notes

- Node is not on PATH: `export PATH="$HOME/gplink-tools/node-v22/bin:$PATH"`.
- Full suite takes about 2 minutes. Single file: `npx vitest run tests/x.test.js`.
- `server.js` is ~85,000 lines. Never read it whole. Grep for symbols, read
  with offset/limit. `var` declarations inside the giant `handleApi` hoist
  across the whole function: use `const`/`let` in new blocks and unique names.
- There is no jsdom. To test inline page JS, tests extract function bodies from
  the HTML (see existing tests for the pattern).
- Handover documents listed at the top of `CLAUDE.md` must be read before
  touching the areas they cover (matching, document uploads, lead ads, Hazel,
  the Overview tab, registration granted, no-shows and reminders).
- Hidden-control-character trap: after writing a regex character class, check
  the file for raw control bytes (`grep -nP '[\x00-\x08\x0b\x0c\x0e-\x1f]' file`).
- Shared code conventions for this build (helper names, where the pathway
  resolver lives, how pages learn the flag) are in `docs/au-gp/CONVENTIONS.md`.
  Reuse them; if you add a helper other packages will need, document it there.
