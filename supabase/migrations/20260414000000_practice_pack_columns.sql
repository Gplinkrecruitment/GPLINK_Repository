-- Add document tracking columns to registration_tasks
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS attachment_url text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS attachment_filename text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS zoho_attachment_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS google_drive_file_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS document_html text;

-- Add Google Drive folder reference to registration_cases
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS google_drive_folder_id text;
