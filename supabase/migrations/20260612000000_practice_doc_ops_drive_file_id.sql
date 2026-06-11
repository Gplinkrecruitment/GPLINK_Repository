-- Link uploaded Drive files directly to their GP LINK placeholder.
-- Without this, an admin upload to a placeholder only linked the Drive file
-- when a practice_pack_child task already existed; otherwise the file fell
-- into the "Other Files" bucket. Storing the Drive file id on the ops row
-- (which is always ensured) makes the placeholder match reliable.
ALTER TABLE practice_doc_ops ADD COLUMN IF NOT EXISTS google_drive_file_id TEXT;
