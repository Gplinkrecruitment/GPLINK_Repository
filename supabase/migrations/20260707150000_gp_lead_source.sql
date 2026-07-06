-- Phase 6 H2 — GP source attribution ("How did you hear about us?").
--
-- Adds an OPTIONAL lead_source (+ free-text detail for Other/Referral) to
-- user_profiles, captured by the onboarding wizard's non-blocking question
-- (js/onboarding.js) and reported by GET /api/ceo/source-attribution.
--
-- Additive / non-breaking / idempotent. Apply via rpc/exec_sql with the
-- service key (schema-qualified names, per convention).
--
-- lead_source is one of: google, facebook_instagram, colleague_referral,
-- medical_college_event, other — enforced in code (lib/ceo-metrics.js
-- sanitizeLeadSource), deliberately NOT a CHECK constraint so adding a new
-- option later never needs DDL. NULL = the GP skipped the question.

ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS lead_source text;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS lead_source_detail text;

CREATE INDEX IF NOT EXISTS idx_user_profiles_lead_source
  ON public.user_profiles (lead_source)
  WHERE lead_source IS NOT NULL;
