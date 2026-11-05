# Ads hub: Meta time rules and the "Creatives running" count — handover (2026-11-06)

Branch `ads-rule-status-20261105` (worktree of the same name), session 012btG5b.

## 1. What the owner asked, and the answer

Two things on 2026-11-06 at 00:52 his time (16:52 UTC):

1. *"When I pause an ad in the test ad set that is not working, won't the rule that turns the
   ad set off and on at a certain time turn that ad back on?"*
2. A screenshot of the Ads hub reading **"Creatives running now 0 · Show 26 paused / other
   ads"**, which he said was wrong: ads are running, they have just been switched off by the rule.

**Answer to 1: no.** A Meta automated rule changes the status of the object it targets and
nothing underneath it. The account history (read through the Facebook MCP,
`ads_account_get_activity_logs`, category `status`) shows both rules acting on the ad set only:

| When (Sydney) | Event | Object | Rule |
|---|---|---|---|
| 5 Nov 07:38 | Ad set status updated, Active → Inactive | `120249238461470648` "Test \| Pain points · before vs split \| 30 Sep 2026 – Copy" | `4475418779441114` **UK night off** |
| 5 Nov 18:38 | Ad set status updated, Inactive → Active | same ad set | `2327070501438577` **UK morning on** |

(same pair on 3 and 4 Nov). Every ad's own `status` is untouched by those events. An ad the
owner pauses gets `status: PAUSED` and `effective_status: PAUSED`; when the rule turns the ad
set back on, that ad stays paused. Conversely the seven ads in the ad set the owner paused by
hand on 22 Oct read `status: ACTIVE / effective_status: ADSET_PAUSED`: active in themselves,
off because the parent is off. Only a rule written at **ad** level ("turn on ads …") would
switch ads on; the owner's two rules are ad-set level.

**Why the count read 0.** The page's "running" test was `effective_status === 'ACTIVE'`. The
rule switches the ad set off at 20:30 UK (07:30 Sydney, the account's clock) and on at
07:30 UK (18:30 Sydney). The nightly review cron (`/api/cron/ads-daily-review`, 21:30 UTC) is
inside that window, so the stored snapshot the page opens with always had every ad as
`ADSET_PAUSED` → 0 live, and the Overview's Meta light was red ("0 ads live · every ad set
paused"). The daily Opus review was told the same, which is why it kept describing a paused
campaign.

## 2. What changed (read before touching any status check)

### `lib/meta-ads.js`
- **Tenth Graph read**: `fetchAdRules()` → `GET /act_<account>/adrules_library?fields=id,name,status,evaluation_spec,execution_spec,schedule_spec,updated_time`. Non-fatal: a failure adds
  "Automated rules failed: …" to `snapshot.errors` and the page falls back to the old
  effective-status view.
- `normaliseRule(row)` → `{ id, name, enabled, action (PAUSE|UNPAUSE|…), level (ADSET|CAMPAIGN|AD),
  ids, adset_ids, campaign_ids, conditional, evaluation_type, schedule_type, schedule:
  [{ start_minute, end_minute, days }] }`. A filter on anything other than identity
  (`entity_type`, `id`, `object_id`, `campaign.id`, `adset.id`, `ad.id`, `time_preset`,
  `attribution_window`) marks the rule `conditional` (a "pause when cost per lead > X" rule
  promises nothing).
- `isSwitchRule(rule)`: enabled + PAUSE/UNPAUSE + has a clock + not conditional.
- `ruleCovers(rule, { kind, id, campaign_id, adset_id })`: by id list, by ad-set list, by campaign,
  or account-wide when only `entity_type` is set; never across levels; a rule with no
  `entity_type` and no ids covers nothing.
- `ruleFires(rule, nowMs, tz)` → `{ next_at, prev_at }` (epoch ms). Minutes are wall-clock minutes
  on the **ad account's** zone (`cfg.accountTimeZone`, Australia/Sydney), days 0 = Sunday,
  empty = every day. A one-step correction keeps the wall-clock minute across a DST change.
- `scheduleFor(entity, rules, nowMs, tz)` → `{ managed, on_rule: {id,name,at}, off_rule,
  last_on_at, last_off_at, expected_on }` or `null`. `expected_on` is what the clock says the
  status should be *now* (null unless both halves of the cycle exist).
- **Rotation** (the word the page uses for "running"):

  | `rotation` | meaning |
  |---|---|
  | `live` | `effective_status === 'ACTIVE'` |
  | `scheduled_off` | its ad set is off and a switch rule will turn it on (ad set: `PAUSED` + an on-rule + `expected_on !== true`) |
  | `review` | pending review / in process / preapproved |
  | `issue` | with issues / disapproved |
  | `parent_paused` | ad set or campaign paused by hand (no rule will undo it) |
  | `paused` | the ad's own `status` is `PAUSED` — checked **before** the parent, so a hand-paused ad inside a clock-managed set is `paused` |
  | `other` | archived, deleted, anything else |

  "In rotation" = `live` + `scheduled_off`. `rotationFlags()` now applies to ads in rotation.
- Snapshot additions: `rotation` on every ad set and ad; `schedule` on every ad set; counts
  `live_ads` (unchanged meaning: delivering now), `rotation_ads`, `scheduled_off_ads`,
  `review_ads`, `paused_ads`; `schedule` summary `{ managed, state: on|off|paused, adset_id,
  adset_name, on_rule, off_rule, expected_on, adsets[] }`; `rules` (normalised). Ads are ordered
  by rotation rank then 7-day spend.
- `rephaseSnapshot(snapshot, now)`: a **stored** snapshot read hours later. "Hand pause or the
  clock?" is judged against the clock at `fetched_at`; then, for ad sets with both an on and an
  off rule, rotation follows the clock at `now` (the ads under it follow their parent). Counts
  and `schedule` are recomputed, metrics untouched, `rephased_at` stamped. Without stored
  `rules` it returns the snapshot as is (so the last pre-change snapshot still reads 0 until the
  next refresh).

### `server.js`
`adsPagePayload()` re-phases the stored snapshot before sending it (`metaAds.rephaseSnapshot(row.snapshot, now)`); the live path is unchanged (a live build already has rotation).

### `lib/ads-review.js`
`compactSnapshot()`: `live_ads` = ads in rotation, an ad off by the clock carries
`status: 'OFF_BY_SCHEDULE'`; `paused_ads` = the rest; `ad_sets[].rotation`; `time_rules` =
the schedule summary. `buildReviewMessages()` inserts a **TIME RULES** paragraph before the
snapshot JSON (`timeRulesNote()`): which ad set, off/on right now, the rules and their next
firing in UK time, "treat OFF_BY_SCHEDULE as live, never call them paused, never advise
switching them on, a rule never changes an ad's own status". The LIVE ADS list for new briefs
uses the same rotation test.

### `lib/ceo-overview.js`
Requires `./meta-ads.js` and re-phases the snapshot. Meta light ladder: grey → **red only when
`rotation_ads === 0`** → amber when stale → **green "N ads in rotation · off by rule until 07:30
UK"** when the clock has it off → green "N ads live · $X this week". `paused_since` only counts
hand pauses (`rotation === 'paused'`). `status.meta` gains `rotation_ads` and `schedule
{ state, adset_name, on_rule, on_at, off_rule, off_at, back_on_label }`. The brief says
"Ads are off for the night by rule: N ads in rotation, back on at 07:30 UK. Yesterday they
spent …" instead of "No ads are running".

### `lib/ads-actions.js` + `metaAds.fetchLiveState()` ("Changes to make on Meta", same day)
The apply route re-reads the account before each change. `fetchLiveState()` now also reads the
rules and stamps every ad set with `schedule` + `rotation` and every ad with `rotation` (plus
`rules` and a `schedule` summary on the result). `checkChange()`:
- **pause_ad** skips only an ad that is already paused itself or not in rotation. An ad whose ad
  set the clock has off is in rotation, so the pause is sent to Meta — the one thing that keeps
  it off when "UK morning on" fires. The result line says "Paused. It stays paused when its ad
  set comes back on." The "would leave N live ads" floor counts ads in rotation, so overnight
  pauses are not refused as emptying the set.
- **pause_adset** on a set the clock has off is skipped with: *Off right now by the rule "UK night
  off", but "UK morning on" turns it back on at 07:30 UK. To keep it off, pause the ads inside
  it or switch the rule off in Ads Manager.* The "only ad set running" guard counts sets in
  rotation.
- **resume_ad** inside a clock-off set reports "Resumed; it runs when the rule turns its ad set
  back on."
Tests: `tests/ads-actions.test.js` "while the time rule has the ad set off" (3).

### Page (`js/ceo-social.js`, `js/ceo-ads-drafts.js`, `css/ceo-social.css`)
- Card renamed **"Creatives running"**; the chip = ads in rotation, with "N delivering this
  minute" beside it when some are off by the clock.
- A schedule line under the card head (`.mk-schedule`): blue **Off by rule** ("… switched off
  right now by 'UK night off' and comes back on at 07:30 UK (18:30 Sydney) (rule 'UK morning
  on'). Its ads are in rotation and counted above. An ad you pause yourself stays paused when
  the rule turns the ad set back on …"), green **Live now** with the next switch-off, or amber
  **Paused by hand** when the owner paused the set while the clock says on ("… 'UK morning on'
  will switch it back on at … To keep it off, pause the ads inside it or switch the rule off").
- Ad cards show a blue "Off by rule" pill (`rotationLabel/rotationMod`); the header reads
  "Meta campaign · 8 ads in rotation · ad set off by rule until 07:30 UK (18:30 Sydney)".
- Drafts' ad-set select labels a clock-managed set "(off by rule, in rotation)".
- Times are printed in UK time with the account zone in brackets (`clockPair`), with the
  weekday when the next firing is more than 20 h away.

## 3. Tests
`tests/meta-ads.test.js` (+11, fixture `rules` + `offPhase()` in `tests/fixtures/meta-ads-graph.js`),
`tests/ads-review.test.js` (+1), `tests/ceo-overview.test.js` (+1), `tests/ceo-social-hub-render.test.js` (new, 3: runs the real
`js/ceo-social.js` in a `vm` context with a stub `document`, so a runtime slip in the page fails
here rather than as "The Ads view hit an error while drawing"). Existing counts updated:
ten reads (eleven calls with the form name), twelve on the paged edge. Run them one file at a
time if another job is running the full suite on the machine: the real-server boot hook times
out at 15 s under load (seen 2026-11-06).

## 4. First live check after deploy
1. The stored snapshot from before this deploy has no `rules`, so the page still reads 0 until
   **Refresh numbers** is clicked (or the 21:30 UTC cron runs). Click it.
2. In the new `ad_reviews` row (`kind: 'snapshot'`) check `snapshot.rules`: two switch rules
   expected (`UK night off` PAUSE, `UK morning on` UNPAUSE), `level: 'ADSET'`, `ids` containing
   `120249238461470648`, `conditional: false`, `schedule[0].start_minute` ≈ 450 / 1110 (Sydney
   minutes). If `schedule.managed` is false while rules came back, Meta's filter field names
   differ from the ones `normaliseRule` knows (`id` / `entity_type` / `adset.id` / `campaign.id`):
   look at `rules[].level`, `ids`, `conditional` and extend the parser. The history showed the
   rules firing at 07:38 / 18:38 Sydney; the page prints the configured minute, so a few
   minutes' difference is Meta's lag, not a bug.
3. Between 20:30 and 07:30 UK the card should read "Creatives running 8 · 0 delivering this
   minute" with the blue Off by rule line; after 07:30 UK, "Live now" with the next switch-off.
4. The Overview's Meta light should be green with "8 ads in rotation · off by rule until 07:30
   UK" overnight, not red.

## 5. Limits worth knowing
- The re-phase trusts the clock between refreshes: if the owner switches the ad set on or off
  by hand, the page is right again after Refresh numbers or the next nightly run.
- Only PAUSE/UNPAUSE rules with a schedule and no metric condition count as switch rules.
  Campaign-level rules are handled (`CAMPAIGN_PAUSED` ads under a clock-managed campaign are
  not, because `adRotation` only follows an ad set's rotation — add it if a campaign ever gets
  a clock).
- `adset_schedule` (Meta's own dayparting on a lifetime-budget ad set) is a different feature
  and is not read.

## 6. Same day, second batch: the white band on "Chasing QOF points", and "why it should run"

**The band.** The owner's screenshot (00:52 his time, 6 Nov) showed the draft's creative with a
white strip across the top fifth. Cause: Higgsfield returned a 1536×2048 file that is a
landscape photograph sitting on a white 3:4 canvas (19% padding top and bottom, 3% at the
sides; measured with PIL on the CloudFront original and on the stored `photo-…jpg`). The
composer's `trimBox()` in `js/ceo-ads-drafts.js` only removed frames up to 4% of an edge, so the
band went through to the 1080×1350 creative; the dark foot gradient hid the bottom one. The
other three photos of that batch have the usual 3% frame only, and the live ad's creative is
clean.
- `trimBox()`: up to 45% per edge, a row or column counts as padding only when its mean
  luminance is over 236 **and** its minimum over 200 (padding is white in every pixel, a bright
  sky is not), never leaving less than 30% of the photo; the box carries `band` (widest edge
  trimmed, as a fraction). The Python port in the session's tmp (`preview-qof-source.jpg`)
  confirmed the result: the car park and building fill the frame, no white.
- `maybeAutoCompose()` also re-composes a **stored** creative once when the photo's `band` is
  over 4% and the draft is still draft/ready; the saved layout gets `composer: 2` (the server
  whitelists it in the `/api/ceo/ads/draft` layout merge) so it is not redone on every load.
  The toast says "Creative re-composed without the white padding".
- `lib/higgsfield.js` `stripAspectNotes()`: the brief's own "4:5" / "3:4" / "(4:5) portrait"
  notes are removed before the prompt is sent (the frame comes from `aspect_ratio` on the
  request), and the suffix now spells out "fills the whole frame edge to edge, with no margin,
  mat or white space". `BRIEF_SCHEMA.image_prompt` no longer asks the model to write "4:5".
- Not changed: the already-live ad `01-ten-minute-slots` (its creative has no band). The QOF
  draft re-composes itself the next time the owner opens the Ads tab with the deploy live.

**"Why it should run" (owner's ask the same night: the AI should deeply analyse what has
worked and what has not when creating ads, and list why each is a strong ad to run).**
- `BRIEF_SCHEMA` gains `why_strong` (required, array of strings; two to four evidence-backed
  reasons, the last naming the 7-day result that would prove it). `normaliseBrief()` keeps up to
  five, 300 chars each.
- `BRIEF_SYSTEM` opens with "ANALYSE BEFORE YOU WRITE": work out from the numbers which
  mechanisms booked and attended and at what cost per booking, which spent without booking and
  why, what the winners' photographs and copy have in common, what leads object to; a reason
  without evidence is not a reason.
- `buildBriefMessages()` adds "EVERY AD AND ITS RESULTS, 30 DAYS" (`adResultsForBrief()`):
  every ad, live or paused, that spent, got a Meta lead or an app lead in 30 days, with
  headline, first line, status (OFF_BY_SCHEDULE when the clock has it off), days live, spend,
  leads, cost per lead, link clicks, click-to-lead, 7-day frequency, booked, signed up, cost
  per booking, attended and cost per attended when the ecosystem join is there, the review's
  verdict and reason for that ad, and the rotation flags. The LIVE ADS headline list stays as
  it was (the "do not duplicate" rule).
- Storage: `supabase/migrations/20261106100000_ad_drafts_why_strong.sql` adds
  `ad_drafts.why_strong JSONB NOT NULL DEFAULT '[]'`. **Applied to production 2026-11-05
  ~19:00Z** via `rpc/exec_sql` (`{"query": "ALTER TABLE public.ad_drafts …"}`, 204; the
  `public.` prefix matters, the unqualified form came back 404), then
  `NOTIFY pgrst, 'reload schema'` and a REST read-back of `why_strong`. `adsDraftFromBrief()`
  writes it for both the daily review's `new_ad_briefs` and "Generate new ads".
- Card: `whyStrongHtml()` renders "WHY IT SHOULD RUN" as a green-bordered list under the
  rationale (`.mk-why` in `css/ceo-social.css`). Drafts from before this change show nothing
  there; the next generated batch carries it.
