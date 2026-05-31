-- Add category column to task_documents to distinguish SPPA PDFs from alt supervisor CVs
ALTER TABLE task_documents ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'primary';
