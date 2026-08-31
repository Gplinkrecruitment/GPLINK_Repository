'use strict';
// Builds the WhatsApp template message sent to a practice's PRIMARY contact
// when a candidate is submitted to them — it rides the same admin
// submit-to-practice action as the introduction email (server.js
// /api/admin/career/application/submit-to-practice) and carries the same
// decision link, as the template's URL button. Pure module — no I/O — so it
// is unit-testable.
//
// TWO templates, both WABA 61494391968, category UTILITY, same body variables
// ({{1}} greeting, {{2}} practice, {{3}} candidate summary) and the same
// dynamic URL button (https://app.mygplink.com.au/pages/practice-decision.html
// ?token={{1}} — the SAME stable practice_action_token the email links use, so
// both channels land on the same decision page, approve/interview prominent,
// turn-down behind a reason + confirm step):
// - gp_link_practice_candidate_intro_cv (id 2360277, created 2026-08-31):
//   DOCUMENT header carrying the candidate's CV, button "Interview or
//   decline". Used whenever a CV link is available.
// - gp_link_practice_candidate_intro (id 2360276): text-only fallback for a
//   candidate with no CV on file. A WhatsApp business-initiated conversation
//   cannot send a separate free-form document message (that needs the practice
//   to have messaged us within 24h), which is why the CV rides IN the template
//   as a header rather than as a follow-up message.

var TEMPLATE_NAME = 'gp_link_practice_candidate_intro';
var TEMPLATE_NAME_CV = 'gp_link_practice_candidate_intro_cv';
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

// A WhatsApp document filename is display-only — keep it readable and safe.
function waSafeFilename(value, fallback) {
  var s = String(value == null ? '' : value).replace(/[^ -~]+/g, ' ').replace(/["*:<>?\\|\/]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

// Returns { templateName, language, placeholders, buttons[, header] } for
// sendConsultWhatsAppTemplate, or null when the message must not be sent
// (no decision token or no practice name — a button that opens a broken
// decision page is worse than no WhatsApp at all; the email is the send of
// record either way). Pass cvUrl (an https link WhatsApp's servers can fetch,
// e.g. a Supabase-storage signed URL) to attach the CV via the _cv template's
// DOCUMENT header; anything else falls back to the text-only template.
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
  var cvUrl = String(o.cvUrl == null ? '' : o.cvUrl).trim();
  var hasCv = /^https:\/\/\S+$/.test(cvUrl);
  var message = {
    templateName: hasCv ? TEMPLATE_NAME_CV : TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    placeholders: [greeting, practiceName, summary],
    buttons: [{ type: 'URL', parameter: token }]
  };
  if (hasCv) {
    message.header = {
      type: 'DOCUMENT',
      mediaUrl: cvUrl,
      filename: waSafeFilename(o.cvFilename, 'Candidate-CV.pdf')
    };
  }
  return message;
}

module.exports = { buildPracticeSubmissionWaMessage, waSafeParam, waSafeFilename, TEMPLATE_NAME, TEMPLATE_NAME_CV };
