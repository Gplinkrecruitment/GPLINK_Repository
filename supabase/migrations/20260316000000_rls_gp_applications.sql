-- =============================================================================
-- Migration: 20260316000000_rls_gp_applications.sql
--
-- Security intent
-- ---------------
-- gp_applications stores a GP user's job-application records synced from
-- Zoho Recruit.  All writes (INSERT / UPDATE / DELETE) are performed
-- exclusively by server.js using the SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS by design (Supabase default behaviour — see note below).
--
-- Authenticated browser clients (using the publishable/anon key) must only
-- be able to read their own rows.  No direct mutation from the client is
-- permitted; the policies below enforce this explicitly so that even a
-- compromised or replayed JWT cannot alter another user's records.
--
-- service_role RLS bypass
-- -----------------------
-- In Supabase, the built-in `service_role` role has
-- `bypassrls = true` set at the database level.  This means server.js
-- requests made with SUPABASE_SERVICE_ROLE_KEY are never evaluated against
-- the policies defined here and will continue to work without any changes.
-- =============================================================================

-- 1. Enable Row Level Security on gp_applications.
--    No row is visible or writable to any role until an explicit POLICY
--    permits it.
ALTER TABLE gp_applications ENABLE ROW LEVEL SECURITY;

-- 2. SELECT — authenticated users may read only their own rows.
CREATE POLICY gp_applications_select_own
  ON gp_applications
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- 3. INSERT — explicitly blocked for the authenticated role.
--    All inserts are handled by server.js via the service_role key.
CREATE POLICY gp_applications_no_insert
  ON gp_applications
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

-- 4. UPDATE — explicitly blocked for the authenticated role.
--    All updates are handled by server.js via the service_role key.
CREATE POLICY gp_applications_no_update
  ON gp_applications
  FOR UPDATE
  TO authenticated
  USING (false);

-- 5. DELETE — explicitly blocked for the authenticated role.
--    All deletes are handled by server.js via the service_role key.
CREATE POLICY gp_applications_no_delete
  ON gp_applications
  FOR DELETE
  TO authenticated
  USING (false);
