-- Add parent_id to guide_folders for subfolder support
ALTER TABLE guide_folders ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES guide_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_guide_folders_parent ON guide_folders(parent_id);
