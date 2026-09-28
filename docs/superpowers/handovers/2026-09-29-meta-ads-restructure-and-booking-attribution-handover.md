# Meta ads restructure + booking attribution — handover

**Date:** 2026-09-29 · **Ad account:** `1668035273758338` (AUD) · **Page:** `769864969547691`
**Code shipped:** `3eddc57` (CAPI stage feed, 14 Sep) and `781493d` (Calendly campaign
attribution, 21 Sep) — both live in production.

This covers roughly two weeks of work: diagnosing why cost per lead jumped, rebuilding the
campaign structure, shipping two pieces of app code, and setting up booking attribution.
**Sections 5, 6 and 10 are the ones to challenge** — they are judgment, and one earlier
recommendation was already wrong.

---

## 1. What is live right now

ONE campaign, **per-ad-set budgets** (no campaign budget — that is deliberate, see §4.1):

`GP Link UK | Cold · Warm · Hot | 14 Sep 2026` — campaign `120248645727400648`,
objective OUTCOME_LEADS, Employment Special Ad Category for GB.

| Layer | Ad set | Goal | Budget | Status |
|---|---|---|---|---|
| Cold | `Cold · UK GPs · Calendly form – Copy` `120248648851520648` | LEAD_GENERATION, instant form `1065996865920792` | AU$70/day | ACTIVE |
| Warm | `Warm \| Engaged or opened form (365d) → Calendly` `120248645741230648` | LINK_CLICKS → Calendly | AU$25/day | ACTIVE |
| Hot | `Hot \| Enquired, not signed up → app sign-up` `120248645743480648` | LINK_CLICKS → app sign-in | AU$5/day | **PAUSED** (owner, ~26 Sep) |

**Cold ads:** Ad3 `120248648851460648` (the "No QOF / No CQC / no 8am scramble" concept) and
Ad4 `120248648851440648` ("Dinner together. On a Tuesday.") are ACTIVE. Ad1 `…851400648`,
Ad2 `…851390648`, Ad5 `…851420648` are PAUSED with zero spend — they produced no leads over
weeks in the old campaign. **Leave them paused.**

**Warm ads:** `120248647442060648` (Warm 1), `120248647442450648` (Warm 2),
`120248647443260648` (Warm 3). **Hot ads:** `120248647443860648`, `120248647444490648`.
Copy and image headlines for all five: `~/Desktop/GP-Link-FB-Ads-UK/WARM-HOT-ADS.md`.

**Warm audiences** (all three OR'd together, Advantage+ audience OFF):
- `120248645460290648` Engaged with Page or its ads — **365d**, ACTIVE. This is the one
  carrying the ad set.
- `120248645431790648` Opened a lead form, didn't submit — 365d, **INACTIVE**: under Meta's
  ~1,000-person floor and widening retention cannot fix it, because both referenced forms were
  only created 21–27 Aug 2026. Harmless in an OR union (contributes zero). To revive it, add
  older form IDs as `event_sources` (e.g. `1600834014732864` from 19 Aug; the Oct-25 / Feb-26
  campaign forms have not been looked up).
- `120248308983270648` Website visitors 30d — owner-created, deliberately left at 30d.

**Hot audience:** `120248645729570648`, a customer list of 866 hashed rows uploaded 14 Sep.

**Switched off:** old campaign `120248115191810648` PAUSED 15 Sep; its ad set
`Test - adset 1` `120248382056590648` PAUSED; the old Cold ad set `120248647578840648`
ARCHIVED (spent AU$3.60). `zz UNUSED` campaign `120248645430890648` is a superseded API draft,
safe to delete.

---

## 2. What shipped in code

### 2.1 `3eddc57` — Meta Conversions API stage feed (14 Sep)
Full detail in memory `meta-capi-lead-stage-feed`. Summary: `lib/meta-capi.js` reports each
Meta lead's funnel stage to Meta keyed by the instant-form `lead_id` — `lead`, `qualified_gp`,
`call_booked`, `signed_up`. Fired from the FB webhook and from
`GET /api/cron/meta-lead-stages` (hourly, `50 * * * *`). Writes to dataset
`31126391376976338`. Stamps `metadata.consult.meta_capi.sent[stage]` only after Meta
acknowledges. Tests: `tests/meta-capi.test.js`, `tests/meta-lead-stages-cron.test.js`.

**Why it exists:** the website pixel can never drive Meta's "qualified leads" goal, because it
never sees the instant-form lead id and there is no sign-up pixel event. The 48 QUALIFIED
events that used to sit on that dataset were the owner hand-marking every form-filler in Meta
Leads Centre, which is a false signal.

### 2.2 `781493d` — a Calendly booking records which ad sent it (21 Sep)
`normalizeCalendlyBookingUtm(tracking)` in `server.js` (exported in `__testUtils`) keeps
`utm_campaign` / `utm_source` / `utm_medium` from Calendly's `invitee.tracking`, lower-cased
and capped at 120 chars. Stamped as `metadata.consult.booking_utm` by **both** booking paths:
`ensureLeadBookedCallAt(email, scheduledAt, nowIso, inviteePhone, bookingUtm)` (5th arg is
new) for a doctor who already has a lead row, and `captureCalendlyDirectBookerLead(d)` via
`d.utm` for a first-time booker. **Write-once** — Calendly replays the tracking block on every
`invitee.created`, so a reschedule must not move the credit, and an untagged booking must
never blank a stored campaign. Tests are in `tests/consult-whatsapp-followups.test.js`, which
already had the Calendly harness.

**Why this instead of a separate Calendly link** (the owner's first instinct): a second
Calendly event type would work, because `calendly_event_type_uri` is already stored on every
booking. But ad creatives are immutable, so changing Warm's destination URL means building
three new creatives and three new ads, which **restarts Warm's learning phase**. The UTM route
cost no ad changes and works for every future campaign. Calendly's API v2 also cannot create
event types, so it would have needed the owner in the UI regardless.

---

## 3. The numbers (14–29 Sep)

| Ad set | Spend | Result | Cost | CTR | Freq | Reach |
|---|---|---|---|---|---|---|
| Cold | AU$956.16 | 21 leads | AU$45.53 | 2.77% | 2.72 | 15,419 |
| Warm | AU$317.63 | 181 link clicks | AU$1.76 | 2.07% | **9.21** | 1,870 |
| Hot (paused) | AU$49.32 | 27 link clicks | AU$1.83 | 0.77% | 9.75 | 450 |

**App funnel since 14 Sep:** 23 Meta leads, **23/23 qualified GPs, 0 screened out**, 10 booked
a call, 2 app sign-ups. 11 consultations on the books (9 completed, 2 upcoming). Booking lag is
still "instant or never": five at 0.0h, then 0.1h, 3.2h, 5.3h, and one outlier at 51.8h.

**Every one of the 10 bookings traces to Cold's Ad3** (`fb_ad_id 120248648851460648`, 20 of
the 23 leads). Ad4 produced 1 lead and 0 bookings across the whole period.

⚠️ **Cold's cost per lead is deteriorating**: AU$34.13 for 14–21 Sep, then ~AU$76 for 21–26
Sep (4 leads / AU$303) and AU$76.83 for 27–29 Sep (2 leads / AU$153.65). Two consecutive
periods, so it is a trend, not noise. **No new Meta lead has reached the app since 27 Sep
07:15Z** (two days). This is the most important open question — see §10.

**Cost per booking** is roughly AU$96 on Cold against ~AU$265 historically, which is the one
clearly good outcome of the restructure. Treat it as directional: it rests on 10 bookings.

**Stage feed health:** 93 Meta leads since 1 Aug, 86 stamped, **0 errors**, every lead since
25 Sep stamped including the 27 Sep booking. The feed is not stalled — its `last_sent_at` of
27 Sep just reflects that no lead has arrived since.

**Calendly pixel** (owner saved it 23 Sep; it began firing 27 Sep): on 27 Sep Meta recorded
8 × `invitee_event_type_page`, 1 × `invitee_select_day`, 1 × `invitee_select_time`,
1 × `invitee_meeting_scheduled`. ⚠️ Those 8 page views are a **mix** of Warm clickers and Cold
form-completers, because the instant form's completion CTA also lands on Calendly. They cannot
be attributed to Warm alone.

---

## 4. Decisions taken and why — do not "fix" these back

1. **One campaign, per-ad-set budgets, no campaign budget.** A lowest-cost CBO campaign forces
   every ad set to share one optimization goal (error 1885760). Cold needs LEAD_GENERATION and
   Warm/Hot need LINK_CLICKS, so the budget must sit on the ad sets.
2. **Warm and Hot use LINK_CLICKS, not LANDING_PAGE_VIEWS.** There is no pixel on
   calendly.com (until 23 Sep) or on the app sign-in page, so landing-page-view optimisation
   had nothing to optimise against.
3. **Cold is LEAD_GENERATION, not QUALITY_LEAD.** Ads Manager duplicates of a lead-form ad set
   default to QUALITY_LEAD pointed at the dead website pixel `2269935553370606`. That happened
   twice (27 Aug and 14 Sep). QUALITY_LEAD is only correct once the Events Manager funnel is
   configured — see §7.
4. **The Employment Special Ad Category declaration stays.** It blocks occupation targeting,
   which is why leads cost AU$45 instead of the AU$14 of last year's untargeted-era campaigns.
   Removing it risks the account. The consequence is that **ad copy must self-select**: only a
   GP knows what QOF, CQC or the 8am scramble means. That is why Ad3 works and Ad4 does not.
5. **Calendly's pixel points at dataset `31126391376976338`**, not the older
   `2269935553370606`, so all conversion signal sits with the CRM stage feed in one dataset.
   Trade-off accepted: Calendly visitors do not flow into the "Website visitors 30d" audience.
6. **`booking_utm` is write-once.** See §2.2.
7. **No AI-content disclosure on the Higgsfield creatives** — owner's explicit decision, 14 Sep.

---

## 5. Where I was wrong — corrections already applied

Read these before trusting §6.

1. **I declared the Calendly pixel broken three days after the owner saved it.** On 26 Sep I
   reported zero browser events and listed three things to fix. It started working on 27 Sep
   on its own. The data was right — re-querying 23–26 Sep today still returns nothing, so it
   was neither lag nor a booking-volume artefact — but the **verdict** was premature. With a
   third-party integration the owner has just saved, the correct call is "not live yet,
   re-test in a few days".
2. **"Move Warm's budget to Cold" was too blunt.** I said it while Cold's cost per lead was
   quietly doubling (§3). I had not checked. The Warm diagnosis stands; the destination for
   the money does not.
3. Earlier in the engagement I claimed Zoho was the source of the QUALIFIED events. It was the
   owner hand-marking leads in Leads Centre. Zoho is fully disconnected.

---

## 6. Open recommendations — judgment, not fact. Please review.

1. **Pause Ad4.** AU$102 per lead against Ad3's AU$28.91 over the first week, 1 lead and 0
   bookings across the full period. It is the third failure of the "universally relatable"
   concept class (the other three are the paused Ad1/Ad2/Ad5). *Counter-argument to weigh:* it
   is the only challenger running, and killing it leaves Cold single-threaded on one creative
   that will eventually fatigue. New challengers should be jargon-led, not lifestyle-led.
2. **Rebuild Warm around the instant form instead of sending people straight to Calendly.**
   The owner's thesis is that Warm is lower friction because it skips the form. I think that
   is backwards, for three reasons: (a) the form is four Facebook-prefilled fields inside the
   app, whereas booking a 30-minute call needs a date, a time, a timezone and a real
   commitment — the form is the small ask; (b) the calendar is where people are lost, 7 of 8
   left at that step on 27 Sep; (c) "shown interest" overstates the audience, which is really
   *engaged with the Page in 365 days* — a like or a stray tap — because the audience that
   genuinely matches the description is the INACTIVE one. **Concrete change:** owner duplicates
   the Cold ad set in Ads Manager, keeps form `1065996865920792`, swaps the audience to the
   three Warm audiences. That makes it a clean A/B where the only variable is the audience.
   Pause the current link-clicks Warm once the replacement is live. *This is the single
   recommendation I would most like a second opinion on.*
3. **Warm's frequency of 9.2 against 1,870 people needs addressing either way** — that is the
   same small group seeing the ads nine times in two weeks.
4. **Do not raise Cold's budget until §10.1 is understood.**
5. **The deepest leak is no longer lead volume, it is onboarding.** The app has ~24 accounts
   in total; both sign-ups in this period are stuck partway through. More leads will not fix
   that.
6. **Follow up every new lead personally within the hour.** 11 of 12 bookings historically
   happened within two hours of the form, and 98 automated emails and WhatsApps produced one
   booking between them. This is the highest-leverage non-ads change.

---

## 7. Owner-side actions outstanding (Meta UI only — cannot be done over the API)

1. **Finish the custom conversion.** Events Manager → Custom conversions → data source
   *GP Link Recruitment Agency*, action source *Website*, event `invitee_meeting_scheduled`.
   **Remove the "URL contains" rule with its ×** — the event is itself the definition; if Meta
   refuses to create without a rule, use `calendly.com/hello-mygplink`. Under *Choose a
   standard event for optimisation* → Select your own category → **Schedule**. (Owner was
   mid-way through this on 29 Sep.)
2. **Events Manager → dataset `31126391376976338` → Modify funnel:** order
   `lead → qualified_gp → call_booked → signed_up` and pick `call_booked` as the stage to
   optimise for. Harmless to do now; it changes nothing about delivery today.
3. **Stop hand-marking every lead QUALIFIED in Leads Centre.** The app now reports real
   qualification, and hand-marking teaches Meta that everyone converts.
4. **Around 13 Oct, decide on the conversion-leads switch** — see §8.4.
5. Delete the `zz UNUSED` campaign `120248645430890648`.

---

## 8. Traps and gotchas

1. 🧨 **`ads_update_entity` force-pauses the entity it edits** and silently appends
   `status:PAUSED`. Always follow with `ads_activate_entity`. Exception observed 17 Sep: a
   **name-only** edit did *not* force-pause (`status_forced_to_paused:false`) — it applies to
   delivery-affecting fields.
2. 🧨 **Any `ads_update_entity` on a lead-form ad set of this Page fails with error 1815089**
   ("Terms of Service Not Accepted"). The Page *has* accepted; the MCP connection lacks
   `pages_manage_ads` and so cannot read the acceptance. **Everything touching Cold must be
   done by the owner in Ads Manager.** This also blocks creating new lead-form ad sets.
3. ⚠️ **A targeting write is a full replace.** Read `targeting` first or you will wipe
   geo/age/placements. Prefer editing the **custom audience** instead, which avoids the ad-set
   write entirely — that is how the Warm 30d→365d widening was done.
4. 🧨 **Always pass `location_types` when creating an ad set over MCP.** Omitting it leaves the
   ad set live and delivering but makes Ads Manager's draft editor raise error #1870194 and
   **block Publish for the owner's entire draft**, including unrelated queued items.
5. 🧨 **Archived ad sets do not appear in a `campaign.id IN [...]` query.** Fetch by
   `object_ids` to confirm an archive.
6. ⚠️ **Creatives are immutable** — copy, image and CTA cannot be edited. Any change means a
   new creative and a new ad, which restarts learning.
7. 🧨 **Meta's "today" is the Sydney day.** The owner asks from Bali (UTC+8) at night. Always
   pass an explicit `time_range`.
8. 🧨 **Do not curl a Calendly page to check for a pixel.** It returns a ~3KB server shell;
   tracking loads client-side. Verify from Meta's dataset stats only.
9. 🧨 **The owner's Mac cannot verify pixels with Meta Pixel Helper** — NordVPN 204s
   `fbevents.js` in browsers only. A blank Pixel Helper is not evidence of failure there.
10. ⚠️ **"Unknown (BOOK_NOW)" in the Ads Manager CTA dropdown is cosmetic.** The leads-objective
    website-ad list lacks "Book now"; the ad still renders and delivers it.
11. ⚠️ **"Meta pixel: None" on a form ad is correct**, not a fault. There is no website to
    track; it appears when the goal moves off QUALITY_LEAD.
12. ⚠️ If a **new instant form** is ever built, its ID must be added to `FB_GP_LEAD_FORM_IDS`
    in Vercel **before** repointing any ad, or its leads land as bogus practice rows.
13. ⚠️ Under Employment SAC, **custom audiences are allowed but exclusions, lookalikes and
    detailed targeting are not.** Warm cannot exclude people who already booked.

---

## 9. How to verify any of this

The analysis scripts lived in an **ephemeral** job tmp directory and are gone. The queries are
short enough to recreate. All read prod Supabase read-only via PostgREST using
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the main checkout's gitignored `.env`.
**Print aggregates only — these rows contain doctors' names, emails and phone numbers.**

- **Funnel:** `GET /rest/v1/site_enquiries?select=created_at,metadata&kind=eq.gp&created_at=gte.<iso>`
  then filter in code on `metadata.source == 'meta_lead_ad'`. **`source` lives inside
  `metadata`, not as a column**, and `kind` *is* a column. Read `metadata.consult` for
  `qualified`, `call_booked_at`, `stopped`, and `metadata.fb_ad_id` / `fb_form_id` for
  attribution.
- **Stage-feed health:** count rows whose `metadata.consult.meta_capi.sent` is present, and
  check `client_errors` for rows `ilike '*Meta CAPI*'`. That table has **no `route` column**.
- **Booking attribution:** `metadata.consult.booking_utm.campaign`.
- **`user_state` has only `user_id`, `state`, `updated_at`** — onboarding lives inside `state`,
  there is no `gp_onboarding` column.
- **`scheduled_calls` has no utm/source/metadata column at all.** Every row reads
  `created_by: calendly_direct`, which is why §2.2 was needed.
- **Meta side:** `ads_get_ad_entities` with `level` + `object_ids` + explicit `time_range`;
  `ads_get_dataset_stats` with `aggregation:"event_source"` to separate BROWSER from SERVER
  (a browser `last_fired_time` running ahead of `server_last_fired_time` is the quick tell
  that a real pixel is alive).
- 🧨 **Vercel's `/runtime-logs` endpoint is a never-ending stream** — a plain GET hangs
  forever. Do not use it for one-shot checks. To confirm a deploy, use
  `GET https://api.vercel.com/v6/deployments?teamId=team_CZsGx8ESlTxQ3Uc9sHG23vCY&projectId=prj_LeHg7obiXjySqpjR23S46QmwSLXJ&target=production`
  and match `meta.githubCommitSha`.

---

## 10. Open questions for whoever picks this up

1. **Why has Cold's cost per lead doubled, and why has no lead arrived since 27 Sep 07:15Z?**
   Candidates, none verified: creative fatigue on Ad3 (frequency 2.72 and climbing); Meta
   re-entering learning after the 21 Sep goal change; seasonal or auction shift; or something
   broken in lead delivery. **Check the webhook is still delivering before assuming it is an
   auction problem** — the app has recorded no lead for two days while Meta reports two.
2. **Is §6.2 right?** The owner disagrees, with a reasonable argument. Their instinct that a
   warm audience deserves its own treatment is sound; the disagreement is only about whether
   the form or the calendar is the friction.
3. **Should Cold move to conversion-leads optimisation in mid-October?** The agreed plan was
   to run on lead volume first so the dataset accumulates booking history, then switch around
   13 Oct if there are ~30+ `call_booked` events. There are 23 now. Expect "learning limited"
   regardless, since ~10 bookings a month is far below Meta's suggested 50 a week.
4. **Why did the Calendly pixel start on 27 Sep rather than 23 Sep?** Never established. Only
   matters if it stops again.
5. **Is the Hot concept dead or just badly sized?** Zero of the 866 uploaded emails created an
   account. The list is too small to advertise to (reach 450, frequency 9.75). GP Link owns
   those addresses outright — a direct email costs nothing and would likely beat the ads.
