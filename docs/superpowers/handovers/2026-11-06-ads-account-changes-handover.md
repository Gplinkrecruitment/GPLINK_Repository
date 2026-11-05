# Ads hub: "Changes to make on Meta" — tick, Submit, applied (2026-11-06)

Read this with the 2026-10-29 Ads hub handover. That one covers the review,
the live creatives and the drafts. This one covers the new block between the
live creatives and the suggested improvements: the review's **account
changes**, which the owner ticks and the app applies to the Meta account
through the API.

## 1. What the owner asked for

"I should have an option to tick the suggested changes to the ads or ad
account and then click submit so that AI does it directly for me
automatically." The improvements list already fed draft generation; nothing on
the page could change the account itself (pause an ad, launch the ready draft,
move a budget), so every "pause X" verdict was still a trip to Ads Manager.

## 2. What is live now

- **The review proposes exact changes.** `REVIEW_SCHEMA.account_changes`
  (lib/ads-review.js) is a list of up to eight items, each `{ id, action,
  target_id, target_name, daily_budget, title, why, priority }`. The item
  schema and the action list live with the executor: `lib/ads-actions.js`
  (`CHANGE_SCHEMA`, `ACTIONS`). Six actions exist and nothing else can be
  asked for: `pause_ad`, `resume_ad`, `pause_adset`, `resume_adset`,
  `set_adset_daily_budget`, `launch_draft`. The prompt (REVIEW_SYSTEM,
  "CHANGES YOU CAN MAKE DIRECTLY") tells the model to put every rotation-rule
  consequence there, to keep three ads live after its changes, never to more
  than double a budget, and to send anything the API cannot do (lead form
  questions, targeting, new ad sets) to `actions_today` with `where:
  ads_manager`. The review runner now passes the **launchable drafts** (ready
  / scheduled / failed with a creative and no problems) into the prompt with
  their ids, so `launch_draft` can name one; with none it says so and the
  model is told not to propose a launch.
- **The page.** `js/ceo-social.js` → `changesSection()`: a card "Changes to
  make on Meta" with one tick box per change, the action pill, a sentence
  saying exactly what will happen (`effect`, computed server-side from the
  latest snapshot by `adsActions.describeChanges` in `adsPagePayload`), the
  model's reason, and the outcome once applied. **Submit ticked changes**
  confirms with the list of effects, calls the route, toasts the summary and
  then refreshes the numbers from Meta so the live cards show the new
  statuses. Applied rows stay, greyed and disabled, with "Applied · time ·
  message"; a refused row is left unticked with the reason and "tick to try
  again". A review from before this feature shows "Click Run review now to
  get them".
- **The route.** `POST /api/ceo/ads/changes/apply` `{ review_id, ids }` →
  `adsApplyChanges()` in server.js: loads the review row, keeps the ticked
  ids that are not already applied, refuses without a token (400) or with
  `ADS_LAUNCH_DISABLED=true` (409), **reads the account fresh**
  (`metaAds.fetchLiveState`: ad sets + ads with statuses, budgets in dollars),
  then `adsActions.applyChanges()`. The outcome of every change is written to
  `review.account_changes[i].applied = { at, by, ok, skipped, held, message,
  before, after, meta_ad_id }` on the row (`adsPatchReview`, only the review
  JSON is ever patched), so a change is never applied twice and the page
  shows what happened after a reload.
- **The executor** (`lib/ads-actions.js`). Order: resume ad set, resume ad,
  launch draft, budget, pause ad, pause ad set, then by priority, so a pause
  is judged with the additions already counted. Checks, against the live
  state and mutated as each change lands: already paused / live / same budget
  → skipped (recorded as done); an ad that is gone → refused; **a pause that
  would leave fewer than `ADS_MIN_LIVE_ADS` (default 1) live ads in its ad
  set → refused**; pausing the only running ad set → refused; **a budget above
  `ADS_MAX_DAILY_BUDGET` (default 300) or more than double the current one →
  refused**; zero budget → refused; a draft that is live → skipped, launching
  / archived / with `draftProblems` → refused. Writes: `metaAds.setEntityStatus`
  (POST /{id} `status`) and `metaAds.setAdsetDailyBudget` (POST /{id}
  `daily_budget` in cents), both insisting on `{ success: true }`; launches
  go through `adsLaunchDraftNow()` (shared with the card's Launch now, which
  was extracted from the route). A Meta refusal on one line is reported with
  `explainMetaError` and the others still run.
- **Tests.** `tests/ads-actions.test.js` (normalising, describing, every
  check, ordering, the executor with a recording Graph stub, the two write
  helpers, `fetchLiveState`), `tests/ads-changes-routes.test.js` (the route
  end to end against a stub Graph server with seeded review rows: order of
  writes, stored outcomes, no double apply, retry re-checks live state, Meta
  refusal on one line, kill switch, missing token) and additions to
  `tests/ads-review.test.js` (schema, normalising, prompt, runner).

## 3. Things to know before touching it

- Meta's structured output rejects `maxItems` / `minimum` / `maximum`; the
  eight-item cap and the budget rules are in descriptions and enforced by
  `normaliseChanges` / `checkChange`. Keep it that way.
- `effect` and `label` are added to the page payload only; the stored review
  row carries the model's fields plus `applied`.
- The snapshot the page shows is the stored one. After Submit the page calls
  `/api/ceo/ads/refresh` (live) so the cards and the `effect` sentences catch
  up; until then "live now" in a sentence can be a few hours old. The executor
  never trusts it: it reads the account again.
- The owner's ad-blocker rule still holds: no `ad-` / `ads-` class prefixes
  (everything here is `mk-chg-*` / `mk-apply*`).
- Error 1815089 (lead-ads terms) was not hit by the System User token on
  2026-11-04 when creating creatives. Status and budget edits on the lead-form
  ad set have not been tried live yet (nothing was in the account's review to
  tick when this shipped); if Meta refuses, the row says so in Meta's words
  and nothing else is touched.
- `ADS_LAUNCH_DISABLED=true` now holds every account change, not only
  launches: one switch.
