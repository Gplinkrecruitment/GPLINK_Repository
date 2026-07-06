-- supabase/migrations/20260707150000_career_cv_practice_decision.sql
-- Career CV gate + practice Approve/Turn-Down (2026-07-06 plan)
-- Adds practice one-click decision plumbing to gp_applications.
-- The careers CV / cover letter reuse user_documents with new document_key
-- values ('career_cv', 'career_cover_letter') — no schema change needed there.

alter table public.gp_applications
  add column if not exists practice_action_token text,
  add column if not exists practice_decision text,
  add column if not exists practice_decision_at timestamptz,
  add column if not exists practice_decision_reason text,
  add column if not exists ai_recommendation text;

create index if not exists gp_applications_practice_action_token_idx
  on public.gp_applications (practice_action_token)
  where practice_action_token is not null;
