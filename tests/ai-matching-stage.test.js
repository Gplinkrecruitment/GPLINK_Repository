import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as atsPractices from '../lib/ats-practices.js';

// AI Matching — Task 1: migration + 'shortlisted' kanban stage plumbing.
// lib/ats-practices.js is the single source of truth the server uses for the
// /api/ats/application PATCH stage validator, the /api/ats/job/pipeline
// column grouping, and the /api/ceo/candidates + /api/ceo/pipeline-summary
// bucket counts — so testing it here covers every server-side whitelist.

const root = process.cwd();

describe('AI Matching Task 1 — shortlisted stage', () => {
  describe('lib/ats-practices.js (server-side single source of truth)', () => {
    it('ATS_STAGES has shortlisted first, ahead of applied', () => {
      expect(atsPractices.ATS_STAGES).toEqual([
        'shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'
      ]);
    });

    it('the PATCH /api/ats/application validStages set accepts shortlisted and rejects junk', () => {
      // Mirrors server.js:48307 — var validStages = atsPracticeUtil.ATS_STAGES.concat([atsPracticeUtil.ATS_REJECT_STAGE]);
      const validStages = atsPractices.ATS_STAGES.concat([atsPractices.ATS_REJECT_STAGE]);
      expect(validStages.indexOf('shortlisted')).not.toBe(-1);
      expect(validStages.indexOf('not_proceeding')).not.toBe(-1);
      expect(validStages.indexOf('junk_stage')).toBe(-1);
      expect(validStages.indexOf('')).toBe(-1);
      expect(validStages.indexOf('Shortlisted')).toBe(-1); // case-sensitive
    });

    it('shortlisted has a label', () => {
      expect(atsPractices.ATS_STAGE_LABELS.shortlisted).toBe('Shortlist');
    });

    it('bucketForApps classifies a shortlisted-only candidate as shortlisted, not not_proceeding', () => {
      expect(atsPractices.bucketForApps([{ ats_stage: 'shortlisted' }])).toBe('shortlisted');
    });

    it('bestAtsStage treats shortlisted as earlier than applied (forward progress)', () => {
      expect(atsPractices.bestAtsStage([
        { ats_stage: 'shortlisted' },
        { ats_stage: 'applied' }
      ])).toBe('applied');
    });

    it('PIPELINE_BUCKETS includes shortlisted with a label (candidates dashboard funnel)', () => {
      expect(atsPractices.PIPELINE_BUCKETS).toContain('shortlisted');
      expect(atsPractices.PIPELINE_BUCKET_LABELS.shortlisted).toBe('Shortlist');
    });
  });

  describe('js/ceo-ats-jobs.js (client-side STAGES)', () => {
    const src = fs.readFileSync(path.join(root, 'js/ceo-ats-jobs.js'), 'utf8');

    it('STAGES array has shortlisted first with the exact key/label/color', () => {
      const stagesBlock = src.slice(src.indexOf('var STAGES = ['), src.indexOf('var REJECT'));
      const firstEntryLine = stagesBlock.split('\n').filter((l) => l.indexOf('key:') !== -1)[0];
      expect(firstEntryLine).toMatch(/key:\s*'shortlisted'/);
      expect(firstEntryLine).toMatch(/label:\s*'Shortlist'/);
      expect(firstEntryLine).toMatch(/color:\s*'#7c3aed'/);
    });
  });

  describe('js/ceo-ats-candidates.js (client-side candidates-tab stage maps)', () => {
    const src = fs.readFileSync(path.join(root, 'js/ceo-ats-candidates.js'), 'utf8');

    it('ATS_STAGE_OPTS includes shortlisted, ordered before applied', () => {
      const optsBlock = src.slice(src.indexOf('var ATS_STAGE_OPTS = ['), src.indexOf('function stageOptLabel'));
      expect(optsBlock).toMatch(/\['shortlisted',\s*'Shortlisted'\]/);
      expect(optsBlock.indexOf('shortlisted')).toBeLessThan(optsBlock.indexOf('applied'));
    });
  });

  describe('server.js stage guards derive from the same source', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

    it('the PATCH validator builds validStages from atsPracticeUtil.ATS_STAGES + ATS_REJECT_STAGE', () => {
      expect(src).toMatch(/var validStages = atsPracticeUtil\.ATS_STAGES\.concat\(\[atsPracticeUtil\.ATS_REJECT_STAGE\]\);/);
    });

    it('the job pipeline column grouping builds columns from the same ATS_STAGES + ATS_REJECT_STAGE source', () => {
      expect(src).toMatch(/atsPracticeUtil\.ATS_STAGES\.concat\(\[atsPracticeUtil\.ATS_REJECT_STAGE\]\)\.map/);
    });
  });

  describe('supabase/migrations/20260707100000_ai_matching.sql', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260707100000_ai_matching.sql'), 'utf8');

    it('adds all ten new gp_applications match columns, guarded with IF NOT EXISTS', () => {
      [
        'match_reasons JSONB', 'match_score INT', 'matched_by TEXT', 'matched_at TIMESTAMPTZ',
        'match_expires_at TIMESTAMPTZ', 'match_seen_at TIMESTAMPTZ', 'match_reminder_sent_at TIMESTAMPTZ',
        'match_outcome TEXT', 'decline_reason TEXT', 'redirect_alternatives JSONB'
      ].forEach((col) => {
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS ' + col);
      });
    });

    it('re-adds the ats_stage CHECK constraint with shortlisted first, guarded by an existence check', () => {
      expect(sql).toMatch(/SELECT 1 FROM pg_constraint WHERE conname = 'gp_applications_ats_stage_check'/);
      expect(sql).toMatch(/DROP CONSTRAINT gp_applications_ats_stage_check/);
      expect(sql).toContain(
        "CHECK (ats_stage IN ('shortlisted','applied','submitted','reviewing','interview','offer','hired','not_proceeding'))"
      );
    });

    it("re-adds the origin CHECK constraint including 'ai_matched' (Task 2 shortlist inserts), guarded by an existence check", () => {
      // The live gp_applications_origin_check from migration 20260705100000
      // only allows gp_applied|admin_applied — without this block every
      // shortlist insert (origin:'ai_matched') would violate it in prod.
      expect(sql).toMatch(/SELECT 1 FROM pg_constraint WHERE conname = 'gp_applications_origin_check'/);
      expect(sql).toMatch(/DROP CONSTRAINT gp_applications_origin_check/);
      expect(sql).toContain("CHECK (origin IN ('gp_applied','admin_applied','ai_matched'))");
    });

    it('creates match_cache guarded, matching the shared-contract shape', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS match_cache/);
      expect(sql).toMatch(/DEFAULT gen_random_uuid\(\)/);
      expect(sql).toMatch(/subject_type\s+TEXT\s+NOT NULL/);
      expect(sql).toMatch(/subject_id\s+TEXT\s+NOT NULL/);
      expect(sql).toMatch(/payload\s+JSONB/);
      expect(sql).toMatch(/generated_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT now\(\)/);
      expect(sql).toContain('UNIQUE(subject_type, subject_id)');
    });

    it('gives match_cache guarded service-role RLS (practices-table pattern)', () => {
      expect(sql).toMatch(/ALTER TABLE match_cache ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/SELECT 1 FROM pg_policies WHERE tablename = 'match_cache' AND policyname = 'match_cache_service_all'/);
      expect(sql).toMatch(/CREATE POLICY match_cache_service_all ON match_cache/);
      expect(sql).toMatch(/FOR ALL USING \(auth\.role\(\) = 'service_role'\)/);
    });

    it('warns to verify the LIVE constraint before applying to prod (constraint-drift precedent)', () => {
      const lower = sql.toLowerCase();
      expect(lower).toMatch(/verify the live/);
      expect(lower).toMatch(/drift/);
    });
  });
});
