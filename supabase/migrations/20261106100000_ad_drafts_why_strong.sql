-- Why the model thinks each new ad is a strong one to run: two to four
-- evidence-backed reasons written with the brief (owner's ask, 2026-11-06),
-- shown on the draft card under the rationale. Applied to prod via rpc/exec_sql
-- the same day; see docs/superpowers/handovers/2026-11-06-ads-time-rules-rotation-handover.md §6.
ALTER TABLE ad_drafts ADD COLUMN IF NOT EXISTS why_strong JSONB NOT NULL DEFAULT '[]'::jsonb;
