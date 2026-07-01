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
import signaturePad from '../js/signature-pad.js';
import * as server from '../server.js';
import { rsoNeedsOnboarding, rsoCanBeAhpraRep, buildRepSectionData, shouldTriggerRepChange, resolveAhpraSubmissionRecipient } from '../server.js';

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

// ---------------------------------------------------------------------------
// Task 3: signature pad component — pure `trimBounds` helper.
//
// The interactive canvas drawing itself (pointer/touch capture, DPR-aware
// backing store, live preview) can't be unit-tested here — Node has no
// canvas/ImageData implementation and this repo's vitest config runs in the
// default 'node' environment (no jsdom canvas shim). That part is verified
// manually against the working prototype
// (docs/mockups/anom00-rep-change-prototype.html), per the task brief. What
// IS pure and unit-testable is the ink-bounds trim math that toPNG() uses to
// crop its output, factored out as `trimBounds({ width, height, data })` and
// exercised here directly against hand-built mock ImageData-like objects.
// ---------------------------------------------------------------------------
const { trimBounds } = signaturePad;

function mockImageData(width, height, inkedPixels) {
  const data = new Uint8ClampedArray(width * height * 4); // all-zero = fully transparent
  for (const [x, y] of inkedPixels) {
    const i = (y * width + x) * 4;
    data[i] = 15;
    data[i + 1] = 44;
    data[i + 2] = 99;
    data[i + 3] = 255; // opaque ink
  }
  return { width, height, data };
}

describe('signature-pad trimBounds helper', () => {
  it('returns null for a fully transparent (empty) canvas', () => {
    expect(trimBounds(mockImageData(5, 5, []))).toBeNull();
  });

  it('returns a single-point box for one opaque pixel at (2,3)', () => {
    const bounds = trimBounds(mockImageData(6, 6, [[2, 3]]));
    expect(bounds).toEqual({ minX: 2, minY: 3, maxX: 2, maxY: 3 });
  });

  it('spans the bounding box of multiple opaque pixels and ignores transparent ones', () => {
    const bounds = trimBounds(mockImageData(10, 10, [[1, 1], [4, 2], [3, 7]]));
    expect(bounds).toEqual({ minX: 1, minY: 1, maxX: 4, maxY: 7 });
  });

  it('treats any non-zero alpha (anti-aliased edge pixels) as ink, not just fully-opaque pixels', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    const i = (1 * 4 + 2) * 4; // (x:2, y:1)
    data[i + 3] = 1; // barely-visible anti-aliased edge pixel
    const bounds = trimBounds({ width: 4, height: 4, data });
    expect(bounds).toEqual({ minX: 2, minY: 1, maxX: 2, maxY: 1 });
  });
});

// ---------------------------------------------------------------------------
// Task 4: RSO first-run onboarding — pure predicates.
//
// rsoNeedsOnboarding gates the one-time first-run onboarding modal on the
// admin dashboard. rsoCanBeAhpraRep is a SEPARATE, later gate (checked at
// AHPRA-representative nomination/send time, outside this task's scope) that
// requires BOTH the RSO's own confirmation that they hold an AHPRA portal
// account AND a GP-LINK-provisioned @mygplink.com.au company email. Both are
// pure functions of a plain rso_team row object — no DB required.
// ---------------------------------------------------------------------------
describe('RSO first-run onboarding predicates', () => {
  it('rso needs onboarding when name missing', () => {
    expect(rsoNeedsOnboarding({ onboarding_completed_at: null })).toBe(true);
    expect(rsoNeedsOnboarding({ onboarding_completed_at: '2026-07-02', first_name: 'Ben', last_name: 'Carter' })).toBe(false);
  });

  it('rso needs onboarding when onboarding_completed_at is missing even if name is present', () => {
    expect(rsoNeedsOnboarding({ onboarding_completed_at: null, first_name: 'Ben', last_name: 'Carter' })).toBe(true);
  });

  it('rso needs onboarding when only one of first/last name is present (or blank)', () => {
    expect(rsoNeedsOnboarding({ onboarding_completed_at: '2026-07-02', first_name: 'Ben', last_name: '' })).toBe(true);
    expect(rsoNeedsOnboarding({ onboarding_completed_at: '2026-07-02', last_name: 'Carter' })).toBe(true);
    expect(rsoNeedsOnboarding({ onboarding_completed_at: '2026-07-02', first_name: '  ', last_name: 'Carter' })).toBe(true);
  });

  it('treats a missing/empty row as needing onboarding', () => {
    expect(rsoNeedsOnboarding(undefined)).toBe(true);
    expect(rsoNeedsOnboarding({})).toBe(true);
  });

  it('rso can be AHPRA rep only when confirmed + mygplink email', () => {
    expect(rsoCanBeAhpraRep({ ahpra_account_confirmed: true, company_email: 'ben@mygplink.com.au' })).toBe(true);
    expect(rsoCanBeAhpraRep({ ahpra_account_confirmed: true, company_email: 'ben@gmail.com' })).toBe(false);
    expect(rsoCanBeAhpraRep({ ahpra_account_confirmed: false, company_email: 'ben@mygplink.com.au' })).toBe(false);
  });

  it('is case-insensitive on the company email domain', () => {
    expect(rsoCanBeAhpraRep({ ahpra_account_confirmed: true, company_email: 'Ben@MyGPLink.Com.Au' })).toBe(true);
  });

  it('rejects a company email that merely contains mygplink.com.au without ending there', () => {
    expect(rsoCanBeAhpraRep({ ahpra_account_confirmed: true, company_email: 'ben@mygplink.com.au.evil.com' })).toBe(false);
  });

  it('rejects ahpra_account_confirmed truthy-but-not-strictly-true values', () => {
    expect(rsoCanBeAhpraRep({ ahpra_account_confirmed: 'true', company_email: 'ben@mygplink.com.au' })).toBe(false);
    expect(rsoCanBeAhpraRep({ ahpra_account_confirmed: 1, company_email: 'ben@mygplink.com.au' })).toBe(false);
  });

  it('treats a missing/empty row as not being AHPRA-rep eligible', () => {
    expect(rsoCanBeAhpraRep(undefined)).toBe(false);
    expect(rsoCanBeAhpraRep({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 5: RSO ANOM-00 task card — buildRepSectionData pure assembler.
//
// buildRepSectionData(caseRow, rsoRow) -> { applicant, rep } maps a case/GP
// profile row and an rso_team row onto the two data blocks lib/anom00.js's
// buildAnom00() expects (see tests/anom00.test.js for that shape). It is only
// ever called by /api/admin/va/task/:id/anom00-send-to-gp AFTER that endpoint
// has already checked rsoCanBeAhpraRep, so rep.hasAhpraAccount is always the
// constant `true` here by construction, and the GP LINK org details are fixed
// company constants (never per-case).
// ---------------------------------------------------------------------------
describe('buildRepSectionData', () => {
  const caseRow = {
    family_name: 'MILLER', first_name: 'SMITH', middle_name: 'JOHN',
    dob: '14/03/1989', email: 'dr.smith.miller@example.com',
  };
  const rsoRow = {
    first_name: 'Ben', last_name: 'Carter', company_email: 'ben@mygplink.com.au',
    ahpra_account_confirmed: true,
  };

  it('maps the rep block from the rso profile + fixed GP LINK org constants', () => {
    const { rep } = buildRepSectionData(caseRow, rsoRow);
    expect(rep.email).toBe('ben@mygplink.com.au');
    expect(rep.fullName).toBe('Ben Carter');
    expect(rep.orgName).toBe('GP LINK RECRUITMENT AUSTRALIA PTY LTD');
    expect(rep.address).toBe('SUITE 3050, 780 THE ENTRANCE RD');
    expect(rep.city).toBe('WAMBERAL');
    expect(rep.state).toBe('NSW');
    expect(rep.country).toBe('AUSTRALIA');
    expect(rep.hasAhpraAccount).toBe(true);
  });

  it('maps the applicant block from the case/GP-profile row', () => {
    const { applicant } = buildRepSectionData(caseRow, rsoRow);
    expect(applicant.title).toBe('DR');
    expect(applicant.familyName).toBe('MILLER');
    expect(applicant.firstName).toBe('SMITH');
    expect(applicant.middleName).toBe('JOHN');
    expect(applicant.dob).toBe('14/03/1989');
    expect(applicant.email).toBe('dr.smith.miller@example.com');
  });

  it('falls back to the rso "name" field when first_name/last_name are absent', () => {
    const { rep } = buildRepSectionData(caseRow, { name: 'Hazel', company_email: 'hazel@mygplink.com.au' });
    expect(rep.fullName).toBe('Hazel');
    expect(rep.email).toBe('hazel@mygplink.com.au');
  });

  it('prefers first_name + last_name over "name" when both are present', () => {
    const { rep } = buildRepSectionData(caseRow, { name: 'Old Display Name', first_name: 'Ben', last_name: 'Carter', company_email: 'ben@mygplink.com.au' });
    expect(rep.fullName).toBe('Ben Carter');
  });

  it('accepts camelCase case-row keys as well as snake_case', () => {
    const { applicant } = buildRepSectionData(
      { familyName: 'MILLER', firstName: 'SMITH', middleName: 'JOHN', dob: '14/03/1989', email: 'x@example.com' },
      rsoRow,
    );
    expect(applicant.familyName).toBe('MILLER');
    expect(applicant.firstName).toBe('SMITH');
    expect(applicant.middleName).toBe('JOHN');
    expect(applicant.email).toBe('x@example.com');
  });

  it('falls back to lastName/last_name for familyName when familyName/family_name are absent', () => {
    const { applicant } = buildRepSectionData({ firstName: 'Smith', lastName: 'Miller', email: 'x@example.com' }, rsoRow);
    expect(applicant.familyName).toBe('Miller');
    expect(applicant.firstName).toBe('Smith');
  });

  it('rep.hasAhpraAccount is always true regardless of the rso row (endpoint gates before calling this)', () => {
    const { rep } = buildRepSectionData(caseRow, { company_email: 'ben@mygplink.com.au', ahpra_account_confirmed: false });
    expect(rep.hasAhpraAccount).toBe(true);
  });

  it('defaults gracefully on missing/empty case or rso rows', () => {
    const { applicant, rep } = buildRepSectionData(undefined, undefined);
    expect(applicant.familyName).toBe('');
    expect(applicant.firstName).toBe('');
    expect(applicant.middleName).toBe('');
    expect(applicant.dob).toBe('');
    expect(applicant.email).toBe('');
    expect(applicant.title).toBe('DR');
    expect(rep.email).toBe('');
    expect(rep.fullName).toBe('');
    expect(rep.hasAhpraAccount).toBe(true);
    expect(rep.orgName).toBe('GP LINK RECRUITMENT AUSTRALIA PTY LTD');
  });
});

// ---------------------------------------------------------------------------
// Task 6: auto-trigger the ahpra_rep_change task on RSO reassignment.
//
// shouldTriggerRepChange(prevCase, nextAssignedVa) is the pure gate the
// /api/admin/case (and /api/admin/ops/case) PUT reassignment handlers check
// AFTER a real assigned_va change has already been detected, and BEFORE
// calling the idempotent _ensureRepChangeTask DB helper. Pure + null-safe —
// no DB required to exercise it here.
// ---------------------------------------------------------------------------
describe('shouldTriggerRepChange', () => {
  const base = { stage: 'ahpra', assigned_va: 'old', ahpra_officer_email: 'j@ahpra.gov.au' };

  it('fires only for a real reassignment of a mid-AHPRA case with an officer', () => {
    expect(shouldTriggerRepChange(base, 'new')).toBe(true);
    expect(shouldTriggerRepChange(base, 'old')).toBe(false);           // no change
    expect(shouldTriggerRepChange({ ...base, ahpra_officer_email: null, ahpra_auth_rep_email: null }, 'new')).toBe(false); // no rep yet
    expect(shouldTriggerRepChange({ ...base, stage: 'amc' }, 'new')).toBe(false); // not mid-AHPRA
  });

  it('fires for every mid-AHPRA-journey stage (ahpra, career, pbs, commencement)', () => {
    for (const stage of ['ahpra', 'career', 'pbs', 'commencement']) {
      expect(shouldTriggerRepChange({ ...base, stage }, 'new')).toBe(true);
    }
  });

  it('fires when only the pinned ahpra_auth_rep_email is set (no officer email yet)', () => {
    const pinnedOnly = { stage: 'career', assigned_va: 'old', ahpra_auth_rep_email: 'rep@mygplink.com.au' };
    expect(shouldTriggerRepChange(pinnedOnly, 'new')).toBe(true);
  });

  it('is false when the next assignee is falsy', () => {
    expect(shouldTriggerRepChange(base, null)).toBe(false);
    expect(shouldTriggerRepChange(base, undefined)).toBe(false);
    expect(shouldTriggerRepChange(base, '')).toBe(false);
  });

  it('is null-safe against a missing/empty prevCase', () => {
    expect(shouldTriggerRepChange(undefined, 'new')).toBe(false);
    expect(shouldTriggerRepChange(null, 'new')).toBe(false);
    expect(shouldTriggerRepChange({}, 'new')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 7 (D5): resolveAhpraSubmissionRecipient — pure recipient resolver the
// /api/ahpra/rep-change/:token/send endpoint uses to address the finished
// ANOM-00: the doctor's assigned AHPRA officer email when one is on file
// (dynamic, per case), else the AHPRA authorised-representatives team mailbox
// (spec §3 decision 5 / §4 D5). Exported both as a named export and via
// __testUtils, matching the brief's exact interface + this file's existing
// dual-export convention for the feature's other pure helpers.
// ---------------------------------------------------------------------------
describe('resolveAhpraSubmissionRecipient', () => {
  it('sends to the assigned officer, else authreps fallback', () => {
    expect(resolveAhpraSubmissionRecipient({ ahpra_officer_email: 'j.whitfield@ahpra.gov.au' })).toBe('j.whitfield@ahpra.gov.au');
    expect(resolveAhpraSubmissionRecipient({})).toBe('authreps@ahpra.gov.au');
  });

  it('is reachable via server.__testUtils as well as the named export', () => {
    expect(server.__testUtils.resolveAhpraSubmissionRecipient({ ahpra_officer_email: 'j.whitfield@ahpra.gov.au' })).toBe('j.whitfield@ahpra.gov.au');
  });

  it('falls back when the officer email is missing, null, or blank/whitespace', () => {
    expect(resolveAhpraSubmissionRecipient({ ahpra_officer_email: null })).toBe('authreps@ahpra.gov.au');
    expect(resolveAhpraSubmissionRecipient({ ahpra_officer_email: '' })).toBe('authreps@ahpra.gov.au');
    expect(resolveAhpraSubmissionRecipient({ ahpra_officer_email: '   ' })).toBe('authreps@ahpra.gov.au');
  });

  it('is null-safe against a missing/empty caseRow', () => {
    expect(resolveAhpraSubmissionRecipient(undefined)).toBe('authreps@ahpra.gov.au');
    expect(resolveAhpraSubmissionRecipient(null)).toBe('authreps@ahpra.gov.au');
  });

  it('trims stray whitespace around a real officer email', () => {
    expect(resolveAhpraSubmissionRecipient({ ahpra_officer_email: '  j.whitfield@ahpra.gov.au  ' })).toBe('j.whitfield@ahpra.gov.au');
  });
});
