// Pure helper: given one application object from GET /api/career/applications,
// return the home-screen "live application" card (title, badge tone, and the
// stage-correct deep link), or null when there is nothing to show.
// UMD: usable both in the browser (window.deriveCareerHomeCard) and in vitest
// (require/import). No DOM, no browser globals, keep it pure.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.deriveCareerHomeCard = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  var SECURED = ['hired', 'secured', 'placed', 'placement_secured', 'offer_accepted', 'contract_signed'];
  var CLOSED = ['withdrawn', 'not_proceeding', 'rejected', 'offer_declined'];
  var INTERVIEW = ['interview', 'interview_scheduled', 'interview_confirmed', 'shortlisted'];

  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function card(title, badgeClass, badgeLabel, href, ts) {
    return { title: title, badgeClass: badgeClass, badgeLabel: badgeLabel, iconType: badgeClass, href: href, ts: ts || '' };
  }

  return function deriveCareerHomeCard(app) {
    if (!app || !app.id) return null;
    var status = normalize(app.status);
    var roleId = app.role && app.role.id ? app.role.id : '';
    var ts = app.appliedAt || '';
    if (CLOSED.indexOf(status) !== -1) return null;

    // 1. Secured placement -> "My Practice".
    if (SECURED.indexOf(status) !== -1 || app.statusTone === 'secured' || app.id === 'placement-by-association') {
      return card('Practice secured', 'success', 'Secured', 'career#secured', ts);
    }
    // 2. Reviewable in-app offer -> offer page.
    if (app.offerPending === true) {
      return card('Offer ready 🎉', 'success', 'Offer', 'offer-review?applicationId=' + enc(app.id), ts);
    }
    if (status === 'finalising_placement') {
      return card('Offer accepted, finalising placement', 'success', 'Offer',
        'application-detail?id=' + enc(app.id) + '&role=' + enc(roleId), ts);
    }
    // 3. Interview stage -> application-detail (shows the inline confirm-time control).
    if (INTERVIEW.indexOf(status) !== -1) {
      return card('Interview offered, confirm your time', 'info', 'Interview',
        'application-detail?id=' + enc(app.id) + '&role=' + enc(roleId), ts);
    }
    // 4. Default (applied / submitted / reviewing / under_review) -> progress page.
    var title = (app.statusLabel && String(app.statusLabel).trim()) ? String(app.statusLabel).trim() : 'Application under review';
    return card(title, 'info', 'In review',
      'application-detail?id=' + enc(app.id) + '&role=' + enc(roleId), ts);
  };
});
