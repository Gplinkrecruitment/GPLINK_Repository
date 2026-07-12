-- One OPEN document-check task per (case, task_type, document).
-- createDocReviewTask/createFlaggedDocTask dedupe with a read-then-insert check,
-- which races on serverless (observed in prod: 3 identical open doc_review tasks
-- created 2026-07-12 by concurrent upload pipelines). This index makes the
-- duplicate insert impossible; _createRegTask handles the 23505/409 by reopening
-- the existing task instead.
-- Partial: only the two document-check task types, only "active" statuses —
-- mirrors the exact statuses the code-level dedupe checks. Completed/cancelled
-- history rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_doc_check_task
  ON public.registration_tasks (case_id, task_type, related_document_key)
  WHERE task_type IN ('doc_review', 'flagged_doc')
    AND status IN ('open', 'in_progress', 'waiting')
    AND related_document_key IS NOT NULL;
