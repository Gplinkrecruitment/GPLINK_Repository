import { describe, it, expect } from 'vitest';
import {
  normalizeBlockerPatch,
  isResolutionTimelineEvent,
  humanizeActor,
  VALID_BLOCKER_STATUSES,
  ESCALATION_FETCH_LIMIT
} from '../lib/ceo-actions.js';

describe('normalizeBlockerPatch', () => {
  it('maps the legacy "blocked" UI option to status=blocked + blocker_status=null (no CHECK violation)', () => {
    var p = normalizeBlockerPatch({ blocker_status: 'blocked', blocker_reason: 'stuck' });
    expect(p.status).toBe('blocked');
    expect(p.blocker_status).toBe(null);
    expect(p.blocker_reason).toBe('stuck');
    expect('blocker_set_at' in p).toBe(true);
    expect(typeof p.blocker_set_at).toBe('string');
  });
  it('passes through a valid blocker_status and sets status=blocked + blocker_set_at', () => {
    var p = normalizeBlockerPatch({ blocker_status: 'waiting_on_gp', blocker_reason: 'awaiting docs' });
    expect(p.blocker_status).toBe('waiting_on_gp');
    expect(p.status).toBe('blocked');
    expect(typeof p.blocker_set_at).toBe('string');
  });
  it('clearing the blocker sets status=active, blocker_status=null, blocker_set_at=null', () => {
    var p = normalizeBlockerPatch({ blocker_status: null, blocker_reason: '' });
    expect(p.status).toBe('active');
    expect(p.blocker_status).toBe(null);
    expect(p.blocker_set_at).toBe(null);
    expect(p.blocker_reason).toBe(null);
  });
  it('rejects an unknown blocker_status by treating it as a plain blocked flag', () => {
    var p = normalizeBlockerPatch({ blocker_status: 'totally_made_up' });
    expect(p.blocker_status).toBe(null);
    expect(p.status).toBe('blocked');
    expect(VALID_BLOCKER_STATUSES).not.toContain('blocked');
  });
});

describe('isResolutionTimelineEvent', () => {
  it('matches the exact CEO resolve title, not arbitrary reason text', () => {
    expect(isResolutionTimelineEvent({ event_type: 'escalation', title: 'CEO resolved escalation' })).toBe(true);
  });
  it('does NOT treat an open escalation whose reason mentions "resolved" as resolved', () => {
    expect(isResolutionTimelineEvent({ event_type: 'escalation', title: 'Escalated to CEO', detail: 'practice has not resolved the contract' })).toBe(false);
  });
});

describe('humanizeActor', () => {
  it('returns the email when actor is an email', () => {
    expect(humanizeActor('hazel@mygplink.com.au')).toBe('hazel@mygplink.com.au');
  });
  it('falls back to "System" for system actor and "Unknown" for empty', () => {
    expect(humanizeActor('system')).toBe('System');
    expect(humanizeActor('')).toBe('Unknown');
    expect(humanizeActor(null)).toBe('Unknown');
  });
});

describe('ESCALATION_FETCH_LIMIT', () => {
  it('is large enough to not silently drop escalations under load', () => {
    expect(ESCALATION_FETCH_LIMIT).toBeGreaterThanOrEqual(500);
  });
});
