# Practice flow — Facebook lead → signed client → placed GP (intake redesign)

**Date:** 2026-07-15 · **Revised:** 2026-07-16 (v2 — supersedes the sections flagged below)
**Status:** Design approved + prototype proven. Ready for implementation plan.
**Prototypes:** `practice-form.html` (the complete 5-step form — current design source of truth), `server.py` (dry-run API), `corporate.html` (groups), `index.html` (flow map), `where.html` (field→screen trace). All under `~/.claude/jobs/eead77ab/tmp/map/`.

## v2 changelog — decisions taken after the original draft

Reached by building the prototype and testing it against real addresses and the real government API.

| Area | v1 said | v2 (binding) |
|---|---|---|
| DPA source | "No official source wired — ship DPA as an unanswered question, never suggest" | **Superseded.** The Department of Health's Health Workforce Locator backend is reachable (`trueview.spectrumspatial.com`, guest token, no credentials). Field `dpa_gps` is the official IMG/FGAMS answer. We **do** suggest, and the practice must still confirm. If the lookup fails we fall back to v1 behaviour — ask, never guess |
| Employment | `sessions per week`, `days & hours` | **Full-time / Part-time / Either** dropdown. Days & hours removed entirely |
| Role title | Asked | **Removed** — the system generates it |
| Income guarantee | Own field | **Folded into Incentives** as a worked example in the placeholder |
| Practice website | Not asked | **Asked** — AI uses it plus the "about the area" text to craft the polished advert |
| ABN | "ABN (11 digits, validated)" | **ABN *or* ACN**, real checksum on both |
| Split | Free text, unparsed | **Parsed.** The larger share always goes to the GP. `70`, `70/30` and `30/70` all mean GP 70 / practice 30 |
| Agreement gates | 7 | **8** (the drawn-or-typed signature becomes its own gate) |
| Draft persistence | Not specified | **localStorage** (`gplink_intake_draft_v3`) — a long form must survive a reload or a phone call |
| Downstream display | "Out of scope — nothing downstream changes" | **Superseded.** See "The display fixes" — the form's answers must actually reach a GP's screen |

## The display fixes (owner-confirmed 2026-07-16)

The form has always collected more than the app can show. Four gaps, all confirmed in code, all in scope:

1. **`intro_text` is written and never read.** The practice writes the single most-read paragraph a candidate sees, and no page renders it. Add an **"About the practice & the area"** section to both `pages/job.html` and `pages/site-job.html`.
2. **`packageTerms` is dead render code.** Both job pages already render a package/terms table; nothing in the repo has ever written `gpLink.packageTerms`. Wire the parsed split and incentives into it. This activates existing UI rather than adding any.
3. **Six CEO job-editor boxes are permanently blank.** `atsJobEditorPayload` (`server.js:29458-29463`) reads `gp_count`, `percentage_split`, `incentives`, `nursing_on_site`, `years_operating`, `general_location` from `career_roles.details`, and `address` from `career_roles.address` — but `createPendingJobFromIntake` writes neither. The practice fills them in, we store them, the CEO sees empty boxes.
4. **`gp_count`, `years_operating`, `nursing_on_site` go nowhere.** Surface them on the job page as practice facts — they are trust signals for a GP deciding whether to apply.

**The common root cause:** `practices.metadata.intake` (JSONB) is the real system of record for 13 of 20 intake fields. They are invisible to SQL, to the CEO editor, and to every GP-facing page. This redesign fixes the seam, not just the form.

## The form, as prototyped (5 steps)

Step 1 **Where** — address (Google Places autocomplete, manual fallback) → derived strip → DPA confirm → urgency → billing style → split.
Step 2 **The job** — GPs needed, employment (FT/PT/either).
Step 3 **The pitch** — about the area & the job, incentives, earnings, visa sponsorship, website, years operating, ownership, nursing on site, supervision, intro video.
Step 4 **Your practices** — one by default; "add another" for groups, each with its own address/billing/split/DPA/urgency, and a per-clinic "trades under a different company" override. Reversible: adding a second practice must never trap the practice into a group (bug found in prototype testing, fixed there).
Step 5 **Sign** — the agreement PDF embedded, 8 gates, nothing pre-filled, live "n of 8 completed".

## Why

The practice pipeline (FB lead → intake → e-sign → masked job → accept → interview → placement) shipped on 2026-07-05 and works end to end. Two problems remain:

1. **The Facebook front door has never been opened.** `FB_LEAD_WEBHOOK_SECRET` and `FB_LEAD_VERIFY_TOKEN` are set nowhere, so `POST /api/webhooks/facebook-lead` returns 503 and no real lead can enter.
2. **The intake form asks the wrong questions.** It asks the practice for four separate location fields it could derive from one, it never asks *when* they need a GP or *how many*, and it assumes one lead = one practice = one contract, which breaks for corporate groups.

This spec covers the questions we ask and how we ask them. It does not change anything downstream of the signed agreement.

## Decisions taken

| # | Decision | Chosen |
|---|---|---|
| 1 | Facebook lead form scope | **4 basics + 3 qualifiers** |
| 2 | Location capture | **One address field**; suburb / nearest city / state / postcode derived from it |
| 3 | Address lookup provider | **Google Places (New)** — existing browser key, referrer-locked |
| 4 | DPA | **Suggested for them, but the practice must actively confirm.** Never silently accepted |
| 5 | Corporate groups | **Option C** — one entity + ABN by default, per-clinic override, one signature |
| 6 | Agreement | **No pre-fill.** Signer types every field; submit stays disabled until all are complete |

---

## Stage 0 — The Facebook lead form

Seven fields. Meta pre-fills the first four from the user's profile, so the real cost to the practice is three taps.

| Meta field name | Purpose |
|---|---|
| `practice_name` | Practice / company name |
| `full_name` | Contact name |
| `email` | Contact email |
| `phone_number` | Contact phone |
| `contact_role` | **NEW** — "Are you the owner, practice manager, or other?" |
| `gp_needed_by` | **NEW** — "When do you need a GP?" → `asap` / `3_6m` / `12m` |
| `postcode` | **NEW** — replaces free-text `city` |

**Why these three.** `contact_role` tells us immediately whether this person can sign a services agreement or whether we need to reach the owner — today, whoever fills the form is the person who signs the contract, which is a live legal risk. `gp_needed_by` is the prioritisation signal and the best available predictor of whether they'll finish the intake form. `postcode` beats Meta's free-text city and lets us pre-fill the intake form's address.

**Code changes:** extend `normalizeFacebookLeadPayload` (`lib/practice-pipeline.js:89-148`) to map the three new field names, in both the native Meta shape and the flat Zapier/Make shape. Persist onto the `practices` row (`contact_role`, `urgency`, `postcode`) rather than leaving them only in `metadata.fb_raw`.

**Deployment (owner action, still outstanding):** set `FB_LEAD_WEBHOOK_SECRET` and `FB_LEAD_VERIFY_TOKEN` in Vercel, and point Meta's Lead Ads webhook at `/api/webhooks/facebook-lead?secret=…`. Until then, the pipeline is testable only from stage 1 onward, by seeding a `prospective` practice and using "Resend intake email".

## Stage 1 — The intake email

Unchanged. It asks for nothing inline; it is a single button to the tokenised, no-login intake page. Subject: *"Your GP is waiting — complete your job details"*.

## Stage 2 — The intake form (rewritten)

### Required — down from 7 to 5

| Question | Type | Notes |
|---|---|---|
| **Practice address** | Google Places autocomplete | The only location question. Everything else is derived |
| **DPA** | Yes / No | Pre-answered for them; **they must click to confirm** |
| **When do you need a GP?** | `asap` / `3_6m` / `12m` | Pre-filled from the Facebook answer, editable |
| **Billing style** | mixed / bulk / private | Unchanged |
| **Percentage split** | Text | Unchanged. Placeholder: *"e.g. 70/30 (GP / practice)"* |

### Removed as questions — derived from the address, kept as columns

`suburb` · `nearest_city` · `state` · `general_location`

These still populate the same `practices` and `career_roles` columns, so nothing downstream changes. They are shown back to the practice under the address as a confirmation strip ("Werribee, VIC 3030 — nearest city Melbourne") with an edit link, so a wrong derivation is caught before submit rather than after the job ad is live.

### Renamed

`intro_text` → **"Tell us about the area, and what a GP working here can expect"**

One box covering both the place and the job. This is the body of the job advert and the most-read text a candidate sees. Hint: *"Cover both: what the area is like to live in, and what the job is like to do."*

### Tooltips and examples on every free-text field

Each field gets a hover `?` tooltip explaining *why* we ask, plus a concrete example inside the box. Examples:

- **Incentives** — *"$10,000 relocation package, 4 weeks' accommodation on arrival, $3,000 annual CPD allowance, airport pickup."* Hint: *"Be specific with numbers — vague offers get ignored."*
- **Percentage split** — *"e.g. 70/30 (GP / practice)"*. Tooltip: *"The GP's share of billings, then yours."*
- **Legal entity name** — Tooltip: *"The company registered against your ABN — not the trading name on your signage."*
- **Visa sponsorship** — Tooltip: *"Leave blank if you're not sure — we read that as 'let's talk', not as a no."*

### Unchanged optional fields

`mmm` · `visa_sponsorship` · `ownership` · `years_operating` · `nursing_on_site` · `gp_count` · `incentives` · `earnings_text` · `role_title` · `role_summary` · `intro_video_url`

---

## The address lookup

**Provider: Google Places API (New), called from the browser** with the existing `GOOGLE_MAPS_BROWSER_API_KEY`.

The key is already referrer-locked to `admin.mygplink.com.au` and `app.mygplink.com.au` and API-locked to Maps JavaScript API. **The one outstanding owner action is ticking "Places API (New)" in that key's API restrictions.** Verified 2026-07-15: with the referrer allowed, Google still replies *"Requests to this API … are blocked"*, i.e. the box is not yet ticked.

We deliberately do **not** proxy this through our server. A referrer-locked browser key can only be used from our own domains, which is exactly the protection we want; a server key would have to have that protection removed. Recommend also setting a daily quota cap (e.g. 500/day) on Places API to make a runaway bill impossible.

**Derivation from the selected place:**

| Derived | Source |
|---|---|
| `suburb`, `state`, `postcode` | Google address components |
| `latitude`, `longitude`, `google_place_id` | Google |
| `nearest_city` | **Computed by distance** against a table of ~42 AU cities and regional centres — measured, not inferred, so it cannot hallucinate a wrong city into a job ad |
| `general_location` | Composed: *"{suburb}, {state} — near {nearest_city}"* |

**Manual fallback (required, not optional).** A practice must never be unable to submit because a lookup missed their address. "Can't find your address? Enter it manually" reveals a free-text street line plus a **suburb** autocomplete. This loses nothing: everything we derive comes from the suburb; the street number is only ever printed on the contract.

## DPA — suggested, never assumed

DPA decides which GPs can see the job at all. A wrong value silently hides a listing from the entire overseas-trained pool, so it gets special handling:

1. On address selection, we look DPA up and pre-answer it.
2. The practice sees the answer and **must click "Yes" or "No"** to accept it. A submit is blocked until they do.
3. If they contradict our suggestion, **we take their answer** and flag `dpa_mismatch = true` for the team to verify.

**Do not use AI to infer DPA.** It is an official Department of Health classification tied to the address (DoctorConnect). An LLM guess here is the one place in this flow where being confidently wrong is expensive. MMM comes from the same source.

**v2 — the official source is wired in.** The public Health Workforce Locator (health.gov.au) is an Angular front end over `https://trueview.spectrumspatial.com/trueviewapi`, which issues a guest token to anyone with no credentials:

- `POST /auth/guest-token` body `{"workspace":"dhac"}` → `{accessToken, expiresIn}` (cache it; refresh 60s before expiry)
- `POST /theme/getResult/locator/address` with the point geometry + `Authorization: Bearer <token>` → `results.dpa_gps.features[0].properties.{value,class,catchment}`

`dpa_gps` is the IMG/FGAMS answer — the exact field the official tool renders under "Distribution Priority Area for GPs", verified against the downloadable DPA shapefile. Also read `dpa_bmp` (bonded) and `mmm2023` (→ `MM<n>`). A `value` outside `Y`/`N` is an error, not a default.

**This must be called server-side** (`GET /api/dpa/check?lat=&lon=`) — the browser cannot reach it. **If it fails, never guess:** show "we couldn't check this automatically", leave DPA unanswered, and require the practice to answer. That is the v1 fallback, retained.

**Longer term:** import the DPA + MMM shapefiles into Supabase PostGIS and query locally instead of depending on a third party's undocumented endpoint at signup time. PostGIS is not currently enabled. Until then the live call is the source, with the fail-safe above.

## Corporate groups — option C

**Default is a single practice, and a solo practice never sees any group UI.**

- The practice enters **one** legal entity name and ABN up front.
- If they say they are a group, each clinic gains a tick-box: *"This clinic trades under a different company."* Ticking it reveals that clinic's own entity name and ABN.
- Each clinic still carries its own address, billing style, split, DPA and urgency, and still generates its own masked job listing.
- **One signature covers all of them.** The agreement carries a *Schedule 1 — Covered Practices*, listing each practice against its contracting entity and ABN.

### Data model

New table `practice_groups`:

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `entity_name` text | The head company |
| `abn` text | |
| `contact_name` / `contact_email` / `contact_phone` / `contact_role` | Moves up from the practice |
| `intake_token` text unique | **Moves up from `practices`** — one link, one signature |
| `agreement_status` / `agreement_signed_at` / `agreement_signed_by` / `agreement_signed_pdf_key` | Moves up from `practices` |
| `source`, `metadata` jsonb | FB lead payload lives here |

Changes to `practices`:

| Column | Notes |
|---|---|
| `group_id` uuid FK → practice_groups | |
| `entity_name`, `abn` | **Nullable.** Set only when this clinic overrides the group's entity |
| `urgency` text CHECK (`asap`,`3_6m`,`12m`) | |
| `latitude`, `longitude`, `google_place_id`, `postcode` | |
| `dpa_suggested` bool, `dpa_mismatch` bool | |

**Backwards compatibility:** every existing practice gets a `practice_group` of one, carrying its current token and agreement state. The intake token is read from the group, falling back to `practices.intake_token` so in-flight links keep working.

## The agreement — nothing pre-filled

Seven fields, all mandatory, none pre-populated:

1. Full legal name
2. Position at the practice
3. Legal entity name
4. ABN (11 digits, validated)
5. Email (the signed copy goes here)
6. Drawn signature
7. Tick: *"I am authorised to bind this practice"*

The submit button is **disabled** until all seven pass, with a live "n of 7 completed" progress indicator listing what's missing. The name, entity and ABN the signer types are what get stamped onto the execution page — so they must be theirs, not ours.

The stamped execution page (`lib/practice-agreement-pdf.js`) gains **Schedule 1**, listing every covered practice and its contracting entity.

---

## Out of scope

The *mechanics* downstream of signing are unchanged: job auto-creation, CEO approval with the mandatory suburb photo, identity masking, the DPA visibility gate, accept-and-reveal, self-serve interview booking, offers and placements. What changes is only *what data reaches them* — see "The display fixes".

## Open items

1. ~~Should the form ask the six "would block a placement" questions?~~ **Decided (v2):** headcount + employment type are in, as step 2. Days/hours and sessions are out. The form is split across 5 steps so it never reads as a wall.
2. **Owner actions outstanding:** set `FB_LEAD_WEBHOOK_SECRET` + `FB_LEAD_VERIFY_TOKEN` in Vercel and point Meta's Lead Ads webhook at `/api/webhooks/facebook-lead?secret=…`. ("Places API (New)" was ticked on the Maps key on 2026-07-14 and is verified working.)
3. **Recommended:** set a daily quota cap (e.g. 500/day) on the Places API key so a runaway or abusive loop cannot produce a large bill. The intake page is unauthenticated by design (token-gated only).
4. **Pre-existing bug, unrelated but adjacent:** most live `career_roles` rows may still carry `dpa = false` from the old Zoho sync, which would blur nearly the whole board for overseas-trained GPs. Verify in production before spending on ads.
5. **Not yet built:** DPA/MMM shapefiles in PostGIS (see the DPA section). Live HWL calls until then.
