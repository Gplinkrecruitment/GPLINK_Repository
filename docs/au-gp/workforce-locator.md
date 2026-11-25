# The area check: priority areas and remoteness (WP-30)

Written for the owner first. The technical detail is further down.

## What it does, in plain words

Some doctors may only bill Medicare if they work in a **Distribution Priority
Area (DPA) for GPs**. The app shows those doctors only the roles at practices
that are in one. Until now a practice typed that in itself (yes, no, or "not
sure"), which is easy to get wrong.

With this turned on, **the app looks the practice's address up on the
Government's Health Workforce Locator** and records two things on the practice:

- whether the address is in a **DPA for GPs** (yes, no, or not confirmed), and
- its **Modified Monash level**, the Government's remoteness scale from
  MM 1 (a major city) to MM 7 (very remote).

Those labels are then put on every role at that practice, so each role is shown
to the right doctors. The practice is not asked.

Nothing here is turned on by itself. It needs two settings: the Australian
switch, and a "provider" setting that says where to look (see Settings). With
either one off, the product behaves exactly as it does today and the practice
is asked the question as before.

## Where the answer comes from

| | |
| --- | --- |
| **Source** | The Health Workforce Locator, published by the Australian Government Department of Health (the tool at health.gov.au > Resources > Apps and tools > Health Workforce Locator). |
| **How it is reached** | The Locator is a web map. Behind it is a data service at `trueview.spectrumspatial.com/trueviewapi`. The app asks that service the same question the web map asks when a person clicks a point: "what is at this latitude and longitude?". The live product has asked it this way since before this work (`lib/dpa-lookup.js`). |
| **What is read** | Two things from the answer: `dpa_gps` (Y or N, plus the name of the GP catchment) and `mmm2023` (a number from 1 to 7). |
| **Which editions** | **Modified Monash: the 2023 edition**, which is the newest the service serves (it also serves 2015 and 2019; the app always uses the newest it is given, and records which). **DPA: the Department's current list.** The service does not say which year its DPA list is, so the app records the date it checked. You can set a label (for example "2026") that is stored with each check: see Settings. |
| **Sign-in, key, CAPTCHA** | None. The service hands an anonymous "guest" pass to any visitor, which is what the web map itself uses. The app does not get round any protection. (The health.gov.au web page itself did not answer an automated request when this was built; the app does not read that page.) |
| **Terms** | **Not confirmed.** The data service's answers carry no licence or terms of use, and the health.gov.au page that would state them could not be read when this was built, so nobody has checked what the Department allows. **This is an owner action** (see OWNER-ACTIONS, owner action 168): read the Department's terms (or ask them) and decide, before turning it on in production. |
| **How often it is asked** | Only when something needs classifying: a practice fills in its form, staff press Re-check or correct an address, or the CEO presses Check all practices. There is no daily job. At most 30 questions a minute from one server (a setting), with an answer remembered for a day. |

## Exact, approximate, and "not confirmed"

A priority-area boundary can run through the middle of a suburb. So the app
only believes a yes or a no when it has checked **the exact street address**.

| What the app could find | What it records |
| --- | --- |
| **Exact**: the street address, to the building, **found by the app itself** from the written address. (When the practice also picked its address from the address list on the form, that map point is used only if the app finds the same building within about 1 km of it.) | The Locator's answer: **In a DPA** or **Not in a DPA**, and the Modified Monash level. |
| **Approximate**: only the suburb, or the street but not the building. | **DPA not confirmed.** The Modified Monash level is shown to staff as "approximately MM n" and is not put on the role. What the centre of the suburb says is shown to staff as a hint only. |
| **Nothing**: the address could not be found, the Locator did not answer, or it took too long (8 seconds). | **DPA not confirmed.** Nothing already recorded is changed. |

**"Not confirmed" is the safe answer.** A role that is not confirmed is hidden
from **every doctor who may only work in a priority area**. That is the
Australian doctors with a location limit **and every doctor moving to
Australia from overseas**. Other doctors still see it. So "not confirmed" is
not harmless: it is on a to-do list for staff until someone settles it (see
"What staff see"). The app never turns an unknown into a yes. The costly mistake is telling a restricted doctor a
practice is in a priority area when it is not, so that is the one the design
refuses to make.

Three more safety rules:

- **A map point sent with the address is only the browser's word.** It is
  believed only when the app's own address search finds the same building
  within about 1 km of it. Otherwise the point is ignored and the app works
  from the written address by itself: exact if it finds the building, not
  confirmed if it only finds the street or the suburb, not found if it finds
  nothing. (Before the round-12 fix a point with any "place id" was believed
  when the address search could not find the street, so a hand-crafted save
  could get a practice recorded "In a DPA".)
- **A label is about an address.** When a practice's or a role's address
  changes, the old label does not come with it. If the new address is answered
  exactly, the role takes that answer. If it is not (only the suburb is found,
  or the check fails), the role becomes **not confirmed** and its old Modified
  Monash level is removed. This also applies to a label typed before this
  check existed and to a value set by hand for the old address: the hand-set
  value is put aside, staff are shown a note saying so, and a person sets it
  again if it still applies. A value set by hand **after** the address change
  is kept as always.
- **Latitude 0, longitude 0 is not a place.** The live form stores a
  hand-typed address that way; this check ignores it (and any point outside
  Australia) and uses the written address.

## What a practice sees

On the form a practice fills in, after it gives its address, it is shown what
was found and is not asked to answer:

- "Your practice is in a Distribution Priority Area for GPs · Modified Monash 3"
- "Your practice is not in a Distribution Priority Area for GPs · Modified Monash 1"
- "We'll confirm your area with you" (when the app is not confident)

When the app is not confident the practice is also told what that means:
"We could not match your exact address automatically, so our team will check
it and confirm with you. Until they have, your role is not shown to doctors
who may only work in a priority area (that includes doctors moving to
Australia from overseas). Other doctors can still see it." (It used to say
"This does not hold anything up", which was not true.)

Under it is a small link, **This looks wrong**. It sends a note to staff: the
practice then appears on the **Area: needs a person** list at the top of the
Practices tab, with the practice's own words, until a named staff member
presses **Mark as looked at**. It does not change the answer. Nothing typed into the form, and nothing a
tampered browser sends, can set the answer: the server works it out again from
the address when the form is saved.

On the employers page of the website, the "check your area" step uses the same
look-up. A suburb is not an exact address, so what it shows there is what the
suburb suggests (as it always has been), and the practice is recorded as "not
confirmed" until its street address is checked on the form.

## What staff see

**On a practice** (CEO dashboard > Practices > open a practice): a card called
"Area: priority area and remoteness" showing

- the DPA status, and under it, when it is not confirmed: *Not confirmed:
  hidden from every doctor who may only work in a priority area (that includes
  doctors moving to Australia from overseas) until it is confirmed*;
- the Modified Monash level in words, for example "Large rural town (MM 3)";
- who set it (the automatic check, or a named person), how confident the check
  was, the source, the edition, the date, and the address that was checked;
- every role at the practice with its own label and where that came from.

A practice nobody has checked yet says **Area not checked yet** (and what was
recorded on it earlier, if anything). That is different from "not confirmed":
nothing has been asked, and its roles keep the labels they already have until
someone presses Re-check or Check all practices.

**Area: needs a person** (top of the Practices tab, everyone who works
practices sees it). A red list of every practice whose area is waiting for
somebody, in words. A practice is on it when: it is not confirmed and has at
least one role (those roles are hidden as described above); the practice
pressed "This looks wrong"; the automatic check and a value set by hand
disagree; or a value set by hand was put aside because the address changed.
Pressing a line opens the practice. A line leaves the list by itself when the
thing is settled. This list is the staff to-do for the area check: the app has
no task that is not attached to a doctor, so it does not appear in the task
queue (see "Known limits").

Buttons on that card:

- **Re-check** looks the address up again.
- **Correct the address…** replaces the address on file and checks the new one.
  The roles that were at the old address move with it.
- **Set by hand…** for when you have confirmed the answer yourself. It asks for
  a reason. Your name, the date and the reason are kept.
- **Remove the value set by hand** goes back to the automatic answer.
- **Mark as looked at** (only when the practice has told us its area looks
  wrong) records that you have checked it, with your name. Check the address
  first (Re-check, Correct the address or Set by hand).

Whatever staff do on this card (re-check, a corrected address, a value set by
hand or removed) also updates the practice's own stored answer, so a new job
and every other screen say the same thing, including after the check is
switched off.

**When two answers differ.** A value set by hand is never replaced **for the
address it was set for**. If the automatic check later says something different, a red banner shows both
answers, both dates and who set the manual one. The manual value stays in use
until a person removes it.

The same applies to a role whose label was recorded **before** this check
existed (a job staff or a practice labelled in the past). If the check
disagrees with it, the role is **not changed**: it gets a red "Two different
answers" note with two buttons, **Use the check's answer** and **Keep this
role's value…** (which asks for a reason). This is deliberate: nothing a doctor
can see changes until a person has looked.

**On a job** (Jobs > open a job > Job settings): the same labels for that role,
where they came from, and a Re-check button. Changing "DPA status" or "Modified
Monash" there and saving sets that role by hand: **a reason is required**
(without one nothing is saved), and your name and the reason are recorded.
Choosing **Not recorded** hands the role back to the automatic check: it
follows the practice (or its own address) again, and no reason is needed. A job at a different address from its practice is checked on its
own address.

**When approving a job**: the labels are shown, and if the priority-area status
is not confirmed (or two answers are unsettled) you are warned and asked to
confirm before it goes live.

**Check all practices** (CEO only, at the top of the Practices list) walks
every practice a few at a time and finishes with a summary: how many changed,
were unchanged, were not confident, disagreed with a value set by hand, or
could not be checked; and how many roles were updated or need a decision. It
never replaces a value set by hand and it is safe to run again.

## What doctors see

Nothing new is added to any doctor's screen by this work. Doctors on the
Australian view already see a role's area as, for example, "Regional (MM3)";
that now comes from the checked value. What changes is **which** roles a
restricted doctor is shown, and only through the labels on the role.

Doctors moving from overseas are filtered by the same "in a DPA" label, so its
accuracy affects them too. Two protections: a failed check never removes a
label that was already there, and a check that disagrees with a label recorded
earlier changes nothing until staff decide.

## When it fails

- The Locator does not answer, or is slow: the earlier answer stays. Staff see
  "Last check failed … The earlier answer was kept."
- The address cannot be found: the practice is "not confirmed" and staff are
  told why. Correct the address, or set it by hand.
- The address was changed and the new one cannot be checked: the answer for
  the **old** address is not carried over to the new one. The practice becomes
  "not confirmed" until it is checked or set by hand.
- To switch the whole thing off at once: set the provider to `none`. Nothing is
  looked up, the practice is asked the question again, and every label already
  recorded stays as it is.

## How to re-check each year

The Department updates the DPA list about once a year. When it does:

1. (Optional) set `AU_WORKFORCE_LOCATOR_EDITION` to the new year, so each check
   records it.
2. CEO dashboard > Practices > **Check all practices**.
3. Read the summary and open the practices listed under "Needs a look".

## Settings

| Setting | Values | What it does |
| --- | --- | --- |
| `AU_PATHWAY_ENABLED` | the one Australian switch | Off: none of this exists. |
| `AU_WORKFORCE_LOCATOR_PROVIDER` | `none` (default), `fixture`, `health_gov` | `none`: off, no network. `fixture`: a small built-in test map, used by the tests and the local test stack, never the real service. **`fixture` is refused in production** (`NODE_ENV=production` or `VERCEL_ENV=production`, which is every Vercel deployment): it is treated as `none` and one line is logged. `health_gov`: the real Locator. Anything else is read as `none`. |
| `AU_WORKFORCE_LOCATOR_EDITION` | free text, for example `2026` | A label stored with each check as the DPA year. Changing it also makes the server ask again instead of using a remembered answer. |
| `AU_WORKFORCE_LOCATOR_MAX_PER_MINUTE` | 1 to 600, default 30 | The most questions one server asks in a minute. Past it, a check is "could not be completed" and nothing changes. |
| `AU_WORKFORCE_LOCATOR_GEOCODER` | unset (default), `google`, `none` | How a written address is turned into a map point when the practice did not pick it from the list. Default: the keyless OpenStreetMap search the app already uses for suburbs. `google`: Google's Geocoding service with `GOOGLE_MAPS_SERVER_API_KEY` (better at finding the building; the Geocoding API must be enabled on that key). `none`: do not look addresses up; only addresses picked from the list can be exact. |

**After the check is switched off** (`none`) a practice it checked earlier is
shown to staff as "Checked automatically on <date>; the check is now off"
(or "Set by hand on <date>…"), never as "Practice answered: Not sure": that
practice was never asked.

The local test stack sets the provider to `fixture` by itself. Start it with
`AU_WORKFORCE_LOCATOR_PROVIDER=none scripts/au-local/start.sh` to see the
product with the look-up off.

---

# Technical reference

## Files

| What | Where |
| --- | --- |
| The look-up (the one module) | `lib/au-workforce-locator.js`: `classifyLocation`, `validAuPoint`, `resolvePoint`, `parseLocatorResponse`, `addressKey`, `mmmWords` |
| The request to the service | `lib/dpa-lookup.js`: `fetchHwlPoint` (the existing request, split from its parser; `lookupDpa` is unchanged in behaviour) |
| Test map | `lib/au-workforce-locator-fixture.json` |
| What is pinned, and how a role follows (pure) | `lib/au-practice-area.js`: `effective`, `applyLookup`, `applyManual`, `clearManual`, `addDispute`, `roleSite`, `roleDecision`, `roleManual`, `intakeFieldsFor`, `practiceFinding`, `staffView`, `staffRoleView` |
| Glue | `server.js`: `auAreaOn`, `auAreaClassify`, `auAreaCompute`, `auAreaWriteRecord`, `auAreaSyncOneRole`, `auAreaSyncRoles`, `auAreaCheckPractice`, `auAreaForNewJob`, `auAreaEditorView` |
| Staff screen | `js/au-practice-area.js` (`window.GPAuArea`), hooked from `js/ceo-ats-practices.js` and `js/ceo-ats-jobs.js` |
| Practice form | `pages/practice-intake.html`, the "WP-30" block inside the final `au:on` block |

## `classifyLocation(input, opts)`

`input`: `{ address, suburb, state, postcode, latitude, longitude, placeId }`.
Returns (never throws):

```js
{ ok, provider, dpaGp: 'yes'|'no'|'unknown', mmm: 1..7|null, mmmApproximate,
  confidence: 'exact'|'approximate'|'none', method, classificationYear: { dpa, mmm },
  checkedAt, pointUsed: { lat, lng, source }|null, catchment, warnings: [], indicative?: { dpaGp, catchment }, error? }
```

`method` / `pointUsed.source`: `selected_address` (the point that came with an
address picked from the list, after it was checked against the written
address), `geocoded_address` (the server found the building), `street_centroid`,
`suburb_centroid`. `dpaGp` is `yes` or `no` **only** when `confidence` is
`exact`; for an approximate point the centre's answer is in `indicative` and is
used for wording only.

Budget 8 seconds in total (`TOTAL_BUDGET_MS`), one retry of the Locator request
(with a fresh guest pass), a cache keyed by provider, edition label and the
point rounded to four decimal places (24 hours, 500 entries, per server
instance), and a sliding one-minute rate limit. Failures are not cached.

## What is stored (no new column, no migration)

`practices.metadata.au_area`:

```js
{ v: 1,
  lookup: null | { dpa, indicative_dpa, mmm, mmm_approx, confidence, provider, method, year: { dpa, mmm },
                   point: { lat, lng, source }, checked_at, catchment, warnings: [], address_key },
  manual: null | { dpa, mmm, reason, by, at, address_key },
  stale_manual: { ...manual, dropped_at },   // FR-9: a hand-set value that was for a different address; decides nothing
  last_attempt: null | { at, ok, error, confidence, trigger, by },
  disputes: [ { at, note, resolved_at?, resolved_by? } ] }   // "This looks wrong", the last five; open until marked as looked at
```

`career_roles.source_payload.au_area`:

```js
{ site: 'practice' | 'own', follows: true|false, status, mmm, set_by,
  address_key,                                  // FR-9: the address these labels are about
  manual: null | { dpa, mmm, reason, by, at, address_key },
  disagreement: null | { lookup: { dpa, mmm, at, set_by }, recorded: { dpa, mmm, by?, at? }, kind: 'recorded_before'|'manual'|'address_changed', at },
  own: { ...a record of the same shape as the practice's, for a role at its own address } }
```

The values a doctor is filtered by are the **existing** `career_roles.dpa`
(boolean: all the overseas rule reads), `career_roles.dpa_status` (WP-08:
`yes` / `no` / `unknown`) and `career_roles.mmm` (`MM1` … `MM7`). The rule that
reads them, `lib/role-eligibility.js`, is not changed by WP-30.

**Who else writes these two JSON columns (FR-9, M9-02).** `updateCareerRoleRow`
(the shared writer behind the role-page enrichment: when a doctor opens a role
and the cached AI profile, website billing or hero image is due, on `main`
too) rebuilds `source_payload` as `{ zoho, gpLink }`. It now carries
`au_area` and `au_intake` over untouched (`keepAuOwnedSourcePayloadKeys`); a
row with neither key gets exactly the body it always got. Every other writer
of `career_roles.source_payload` (`atsUpdateJobRow` callers in the job editor,
the area routes, the AI write-up) and of `practices.metadata` (intake save,
agreement signing, intake-token and lead writes, `auAreaWriteRecord`) spreads
the existing object first. That enrichment write is not new and was not
removed: it is how `main` caches what it fetched.

## The rules, each in one place

| Rule | Home |
| --- | --- |
| What counts as coordinates | `validAuPoint` |
| Which point stands for an address, and exact vs approximate | `resolvePoint` |
| Only an exact point says yes or no | `classifyLocation` |
| The status of a practice from its record | `effective` |
| A failed look-up changes nothing for the same address; a weaker answer never replaces a stronger one; a changed address does not inherit the old answer | `applyLookup` |
| A manual value is never replaced for the address it was set for, only disagreed with; one set for a different address is put aside (`stale_manual`) | `effective` (the disagreement), `applyLookup` |
| Are two address keys the same place (a postcode only added or dropped is not a move) | `sameAddressKey` |
| A label is about an address: what a role becomes when its address changes | `roleDecision` (`ctx.addressKey`, `ctx.addressChanged`; the role's own `address_key`) |
| A browser's map point is believed only when the server finds the same building itself | `resolvePoint` |
| What is waiting for a person on a practice's area | `needsPerson` |
| A hand-set value on a role needs a reason | `manualReasonError` (the job editor's `PATCH /api/ats/job` refuses with `au_area_reason_required`) |
| What staff read once the check is off | `autoCheckedNote` |
| The practice's own stored answers follow the record | `server.js` `auAreaWriteRecord(..., { syncAnswers: true })` |
| The `fixture` provider is refused in production | `lib/au-provider-guard.js` `guardProvider` (used by `providerName`) |
| Is a role at its practice's address | `roleSite` |
| Whether and how one role follows | `roleDecision` |
| Nothing the browser sends sets DPA or MMM | `server.js`, `POST /api/practice-intake` (`auAreaOverrideClinicBody`, then `intakeFieldsFor` once the row is known) |
| Is any of it on | `auAreaOn()` = the Australian switch AND provider is not `none` |

## Routes (all absent unless `auAreaOn()`)

| Route | Who | What |
| --- | --- | --- |
| `POST /api/practice-intake/area` | a practice with its form link (token) | `{ token, address, suburb, state, postcode, latitude, longitude, google_place_id }` → `{ ok, finding: { state, line, note? } }` (`note` only when not confirmed: what that means for the role). Stores nothing. 40 an hour per address, 60 an hour per link. |
| `POST /api/practice-intake/area-note` | the same | `{ token, note, clinic }` → the note is added to the practice's record as an OPEN item (it is on the "needs a person" list). 10 an hour. |
| `POST /api/ats/practice/area` | CEO, consultants | `{ id, action: 'recheck' | 'set_address' | 'manual' | 'clear_manual' | 'dispute_done', … }` → `{ ok, outcome, au_area, au_area_roles, roles }`. 60 actions per 10 minutes per person. |
| `POST /api/ats/job/area` | CEO, consultants | `{ id, action: 'recheck' | 'use_lookup' | 'keep', reason? }` → `{ ok, outcome, job, editor }`. |
| `POST /api/ats/practices/area/check-all` | CEO | `{ cursor, limit (1 to 5) }` → `{ ok, done, next_cursor, phase, total_practices, position, items }`. Call again with `next_cursor` until `done`. |

Existing routes that gain keys when `auAreaOn()`: `GET /api/practice-intake`
(`practice.au_gp.locator = { on: true }`), `GET /api/ats/practices` (`au_area`
on each card, including `needsPerson`), `GET /api/ats/practice`
(`practice.au_area`, `au_area_roles`),
`GET` / `PATCH /api/ats/job` (`editor.au_area`), `GET /api/public/practice-dpa`
(`confidence`).

With the switch on and the provider **off**: on `GET /api/ats/practices`,
`GET /api/ats/practice` and `GET /api/ats/job`, a practice or role that has an
area record gets `dpa.autoChecked = { at, note }` and an empty
`dpa.practiceAnswer` in the WP-23 summary (`au_gp.dpa` / `editor.au_intake.dpa`).
A practice with no record is unchanged. `PATCH /api/ats/job` with the provider
on refuses a hand-set DPA status or Modified Monash level without
`au_area_reason` (400, `code: 'au_area_reason_required'`).

## Audit

Every classification writes one row to `admin_audit_log` (the existing
`logAdminAction`): practice id, old value → new value, method, confidence,
provider, year, time, what triggered it, and who (a staff email,
`practice_intake`, `practice_lead` or `system`). Actions:
`admin_au_practice_area_check`, `admin_au_practice_area_manual`,
`admin_au_practice_area_manual_cleared`, `admin_au_practice_address_set`,
`admin_au_practice_area_disputed`, `admin_au_practice_area_dispute_looked_at`,
`admin_au_practice_area_check_all`,
`admin_au_role_area_applied`, `admin_au_role_area_disagreement`,
`admin_au_role_area_manual`. `admin_au_role_area_applied` carries
`address_changed` and `hand_value_put_aside`.

## How the source was investigated (2026-11-25)

Seven requests in total, a few seconds apart, one at a time, with a plain
generic user agent: two to the health.gov.au page (neither answered: a
connection error, then a timeout; not pursued), one for a guest pass, and four
point questions (Dubbo NSW, Parramatta NSW, Tennant Creek NT, and a point in
the Tasman Sea). Results: Dubbo is DPA, MM 3; Parramatta is not DPA, MM 1;
Tennant Creek is DPA, MM 7; the sea has no classification. Those four answers,
with the map shapes removed, are `tests/fixtures/au-wp30-locator-responses.json`,
and they are the "verified" entries of the test map. The service returns no
boundary shape for the DPA layer, which is why a suburb cannot be proved to lie
wholly on one side and stays "not confirmed".

The service offers layers the app does not read: `dpa_bmp` (the Bonded Medical
Program's DPA), `dws_all` (District of Workforce Shortage by specialty), the
ASGS Remoteness Areas and older schemes.

## Known limits

- **Terms of use are not confirmed** (owner action).
- **The DPA year is not stated by the source.** The app records the date of the
  check and an optional label.
- **Finding a building from a hand-typed address** depends on the address
  search. The default (OpenStreetMap) knows fewer Australian house numbers than
  Google; an address it cannot find to the building is "not confirmed" and
  staff set it by hand or correct it. Addresses picked from the list on the
  form do not have this problem.
- **A point picked from the list is not trusted by itself** (round-12 fix). It
  is used only when the address search finds the same building. So with the
  default address search (OpenStreetMap), which knows fewer Australian house
  numbers than Google, more real practices will read "not confirmed" until
  staff confirm them. Turning on `AU_WORKFORCE_LOCATOR_GEOCODER=google`
  reduces that.
- **There is no staff task for a practice.** Every task in the app belongs to
  a doctor's case (`registration_tasks.case_id` is required). The area check's
  to-do is the "Area: needs a person" list on the Practices tab and the red
  chips on each card; nothing appears in the Ops task queue. A task table for
  practices would be a database change (not made).
- **A role opened by a doctor has its job-form answers moved one level down**
  in the stored JSON (`source_payload.zoho.intake`): that is `main`'s
  enrichment and was not changed. The staff "What the practice told us" panel
  now reads them from there. Other readers of `source_payload.intake` and
  `source_payload.practice_intro` on `main` behave as they do on `main`.
- **An address re-typed differently** (for example "St" instead of "Street")
  counts as a changed address. If the new spelling cannot be found to the
  building, the role becomes "not confirmed" until staff re-check or set it.
- **A practice record that stands for a corporation** (head office) is never
  followed by its roles: each role is checked on its own address.
- **A role with only a suburb** (no street address) at a different suburb from
  its practice can only be "approximate", so its recorded label is kept and
  staff decide.
- **A "not confirmed" role created from the form is titled "Non-DPA - …"**, as
  it was for a practice that answered "Not sure" (WP-23 known limit): the title
  is built from yes / not-yes. It is pending until staff approve, and approval
  warns.
- **The live form still stores a hand-typed address as latitude 0, longitude 0**
  (a bug on `main`, not changed here). This check ignores that point.
- **Remembered answers and the rate limit are per server instance.**
- **One form, at most twelve look-ups.** A form that lists more than twelve
  clinics has the rest recorded as "not confirmed" for staff to check.
- **A doctor's Careers page keeps a remembered copy of the role list for a
  short while** (existing behaviour, not changed here). Seen on the real-browser
  check: straight after staff changed a practice to "not confirmed", the
  doctor's first reload still drew the old card; the next reload did not.
  Opening a role or applying always asks the server, which refuses.
- **The two older staff notes "the practice was not sure" and "the practice
  and the look-up disagree"** (WP-23) are not shown for a practice whose area
  has been checked: the practice was never asked, and the Area card says what
  is known.
