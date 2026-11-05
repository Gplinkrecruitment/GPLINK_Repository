// lib/zoom-reconcile.js — Zoom is the truth for WHEN a consult happens.
// The owner moves meetings by hand in Zoom (a doctor was unwell, the meeting
// got dragged to another day); Calendly never hears about it, so the booking
// row kept the old slot and the dashboard said "no consults today" while Zoom
// listed one (owner report 2026-11-05).
import { describe, it, expect } from 'vitest';
import { planZoomReconcile, MOVABLE_STATUSES } from '../lib/zoom-reconcile.js';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const row = (o) => Object.assign({ id: 'sc', zoom_meeting_id: '86526105611', scheduled_at: '2026-11-01T13:00:00.000Z', status: 'completed', completed_at: '2026-11-01T13:15:00.000Z', no_show_at: null, invitee_email: 'Vishal@Example.com' }, o);
const zoom = (o) => Object.assign({ id: 86526105611, type: 2, start_time: '2026-11-05T13:00:00Z', duration: 30, topic: 'Vishal: Finding The Perfect Australian Practice' }, o);

describe('planZoomReconcile', () => {
  it('moves a completed row to the new Zoom time and re-opens it (completed_at / no_show_at cleared)', () => {
    const plan = planZoomReconcile({ zoomMeetings: [zoom()], rows: [row()], nowMs: NOW });
    expect(plan.checked).toBe(1);
    expect(plan.moves).toHaveLength(1);
    const mv = plan.moves[0];
    expect(mv).toMatchObject({ id: 'sc', zoom_meeting_id: '86526105611', invitee_email: 'vishal@example.com', from: '2026-11-01T13:00:00.000Z', to: '2026-11-05T13:00:00.000Z', reopened: true });
    expect(mv.patch).toEqual({ scheduled_at: '2026-11-05T13:00:00.000Z', status: 'booked', updated_at: new Date(NOW).toISOString(), completed_at: null, no_show_at: null });
  });

  it('a booked row that merely drifted keeps its status and does not touch completed_at', () => {
    const plan = planZoomReconcile({ zoomMeetings: [zoom({ start_time: '2026-11-06T12:00:00Z' })], rows: [row({ status: 'booked', completed_at: null, scheduled_at: '2026-11-06T11:00:00.000Z' })], nowMs: NOW });
    expect(plan.moves[0].reopened).toBe(false);
    expect(plan.moves[0].patch).toEqual({ scheduled_at: '2026-11-06T12:00:00.000Z', status: 'booked', updated_at: new Date(NOW).toISOString() });
  });

  it('leaves alone: same time, a cancelled row, a Zoom slot already in the past, a meeting we do not know, a recurring meeting', () => {
    const same = planZoomReconcile({ zoomMeetings: [zoom({ start_time: '2026-11-01T13:00:30Z' })], rows: [row({ status: 'booked', completed_at: null })], nowMs: Date.parse('2026-10-30T00:00:00Z') });
    expect(same.moves).toEqual([]);
    const cancelled = planZoomReconcile({ zoomMeetings: [zoom()], rows: [row({ status: 'cancelled' })], nowMs: NOW });
    expect(cancelled.moves).toEqual([]);
    const past = planZoomReconcile({ zoomMeetings: [zoom({ start_time: '2026-11-05T09:00:00Z' })], rows: [row()], nowMs: NOW });
    expect(past.moves).toEqual([]);
    const unknown = planZoomReconcile({ zoomMeetings: [zoom({ id: 1 })], rows: [row()], nowMs: NOW });
    expect(unknown.moves).toEqual([]);
    const recurring = planZoomReconcile({ zoomMeetings: [zoom({ type: 8 })], rows: [row()], nowMs: NOW });
    expect(recurring.moves).toEqual([]);
    expect(MOVABLE_STATUSES).toEqual(['booked', 'completed', 'no_show']);
  });

  it('survives junk input', () => {
    expect(planZoomReconcile({})).toEqual({ checked: 0, moves: [] });
    expect(planZoomReconcile({ zoomMeetings: [null, { id: 5 }], rows: [null, {}] , nowMs: NOW })).toEqual({ checked: 0, moves: [] });
  });
});
