-- AHPRA registration granted → visa stage (owner spec 2026-11-05).
--
-- 1. registration_cases gains the registration details AHPRA's Final Notice
--    carries (number, type, effective/expiry dates, conditions) so the app can
--    track renewal and the conditions review, plus the visa-stage columns the
--    unapplied 20260404 migration promised (visa_case_id, migration agent,
--    sponsor). All additive; IF NOT EXISTS keeps this re-runnable.
-- 2. visa_documents gains a dependant link + a display label so a passport
--    request can be made per family member ("Partner's passport") and shown as
--    such on the GP's visa page.
--
-- Applied to production via rpc/exec_sql on 2026-11-05 (same path as the
-- 20260701 task_type constraint rebuild) before the feature deployed.
ALTER TABLE public.registration_cases
  ADD COLUMN IF NOT EXISTS ahpra_registration_number text,
  ADD COLUMN IF NOT EXISTS ahpra_registration_type text,
  ADD COLUMN IF NOT EXISTS ahpra_registration_effective_date date,
  ADD COLUMN IF NOT EXISTS ahpra_registration_expiry_date date,
  ADD COLUMN IF NOT EXISTS ahpra_registration_granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS ahpra_registration_has_conditions boolean,
  ADD COLUMN IF NOT EXISTS ahpra_registration_conditions jsonb,
  ADD COLUMN IF NOT EXISTS ahpra_registration_source_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS visa_case_id uuid,
  ADD COLUMN IF NOT EXISTS migration_agent text,
  ADD COLUMN IF NOT EXISTS migration_agent_contact text,
  ADD COLUMN IF NOT EXISTS sponsor_name text,
  ADD COLUMN IF NOT EXISTS sponsor_contact text;

ALTER TABLE public.visa_documents
  ADD COLUMN IF NOT EXISTS dependant_id uuid REFERENCES public.visa_dependants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS label text;

CREATE INDEX IF NOT EXISTS idx_visa_documents_dependant_id ON public.visa_documents(dependant_id);
CREATE INDEX IF NOT EXISTS idx_registration_cases_visa_case_id ON public.registration_cases(visa_case_id);
