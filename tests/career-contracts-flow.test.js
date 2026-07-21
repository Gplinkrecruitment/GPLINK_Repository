// Post-interview contract pipeline (owner spec 2026-07-21):
// interview happens -> practice extends offer by uploading a contract ->
// CEO + AI review -> GP signs (upload) or requests changes -> signed = placement.
//
// Task 8 only lands the migration (career_contracts table + two new
// gp_applications bookkeeping columns). Later tasks build the endpoints on
// top of it and will extend this file with server/endpoint coverage — this
// describe block covers the migration itself.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/20260721150000_career_contracts.sql');

describe('career_contracts migration', () => {
  it('the migration file exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('creates the career_contracts table, additive and idempotent', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/create table if not exists public\.career_contracts/);
    expect(sql).not.toMatch(/drop\s/i);
  });

  it('has the columns the contract pipeline needs', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    const cols = [
      'id uuid primary key default gen_random_uuid()',
      'application_id uuid not null references public.gp_applications(id) on delete cascade',
      'user_id uuid',
      'career_role_id bigint',
      'version integer not null default 1',
      'contract_bucket text',
      'contract_path text',
      'contract_filename text',
      'contract_mime text',
      'signed_bucket text',
      'signed_path text',
      'signed_filename text',
      'ai_review jsonb',
      'terms_context jsonb',
      'change_request text',
      'change_response text',
      'ceo_note text',
      'practice_contact_email text',
      'practice_contact_name text',
      'uploaded_at timestamptz',
      'sent_to_gp_at timestamptz',
      'signed_at timestamptz',
      'created_at timestamptz not null default now()',
      'updated_at timestamptz not null default now()',
    ];
    for (const col of cols) {
      expect(sql).toContain(col);
    }
  });

  it('constrains status to the contract lifecycle', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/status text not null default 'awaiting_upload'/);
    expect(sql).toContain(
      "check (status in ('awaiting_upload','uploaded','sent_to_gp','changes_requested','practice_review','signed','void'))"
    );
  });

  it('constrains ai_review_status to the review lifecycle', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/ai_review_status text not null default 'not_run'/);
    expect(sql).toContain("check (ai_review_status in ('not_run','running','done','error'))");
  });

  it('indexes application lookups and status filters', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(
      /create index if not exists career_contracts_app_idx on public\.career_contracts \(application_id, version desc\)/
    );
    expect(sql).toMatch(/create index if not exists career_contracts_status_idx on public\.career_contracts \(status\)/);
  });

  it('adds the two interview follow-up bookkeeping columns to gp_applications, additively', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/alter table public\.gp_applications add column if not exists post_interview_email_sent_at timestamptz/);
    expect(sql).toMatch(/alter table public\.gp_applications add column if not exists interview_completed_at timestamptz/);
  });
});
