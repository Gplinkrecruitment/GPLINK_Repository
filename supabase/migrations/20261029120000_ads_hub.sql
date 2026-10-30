-- CEO dashboard → Social tab → "Ads" hub.
--
-- Two tables:
--   ad_reviews  one row per Opus review run (daily cron or on demand). Holds the
--               performance snapshot the model was shown AND the model's answer,
--               so the morning summary loads from a row instead of six Meta
--               calls plus a model call, and so a verdict can always be traced
--               back to the numbers it was based on.
--   ad_drafts   new ads written on the page (by the model, then edited and
--               iterated by the owner), composed into a 1080x1350 creative,
--               scheduled, and launched into the Meta ad set by the cron.
--
-- Why launch state lives per step (image hash, creative id, ad id): Meta ad
-- creation is three calls, and a failure on the third must not re-upload the
-- image or create a second creative on retry. Each id is written as soon as
-- Meta returns it, and the launcher resumes from whatever is already there.

CREATE TABLE IF NOT EXISTS public.ad_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The local (SOCIAL_TIMEZONE, Australia/Melbourne) calendar day the review
  -- was run on. 'daily' runs once per day from the cron; 'manual' is the
  -- owner's "Run review now" button and can happen any number of times.
  review_date DATE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'daily',

  -- Everything the model saw: ads, creatives, metrics per window, the app-side
  -- booking funnel joined by ad id, and the 14-day daily series.
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The model's answer, validated against lib/ads-review.js REVIEW_SCHEMA:
  -- headline, summary, actions_today[], ad_verdicts[], improvements[],
  -- new_ad_briefs[].
  review JSONB NOT NULL DEFAULT '{}'::jsonb,

  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,

  -- Set when the model call failed; the snapshot is still stored so the page
  -- can show numbers even when there is no commentary.
  error TEXT,

  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_reviews_date
  ON public.ad_reviews (review_date DESC, created_at DESC);


CREATE TABLE IF NOT EXISTS public.ad_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- draft      → written, being edited
  -- ready      → owner marked it good (creative composed)
  -- scheduled  → launch_at set; the cron will create the ad when due
  -- launching  → a launch attempt is in flight / partially done
  -- live       → the ad exists in Meta (meta_ad_id set)
  -- failed     → three launch attempts failed; launch_error says why
  -- archived   → kept for the record, never launched
  status TEXT NOT NULL DEFAULT 'draft',

  -- Short label for the angle, e.g. '02-cqc-tuesday'. Becomes the Meta ad name
  -- (and therefore utm_campaign), so keep it short and without spaces.
  angle TEXT,

  -- The ad copy as Ads Manager names it.
  headline TEXT NOT NULL DEFAULT '',
  primary_text TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',

  -- What is drawn ON the image by the in-page composer.
  image_headline TEXT NOT NULL DEFAULT '',
  image_sub TEXT NOT NULL DEFAULT '',

  -- Photo brief for a generator (Higgsfield / Gemini) or for the owner.
  image_prompt TEXT,

  -- Composer settings: { placement: 'bottom'|'top', focus: 0..1 }.
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Storage object paths inside the social-creatives bucket (never served from
  -- *.supabase.co directly — see /api/ceo/ads/image).
  photo_path TEXT,            -- the clean photograph (uploaded or generated)
  image_path TEXT,            -- the composed 1080x1350 creative
  image_width INTEGER,
  image_height INTEGER,

  -- Meta call-to-action type. 'BOOK_TRAVEL' is what Ads Manager calls
  -- "Book now" on a lead ad (that is what the live ads carry).
  cta TEXT NOT NULL DEFAULT 'BOOK_TRAVEL',

  -- Why the model proposed it and which review improvements it applies.
  rationale TEXT,
  improvements JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Every iteration: [{ at, by, instruction, before: {headline,...} }].
  history JSONB NOT NULL DEFAULT '[]'::jsonb,

  review_id UUID REFERENCES public.ad_reviews(id) ON DELETE SET NULL,

  -- Where and when it launches.
  adset_id TEXT,
  launch_at TIMESTAMPTZ,

  -- Launch state, one id per Meta step so a retry resumes instead of repeating.
  meta_image_hash TEXT,
  meta_creative_id TEXT,
  meta_ad_id TEXT,
  launch_error TEXT,
  launch_attempts INTEGER NOT NULL DEFAULT 0,
  last_launch_attempt_at TIMESTAMPTZ,
  launched_at TIMESTAMPTZ,

  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The launcher's hot path: "what is due right now".
CREATE INDEX IF NOT EXISTS idx_ad_drafts_due
  ON public.ad_drafts (status, launch_at)
  WHERE launch_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ad_drafts_status
  ON public.ad_drafts (status, created_at DESC);

-- Staff-only, reached exclusively through the service role (same reasoning as
-- the social tables: Supabase grants ALL to anon by default, so RLS with no
-- anon policy is the barrier, and the revoke targets `public`).
ALTER TABLE public.ad_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_reviews FROM public;
REVOKE ALL ON public.ad_drafts FROM public;
