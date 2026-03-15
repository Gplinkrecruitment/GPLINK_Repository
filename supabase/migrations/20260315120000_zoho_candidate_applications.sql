-- Add zoho_candidate_id to user_profiles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS zoho_candidate_id TEXT;

-- Create gp_applications table
CREATE TABLE IF NOT EXISTS gp_applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  career_role_id UUID REFERENCES career_roles(id) ON DELETE SET NULL,
  provider_role_id TEXT NOT NULL,
  zoho_candidate_id TEXT,
  zoho_application_id TEXT,
  status TEXT NOT NULL DEFAULT 'applied',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider_role_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_gp_applications_user_id ON gp_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_gp_applications_career_role_id ON gp_applications(career_role_id);
