// Pure helper: given a GP's interview (from GET /api/career/application or
// /api/career/my-interviews), work out what the doctor should actually be shown RIGHT NOW.
//
// WHY THIS EXISTS
// ---------------
// The interview card had exactly two states: "Schedule your interview" (no time booked) and
// "Upcoming Interview" (a time booked -> details + a live Join Zoom button). Nothing anywhere
// compared the meeting time to the clock, and the only thing that could hide the Join button
// was a non-video format — which the server hardcodes to 'video' for every self-booked
// interview, so it could never fire. The result: hours, days and weeks after the interview
// finished, the doctor still saw a card headed "Upcoming Interview", showing a date that had
// already passed, with a Join button that still worked.
//
// UMD: usable both in the browser (window.deriveInterviewCardState) and in vitest
// (require/import). No DOM, no browser globals, no Date.now() unless you omit `now` —
// keep it pure and testable.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.deriveInterviewCardState = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // How long an interview is assumed to run when the row does not say. Matches the 45 the
  // card already prints as its "Duration" default.
  var DEFAULT_DURATION_MINUTES = 45;
  // Interviews start late and run over. Keep the Join button alive this long past the
  // scheduled end so a doctor rejoining after a dropout is never locked out of their own
  // interview — the cost of being wrong in this direction is far higher than a button that
  // lingers a little.
  var OVERRUN_GRACE_MINUTES = 30;

  function parseTime(value) {
    if (!value) return NaN;
    var t = Date.parse(value);
    return isFinite(t) ? t : NaN;
  }

  function normStatus(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /**
   * @param {Object} interview
   * @param {string} [interview.status]            'scheduled'|'booked'|'completed'|'no_show'|'cancelled'
   * @param {string} [interview.scheduled_at]      ISO start (scheduledAt also accepted)
   * @param {number} [interview.duration_minutes]  minutes (durationMinutes also accepted)
   * @param {number} [now]                         epoch ms; defaults to the real clock
   * @returns {{phase:string,title:string,message:string,showJoin:boolean,showCalendar:boolean,isBooked:boolean}}
   */
  return function deriveInterviewCardState(interview, now) {
    var iv = interview || {};
    var status = normStatus(iv.status);
    var startMs = parseTime(iv.scheduled_at != null ? iv.scheduled_at : iv.scheduledAt);
    var nowMs = (typeof now === 'number' && isFinite(now)) ? now : Date.now();

    // No confirmed time yet -> the picker, exactly as before.
    if (!isFinite(startMs)) {
      return {
        phase: 'scheduling', title: 'Schedule your interview', message: '',
        showJoin: false, showCalendar: false, isBooked: false,
      };
    }

    if (status === 'cancelled') {
      return {
        phase: 'cancelled', title: 'Interview cancelled',
        message: 'This interview was cancelled. GP Link will be in touch about next steps.',
        showJoin: false, showCalendar: false, isBooked: true,
      };
    }

    if (status === 'no_show') {
      return {
        phase: 'no_show', title: 'Interview missed',
        message: 'This interview was recorded as missed. Please contact GP Link so we can rebook it for you.',
        showJoin: false, showCalendar: false, isBooked: true,
      };
    }

    var durationMin = Number(iv.duration_minutes != null ? iv.duration_minutes : iv.durationMinutes);
    if (!isFinite(durationMin) || durationMin <= 0) durationMin = DEFAULT_DURATION_MINUTES;
    var endMs = startMs + durationMin * 60000;
    var joinClosesMs = endMs + OVERRUN_GRACE_MINUTES * 60000;

    // Marked done by staff or the no-show sweep — trust that over the clock.
    if (status === 'completed') {
      return {
        phase: 'done', title: 'Interview complete',
        message: 'Thanks for attending. The practice is considering your interview — GP Link will let you know as soon as there is an outcome.',
        showJoin: false, showCalendar: false, isBooked: true,
      };
    }

    // Still to come.
    if (nowMs < startMs) {
      return {
        phase: 'upcoming', title: 'Upcoming Interview', message: '',
        showJoin: true, showCalendar: true, isBooked: true,
      };
    }

    // Under way (or just over, within the grace window).
    if (nowMs < joinClosesMs) {
      return {
        phase: 'live', title: 'Interview in progress',
        message: 'Your interview is scheduled for now. Use the join button if you have not joined yet.',
        showJoin: true, showCalendar: false, isBooked: true,
      };
    }

    // The window has closed and nothing has marked it complete yet — the row is only swept
    // to 'completed' up to 7 days later, so the clock has to carry the card until then.
    return {
      phase: 'done', title: 'Interview complete',
      message: 'Thanks for attending. The practice is considering your interview — GP Link will let you know as soon as there is an outcome.',
      showJoin: false, showCalendar: false, isBooked: true,
    };
  };
});
