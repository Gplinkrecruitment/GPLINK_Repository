-- Deleting a GP's auth user failed with "Database error deleting user"
-- (owner 2026-09-15, deleting the recreated smithmiller1234@gmail.com test
-- account from the Supabase dashboard). Every other GP table cascades from
-- auth.users; scheduled_calls was created without a delete rule on either
-- of its two foreign keys, so one booked interview (or consult) row blocks
-- the whole delete. Make both cascade, matching the rest of the schema.
--
-- Applied to prod manually via exec_sql (repo convention). Idempotent.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT tc.constraint_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.table_name = 'scheduled_calls'
      AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name IN ('user_id', 'case_id')
  LOOP
    EXECUTE format('ALTER TABLE public.scheduled_calls DROP CONSTRAINT %I', c.constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.scheduled_calls
  ADD CONSTRAINT scheduled_calls_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.scheduled_calls
  ADD CONSTRAINT scheduled_calls_case_id_fkey FOREIGN KEY (case_id)
    REFERENCES public.registration_cases(id) ON DELETE CASCADE;
