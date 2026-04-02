-- Registration Cases & VA Task System
-- Adds persistent case management and task tracking for VA workflow

-- ── Registration Cases: one per GP ──
CREATE TABLE IF NOT EXISTS registration_cases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_va UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'myintealth'
    CHECK (stage IN ('myintealth','amc','career','ahpra','visa','pbs','commencement','complete')),
  substage TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','on_hold','blocked','complete','withdrawn')),
  blocker_status TEXT
    CHECK (blocker_status IS NULL OR blocker_status IN ('waiting_on_gp','waiting_on_practice','waiting_on_external','internal_review')),
  blocker_reason TEXT,
  next_followup_date DATE,
  last_gp_activity_at TIMESTAMPTZ,
  last_va_action_at TIMESTAMPTZ,
  practice_name TEXT,
  practice_contact TEXT,
  handover_notes TEXT,
  gp_verified_stage TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_reg_cases_user ON registration_cases(user_id);
CREATE INDEX IF NOT EXISTS idx_reg_cases_va ON registration_cases(assigned_va);
CREATE INDEX IF NOT EXISTS idx_reg_cases_stage ON registration_cases(stage);
CREATE INDEX IF NOT EXISTS idx_reg_cases_status ON registration_cases(status);

-- ── Registration Tasks: persistent VA work items ──
CREATE TABLE IF NOT EXISTS registration_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES registration_cases(id) ON DELETE CASCADE,
  parent_task_id UUID REFERENCES registration_tasks(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL
    CHECK (task_type IN ('kickoff','verify','review','followup','blocker','escalation','practice_pack','practice_pack_child','manual','system')),
  title TEXT NOT NULL,
  description TEXT,
  assignee UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent','high','normal','low')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','waiting','completed','cancelled')),
  blocker_reason TEXT,
  due_date DATE,
  source_trigger TEXT,
  related_stage TEXT,
  related_substage TEXT,
  related_document_key TEXT,
  related_ticket_id TEXT,
  completed_at TIMESTAMPTZ,
  completed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reg_tasks_case ON registration_tasks(case_id);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_assignee ON registration_tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_status ON registration_tasks(status);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_priority ON registration_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_stage ON registration_tasks(related_stage);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_parent ON registration_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_due ON registration_tasks(due_date) WHERE status NOT IN ('completed','cancelled');

-- ── Task Timeline: audit trail ──
CREATE TABLE IF NOT EXISTS task_timeline (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID REFERENCES registration_tasks(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES registration_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('created','status_change','assigned','note','blocker_set','blocker_cleared','priority_change','stage_change','completed','cancelled','system','reopened')),
  title TEXT NOT NULL,
  detail TEXT,
  actor TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_timeline_case ON task_timeline(case_id);
CREATE INDEX IF NOT EXISTS idx_task_timeline_task ON task_timeline(task_id);
CREATE INDEX IF NOT EXISTS idx_task_timeline_created ON task_timeline(created_at DESC);

-- ── RLS ──
ALTER TABLE registration_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_timeline ENABLE ROW LEVEL SECURITY;

-- Service role full access (admin endpoints use service key)
CREATE POLICY reg_cases_service_all ON registration_cases
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY reg_tasks_service_all ON registration_tasks
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY task_timeline_service_all ON task_timeline
  FOR ALL USING (auth.role() = 'service_role');

-- Updated-at triggers (reuse existing set_updated_at if available)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_reg_cases') THEN
    CREATE TRIGGER set_updated_at_reg_cases
      BEFORE UPDATE ON registration_cases
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_reg_tasks') THEN
    CREATE TRIGGER set_updated_at_reg_tasks
      BEFORE UPDATE ON registration_tasks
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
