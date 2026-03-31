-- PBS Module V2: Extend schema for full MVP case management
-- Adds new columns to pbs_applications, creates pbs_documents, pbs_updates, pbs_timeline_events

-- ── Extend pbs_applications with case management fields ──
ALTER TABLE pbs_applications
  ADD COLUMN IF NOT EXISTS provider_number TEXT,
  ADD COLUMN IF NOT EXISTS prescriber_number TEXT,
  ADD COLUMN IF NOT EXISTS current_action_title TEXT,
  ADD COLUMN IF NOT EXISTS current_action_description TEXT,
  ADD COLUMN IF NOT EXISTS current_action_owner TEXT,
  ADD COLUMN IF NOT EXISTS current_action_due_date DATE,
  ADD COLUMN IF NOT EXISTS practice_name TEXT,
  ADD COLUMN IF NOT EXISTS practice_contact TEXT,
  ADD COLUMN IF NOT EXISTS status_message TEXT;

-- Drop old status constraint and add expanded one
ALTER TABLE pbs_applications DROP CONSTRAINT IF EXISTS pbs_applications_status_check;
ALTER TABLE pbs_applications ADD CONSTRAINT pbs_applications_status_check
  CHECK (status IN ('not_started', 'in_progress', 'submitted', 'approved', 'rejected', 'waiting_on_gp', 'under_review', 'complete', 'blocked'));

-- ── PBS Documents table ──
CREATE TABLE IF NOT EXISTS pbs_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pbs_application_id UUID NOT NULL REFERENCES pbs_applications(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_path TEXT NOT NULL DEFAULT '',
  original_file_name TEXT,
  mime_type TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('missing', 'uploaded', 'under_review', 'approved', 'rejected')),
  rejection_reason TEXT,
  uploaded_by_user_id UUID,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  requested_by TEXT,
  requested_at TIMESTAMPTZ,
  request_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pbs_documents_app_id ON pbs_documents(pbs_application_id);

-- ── PBS Updates / notes table ──
CREATE TABLE IF NOT EXISTS pbs_updates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pbs_application_id UUID NOT NULL REFERENCES pbs_applications(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'gp' CHECK (visibility IN ('gp', 'internal')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pbs_updates_app_id ON pbs_updates(pbs_application_id);

-- ── PBS Timeline events table ──
CREATE TABLE IF NOT EXISTS pbs_timeline_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pbs_application_id UUID NOT NULL REFERENCES pbs_applications(id) ON DELETE CASCADE,
  event_title TEXT NOT NULL,
  event_description TEXT,
  visible_to_gp BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pbs_timeline_events_app_id ON pbs_timeline_events(pbs_application_id);

-- ── RLS for new tables ──
ALTER TABLE pbs_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE pbs_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pbs_timeline_events ENABLE ROW LEVEL SECURITY;

-- Users can read documents on their own applications
CREATE POLICY pbs_documents_select_own ON pbs_documents
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM pbs_applications pa
      WHERE pa.id = pbs_documents.pbs_application_id
      AND pa.user_id = auth.uid()
    )
  );

-- Users can insert documents on their own applications
CREATE POLICY pbs_documents_insert_own ON pbs_documents
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM pbs_applications pa
      WHERE pa.id = pbs_documents.pbs_application_id
      AND pa.user_id = auth.uid()
    )
  );

-- Service role full access on pbs_documents
CREATE POLICY pbs_documents_service_all ON pbs_documents
  FOR ALL USING (auth.role() = 'service_role');

-- Users can read GP-visible updates on their own applications
CREATE POLICY pbs_updates_select_own ON pbs_updates
  FOR SELECT USING (
    visibility = 'gp' AND EXISTS (
      SELECT 1 FROM pbs_applications pa
      WHERE pa.id = pbs_updates.pbs_application_id
      AND pa.user_id = auth.uid()
    )
  );

-- Service role full access on pbs_updates
CREATE POLICY pbs_updates_service_all ON pbs_updates
  FOR ALL USING (auth.role() = 'service_role');

-- Users can read GP-visible timeline events on their own applications
CREATE POLICY pbs_timeline_events_select_own ON pbs_timeline_events
  FOR SELECT USING (
    visible_to_gp = true AND EXISTS (
      SELECT 1 FROM pbs_applications pa
      WHERE pa.id = pbs_timeline_events.pbs_application_id
      AND pa.user_id = auth.uid()
    )
  );

-- Service role full access on pbs_timeline_events
CREATE POLICY pbs_timeline_events_service_all ON pbs_timeline_events
  FOR ALL USING (auth.role() = 'service_role');
