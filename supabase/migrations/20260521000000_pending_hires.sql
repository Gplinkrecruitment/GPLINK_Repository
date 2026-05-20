-- Pending Hires table
-- Stores hired candidate details from Zoho Recruit webhook so that
-- when the GP signs up, we can link them instantly via local DB lookup
-- instead of needing a live Zoho API connection.

CREATE TABLE IF NOT EXISTS pending_hires (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_email TEXT NOT NULL,
  candidate_phone TEXT,
  candidate_first_name TEXT,
  candidate_last_name TEXT,
  provider_role_id TEXT,
  career_role_id BIGINT REFERENCES career_roles(id),
  practice_name TEXT,
  job_title TEXT,
  location TEXT,
  zoho_candidate_id TEXT,
  zoho_application_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','linked','expired')),
  linked_user_id UUID,
  linked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_hires_email
  ON pending_hires (candidate_email) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_hires_phone
  ON pending_hires (candidate_phone) WHERE status = 'pending' AND candidate_phone IS NOT NULL;
