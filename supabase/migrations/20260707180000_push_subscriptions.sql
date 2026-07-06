-- Phase 6 J1 — standards-based Web Push (VAPID) subscriptions.
-- One row per browser PushSubscription. The endpoint URL is unique across all
-- users (a browser endpoint belongs to whoever is currently signed in on that
-- device, so re-subscribing after a login switch simply reassigns the row).
-- Replaces the legacy user_state.gp_push_tokens FCM tokens, whose delivery
-- path (fcm.googleapis.com/fcm/send) was shut down by Google in 2024.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  email text,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
-- Service-role access only (the app server); no anon/authenticated policies.
