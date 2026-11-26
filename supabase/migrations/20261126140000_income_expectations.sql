-- Income forecast on the CEO "Pipeline & money" board (26 Nov 2026).
--
-- income_expectations  money the owner expects that the app cannot see on its
--                      own (old Zoho-era balances, a fee agreed by phone, …).
--                      lib/income-forecast.js puts each live row in the month
--                      of expected_date ("Date unknown" when null). Archived
--                      rows (archived_at set) are left out.
--
-- Service-role only, like the other pipeline tables
-- (20261126120000_ceo_pipeline_board.sql).

create table if not exists public.income_expectations (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  from_name text,
  doctor_name text,
  amount_inc_gst numeric not null check (amount_inc_gst > 0),
  expected_date date null,
  confidence text not null default 'estimated'
    check (confidence in ('agreed','estimated','unknown')),
  note text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_income_expectations_live
  on public.income_expectations (expected_date) where archived_at is null;

alter table public.income_expectations enable row level security;
drop policy if exists income_expectations_service_all on public.income_expectations;
create policy income_expectations_service_all on public.income_expectations
  for all using (auth.role() = 'service_role');

drop trigger if exists trg_income_expectations_updated_at on public.income_expectations;
create trigger trg_income_expectations_updated_at before update on public.income_expectations
for each row execute function public.set_updated_at();
