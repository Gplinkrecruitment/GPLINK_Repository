-- VA Dashboard Rebuild — Support Tickets + Nudges
-- Promotes support tickets from user-state JSON to a first-class table,
-- and introduces per-user nudge delivery for the VA "Send nudge" action.
-- All operations are additive — no destructive changes.

-- ══════════════════════════════════════════════
-- 1. Support Tickets
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE SET NULL,
  -- Legacy id from gpLinkSupportCases JSON blob, so we can idempotently backfill + dual-write
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

-- GP can read their own tickets
CREATE POLICY support_tickets_select_own ON support_tickets
  FOR SELECT USING (auth.uid() = user_id);

-- GP can insert their own tickets
CREATE POLICY support_tickets_insert_own ON support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- GP can update their own tickets while still open
CREATE POLICY support_tickets_update_own ON support_tickets
  FOR UPDATE USING (auth.uid() = user_id AND status <> 'closed');

-- Service role full access (admin endpoints use service key)
CREATE POLICY support_tickets_service_all ON support_tickets
  FOR ALL USING (auth.role() = 'service_role');

-- ══════════════════════════════════════════════
-- 2. User Nudges — in-app + future-native push dispatcher
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_nudges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE SET NULL,
  stage TEXT,
  substage TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  whatsapp_number TEXT,
  -- Channels this nudge should reach: any of 'in_app','email','push_ios','push_android'
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

-- GP can read their own nudges
CREATE POLICY user_nudges_select_own ON user_nudges
  FOR SELECT USING (auth.uid() = user_id);

-- GP can mark their own nudges read/dismissed
CREATE POLICY user_nudges_update_own ON user_nudges
  FOR UPDATE USING (auth.uid() = user_id);

-- Service role full access
CREATE POLICY user_nudges_service_all ON user_nudges
  FOR ALL USING (auth.role() = 'service_role');

-- ══════════════════════════════════════════════
-- 3. Updated-at triggers
-- ══════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_support_tickets') THEN
    CREATE TRIGGER set_updated_at_support_tickets
      BEFORE UPDATE ON support_tickets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ══════════════════════════════════════════════
-- 4. Helper view: open tickets FIFO for VA queue
-- ══════════════════════════════════════════════

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
