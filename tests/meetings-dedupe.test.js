// Reschedule/double-booking dedupe for the CEO "Meetings" tab.
//
// Root cause (see prod evidence for farazsonde88@gmail.com): a GP who reschedules or
// re-books the public Calendly consultation link ends up with TWO scheduled_calls rows,
// both status='booked' — the old slot never gets cancelled. The Meetings list must
// collapse superseded/duplicate ACTIVE meetings so only the current one shows, while
// still keeping genuine history (completed / no-show / a standalone cancellation).
import { describe, it, expect } from 'vitest';
const { dedupeMeetingRowsForDisplay } = require('../server-test-helpers.js');

const ids = (rows) => rows.map((r) => r.id);

describe('dedupeMeetingRowsForDisplay', () => {
  it('keeps only the most-recently-booked active row when a GP re-books the same slot (Faraz)', () => {
    // Rows come back ordered created_at.desc, so the newest is first.
    const rowB = { id: 'B', status: 'booked', meeting_kind: 'consultation', invitee_email: 'faraz@example.com',
      scheduled_at: '2026-07-26T13:00:00+00:00', booked_at: '2026-07-23T15:29:04.283+00:00', created_at: '2026-07-23T15:29:04.283+00:00' };
    const rowA = { id: 'A', status: 'booked', meeting_kind: 'consultation', invitee_email: 'faraz@example.com',
      scheduled_at: '2026-07-25T15:00:00+00:00', booked_at: '2026-07-23T14:44:35.78+00:00', created_at: '2026-07-23T14:44:35.78+00:00' };
    const out = dedupeMeetingRowsForDisplay([rowB, rowA]);
    expect(ids(out)).toEqual(['B']);
  });

  it('hides the superseded old slot when a reschedule cancelled it (no cancelled meetings show alongside the new one)', () => {
    const booked = { id: 'new', status: 'booked', meeting_kind: 'consultation', invitee_email: 'gp@example.com',
      scheduled_at: '2026-07-26T13:00:00+00:00', booked_at: '2026-07-23T15:29:00+00:00', created_at: '2026-07-23T15:29:00+00:00' };
    const cancelled = { id: 'old', status: 'cancelled', meeting_kind: 'consultation', invitee_email: 'gp@example.com',
      scheduled_at: '2026-07-25T15:00:00+00:00', cancelled_at: '2026-07-23T15:29:00+00:00', booked_at: '2026-07-23T14:44:00+00:00', created_at: '2026-07-23T14:44:00+00:00' };
    const out = dedupeMeetingRowsForDisplay([booked, cancelled]);
    expect(ids(out)).toEqual(['new']);
  });

  it('keeps a standalone cancellation (GP cancelled, never rebooked) as history', () => {
    const cancelled = { id: 'c1', status: 'cancelled', meeting_kind: 'consultation', invitee_email: 'gp@example.com',
      scheduled_at: '2026-07-25T15:00:00+00:00', cancelled_at: '2026-07-23T15:00:00+00:00', created_at: '2026-07-23T14:00:00+00:00' };
    const out = dedupeMeetingRowsForDisplay([cancelled]);
    expect(ids(out)).toEqual(['c1']);
  });

  it('never drops real history (a completed past call) when a new call is booked for the same person', () => {
    const booked = { id: 'up', status: 'booked', meeting_kind: 'consultation', user_id: 'u1',
      scheduled_at: '2026-07-26T13:00:00+00:00', booked_at: '2026-07-23T15:00:00+00:00', created_at: '2026-07-23T15:00:00+00:00' };
    const completed = { id: 'past', status: 'completed', meeting_kind: 'consultation', user_id: 'u1',
      scheduled_at: '2026-06-01T09:00:00+00:00', completed_at: '2026-06-01T09:30:00+00:00', booked_at: '2026-05-30T10:00:00+00:00', created_at: '2026-05-30T10:00:00+00:00' };
    const out = dedupeMeetingRowsForDisplay([booked, completed]);
    expect(ids(out).sort()).toEqual(['past', 'up']);
  });

  it('does not merge two interviews for the same GP that belong to different applications', () => {
    const int1 = { id: 'i1', status: 'booked', meeting_kind: 'interview', user_id: 'u1', application_id: 'appA',
      scheduled_at: '2026-07-26T13:00:00+00:00', booked_at: '2026-07-23T10:00:00+00:00', created_at: '2026-07-23T10:00:00+00:00' };
    const int2 = { id: 'i2', status: 'booked', meeting_kind: 'interview', user_id: 'u1', application_id: 'appB',
      scheduled_at: '2026-07-27T13:00:00+00:00', booked_at: '2026-07-23T11:00:00+00:00', created_at: '2026-07-23T11:00:00+00:00' };
    const out = dedupeMeetingRowsForDisplay([int2, int1]);
    expect(ids(out).sort()).toEqual(['i1', 'i2']);
  });

  it('collapses duplicate active consultations grouped by user_id', () => {
    const older = { id: 'o', status: 'booked', meeting_kind: 'consultation', user_id: 'u9',
      scheduled_at: '2026-07-25T15:00:00+00:00', booked_at: '2026-07-23T14:00:00+00:00', created_at: '2026-07-23T14:00:00+00:00' };
    const newer = { id: 'n', status: 'booked', meeting_kind: 'consultation', user_id: 'u9',
      scheduled_at: '2026-07-26T15:00:00+00:00', booked_at: '2026-07-23T16:00:00+00:00', created_at: '2026-07-23T16:00:00+00:00' };
    const out = dedupeMeetingRowsForDisplay([newer, older]);
    expect(ids(out)).toEqual(['n']);
  });

  it('never groups rows that have no person identity (no user_id and no email)', () => {
    const a = { id: 'a', status: 'booked', meeting_kind: 'consultation', booked_at: '2026-07-23T14:00:00+00:00', created_at: '2026-07-23T14:00:00+00:00' };
    const b = { id: 'b', status: 'booked', meeting_kind: 'consultation', booked_at: '2026-07-23T15:00:00+00:00', created_at: '2026-07-23T15:00:00+00:00' };
    const out = dedupeMeetingRowsForDisplay([a, b]);
    expect(ids(out).sort()).toEqual(['a', 'b']);
  });

  it('preserves the incoming order of the rows it keeps', () => {
    const rows = [
      { id: 'x', status: 'booked', meeting_kind: 'consultation', user_id: 'ux', booked_at: '2026-07-23T10:00:00+00:00', created_at: '2026-07-23T10:00:00+00:00' },
      { id: 'y', status: 'booked', meeting_kind: 'consultation', user_id: 'uy', booked_at: '2026-07-23T11:00:00+00:00', created_at: '2026-07-23T11:00:00+00:00' },
      { id: 'z', status: 'booked', meeting_kind: 'consultation', user_id: 'uz', booked_at: '2026-07-23T12:00:00+00:00', created_at: '2026-07-23T12:00:00+00:00' }
    ];
    const out = dedupeMeetingRowsForDisplay(rows);
    expect(ids(out)).toEqual(['x', 'y', 'z']);
  });

  it('returns an empty array for non-array input', () => {
    expect(dedupeMeetingRowsForDisplay(null)).toEqual([]);
    expect(dedupeMeetingRowsForDisplay(undefined)).toEqual([]);
  });
});
