-- Adds the 'consultant' role (ATS-only recruiters) to public.user_roles.
--
-- NOT applied automatically — apply later via rpc/exec_sql with the service key
-- (see docs/superpowers plans; schema-qualify names). Before applying, read the
-- LIVE constraint definition first (constraints have drifted from migration
-- files before) and re-derive the value list from it, adding 'consultant'.
--
-- The code works WITHOUT this migration: consultant access resolves from the
-- CONSULTANT_EMAILS env allowlist and the runtime_kv 'ats_consultants' JSON
-- array. Applying this only enables storing role='consultant' rows in
-- user_roles (which then win over env/kv resolution at login).
--
-- Same drop/add pattern as 20260320043000_super_admin_roles.sql. The
-- is_admin()/is_super_admin() helper functions are intentionally untouched:
-- consultants are NOT admins for RLS purposes.

begin;

alter table public.user_roles
  drop constraint if exists user_roles_role_check;

alter table public.user_roles
  add constraint user_roles_role_check
  check (role in ('gp', 'staff', 'admin', 'super_admin', 'consultant'));

commit;
