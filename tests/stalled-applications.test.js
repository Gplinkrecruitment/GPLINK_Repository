import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const S = require(path.join(__dirname, '..', 'lib', 'stalled-applications.js'));

const NOW = '2026-09-04T00:00:00Z';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();
const app = (over) => Object.assign({ id: 'a1', user_id: 'u1', career_role_id: 7, status: 'interview', ats_stage: 'interview', revealed: true, applied_at: daysAgo(120) }, over);

describe('stalled applications — narrow detector', () => {
  it('flags an introduced application with no movement for 60+ days', () => {
    const out = S.findStalledApplications([app({ ats_stage_updated_at: daysAgo(61) })], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a1', days_quiet: 61, ats_stage: 'interview', revealed: true });
    expect(out[0].last_movement_at).toBe(daysAgo(61));
  });
  it('59 days is not stalled; the threshold is configurable', () => {
    expect(S.findStalledApplications([app({ ats_stage_updated_at: daysAgo(59) })], { now: NOW })).toHaveLength(0);
    expect(S.findStalledApplications([app({ ats_stage_updated_at: daysAgo(31) })], { now: NOW, thresholdDays: 30 })).toHaveLength(1);
  });
  it('measures from the LATEST movement, never applied_at alone', () => {
    const out = S.findStalledApplications([app({ applied_at: daysAgo(200), ats_stage_updated_at: daysAgo(90), interview_completed_at: daysAgo(10) })], { now: NOW });
    expect(out).toHaveLength(0);
    expect(S.lastMovementAt({ applied_at: daysAgo(200), practice_decision_at: daysAgo(5) })).toBe(daysAgo(5));
  });
  it('ignores updated_at (reminder crons bump it)', () => {
    const out = S.findStalledApplications([app({ ats_stage_updated_at: daysAgo(90), updated_at: daysAgo(1) })], { now: NOW });
    expect(out).toHaveLength(1);
  });
  it('only introduced pairs count: revealed, interview/offer stage, interview held, practice approved, or staff-applied', () => {
    const quiet = { ats_stage_updated_at: daysAgo(90) };
    expect(S.findStalledApplications([app({ revealed: false, ats_stage: 'submitted', status: 'review', ...quiet })], { now: NOW })).toHaveLength(0);
    expect(S.findStalledApplications([app({ revealed: false, ats_stage: 'applied', status: 'applied', ...quiet })], { now: NOW })).toHaveLength(0);
    expect(S.isIntroduced({ revealed: true })).toBe(true);
    expect(S.isIntroduced({ ats_stage: 'offer' })).toBe(true);
    expect(S.isIntroduced({ interview_completed_at: daysAgo(1) })).toBe(true);
    expect(S.isIntroduced({ practice_decision: 'approved' })).toBe(true);
    expect(S.isIntroduced({ origin: 'admin_applied' })).toBe(true);
    expect(S.isIntroduced({ ats_stage: 'reviewing', practice_decision: 'turned_down' })).toBe(false);
  });
  it('closed applications never count, whatever the timestamps say', () => {
    const quiet = { ats_stage_updated_at: daysAgo(400) };
    for (const over of [{ status: 'withdrawn' }, { ats_stage: 'not_proceeding' }, { status: 'placement_secured', ats_stage: 'hired' }, { status: 'hired' }, { status: 'offer_declined' }]) {
      expect(S.findStalledApplications([app({ ...quiet, ...over })], { now: NOW }), JSON.stringify(over)).toHaveLength(0);
    }
  });
  it('sorts longest-quiet first and tolerates garbage rows', () => {
    const out = S.findStalledApplications([null, 'x', app({ id: 'b', ats_stage_updated_at: daysAgo(70) }), app({ id: 'c', ats_stage_updated_at: daysAgo(100) }), { id: 'no-ts', revealed: true, status: 'interview', ats_stage: 'interview' }], { now: NOW });
    expect(out.map((o) => o.id)).toEqual(['c', 'b']);
  });
});

describe('stalled applications — alert sentinel (once per quiet stretch)', () => {
  const stalled = [{ id: 'a', last_movement_at: '2026-06-01T00:00:00.000Z', days_quiet: 95 }, { id: 'b', last_movement_at: '2026-07-01T00:00:00.000Z', days_quiet: 65 }];
  it('alerts everything when nothing has been alerted', () => {
    expect(S.selectFreshStalls(stalled, {}).map((s) => s.id)).toEqual(['a', 'b']);
    expect(S.selectFreshStalls(stalled, null).map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('does not re-alert an application already alerted for the same quiet stretch', () => {
    const sentinel = { a: { alerted_at: '2026-08-01T00:00:00.000Z', last_movement_at: '2026-06-01T00:00:00.000Z' } };
    expect(S.selectFreshStalls(stalled, sentinel).map((s) => s.id)).toEqual(['b']);
  });
  it('re-alerts when the application moved and went quiet again', () => {
    const sentinel = { a: { alerted_at: '2026-03-01T00:00:00.000Z', last_movement_at: '2026-01-01T00:00:00.000Z' } };
    expect(S.selectFreshStalls(stalled, sentinel).map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('nextSentinel keeps prior entries for unchanged stretches, stamps new ones, and drops applications that recovered', () => {
    const prior = { a: { alerted_at: '2026-08-01T00:00:00.000Z', last_movement_at: '2026-06-01T00:00:00.000Z' }, gone: { alerted_at: 'x', last_movement_at: 'y' } };
    const next = S.nextSentinel(stalled, prior, '2026-09-04T00:00:00.000Z');
    expect(next.a).toBe(prior.a);
    expect(next.b).toMatchObject({ alerted_at: '2026-09-04T00:00:00.000Z', last_movement_at: '2026-07-01T00:00:00.000Z', days_quiet_at_alert: 65 });
    expect(next.gone).toBeUndefined();
  });
});
