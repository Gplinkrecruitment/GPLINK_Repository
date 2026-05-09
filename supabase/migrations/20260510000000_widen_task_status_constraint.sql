-- Widen registration_tasks status CHECK to include waiting_on_* and blocked statuses
-- This constraint was defined in 20260404 migration but may not have been applied to production
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_status_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_status_check
  CHECK (status IN (
    'open','in_progress','waiting','completed','cancelled',
    'waiting_on_gp','waiting_on_practice','waiting_on_external','blocked'
  ));
