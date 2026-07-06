-- Phase 6 G3 — eligibility off-ramp waitlist.
-- Out-of-scope-country GPs (not UK/IE/NZ) are captured as candidate_leads rows
-- with source='eligibility_waitlist' so we can notify them when their country
-- is supported. The row needs to remember WHICH country they trained in.
begin;

alter table public.candidate_leads add column if not exists country text;

commit;
