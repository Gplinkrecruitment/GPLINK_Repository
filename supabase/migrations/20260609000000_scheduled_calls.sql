-- Migration: 20260609000000_scheduled_calls.sql
-- Adds zoom_call task type and creates scheduled_calls + webhook_events tables

-- ============================================================
-- 1. Update registration_tasks_task_type_check constraint
--    to include zoom_call
-- ============================================================

ALTER TABLE registration_tasks
  DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;

ALTER TABLE registration_tasks
  ADD CONSTRAINT registration_tasks_task_type_check
    CHECK (task_type IN (
      'kickoff','verify','review','followup','blocker','escalation',
      'practice_pack','practice_pack_child','manual','system',
      'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
      'sla_overdue','chase','document_ops','whatsapp_help','email_triage',
      'ahpra_action_item','flagged_doc','doc_review','zoom_call'
    ));

-- ============================================================
-- 2. Create scheduled_calls table
-- ============================================================

CREATE TABLE scheduled_calls (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                   UUID        NOT NULL REFERENCES registration_cases(id),
  user_id                   UUID        NOT NULL REFERENCES auth.users(id),
  registration_task_id      UUID        REFERENCES registration_tasks(id),

  stage                     TEXT        NOT NULL CHECK (stage IN ('myintealth','amc','ahpra')),
  status                    TEXT        NOT NULL DEFAULT 'invited'
                                          CHECK (status IN ('invited','booked','completed','cancelled','no_show')),

  admin_notes               TEXT,
  correlation_token         TEXT        NOT NULL UNIQUE,

  -- Calendly fields
  calendly_booking_url      TEXT,
  calendly_event_type_uri   TEXT,
  calendly_event_uri        TEXT,
  calendly_invitee_uri      TEXT,
  calendly_old_invitee_uri  TEXT,
  calendly_webhook_event_id TEXT,
  invitee_email             TEXT,
  scheduled_at              TIMESTAMPTZ,
  booked_at                 TIMESTAMPTZ,
  timezone                  TEXT,
  duration_minutes          INT         NOT NULL DEFAULT 30,

  -- Zoom meeting fields
  zoom_meeting_id           TEXT,
  zoom_meeting_uuid         TEXT,
  zoom_join_url             TEXT,
  zoom_passcode             TEXT,

  -- Meeting summary fields
  meeting_summary           TEXT,
  meeting_action_items      JSONB,
  meeting_summary_raw       JSONB,
  summary_status            TEXT        NOT NULL DEFAULT 'not_requested'
                                          CHECK (summary_status IN (
                                            'not_requested','pending','saved','not_available','error'
                                          )),
  summary_fetch_attempts    INT         NOT NULL DEFAULT 0,
  summary_error             TEXT,
  summary_saved_at          TIMESTAMPTZ,

  -- Notification tracking
  invite_sent_at            TIMESTAMPTZ,
  resend_count              INT         NOT NULL DEFAULT 0,
  notification_channels     JSONB,
  whatsapp_message_id       TEXT,
  email_message_id          TEXT,

  -- Lifecycle timestamps
  completed_at              TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  no_show_at                TIMESTAMPTZ,

  -- Audit
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 3. Indexes
-- ============================================================

-- Partial unique index on calendly_invitee_uri (only when set)
CREATE UNIQUE INDEX scheduled_calls_calendly_invitee_uri_unique
  ON scheduled_calls (calendly_invitee_uri)
  WHERE calendly_invitee_uri IS NOT NULL;

-- Partial unique index on zoom_meeting_id (only when set)
CREATE UNIQUE INDEX scheduled_calls_zoom_meeting_id_unique
  ON scheduled_calls (zoom_meeting_id)
  WHERE zoom_meeting_id IS NOT NULL;

-- Unique index on correlation_token (already enforced by column UNIQUE, but explicit for clarity)
CREATE UNIQUE INDEX scheduled_calls_correlation_token_unique
  ON scheduled_calls (correlation_token);

-- Case call history (most recent first)
CREATE INDEX scheduled_calls_case_id_created_at_idx
  ON scheduled_calls (case_id, created_at DESC);

-- Scheduled Calls tab: filter by status + sort by scheduled_at
CREATE INDEX scheduled_calls_status_scheduled_at_idx
  ON scheduled_calls (status, scheduled_at);

-- Summary polling: only rows that still need processing
CREATE INDEX scheduled_calls_summary_status_completed_at_idx
  ON scheduled_calls (summary_status, completed_at)
  WHERE summary_status IN ('pending', 'error');

-- ============================================================
-- 4. Row Level Security (deny-all; service role bypasses RLS)
-- ============================================================

ALTER TABLE scheduled_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY scheduled_calls_service_only ON scheduled_calls
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- ============================================================
-- 5. updated_at trigger for scheduled_calls
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER scheduled_calls_updated_at
  BEFORE UPDATE ON scheduled_calls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 6. webhook_events idempotency table
-- ============================================================

CREATE TABLE webhook_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT        NOT NULL,
  event_id     TEXT        NOT NULL,
  event_type   TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB
);

CREATE UNIQUE INDEX webhook_events_provider_event_id_unique
  ON webhook_events (provider, event_id);
