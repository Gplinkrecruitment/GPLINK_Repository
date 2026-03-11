begin;

-- Master document template definitions (country-aware)
create table if not exists public.document_templates (
  id serial primary key,
  key text not null,
  label text not null,
  source text not null check (source in ('prepared_by_you', 'institution_docs', 'gplink_pack')),
  country_code text not null default 'all',
  sort_order int not null default 0,
  help_title text not null default '',
  help_steps jsonb not null default '[]'::jsonb,
  help_reminder text not null default '',
  created_at timestamptz not null default now(),
  unique (key, country_code)
);

-- Seed shared documents (all countries)
insert into public.document_templates (key, label, source, country_code, sort_order, help_title, help_steps, help_reminder) values
  ('primary_medical_degree', 'Primary medical degree', 'prepared_by_you', 'all', 10, 'Primary Medical Degree', '["Upload a certified copy of your primary medical degree"]', ''),
  ('cv_signed_dated', 'CV (Signed and dated)', 'prepared_by_you', 'all', 90, 'CV', '["Upload your signed and dated CV"]', ''),
  ('certificate_good_standing', 'Certificate of good standing', 'institution_docs', 'all', 100, '', '[]', ''),
  ('criminal_history', 'Criminal history check', 'institution_docs', 'all', 120, 'Criminal History Check', '["Complete your criminal history check through the approved provider"]', '')
on conflict (key, country_code) do nothing;

-- UK-specific documents
insert into public.document_templates (key, label, source, country_code, sort_order, help_title, help_steps, help_reminder) values
  ('mrcgp_certified', 'MRCGP certificate', 'prepared_by_you', 'uk', 20, 'MRCGP', '["Upload a certified copy of your MRCGP certificate"]', ''),
  ('cct_certified', 'CCT certificate', 'prepared_by_you', 'uk', 30, 'CCT', '["Upload a certified copy of your CCT certificate issued by the GMC or PMETB"]', ''),
  ('certificate_good_standing', 'Certificate of good standing', 'institution_docs', 'uk', 100, 'Certificate of Good Standing', '["Log in to your GMC Online account","In the left hand menu choose My registration","Then open My CCPS requests","Request the certificate to be sent directly to Ahpra"]', 'Reminder: this must be sent directly by the issuing authority to Ahpra.'),
  ('confirmation_training', 'Confirmation of training', 'institution_docs', 'uk', 110, 'Confirmation of Training', '["Email portfolio@gmc-uk.org","State that you require confirmation of your specialist / GP training posts","GMC will review the request and send you an application form to complete","Complete the form and return it as instructed"]', 'Reminder: request that the confirmation is sent by the GMC directly to Ahpra.')
on conflict (key, country_code) do nothing;

-- Ireland-specific documents
insert into public.document_templates (key, label, source, country_code, sort_order, help_title, help_steps, help_reminder) values
  ('micgp_certified', 'MICGP certificate', 'prepared_by_you', 'ie', 20, 'MICGP', '["Upload a certified copy of your MICGP certificate","If you do not have a copy, request a re-issue from ICGP Membership Services"]', ''),
  ('cscst_certified', 'CSCST certificate', 'prepared_by_you', 'ie', 30, 'CSCST', '["Upload a certified copy of your CSCST","If needed, request a re-issue from ICGP Membership Services"]', ''),
  ('icgp_confirmation_letter', 'ICGP confirmation letter', 'prepared_by_you', 'ie', 40, 'ICGP Confirmation Letter', '["Contact ICGP Membership Services","Request a confirmation / verification letter confirming your qualification was awarded under the ICGP curriculum after completion of the approved GP training pathway","If needed, request verification of training through ICGP"]', 'This is the key supporting letter for Irish GPs.'),
  ('certificate_good_standing', 'Certificate of good standing / registration status', 'institution_docs', 'ie', 100, 'Certificate of Good Standing / Registration Status', '["Request a current certificate of good standing / registration status from your Irish regulator","Ensure it is sent in the required format for Ahpra"]', 'Reminder: this must be sent directly where required.')
on conflict (key, country_code) do nothing;

-- New Zealand-specific documents
insert into public.document_templates (key, label, source, country_code, sort_order, help_title, help_steps, help_reminder) values
  ('frnzcgp_certified', 'FRNZCGP certificate', 'prepared_by_you', 'nz', 20, 'FRNZCGP', '["Upload a certified copy of your FRNZCGP certificate","If needed, contact RNZCGP for replacement or confirmation"]', ''),
  ('rnzcgp_confirmation_letter', 'RNZCGP confirmation letter', 'prepared_by_you', 'nz', 30, 'RNZCGP Confirmation Letter', '["Contact RNZCGP","Request a confirmation letter stating that your fellowship was awarded under the RNZCGP curriculum following satisfactory completion of GPEP"]', ''),
  ('certificate_good_standing', 'Certificate of good standing / registration status', 'institution_docs', 'nz', 100, 'Certificate of Good Standing / Registration Status', '["Request your current certificate of good standing / registration status from the relevant New Zealand authority","Ensure it is provided in a format acceptable for Ahpra"]', '')
on conflict (key, country_code) do nothing;

-- Per-user document instances (for future admin review workflows)
create table if not exists public.user_documents (
  id serial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_key text not null,
  country_code text not null default 'uk',
  status text not null default 'pending' check (status in ('pending', 'requested', 'uploaded', 'under_review', 'approved', 'accepted', 'rejected', 'action_required')),
  file_name text not null default '',
  file_url text not null default '',
  review_notes text not null default '',
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, document_key, country_code)
);

drop trigger if exists trg_user_documents_updated_at on public.user_documents;
create trigger trg_user_documents_updated_at
before update on public.user_documents
for each row
execute function public.set_updated_at();

-- RLS for user_documents
alter table public.user_documents enable row level security;

drop policy if exists "user_documents_select_own" on public.user_documents;
create policy "user_documents_select_own"
on public.user_documents
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "user_documents_insert_own" on public.user_documents;
create policy "user_documents_insert_own"
on public.user_documents
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "user_documents_update_own" on public.user_documents;
create policy "user_documents_update_own"
on public.user_documents
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- RLS for document_templates (read-only for authenticated users)
alter table public.document_templates enable row level security;

drop policy if exists "document_templates_select" on public.document_templates;
create policy "document_templates_select"
on public.document_templates
for select
to authenticated
using (true);

commit;
