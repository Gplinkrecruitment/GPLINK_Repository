# Competitor Ad Monitoring Playbook — GP Link marketing

**Purpose:** keep a consistent, repeatable view of what competitors (UK-targeted
"GP → Australia" recruiters) are advertising, so our own creative stays sharp —
using their ads as *pattern inspiration only*, never as assets to copy.

**Companion to:** the campaign spec
`docs/superpowers/specs/2026-07-13-uk-gp-marketing-video-campaign-design.md`.

---

## The golden rule (IP guardrail)

Use competitor ads to learn **patterns** — hooks, offers, angles, length,
pacing, CTA, how long an ad has run (longevity = it's working). **Never** feed a
competitor's actual video/image into Higgsfield (or any generator) to reproduce
it. That is copyright / passing-off risk and makes GP Link look derivative. Keep
our own voice; competitors only tell us what's already landing in the feed.

---

## Today's method (manual — no build required)

1. Owner supplies competitor **Facebook Page URLs** or **Meta Ad Library URLs**.
2. Open each in the **free Meta Ad Library** — <https://www.facebook.com/ads/library/>
   (no login, no verification, no code). Set **Country = United Kingdom**,
   **Ad category = All ads**, and either search the Page name or paste the URL.
3. For each competitor, capture the fields in the **Teardown template** below.
4. Distil the recurring winners into our next creative batch. Append the dated
   entry to the **Running log** at the bottom of this file.

### Teardown template (copy per competitor, per review)

| Field | Notes |
|-------|-------|
| Competitor / Page | |
| Ad Library URL | |
| # active ads | |
| Dominant hooks / opening lines | first 2 seconds — what stops the scroll |
| Offer / claims | free service? earnings? visa? family? guarantees? |
| Format(s) | video / static / carousel · aspect ratio · with/without captions |
| Typical length | seconds |
| CTA | "Apply", "Book a call", "Learn more"… |
| Longevity signal | any ad running > 4–6 weeks = it's working, worth learning from |
| Notable technique | testimonial style, before/after, day-in-life, price anchor… |
| What we'd borrow (pattern only) | |

---

## Cadence (keeps it "consistent")

- **Before every new creative batch** — a fresh teardown of the confirmed list.
- **Monthly** — a lighter check for new entrants or a competitor's new angle.
- Always date the entry in the Running log so we can see how the market shifts.

---

## Competitor watch-list

> Owner confirms the definitive list — you know the real competitors. Seed
> candidates below are **to verify**, not asserted as fact.

| Competitor (to confirm) | Facebook Page URL | Notes |
|-------------------------|-------------------|-------|
| _(owner to fill)_ | | primary competitor |
| _(owner to fill)_ | | |
| _(owner to fill)_ | | |

*Candidate names to check when building the list:* international/AU medical
recruiters that place UK GPs into Australia (e.g. Wavelength/Medacs, Global
Medics, Head Medical, HealthStaff Recruitment, Ochre Recruitment, Cornerstone
Medical Recruitment, Prescript Recruitment, IMG Connect). **Verify each is a
genuine competitor and find its real Page before adding.**

---

## Future method (automated monitoring — optional, separate mini-project)

Only worth building if we want continuous, hands-off tracking. It is **not**
required to ship a campaign.

**Why it's viable for us specifically:** the Meta Ad Library **API** normally
returns only political/social-issue ads — but commercial ads *are* available for
ads reaching **UK / EU** users (forced by the EU Digital Services Act). Our
competitors advertise **to UK doctors**, so their ads reach UK users and are
therefore queryable. (AU-reaching commercial ads are *not* API-available — use
the web UI for those.)

**Setup:**
1. Verify identity at <https://www.facebook.com/ID> (government ID; 1–3 business days).
2. Create a Meta for Developers app; add the **Ad Library API** product; issue an access token.
3. Query the archive, e.g.:
   `ad_reached_countries=['GB']`, `ad_type=ALL`,
   `search_terms="GP jobs Australia"` (or `search_page_ids=<competitor page ids>`),
   `ad_active_status=ALL`, request fields incl. creative bodies, start dates, platforms.
4. Store results (a sheet or small table); optionally alert on new competitor ads.

**Confirm against Meta's official docs before building** — access rules change.
Ref: <https://developers.facebook.com/docs/graph-api/reference/ads_archive/>

---

## Running log

> Append a dated block per review. Newest at top.

_(no reviews logged yet — first entry goes here once competitor URLs are supplied)_
