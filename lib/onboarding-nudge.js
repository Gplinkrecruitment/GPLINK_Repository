// Onboarding nudge engine, pure scheduling + copy for the reminder emails sent
// to GPs who started but never finished the 5-step onboarding wizard.
// No I/O here: the /api/cron/onboarding-nudge branch in server.js owns reads,
// writes and sending. Spec: docs/superpowers/specs/2026-07-05-onboarding-nudge-waitlist-design.md
'use strict';

var HOUR = 3600000;
var DAY = 24 * HOUR;

// Inactivity thresholds. Index N = the Nth email, sent once inactivity passes it:
// ~1h after leaving, 24h, 3 days, then weekly (day 10/17/24/31), then stop.
var NUDGE_SCHEDULE_MS = [HOUR, 24 * HOUR, 72 * HOUR, 10 * DAY, 17 * DAY, 24 * DAY, 31 * DAY];

// Mirrors the 5-step wizard in js/onboarding.js (TOTAL_STEPS = 5).
var ONBOARDING_STEP_LABELS = [
  'Get started',
  'Qualification check',
  'Qualification documents',
  'Personal & family details',
  'Identity verification'
];

function _sentSet(stepsSent) {
  var set = {};
  (Array.isArray(stepsSent) ? stepsSent : []).forEach(function (s) { set[Number(s)] = true; });
  return set;
}

// First-sight anchor choice for a new reminder row. A GP who is ALREADY
// inactive 24h+ the first time the system sees them (a long-dormant account
// backfilled the day this feature ships, or any GP the cron first notices
// late) anchors at NOW, the sequence starts fresh and properly spaced
// (~1h, then 24h, ...) instead of every threshold already being due and
// firing up to 7 catch-up emails an hour apart. A GP seen within 24h of their
// real last activity keeps the true last-active anchor, preserving the
// "right after they leave" timing for fresh dropouts.
function backfillAnchorMs(lastActiveMs, nowMs) {
  var last = Number(lastActiveMs);
  var now = Number(nowMs);
  if (!isFinite(now)) now = Date.now();
  if (!isFinite(last)) return now;
  return (now - last >= 24 * HOUR) ? now : last;
}

// Lowest schedule index that is due (threshold <= inactivityMs) and unsent.
// One email per cron pass per GP, the earliest owed one.
function nextDueStep(input) {
  var inactivityMs = Number(input && input.inactivityMs);
  if (!isFinite(inactivityMs) || inactivityMs <= 0) return null;
  var sent = _sentSet(input && input.stepsSent);
  for (var i = 0; i < NUDGE_SCHEDULE_MS.length; i++) {
    if (sent[i]) continue;
    if (inactivityMs >= NUDGE_SCHEDULE_MS[i]) return i;
    return null; // thresholds are ascending: first unsent not yet due -> nothing due
  }
  return null;
}

// Sequence complete: past the final threshold with nothing left to send.
function isExhausted(input) {
  var inactivityMs = Number(input && input.inactivityMs);
  if (!isFinite(inactivityMs)) return false;
  if (inactivityMs < NUDGE_SCHEDULE_MS[NUDGE_SCHEDULE_MS.length - 1]) {
    var sent = _sentSet(input && input.stepsSent);
    return !!sent[NUDGE_SCHEDULE_MS.length - 1];
  }
  return nextDueStep(input) === null;
}

// Plain, friendly copy. `stepsLeft` = wizard steps remaining (may be null).
function copyForStep(index, opts) {
  var name = String((opts && opts.name) || '').trim() || 'there';
  var stepsLeft = (opts && opts.stepsLeft != null) ? Number(opts.stepsLeft) : null;
  var leftBit = (stepsLeft && stepsLeft > 0)
    ? 'You only have ' + stepsLeft + ' step' + (stepsLeft === 1 ? '' : 's') + ' left. '
    : '';
  var variants = [
    { subject: "Finish setting up your GP Link account",
      title: "You're almost set up",
      body: "Hi " + name + ", you were so close! " + leftBit + "Pick up right where you left off, it only takes a few minutes." },
    { subject: "Your GP Link account is waiting",
      title: "Ready when you are",
      body: "Hi " + name + ", your GP Link account setup is still waiting. " + leftBit + "Practices are hiring right now, finish up so we can start matching you." },
    { subject: "Still keen on working in Australia?",
      title: "Let's get you over the line",
      body: "Hi " + name + ", it's been a few days since you started your GP Link setup. " + leftBit + "Jump back in and we'll take care of the rest." },
    { subject: "Your Australian GP journey is on pause",
      title: "Shall we keep going?",
      body: "Hi " + name + ", your account setup has been paused for over a week. " + leftBit + "It only takes a few minutes to finish, then our team can start working for you." },
    { subject: "We're holding your spot",
      title: "Your spot is still here",
      body: "Hi " + name + ", we're still holding your place at GP Link. " + leftBit + "Finish your setup and our recruitment team will pick things up straight away." },
    { subject: "Don't lose momentum on your move to Australia",
      title: "Nearly a month has gone by",
      body: "Hi " + name + ", it's been nearly a month since you started. " + leftBit + "If life got busy, no stress, your progress is saved and you can finish any time." },
    { subject: "Last reminder from GP Link",
      title: "This is our last reminder",
      body: "Hi " + name + ", this is the last reminder we'll send about finishing your GP Link setup. " + leftBit + "Your progress stays saved, and you're welcome back whenever you're ready." }
  ];
  var i = Math.max(0, Math.min(variants.length - 1, Number(index) || 0));
  return variants[i];
}

module.exports = { NUDGE_SCHEDULE_MS, ONBOARDING_STEP_LABELS, nextDueStep, isExhausted, copyForStep, backfillAnchorMs };
