/* Australian GP build (WP-12): the last line of defence on the screens a
 * doctor on an Australian pathway shares with everyone else (Careers, the job
 * page, an application, the offer and signing screens, Account, Support).
 *
 * Those pages were written for a doctor moving country. Where a screen has an
 * Australian version it is built properly (Home, the pre-start page, the
 * provider-number step, the hold card, the support articles). Everywhere
 * else this file makes sure of two things for such a doctor, on whatever the
 * page draws, now or later:
 *
 *   1. A phrase from the other journey that has a plain Australian
 *      equivalent is replaced by it (PHRASES below): the job title of the
 *      person looking after them (walk-findings D19), "about your move",
 *      "Relocation package", "Start my registration" and so on.
 *   2. Any sentence that still carries a word from AGENT-RULES section 4 is
 *      taken out before it is painted (the same rule as lib/au-doctor-text.js
 *      on the server).
 *
 * It is loaded ONLY behind the guard that loads js/au-doctor.js (the device
 * already knows the doctor is on an Australian pathway). Nobody else requests
 * it or runs it. When the device believes so but the session has not answered
 * yet, the page is held back (not painted) until it has; a session that says
 * "not an Australian doctor" shows the page exactly as it is, untouched.
 *
 * What it never touches: anything a person typed (inputs, text areas,
 * editable regions) and any region marked `data-au-raw` (conversations with
 * the team, a contract being read, a practice's own uploaded documents).
 *
 * This file names the phrases it looks FOR, so unlike the other Australian
 * files it is not scanned whole for those words: tests/au-wp12-banned-words
 * checks that what it PRODUCES is clean.
 *
 *   /js/au-localise.js?v=20261121a
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GPAuLocalise = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  // The words (AGENT-RULES section 4). The browser's copy of
  // lib/au-doctor-text.js BANNED_WORDS; tests keep the two in step.
  var BANNED = [
    ['MyIntealth', /my\s?int(e)?alth/i],
    ['AMC', /\bAMC\b/i],
    ['EPIC', /\bEPIC\b/i],
    ['visa', /\bvisas?\b/i],
    ['relocate / relocation', /\brelocat(e|es|ed|ing|ion|ions)\b/i],
    ['your move', /\byour\s+move\b/i],
    ['overseas', /\boverseas\b/i],
    ['internationally trained', /\binternationally[\s-]+trained\b/i],
    ['GMC', /\bGMC\b/i],
    ['SPPA', /\bSPPA\b/i],
    ['Section G', /\bsection\s+G\b/i],
    ['supervisor CV', /\bsupervisor\s+CV\b/i],
    ['Not yet eligible', /\bnot\s+yet\s+eligible\b/i]
  ];

  function violations(text) {
    var s = String(text == null ? '' : text);
    if (!s) return [];
    var out = [];
    for (var i = 0; i < BANNED.length; i++) if (BANNED[i][1].test(s)) out.push(BANNED[i][0]);
    return out;
  }
  function isClean(text) { return violations(text).length === 0; }

  // Phrases with a plain Australian equivalent. `team` is replaced with the
  // neutral name for the people at GP Link (js/au-doctor.js teamLabel): a
  // consultant before placement, the team after it. Order matters: the long
  // phrases first.
  var PHRASES = [
    [/Talk to our team about your move\s*(?:—|–|-)\s*any time\./g, 'Questions about a role? Talk to {team} any time.'],
    [/your Registration (?:Support|Guidance) Officer/g, '{team}'],
    [/Your Registration (?:Support|Guidance) Officer/g, '{Team}'],
    [/YOUR REGISTRATION (?:SUPPORT|GUIDANCE) OFFICER/g, '{TEAM}'],
    [/a Registration (?:Support|Guidance) Officer/g, 'someone from GP Link'],
    [/Registration (?:Support|Guidance) Officer/g, 'GP Link consultant'],
    [/Your GP Link officer will guide you through the remaining registration steps\./g, 'Your GP Link team will guide you through a short pre-start checklist before your first day.'],
    [/remaining registration steps/g, 'short pre-start checklist'],
    [/Contract & registration/g, 'Contract & pre-start'],
    [/and keeps your registration steps moving/g, 'and your short pre-start checklist opens'],
    [/Your registration steps are now unlocked\./g, 'Your pre-start checklist is ready.'],
    [/Continue your specialist registration steps/g, 'Continue your pre-start checklist'],
    [/Start my registration/g, 'Open my pre-start checklist'],
    [/Your secured role and relocation progress/g, 'Your secured role and pre-start progress'],
    [/next relocation steps/g, 'next pre-start steps'],
    [/your profile and relocation goals/g, 'your profile and preferences'],
    [/before you relocate/g, 'before you start'],
    [/Relocation status/g, 'Pre-start status'],
    [/Relocation handover/g, 'Pre-start'],
    [/Relocation Explorer/g, 'Explore the area'],
    [/Live relocation search/g, 'Live housing search'],
    [/Relocation [Pp]ackage/g, 'Moving allowance'],
    [/Relocation [Ss]upport/g, 'Moving support'],
    [/relocation support/g, 'moving support'],
    [/Relocation Details/g, 'Where you are now'],
    [/AHPRA\/visa submissions/g, 'registration records'],
    [/e\.g\. \+44 7700 900123/g, 'e.g. +61 412 345 678'],
    [/Curated for your move/g, 'Curated for you'],
    [/Chat to your officer via WhatsApp/g, 'Chat to us on WhatsApp'],
    [/your GP Link officer/g, '{team}'],
    [/Your GP Link officer/g, '{Team}'],
    [/about your move/g, 'about your next role']
  ];

  function teamWords(placed) {
    var helper = root && root.GPAuDoctor;
    var lower = helper && typeof helper.teamLabel === 'function' ? helper.teamLabel(placed) : (placed ? 'your GP Link team' : 'your GP Link consultant');
    return { lower: lower, upper: lower.charAt(0).toUpperCase() + lower.slice(1), caps: lower.toUpperCase() };
  }

  /** One string, with the phrase map applied. Unchanged when nothing matches. */
  function localiseText(text, placed) {
    var s = String(text == null ? '' : text);
    if (!s) return s;
    var team = null;
    for (var i = 0; i < PHRASES.length; i++) {
      var re = PHRASES[i][0];
      re.lastIndex = 0;
      if (!re.test(s)) continue;
      re.lastIndex = 0;
      if (!team) team = teamWords(placed);
      s = s.replace(re, PHRASES[i][1].replace('{team}', team.lower).replace('{Team}', team.upper).replace('{TEAM}', team.caps));
    }
    return s;
  }

  /** Remove every sentence (or line, or bullet) that still carries a banned word. */
  function scrubText(text) {
    var s = String(text == null ? '' : text);
    if (!s || isClean(s)) return s;
    var lead = (s.match(/^\s*/) || [''])[0];
    var tail = (s.match(/\s*$/) || [''])[0];
    var parts = s.match(/[^.!?;\n•·|]+[.!?;\n•·|]*\s*/g) || [s];
    var kept = parts.filter(isClean).join('').replace(/\s+$/, '');
    if (!kept.trim()) return '';
    return (/^\s/.test(kept) ? '' : lead) + kept + tail;
  }

  /** What a doctor on an Australian pathway is shown for one string. */
  function safeText(text, placed) {
    return scrubText(localiseText(text, placed));
  }

  // ── browser-only below ─────────────────────────────────────────────────────
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, TEMPLATE: 1 };
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  var active = false;
  var placedNow = false;
  var observer = null;

  function skipped(node) {
    var el = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS[el.tagName]) return true;
      if (el.isContentEditable === true) return true;
      if (el.hasAttribute && el.hasAttribute('data-au-raw')) return true;
      el = el.parentNode;
    }
    return false;
  }

  function fixTextNode(node) {
    var before = node.nodeValue;
    if (!before || before.length < 3) return;
    var after = safeText(before, placedNow);
    if (after !== before) node.nodeValue = after;
  }

  function fixElementAttrs(el) {
    if (!el.getAttribute) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (!v) continue;
      var next = safeText(v, placedNow);
      if (next !== v) el.setAttribute(ATTRS[i], next);
    }
    // A button drawn as an <input>.
    if (el.tagName === 'INPUT' && /^(button|submit)$/i.test(el.type || '')) {
      var label = el.value;
      var fixed = safeText(label, placedNow);
      if (fixed !== label) el.value = fixed;
    }
  }

  function walk(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { if (!skipped(rootNode)) fixTextNode(rootNode); return; }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1) {
      if (skipped(rootNode)) return;
      fixElementAttrs(rootNode);
    }
    var doc = rootNode.ownerDocument || rootNode;
    var walker = doc.createTreeWalker(rootNode, 5 /* elements + text */, null, false);
    var node = walker.nextNode();
    var pending = [];
    while (node) {
      pending.push(node);
      node = walker.nextNode();
    }
    for (var i = 0; i < pending.length; i++) {
      var n = pending[i];
      if (skipped(n)) continue;
      if (n.nodeType === 3) fixTextNode(n);
      else fixElementAttrs(n);
    }
    if (rootNode.nodeType === 9 || rootNode === doc.documentElement) {
      var t = doc.title;
      var nt = safeText(t, placedNow);
      if (nt !== t) doc.title = nt;
    }
  }

  function begin(placed) {
    if (!root || !root.document) return;
    placedNow = placed === true;
    var doc = root.document;
    if (active) { walk(doc.documentElement); return; }
    active = true;
    try { doc.documentElement.classList.add('gp-au-doctor'); } catch (e) { /* ignore */ }
    walk(doc.documentElement);
    if (typeof root.MutationObserver !== 'function') return;
    observer = new root.MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'characterData') {
          if (!skipped(r.target)) fixTextNode(r.target);
        } else if (r.type === 'attributes') {
          if (!skipped(r.target)) fixElementAttrs(r.target);
        } else {
          for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
        }
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  // Hold the page back (not painted) while "is this an Australian doctor?" is
  // still being asked.
  var WAIT_CLASS = 'gp-au-wait';
  function hold() {
    try {
      var doc = root.document;
      doc.documentElement.classList.add(WAIT_CLASS);
      if (!doc.getElementById('gp-au-wait-style')) {
        var st = doc.createElement('style');
        st.id = 'gp-au-wait-style';
        st.textContent = 'html.' + WAIT_CLASS + ' body{visibility:hidden}';
        (doc.head || doc.documentElement).appendChild(st);
      }
    } catch (e) { /* ignore */ }
  }
  function release() {
    try { root.document.documentElement.classList.remove(WAIT_CLASS); } catch (e) { /* ignore */ }
  }

  /**
   * Called once when this file loads in a page. `options.shell`: the app
   * shell itself (never held back: it only draws the menu).
   */
  function start(options) {
    var o = options || {};
    var helper = root && root.GPAuDoctor;
    if (!root || !root.document || !helper) return;
    var info = null;
    try { info = helper.cached(); } catch (e) { info = null; }
    if (info) { begin(helper.isPlaced(info)); watchPlacement(helper); return; }
    var candidate = false;
    try { candidate = helper.isCandidate(); } catch (e) { candidate = false; }
    if (!candidate) return;
    var decided = false;
    if (!o.shell) hold();
    var settle = function (known) {
      if (decided) return;
      decided = true;
      if (known) { begin(helper.isPlaced(known)); watchPlacement(helper); }
      release();
    };
    // No answer in six seconds: this device last belonged to an Australian
    // doctor, so the careful choice is their wording.
    var timer = root.setTimeout(function () {
      if (decided) return;
      decided = true;
      begin(false);
      release();
    }, 6000);
    helper.whenKnown().then(function (known) { root.clearTimeout(timer); settle(known); }, function () { root.clearTimeout(timer); settle(null); });
  }

  // "Your consultant" becomes "your team" once a placement is recorded.
  function watchPlacement(helper) {
    try {
      root.addEventListener('gp-au-doctor-known', function () {
        var info = helper.cached();
        if (info && helper.isPlaced(info) !== placedNow) begin(helper.isPlaced(info));
      });
    } catch (e) { /* ignore */ }
  }

  var api = {
    BANNED: BANNED,
    PHRASES: PHRASES,
    violations: violations,
    localiseText: localiseText,
    scrubText: scrubText,
    safeText: safeText,
    start: start,
    begin: begin,
    isActive: function () { return active; }
  };

  // Start by itself in a browser. The app shell says so first
  // (window.__gpAuShell) so that it is never held back.
  if (root && root.document && !root.__gpAuLocaliseManual) {
    try { start({ shell: root.__gpAuShell === true }); } catch (e) { /* the page still works */ }
  }

  return api;
});
