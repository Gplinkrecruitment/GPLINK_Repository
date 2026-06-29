-- Store the Cc recipients on an email message so the hub shows who else was on a reply
-- (the composer now lets an RSO Cc additional people) and so an inbound email's Cc is visible.
ALTER TABLE task_messages ADD COLUMN IF NOT EXISTS cc TEXT;
