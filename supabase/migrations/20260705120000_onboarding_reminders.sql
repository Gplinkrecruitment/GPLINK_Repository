-- Onboarding reminders — chase GPs who started but never finished onboarding.
--
-- NOT applied automatically — apply via rpc/exec_sql with the service key
-- (schema-qualify names). One row per GP; the hourly /api/cron/onboarding-nudge
-- job creates rows on first sight, sends the schedule (1h/24h/3d/weekly to day
-- 31) measured from anchor_at, resets the anchor when the GP returns, and stops
-- on completion, unsubscribe, or exhaustion.
--
-- Additive / non-breaking. user_id is intentionally loose (nullable, NO foreign
-- key), matching pep_waitlist (20260705110000). Service-role-only RLS.

CREATE TABLE IF NOT EXISTS onboarding_reminders (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID,
  email              TEXT,
  name               TEXT,
  anchor_at          TIMESTAMPTZ,          -- most-recent last-active; schedule measured from here
  last_step          SMALLINT,             -- gp_onboarding.currentStep at last read (deep link)
  steps_sent         SMALLINT[]  NOT NULL DEFAULT '{}',
  last_sent_at       TIMESTAMPTZ,
  unsubscribed       BOOLEAN     NOT NULL DEFAULT false,
  unsubscribed_at    TIMESTAMPTZ,
  stopped            BOOLEAN     NOT NULL DEFAULT false,
  stopped_reason     TEXT,                 -- 'completed' | 'exhausted'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_reminders_user ON onboarding_reminders(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_reminders_email ON onboarding_reminders(email);
CREATE INDEX IF NOT EXISTS idx_onboarding_reminders_active ON onboarding_reminders(stopped, unsubscribed);

ALTER TABLE onboarding_reminders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'onboarding_reminders' AND policyname = 'onboarding_reminders_service_all'
  ) THEN
    CREATE POLICY onboarding_reminders_service_all ON onboarding_reminders
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
