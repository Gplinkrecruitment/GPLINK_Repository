-- Visa Module V2: Extend schema for full MVP visa case management
-- Adds new columns to visa_applications, extends visa_documents, creates visa_updates and visa_timeline_events

-- ── Extend visa_applications with case management fields ──
ALTER TABLE visa_applications
  ADD COLUMN IF NOT EXISTS visa_type TEXT,
  ADD COLUMN IF NOT EXISTS responsible_party TEXT,
  ADD COLUMN IF NOT EXISTS estimated_timeline TEXT,
  ADD COLUMN IF NOT EXISTS current_action_title TEXT,
  ADD COLUMN IF NOT EXISTS current_action_description TEXT,
  ADD COLUMN IF NOT EXISTS current_action_owner TEXT,
  ADD COLUMN IF NOT EXISTS current_action_due_date DATE,
  ADD COLUMN IF NOT EXISTS sponsor_name TEXT,
  ADD COLUMN IF NOT EXISTS sponsor_contact TEXT,
  ADD COLUMN IF NOT EXISTS reference_number TEXT,
  ADD COLUMN IF NOT EXISTS status_message TEXT;

-- ── Extend visa_documents with review workflow fields ──
ALTER TABLE visa_documents
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('missing', 'uploaded', 'under_review', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS original_file_name TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- ── Visa updates / notes table ──
CREATE TABLE IF NOT EXISTS visa_updates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  visa_case_id UUID NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'gp' CHECK (visibility IN ('gp', 'internal')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visa_updates_case_id ON visa_updates(visa_case_id);

-- ── Visa timeline events table ──
CREATE TABLE IF NOT EXISTS visa_timeline_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  visa_case_id UUID NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
  event_title TEXT NOT NULL,
  event_description TEXT,
  visible_to_gp BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visa_timeline_events_case_id ON visa_timeline_events(visa_case_id);

-- ── RLS for new tables ──
ALTER TABLE visa_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE visa_timeline_events ENABLE ROW LEVEL SECURITY;

-- Users can read GP-visible updates on their own cases
CREATE POLICY visa_updates_select_own ON visa_updates
  FOR SELECT USING (
    visibility = 'gp' AND EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_updates.visa_case_id
      AND va.user_id = auth.uid()
    )
  );

-- Service role full access on visa_updates
CREATE POLICY visa_updates_service_all ON visa_updates
  FOR ALL USING (auth.role() = 'service_role');

-- Users can read GP-visible timeline events on their own cases
CREATE POLICY visa_timeline_events_select_own ON visa_timeline_events
  FOR SELECT USING (
    visible_to_gp = true AND EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_timeline_events.visa_case_id
      AND va.user_id = auth.uid()
    )
  );

-- Service role full access on visa_timeline_events
CREATE POLICY visa_timeline_events_service_all ON visa_timeline_events
  FOR ALL USING (auth.role() = 'service_role');

-- Users can insert their own documents
CREATE POLICY visa_documents_insert_own ON visa_documents
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_documents.visa_application_id
      AND va.user_id = auth.uid()
    )
  );

-- ── Extend visa_documents for document request workflow ──
ALTER TABLE visa_documents
  ADD COLUMN IF NOT EXISTS requested_by TEXT,
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS request_note TEXT;

-- ── Visa dependants table ──
CREATE TABLE IF NOT EXISTS visa_dependants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  visa_case_id UUID NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  relationship TEXT NOT NULL CHECK (relationship IN ('spouse', 'child', 'other')),
  date_of_birth DATE,
  passport_number TEXT,
  passport_country TEXT,
  visa_status TEXT DEFAULT 'not_included' CHECK (visa_status IN ('not_included', 'included', 'granted', 'refused')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visa_dependants_case_id ON visa_dependants(visa_case_id);

-- RLS for visa_dependants
ALTER TABLE visa_dependants ENABLE ROW LEVEL SECURITY;

-- Users can read their own dependants
CREATE POLICY visa_dependants_select_own ON visa_dependants
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_dependants.visa_case_id
      AND va.user_id = auth.uid()
    )
  );

-- Users can insert dependants on their own cases
CREATE POLICY visa_dependants_insert_own ON visa_dependants
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_dependants.visa_case_id
      AND va.user_id = auth.uid()
    )
  );

-- Users can update their own dependants
CREATE POLICY visa_dependants_update_own ON visa_dependants
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_dependants.visa_case_id
      AND va.user_id = auth.uid()
    )
  );

-- Users can delete their own dependants
CREATE POLICY visa_dependants_delete_own ON visa_dependants
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_dependants.visa_case_id
      AND va.user_id = auth.uid()
    )
  );

-- Service role full access on visa_dependants
CREATE POLICY visa_dependants_service_all ON visa_dependants
  FOR ALL USING (auth.role() = 'service_role');
