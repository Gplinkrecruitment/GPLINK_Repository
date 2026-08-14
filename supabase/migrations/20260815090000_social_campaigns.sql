-- Monthly social campaign pipeline: generate → CEO approves → auto-publish.
--
-- The shape of the month:
--   1. A generator (a Claude session with the Higgsfield connector) produces ~60
--      creatives and POSTs them to /api/admin/social/ingest. That creates a
--      campaign in 'draft' and one social_posts row per creative.
--   2. The generator marks the campaign ready, which moves it to 'in_review' and
--      raises the alert dot on the CEO dashboard's Social tab.
--   3. The CEO reviews every image + caption, edits or rejects individual posts,
--      then approves the campaign. Approval is what stamps publish_at on each
--      approved post: two a day, at the configured local times.
--   4. /api/cron/social-publish drains whatever is due to Facebook and Instagram.
--
-- Why publish_at is stamped at APPROVAL and not at ingest: nothing may go out
-- before a human has seen it. A post with no publish_at is unschedulable by
-- construction, so a bug in the publisher cannot leak an unreviewed creative.

CREATE TABLE IF NOT EXISTS public.social_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'YYYY-MM'. One campaign per calendar month; the unique index below is what
  -- makes a re-run of the monthly opener idempotent.
  month TEXT NOT NULL,

  -- draft      → creatives are still being added
  -- in_review  → generator finished, waiting on the CEO
  -- approved   → CEO said yes; approved posts now carry a publish_at
  -- publishing → at least one post has gone out
  -- complete   → nothing left due
  -- cancelled  → abandoned; the publisher ignores it
  status TEXT NOT NULL DEFAULT 'draft',

  posts_per_day INTEGER NOT NULL DEFAULT 2,

  -- Local wall-clock times the two daily slots go out at, in time_zone.
  -- Stored as text 'HH:MM' so the schedule is readable in the row.
  slot_times JSONB NOT NULL DEFAULT '["09:00","15:00"]'::jsonb,
  time_zone TEXT NOT NULL DEFAULT 'Australia/Melbourne',

  -- Where this month's posts go. Both default on.
  targets JSONB NOT NULL DEFAULT '{"facebook":true,"instagram":true}'::jsonb,

  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,          -- moved to in_review
  approved_at TIMESTAMPTZ,
  approved_by TEXT,                  -- CEO email
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One campaign per month. A second ingest for the same month appends to the
-- existing campaign rather than creating a rival one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_campaigns_month
  ON public.social_campaigns (month);

CREATE INDEX IF NOT EXISTS idx_social_campaigns_status
  ON public.social_campaigns (status);


CREATE TABLE IF NOT EXISTS public.social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.social_campaigns(id) ON DELETE CASCADE,

  -- 1-based position within the campaign. Drives the default ordering and the
  -- slot each post lands in when the schedule is stamped.
  slot INTEGER NOT NULL,

  caption TEXT NOT NULL DEFAULT '',
  alt_text TEXT,

  -- Supabase Storage object path inside the social-creatives bucket. The bytes
  -- are never served from *.supabase.co directly: /api/public/social-image
  -- proxies them from a first-party origin, because iOS content blockers and
  -- Private Relay drop the raw project host (see normalizeSupabaseStorageUrl).
  image_path TEXT,
  image_width INTEGER,
  image_height INTEGER,

  -- draft     → ingested, not yet reviewed
  -- approved  → CEO approved; publish_at is set
  -- rejected  → CEO said no; never publishes, keeps the record
  -- posted    → live on at least one network
  -- failed    → publisher tried and gave up (see error, attempts)
  -- skipped   → due date passed while unapproved
  status TEXT NOT NULL DEFAULT 'draft',

  -- NULL until the campaign is approved. The publisher's due-query requires it,
  -- so an unreviewed post is unpublishable by construction.
  publish_at TIMESTAMPTZ,

  targets JSONB NOT NULL DEFAULT '{"facebook":true,"instagram":true}'::jsonb,

  -- Per-network results. Kept separate so a Facebook success is not lost when
  -- Instagram fails: the publisher retries only the network still outstanding.
  facebook_post_id TEXT,
  facebook_posted_at TIMESTAMPTZ,
  facebook_error TEXT,
  instagram_media_id TEXT,
  instagram_posted_at TIMESTAMPTZ,
  instagram_error TEXT,

  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,

  review_note TEXT,                  -- CEO's note when rejecting or editing
  pillar TEXT,                       -- 'Pain point' | 'Education' | ... for the review UI
  source_ref TEXT,                   -- e.g. the Higgsfield job id, for re-rolls

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The publisher's hot path: "what is due right now".
CREATE INDEX IF NOT EXISTS idx_social_posts_due
  ON public.social_posts (status, publish_at)
  WHERE publish_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_social_posts_campaign
  ON public.social_posts (campaign_id, slot);

-- A campaign's slots are unique, so a retried ingest updates in place instead of
-- duplicating a creative.
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_campaign_slot
  ON public.social_posts (campaign_id, slot);


-- Supabase grants ALL on every new public table to anon by default, so RLS is
-- the only barrier. These tables are staff-only and are reached exclusively
-- through the service role, so no anon policy is created on purpose.
-- See the 2026-08 security-advisor hardening pass for why the revoke targets
-- `public` and not `anon`: revoking from anon alone does nothing.
ALTER TABLE public.social_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_campaigns FROM public;
REVOKE ALL ON public.social_posts FROM public;
