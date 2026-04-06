-- Career interviews table for Zoom interview scheduling
-- Tracks interview sessions linked to GP applications

CREATE TABLE IF NOT EXISTS career_interviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES gp_applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Scheduling
  scheduled_at TIMESTAMPTZ,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',

  -- Interview details
  format TEXT NOT NULL DEFAULT 'video',
  status TEXT NOT NULL DEFAULT 'scheduled',

  -- Zoom integration
  zoom_meeting_id TEXT,
  zoom_join_url TEXT,
  zoom_host_url TEXT,
  zoom_passcode TEXT,

  -- Participants
  interviewer_name TEXT NOT NULL DEFAULT '',
  interviewer_role TEXT NOT NULL DEFAULT '',
  interviewer_email TEXT NOT NULL DEFAULT '',

  -- Notes
  gp_notes TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',

  -- Zoho sync
  zoho_interview_id TEXT,
  synced_from_zoho BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(application_id, scheduled_at)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_career_interviews_user
  ON career_interviews(user_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_career_interviews_app
  ON career_interviews(application_id);

CREATE INDEX IF NOT EXISTS idx_career_interviews_zoom
  ON career_interviews(zoom_meeting_id)
  WHERE zoom_meeting_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_career_interviews_status
  ON career_interviews(status)
  WHERE status IN ('scheduled', 'confirmed');

-- RLS
ALTER TABLE career_interviews ENABLE ROW LEVEL SECURITY;

-- GP users can read their own interviews
CREATE POLICY career_interviews_select_own ON career_interviews
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- All mutations via service_role only (server.js with SUPABASE_SERVICE_ROLE_KEY)
CREATE POLICY career_interviews_no_insert ON career_interviews
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY career_interviews_no_update ON career_interviews
  FOR UPDATE TO authenticated
  USING (false);

CREATE POLICY career_interviews_no_delete ON career_interviews
  FOR DELETE TO authenticated
  USING (false);
