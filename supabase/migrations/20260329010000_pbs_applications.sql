-- PBS applications table
CREATE TABLE IF NOT EXISTS pbs_applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  application_type TEXT NOT NULL CHECK (application_type IN ('medicare_provider', 'pbs_prescriber')),
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'submitted', 'approved', 'rejected')),
  reference_number TEXT,
  application_date TIMESTAMPTZ,
  approval_date TIMESTAMPTZ,
  documents JSONB DEFAULT '[]'::jsonb,
  notes JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, application_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pbs_applications_user_id ON pbs_applications(user_id);

-- RLS policies
ALTER TABLE pbs_applications ENABLE ROW LEVEL SECURITY;

-- Users can read their own PBS applications
CREATE POLICY pbs_applications_select_own ON pbs_applications
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY pbs_applications_service_all ON pbs_applications
  FOR ALL USING (auth.role() = 'service_role');
