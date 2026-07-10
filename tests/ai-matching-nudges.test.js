// Matching Board Task 1 (2026-07-11 spec, Part B) — nudge stamp columns.
//
// Source-wiring block only: confirms the migration file exists and declares
// both nudge timestamp columns. Extended with endpoint/behavior coverage in
// Task 2.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('Matching Board Task 1 — nudge stamp migration source wiring', () => {
  const migrationPath = path.join(ROOT, 'supabase/migrations/20260711220000_match_nudges.sql');

  it('migration file exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('adds both nudge stamp columns to gp_applications', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('ALTER TABLE public.gp_applications');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS match_final_reminder_sent_at TIMESTAMPTZ');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS match_more_time_requested_at TIMESTAMPTZ');
  });

  it('reloads PostgREST schema cache after the DDL change', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });
});
