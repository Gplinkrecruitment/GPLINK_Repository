-- Visa applications table
CREATE TABLE IF NOT EXISTS visa_applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id UUID,
  visa_subclass TEXT,
  stage TEXT NOT NULL DEFAULT 'nomination' CHECK (stage IN ('nomination', 'lodgement', 'processing', 'granted', 'refused')),
  sponsor_status TEXT,
  nomination_date TIMESTAMPTZ,
  lodgement_date TIMESTAMPTZ,
  grant_date TIMESTAMPTZ,
  notes JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Visa documents table
CREATE TABLE IF NOT EXISTS visa_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  visa_application_id UUID NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_visa_applications_user_id ON visa_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_visa_applications_job_id ON visa_applications(job_id);
CREATE INDEX IF NOT EXISTS idx_visa_documents_visa_application_id ON visa_documents(visa_application_id);

-- RLS policies
ALTER TABLE visa_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE visa_documents ENABLE ROW LEVEL SECURITY;

-- Users can read their own visa applications
CREATE POLICY visa_applications_select_own ON visa_applications
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can do everything on visa_applications
CREATE POLICY visa_applications_service_all ON visa_applications
  FOR ALL USING (auth.role() = 'service_role');

-- Users can read their own visa documents (via visa_application ownership)
CREATE POLICY visa_documents_select_own ON visa_documents
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM visa_applications va
      WHERE va.id = visa_documents.visa_application_id
      AND va.user_id = auth.uid()
    )
  );

-- Service role can do everything on visa_documents
CREATE POLICY visa_documents_service_all ON visa_documents
  FOR ALL USING (auth.role() = 'service_role');
