-- ════════════════════════════════════════════════════════════════
-- GP Link — apply pending VA-dashboard migration + wipe test data
-- ════════════════════════════════════════════════════════════════
--
-- Run this in the Supabase SQL editor (or: psql $DATABASE_URL -f this-file).
-- Part 1 is the 20260405000000_va_dashboard_rebuild migration, made idempotent
-- so it is safe to run whether or not it has already been applied.
-- Part 2 wipes tickets + progress from every user so you can test the
-- MyIntealth → AMC flow end-to-end with one account. User accounts,
-- profiles, sessions, document templates, and super-admin roles are preserved.
--
-- This script is DESTRUCTIVE for row data in:
--   support_tickets, user_nudges, registration_cases, registration_tasks,
--   task_timeline, user_documents, and selected keys inside user_state.state.
-- Do NOT run against production without a backup.

BEGIN;

-- ════════════════════════════════════════════════════════════════
-- PART 1 — Apply 20260405000000_va_dashboard_rebuild (idempotent)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE SET NULL,
  source_ticket_id TEXT,
  case_code TEXT,
  title TEXT NOT NULL,
  body TEXT,
  category TEXT
    CHECK (category IS NULL OR category IN ('EPIC','AMC','Documents','AHPRA','Provider','Contract','Qualification','Other')),
  stage TEXT,
  substage TEXT,
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent','high','normal','low','blocked','time_sensitive')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','waiting_on_gp','closed')),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  thread_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, source_ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_case ON support_tickets(case_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created ON support_tickets(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_stage ON support_tickets(stage);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='support_tickets_select_own') THEN
    CREATE POLICY support_tickets_select_own ON support_tickets
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='support_tickets_insert_own') THEN
    CREATE POLICY support_tickets_insert_own ON support_tickets
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='support_tickets_update_own') THEN
    CREATE POLICY support_tickets_update_own ON support_tickets
      FOR UPDATE USING (auth.uid() = user_id AND status <> 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='support_tickets_service_all') THEN
    CREATE POLICY support_tickets_service_all ON support_tickets
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_nudges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE SET NULL,
  stage TEXT,
  substage TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  whatsapp_number TEXT,
  delivered_channels TEXT[] NOT NULL DEFAULT ARRAY['in_app']::TEXT[],
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','read','dismissed')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_nudges_user_status ON user_nudges(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_nudges_created ON user_nudges(created_at DESC);

ALTER TABLE user_nudges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_nudges' AND policyname='user_nudges_select_own') THEN
    CREATE POLICY user_nudges_select_own ON user_nudges
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_nudges' AND policyname='user_nudges_update_own') THEN
    CREATE POLICY user_nudges_update_own ON user_nudges
      FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_nudges' AND policyname='user_nudges_service_all') THEN
    CREATE POLICY user_nudges_service_all ON user_nudges
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_support_tickets') THEN
    CREATE TRIGGER set_updated_at_support_tickets
      BEFORE UPDATE ON support_tickets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE OR REPLACE VIEW va_open_tickets_fifo AS
SELECT
  t.id,
  t.user_id,
  t.case_id,
  t.source_ticket_id,
  t.case_code,
  t.title,
  t.category,
  t.stage,
  t.substage,
  t.priority,
  t.status,
  t.created_at,
  t.updated_at,
  p.first_name,
  p.last_name,
  p.email AS gp_email,
  p.phone_number AS gp_phone
FROM support_tickets t
LEFT JOIN user_profiles p ON p.user_id = t.user_id
WHERE t.status <> 'closed'
ORDER BY t.created_at ASC;

-- ════════════════════════════════════════════════════════════════
-- PART 2 — Wipe tickets + progress from every user
-- ════════════════════════════════════════════════════════════════
-- Order matters: clear child/dependent tables before parents.

TRUNCATE TABLE
  support_tickets,
  user_nudges,
  task_timeline,
  registration_tasks,
  registration_cases,
  user_documents
RESTART IDENTITY CASCADE;

-- Strip progress + ticket JSON blobs from user_state without touching
-- identity/preference keys (gp_selected_country stays). The __gp_reset_at
-- sentinel is bumped to now() so that js/state-sync.js on every logged-in
-- device detects the reset on its next hydrate and wipes its localStorage
-- cache instead of re-pushing stale progress back to Supabase.
UPDATE public.user_state
SET state = (state
    - 'gpLinkSupportCases'
    - 'gpLinkMessageDB'
    - 'gp_epic_progress'
    - 'gp_amc_progress'
    - 'gp_ahpra_progress'
    - 'gp_documents_prep'
    - 'gp_prepared_docs'
    - 'gp_link_updates')
    || jsonb_build_object('__gp_reset_at', (extract(epoch from now()) * 1000)::bigint),
    updated_at = now();

-- ════════════════════════════════════════════════════════════════
-- Verification — should return zero rows / empty arrays
-- ════════════════════════════════════════════════════════════════

SELECT 'support_tickets' AS table_name, count(*) FROM support_tickets
UNION ALL SELECT 'user_nudges',          count(*) FROM user_nudges
UNION ALL SELECT 'registration_cases',   count(*) FROM registration_cases
UNION ALL SELECT 'registration_tasks',   count(*) FROM registration_tasks
UNION ALL SELECT 'task_timeline',        count(*) FROM task_timeline
UNION ALL SELECT 'user_documents',       count(*) FROM user_documents;

SELECT
  user_id,
  (state ? 'gpLinkSupportCases') AS has_tickets,
  (state ? 'gp_epic_progress')   AS has_epic,
  (state ? 'gp_amc_progress')    AS has_amc
FROM public.user_state;

COMMIT;
