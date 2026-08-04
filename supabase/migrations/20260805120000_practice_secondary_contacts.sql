-- Secondary practice contacts (owner spec 2026-08-05).
--
-- A practice keeps ONE primary contact (contact_name / contact_email) who
-- receives every practice-facing email. Secondary contacts are additional
-- people at the practice who are CC'd on exactly ONE email: the introduction
-- sent when a candidate is first presented/matched to them. They are never
-- copied on anything after that (decision reminders, interview confirmations,
-- offers, contracts, SPPA correspondence all stay primary-only).
--
-- Shape: [{"name": "Jane Smith", "email": "jane@practice.com.au"}, ...]
-- Normalized on write by lib/ats-practices.js normalizeSecondaryContacts()
-- (lowercased, de-duplicated, primary contact excluded, capped at 10).
alter table public.practices
  add column if not exists secondary_contacts jsonb not null default '[]'::jsonb;
