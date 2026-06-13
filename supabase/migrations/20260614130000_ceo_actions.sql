-- Phase 5: CEO action reliability + escalation semantics

-- 1. escalated_to becomes a TEXT role marker (e.g. 'CEO'), not a UUID FK (#26).
--    Drop the partial index AND the FK to auth.users(id) that referenced it as UUID,
--    then convert. (The FK must go first or the type change is rejected: a uuid FK
--    cannot point at a text column.)
DROP INDEX IF EXISTS idx_reg_tasks_escalated;
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_escalated_to_fkey;
ALTER TABLE registration_tasks
  ALTER COLUMN escalated_to TYPE text USING NULLIF(escalated_to::text, '');

-- 2. Record the REAL escalator (#27). NULL = unknown / pre-existing rows.
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS escalated_by text,
  ADD COLUMN IF NOT EXISTS blocker_set_at timestamptz;

-- 3. Recreate the escalation lookup index on the live shape.
CREATE INDEX IF NOT EXISTS idx_reg_tasks_escalated
  ON registration_tasks (status, escalated_at DESC)
  WHERE status = 'escalated';

-- 4. Allow an internal CEO note to be stored on the task conversation thread (#55).
--    task_messages.channel was CHECK IN ('email','whatsapp'); direction IN ('inbound','outbound').
ALTER TABLE task_messages DROP CONSTRAINT IF EXISTS task_messages_channel_check;
ALTER TABLE task_messages ADD CONSTRAINT task_messages_channel_check
  CHECK (channel IN ('email', 'whatsapp', 'internal'));
ALTER TABLE task_messages DROP CONSTRAINT IF EXISTS task_messages_direction_check;
ALTER TABLE task_messages ADD CONSTRAINT task_messages_direction_check
  CHECK (direction IN ('inbound', 'outbound', 'internal'));
