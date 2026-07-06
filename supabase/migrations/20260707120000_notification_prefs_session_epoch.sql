-- Phase 6 F4 (audit G6 + security L2):
--   1. public.notification_preferences — per-GP channel toggles for
--      NON-CRITICAL messages only (nudges / WhatsApp niceties / push niceties).
--      Transactional mail (OTP, security, document expiry, offers/interviews/
--      placements) never consults this table.
--   2. public.user_session_epoch — the "sign out of all devices" kill-switch.
--      A gp_session token is rejected only when its embedded epoch is lower
--      than the stored epoch. No row / epoch 0 = every existing session stays
--      valid, so applying this migration logs nobody out.

create table if not exists public.notification_preferences (
  email text primary key,
  email_nudges boolean not null default true,
  whatsapp boolean not null default true,
  push boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_session_epoch (
  email text primary key,
  epoch integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;
alter table public.user_session_epoch enable row level security;
-- Service-role access only (the app server); no anon/authenticated policies.
