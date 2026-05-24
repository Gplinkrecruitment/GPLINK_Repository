-- Create practice_doc_ops table (was defined in 20260404 unified migration but table doesn't exist)
CREATE TABLE IF NOT EXISTS practice_doc_ops (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES registration_cases(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL
    CHECK (document_key IN ('sppa_00','section_g','position_description','offer_contract','supervisor_cv')),
  ops_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (ops_status IN ('not_requested','requested','awaiting_practice','received','under_review','needs_correction','ready_for_gp','completed')),
  requested_from TEXT,
  practice_contact TEXT,
  request_date DATE,
  due_date DATE,
  last_chased_date DATE,
  file_version INTEGER DEFAULT 0,
  review_outcome TEXT,
  correction_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(case_id, document_key)
);

CREATE INDEX IF NOT EXISTS idx_practice_doc_ops_case ON practice_doc_ops(case_id);
CREATE INDEX IF NOT EXISTS idx_practice_doc_ops_status ON practice_doc_ops(ops_status);

ALTER TABLE practice_doc_ops ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'practice_doc_ops' AND policyname = 'practice_doc_ops_service_all') THEN
    CREATE POLICY practice_doc_ops_service_all ON practice_doc_ops
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- Auto-update updated_at using the existing set_updated_at() function
DROP TRIGGER IF EXISTS set_updated_at_practice_doc_ops ON practice_doc_ops;
CREATE TRIGGER set_updated_at_practice_doc_ops
  BEFORE UPDATE ON practice_doc_ops
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
