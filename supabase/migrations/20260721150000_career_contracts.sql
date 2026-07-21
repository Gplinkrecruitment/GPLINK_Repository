-- Post-interview contract pipeline (owner spec 2026-07-21):
-- interview happens -> practice extends offer by uploading a contract ->
-- CEO + AI review -> GP signs (upload) or requests changes -> signed = placement.
create table if not exists public.career_contracts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.gp_applications(id) on delete cascade,
  user_id uuid,
  career_role_id bigint,
  version integer not null default 1,
  status text not null default 'awaiting_upload'
    check (status in ('awaiting_upload','uploaded','sent_to_gp','changes_requested','practice_review','signed','void')),
  contract_bucket text,
  contract_path text,
  contract_filename text,
  contract_mime text,
  signed_bucket text,
  signed_path text,
  signed_filename text,
  ai_review jsonb,
  ai_review_status text not null default 'not_run'
    check (ai_review_status in ('not_run','running','done','error')),
  terms_context jsonb,
  change_request text,
  change_response text,
  ceo_note text,
  practice_contact_email text,
  practice_contact_name text,
  uploaded_at timestamptz,
  sent_to_gp_at timestamptz,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists career_contracts_app_idx on public.career_contracts (application_id, version desc);
create index if not exists career_contracts_status_idx on public.career_contracts (status);
alter table public.gp_applications add column if not exists post_interview_email_sent_at timestamptz;
alter table public.gp_applications add column if not exists interview_completed_at timestamptz;
