-- ============================================================================
-- Onboarding qualification review-task cleanup (one-off, idempotent)
-- ============================================================================
-- Context: before the 2026-06-15 fix, qualification documents the GP uploads
-- during onboarding produced review tasks through THREE separate code paths,
-- each tagging a different pipeline stage with no cross-path de-duplication:
--   * flagged_doc   -> related_stage = 'myintealth'   (onboarding-complete + prepared-doc scan)
--   * review        -> related_stage = 'ahpra'        ("Review uploaded: X" from gp_documents_prep)
--   * doc_review    -> related_stage = 'career'        ("Review uploaded X for Dr Y" from the doc pipeline)
-- The code now routes them all to a single 'onboarding' stage with a canonical
-- related_document_key + de-duplication. This script repairs tasks that were
-- ALREADY created under the old behaviour.
--
-- SAFE TO RE-RUN. Run the SELECT previews first, eyeball the rows, then run the
-- UPDATEs. Only touches OPEN qualification review tasks.
-- ============================================================================

-- The qualification document keys, across every capture-flow spelling.
-- Keep in sync with server.js QUALIFICATION_DOC_KEYS + ONBOARDING_QUAL_KEYS.
-- (Inlined below as a VALUES list so the script needs no helper functions.)

-- ----------------------------------------------------------------------------
-- STEP 0 — PREVIEW: which open onboarding qualification tasks exist today?
-- ----------------------------------------------------------------------------
SELECT t.id, t.case_id, t.task_type, t.related_stage, t.related_document_key, t.title, t.status
FROM registration_tasks t
WHERE t.status IN ('open', 'in_progress', 'waiting')
  AND (
        t.task_type = 'flagged_doc'
     OR (t.task_type IN ('review', 'doc_review')
         AND lower(coalesce(t.related_document_key, '')) IN (
           'primary_med_degree','onboarding_primary_med_degree','primary_medical_degree',
           'mrcgp_cert','micgp_cert','frnzcgp_cert','cscst_cert',
           'onboarding_specialist_qualification','specialist_qualification',
           'mrcgp_certified','cct_certified','micgp_certified','cscst_certified','frnzcgp_certified',
           'mrcgp','cct','micgp','cscst','frnzcgp',
           'certificate_good_standing','certificate_of_good_standing',
           'confirmation_training','confirmation_of_training',
           'icgp_confirmation_letter','rnzcgp_confirmation_letter'
         ))
      )
ORDER BY t.case_id, t.related_document_key, t.task_type;

-- ----------------------------------------------------------------------------
-- STEP 1 — RE-CATEGORISE: move every onboarding qualification review task to the
-- new 'onboarding' stage so the admin dashboard groups them under "Onboarding"
-- instead of MyIntealth / AHPRA / Other. Low-risk + reversible.
-- ----------------------------------------------------------------------------
UPDATE registration_tasks t
SET related_stage = 'onboarding', updated_at = now()
WHERE t.status IN ('open', 'in_progress', 'waiting')
  AND t.related_stage IS DISTINCT FROM 'onboarding'
  AND (
        t.task_type = 'flagged_doc'
     OR (t.task_type IN ('review', 'doc_review')
         AND lower(coalesce(t.related_document_key, '')) IN (
           'primary_med_degree','onboarding_primary_med_degree','primary_medical_degree',
           'mrcgp_cert','micgp_cert','frnzcgp_cert','cscst_cert',
           'onboarding_specialist_qualification','specialist_qualification',
           'mrcgp_certified','cct_certified','micgp_certified','cscst_certified','frnzcgp_certified',
           'mrcgp','cct','micgp','cscst','frnzcgp',
           'certificate_good_standing','certificate_of_good_standing',
           'confirmation_training','confirmation_of_training',
           'icgp_confirmation_letter','rnzcgp_confirmation_letter'
         ))
      );

-- ----------------------------------------------------------------------------
-- STEP 2 (OPTIONAL) — DE-DUPLICATE: cancel the spurious generic "Review uploaded:
-- X" tasks (task_type='review') for a qualification document when the same case
-- already has a flagged_doc or doc_review for the SAME logical document. These
-- 'review' tasks came from the scan-only path: they carry no AI reason and no
-- openable file, and the new code no longer creates them.
--
-- PREVIEW the rows this would cancel BEFORE running the UPDATE.
-- ----------------------------------------------------------------------------
WITH canon AS (
  SELECT t.id, t.case_id, t.task_type, t.related_document_key, t.title,
         CASE
           WHEN lower(coalesce(t.related_document_key, '')) IN ('primary_med_degree','onboarding_primary_med_degree','primary_medical_degree')
             OR t.title ILIKE '%primary medical degree%'
             THEN 'primary_medical_degree'
           WHEN lower(coalesce(t.related_document_key, '')) IN ('mrcgp_cert','micgp_cert','frnzcgp_cert','cscst_cert','onboarding_specialist_qualification','specialist_qualification','mrcgp_certified','cct_certified','micgp_certified','cscst_certified','frnzcgp_certified','mrcgp','cct','micgp','cscst','frnzcgp')
             OR t.title ILIKE '%specialist qualification%' OR t.title ILIKE '%mrcgp%' OR t.title ILIKE '%micgp%' OR t.title ILIKE '%frnzcgp%' OR t.title ILIKE '%cct%'
             THEN 'specialist_qualification'
           ELSE coalesce(lower(t.related_document_key), 'unknown_' || t.id::text)
         END AS canon_key
  FROM registration_tasks t
  WHERE t.status IN ('open', 'in_progress', 'waiting')
)
-- Preview: 'review' tasks that overlap a flagged_doc/doc_review for the same case+document.
SELECT r.id AS cancel_task_id, r.case_id, r.canon_key, r.title AS cancel_title,
       keep.id AS keep_task_id, keep.task_type AS keep_type, keep.title AS keep_title
FROM canon r
JOIN canon keep
  ON keep.case_id = r.case_id
 AND keep.canon_key = r.canon_key
 AND keep.task_type IN ('flagged_doc', 'doc_review')
WHERE r.task_type = 'review';

-- To APPLY step 2, run:
-- WITH canon AS ( ... same CTE as above ... )
-- UPDATE registration_tasks
-- SET status = 'cancelled', updated_at = now()
-- WHERE id IN (
--   SELECT r.id FROM canon r
--   JOIN canon keep ON keep.case_id = r.case_id AND keep.canon_key = r.canon_key
--                  AND keep.task_type IN ('flagged_doc','doc_review')
--   WHERE r.task_type = 'review'
-- );

-- ----------------------------------------------------------------------------
-- NOTE on flagged documents with no stored file:
-- A qualification that FAILED its onboarding scan before this fix was never saved
-- to storage, so its flagged_doc "Review Document" button will still report
-- "No document is stored" — there is genuinely no file. Those GPs must RE-UPLOAD
-- the document (the re-upload now persists the file regardless of AI outcome).
-- No SQL can recover a file that was never stored.
-- ----------------------------------------------------------------------------
