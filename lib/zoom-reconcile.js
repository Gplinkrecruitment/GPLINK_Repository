'use strict';

// Zoom is where the owner moves a consult by hand: a doctor was unwell on
// Sunday, so the owner dragged the same Zoom meeting to Thursday. Calendly
// never hears about that, so the booking row and the lead kept the old slot
// and the dashboard said "no consults today" while Zoom listed one (owner
// report 2026-11-05). This planner compares the rows against Zoom's upcoming
// list and says which rows to move; the server applies the patches.

var MIN_DRIFT_MS = 60 * 1000;
// A cancelled row stays cancelled even if its Zoom meeting still exists —
// Calendly's cancellation is the owner's or doctor's decision; Zoom is only
// trusted for the TIME of a booking that is still meant to happen.
var MOVABLE_STATUSES = ['booked', 'completed', 'no_show'];

function parseMs(v) { var t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : NaN; }

function planZoomReconcile(input) {
  var nowMs = Number(input && input.nowMs) || Date.now();
  var byId = {};
  (Array.isArray(input && input.zoomMeetings) ? input.zoomMeetings : []).forEach(function (m) {
    if (!m || m.id == null) return;
    if (m.type != null && Number(m.type) !== 2) return; // scheduled meetings only (not recurring / instant)
    var t = parseMs(m.start_time);
    if (!Number.isFinite(t)) return;
    byId[String(m.id)] = { startMs: t, startIso: new Date(t).toISOString(), topic: String(m.topic || '') };
  });
  var moves = [];
  (Array.isArray(input && input.rows) ? input.rows : []).forEach(function (r) {
    if (!r || r.zoom_meeting_id == null) return;
    var z = byId[String(r.zoom_meeting_id)];
    if (!z) return;
    if (MOVABLE_STATUSES.indexOf(String(r.status || '')) === -1) return;
    if (z.startMs <= nowMs) return; // only a slot still ahead of us is worth re-opening
    var cur = parseMs(r.scheduled_at);
    if (Number.isFinite(cur) && Math.abs(cur - z.startMs) < MIN_DRIFT_MS) return;
    var reopened = String(r.status) !== 'booked' || !!r.completed_at || !!r.no_show_at;
    var patch = { scheduled_at: z.startIso, status: 'booked', updated_at: new Date(nowMs).toISOString() };
    if (reopened) { patch.completed_at = null; patch.no_show_at = null; }
    moves.push({
      id: r.id, zoom_meeting_id: String(r.zoom_meeting_id), invitee_email: String(r.invitee_email || '').trim().toLowerCase(),
      from: r.scheduled_at || null, to: z.startIso, reopened: reopened, patch: patch
    });
  });
  return { checked: Object.keys(byId).length, moves: moves };
}

module.exports = { planZoomReconcile: planZoomReconcile, MIN_DRIFT_MS: MIN_DRIFT_MS, MOVABLE_STATUSES: MOVABLE_STATUSES };
