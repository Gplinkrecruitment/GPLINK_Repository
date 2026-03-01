begin;

-- Roles table for admin/staff permissions.
create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('gp', 'admin', 'staff')) default 'gp',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = uid
      and r.role in ('admin','staff')
  );
$$;

-- Main AHPRA case state (one per candidate user).
create table if not exists public.ahpra_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started','in_progress','action_required','complete')),
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),

  stage_1_account_created boolean not null default false,
  stage_1_ahpra_user_id text not null default '',
  stage_1_completed_at timestamptz,

  stage_2_submitted boolean not null default false,
  stage_2_submitted_date date,
  stage_2_reference_number text not null default '',
  stage_2_download_attempted_at timestamptz,
  stage_2_missing_count integer not null default 0,
  stage_2_missing_names jsonb not null default '[]'::jsonb,
  stage_2_completed_at timestamptz,

  stage_3_assessment_status text not null default 'not_started' check (stage_3_assessment_status in ('not_started','under_review','further_info_requested','approved','refused')),
  stage_3_latest_note text not null default '',
  stage_3_last_updated_at timestamptz,
  stage_3_gp_responded_at timestamptz,
  stage_3_completed_at timestamptz,

  stage_4_registration_granted boolean,
  stage_4_registration_number text not null default '',
  stage_4_has_conditions boolean,
  stage_4_conditions_details text not null default '',
  stage_4_expiry_date date,
  stage_4_completed_at timestamptz,

  action_required_flag boolean not null default false,
  action_required_message text not null default '',
  locked_previous_stages boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists idx_ahpra_cases_user_id on public.ahpra_cases(user_id);
create index if not exists idx_ahpra_cases_status on public.ahpra_cases(status);

-- Required document catalog, country-aware and stage-aware.
create table if not exists public.ahpra_required_documents (
  id uuid primary key default gen_random_uuid(),
  doc_key text not null,
  country_code text not null default 'uk',
  stage_key text not null default 'stage_2',
  source_type text not null check (source_type in ('gp','gplink')),
  display_name text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (doc_key, country_code, stage_key)
);

create index if not exists idx_ahpra_required_docs_country on public.ahpra_required_documents(country_code, stage_key, source_type, sort_order);

-- Per-case document state mapped to storage object paths.
create table if not exists public.ahpra_case_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.ahpra_cases(id) on delete cascade,
  doc_key text not null,
  source_type text not null check (source_type in ('gp','gplink')),
  status text not null default 'not_ready' check (status in ('not_ready','pending','ready','rejected')),
  storage_bucket text not null default 'gp-link-documents',
  storage_path text,
  file_name text not null default '',
  admin_note text not null default '',
  review_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, doc_key)
);

create index if not exists idx_ahpra_case_docs_case on public.ahpra_case_documents(case_id, source_type);
create index if not exists idx_ahpra_case_docs_status on public.ahpra_case_documents(status);

-- Timeline event log used for updates + auditing.
create table if not exists public.ahpra_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.ahpra_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  actor_role text not null default 'system' check (actor_role in ('gp','admin','staff','system')),
  event_type text not null,
  title text not null,
  detail text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ahpra_events_case_created on public.ahpra_events(case_id, created_at desc);
create index if not exists idx_ahpra_events_user_created on public.ahpra_events(user_id, created_at desc);

-- Notification queue/foundation.
create table if not exists public.ahpra_notifications (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.ahpra_cases(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'in_app' check (channel in ('in_app','email','push')),
  type text not null default 'info' check (type in ('info','action','success')),
  title text not null,
  detail text not null default '',
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_ahpra_notifications_recipient on public.ahpra_notifications(recipient_user_id, read_at, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_roles_updated_at on public.user_roles;
create trigger trg_user_roles_updated_at
before update on public.user_roles
for each row
execute function public.set_updated_at();

drop trigger if exists trg_ahpra_cases_updated_at on public.ahpra_cases;
create trigger trg_ahpra_cases_updated_at
before update on public.ahpra_cases
for each row
execute function public.set_updated_at();

drop trigger if exists trg_ahpra_case_documents_updated_at on public.ahpra_case_documents;
create trigger trg_ahpra_case_documents_updated_at
before update on public.ahpra_case_documents
for each row
execute function public.set_updated_at();

-- Seed UK required docs.
insert into public.ahpra_required_documents (doc_key, country_code, stage_key, source_type, display_name, sort_order)
values
  ('primary_medical_degree','uk','stage_2','gp','Certified copy of Primary Medical Degree (MBBS/MBChB)',1),
  ('mrcgp_certified','uk','stage_2','gp','Certified copy of MRCGP (issued from Aug 2007 onward)',2),
  ('cct_certified','uk','stage_2','gp','Certified copy of CCT (General Practice)',3),
  ('cv_signed_dated','uk','stage_2','gp','CV (Signed + dated)',4),
  ('sppa_00','uk','stage_2','gplink','Supervised Practice Plan - SPPA-00',10),
  ('section_g','uk','stage_2','gplink','Supervised Practice Plan - Section G',11),
  ('position_description','uk','stage_2','gplink','Position Description',12),
  ('offer_contract','uk','stage_2','gplink','Letter of Offer / Employment Contract',13),
  ('supervisor_cv','uk','stage_2','gplink','Supervisor''s CV',14)
on conflict (doc_key, country_code, stage_key) do update
set
  source_type = excluded.source_type,
  display_name = excluded.display_name,
  sort_order = excluded.sort_order,
  active = true;

-- Helper view for readiness counters and missing docs.
create or replace view public.ahpra_case_readiness as
select
  c.id as case_id,
  c.user_id,
  count(*) filter (where d.source_type = 'gp') as gp_total,
  count(*) filter (where d.source_type = 'gp' and d.status = 'ready') as gp_ready,
  count(*) filter (where d.source_type = 'gplink') as gplink_total,
  count(*) filter (where d.source_type = 'gplink' and d.status = 'ready') as gplink_ready,
  count(*) filter (where d.status = 'rejected') as rejected_count,
  count(*) filter (where d.status in ('not_ready','pending','rejected')) as missing_count
from public.ahpra_cases c
left join public.ahpra_case_documents d on d.case_id = c.id
group by c.id, c.user_id;

create or replace function public.log_ahpra_event(
  p_case_id uuid,
  p_event_type text,
  p_title text,
  p_detail text default '',
  p_payload jsonb default '{}'::jsonb,
  p_notify_type text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case public.ahpra_cases;
  v_actor uuid := auth.uid();
  v_actor_role text := 'system';
  v_event_id uuid;
begin
  select * into v_case from public.ahpra_cases where id = p_case_id;
  if not found then
    raise exception 'AHPRA case not found: %', p_case_id;
  end if;

  if v_actor is not null then
    if public.is_admin(v_actor) then
      v_actor_role := 'admin';
    elsif v_actor = v_case.user_id then
      v_actor_role := 'gp';
    else
      v_actor_role := 'staff';
    end if;
  end if;

  insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail, payload)
  values (p_case_id, v_case.user_id, v_actor, v_actor_role, p_event_type, p_title, coalesce(p_detail, ''), coalesce(p_payload, '{}'::jsonb))
  returning id into v_event_id;

  if p_notify_type is not null then
    insert into public.ahpra_notifications(case_id, recipient_user_id, type, title, detail, payload)
    values (p_case_id, v_case.user_id, p_notify_type, p_title, coalesce(p_detail, ''), coalesce(p_payload, '{}'::jsonb));
  end if;

  return v_event_id;
end;
$$;

create or replace function public.get_ahpra_readiness(p_case_id uuid)
returns table (
  gp_total integer,
  gp_ready integer,
  gplink_total integer,
  gplink_ready integer,
  rejected_count integer,
  missing_count integer
)
language sql
stable
as $$
  select r.gp_total, r.gp_ready, r.gplink_total, r.gplink_ready, r.rejected_count, r.missing_count
  from public.ahpra_case_readiness r
  where r.case_id = p_case_id
$$;

create or replace function public.mark_ahpra_download_attempt(p_case_id uuid, p_missing_names jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing_count integer := coalesce(jsonb_array_length(coalesce(p_missing_names, '[]'::jsonb)), 0);
begin
  update public.ahpra_cases
  set
    stage_2_download_attempted_at = now(),
    stage_2_missing_count = v_missing_count,
    stage_2_missing_names = coalesce(p_missing_names, '[]'::jsonb)
  where id = p_case_id;

  perform public.log_ahpra_event(
    p_case_id,
    'stage_2_download_all_attempted',
    'Download all attempted',
    format('Missing documents: %s', v_missing_count),
    jsonb_build_object('missing_names', coalesce(p_missing_names, '[]'::jsonb)),
    case when v_missing_count > 0 then 'action' else 'info' end
  );
end;
$$;

create or replace function public.handle_ahpra_case_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage_1_completed_at is distinct from old.stage_1_completed_at and new.stage_1_completed_at is not null then
    insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail)
    values (new.id, new.user_id, auth.uid(), case when public.is_admin(auth.uid()) then 'admin' else 'gp' end, 'stage_1_completed', 'Stage 1 completed', 'Create AHPRA Account marked complete.');
    insert into public.ahpra_notifications(case_id, recipient_user_id, type, title, detail)
    values (new.id, new.user_id, 'success', 'AHPRA Stage 1 completed', 'Create AHPRA Account was marked complete.');
  end if;

  if new.stage_2_submitted = true and old.stage_2_submitted is distinct from true then
    insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail, payload)
    values (
      new.id, new.user_id, auth.uid(), case when public.is_admin(auth.uid()) then 'admin' else 'gp' end,
      'stage_2_submitted',
      'Stage 2 submitted',
      'AHPRA submission details recorded.',
      jsonb_build_object('submitted_date', new.stage_2_submitted_date, 'reference_number', new.stage_2_reference_number)
    );
    insert into public.ahpra_notifications(case_id, recipient_user_id, type, title, detail)
    values (new.id, new.user_id, 'success', 'AHPRA Stage 2 submitted', 'Submission details were recorded successfully.');
  end if;

  if new.stage_3_assessment_status is distinct from old.stage_3_assessment_status then
    insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail)
    values (
      new.id, new.user_id, auth.uid(),
      case when public.is_admin(auth.uid()) then 'admin' else 'gp' end,
      'assessment_status_changed',
      'Assessment status changed',
      format('Assessment status updated to %s', replace(new.stage_3_assessment_status, '_', ' '))
    );
    insert into public.ahpra_notifications(case_id, recipient_user_id, type, title, detail)
    values (
      new.id,
      new.user_id,
      case when new.stage_3_assessment_status = 'further_info_requested' then 'action' else 'info' end,
      'Assessment status updated',
      format('New status: %s', replace(new.stage_3_assessment_status, '_', ' '))
    );
  end if;

  if new.stage_3_gp_responded_at is distinct from old.stage_3_gp_responded_at and new.stage_3_gp_responded_at is not null then
    insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail)
    values (new.id, new.user_id, auth.uid(), 'gp', 'gp_responded', 'Candidate marked response uploaded', 'GP clicked I''ve responded / uploaded requested info.');
  end if;

  if new.stage_4_completed_at is distinct from old.stage_4_completed_at and new.stage_4_completed_at is not null then
    insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail, payload)
    values (
      new.id, new.user_id, auth.uid(),
      case when public.is_admin(auth.uid()) then 'admin' else 'gp' end,
      'registration_outcome_recorded',
      'Registration outcome recorded',
      case when new.stage_4_registration_granted then 'Registration granted.' else 'Registration not granted.' end,
      jsonb_build_object('registration_number', new.stage_4_registration_number, 'has_conditions', new.stage_4_has_conditions)
    );
    insert into public.ahpra_notifications(case_id, recipient_user_id, type, title, detail)
    values (
      new.id,
      new.user_id,
      case when new.stage_4_registration_granted then 'success' else 'action' end,
      case when new.stage_4_registration_granted then 'Registration granted' else 'Registration outcome requires action' end,
      case when new.stage_4_registration_granted then 'Your AHPRA registration was recorded as granted.' else 'Please review the recorded registration outcome.' end
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_ahpra_case_change on public.ahpra_cases;
create trigger trg_ahpra_case_change
after update on public.ahpra_cases
for each row
execute function public.handle_ahpra_case_change();

create or replace function public.handle_ahpra_doc_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case public.ahpra_cases;
begin
  select * into v_case from public.ahpra_cases where id = new.case_id;
  if not found then
    return new;
  end if;

  if new.status is distinct from old.status and new.status = 'ready' then
    insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail, payload)
    values (
      new.case_id,
      v_case.user_id,
      auth.uid(),
      case when public.is_admin(auth.uid()) then 'admin' else 'gp' end,
      'document_ready',
      'Required document is ready',
      format('%s is now ready.', new.doc_key),
      jsonb_build_object('doc_key', new.doc_key, 'source_type', new.source_type)
    );
    insert into public.ahpra_notifications(case_id, recipient_user_id, type, title, detail)
    values (new.case_id, v_case.user_id, 'info', 'Document ready', format('%s is now ready for AHPRA.', new.doc_key));
  end if;

  if new.status is distinct from old.status and new.status = 'rejected' then
    insert into public.ahpra_events(case_id, user_id, actor_user_id, actor_role, event_type, title, detail, payload)
    values (
      new.case_id,
      v_case.user_id,
      auth.uid(),
      case when public.is_admin(auth.uid()) then 'admin' else 'gp' end,
      'document_rejected',
      'Required document was rejected',
      coalesce(new.admin_note, ''),
      jsonb_build_object('doc_key', new.doc_key, 'source_type', new.source_type, 'admin_note', new.admin_note)
    );
    insert into public.ahpra_notifications(case_id, recipient_user_id, type, title, detail)
    values (new.case_id, v_case.user_id, 'action', 'Document rejected', format('%s was rejected. %s', new.doc_key, coalesce(new.admin_note, 'Re-upload required.')));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_ahpra_doc_change on public.ahpra_case_documents;
create trigger trg_ahpra_doc_change
after update on public.ahpra_case_documents
for each row
execute function public.handle_ahpra_doc_change();

-- RLS policies.
alter table public.user_roles enable row level security;
alter table public.ahpra_cases enable row level security;
alter table public.ahpra_case_documents enable row level security;
alter table public.ahpra_events enable row level security;
alter table public.ahpra_notifications enable row level security;
alter table public.ahpra_required_documents enable row level security;

drop policy if exists "user_roles_select_own_or_admin" on public.user_roles;
create policy "user_roles_select_own_or_admin"
on public.user_roles
for select
to authenticated
using (auth.uid() = user_id or public.is_admin(auth.uid()));

drop policy if exists "ahpra_cases_select_own_or_admin" on public.ahpra_cases;
create policy "ahpra_cases_select_own_or_admin"
on public.ahpra_cases
for select
to authenticated
using (auth.uid() = user_id or public.is_admin(auth.uid()));

drop policy if exists "ahpra_cases_insert_own_or_admin" on public.ahpra_cases;
create policy "ahpra_cases_insert_own_or_admin"
on public.ahpra_cases
for insert
to authenticated
with check (auth.uid() = user_id or public.is_admin(auth.uid()));

drop policy if exists "ahpra_cases_update_own_or_admin" on public.ahpra_cases;
create policy "ahpra_cases_update_own_or_admin"
on public.ahpra_cases
for update
to authenticated
using (auth.uid() = user_id or public.is_admin(auth.uid()))
with check (auth.uid() = user_id or public.is_admin(auth.uid()));

drop policy if exists "ahpra_case_docs_select_own_or_admin" on public.ahpra_case_documents;
create policy "ahpra_case_docs_select_own_or_admin"
on public.ahpra_case_documents
for select
to authenticated
using (
  exists (
    select 1 from public.ahpra_cases c
    where c.id = case_id and (c.user_id = auth.uid() or public.is_admin(auth.uid()))
  )
);

drop policy if exists "ahpra_case_docs_write_admin_or_owner" on public.ahpra_case_documents;
create policy "ahpra_case_docs_write_admin_or_owner"
on public.ahpra_case_documents
for all
to authenticated
using (
  exists (
    select 1 from public.ahpra_cases c
    where c.id = case_id and (c.user_id = auth.uid() or public.is_admin(auth.uid()))
  )
)
with check (
  exists (
    select 1 from public.ahpra_cases c
    where c.id = case_id and (c.user_id = auth.uid() or public.is_admin(auth.uid()))
  )
);

drop policy if exists "ahpra_events_select_own_or_admin" on public.ahpra_events;
create policy "ahpra_events_select_own_or_admin"
on public.ahpra_events
for select
to authenticated
using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "ahpra_events_insert_own_or_admin" on public.ahpra_events;
create policy "ahpra_events_insert_own_or_admin"
on public.ahpra_events
for insert
to authenticated
with check (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "ahpra_notifications_select_recipient_or_admin" on public.ahpra_notifications;
create policy "ahpra_notifications_select_recipient_or_admin"
on public.ahpra_notifications
for select
to authenticated
using (recipient_user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "ahpra_notifications_update_recipient_or_admin" on public.ahpra_notifications;
create policy "ahpra_notifications_update_recipient_or_admin"
on public.ahpra_notifications
for update
to authenticated
using (recipient_user_id = auth.uid() or public.is_admin(auth.uid()))
with check (recipient_user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "ahpra_required_docs_select_all_auth" on public.ahpra_required_documents;
create policy "ahpra_required_docs_select_all_auth"
on public.ahpra_required_documents
for select
to authenticated
using (true);

drop policy if exists "ahpra_required_docs_admin_write" on public.ahpra_required_documents;
create policy "ahpra_required_docs_admin_write"
on public.ahpra_required_documents
for all
to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

-- Storage bucket and policies (idempotent).
insert into storage.buckets (id, name, public)
values ('gp-link-documents', 'gp-link-documents', false)
on conflict (id) do nothing;

drop policy if exists "gplink_docs_select_own_or_admin" on storage.objects;
create policy "gplink_docs_select_own_or_admin"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'gp-link-documents'
  and (
    public.is_admin(auth.uid())
    or name like concat('users/', auth.uid()::text, '/%')
  )
);

drop policy if exists "gplink_docs_insert_own_or_admin" on storage.objects;
create policy "gplink_docs_insert_own_or_admin"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'gp-link-documents'
  and (
    public.is_admin(auth.uid())
    or name like concat('users/', auth.uid()::text, '/%')
  )
);

drop policy if exists "gplink_docs_update_own_or_admin" on storage.objects;
create policy "gplink_docs_update_own_or_admin"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'gp-link-documents'
  and (
    public.is_admin(auth.uid())
    or name like concat('users/', auth.uid()::text, '/%')
  )
)
with check (
  bucket_id = 'gp-link-documents'
  and (
    public.is_admin(auth.uid())
    or name like concat('users/', auth.uid()::text, '/%')
  )
);

drop policy if exists "gplink_docs_delete_admin_only" on storage.objects;
create policy "gplink_docs_delete_admin_only"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'gp-link-documents'
  and public.is_admin(auth.uid())
);

commit;
