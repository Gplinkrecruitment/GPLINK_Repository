-- GP applications: first-class practice link
-- Apply via exec_sql per docs/supabase-migrations — server code tolerates this
-- column being absent (apply-path insert retries without practice_id and logs
-- once when PostgREST reports an unknown column).
-- Additive / non-breaking / idempotent.

ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES public.practices(id);

CREATE INDEX IF NOT EXISTS idx_gp_applications_practice_id ON public.gp_applications(practice_id);
