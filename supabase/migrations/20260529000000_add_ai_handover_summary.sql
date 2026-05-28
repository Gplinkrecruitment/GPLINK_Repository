-- Add JSONB column to store rolling AI handover summary
ALTER TABLE registration_cases
ADD COLUMN IF NOT EXISTS ai_handover_summary JSONB DEFAULT NULL;

COMMENT ON COLUMN registration_cases.ai_handover_summary IS
  'Rolling AI-generated summary carried forward across generations. Contains overview, action_items, concerns, key_history, generated_at.';
