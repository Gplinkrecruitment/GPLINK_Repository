// tests/ahpra-rep-change.test.js
//
// Pure, file-based assertions for Task 1 of the AHPRA "change of authorised
// representative" (ANOM-00) feature: the data model migration + the
// `ahpra_rep_change` registration_tasks.task_type value.
//
// These tests read the migration file's text directly — no DB/service key
// required (see NOTE in the migration file re-deriving the live constraint
// at apply time).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIGRATION_PATH = 'supabase/migrations/20260702120000_ahpra_rep_change.sql';

// The task_type values known to be live in production as of the most recent
// constraint rebuild (supabase/migrations/20260701000000_add_ahpra_conflict_letter_task_type.sql,
// itself derived from a verified read of the live constraint on 2026-07-01).
// This migration must UNION 'ahpra_rep_change' onto that list, not regress
// to an earlier/staler list — dropping any of these from the CHECK constraint
// would silently break inserts for that task type in prod (this exact class
// of bug has bitten this repo multiple times; see the comments in
// 20260630120000_task_type_check_union_alt_supervisor_cv_request.sql and
// 20260701000000_add_ahpra_conflict_letter_task_type.sql).
const PRE_EXISTING_TASK_TYPES = [
  'kickoff', 'verify', 'review', 'followup', 'blocker', 'escalation',
  'practice_pack', 'practice_pack_child', 'manual', 'system', 'visa_stage',
  'visa_doc', 'questionnaire', 'sponsor', 'migration_agent', 'sla_overdue',
  'chase', 'document_ops', 'whatsapp_help', 'email_triage', 'ahpra_action_item',
  'ahpra_correspondence', 'flagged_doc', 'doc_review', 'zoom_call',
  'alt_supervisor_cv_review', 'alt_supervisor_cv_request',
  'account_deleted_active_placement', 'model_update_available',
  'ahpra_conflict_letter',
];

describe('ahpra_rep_change plumbing', () => {
  it('migration adds the task type and the new columns', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toContain("'ahpra_rep_change'");
    expect(sql).toMatch(/ahpra_auth_rep_email/);
    expect(sql).toMatch(/company_email/);
    expect(sql).toMatch(/ahpra_account_confirmed/);
  });

  it('adds every rso_team and registration_cases column from the brief, idempotently', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');

    const rsoTeamCols = [
      'first_name', 'last_name', 'company_email',
      'ahpra_account_confirmed', 'ahpra_account_confirmed_at', 'onboarding_completed_at',
    ];
    for (const col of rsoTeamCols) {
      const re = new RegExp(`ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS ${col}\\b`);
      expect(sql, `expected idempotent ADD COLUMN for rso_team.${col}`).toMatch(re);
    }

    const caseCols = ['ahpra_auth_rep_email', 'ahpra_auth_rep_user_id', 'ahpra_auth_rep_confirmed_at'];
    for (const col of caseCols) {
      const re = new RegExp(`ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ${col}\\b`);
      expect(sql, `expected idempotent ADD COLUMN for registration_cases.${col}`).toMatch(re);
    }
  });

  it('rebuilds the task_type CHECK constraint as a pure UNION (no dropped pre-existing types)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');

    expect(sql).toContain('DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check');
    expect(sql).toContain('ADD CONSTRAINT registration_tasks_task_type_check');

    // Isolate the CHECK (task_type IN (...)) list so we assert against the
    // constraint body specifically, not just anywhere in the file.
    const match = sql.match(/CHECK\s*\(\s*task_type\s+IN\s*\(([\s\S]*?)\)\s*\)/);
    expect(match, 'expected a CHECK (task_type IN (...)) clause').toBeTruthy();
    const constraintList = match[1];

    for (const type of PRE_EXISTING_TASK_TYPES) {
      expect(constraintList, `constraint dropped pre-existing type '${type}'`).toContain(`'${type}'`);
    }
    expect(constraintList).toContain("'ahpra_rep_change'");
  });

  it('carries the re-derive-from-live-constraint operator warning', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/re-derive this IN-list from the LIVE constraint/i);
  });

  it('backfills company_email from email for existing @mygplink.com.au rso_team rows', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/UPDATE rso_team SET company_email = email/);
    expect(sql).toMatch(/mygplink\.com\.au/);
  });
});
