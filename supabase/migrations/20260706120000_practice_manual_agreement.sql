-- Phase 3 Task 1: manually uploaded (already-signed) agreement PDFs on practices.
-- Stored under a SEPARATE key from the e-signed agreement_signed_pdf_key so a
-- manual upload can never clobber an e-signed contract.
begin;

alter table public.practices
  add column if not exists agreement_manual_pdf_key text,
  add column if not exists agreement_manual_uploaded_at timestamptz,
  add column if not exists agreement_manual_uploaded_by text;

commit;
