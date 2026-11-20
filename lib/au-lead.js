'use strict';

/**
 * "Is this an Australian-segment lead?" — the ONE place that question is
 * answered for the lead funnel (site_enquiries rows of kind 'gp').
 *
 * Why it exists (WP-01 of the Australian GP build, docs/au-gp/review-report.md):
 * the funnel admits a lead whose training country is Australia, and then treats
 * them like a UK doctor moving country: Hazel rings with the UK script, and the
 * chase emails and WhatsApps talk about visas and "your move". Until Australian
 * copy exists those messages are held back and only the owner is told.
 *
 * Three questions, kept separate on purpose so later packages can change one
 * without touching the others:
 *
 *   isAuSegmentLead(lead)     the fact. Today: consult.country === 'au'.
 *                             WP-15 extends this to read consult.segment.
 *   auHazelBlocked(lead)      PERMANENT (owner decision 7): Hazel never rings
 *                             an Australian-segment lead. WP-19 writes an AU
 *                             script as a file only; this stays.
 *   auMessagesHeld(lead)      INTERIM: automated emails and WhatsApps to the
 *                             lead are held until WP-16 ships Australian copy.
 *                             WP-16 replaces the call sites of this one.
 *
 * The message hold (auMessagesHeld) sits behind the single AU_PATHWAY_ENABLED
 * switch (lib/au-pathway-flag.js): with the switch off it always answers
 * false, so an Australian lead is emailed exactly as before. Callers that are
 * pure functions pass the switch in as `opts.auPathwayEnabled` so tests can
 * exercise both states; when it is not passed, the switch is read at call time.
 *
 * The Hazel block (auHazelBlocked) does NOT look at the switch (WP-04, on the
 * lead's instruction): Hazel never rings an Australian-segment lead, switch on
 * or off. This is the one deliberate exception to "switch off = identical to
 * main" (docs/au-gp/CONVENTIONS.md section 2). In production today no
 * Australian from-number is configured, so nothing a lead experiences
 * changes; the block protects against the UK script ringing Australian leads
 * if a number is ever added.
 *
 * `lead` may be a site_enquiries row ({ metadata: { consult } }) or the consult
 * object itself.
 */

const { isAuPathwayEnabled } = require('./au-pathway-flag.js');

// The skip reason leadCallDecision returns, and the Leads tab explains.
const AU_NO_CALL_REASON = 'au_segment';
// The reason recorded when a message to the lead is held back.
const AU_MESSAGES_HELD_REASON = 'au_segment';

function consultOf(lead) {
  if (!lead || typeof lead !== 'object') return null;
  // A row carries metadata (and kind); anything else is taken as the consult.
  if (Object.prototype.hasOwnProperty.call(lead, 'metadata') || Object.prototype.hasOwnProperty.call(lead, 'kind')) {
    const c = lead.metadata && lead.metadata.consult;
    return (c && typeof c === 'object') ? c : null;
  }
  return lead;
}

function isAuSegmentLead(lead) {
  const consult = consultOf(lead);
  if (!consult) return false;
  return String(consult.country == null ? '' : consult.country).trim().toLowerCase() === 'au';
}

// The switch, with an explicit override for pure callers and tests.
function auPathwayOn(opts) {
  if (opts && typeof opts.auPathwayEnabled === 'boolean') return opts.auPathwayEnabled;
  return isAuPathwayEnabled();
}

// PERMANENT and UNCONDITIONAL (owner decision 7; WP-04 removed the switch from
// this one). True for any Australian-segment lead, whatever AU_PATHWAY_ENABLED
// says. `opts` is accepted so existing callers keep working and is ignored.
function auHazelBlocked(lead, opts) { // eslint-disable-line no-unused-vars
  return isAuSegmentLead(lead);
}

function auMessagesHeld(lead, opts) {
  return auPathwayOn(opts) && isAuSegmentLead(lead);
}

module.exports = {
  AU_NO_CALL_REASON,
  AU_MESSAGES_HELD_REASON,
  isAuSegmentLead,
  auPathwayOn,
  auHazelBlocked,
  auMessagesHeld
};
