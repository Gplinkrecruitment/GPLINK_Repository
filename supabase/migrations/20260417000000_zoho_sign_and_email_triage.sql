-- Practice Pack Phase 2 — Zoho Sign + AI email triage
-- 2026-04-17

-- 1. Zoho Sign envelope lifecycle records
CREATE TABLE IF NOT EXISTS zoho_sign_envelopes (
  envelope_id           text PRIMARY KEY,
  task_id               uuid REFERENCES registration_tasks(id) ON DELETE SET NULL,
  user_id               uuid,
  case_id               uuid REFERENCES registration_cases(id) ON DELETE SET NULL,
  template_id           text NOT NULL,
  status                text NOT NULL CHECK (status IN (
    'sent_to_contact','contact_signed','sent_to_candidate','candidate_signed',
    'awaiting_review','approved','declined','voided','voided_for_correction',
    'expired','recipient_delivery_failed'
  )),
  recipient_contact     jsonb,
  recipient_candidate   jsonb,
  sent_at               timestamptz,
  completed_at          timestamptz,
  decline_reason        text,
  previous_envelope_id  text,
  correction_sections   text[],
  correction_note       text,
  signed_pdf_drive_id   text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zoho_sign_envelopes_task_id
  ON zoho_sign_envelopes(task_id);
CREATE INDEX IF NOT EXISTS idx_zoho_sign_envelopes_case_id
  ON zoho_sign_envelopes(case_id);
CREATE INDEX IF NOT EXISTS idx_zoho_sign_envelopes_status
  ON zoho_sign_envelopes(status);

-- 2. Webhook idempotency
CREATE TABLE IF NOT EXISTS processed_zoho_sign_events (
  notification_id   text PRIMARY KEY,
  -- intentionally no FK: webhooks can arrive before envelope row exists (Zoho at-least-once)
  envelope_id       text,
  event_type        text NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_zoho_sign_events_envelope
  ON processed_zoho_sign_events(envelope_id);

-- 3. AI email triage to-dos
CREATE TABLE IF NOT EXISTS incoming_email_todos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id  text NOT NULL UNIQUE,
  matched_user_id   uuid,
  sender_email      text NOT NULL,
  subject           text,
  ai_category       text,
  ai_urgency        text,
  ai_summary        text,
  ai_confidence     real,
  needs_triage      boolean NOT NULL DEFAULT false,
  resolved_at       timestamptz,
  resolved_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incoming_email_todos_unresolved
  ON incoming_email_todos(created_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incoming_email_todos_user
  ON incoming_email_todos(matched_user_id);

-- 4. Link registration_tasks to their envelope
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS zoho_sign_envelope_id text;
CREATE INDEX IF NOT EXISTS idx_registration_tasks_envelope
  ON registration_tasks(zoho_sign_envelope_id)
  WHERE zoho_sign_envelope_id IS NOT NULL;

-- 5. FK: registration_tasks.zoho_sign_envelope_id -> zoho_sign_envelopes.envelope_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'registration_tasks_zoho_sign_envelope_id_fkey'
  ) THEN
    ALTER TABLE registration_tasks
      ADD CONSTRAINT registration_tasks_zoho_sign_envelope_id_fkey
      FOREIGN KEY (zoho_sign_envelope_id)
      REFERENCES zoho_sign_envelopes(envelope_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 6. updated_at trigger on zoho_sign_envelopes (reuses shared set_updated_at())
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_zoho_sign_envelopes') THEN
    CREATE TRIGGER set_updated_at_zoho_sign_envelopes
      BEFORE UPDATE ON zoho_sign_envelopes
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
