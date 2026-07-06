-- Phase 6 I2: corporation parent link.
-- Adds practices.parent_corporation_id — an optional link from a member
-- practice to the practices row of its parent corporation (org_type =
-- 'corporation'). The "parent must be a corporation" rule is enforced in the
-- write path (server.js POST/PATCH validation), not as a DB constraint, so a
-- corporation later re-typed to 'practice' never breaks existing rows.
-- Additive + idempotent.
ALTER TABLE public.practices
  ADD COLUMN IF NOT EXISTS parent_corporation_id uuid
    REFERENCES public.practices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_practices_parent_corporation
  ON public.practices (parent_corporation_id)
  WHERE parent_corporation_id IS NOT NULL;
