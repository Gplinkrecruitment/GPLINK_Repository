// Pure helper for the careers page "where am I" strip (owner brief 2026-09-03:
// the doctor should never have to think about what to do next).
//
// Given the page's normalised applications (pages/career.html
// normalizeCareerApplication output — rawStatus/status, offerPending,
// contractStage, interview, isPlacementSecured, practiceName, id, roleId) it
// returns which of the four pre-registration steps the doctor is on and the one
// line of "what to do now" copy, plus an optional deep link.
//
//   1 Find your practice → 2 Interview → 3 Offer & contract → 4 Registration
//
// UMD: window.deriveCareerStep in the browser, module.exports under vitest.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gpCareerStepStrip = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var STEPS = Object.freeze([
    { num: 1, label: 'Find your practice' },
    { num: 2, label: 'Interview' },
    { num: 3, label: 'Offer & contract' },
    { num: 4, label: 'Registration' }
  ]);

  var SECURED = ['hired', 'secured', 'placed', 'placement_secured', 'practice_secured', 'offer_accepted', 'contract_signed'];
  var CLOSED = ['withdrawn', 'not_proceeding', 'rejected', 'offer_declined', 'declined', 'unsuccessful'];
  var OFFER = ['offer', 'offer_pending', 'offered', 'finalising_placement'];
  var INTERVIEW = ['interview', 'interview_scheduled', 'interview_confirmed', 'shortlisted', 'interview_completed'];
  var LIVE_CONTRACT = ['sent_to_gp', 'changes_requested', 'practice_review'];

  function norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function detailHref(app) {
    return 'application-detail?id=' + enc(app.id) + (app.roleId ? '&role=' + enc(app.roleId) : '');
  }
  function practiceLabel(app) {
    var n = String(app.practiceName || '').trim();
    if (!n || /^practice$/i.test(n) || /^confidential/i.test(n)) return 'the practice';
    return n;
  }
  function fmtDate(iso) {
    try {
      var dt = new Date(iso);
      if (isNaN(dt.getTime())) return '';
      return dt.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    } catch (e) { return ''; }
  }
  function result(step, key, hint, href, ctaLabel) {
    return { step: step, total: STEPS.length, label: STEPS[step - 1].label, steps: STEPS, key: key, hint: hint, href: href || '', ctaLabel: ctaLabel || '' };
  }

  function deriveCareerStep(applications) {
    var apps = Array.isArray(applications) ? applications : [];
    var live = [];
    for (var i = 0; i < apps.length; i++) {
      var a = apps[i];
      if (!a || typeof a !== 'object') continue;
      var k = norm(a.rawStatus || a.status);
      if (CLOSED.indexOf(k) !== -1) continue;
      live.push({ app: a, key: k });
    }

    // 4 — secured (the shell hides this strip once the nav expands, but the
    // page can still render it during the hand-off).
    for (var s = 0; s < live.length; s++) {
      if (live[s].app.isPlacementSecured === true || SECURED.indexOf(live[s].key) !== -1) {
        return result(4, 'secured', 'Your position is secured. Your registration steps are now unlocked.', 'index', 'Start my registration');
      }
    }
    // 3 — offer / contract
    for (var o = 0; o < live.length; o++) {
      var oa = live[o].app, ok = live[o].key;
      if (oa.offerPending === true) return result(3, 'offer_pending', 'The practice has made you an offer. Review it when you are ready.', 'offer-review?applicationId=' + enc(oa.id), 'Review my offer');
      var cs = norm(oa.contractStage);
      if (cs === 'sent_to_gp') return result(3, 'contract_sign', 'Your contract is ready. Read it and sign it in the app to secure your position.', detailHref(oa), 'Sign my contract');
      if (cs === 'changes_requested' || cs === 'practice_review') return result(3, 'contract_review', 'The practice is reviewing your contract changes. We will message you when it is back.', detailHref(oa));
      if (ok === 'finalising_placement') return result(3, 'finalising', 'You accepted the offer. We are finalising your placement with the practice.', detailHref(oa));
      if (OFFER.indexOf(ok) !== -1 || LIVE_CONTRACT.indexOf(cs) !== -1) return result(3, 'offer', 'An offer is on its way through the app. We will message you the moment it lands.', detailHref(oa));
    }
    // 2 — interview
    for (var v = 0; v < live.length; v++) {
      var va = live[v].app, vk = live[v].key;
      var iv = va.interview && typeof va.interview === 'object' ? va.interview : null;
      var ivStatus = iv ? norm(iv.status) : '';
      if (vk === 'interview_completed' || ivStatus === 'completed' || ivStatus === 'done') {
        return result(2, 'interview_done', 'Your interview is done. We are waiting for ' + practiceLabel(va) + ' to decide.', detailHref(va));
      }
      if (iv && iv.scheduledAt) {
        var when = fmtDate(iv.scheduledAt);
        return result(2, 'interview_booked', 'Your interview is booked' + (when ? ' for ' + when : '') + '. We will send the video link before it starts.', detailHref(va), 'See my interview');
      }
      if (INTERVIEW.indexOf(vk) !== -1 || iv) {
        return result(2, 'interview_pick', practiceLabel(va).replace(/^the practice$/, 'The practice') + ' wants to meet you. Choose an interview time that suits you.', detailHref(va), 'Choose a time');
      }
    }
    // 1 — applied and waiting
    if (live.length) {
      var la = live[0].app;
      return result(1, 'applied', 'Your application is with ' + practiceLabel(la) + '. We will message you when they reply. You can keep browsing meanwhile.', detailHref(la), 'See my application');
    }
    // 1 — nothing yet
    return result(1, 'browse', 'Browse the practices matched to you, then apply or send an enquiry.');
  }

  return { STEPS: STEPS, deriveCareerStep: deriveCareerStep };
});
