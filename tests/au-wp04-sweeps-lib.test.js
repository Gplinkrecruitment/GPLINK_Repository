// WP-04 of the Australian GP build: the pure rules behind pathway-aware
// scheduled jobs (lib/au-sweeps.js). The index every job asks, and the date an
// Australian case is aged from (ADM-04).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const auSweeps = requireCjs('../lib/au-sweeps.js');

const AU = 'user-au-1';
const UK = 'user-uk-1';

describe('buildAuSweepIndex: the one predicate every job applies', () => {
  it('switch off (inert): every answer is false and there is nothing to report', () => {
    const idx = auSweeps.inertAuSweepIndex('job');
    expect(idx.enabled).toBe(false);
    expect(idx.size).toBe(0);
    expect(idx.isAuUser(AU)).toBe(false);
    expect(idx.excludesUser(AU)).toBe(false);
    expect(idx.reasonForUser(AU)).toBe(null);
    // Even a case row that plainly says "Australian" is not excluded: with the
    // switch off every doctor is an overseas doctor.
    expect(idx.excludesCase({ id: 'c1', user_id: AU, stage: 'prestart', pathway: 'au_vr' })).toBe(false);
    expect(idx.excludesCaseId('c1')).toBe(false);
    expect(idx.summary()).toBe(null);
  });

  it('an index built with user ids but the switch off is still inert', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: false, userIds: [AU] });
    expect(idx.size).toBe(0);
    expect(idx.excludesUser(AU)).toBe(false);
  });

  it('switch on: a doctor on an Australian pathway is excluded; anyone else is not', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: true, userIds: [AU, ' user-au-2 ', '', null], job: 'weekly-sweep' });
    expect(idx.size).toBe(2);
    expect(idx.isAuUser(AU)).toBe(true);
    expect(idx.excludesUser(AU)).toBe(true);
    expect(idx.excludesUser('user-au-2')).toBe(true);
    expect(idx.reasonForUser(AU)).toBe('au_pathway');
    expect(idx.excludesUser(UK)).toBe(false);
    expect(idx.reasonForUser(UK)).toBe(null);
    // Unknown, empty and missing ids are overseas: never Australian by accident.
    [undefined, null, '', 'nobody'].forEach((id) => expect(idx.excludesUser(id)).toBe(false));
  });

  it('a case row: by the doctor, by the mirrored pathway, or by an Australian-only stage', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: true, userIds: [AU] });
    // The doctor is on the index, the case is still parked at myintealth with no mirror.
    expect(idx.excludesCase({ id: 'c1', user_id: AU, stage: 'myintealth', pathway: null })).toBe(true);
    // The row says so even though the doctor is not on the index (belt and braces).
    expect(idx.excludesCase({ id: 'c2', user_id: 'other', stage: 'myintealth', pathway: 'au_restricted' })).toBe(true);
    ['placement', 'prestart', 'commenced', 'guarantee'].forEach((stage) => {
      expect(idx.excludesCase({ id: 'c-' + stage, user_id: 'other', stage }), stage).toBe(true);
    });
    // 'complete' is on both ladders, so on its own it says nothing.
    expect(idx.excludesCase({ id: 'c3', user_id: UK, stage: 'complete' })).toBe(false);
    // Overseas cases, including a recorded overseas pathway and rows selected without the columns.
    ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement'].forEach((stage) => {
      expect(idx.excludesCase({ id: 'o-' + stage, user_id: UK, stage, pathway: 'overseas_esp' }), stage).toBe(false);
    });
    expect(idx.excludesCase({ id: 'c4', user_id: UK })).toBe(false);
    expect(idx.excludesCase(null)).toBe(false);
  });

  it('unreadable: every doctor and every case is held (unknown fails closed), with its own reason', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: true, unreadable: true, userIds: [AU] });
    expect(idx.unreadable).toBe(true);
    expect(idx.size).toBe(0);
    expect(idx.excludesUser(UK)).toBe(true);
    expect(idx.reasonForUser(UK)).toBe('pathway_unreadable');
    expect(idx.excludesCase({ id: 'c1', user_id: UK, stage: 'amc' })).toBe(true);
    expect(idx.excludesCaseId('c1')).toBe(true);
    // The fact is still "not known to be Australian".
    expect(idx.isAuUser(AU)).toBe(false);
    expect(idx.summary()).toMatchObject({ unreadable: true, excluded_au_pathway: 0 });
    expect(idx.summary().held_pathway_unreadable).toBeGreaterThan(0);
  });

  it('a missing column is not "unreadable": nobody is Australian and nothing is held', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: true, schemaMissing: true, userIds: [] });
    expect(idx.unreadable).toBe(false);
    expect(idx.schemaMissing).toBe(true);
    expect(idx.excludesUser(UK)).toBe(false);
    expect(idx.excludesCase({ id: 'c', user_id: UK, stage: 'myintealth' })).toBe(false);
  });

  it('bare case ids: held until the case ids are loaded, then exact', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: true, userIds: [AU] });
    expect(idx.hasCaseIds()).toBe(false);
    expect(idx.excludesCaseId('case-au')).toBe(true); // not loaded = cannot tell = hold
    idx.setCaseIds(['case-au']);
    expect(idx.hasCaseIds()).toBe(true);
    expect(idx.excludesCaseId('case-au')).toBe(true);
    expect(idx.excludesCaseId('case-uk')).toBe(false);
  });

  it('counts each doctor once per run, however often a job asks', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: true, userIds: [AU, 'user-au-2'] });
    idx.excludesUser(AU); idx.excludesUser(AU); idx.excludesUser(AU);
    idx.excludesUser('user-au-2');
    idx.excludesUser(UK);
    idx.reasonForUser(AU); // asking why does not count
    expect(idx.summary()).toEqual({ au_pathway_doctors: 2, excluded_au_pathway: 2, held_pathway_unreadable: 0, unreadable: false, schema_missing: false });
  });
});

describe('caseRowLooksAustralian', () => {
  it('true only for an Australian pathway on the row or an Australian-only stage', () => {
    expect(auSweeps.caseRowLooksAustralian({ pathway: 'au_vr' })).toBe(true);
    expect(auSweeps.caseRowLooksAustralian({ pathway: 'au_registrar', stage: 'myintealth' })).toBe(true);
    expect(auSweeps.caseRowLooksAustralian({ stage: 'guarantee' })).toBe(true);
    expect(auSweeps.caseRowLooksAustralian({ pathway: 'overseas_pep', stage: 'amc' })).toBe(false);
    expect(auSweeps.caseRowLooksAustralian({ pathway: null, stage: 'complete' })).toBe(false);
    expect(auSweeps.caseRowLooksAustralian({ pathway: 'garbage', stage: 'nonsense' })).toBe(false);
    expect(auSweeps.caseRowLooksAustralian({})).toBe(false);
    expect(auSweeps.caseRowLooksAustralian(null)).toBe(false);
  });
});

describe('auCaseAgeAnchor (ADM-04): an Australian case is aged from its milestones, never from the doctor\'s last activity', () => {
  const CREATED = '2026-08-01T00:00:00.000Z';
  const PLACED = '2026-09-10T00:00:00.000Z';
  const START = '2026-10-20';
  const placement = { placed_at: PLACED, created_at: '2026-09-09T00:00:00.000Z', start_date: START };

  it('placement: the day the case was created', () => {
    expect(auSweeps.auCaseAgeAnchor({ stage: 'placement', created_at: CREATED }, null)).toEqual({ at: CREATED, basis: 'case_created', stage: 'placement' });
    // A placement row on file does not change that while the case is still at placement.
    expect(auSweeps.auCaseAgeAnchor({ stage: 'placement', created_at: CREATED }, placement).basis).toBe('case_created');
  });

  it('prestart: the day the placement was recorded', () => {
    expect(auSweeps.auCaseAgeAnchor({ stage: 'prestart', created_at: CREATED }, placement)).toEqual({ at: PLACED, basis: 'placement_recorded', stage: 'prestart' });
    // No placed_at: the placement row's own creation; no row at all: the case.
    expect(auSweeps.auCaseAgeAnchor({ stage: 'prestart', created_at: CREATED }, { created_at: '2026-09-09T00:00:00.000Z' }).at).toBe('2026-09-09T00:00:00.000Z');
    expect(auSweeps.auCaseAgeAnchor({ stage: 'prestart', created_at: CREATED }, null)).toEqual({ at: CREATED, basis: 'case_created', stage: 'prestart' });
  });

  it('commenced and guarantee: the start, from WP-13\'s columns when they exist, else the placement\'s start date', () => {
    expect(auSweeps.auCaseAgeAnchor({ stage: 'commenced', created_at: CREATED }, placement)).toEqual({ at: '2026-10-20T00:00:00.000Z', basis: 'placement_start_date', stage: 'commenced' });
    expect(auSweeps.auCaseAgeAnchor({ stage: 'commenced', created_at: CREATED, commenced_at: '2026-10-22T00:00:00.000Z' }, placement))
      .toEqual({ at: '2026-10-22T00:00:00.000Z', basis: 'commenced', stage: 'commenced' });
    expect(auSweeps.auCaseAgeAnchor({ stage: 'guarantee', created_at: CREATED }, placement).basis).toBe('placement_start_date');
    expect(auSweeps.auCaseAgeAnchor({ stage: 'guarantee', created_at: CREATED, guarantee_started_at: '2026-10-23T00:00:00.000Z' }, placement))
      .toEqual({ at: '2026-10-23T00:00:00.000Z', basis: 'guarantee_started', stage: 'guarantee' });
    // Nothing but the placement record.
    expect(auSweeps.auCaseAgeAnchor({ stage: 'commenced', created_at: CREATED }, { placed_at: PLACED }).basis).toBe('placement_recorded');
  });

  it('complete: when the case was completed', () => {
    expect(auSweeps.auCaseAgeAnchor({ stage: 'complete', created_at: CREATED, completed_at: '2027-02-01T00:00:00.000Z' }, placement))
      .toEqual({ at: '2027-02-01T00:00:00.000Z', basis: 'completed', stage: 'complete' });
  });

  it('never reads last_gp_activity_at or updated_at', () => {
    const quiet = { stage: 'prestart', created_at: CREATED, last_gp_activity_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' };
    const busy = { stage: 'prestart', created_at: CREATED, last_gp_activity_at: '2026-11-19T00:00:00.000Z', updated_at: '2026-11-19T00:00:00.000Z' };
    expect(auSweeps.auCaseAgeAnchor(quiet, placement)).toEqual(auSweeps.auCaseAgeAnchor(busy, placement));
  });

  it('a case not yet on the Australian ladder, odd input and missing dates never throw', () => {
    expect(auSweeps.auCaseAgeAnchor({ stage: 'myintealth', created_at: CREATED }, placement).basis).toBe('case_created');
    expect(auSweeps.auCaseAgeAnchor({ stage: 'prestart', created_at: 'not a date' }, { placed_at: 'nope' })).toEqual({ at: null, basis: 'none', stage: 'prestart' });
    expect(auSweeps.auCaseAgeAnchor(null, null)).toEqual({ at: null, basis: 'none', stage: '' });
    expect(auSweeps.auCaseAgeAnchor(undefined, 'x').at).toBe(null);
  });

  it('auCaseAgeDays: whole days since the anchor, null when there is none', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    expect(auSweeps.auCaseAgeDays({ stage: 'prestart', created_at: CREATED }, placement, now)).toBe(10);
    expect(auSweeps.auCaseAgeDays({ stage: 'placement', created_at: CREATED }, null, now)).toBe(50);
    expect(auSweeps.auCaseAgeDays({ stage: 'prestart' }, null, now)).toBe(null);
    // An anchor in the future (a start date not yet reached) is day 0, never negative.
    expect(auSweeps.auCaseAgeDays({ stage: 'commenced', created_at: CREATED }, placement, now)).toBe(0);
  });
});
