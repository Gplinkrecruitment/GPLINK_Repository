-- Booking the PEP consultation is what initiates the pathway (owner
-- 2026-09-18: "offer them a cta with book a consultation to initiate PEP
-- pathway ... but marks them as PEP pathway on their gp link profile").
-- POST /api/pep/consult stamps this column; the doctor's own user_state
-- carries the same mark, so the endpoint works whether or not this has been
-- applied. Idempotent.
ALTER TABLE pep_waitlist ADD COLUMN IF NOT EXISTS consult_requested_at TIMESTAMPTZ;
