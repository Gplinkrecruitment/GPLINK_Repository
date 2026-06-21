-- Admin audit log: append-only record of privileged admin actions (logins,
-- impersonation, destructive operations). Written by logAdminAction() in server.js.
--
-- Threat-model note: the app writes with the Supabase service-role key, which
-- BYPASSES RLS and is not constrained by PUBLIC grants. The REVOKE + RLS below
-- therefore only block the anon/authenticated PostgREST roles (and SQL-editor as
-- PUBLIC) from tampering — true immutability against the service role would need a
-- BEFORE UPDATE/DELETE trigger or an external WORM sink. For this app, the trail is
-- protected at the application layer (only INSERTs are ever issued).

create table if not exists public.admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  actor_email  text,
  actor_role   text,
  action       text not null,
  target_type  text,
  target_id    text,
  detail       jsonb not null default '{}'::jsonb,
  ip           text,
  host         text,
  user_agent   text,
  success      boolean not null default true
);

create index if not exists idx_admin_audit_created_at on public.admin_audit_log (created_at desc);
create index if not exists idx_admin_audit_action     on public.admin_audit_log (action);
create index if not exists idx_admin_audit_actor      on public.admin_audit_log (actor_email);

-- Defense-in-depth against the non-service PostgREST roles only (see note above).
alter table public.admin_audit_log enable row level security;
revoke update, delete on public.admin_audit_log from public;
