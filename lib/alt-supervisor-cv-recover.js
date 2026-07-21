'use strict';

/**
 * Pure decision helpers for the alternate-supervisor-CV reply pickup + the
 * triage sender allow-list gate. These hold the testable logic so the server.js
 * Gmail/Supabase wrappers stay thin. No I/O here.
 */

// Extract a bare lowercased email address from a raw From header value.
function bareEmail(raw) {
  return (String(raw || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [''])[0].toLowerCase();
}

// Is this sender on an always-trusted domain (never suppressed even when unmatched)?
// AHPRA officer mail must always reach the Support queue even during the scoped
// test rollout, because it can fail every GP-match signal yet still be critical.
function isAlwaysTrustedSender(rawSender, trustedDomains) {
  var addr = bareEmail(rawSender);
  if (!addr) return false;
  var domain = addr.split('@')[1] || '';
  var list = Array.isArray(trustedDomains) ? trustedDomains : ['ahpra.gov.au'];
  for (var i = 0; i < list.length; i++) {
    var d = String(list[i] || '').toLowerCase().trim();
    if (!d) continue;
    if (domain === d || domain.endsWith('.' + d)) return true;
  }
  return false;
}

/**
 * Decide whether to suppress a genuinely-UNMATCHED inbound message from the
 * ops queue / auto-delivery during the scoped test rollout.
 *
 * The rule: a message is only suppressed when it bound to NOTHING — it was not
 * an early-response match, not an alt-CV match, and its sender did not resolve to
 * a known GP case — AND the sender is not allow-listed and not always-trusted,
 * AND the allow-list is active (size > 0; "*"/empty disables the gate = full prod).
 *
 * This is the key regression guard: any reply that matched a tracked task/known
 * party (the whole point of the system) is NEVER suppressed, regardless of sender.
 */
function shouldSuppressUnmatched(opts) {
  opts = opts || {};
  var allowSet = opts.allowSet;
  if (!allowSet || typeof allowSet.size !== 'number' || allowSet.size === 0) return false; // gate off / full prod
  if (opts.earlyResponseMatched) return false;
  if (opts.altCvMatched) return false;
  if (opts.hasKnownCase) return false; // sender resolved to a real GP case → legitimate party
  var addr = bareEmail(opts.fromAddr);
  if (allowSet.has(addr)) return false;
  if (isAlwaysTrustedSender(addr, opts.alwaysTrustedDomains)) return false;
  return true;
}

/**
 * From a set of candidate message metas (thread messages + sender-search hits),
 * pick the ones that could be the practice's alt-CV reply:
 *  - sender (bare) === expectedSender (when an expected sender is known)
 *  - carries at least one attachment
 *  - not already ingested (gmail messageId not in attachedIds — case-wide, so the
 *    SPPA-00 form and other already-filed docs in the same thread are excluded)
 * Returned newest-first by internalDate so the most recent reply wins.
 */
function selectAltCvReplyCandidates(metas, opts) {
  opts = opts || {};
  var expectedSender = bareEmail(opts.expectedSender);
  var attached = {};
  (opts.attachedIds || []).forEach(function (id) { if (id) attached[id] = true; });
  var out = (metas || []).filter(function (m) {
    if (!m || !m.messageId) return false;
    if (attached[m.messageId]) return false;
    var atts = m.attachments || [];
    if (!atts.length) return false;
    if (expectedSender && bareEmail(m.sender) !== expectedSender) return false;
    return true;
  });
  out.sort(function (a, b) {
    var da = Number(a.internalDate || 0), db = Number(b.internalDate || 0);
    return db - da;
  });
  return out;
}

/**
 * Interpret the raw AI matcher JSON into the match decision. A document is only
 * accepted as an alt-supervisor CV when the model says it IS a CV (is_cv) — this
 * is what stops an SPPA-00 form / contract / position description (which all NAME
 * the alt supervisor and live in the same thread) from being mis-delivered as the CV.
 */
function interpretAltCvMatch(parsed) {
  parsed = parsed || {};
  var isCv = !!parsed.is_cv;
  var confidence = Number(parsed.confidence) || 0;
  return {
    matched: !!(isCv && parsed.matched_supervisor && confidence > 0.5),
    isCv: isCv,
    cvName: parsed.cv_name || '',
    matchedSupervisor: parsed.matched_supervisor || null,
    confidence: confidence
  };
}

/**
 * Roll up per-attachment match results for one message.
 *  - matchedCvs: the attachments that matched an alt supervisor (deliver these)
 *  - foundAttachmentButNoMatch: we saw attachments but none matched → surface for
 *    RSO review (never silent), and do NOT complete the request task.
 */
function summarizeAltCvMatch(perAttachmentResults) {
  var results = perAttachmentResults || [];
  var matchedCvs = results.filter(function (r) { return r && r.matched; });
  return {
    matchedCvs: matchedCvs,
    foundAttachmentButNoMatch: results.length > 0 && matchedCvs.length === 0
  };
}

module.exports = {
  bareEmail,
  isAlwaysTrustedSender,
  shouldSuppressUnmatched,
  selectAltCvReplyCandidates,
  interpretAltCvMatch,
  summarizeAltCvMatch
};
