-- Migration: 20260610000000_scheduled_calls_invitee_notes.sql
-- Adds invitee_notes column to capture GP's booking notes from Calendly

ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS invitee_notes TEXT;
