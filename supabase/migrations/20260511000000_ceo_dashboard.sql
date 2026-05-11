-- CEO Dashboard: escalation columns, completed_at, first_reply_at, wider status constraint

-- 1. Widen task status constraint to include 'escalated'
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_status_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_status_check
  CHECK (status IN (
    'open','in_progress','waiting','completed','cancelled',
    'waiting_on_gp','waiting_on_practice','waiting_on_external','blocked',
    'escalated'
  ));

-- 2. Add escalation columns to registration_tasks
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS escalated_to UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS escalated_reason TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

-- 3. Add completed_at to registration_cases
ALTER TABLE registration_cases
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 4. Add first_reply_at to support_tickets
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS first_reply_at TIMESTAMPTZ;

-- 5. Indexes for CEO dashboard queries
CREATE INDEX IF NOT EXISTS idx_reg_tasks_escalated
  ON registration_tasks (escalated_to, escalated_at DESC)
  WHERE escalated_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_cases_completed
  ON registration_cases (completed_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_cases_stage
  ON registration_cases (stage);
