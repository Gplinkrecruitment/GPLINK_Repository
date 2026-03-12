begin;

alter table public.user_documents
  add column if not exists storage_bucket text not null default 'gp-link-documents',
  add column if not exists storage_path text,
  add column if not exists mime_type text not null default '',
  add column if not exists file_size bigint not null default 0;

create index if not exists idx_user_documents_user_country_key
  on public.user_documents(user_id, country_code, document_key);

commit;
