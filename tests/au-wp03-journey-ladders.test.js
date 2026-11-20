// WP-03 of the Australian GP build: the two stage ladders (lib/journey-ladders.js),
// the stage-enumerating library code that must tolerate the four new stage
// values, and a static lint of the migration that widens the two CHECKs.
// Pure: no server, no database.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const jl = require('../lib/journey-ladders.js');
const cp = require('../lib/candidate-pathway.js');
const ceoMetrics = require('../lib/ceo-metrics.js');
const ceoOverview = require('../lib/ceo-overview.js');

const ROOT = path.join(__dirname, '..');
// The LIVE constraint lists, from docs/au-gp/ENVIRONMENT.md section 9.
const LIVE_CASE_STAGES = ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement', 'complete'];
const LIVE_CALL_STAGES = ['myintealth', 'amc', 'ahpra'];
const NEW_STAGES = ['placement', 'prestart', 'commenced', 'guarantee'];
const AU_FORBIDDEN_WORDS = /myintealth|\bamc\b|epic|visa|relocat|overseas|internationally|gmc|sppa|section g|supervisor|guarantee/i;

describe('the overseas ladder is exactly today\'s', () => {
  it('the eight live stage values, in the live order', () => {
    expect(jl.OVERSEAS_STAGES).toEqual(LIVE_CASE_STAGES);
    expect(jl.stagesFor('overseas_esp')).toEqual(LIVE_CASE_STAGES);
    expect(jl.stagesFor('overseas_pep')).toEqual(LIVE_CASE_STAGES);
  });

  it('nothing recorded, unknown and garbage pathways are the overseas ladder, never the Australian one', () => {
    [null, undefined, '', 'nonsense', 'AU', 'australia', 0, {}, 'au'].forEach((p) => {
      expect(jl.ladderIdFor(p), String(p)).toBe('overseas');
      expect(jl.initialStageFor(p), String(p)).toBe('myintealth');
    });
  });

  it('labels match the ones the dashboards already use', () => {
    const byKey = {};
    jl.ladderFor('overseas_esp').forEach((s) => { byKey[s.key] = s.label; });
    ceoMetrics.FUNNEL_STAGES.forEach((s) => expect(byKey[s.key], s.key).toBe(s.label));
  });
});

describe('the Australian ladder', () => {
  it('placement -> prestart -> commenced -> guarantee -> complete, for every Australian pathway', () => {
    cp.AU_PATHWAYS.forEach((p) => {
      expect(jl.ladderIdFor(p)).toBe('au');
      expect(jl.stagesFor(p)).toEqual(['placement', 'prestart', 'commenced', 'guarantee', 'complete']);
      expect(jl.initialStageFor(p)).toBe('placement');
      expect(jl.ladderFor(p).map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  it('no Australian label a doctor can see contains an overseas word or "guarantee"', () => {
    jl.AU_LADDER.forEach((s) => expect(s.gpLabel, s.key).not.toMatch(AU_FORBIDDEN_WORDS));
  });

  it('knows which stages are on which ladder', () => {
    expect(jl.isStageOnLadder('au_vr', 'prestart')).toBe(true);
    expect(jl.isStageOnLadder('au_vr', 'myintealth')).toBe(false);
    expect(jl.isStageOnLadder('au_vr', 'ahpra')).toBe(false);
    expect(jl.isStageOnLadder('overseas_esp', 'prestart')).toBe(false);
    expect(jl.isStageOnLadder(null, 'placement')).toBe(false);
    expect(jl.isStageOnLadder('overseas_esp', 'complete')).toBe(true);
    expect(jl.isStageOnLadder('au_vr', 'complete')).toBe(true);
    expect(jl.AU_ONLY_STAGES).toEqual(NEW_STAGES);
    NEW_STAGES.forEach((s) => expect(jl.isAuOnlyStage(s)).toBe(true));
    LIVE_CASE_STAGES.forEach((s) => expect(jl.isAuOnlyStage(s), s).toBe(false));
    expect(jl.isAuOnlyStage(' PreStart ')).toBe(true);
  });

  it('comparison helpers: forward only, and stages on different ladders do not compare', () => {
    expect(jl.compareStages('au_vr', 'placement', 'prestart')).toBeLessThan(0);
    expect(jl.compareStages('au_vr', 'guarantee', 'prestart')).toBeGreaterThan(0);
    expect(jl.compareStages('au_vr', 'commenced', 'commenced')).toBe(0);
    expect(jl.compareStages('au_vr', 'myintealth', 'prestart')).toBe(null);
    expect(jl.compareStages('overseas_esp', 'amc', 'ahpra')).toBeLessThan(0);
    expect(jl.isForwardMove('au_vr', 'placement', 'prestart')).toBe(true);
    expect(jl.isForwardMove('au_vr', 'placement', 'complete')).toBe(true);
    expect(jl.isForwardMove('au_vr', 'prestart', 'placement')).toBe(false);
    expect(jl.isForwardMove('au_vr', 'prestart', 'prestart')).toBe(false);
    expect(jl.isForwardMove('au_vr', 'prestart', 'ahpra')).toBe(false);
    // A case still parked on the overseas ladder is "before the start".
    expect(jl.isForwardMove('au_vr', 'myintealth', 'placement')).toBe(true);
    expect(jl.isForwardMove('au_vr', 'ahpra', 'prestart')).toBe(true);
    expect(jl.nextStage('au_vr', 'placement')).toBe('prestart');
    expect(jl.nextStage('au_vr', 'complete')).toBe(null);
    expect(jl.nextStage('au_vr', 'myintealth')).toBe(null);
    expect(jl.nextStage(null, 'myintealth')).toBe('amc');
  });
});

describe('auStageFromFacts: the Australian stage comes from facts, never from EPIC / AMC / AHPRA flags', () => {
  it('no placement -> placement; placement recorded -> prestart', () => {
    expect(jl.auStageFromFacts({})).toBe('placement');
    expect(jl.auStageFromFacts({ currentStage: 'placement', placementSecured: false })).toBe('placement');
    expect(jl.auStageFromFacts({ currentStage: 'placement', placementSecured: true })).toBe('prestart');
    expect(jl.auStageFromFacts({ currentStage: 'myintealth', placementSecured: false })).toBe('placement');
    expect(jl.auStageFromFacts({ currentStage: 'ahpra', placementSecured: true })).toBe('prestart');
  });

  it('never demotes: past placement it stays put whatever the placement fact says', () => {
    ['prestart', 'commenced', 'guarantee', 'complete'].forEach((s) => {
      expect(jl.auStageFromFacts({ currentStage: s, placementSecured: false })).toBe(s);
      expect(jl.auStageFromFacts({ currentStage: s, placementSecured: true })).toBe(s);
    });
  });

  it('only a real `true` counts as a placement; it has no input for state flags at all', () => {
    ['true', 1, 'yes', {}, null, undefined].forEach((v) => {
      expect(jl.auStageFromFacts({ currentStage: 'placement', placementSecured: v })).toBe('placement');
    });
    expect(jl.auStageFromFacts({
      currentStage: 'placement', gp_epic_progress: { completed: { verification_issued: true } },
      gp_amc_progress: { completed: { qualifications_verified: true } }
    })).toBe('placement');
  });

  it('WP-14 hook: every Australian pathway goes to prestart on placement today', () => {
    cp.AU_PATHWAYS.forEach((p) => expect(jl.auPlacementTargetStage(p)).toBe('prestart'));
  });
});

describe('unknown-stage safety', () => {
  const ODD = [undefined, null, '', 'zzz', 42, {}, [], 'PLACEMENT ', 'prestart', 'guarantee'];

  it('labels never throw and never come back empty for a real value', () => {
    ODD.forEach((v) => {
      expect(() => jl.stageLabel(v)).not.toThrow();
      expect(() => jl.gpStageLabel(v, 'au_vr')).not.toThrow();
    });
    expect(jl.stageLabel('prestart')).toBe('Pre-start');
    expect(jl.stageLabel('guarantee')).toBe('Guarantee period');
    expect(jl.stageLabel('myintealth')).toBe('MyIntealth');
    expect(jl.stageLabel('zzz')).toBe('zzz');
    expect(jl.stageLabel('', undefined, 'Registration')).toBe('Registration');
    expect(jl.gpStageLabel('guarantee', 'au_vr')).toBe('Settling in');
    // 'complete' is on both ladders.
    expect(jl.stageLabel('complete', 'au_vr')).toBe('Complete');
  });

  it('sortIndexAny: overseas stages, then Australian, then unknown, complete last of the known', () => {
    const mixed = ['zzz', 'guarantee', 'complete', 'amc', 'placement', 'myintealth', 'prestart', 'visa', null];
    const sorted = mixed.slice().sort((a, b) => jl.sortIndexAny(a) - jl.sortIndexAny(b));
    expect(sorted).toEqual(['myintealth', 'amc', 'visa', 'placement', 'prestart', 'guarantee', 'complete', 'zzz', null]);
    ODD.forEach((v) => expect(Number.isFinite(jl.sortIndexAny(v))).toBe(true));
  });

  it('index helpers return -1 / null / false for anything odd', () => {
    ODD.slice(0, 7).forEach((v) => {
      expect(jl.stageIndex('au_vr', v)).toBe(-1);
      expect(jl.isKnownStage(v)).toBe(false);
    });
    expect(jl.ALL_CASE_STAGES).toEqual(LIVE_CASE_STAGES.concat(NEW_STAGES));
  });
});

describe('assistance-call stages', () => {
  it('overseas: exactly today\'s three; Australian: prestart only', () => {
    expect(jl.callStagesFor(null)).toEqual(LIVE_CALL_STAGES);
    expect(jl.callStagesFor('overseas_pep')).toEqual(LIVE_CALL_STAGES);
    expect(jl.callStagesFor('au_vr')).toEqual(['prestart']);
    expect(jl.ALL_CALL_STAGES_DB).toEqual(LIVE_CALL_STAGES.concat(NEW_STAGES));
  });
});

describe('lib/ceo-metrics.js and lib/ceo-overview.js tolerate the new stage values', () => {
  const cases = [
    { id: 'o1', user_id: 'u1', stage: 'myintealth', status: 'active' },
    { id: 'o2', user_id: 'u2', stage: 'ahpra', status: 'active' },
    { id: 'a1', user_id: 'u3', stage: 'placement', status: 'active' },
    { id: 'a2', user_id: 'u4', stage: 'prestart', status: 'blocked', blocker_status: 'waiting_on_practice' },
    { id: 'a3', user_id: 'u5', stage: 'commenced', status: 'active' },
    { id: 'a4', user_id: 'u6', stage: 'guarantee', status: 'active' },
    { id: 'x1', user_id: 'u7', stage: 'something_new', status: 'active' }
  ];
  const overseasOnly = cases.slice(0, 2);

  it('an Australian case is never counted under MyIntealth (or any overseas stage), cumulative or not', () => {
    [false, true].forEach((cumulative) => {
      const withAu = ceoMetrics.computePipeline(cases, { cumulative });
      const without = ceoMetrics.computePipeline(overseasOnly, { cumulative });
      expect(withAu, 'cumulative=' + cumulative).toEqual(without);
      ceoMetrics.FUNNEL_STAGES.forEach((s) => {
        const ids = ceoMetrics.pipelineCaseIds(cases, s.key, { cumulative });
        expect(ids.filter((id) => /^(a|x)/.test(id)), s.key).toEqual([]);
      });
    });
    expect(ceoMetrics.computePipeline(cases, { cumulative: true })[0]).toMatchObject({ key: 'myintealth', count: 2 });
  });

  it('the overseas funnel itself is unchanged', () => {
    const all = LIVE_CASE_STAGES.map((s, i) => ({ id: 'c' + i, user_id: 'u' + i, stage: s, status: 'active' }));
    expect(ceoMetrics.computePipeline(all, { cumulative: false }).map((s) => [s.key, s.count])).toEqual(
      [['myintealth', 1], ['amc', 1], ['career', 1], ['ahpra', 1], ['pbs', 2], ['commencement', 1]]);
    expect(ceoMetrics.computePipeline(all, { cumulative: true }).map((s) => [s.key, s.count])).toEqual(
      [['myintealth', 7], ['amc', 6], ['career', 5], ['ahpra', 4], ['pbs', 3], ['commencement', 1]]);
    // A row with no stage at all still reads as the first stage, as before.
    expect(ceoMetrics.computePipeline([{ id: 'n', status: 'active' }], {})[0].count).toBe(1);
  });

  it('blockers and the other case readers do not throw and keep the real stage', () => {
    const blockers = ceoMetrics.computeBlockers(cases, Date.now());
    expect(blockers.map((b) => b.stage)).toEqual(['prestart']);
    expect(() => ceoMetrics.computeKpis ? ceoMetrics.computeKpis(cases, [], [], Date.now()) : null).not.toThrow();
    expect(typeof ceoOverview).toBe('object');
  });
});

describe('migration lint: supabase/migrations/*au_gp_wp03*', () => {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => /au_gp_wp03/.test(f));
  const raw = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const sql = raw.split('\n').filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/\s--.*$/, '')).join('\n');
  const lower = sql.toLowerCase();
  const listOf = (constraint) => {
    const m = lower.match(new RegExp('add constraint ' + constraint + '\\s+check\\s*\\(([\\s\\S]*?)\\)\\s*not valid'));
    return m ? (m[1].match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, '')) : null;
  };

  it('there is one, named with au_gp, sorted after the WP-02 migration', () => {
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{14}_au_gp_wp03_[a-z0-9_]+\.sql$/);
    const wp02 = fs.readdirSync(dir).filter((f) => /au_gp_wp02/.test(f))[0];
    expect(files[0] > wp02).toBe(true);
  });

  it('registration_cases.stage: a SUPERSET of the live list, adding exactly the four Australian stages', () => {
    const list = listOf('registration_cases_stage_check');
    expect(list).not.toBe(null);
    LIVE_CASE_STAGES.forEach((s) => expect(list, s).toContain(s));
    expect(list.slice().sort()).toEqual(LIVE_CASE_STAGES.concat(NEW_STAGES).sort());
    expect(list.slice().sort()).toEqual(jl.ALL_CASE_STAGES.slice().sort());
  });

  it('scheduled_calls.stage: NULL still allowed, a SUPERSET of the live list', () => {
    const list = listOf('scheduled_calls_stage_check');
    expect(list).not.toBe(null);
    LIVE_CALL_STAGES.forEach((s) => expect(list, s).toContain(s));
    expect(list.slice().sort()).toEqual(jl.ALL_CALL_STAGES_DB.slice().sort());
    expect(lower).toMatch(/add constraint scheduled_calls_stage_check\s+check\s*\(stage is null or stage in/);
    jl.AU_CALL_STAGES.forEach((s) => expect(list).toContain(s));
  });

  it('nothing else is touched: the only drops are the two constraints being widened, each re-added in the same block', () => {
    const drops = lower.match(/\bdrop\s+\w+[^;]*;/g) || [];
    expect(drops.map((d) => d.replace(/\s+/g, ' '))).toEqual([
      'drop constraint if exists registration_cases_stage_check;',
      'drop constraint if exists scheduled_calls_stage_check;'
    ]);
    expect(lower).not.toMatch(/\bdrop\s+(table|column|index|schema|type|function|policy|trigger)\b/);
    expect(lower).not.toMatch(/\brename\b|\balter\s+column\b|\badd\s+column\b|\bcreate\s+table\b/);
    expect(lower).not.toMatch(/\bupdate\s+\S+\s+set\b|\bdelete\s+from\b|\btruncate\b|\binsert\s+into\b/);
    // Each drop and its re-add sit inside ONE do-block, so there is never a
    // moment with no constraint.
    const blocks = lower.match(/do \$\$[\s\S]*?end \$\$;/g) || [];
    expect(blocks.length).toBe(2);
    blocks.forEach((b) => {
      expect((b.match(/drop constraint if exists/g) || []).length).toBe(1);
      expect((b.match(/add constraint/g) || []).length).toBe(1);
      expect(b.indexOf('drop constraint')).toBeLessThan(b.indexOf('add constraint'));
    });
    // Nothing is dropped outside a block.
    expect(lower.replace(/do \$\$[\s\S]*?end \$\$;/g, '')).not.toMatch(/\bdrop\b/);
  });

  it('idempotent: each block is skipped once the constraint already allows the new values', () => {
    expect((lower.match(/if not exists \(\s*select 1 from pg_catalog\.pg_constraint/g) || []).length).toBe(2);
    expect((lower.match(/pg_catalog\.pg_get_constraintdef\(oid\) like '%guarantee%'/g) || []).length).toBe(2);
  });

  it('written for exec_sql: schema-qualified, no transaction control, validated after', () => {
    expect(lower).not.toMatch(/^\s*(begin|commit|rollback)\s*;/m);
    const tables = lower.match(/alter table\s+(\S+)/g) || [];
    expect(tables.length).toBeGreaterThan(0);
    tables.forEach((a) => expect(a).toMatch(/^alter table\s+public\.(registration_cases|scheduled_calls)$/));
    expect(lower).not.toMatch(/\bfrom\s+pg_constraint\b/);
    expect(lower).toMatch(/pg_catalog\.to_regclass\('public\.registration_cases'\)/);
    expect(lower).toMatch(/pg_catalog\.to_regclass\('public\.scheduled_calls'\)/);
    expect(lower).toMatch(/alter table public\.registration_cases validate constraint registration_cases_stage_check;/);
    expect(lower).toMatch(/alter table public\.scheduled_calls validate constraint scheduled_calls_stage_check;/);
  });

  it('ends with a commented rollback note', () => {
    expect(raw).toMatch(/-- Rollback note/);
  });
});
