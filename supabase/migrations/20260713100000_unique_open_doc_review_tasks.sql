-- Dedupe first: the index cannot be created while active duplicates exist.
-- Keep the OLDEST task of each group (it carries the timeline history), complete the rest.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY case_id, task_type, related_document_key
           ORDER BY created_at ASC
         ) AS rn
  FROM public.registration_tasks
  WHERE task_type IN ('doc_review', 'flagged_doc')
    AND status IN ('open', 'in_progress', 'waiting')
    AND related_document_key IS NOT NULL
)
UPDATE public.registration_tasks t
SET status = 'completed',
    completed_at = now(),
    completed_by = 'ops-dedupe-migration',
    updated_at = now()
FROM ranked r
WHERE t.id = r.id AND r.rn > 1;

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
