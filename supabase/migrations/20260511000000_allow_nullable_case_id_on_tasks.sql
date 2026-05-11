-- Allow registration_tasks.case_id to be NULL so that DoubleTick inbound
-- messages from unregistered phone numbers can still create VA tasks.
-- The VA admin WhatsApp inbox queries by task_type/source_trigger, not case_id,
-- so null-case tasks still appear in the queue.

ALTER TABLE registration_tasks ALTER COLUMN case_id DROP NOT NULL;
