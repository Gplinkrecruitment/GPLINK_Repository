# Monthly social campaign pipeline

Generate 60 creatives a month, put every one in front of the CEO, and publish two
a day to Facebook and Instagram once approved.

```
  generate (Claude + Higgsfield)         OUTSIDE the app
        │
        ▼  POST /api/admin/social/ingest
  social_campaigns + social_posts        status: draft → in_review
        │
        ▼  CEO dashboard → Social tab
  approve / reject / edit every post
        │
        ▼  POST /api/ceo/social/approve   ← stamps publish_at
  approved posts carry a schedule
        │
        ▼  /api/cron/social-publish (hourly)
  Facebook Page photo + Instagram media
```

## The one design rule

**`publish_at` is stamped at approval and nowhere else, and the publisher's query
requires it.** An unreviewed post therefore has no schedule and cannot be
selected for publishing. That is a structural guarantee, not a check somebody can
later delete by accident. Every other safety property in this pipeline is
downstream of it.

## Where generation runs

The **Higgsfield MCP connector** is interactively authenticated through claude.ai
and a Vercel cron cannot hold that session. That is a fact about the connector,
and it is why the first version of this pipeline started at ingest.

It is **not** a reason generation must stay manual. Both providers expose a
server-side API that a cron can call:

| Provider | Auth | Notes |
|---|---|---|
| **Higgsfield REST API** — `https://platform.higgsfield.ai` | `Authorization: Key <ID>:<SECRET>`, keys from [cloud.higgsfield.ai](https://cloud.higgsfield.ai) | Async: submit, then poll or take a webhook. Same models and prompts as the approved set, including `soul_2`, which has no Google equivalent. ~2 credits/image. |
| **Google Gemini** — `generativelanguage.googleapis.com/v1beta/interactions` | `x-goog-api-key`, key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-3-pro-image` **is** the model Higgsfield calls `nano_banana_pro`. One synchronous call, native 4:5. ~$0.134/image, no free tier. |

⚠️ Verify whether an API key bills separately from the subscription before
committing: the Higgsfield *subscription* enforced a ~5/day generation cap during
its grace period, which would make a 60-image run take twelve days.

| Step | Where it runs | Automated? |
|---|---|---|
| Generate 60 creatives | Provider REST API from a cron, or a Claude session | Yes, once a provider key is set |
| Ingest into the queue | `scripts/social-ingest.js`, or direct write | Yes |
| CEO review + approve | CEO dashboard, Social tab | No, deliberately |
| Publish 2/day | `/api/cron/social-publish` | Yes |
| Open next month | `/api/cron/social-campaign-open` | Yes, 20th of the month |

The review gate stays manual on purpose. Everything else can be machine-driven.

## Monthly run book

**Around the 20th**, `social-campaign-open` creates next month's empty campaign so
there is somewhere to write and ten days of slack before the 1st.

**Generate.** In a Claude session, produce ~60 creatives at **1080x1350** (4:5,
which is the only size that satisfies both networks and takes the most feed
space). Write a `posts.json` manifest next to them:

```json
[
  { "slot": 1, "file": "post-01.jpg", "caption": "…", "pillar": "Pain point" },
  { "slot": 2, "file": "post-02.jpg", "caption": "…", "pillar": "Education" }
]
```

**Upload.**

```bash
SOCIAL_INGEST_TOKEN=… node scripts/social-ingest.js \
  --dir ~/Downloads/gplink-social-2026-09 \
  --month 2026-09 --ready
```

Re-running is safe: a slot that already exists is replaced, and replacing a
creative resets it to "needs review" so an edited post cannot skip the gate.

**Review.** The Social tab shows every creative with its caption in an editable
box. Approve, reject, or fix the copy in place. The Approve button stays disabled
until every post has a decision, and the server re-checks that on submit, so a
half-reviewed month cannot be scheduled from a stale page.

**Approve.** One click schedules the month: two posts a day at 09:00 and 15:00
Melbourne time, skipping any slot already in the past. If more posts were approved
than the month has slots, the extras are reported as unscheduled rather than
silently dropped.

**Publishing** then runs itself hourly.

## Configuration

| Variable | What it is | Needed for |
|---|---|---|
| `FB_PAGE_ID` | The Facebook Page's numeric id | Facebook |
| `FB_PAGE_ACCESS_TOKEN` | Page access token, `pages_manage_posts` + `pages_read_engagement` | Both |
| `IG_USER_ID` | The Instagram **Business** account id linked to that Page | Instagram |
| `SOCIAL_INGEST_TOKEN` | Shared secret for the ingest endpoint | Upload |
| `SOCIAL_TIMEZONE` | Defaults to `Australia/Melbourne` | Scheduling |
| `SOCIAL_PUBLISH_DISABLED` | `true` schedules but holds everything | Kill switch |
| `PUBLIC_SITE_ORIGIN` | Defaults to `https://www.mygplink.com.au` | Image URLs |

The Social tab shows a red banner naming any of these that is missing, so the
owner finds out **before** approving a month rather than when nothing posts.

### Getting the token

Generate it as a **System User token** in Business Manager so it does not expire.
A user token lasts 60 days and will fail silently in the middle of a campaign.

⚠️ **Test the token before trusting a cron with it.** Meta gates
`pages_manage_posts` behind App Review in some configurations. Posting to a Page
you administer generally works without review, but confirm with one manual call
first:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<PAGE_ID>/photos" \
  -d "url=https://www.mygplink.com.au/api/public/social-image?id=<POST_ID>" \
  -d "caption=test" -d "access_token=<TOKEN>"
```

Instagram additionally requires the account to be a **Business** account (not
Creator, not personal) linked to the Page, plus `instagram_content_publish`.

## Why the image route is public

Meta's Graph API fetches the image itself, so the URL cannot be behind a session.
`/api/public/social-image?id=<uuid>` serves the bytes from Supabase Storage on a
first-party origin.

It is deliberately **not** a raw `*.supabase.co` URL: that host is dropped by iOS
content blockers and Private Relay, which already broke practice photos once (see
`normalizeSupabaseStorageUrl`), and the same URL is what the owner's browser
renders in the review grid. Exposure is bounded to an opaque UUID pointing at an
image that is about to be posted publicly anyway.

## Failure behaviour

- **Per-network results are recorded separately.** If Facebook succeeds and
  Instagram fails, the retry only attempts Instagram. A post can never be
  double-posted to a network that already worked.
- **Three attempts**, then the post is parked as `failed` with the error visible
  in the review grid. The cron is hourly, so that is a three-hour window for a
  transient Meta error to clear without letting a genuinely broken creative retry
  all month.
- **Instagram containers are polled** until `FINISHED` before publishing. Calling
  `media_publish` immediately is the classic failure and returns a confusing
  error rather than a retryable one.
- **A missing table is reported**, never treated as "no campaigns". Selecting from
  a non-existent table 400s the whole query, and swallowing that would read on
  screen as an empty month.

## Cost

Publishing is free; the Graph API has no per-post charge. The only spend is image
generation, at roughly 2 Higgsfield credits per image, so about **120 credits a
month** for 60 creatives.
