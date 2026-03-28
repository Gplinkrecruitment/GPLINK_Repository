-- Commencement checklist items table
CREATE TABLE IF NOT EXISTS commencement_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, item_key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_commencement_items_user_id ON commencement_items(user_id);

-- RLS policies
ALTER TABLE commencement_items ENABLE ROW LEVEL SECURITY;

-- Users can read their own commencement items
CREATE POLICY commencement_items_select_own ON commencement_items
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY commencement_items_service_all ON commencement_items
  FOR ALL USING (auth.role() = 'service_role');
