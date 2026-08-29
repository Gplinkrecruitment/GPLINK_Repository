// lib/match-whatsapp.js — pure copy/decision logic for the "you've been matched"
// WhatsApp touch (DoubleTick). No I/O. Consumed by server.js
// (announceShortlistToGp), which resolves the job/practice/GP rows and does the
// sending.
//
// Until this shipped, a shortlist reached the doctor by email, in-app update and
// web push — but NOT WhatsApp, which is the channel this audience actually reads
// (see lib/consult-whatsapp.js for the same reasoning on the consult funnel).
// A first message to someone who has never messaged us MUST be an approved
// template, so the copy below has to match the DoubleTick dashboard exactly;
// renderMatchWhatsAppText() reproduces the assembled message so the template can
// be registered from the same source of truth it is sent from.
//
// ── On urgency ────────────────────────────────────────────────────────────────
// The brief was to convey competition so doctors respond quickly. Everything
// this file claims is TRUE and checkable, because these are real people making
// relocation decisions and a claim that turns out to be invented is a trust
// problem we would rather not buy:
//   • the 5-day hold is real — match_expires_at is enforced by the lifecycle
//     cron, and the spot really is released when it lapses;
//   • the "other doctors" line is only emitted when other doctors really ARE
//     live on the same role, and it states the real number (server.js counts
//     shortlisted gp_applications on that career_role_id).
// When nobody else is shortlisted, the deadline carries the urgency on its own
// rather than inventing rivals.
'use strict';

const MATCH_WA_TEMPLATE = { templateName: 'gp_link_app_match_invitation', language: 'en' };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Wed 3 Sep". Deliberately a DATE, not "in 5 days": a doctor reading this on
// day three would otherwise be told the wrong thing by their own scrollback.
function formatHoldDate(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return DAY_NAMES[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()];
}

function firstNameOf(value) {
  const n = String(value || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0];
}

// "Dr Deepika" reads better than a bare first name on WhatsApp, but only when we
// actually hold a name.
function greetingNameOf(ctx) {
  const first = String((ctx && ctx.firstName) || '').trim();
  return first ? firstNameOf(first) : 'there';
}

function locationLabelOf(ctx) {
  const city = String((ctx && ctx.city) || '').trim();
  const state = String((ctx && ctx.state) || '').trim();
  return [city, state].filter(Boolean).join(', ');
}

// The one line that carries the urgency. Two shapes, both factual.
//   • others > 0 → name the real number of doctors live on this same role.
//   • others = 0 → lean on the real hold date only.
// Never claims a number we did not count.
function buildUrgencyLine(ctx) {
  const others = Number((ctx && ctx.otherShortlistedCount) || 0);
  const hold = formatHoldDate(ctx && ctx.expiresAt);
  const holdClause = hold ? ('your spot is held until ' + hold) : 'your spot is held for a short window';
  if (others > 0) {
    const who = others === 1 ? 'one other doctor has' : (others + ' other doctors have');
    // NOT "whoever accepts first gets the interview" — the practice decides who
    // it sees, and doctors are submitted by hand, so we cannot promise an
    // ordering. What IS true: accepting is the step that puts them in front of
    // the practice, so accepting sooner reaches the practice sooner.
    return who.charAt(0).toUpperCase() + who.slice(1) + ' also been shortlisted for this position, and '
      + holdClause + '. The sooner you accept, the sooner we can put you in front of them.';
  }
  return 'We are holding this one for you until ' + (hold || 'the end of your window')
    + ' — after that the position is released to other doctors.';
}

// The assembled message. Kept here (rather than only in the DoubleTick console)
// so the approved template and the thing we believe we are sending are the same
// text, and so tests can read it.
function renderMatchWhatsAppText(ctx) {
  const p = buildMatchWhatsAppPlaceholders(ctx);
  if (!p) return '';
  return 'Hi ' + p.placeholders[0] + ' 👋\n\n'
    + 'Great news — you have been personally matched with ' + p.placeholders[1] + '.\n\n'
    + p.placeholders[2] + '\n\n'
    + 'Have a look and let us know if you would like to go forward to an interview:\n'
    + p.placeholders[3] + '\n\n'
    + 'Not the right fit? Just reply here and tell us why — it helps us find you a better one.';
}

// {{1}} greeting name · {{2}} practice + location · {{3}} urgency line · {{4}} link
//
// Returns null when the link is missing: the entire point of this message is to
// get the doctor onto the match page, and a template that lands without one just
// spends the doctor's goodwill (same rule as the consult reminders).
function buildMatchWhatsAppPlaceholders(ctx) {
  const link = String((ctx && ctx.matchUrl) || '').trim();
  if (!link) return null;

  const practice = String((ctx && ctx.practiceName) || '').trim();
  const where = locationLabelOf(ctx);
  // A match ALWAYS reveals the practice (gp_applications.revealed = true), and
  // the match email already names it in its subject line — so naming it here
  // leaks nothing the doctor cannot already see.
  const practiceLine = practice
    ? (practice + (where ? (' in ' + where) : ''))
    : (where ? ('a practice in ' + where) : 'an Australian practice');

  return {
    templateName: MATCH_WA_TEMPLATE.templateName,
    language: MATCH_WA_TEMPLATE.language,
    placeholders: [greetingNameOf(ctx), practiceLine, buildUrgencyLine(ctx), link]
  };
}

module.exports = {
  MATCH_WA_TEMPLATE,
  formatHoldDate,
  buildUrgencyLine,
  buildMatchWhatsAppPlaceholders,
  renderMatchWhatsAppText
};
