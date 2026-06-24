-- Supabase Security Advisor fixes (2026-06-24)
-- Resolves three "Errors" reported by the Supabase Security Advisor:
--   1. rls_disabled_in_public  -> public.rso_team had RLS disabled, making the
--      table readable/editable/deletable by anyone with the project URL + anon key.
--   2. security_definer_view    -> public.va_open_tickets_fifo
--   3. security_definer_view    -> public.ahpra_case_readiness
--
-- The app reaches the database exclusively through the service-role key
-- (supabaseDbRequest in server.js), which bypasses RLS, so enabling RLS does not
-- affect server-side access. The explicit service_role policy matches the existing
-- project convention (e.g. reg_cases_service_all) and guarantees access regardless
-- of the BYPASSRLS attribute. Neither view is queried via the anon key (the anon
-- key is used only for OTP auth in pages/signin.html), so switching them to
-- security_invoker is safe.

-- ── 1. rso_team: enable RLS + service-role full access ──
ALTER TABLE public.rso_team ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rso_team_service_all ON public.rso_team;
CREATE POLICY rso_team_service_all ON public.rso_team
  FOR ALL USING (auth.role() = 'service_role');

-- ── 2 & 3. Views: run with the querying user's permissions, not the definer's ──
ALTER VIEW public.va_open_tickets_fifo SET (security_invoker = on);
ALTER VIEW public.ahpra_case_readiness SET (security_invoker = on);
