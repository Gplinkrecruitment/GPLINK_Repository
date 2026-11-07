# Ads hub in four sub-tabs, one "Do today" list — handover (2026-11-08)

**Owner's ask (8 Nov 2026, with a screenshot of the hub):** "a lot of noise in the social tab …
especially with the suggested improvements as there's many sections for the same thing … ensure the
tab is simple and covers everything we already have." Two mockups were built on localhost from the
real 8 Nov review; he chose the sub-tab one and added: "make sure we don't lose any functionality
eg the tick box on changes system we just implemented."

## 1. What was wrong

`js/ceo-social.js` drew the same morning review five times: `summarySection` (headline + summary +
"What to do today" ×6), the verdict on each `liveCard`, `changesSection` ("Changes to make on Meta"
×3 + Submit), `improvementsSection` (what-works / what-does-not columns + 8 tick items + Generate)
and the new-ad briefs. Four of the eight "improvements" were the automation actions word for word
(Hazel's script, the retry rule, the form question, the tracking check). Reading the tab meant
reading the review three times.

## 2. What is live now (`js/ceo-social.js`, `css/ceo-social.css`, `server.js`, `lib/ads-review.js`)

Four sub-tabs under the Ads / Organic switch, remembered per session (`sessionStorage`
`soc.ads.subtab`). All four panels are in the same paint; the three not showing are `display:none`,
so `#soc-drafts-root` (the drafts editor's own node) and `#soc-range-root` (the Performance card) keep
their place and a switch is just a repaint.

| Tab | Cards |
|---|---|
| **Today** | **This week**: the Performance card (unchanged, `js/ceo-ads-range.js`) + the funnel-only tiles when Meta is not connected + ONE "After the form, 30 days" line that opens to the old five-line strip. **Today's review**: headline, summary, then **Do today** in three groups. |
| **Creatives** | **Creatives running**: the same cards, now compact — verdict pill and four numbers (7-day spend, leads, cost per lead, click→lead) up front; the 6-row table, the Hazel line, the copy, the description, the form name and the Ads Manager link under *Details*. Paused toggle unchanged. **Evidence behind today's call**: what works / what does not, naming the ads each pattern comes from. |
| **New ads** | **Rules the ad writer follows**: the *creative* improvements (headline, image, copy, angle…), ticked by default, still `input.mk-imp-check` so `generate()` sends them as `improvement_ids` exactly as before; the Generate controls (`#mkGenCount`, `#mkGenInstr`). Then the drafts board (`js/ceo-ads-drafts.js`), **untouched**. |
| **Research** | What GPs ask about in consultations (unchanged) and the after-the-form funnel opened out. |

### Do today — the one list

- **On Meta** (`div.mk-do-group.mk-changes`): the review's `account_changes` with the **unchanged**
  tick-and-Submit mechanism from the 6 Nov work — `input.mk-chg-check` per change, `data-act="apply-changes"`
  → `POST /api/ceo/ads/changes/apply`, the "N waiting / in progress / All applied" count, the
  applied ✓ / in-progress ⏳ / failed ✕ states, a failed one left unticked so re-ticking retries.
  The 60-word how-it-works paragraph sits behind a "How it applies them" disclosure. Actions with
  `where: ads_manager | this_page` (by hand) sit in the same group as to-dos.
- **In the app**: actions with `where: automation | follow_up` — Hazel, the chase, tracking.
- **Elsewhere**: `where: none` (e.g. organic posts).
- **To-do ticks** (`input.mk-todo-check`, `data-act="todo"`): things the app cannot apply itself.
  `POST /api/ceo/ads/review/todo { review_id, key, done }` stores `review.todos[key] = { done_at, by }`
  on the review JSON (same place as a change's `applied`), so a refresh keeps it; it is cleared
  naturally when the next review replaces the row. The "Why" is a `<details>` *outside* the label
  (the row is a `div.mk-todo-row`, the title a `<label for>`), so opening it never flips the tick.
- **Each point once.** `todoItems(review)` starts from `actions_today`. An automation improvement
  joins the list only when no action carries it: by `improvement_id` (the schema now asks the model
  for it on every action; `normaliseReview` keeps `imp-N[a-z]?` or `''`) or, for reviews stored before
  the field existed, by word overlap — ≥ 6 shared significant words between the improvement's
  title+change and an action. Measured on the 8 Nov review: the four real pairs scored 16 / 11 / 8 / 9,
  every other pairing ≤ 5. When folded, the improvement's short title becomes the item's title and
  the action text its body; priority 1 shows "do first".

### Counts on the tab buttons
Today = open account changes + undone to-dos; Creatives = ads in rotation; New ads = non-archived drafts.

### Also fixed
`.btn-primary` had **no CSS rule anywhere** (only `.ats-btn-primary`), so "Run review now", "Submit
ticked changes", "Generate new ads" and "Approve · publish automatically" rendered as native white
buttons. Aliased in `css/ceo-social.css` (`.ats-scope .btn-primary`), not in `ceo-ats.css`: eleven
unrelated tests pin that file's exact buster.

## 3. Deliberately NOT changed
- `js/ceo-ads-drafts.js` (the board, editor, canvas composer, judge, approve / schedule / launch /
  archive / kit / history / filters). The mockup showed a one-row-per-draft queue; it was left out
  because the composer draws into each card's canvas and the auto-launch path for review-written
  drafts depends on that card being in the DOM. A compact row would need that path re-checked first.
- `js/ceo-ads-range.js`. It measures `#soc-range-root`'s width; when Today is hidden that is 0 and it
  falls back to 900px, and the switch repaints, so it re-measures.
- The Organic posts view.

## 4. Tests
`tests/ceo-social-hub-render.test.js` (10): the four tabs and which is showing; the counts; the
unchanged changes list (`mk-chg-check` ×2, one `disabled` after apply, `✓ Applied`, Submit once,
"1 waiting"); de-duplication (3 actions + 1 unmatched improvement = 4 to-dos, imp-17 folded into
action 0, nothing titled "What to do today" or "Suggested improvements" anywhere); writer rules
(`mk-imp-check` only for creative improvements, Generate wired); verdict on the card, evidence under
the creatives. `tests/ads-hub-routes.test.js` (+3): the to-do route (400 / 404 / tick, second key,
untick, survives a page read). `tests/ads-review.test.js` (+1): `improvement_id` passthrough.
Full suite on the rebased branch: 7,390 passed, 1 failed — `server-observability` cron-health, which
fails identically on untouched main (two Zoho crons missing from the list; not touched here).

## 5. If the owner wants the queue view next
Add an `expanded` set to `ceo-ads-drafts.js` state, render a compact row for collapsed drafts, and
keep `initCard`/`draw` for expanded ones only — but first confirm `maybeAutoCompose` and the
auto-launch save can run without the card's canvas (today they cannot).
