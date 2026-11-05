-- registration_tasks.domain + visa_case_id were promised by the unapplied
-- 20260404 va_ops_unified migration and are used by the visa code paths
-- (visa document review tasks, visa case setup, the registration-granted
-- passports task). In production the insert was rejected with PGRST204
-- ("Could not find the 'domain' column") on 2026-11-05. Additive, re-runnable.
-- Applied to production via rpc/exec_sql on 2026-11-05.
ALTER TABLE public.registration_tasks
  ADD COLUMN IF NOT EXISTS domain text,
  ADD COLUMN IF NOT EXISTS visa_case_id uuid;
CREATE INDEX IF NOT EXISTS idx_registration_tasks_visa_case_id ON public.registration_tasks(visa_case_id);
