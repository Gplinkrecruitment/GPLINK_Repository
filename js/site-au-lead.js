/* ============================================================================
 * site-au-lead.js: the booking form's first question and its Australian branch.
 * (Australian GP build, WP-15. Read docs/au-gp/CONVENTIONS.md section 27.)
 *
 * What it does. A booking form that mounts this asks, before anything else,
 * "Are you currently registered with Ahpra?".
 *   Yes   a few taps follow (state, vocational registration, 19AB, right to
 *         work), the contact fields, and the Australian consent wording.
 *   No    the form is exactly the form it was before this file existed.
 *
 * Who loads it. A page asks GET /api/public/features first and loads this file
 * only when that says the Australian switch is on. With the switch off this
 * file is never requested and no wording in it reaches a screen.
 *
 * Reuse (WP-21, the Australian landing page). Give the page the same form
 * markup (ids below), load this file and call:
 *
 *   var ctl = window.GPAuLeadForm.mount({ form: formEl, preset: 'au' });
 *
 * `preset: 'au'` opens the form with the first question already answered
 * "Yes" (still visible, still changeable). On /start the same thing is done by
 * the address (?seg=au) or by data-lead-segment="au" on the #book section.
 *
 * The form markup it expects (all optional except the form itself):
 *   #cfPhone                 the phone input (a one-line hint is placed under it)
 *   label[for="cfCountry"]   the "where did you train" label (marked optional)
 *   .book-consent            the consent line (swapped for the Australian one)
 *
 * The controller it returns:
 *   ctl.answer()     'yes' | 'no' | ''   (the first question)
 *   ctl.isAu()       true when the answer is "yes"
 *   ctl.error()      '' or the sentence to show when a follow-up is unanswered
 *   ctl.extras()     the keys to add to the POST /api/public/consult-lead body,
 *                    or null when the first question is unanswered
 *   ctl.setAnswer(v) 'yes' | 'no'
 *
 * Wording rule. Nothing in this file (comments and names included) may use a
 * word from docs/au-gp/AGENT-RULES.md section 4: a test scans the whole file.
 * That is why the body key is `rightToWork` and the value is `temporary`.
 *
 * No framework, no dependencies. The pure parts load with require() in tests.
 * ========================================================================== */
(function (root) {
  'use strict';

  // The wording version recorded on the lead (lib/au-lead.js
  // LEAD_CONSENT_VERSIONS). The text is the DRAFT in
  // docs/au-gp/legal-draft/consent-wording.md A1: not yet legally reviewed.
  var CONSENT_VERSION = 'au_a1_draft_2026_11';
  var CONSENT_HTML = 'By continuing you agree that GP Link may contact you about your enquiry by email, WhatsApp and phone, '
    + 'and that we handle your details as set out in our <a href="/pages/privacy" target="_blank" rel="noopener">Privacy Policy</a>. '
    + 'Your enquiry is confidential: we never contact your current practice without asking you first. '
    + 'You can ask us to stop at any time.';
  var CONTACT_HINT = "Use a personal email and mobile, not your practice's.";

  var FIRST_QUESTION = 'Are you currently registered with Ahpra?';
  var YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

  var STATE_OUTSIDE = 'outside';
  var STATES = [
    { value: 'NSW', label: 'New South Wales' },
    { value: 'VIC', label: 'Victoria' },
    { value: 'QLD', label: 'Queensland' },
    { value: 'WA', label: 'Western Australia' },
    { value: 'SA', label: 'South Australia' },
    { value: 'TAS', label: 'Tasmania' },
    { value: 'ACT', label: 'Australian Capital Territory' },
    { value: 'NT', label: 'Northern Territory' },
    { value: STATE_OUTSIDE, label: "I'm outside Australia at the moment" }
  ];
  var VR = [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
    { value: 'registrar', label: "I'm a GP registrar" },
    { value: 'unsure', label: 'Not sure' }
  ];
  var MORATORIUM = [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
    { value: 'unsure', label: 'Not sure' }
  ];
  var RIGHT_TO_WORK = [
    { value: 'citizen_pr', label: 'Citizen or permanent resident' },
    { value: 'temporary', label: 'Temporary' },
    { value: 'unsure', label: 'Not sure' }
  ];

  // The follow-ups, in the order they are asked. `key` is the body key.
  var FOLLOW_UPS = [
    { key: 'state', kind: 'select', label: 'Which state or territory are you in?', options: STATES },
    { key: 'vrStatus', kind: 'choice', label: 'Are you a vocationally registered GP (FRACGP or FACRRM)?', options: VR },
    { key: 'restriction19ab', kind: 'choice', label: 'Does the 19AB moratorium apply to you?', options: MORATORIUM },
    { key: 'rightToWork', kind: 'choice', label: 'Your right to work in Australia', options: RIGHT_TO_WORK }
  ];
  var FOLLOW_UP_NOTE = '"Not sure" is a fine answer. We can work it out together on the call.';

  function has(list, value) {
    for (var i = 0; i < list.length; i++) { if (list[i].value === value) return true; }
    return false;
  }

  function emptyAnswers() {
    return { first: '', state: '', vrStatus: '', restriction19ab: '', rightToWork: '' };
  }

  // '' when every follow-up has an answer we offered; otherwise the sentence
  // to show. Nothing here turns anyone away: every option is acceptable.
  function validateAnswers(answers) {
    var a = answers || {};
    if (a.first !== 'yes' && a.first !== 'no') return 'Please tell us whether you are currently registered with Ahpra.';
    if (a.first === 'no') return '';
    for (var i = 0; i < FOLLOW_UPS.length; i++) {
      var q = FOLLOW_UPS[i];
      if (!has(q.options, a[q.key])) return 'Please answer: ' + q.label;
    }
    return '';
  }

  // The keys the server reads (lib/au-lead.js readLeadFormAnswers). Null until
  // the first question is answered.
  function payloadExtras(answers) {
    var a = answers || {};
    if (a.first === 'no') return { ahpraRegistered: false };
    if (a.first !== 'yes') return null;
    var out = { ahpraRegistered: true, consentVersion: CONSENT_VERSION };
    FOLLOW_UPS.forEach(function (q) { if (has(q.options, a[q.key])) out[q.key] = a[q.key]; });
    return out;
  }

  var CSS = ''
    + '.au-lead-q,.au-lead-follow{margin:0 0 18px;}'
    + '.au-lead-follow[hidden]{display:none;}'
    + '.au-lead-group{margin:0 0 16px;}'
    + '.au-lead-legend{display:block;margin:0 0 8px;font-size:14.5px;font-weight:700;line-height:1.4;color:var(--ink-2,#14324c);letter-spacing:0;text-transform:none;}'
    + '.au-lead-q .au-lead-legend{font-size:16px;}'
    + '.au-lead-opts{display:flex;flex-wrap:wrap;gap:8px;}'
    + '.au-lead-opt{flex:1 1 auto;min-height:44px;padding:10px 16px;font:inherit;font-size:14.5px;font-weight:650;color:var(--ink-2,#14324c);'
    + 'background:#fff;border:1.5px solid var(--line,#dce6ee);border-radius:12px;cursor:pointer;text-align:center;-webkit-tap-highlight-color:transparent;}'
    + '.au-lead-opt:hover{border-color:var(--teal,#0e8f8a);}'
    + '.au-lead-opt:focus-visible{outline:2px solid var(--teal,#0e8f8a);outline-offset:2px;}'
    + '.au-lead-opt[aria-checked="true"]{background:var(--teal,#0e8f8a);border-color:var(--teal,#0e8f8a);color:#fff;}'
    + '.au-lead-note,.au-lead-hint{margin:-4px 0 16px;font-size:12.5px;line-height:1.5;color:var(--mut-2,#6b8194);}'
    + '.au-lead-follow select{margin-bottom:0;}'
    + 'form.au-lead-pending > *:not(.au-lead-q){display:none !important;}';

  function ensureStyles(doc) {
    if (doc.getElementById('auLeadStyles')) return;
    var st = doc.createElement('style');
    st.id = 'auLeadStyles';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  var groupSeq = 0;
  function buildChoice(doc, q, onPick) {
    groupSeq += 1;
    var wrap = doc.createElement('div');
    wrap.className = 'au-lead-group';
    var legend = doc.createElement('span');
    legend.className = 'au-lead-legend';
    legend.id = 'auLeadLegend' + groupSeq;
    legend.textContent = q.label;
    var opts = doc.createElement('div');
    opts.className = 'au-lead-opts';
    opts.setAttribute('role', 'radiogroup');
    opts.setAttribute('aria-labelledby', legend.id);
    opts.setAttribute('data-au-lead-key', q.key);
    q.options.forEach(function (o) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'au-lead-opt';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('data-value', o.value);
      b.textContent = o.label;
      b.addEventListener('click', function () { onPick(q.key, o.value); });
      opts.appendChild(b);
    });
    wrap.appendChild(legend);
    wrap.appendChild(opts);
    return wrap;
  }

  function markChoice(container, key, value) {
    var group = container.querySelector('[data-au-lead-key="' + key + '"]');
    if (!group) return;
    Array.prototype.forEach.call(group.querySelectorAll('.au-lead-opt'), function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-value') === value ? 'true' : 'false');
    });
  }

  /**
   * opts: { form (required), preset: 'au' | '', onAnswer: function ('yes' | 'no') }
   */
  function mount(opts) {
    var o = opts || {};
    var form = o.form;
    if (!form || form.getAttribute('data-au-lead-mounted') === '1') return null;
    var doc = form.ownerDocument;
    form.setAttribute('data-au-lead-mounted', '1');
    ensureStyles(doc);

    var answers = emptyAnswers();

    // The first question.
    var first = doc.createElement('div');
    first.className = 'au-lead-q';
    var firstGroup = buildChoice(doc, { key: 'first', label: FIRST_QUESTION, options: YES_NO }, function (key, value) { setAnswer(value); });
    firstGroup.className = 'au-lead-group';
    first.appendChild(firstGroup);

    // The Australian follow-ups.
    var follow = doc.createElement('div');
    follow.className = 'au-lead-follow';
    follow.hidden = true;
    FOLLOW_UPS.forEach(function (q) {
      if (q.kind === 'select') {
        var wrap = doc.createElement('div');
        wrap.className = 'au-lead-group';
        var label = doc.createElement('label');
        label.className = 'au-lead-legend';
        label.setAttribute('for', 'auLeadState');
        label.textContent = q.label;
        var sel = doc.createElement('select');
        sel.id = 'auLeadState';
        var blank = doc.createElement('option');
        blank.value = ''; blank.textContent = 'Choose…';
        sel.appendChild(blank);
        q.options.forEach(function (st) {
          var op = doc.createElement('option');
          op.value = st.value; op.textContent = st.label;
          sel.appendChild(op);
        });
        sel.addEventListener('change', function () { answers[q.key] = sel.value; });
        wrap.appendChild(label);
        wrap.appendChild(sel);
        follow.appendChild(wrap);
      } else {
        follow.appendChild(buildChoice(doc, q, function (key, value) {
          answers[key] = value;
          markChoice(follow, key, value);
        }));
      }
    });
    var note = doc.createElement('p');
    note.className = 'au-lead-note';
    note.textContent = FOLLOW_UP_NOTE;
    follow.appendChild(note);

    form.insertBefore(follow, form.firstChild);
    form.insertBefore(first, follow);
    form.classList.add('au-lead-pending');

    // The pieces of the host form that read differently for this branch.
    var consentEl = form.querySelector('.book-consent');
    var consentOriginal = consentEl ? consentEl.innerHTML : '';
    var countryLabel = form.querySelector('label[for="cfCountry"]');
    var countryLabelOriginal = countryLabel ? countryLabel.textContent : '';
    var phoneEl = form.querySelector('#cfPhone');
    var hint = doc.createElement('p');
    hint.className = 'au-lead-hint';
    hint.textContent = CONTACT_HINT;

    function setAnswer(value) {
      if (value !== 'yes' && value !== 'no') return;
      answers.first = value;
      markChoice(first, 'first', value);
      form.classList.remove('au-lead-pending');
      var au = value === 'yes';
      follow.hidden = !au;
      form.classList.toggle('au-lead-yes', au);
      if (consentEl) consentEl.innerHTML = au ? CONSENT_HTML : consentOriginal;
      if (countryLabel) countryLabel.textContent = au ? countryLabelOriginal + ' (optional)' : countryLabelOriginal;
      if (phoneEl && phoneEl.parentNode) {
        if (au && !hint.parentNode) phoneEl.parentNode.insertBefore(hint, phoneEl.nextSibling);
        if (!au && hint.parentNode) hint.parentNode.removeChild(hint);
      }
      if (typeof o.onAnswer === 'function') { try { o.onAnswer(value); } catch (e) { /* the host's own concern */ } }
    }

    if (o.preset === 'au') setAnswer('yes');

    return {
      answer: function () { return answers.first; },
      isAu: function () { return answers.first === 'yes'; },
      error: function () { return validateAnswers(answers); },
      extras: function () { return payloadExtras(answers); },
      setAnswer: setAnswer
    };
  }

  /**
   * Swaps the wording around a form, and puts it back. Generic: the page says
   * what to change. swaps: [{ sel, text } | { sel, html } | { sel, hide: true }]
   * (every element matching `sel` is changed). on: true swaps, false restores.
   */
  function swapFraming(doc, swaps, on) {
    (Array.isArray(swaps) ? swaps : []).forEach(function (sw, i) {
      var nodes;
      try { nodes = doc.querySelectorAll(sw.sel); } catch (e) { nodes = []; }
      Array.prototype.forEach.call(nodes, function (el) {
        var key = 'auLeadWas' + i;
        if (on) {
          if (el.dataset[key] !== undefined) return;
          if (sw.hide) { el.dataset[key] = el.hidden ? '1' : '0'; el.hidden = true; return; }
          el.dataset[key] = el.innerHTML;
          if (typeof sw.html === 'string') el.innerHTML = sw.html; else el.textContent = String(sw.text == null ? '' : sw.text);
        } else {
          if (el.dataset[key] === undefined) return;
          if (sw.hide) el.hidden = el.dataset[key] === '1'; else el.innerHTML = el.dataset[key];
          delete el.dataset[key];
        }
      });
    });
  }

  var api = {
    VERSION: '20261121a',
    CONSENT_VERSION: CONSENT_VERSION,
    CONSENT_HTML: CONSENT_HTML,
    CONTACT_HINT: CONTACT_HINT,
    FIRST_QUESTION: FIRST_QUESTION,
    STATES: STATES,
    VR: VR,
    MORATORIUM: MORATORIUM,
    RIGHT_TO_WORK: RIGHT_TO_WORK,
    FOLLOW_UPS: FOLLOW_UPS,
    FOLLOW_UP_NOTE: FOLLOW_UP_NOTE,
    emptyAnswers: emptyAnswers,
    validateAnswers: validateAnswers,
    payloadExtras: payloadExtras,
    mount: mount,
    swapFraming: swapFraming
  };

  root.GPAuLeadForm = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
