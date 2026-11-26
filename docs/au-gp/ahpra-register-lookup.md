# Checking a doctor on the Ahpra register, and sorting them by where they can work (WP-29)

Written 26 November 2026. Plain English first; the technical detail is at the end.

## In one minute

- When an Australian GP finishes signing up, the app can look up **that one doctor**, by the registration number they typed, on Ahpra's **public** "Register of practitioners", so nobody has to search for each doctor by hand. Staff can also press **Look up on the register** on the doctor's Ahpra check card.
- **It is switched off** until you turn it on (one setting, below). While it is off nothing is requested from Ahpra, and everything works from the doctor's own answers and what staff confirm, exactly as it would without this feature.
- What the lookup reads decides two things:
  1. **Which roles the doctor sees** (their *group*: see the table below). This is automatic and immediate.
  2. **Whether the register check is finished without a person.** Only when everything it read was clean (the list is below). Otherwise the staff form is filled in for you, with the reasons a person is needed listed at the top, so confirming is one look and one press.
- A doctor is **never introduced to a practice** on their own word alone. "Submit to practice" needs the register check to be complete (by the lookup or by a person) and, for a practice that is not in a priority area, an answer from the register or from staff that the doctor is free to work there.

## The four groups

Every Australian-pathway doctor is in exactly one group. One rule decides it (`lib/au-work-sorting.js`, the function `sortDoctorByWhereTheyCanWork`); nothing else in the app decides it.

| Group (what staff see) | Who | What the doctor sees |
| --- | --- | --- |
| **Can work anywhere** | A vocationally registered GP (specialist registration, specialty General practice) with no location limit | Every role |
| **Priority areas only (DPA)** | A vocationally registered GP who, for now, may only work in a Distribution Priority Area | Roles in a priority area only. A role whose priority-area status is "not sure" is **not** shown to them. One honest line on Careers: "You are seeing roles in areas where your registration lets you work. If you think this is wrong, message us." |
| **Registrar: not placed** | Says they are a GP registrar (in training) | No roles. "We place fully qualified GPs" on the finish screen, home, Careers and in their email. Staff are not asked to review them. |
| **Non-VR: held** | Not vocationally registered and not a registrar (this includes limited and provisional registration) | No roles, the "we are confirming your details" card, as before |

On top of the group a doctor can be marked **Needs a person**. Then they see priority-area roles at most, and **nothing at all** when the number was not found, the name on the register does not match the account, or the register does not say "Registered".

**Supervision never hides a role.** Every GP Link practice accepts supervised doctors, so a supervision requirement is shown to staff as a fact ("Supervision required: Indirect 2") and nothing more.

## Where the answer comes from (best first)

1. **What staff have confirmed.** A staff 19AB answer (on the candidate page, "Section 19AB") wins over everything, both ways, and is recorded with who and why.
2. **The register**, when a lookup worked **and the name on the register matches the account** (the same name check the app uses for documents: the surname must match in full).
3. **The doctor's own answers** at sign-up.

When the register and the doctor disagree, **the more restrictive answer applies** until staff decide, and staff are shown the disagreement.

**Seeing is not the same as being introduced (changed 26 November 2026).** The register never shows whether 19AB applies, so "can work anywhere" always leans on something the doctor told us: their answer that 19AB does not apply (an Australian or New Zealand graduate), or that they are a citizen or permanent resident (a doctor who trained overseas more than ten years ago). That is enough for what the doctor **sees** and for **applying**. It is **not** enough to introduce them to a practice outside a priority area: "Submit to practice" refuses until a staff member confirms 19AB, the application shows an amber line ("19AB not yet confirmed by staff: confirm before introducing to this practice."), and a task, **"Confirm 19AB with the doctor"**, is open until someone does. Staff are told where each part of the answer came from ("Sorted from the Ahpra register lookup on …, together with the doctor's own answer that 19AB does not apply, which nobody has checked"). An introduction to a practice **in** a priority area is not affected. The one case that needs no staff answer: a person saved the register check themselves and recorded the right to work, and the doctor trained overseas more than ten years ago.

**If what the lookup found cannot be read** (a database fault), the doctor gets the careful answer, not the open one: priority-area roles at most, "needs a person", and no roles at all if an earlier lookup had put them on hold.

## The location rule (section 19AB, "the ten-year moratorium")

The owner's rule: *"if it says expedited pathway or PEP pathway and the current date is less than 10 years since their first registration … they need to work in a DPA area."* Made precise:

- Section 19AB of the Health Insurance Act limits where some doctors can work under Medicare to Distribution Priority Areas. It applies to doctors whose **primary medical degree is from outside Australia and New Zealand**, and to doctors who graduated from an Australian or New Zealand medical school but **were not a citizen or permanent resident when they began the degree**.
- It runs for **ten years from the doctor's first Australian registration**. After ten years it ends for citizens and permanent residents, but **not for temporary residents**.
- Exemptions and "scaling" (time off for working in more remote areas) exist. **The app cannot see them.** Staff can override with a confirmed 19AB answer and a reason.

How the app applies it:

| What the register shows | And | Result |
| --- | --- | --- |
| Names the **Expedited Specialist Pathway** or the **Practice Experience Program / PEP**, or the primary medical degree is from outside Australia and New Zealand | first registered **less than ten years ago** | Priority areas only. Staff see "restricted until <date>". |
| the same | first registration date **could not be read** | Priority areas only |
| the same | ten years **have passed** and the doctor is a **citizen or permanent resident** | Can work anywhere |
| the same | ten years have passed but the doctor is a **temporary resident**, or their right to work is not known | Priority areas only |
| Primary medical degree is positively **Australian or New Zealand**, neither pathway named | the doctor said 19AB **does not apply** | Can work anywhere |
| the same | the doctor said it **applies**, or **not sure**, or did not answer | Priority areas only (only the doctor can know whether they were a citizen or resident when they began the degree) |
| The primary medical degree **cannot be told** (only fellowships listed, no country) | | Priority areas only |
| **No lookup** (switched off, or it failed) | the doctor said "does not apply" | Can work anywhere, **on their own word only**: they can see and apply, but cannot be introduced to a practice outside a priority area until staff confirm |
| No lookup | the doctor said "applies" / "not sure" / nothing | Priority areas only |
| Any | the doctor is a **temporary resident** | Priority areas only, and only roles whose practice says it offers sponsorship |

**This is a simplification of the law, not legal advice. It errs to "restricted" whenever something is not known.** The ten years are counted on calendar dates (a doctor first registered on 29 February is restricted until 1 March ten years on).

How "where they trained" is worked out (changed 26 November 2026, so that it can only be wrong in the careful direction):

- Every qualification the register lists is looked at, **except college fellowships and memberships** (FRACGP, FACRRM, MRCGP and so on). Anything else may be the degree that made the person a doctor, whatever it is called ("Medico Cirujano", "Lekarz", "MBBCh", "Dr. med.", a diploma).
- A line counts as **Australian or New Zealand** only on positive evidence: it names the country, or one of its parts is, in full, the name of a medical school on a list kept in the code (`HOME_MEDICAL_SCHOOLS`). No part-of-a-name matching: "University of Newcastle upon Tyne" and "Monash University Malaysia" are not on it, and "University of Newcastle" and "University of New England" (names shared with schools abroad) count only with the country written out.
- If **any** of them is from another country, the doctor is treated as trained overseas, with or without a year, even when a later Australian "Doctor of Medicine" is also listed.
- If any of them cannot be placed, or none is a recognised first medical degree, the answer is "cannot tell" (priority areas only).
- Only when every one is Australian or New Zealand and at least one is a recognised first medical degree (MBBS, MB BS, MBChB, BMed, BMBS, "Bachelor of Medicine", "Doctor of Medicine", MD) is the doctor "trained here".

## What finishes without a person

The register check completes automatically ("verified by automatic register lookup (ahpra_public)", never attributed to a staff member) **only when all of these are true**:

- the number is on the register, and the name matches the account;
- the status is "Registered", and the expiry date has not passed;
- the registration is specialist, specialty General practice, **and the doctor said so too**;
- there is no undertaking, reprimand or notation;
- there are no conditions, **or** the conditions are the standard supervised-practice set (below);
- every one of those was read cleanly;
- **nothing has gone wrong before for this doctor**: no earlier lookup put them on hold (number not found, wrong name, not "Registered", not a specialist GP), and no person has recorded "number not matched". After any of those, a later clean lookup only fills the form in: a person presses the button. (A doctor who renames their account after a wrong-name result does not turn it into a match.)

When it completes automatically:

- the facts the register shows are saved (registration type, specialty, conditions, undertakings, notations, expiry, and the supervision it shows: "None" only when the register positively shows none, a level only when it can be read). **Fellowship, right to work and 19AB are not touched**: the register does not show them;
- the Ahpra check task is closed and a line goes on the doctor's timeline. **If 19AB still needs a person** (it rests on the doctor's word, or the doctor said "Not sure"), the task "Confirm 19AB with the doctor" is opened in its place, so the question cannot sit unseen;
- a doctor who had already said they are a VR GP, with a clean record and nothing waiting on a human decision, has that marked confirmed and is sent "Your Ahpra registration is confirmed". A doctor who answered "Not sure" is not told "everything matches": their message says the registration is confirmed and that one detail about where they can work is still to be confirmed with them;
- **what a practice is told:** the automatic check never makes the doctor's own fellowship answer a fact. A fellowship is stated to a practice only when a person saved the check, or when the register's own qualification list shows FRACGP or FACRRM (then the register's is used). A supervision requirement the register shows is said in plain words ("works under supervision"), never in the register's own text;
- **the doctor's segment is never changed by the lookup**, and it never lifts a hold that needs a person;
- the staff flags are still raised (supervision, approved practice locations).

Everything else stays open for staff, with the form filled in and the reasons listed:

| What was found | What happens |
| --- | --- |
| Number not found | Not verified. The doctor is shown no roles until a person has looked. |
| Name on the register does not match the account | Not verified, nothing is filled in, a warning is shown. The doctor is shown no roles. |
| Status is not "Registered" | Not verified. The doctor is shown no roles. |
| Expired | Not verified. Priority-area roles at most. |
| Not specialist GP, though the doctor said they were (or the other way round) | Not verified. Held as non-VR until a person decides. |
| An undertaking, a reprimand or a notation | Not verified. Priority-area roles at most. |
| A condition that is not the standard supervised-practice set | Not verified. Priority-area roles at most. |
| Part of the page could not be read | Not verified. Priority-area roles at most. |
| The lookup failed (no answer, refused, a page in another layout) | **Nothing changes at all.** Staff check by hand. |

### The standard supervised-practice conditions

A doctor who came through the Expedited Specialist pathway is given the same three numbered conditions (taken from the real page in the owner's example):

1. "Complete supervised practice for suitability and eligibility …"
2. "Complete multi-source feedback for medical practitioners …"
3. "Complete board-directed program of education …"

A conditions block counts as "standard" only when **every line of it is recognised** (changed 26 November 2026): the Board's opening sentence, one of those three headings, or a sentence that appears under that heading in the standard text (`STANDARD_CONDITION_TEMPLATES`, 28 sentences). Dates and numbers may differ from doctor to doctor; nothing else may. An extra condition with no number or with a letter, different wording under a standard heading, a standard heading with nothing under it, or anything after the set, needs a person. This is strict on purpose: if Ahpra rewords the standard text, doctors will be handed to staff until the list is updated, never passed by mistake.

## Flags staff see (they never change what the doctor sees)

- **Supervision required**, with the level the register shows.
- **Registration is tied to approved practice locations: a move needs a new Board approval for the new practice.** "Submit to practice" reminds staff of this in its confirmation; it does not block.
- **Temporary resident: needs the new practice to sponsor them or take over the nomination.**
- **The ten years from first registration end on <date>**, for a doctor who is restricted and a citizen or permanent resident, so staff know when they open up.
- The basis line: "Sorted from the Ahpra register lookup on <date>" or "Sorted from the doctor's own answers, not yet checked" or "Sorted from what staff confirmed".

## Turning it on and off

One environment setting, `AHPRA_LOOKUP_PROVIDER`:

| Value | What it does |
| --- | --- |
| `none` (the default, and what an unknown value means) | Off. Nothing is requested and stored lookups are no longer read, so nothing the register said can open anything. **This is the kill switch for new lookups. It does not release anyone** (changed 26 November 2026): a doctor a lookup put on hold, or limited to priority areas against their own answer, stays that way until a person decides (the hold is written on the doctor's own record, not only in the stored lookup). Staff see "An earlier register lookup put this doctor on hold … The automatic lookup is switched off now". Checks the lookup already completed stay completed. |
| `fixture` | For the local test stack and tests: made-up numbers answered from made-up pages (see `TESTING.md`). No network. **Refused in production** (`NODE_ENV` or `VERCEL_ENV` = `production`): it then behaves as `none` and says so once in the log. |
| `ahpra_public` | The real public register. |

Turn it on in **Preview first**. It also needs the Australian switch (`AU_PATHWAY_ENABLED`) to be on.

## Limits you should know about

- **It reads a public web page, and that page can change.** If the layout changes, the lookup reports "unrecognised page" and changes nothing; staff check by hand until the code is updated.
- **Ahpra has objected to bulk automated collection of the register and bars commercial reuse of register data.** This feature is one lookup per onboarding doctor, with the number they gave us, to check what they told us; it is never run in bulk, never run over a list of numbers, and nothing it reads is republished. Whether that is acceptable to Ahpra is a judgement for the owner (see the owner actions). **The durable route is Ahpra's contracted service, the Practitioner Information Exchange (PIE)**, which needs a signed data agreement and fees.
- **The site carries bot-protection software** (an F5 script and Cloudflare). On 25 November 2026 ordinary requests were answered normally with no challenge. If it ever answers with a challenge, a CAPTCHA, a login or a refusal, the lookup **stops** ("blocked") and never tries to get around it.
- **It runs when the doctor finishes signing up, and the sign-up waits for it** (changed 26 November 2026; up to about ten seconds, usually much less). The finish screen and the "profile complete" email therefore follow what the register showed: a doctor it put on hold sees "Thanks, we have your details", never "You're all set". Staff can run it again with the button.
- **A lookup that did not finish is owed, not lost.** Before asking, the app notes that a lookup is owed; if the attempt is cut short, is rate limited (a second doctor inside four seconds) or times out, the scheduled Australian job tries again, three attempts in all. Until then the Ahpra check card says "Lookup not run yet". A refusal ("blocked") or an unrecognised page is never retried automatically.
- The same number is not looked up twice in 24 hours unless staff press the button; all lookups together are paced to about one every four seconds per server; each has eight seconds in total and at most one retry (only for a network slip).
- The register does **not** show: fellowship, right to work, or whether 19AB applies. Those still come from the doctor and from staff.

## For engineers

| Thing | Where |
| --- | --- |
| The rule | `lib/au-work-sorting.js`: `sortDoctorByWhereTheyCanWork({ registerFacts, doctorAnswers, staffConfirmed, now })`, `registerDerivedRestrictions(facts, now)`, `classifyConditions(text)`, `sortingInputsFromRecords(...)`. Table of cases: `tests/au-wp29-work-sorting.test.js`. |
| Where it is read | `lib/candidate-pathway.js` `auSortingFor` → the resolver result's `sorting`, `dpaRestricted`, `selfServiceHeld`, `holdKind`, `roleFit`. `lib/role-eligibility.js` `roleEligibilityFor`, `auIntroductionBlock`, `auApplicationLocationFlag`. |
| The lookup | `lib/ahpra-register-lookup.js`: `lookupRegistration(number, opts)`, `parseRegistrationDetailsHtml`, `parseSearchResultsHtml`. Fixture pages: `lib/ahpra-register-fixtures.js`. Saved real pages with the personal details replaced: `tests/fixtures/ahpra-register/`. |
| How the public search works | `GET /Registration/Registers-of-Practitioners.aspx` (cookies) → `POST /Registration/Registers-of-Practitioners` with the search form (`name-reg` = the number); the results page has `id="SearchResultsPage"` and a row `data-practitioner-row-id="MED…"` → `POST` the same form with `practitioner-row-id` = the number for the "Registration Details" page. Ordinary form posts; no token. Posting the details request for a number with no row answers with a redirect to an error page, so the search step is never skipped. |
| Server | `auRunRegisterLookup` (the one place a lookup is started: `onAuOnboardingCompleted`, awaited; `POST /api/ats/candidate/register-lookup`; and `auRetryOwedRegisterLookups` from `runAuLifecycleSweep`), `auAutoCompleteRegisterCheck` → `recordAhpraRegisterCheck({ auto: true })`, `auRegisterLookupStaffView`, `auEnsureConfirm19abTask` / `auCloseConfirm19abTasks` (a `followup` task with `source_trigger = au_confirm_19ab`). |
| Where the result is kept | `runtime_kv`, key `au_register_lookup:<user id>` (server-only: no row policy, no public grants). Read only while a provider is switched on; a failed read is `{ unreadable: true }`, never "none". **A hold** is also written on `gp_credentials.ahpra_last_checked_by` as a suffix, ` (lookup hold: <code>)` (`auWorkSorting.lookupHoldMark`; codes `not_found`, `name_mismatch`, `not_registered`, `not_specialist_gp`, `restricted_19ab`), so it is read with the credentials and survives the provider being off. A person's saved check writes their plain name there, which is what releases it. No migration. |
| Audit | A timeline entry on the doctor's case for every lookup (`metadata.register_lookup`); `admin_ahpra_register_lookup` in the admin audit log when staff press the button. |

### Where a PIE provider plugs in

Add a third branch in `lookupRegistration` (`AHPRA_LOOKUP_PROVIDER=pie`) that returns the same shape the parser returns: `{ ok: true, found: true, facts: { found, number, name, status, registrationType, specialty, specialistGp, expiry, firstRegistrationDate, conditions: { present, text }, undertakings, reprimands, endorsements, notations, requirements: { supervisionRequired, supervisionLevel, pathway, position, approvedLocationsOnly, workplaces, commencement, raw }, qualifications: [{ title, institution, country, year }], parseWarnings: [], fetchedAt, source: 'pie' } }`, `{ ok: true, found: false }` for a number not on the register, and `{ ok: false, reason }` for a failure. Nothing else has to change: the rule, the storage, the staff card and the automatic completion all read that shape. It was not written because it cannot be tested without a signed Ahpra data agreement.

## FR-9 finishing pass (26 November 2026)

What changed after the first FR-9 commits, in plain words:

- **A hold also covers "something a person must see".** If the lookup finds an
  undertaking, a reprimand, a notation, a condition that is not the standard
  set, an expired registration or a page it could not read with confidence,
  that is now written on the doctor's own record too (hold code
  `register_flags`). Switching the lookup off, or a later clean lookup, no
  longer gives that doctor every role again: priority-area roles at most until
  a person saves the check.
- **A later hold withdraws an earlier automatic "verified".** If a lookup once
  completed the check by itself and a later one finds the number missing, a
  different name, not "Registered", or not a specialist GP, the automatic
  verification is taken back (a person's never is) and the doctor cannot be
  introduced to any practice, a priority-area one included, until a person
  checks. The hold no longer stamps "last checked" either: that read as "a
  person has looked" on the staff form, the pipeline and the AI's staff notes.
- **Who checked is always said.** The staff AI notes say "completed
  automatically by the register lookup; no staff member has checked it"; the
  Pathway card says "Set by the automatic register lookup (no person has
  checked)" instead of "Confirmed by staff".
- **Conditions are matched more strictly.** Each of the three standard
  headings must be exactly the Board's heading (for the Expedited Specialist
  pathway), appear once, and have every one of its standard sentences under
  it. Anything else needs a person.
- **A stored lookup that cannot be read** (failed read, or a stored record in
  a shape the app does not know) means priority-area roles at most for every
  reader, including the candidate list and matching, and even when staff have
  answered 19AB (a person's own saved check is not affected).
- **19AB "does not apply" always has a task and a reason behind it.** "Submit
  to practice" refused because 19AB rests on the doctor's word opens the
  "Confirm 19AB with the doctor" task; the 19AB-and-DPA check closes it; the
  practice is told 19AB "is being confirmed" only when that task really
  exists. Saving the register check with "19AB does not apply" now needs a
  reason in the note, as the Pathway card already did.
- **The "profile complete" email is not lost** when the lookup is still running
  at the end of sign-up: it goes when the lookup finishes, or from the
  scheduled retry, and only ever to a doctor who finished onboarding.
- **The test copy starts with the made-up lookup on** (`fixture`); start it
  with `AHPRA_LOOKUP_PROVIDER=none` to see it off. The real register can never
  be switched on from the test copy.

Tests: `tests/au-fr9b-sorting-unit.test.js` and the "FR-9 finishing pass"
blocks at the end of `tests/au-fr9-sorting-lookup.test.js`.
