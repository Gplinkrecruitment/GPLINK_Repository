-- Phase 6 E2: enquiry → practice conversion.
--
-- 1. site_enquiries.status gains 'converted' — set only by
--    POST /api/admin/enquiry/convert after the practice row is created and
--    the intake email queued. Live prod constraint was read and verified on
--    2026-07-06 before this widening (it matched the original migration:
--    new/contacted/closed).
-- 2. practices.source gains 'website_enquiry' so converted practices are
--    distinguishable from manual/facebook_lead ones.
--
-- Both are pure CHECK widenings — existing rows all satisfy the new
-- constraints, so this is safe to run on a live database.

ALTER TABLE public.site_enquiries DROP CONSTRAINT IF EXISTS site_enquiries_status_check;
ALTER TABLE public.site_enquiries ADD CONSTRAINT site_enquiries_status_check
  CHECK (status IN ('new','contacted','closed','converted'));

ALTER TABLE public.practices DROP CONSTRAINT IF EXISTS practices_source_check;
ALTER TABLE public.practices ADD CONSTRAINT practices_source_check
  CHECK (source IN ('zoho_sync','internal_ats','manual','backfill','facebook_lead','website_enquiry'));
