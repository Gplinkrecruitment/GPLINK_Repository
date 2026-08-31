'use strict';
// Builds the WhatsApp template message sent to a practice's PRIMARY contact
// when a candidate is submitted to them — it rides the same admin
// submit-to-practice action as the introduction email (server.js
// /api/admin/career/application/submit-to-practice) and carries the same
// decision link, as the template's URL button. Pure module — no I/O — so it
// is unit-testable.
//
// Template gp_link_practice_candidate_intro (created via the DoubleTick API
// 2026-08-31, WABA 61494391968, category UTILITY):
//   body {{1}} greeting name  {{2}} practice name  {{3}} candidate summary
//   button URL https://app.mygplink.com.au/pages/practice-decision.html?token={{1}}
// The button's one variable is the practice_action_token — the SAME stable
// token the email links use, so both channels land on the same decision page
// (approve prominent, turn-down behind a reason + confirm step).

var TEMPLATE_NAME = 'gp_link_practice_candidate_intro';
var TEMPLATE_LANGUAGE = 'en';
var MAX_SUMMARY_CHARS = 550;

// WhatsApp refuses template parameters containing newlines, tab characters or
// runs of 4+ spaces — collapse ALL whitespace runs to single spaces, then cap
// the length on a word boundary so a long value can never fail the send.
function waSafeParam(value, maxLen) {
  var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  var cap = Number(maxLen) > 0 ? Number(maxLen) : 0;
  if (cap && s.length > cap) {
    var cut = s.slice(0, cap);
    var lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > cap * 0.6) cut = cut.slice(0, lastSpace);
    s = cut.replace(/[\s.,;:]+$/, '') + '…';
  }
  return s;
}

// Returns { templateName, language, placeholders, buttons } for
// sendConsultWhatsAppTemplate, or null when the message must not be sent
// (no decision token or no practice name — a button that opens a broken
// decision page is worse than no WhatsApp at all; the email is the send of
// record either way).
function buildPracticeSubmissionWaMessage(opts) {
  var o = opts || {};
  var practiceName = waSafeParam(o.practiceName, 120);
  var token = String(o.actionToken == null ? '' : o.actionToken).trim();
  // The token is appended to the template's URL — refuse anything that is not
  // a plain URL-safe token rather than send a mangled link.
  if (!practiceName || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  var greeting = waSafeParam(o.contactName, 80) || (practiceName + ' team');
  var summary = waSafeParam(o.introParagraph, MAX_SUMMARY_CHARS);
  if (!summary) summary = 'We think this candidate could be a strong fit for your practice.';
  return {
    templateName: TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    placeholders: [greeting, practiceName, summary],
    buttons: [{ type: 'URL', parameter: token }]
  };
}

module.exports = { buildPracticeSubmissionWaMessage, waSafeParam, TEMPLATE_NAME };
