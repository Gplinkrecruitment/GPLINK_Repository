/* Australian GP build (WP-12, APP-19 / APP-20, walk-findings D4): the plain
 * facts about a role that matter to a GP who already works in Australia.
 *
 *   GPAuJobFacts.rows(auFacts, options)   -> [{ key, label, value }]
 *   GPAuJobFacts.html(auFacts, options)   -> a ready <dl> (escaped)
 *
 * `auFacts` is what the server puts on a role for such a doctor
 * (lib/role-eligibility.js publicRoleFacts): billing model, VR requirement,
 * sessions a week, MMM and metro / regional, engagement type, special
 * interests, and whether the location is in a Distribution Priority Area.
 *
 * SHARED: the in-app job page (pages/job.html) uses rows(); the public job
 * page (WP-22) can load this same file and use rows() or html(). It has no
 * dependency and touches nothing on the page by itself.
 *
 * What it never says: anything about moving country or sponsorship, a
 * dollar figure, a percentage, or a rule about who may work where. It states
 * what the practice told us and nothing else; a fact that is not on file is
 * left out rather than guessed. Every word is checked by
 * tests/au-wp12-banned-words.test.js.
 */
(function (root) {
  'use strict';

  var BILLING = { bulk: 'Bulk billing', mixed: 'Mixed billing', private: 'Private billing' };
  var VR = {
    vr_required: 'Vocational registration (VR) required',
    vr_preferred: 'VR preferred',
    non_vr_accepted: 'Open to GPs without VR'
  };
  var ENGAGEMENT = { permanent: 'Permanent', contract: 'Contract' };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(v) {
    var n = Number(v);
    return v !== null && v !== undefined && v !== '' && isFinite(n) && n > 0 ? n : null;
  }
  function plain(n) { return String(Math.round(n * 10) / 10).replace(/\.0$/, ''); }

  function sessionsText(min, max) {
    var a = num(min);
    var b = num(max);
    if (a && b && a !== b) return plain(Math.min(a, b)) + ' to ' + plain(Math.max(a, b)) + ' sessions a week';
    var one = a || b;
    return one ? plain(one) + (one === 1 ? ' session a week' : ' sessions a week') : '';
  }

  function areaText(area, mmm) {
    var m = num(mmm);
    var name = area === 'metro' ? 'Metropolitan' : (area === 'regional' ? 'Regional' : '');
    if (name && m) return name + ' (MM' + plain(m) + ')';
    if (name) return name;
    return m ? 'MM' + plain(m) : '';
  }

  /**
   * @param {object} auFacts
   * @param {{ showDpa?: boolean }} [options]  showDpa: include the Distribution
   *   Priority Area row (the in-app page leaves it out for a doctor it does
   *   not concern).
   */
  function rows(auFacts, options) {
    var f = auFacts && typeof auFacts === 'object' ? auFacts : null;
    var o = options || {};
    if (!f) return [];
    var out = [];
    if (f.billingModel && BILLING[f.billingModel]) out.push({ key: 'billing', label: 'Billing', value: BILLING[f.billingModel] });
    // Nothing recorded reads as "VR required" (the careful default).
    var vr = VR[f.vrRequirement] ? f.vrRequirement : 'vr_required';
    out.push({ key: 'vr', label: 'Registration', value: VR[vr] });
    var sessions = sessionsText(f.sessionsMin, f.sessionsMax);
    if (sessions) out.push({ key: 'sessions', label: 'Sessions', value: sessions });
    var area = areaText(f.area, f.mmm);
    if (area) out.push({ key: 'area', label: 'Location type', value: area });
    if (f.engagementType && ENGAGEMENT[f.engagementType]) out.push({ key: 'engagement', label: 'Engagement', value: ENGAGEMENT[f.engagementType] });
    if (Array.isArray(f.specialInterests) && f.specialInterests.length) {
      out.push({ key: 'interests', label: 'Special interests', value: f.specialInterests.slice(0, 8).map(function (s) { return String(s); }).join(', ') });
    }
    if (f.acceptsRegistrars === true) out.push({ key: 'registrars', label: 'GP registrars', value: 'Considered' });
    if (o.showDpa === true && (f.dpa === 'yes' || f.dpa === 'no')) {
      out.push({ key: 'dpa', label: 'Distribution Priority Area', value: f.dpa === 'yes' ? 'Yes' : 'No' });
    }
    return out;
  }

  function html(auFacts, options) {
    var list = rows(auFacts, options);
    if (!list.length) return '';
    return '<dl class="au-job-facts">' + list.map(function (r) {
      return '<div class="au-job-fact" data-fact="' + esc(r.key) + '"><dt>' + esc(r.label) + '</dt><dd>' + esc(r.value) + '</dd></div>';
    }).join('') + '</dl>';
  }

  var api = { rows: rows, html: html, BILLING: BILLING, VR: VR, ENGAGEMENT: ENGAGEMENT };
  root.GPAuJobFacts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
