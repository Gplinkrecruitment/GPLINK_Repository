-- Letter of offer alongside the employment contract (owner request 2026-09-14).
--
-- Some practices send TWO documents when they extend an offer: a letter of
-- offer and the employment contract. Both have to be signed by the doctor
-- before the placement is secured; other practices send the contract alone.
-- A career_contracts row used to hold exactly one document (contract_*) and
-- one signed copy (signed_*), so the letter had nowhere to live and the CEO
-- was filing it by email. These columns give the letter its own file slots
-- and its own signed slots on the SAME row — one revision, two documents —
-- so the existing statuses, versioning, AI review and CAS rules apply to both.
--
-- Everything here is additive and nullable: a row with offer_letter_path null
-- is a single-document contract and behaves exactly as before. signed_at
-- keeps meaning "the whole agreement is signed" (status → 'signed');
-- contract_signed_at / offer_letter_signed_at record when EACH document was
-- signed so a doctor can sign one today and the other tomorrow.
alter table public.career_contracts add column if not exists offer_letter_bucket text;
alter table public.career_contracts add column if not exists offer_letter_path text;
alter table public.career_contracts add column if not exists offer_letter_filename text;
alter table public.career_contracts add column if not exists offer_letter_mime text;
alter table public.career_contracts add column if not exists offer_letter_signed_bucket text;
alter table public.career_contracts add column if not exists offer_letter_signed_path text;
alter table public.career_contracts add column if not exists offer_letter_signed_filename text;
alter table public.career_contracts add column if not exists offer_letter_signed_at timestamptz;
alter table public.career_contracts add column if not exists contract_signed_at timestamptz;
