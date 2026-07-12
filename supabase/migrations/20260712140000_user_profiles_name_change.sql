-- Name-change evidence flag: set when an RSO approves a qualification document
-- whose name differs from the account (a genuine name change). Drives the AMC
-- "Establishment" step name-change-evidence notice.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS name_change_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS name_change_note text;

NOTIFY pgrst, 'reload schema';
