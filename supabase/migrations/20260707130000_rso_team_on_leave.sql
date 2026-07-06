-- Phase 6 G2a: RSO team management — on-leave flag.
-- Adds an on_leave boolean to public.rso_team so the Team UI can mark an officer
-- as away without deactivating them. Roster/assignment selection refuses on-leave
-- targets (lib/ceo-metrics.js resolveRsoReassignmentTarget); existing cases are
-- moved explicitly via the bulk-reassign tool, never automatically.
ALTER TABLE public.rso_team ADD COLUMN IF NOT EXISTS on_leave BOOLEAN NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
