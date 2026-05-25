-- Guide folders and items for RSO admin Guide tab

CREATE TABLE IF NOT EXISTS guide_folders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE guide_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guide_folders_service_role" ON guide_folders
  FOR ALL USING (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS guide_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  folder_id UUID NOT NULL REFERENCES guide_folders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scribe_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guide_items_folder ON guide_items(folder_id);

ALTER TABLE guide_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guide_items_service_role" ON guide_items
  FOR ALL USING (auth.role() = 'service_role');

-- Seed default folders
INSERT INTO guide_folders (name, sort_order) VALUES
  ('Onboarding', 0),
  ('Guiding GP through Registration', 1),
  ('Completing Tasks', 2);
