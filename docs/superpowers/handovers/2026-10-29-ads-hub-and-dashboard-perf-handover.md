# Ads hub (Social tab) + CEO dashboard performance — handover

**Date:** 2026-10-29 · **Ad account:** `1668035273758338` (AUD) · **Live ad set:** `120249238461470648`
(`Test | Pain points · before vs split | 30 Sep 2026 – Copy`, AU$100/day, qualified-leads goal, 7 live ads)

Two things shipped together because the owner asked for both in one breath:

1. **The Social tab is now the Ads hub.** Every morning: a summary of yesterday and the week
   written by Claude Opus 5.5 from the real Meta numbers and the app's own booking funnel, the
   creatives that are live with their cost per booking and the owner's rotation-rule flags, the
   model's suggested improvements, and a drafts board where new ads are written by the model,
   edited and iterated on the page, composed into a 1080x1350 creative in the browser,
   scheduled, and created in the live ad set. The old monthly organic review is unchanged
   behind the "Organic posts" switch.
2. **The dashboard no longer feels like it reloads.** Tab switches reuse what is on screen,
   actions repaint in place, the hidden Overview stops polling, a save no longer wipes every
   tab's cache, and the two things that really did navigate the page (the deploy "Reload now"
   bar sitting over the tab bar, and Export CSV links that navigated to JSON on error) are gone.

---

## 1. What is live

### Files
| Area | Files |
|---|---|
| Meta reads/writes | `lib/meta-ads.js` (pure helpers + Graph client with injectable fetch) |
| The model | `lib/ads-review.js` (prompts, schemas, parser, raw-HTTP call to `claude-opus-5-5`) |
| Server | `server.js` — helpers before `checkAnthropicBudget()`, routes before `/api/cron/onboarding-nudge`; cron registry entries `ads-daily-review`, `ads-launch`; `vercel.json` crons |
| Tables | `supabase/migrations/20261029120000_ads_hub.sql` — `ad_reviews`, `ad_drafts`. **Applied to prod 2026-10-29** via `rpc/exec_sql` (param `query`), verified by REST read-back, ledger row inserted |
| Client | `js/ceo-social.js` (hub), `js/ceo-ads-drafts.js` (drafts + canvas composer), `js/ceo-social-organic.js` (the old tab, moved), `css/ceo-social.css` (appended), `media/fonts/Figtree-*.ttf` |
| Tests | `tests/ads-hub-routes.test.js` (19, real server, local mode), `tests/meta-ads.test.js`, `tests/ads-review.test.js`, `tests/ceo-dashboard-perf.test.js` (25), `tests/fixtures/meta-ads-graph.js` |

### Endpoints (all `requireCeoSession`)
`GET /api/ceo/ads` (stored snapshot by default, `?live=1` pulls) · `POST /api/ceo/ads/refresh` ·
`POST /api/ceo/ads/review` (runs the model now) · `GET /api/ceo/ads/health` (what the token can
do) · `GET /api/ceo/ads/photos` (ad-account image library) · `GET /api/ceo/ads/photo-proxy?url=`
(Meta CDN → our origin, host-allowlisted, so the canvas is not tainted) ·
`GET /api/ceo/ads/image?id=&kind=photo|creative` · `POST /api/ceo/ads/drafts/generate` ·
`POST /api/ceo/ads/drafts/create` · `POST /api/ceo/ads/draft` (edit; images as data URLs) ·
`POST /api/ceo/ads/draft/iterate` · `/schedule` · `/unschedule` · `/launch-now`.
Crons: `GET /api/cron/ads-daily-review` (21:30 UTC ≈ 08:30 Melbourne) and `GET /api/cron/ads-launch`
(every 15 min), both behind `CRON_SECRET`.

### The one design rule
**A draft only reaches Meta with `status: scheduled` and a `launch_at`, and the launcher
writes each Meta id (image hash → creative id → ad id) the moment Meta returns it.** A retry
resumes from the ids already stored, so a failure on step three can never upload the picture
twice or create a second creative. Three failed attempts park the draft as `failed` with the
Meta error shown verbatim on the card plus a "manual kit" (every field, the form id, the URL
tags, the download link for the composed image) for Ads Manager.

---

## 2. What the owner has to do (nothing else works until the first one)

1. **Set `META_ADS_ACCESS_TOKEN` in Vercel (production).** Business Settings → System Users →
   the GP Link system user → *Assign assets*: the ad account `1668035273758338` (Manage) and
   the Page `769864969547691` (Manage) → *Generate token* with `ads_read`, `ads_management`,
   `pages_manage_ads` (and `leads_retrieval` is harmless). **Then redeploy** (Vercel →
   Deployments → ⋯ → Redeploy): serverless functions read env at deploy time. Until it is set
   the page shows the app's own lead funnel only and says so in red. The code falls back to
   `META_CAPI_ACCESS_TOKEN` (the CRM stage-feed System User token) — it *may* already carry
   `ads_read`; the **Check connection** button on the page says exactly what the active token
   can read and whether it can create ads.
2. Click **Run review now** once; the morning cron then takes over.
3. The first launch from the page is the real test of ad creation (see §4.1). Watch the card:
   it either shows the Meta ad id with an Ads Manager link, or the exact error and the kit.

4. **Photos from the brief (optional): `HIGGSFIELD_API_KEY`** in Vercel, value `KEY_ID:KEY_SECRET`
   from console.higgsfield.ai → API keys. The draft card then shows **Generate photo**, which
   posts the brief to `api.higgsfield.ai` (SOUL, 4:5), waits (about a minute), and stores the
   result as the draft's photo (`lib/higgsfield.js`, `POST /api/ceo/ads/draft/generate-photo`).
   Their result URLs expire after 7 days, which is why the bytes are copied into our bucket.
   Two things the docs disagree on are handled in code: the quickstart path is
   `/higgsfield-ai/soul/v2/standard`, the OpenAPI spec says `/higgsfield-ai/soul/standard`
   (tried in that order; a 404 falls through), and the optional fields `aspect_ratio`,
   `resolution`, `num_images` are dropped on a 400 that names one. **Untested against a real
   key** (none available in this session); `tests/higgsfield.test.js` covers the client logic.

Optional: `ADS_LAUNCH_DISABLED=true` holds every launch (drafts still schedule);
`ADS_REVIEW_MODEL` overrides the model (default `claude-opus-5-5`); `META_ADS_DEFAULT_ADSET_ID`,
`META_ADS_CAMPAIGN_ID`, `META_LEAD_FORM_ID`, `META_AD_ACCOUNT_ID`, `META_ADS_PAGE_ID` override the
2026-10-29 defaults baked into `lib/meta-ads.js`.

---

## 3. Verified, measured, decided

- **The model call works and the output is the right shape.** Run live on 2026-10-29 against a
  Graph-shaped fixture of the real account (`tests/fixtures/meta-ads-graph.js`): 82 s,
  7.7k input / 8.2k output tokens, no fallback. It applied the rotation rule per ad, named the
  one ad to pause, listed six actions with where to do them, seven improvements with evidence,
  and three complete briefs (angle, image line, sub-line, three paragraphs ending with the
  closer, photo brief). It also spotted a fixture artefact ("30-day numbers mix in leads from
  the paused ad set without its spend"), which is the honesty the prompt asks for.
- **`output_config.format` (structured output) rejects `maxItems`, `minimum`, `maximum`** inside
  the schema — "For 'array' type, property 'maxItems' is not supported". Every limit now lives
  in the description and is enforced in `normaliseReview()`. `$defs`/`$ref` were removed too
  (inlined) to stay safe.
- **Thinking tokens count against `max_tokens`.** At effort `high`, Opus spent all 16k on
  reasoning and returned no text at all (152 s, `stop_reason` max_tokens). Effort `medium`
  with `max_tokens` 24000 returns in 80–130 s. Do not raise effort without raising the cap,
  and keep both under Vercel's 300 s function ceiling.
- **Reach is not additive across ads**, so the headline totals come from Meta's campaign row
  per window (`fetchCampaignInsights`), not a sum of the ad rows (which gave frequency 1.9
  where Meta says 3.3).
- **Cost per booking is `null`, never 0, when the window has no spend**: a booking from an
  ad that spent nothing this week is a lagging lead, not a free booking.
- **`BOOK_TRAVEL` is what Ads Manager calls "Book now" on a lead ad.** Every live creative
  carries it; it is the drafts' default.
- **Production tokens cannot be read from here.** Vercel returns "sensitive" env values as
  nothing and "encrypted" ones as an envelope, so whether the existing tokens can read the ad
  account is only knowable from the page's health check after deploy.
- **The organic pipeline is in use** (61 posts across Aug–Oct 2026, Nov shell open), which is
  why it was moved rather than removed.

### Dashboard performance (measured by code reading, not in a browser)
Root causes found and fixed — all in the inline script of `pages/ceo-dashboard.html`,
`js/ceo-ats-shared.js` and the `js/ceo-ats-*.js` modules:
1. The deploy "new version — Reload now" bar rendered full-width at `top:0` over the tabs
   (`js/ceo-review-queue.js`). A click aimed at a tab after any deploy reloaded the page. Now a
   bottom-right notice with Reload / Later.
2. Export CSV `<a>` links navigated the tab to JSON on any non-200. Now fetched into a Blob;
   failures toast.
3. `setActiveTab` re-ran the loader on every click including the active tab; every loader
   painted "Loading…" and refetched; returning to a tab dropped the open profile/board. Now:
   re-click is a no-op, revisits within 5 min load quietly in place and leave drill-ins alone.
4. After almost every action the opener re-ran with a placeholder and a scroll to top. Now
   `{quiet:true}` repaints in place and keeps scroll.
5. The hidden Overview polled every 30 s (10 sub-requests) regardless of tab. Now gated on the
   Overview being active; the 5 sub-requests fire once per cycle; an open drilldown survives.
6. Any non-GET purged the whole SWR cache. Now `__gpSwr.invalidate(path)` drops only the
   resource family (+ dashboard, review-queue).
7. Boot chip fetches (full candidate/jobs/practices lists just for counts) deferred to idle;
   jobs search debounced; the Jobs map's resize listeners bound once.

---

## 4. Open risks and what to try first

1. **Ad creation over the API is untested against this account.** Every edit to a lead-form ad
   set has failed with error 1815089 for the MCP connector (which lacks `pages_manage_ads`). A
   System User token *with* `pages_manage_ads` should pass; if the first launch still returns
   1815089 the card says so and the manual kit covers it. Nothing is half-created: the
   image hash and creative id are kept, so a later retry only repeats the step that failed.
2. **No image generation in the app.** Production has no Gemini/Higgsfield key. The composer
   takes an uploaded photo or one of the ad account's existing photos (proxied), and each
   draft carries the model's photo brief with a "Copy photo brief" button for Higgsfield.
   Adding generation = one function in `lib/meta-ads.js`'s sibling and a key.
3. **The stored snapshot's creative image URLs are Meta CDN links that expire** (weeks). The
   live-creatives cards fall back to the headline on a navy block when one 404s; the morning
   run refreshes them.
4. The model sometimes calls link clicks "form opens" (correct for lead ads) — fine, but the
   KPI tiles say "Link clicks". If the owner finds that confusing, rename the tile.
5. **Browser-verified 2026-10-29 in headless Chrome 156** (driven over the DevTools protocol
   against a local boot of the real server seeded with the real Opus review and the fixture
   snapshot): the tab loads, the summary and verdicts render, a photo uploaded into a draft
   composes with the headline in Figtree, Save stores the 1080x1350 creative and the server
   serves it back. That run caught one real bug, fixed the same day: the page's
   `img-src` CSP does not allow `*.fbcdn.net`, so the live creatives' Meta images were
   blocked; they now go through `/api/ceo/ads/photo-proxy`. The driver script is in the job
   tmp (`verify/cdp.js`); the pattern (createServer + listen, cookie via Network.setCookie,
   `--host-resolver-rules` for the super-admin host) is the way to screenshot the CEO
   dashboard without a browser session.

---

## 5. How to verify

- Page: `GET https://app.mygplink.com.au/api/ceo/ads` with a CEO session → `configured`,
  `snapshot_source`, `review`, `drafts`.
- Rows: `GET $SUPABASE_URL/rest/v1/ad_reviews?select=review_date,kind,error,created_at&order=created_at.desc&limit=5`.
- Cron health: the Technical tab's cron table (`ads-daily-review`, `ads-launch`) via `recordCronRun`.
- Tests: `npx vitest run tests/ads-hub-routes.test.js tests/meta-ads.test.js tests/ads-review.test.js tests/ceo-dashboard-perf.test.js tests/ceo-social-tab-wiring.test.js tests/ceo-social-approve-toast-storm.test.js`.
- A real model run costs about US$0.20 (Opus 5.5 at $4/$20 per MTok, ~8k in / ~8k out).

## 6. Traps
- `node server.js` does not listen when `NODE_ENV=test`; boot through `createServer()`
  (as the tests do) for a local run. macOS has no `timeout` command.
- The CEO surface answers 404, not 401, to a caller on a host outside
  `SUPER_ADMIN_ALLOWED_HOSTS` (and to no session), so a bare curl of a CEO route proves nothing.
- `exec_sql` takes `{"query": ...}` and returns 204 with no body; PostgREST's schema cache can
  lag a new table by seconds — `NOTIFY pgrst, 'reload schema'` then re-read.
- `js/*` and `css/*` are immutable-cached for a year: bump `?v=` on every change
  (`tests/ceo-social-tab-wiring.test.js` pins the busters).
- The drafts board owns `#soc-drafts-root`; the hub keeps that node across its repaints. Never
  `innerHTML` the whole `#panel-social` from anywhere else.
- `recordAnthropicSpend` prices at Sonnet rates; the daily budget check is approximate.
