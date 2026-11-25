/* Australian GP build (WP-12, APP-26, walk-findings D5 and D15): the part of
 * Account, Personal that a doctor on an Australian pathway sees instead of
 * the card about moving country: what is on file about their registration, where they
 * are now, when they can start, and the provider numbers they already hold.
 *
 *   GPAccountAu.mount(el)   draws it from GET /api/account/au-details and
 *                           saves through POST /api/account/au-details
 *
 * The server checks every value and never takes a pathway from the browser.
 * The Ahpra number is read-only once our team has checked it on the register.
 * pages/account.html loads this file only for a doctor on an Australian
 * pathway. Every word here is checked by tests/au-wp12-banned-words.test.js.
 */
(function (root) {
  'use strict';

  var API = '/api/account/au-details';

  var REGISTRATION_LABELS = {
    general: 'General',
    specialist: 'Specialist (general practice)',
    general_and_specialist: 'General and specialist (general practice)',
    provisional: 'Provisional',
    limited: 'Limited',
    non_practising: 'Non-practising'
  };
  var FELLOWSHIP_LABELS = {
    fracgp: 'FRACGP',
    facrrm: 'FACRRM',
    both: 'Both FRACGP and FACRRM',
    other: 'Another fellowship',
    none: 'No fellowship'
  };
  var WORK_RIGHTS_LABELS = {
    citizen: 'Australian citizen',
    pr: 'Permanent resident',
    temporary: 'Temporary resident'
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isView(v) {
    return !!v && typeof v === 'object' && v.ok === true && v.options && typeof v.options === 'object';
  }

  function selectHtml(id, values, labels, current, placeholder) {
    var list = Array.isArray(values) ? values : [];
    return '<select id="' + id + '" data-au-field="' + id + '">'
      + '<option value="">' + esc(placeholder || 'Select') + '</option>'
      + list.map(function (v) {
        return '<option value="' + esc(v) + '"' + (String(current) === String(v) ? ' selected' : '') + '>' + esc((labels && labels[v]) || v) + '</option>';
      }).join('') + '</select>';
  }

  function existingRow(row) {
    var r = row || {};
    return '<div class="au-acc-row" data-au-existing-row>'
      + '<div class="field"><label>Provider number</label><input type="text" autocomplete="off" autocapitalize="characters" maxlength="20" placeholder="123456AB" data-au-existing="number" value="' + esc(r.number) + '"></div>'
      + '<div class="field"><label>Location it is for</label><input type="text" autocomplete="off" maxlength="160" placeholder="Practice or suburb" data-au-existing="location" value="' + esc(r.location) + '"></div>'
      + '</div>';
  }

  function sectionHead(title, subtitle) {
    return '<div class="section-header"><div class="section-header-left"><h3 class="section-title">' + esc(title) + '</h3>'
      + '<p class="section-subtitle">' + esc(subtitle) + '</p></div></div>';
  }

  /** The whole Australian block of the Personal tab, as HTML. Pure. */
  function viewHtml(view) {
    if (!isView(view)) {
      return '<section class="section-card"><p class="input-note">We could not load your details just now. Please refresh the page.</p></section>';
    }
    var o = view.options;
    var existing = Array.isArray(view.existingProviderNumbers) ? view.existingProviderNumbers : [];
    var rows = existing.length ? existing.map(existingRow).join('') : existingRow(null);
    var chosen = Array.isArray(view.preferredLocations) ? view.preferredLocations : [];
    var locations = (Array.isArray(o.locations) ? o.locations : []).map(function (name) {
      return '<label class="au-acc-check"><input type="checkbox" data-au-location value="' + esc(name) + '"' + (chosen.indexOf(name) !== -1 ? ' checked' : '') + '><span>' + esc(name) + '</span></label>';
    }).join('');
    var out = [];

    out.push('<section class="section-card" data-au-section="registration">'
      + sectionHead('Your registration', view.registrationLocked
        ? 'Checked by our team on the public Ahpra register. If something has changed, choose the new value and save: we will confirm it on the register before your profile changes.'
        : 'What we have on file. Tell us if anything has changed.')
      + '<div class="fields">'
      + '<div class="field full"><label for="auAhpraNumber">Ahpra registration number</label>'
      + (view.ahpraNumberLocked
        ? '<div class="readonly-wrap"><input id="auAhpraNumber" type="text" readonly value="' + esc(view.ahpraNumber) + '"></div>'
          + '<p class="input-note">Checked by our team on the public Ahpra register. Message us if it is wrong.</p>'
        : '<input id="auAhpraNumber" data-au-field="auAhpraNumber" type="text" autocomplete="off" autocapitalize="characters" maxlength="13" placeholder="MED0001234567" value="' + esc(view.ahpraNumber) + '">'
          + '<p class="input-note">Three letters followed by 10 digits, as it appears on the Ahpra register.</p>')
      + '</div>'
      + '<div class="field"><label for="auRegistrationType">Registration type</label>' + selectHtml('auRegistrationType', o.registrationTypes, REGISTRATION_LABELS, view.registrationType) + '</div>'
      + '<div class="field"><label for="auFellowshipType">Fellowship</label>' + selectHtml('auFellowshipType', o.fellowshipTypes, FELLOWSHIP_LABELS, view.fellowshipType) + '</div>'
      + '<div class="field full"><label for="auFellowshipDetail">Fellowship details (optional)</label><input id="auFellowshipDetail" data-au-field="auFellowshipDetail" type="text" maxlength="200" value="' + esc(view.fellowshipDetail) + '"></div>'
      + '<div class="field full"><label for="auWorkRights">Right to work in Australia</label>' + selectHtml('auWorkRights', o.workRights, WORK_RIGHTS_LABELS, view.workRights) + '</div>'
      + '</div></section>');

    out.push('<section class="section-card" data-au-section="location">'
      + sectionHead('Where you are now and when you can start', 'Your current location, your notice period and where you would like to work.')
      + '<div class="fields">'
      + '<div class="field"><label for="auCurrentState">State or territory</label>' + selectHtml('auCurrentState', o.states, null, view.currentState) + '</div>'
      + '<div class="field"><label for="auCurrentSuburb">Suburb</label><input id="auCurrentSuburb" data-au-field="auCurrentSuburb" type="text" maxlength="120" autocomplete="address-level2" value="' + esc(view.currentSuburb) + '"></div>'
      + '<div class="field"><label for="auCurrentPostcode">Postcode</label><input id="auCurrentPostcode" data-au-field="auCurrentPostcode" type="text" inputmode="numeric" maxlength="4" autocomplete="postal-code" value="' + esc(view.currentPostcode) + '"></div>'
      + '<div class="field"><label for="auNoticeWeeks">Notice period (weeks)</label><input id="auNoticeWeeks" data-au-field="auNoticeWeeks" type="number" inputmode="numeric" min="0" max="104" step="1" value="' + (view.noticePeriodWeeks === null || view.noticePeriodWeeks === undefined ? '' : esc(view.noticePeriodWeeks)) + '"></div>'
      + '<div class="field"><label for="auAvailableFrom">Available from</label><input id="auAvailableFrom" data-au-field="auAvailableFrom" type="date" value="' + esc(view.availableFrom) + '"></div>'
      // WP-29: where they are based and how far they would go (the same
      // picker the sign-up screen uses). The older three fields above and the
      // list below are hidden when it is available: it fills them in.
      + '<div class="field full" id="auAccLocationPickerWrap" hidden><div id="auAccLocationPicker"></div>'
      + (view.locationChoice && view.locationChoice.fromEarlierAnswers ? '<p class="hint" id="auAccLocationEarlier">This is from what you told us when you signed up. Check it and save.</p>' : '')
      + '<p class="hint au-acc-error" id="auAccLocationError" role="alert" hidden></p></div>'
      + '<div class="field full" data-au-legacy-location><label>Preferred locations</label>'
      + '<p class="input-note">' + (chosen.length ? 'On file: ' + esc(chosen.join(', ')) + '.' : 'None chosen yet.') + '</p>'
      + '<details class="au-acc-details"><summary>Change preferred locations</summary><div class="au-acc-checks">' + locations + '</div></details></div>'
      + '</div></section>');

    out.push('<section class="section-card" data-au-section="numbers">'
      + sectionHead('Provider numbers you already hold', 'So we have them on file when you start somewhere new.')
      + '<div data-au-existing-list>' + rows + '</div>'
      + '<div class="au-acc-actions"><button type="button" class="btn" data-au-add-row>Add another provider number</button></div>'
      + '<div class="fields"><div class="field"><label for="auPrescriber">Prescriber number (if you have one)</label><input id="auPrescriber" data-au-field="auPrescriber" type="text" inputmode="numeric" maxlength="20" autocomplete="off" value="' + esc(view.prescriberNumber) + '"></div></div>'
      + '</section>');

    out.push('<div class="bottom-actions"><p class="save-state" id="auSaveState" role="status"></p>'
      + '<button class="btn primary" type="button" data-au-save>Save these details</button></div>');
    return out.join('');
  }

  // What the form holds, in the shape the server takes.
  // WP-29: `picked` is the location picker's value when the picker is on the
  // page ({ base, travel, places }), or nothing. A complete choice is sent as
  // ids only and replaces the three typed fields and the old list (the server
  // fills those in from it).
  function locationChoiceComplete(v) {
    return !!(v && v.base && v.base.id && v.travel && (v.travel !== 'places' || (v.places && v.places.length)));
  }
  function readForm(el, view, picked) {
    function val(id) { var n = el.querySelector('#' + id); return n ? String(n.value == null ? '' : n.value).trim() : ''; }
    var body = {};
    if (!view.ahpraNumberLocked) body.ahpraNumber = val('auAhpraNumber');
    if (val('auRegistrationType')) body.registrationType = val('auRegistrationType');
    if (val('auFellowshipType')) body.fellowshipType = val('auFellowshipType');
    body.fellowshipDetail = val('auFellowshipDetail');
    if (val('auWorkRights')) body.workRights = val('auWorkRights');
    if (val('auCurrentState')) body.currentState = val('auCurrentState');
    body.currentSuburb = val('auCurrentSuburb');
    body.currentPostcode = val('auCurrentPostcode');
    body.noticePeriodWeeks = val('auNoticeWeeks') === '' ? null : Number(val('auNoticeWeeks'));
    body.availableFrom = val('auAvailableFrom');
    var locations = [];
    Array.prototype.forEach.call(el.querySelectorAll('[data-au-location]'), function (box) { if (box.checked) locations.push(box.value); });
    if (locations.length) body.preferredLocations = locations;
    var numbers = [];
    Array.prototype.forEach.call(el.querySelectorAll('[data-au-existing-row]'), function (row) {
      var number = row.querySelector('[data-au-existing="number"]');
      var location = row.querySelector('[data-au-existing="location"]');
      var value = number ? String(number.value || '').trim() : '';
      if (value) numbers.push({ number: value, location: location ? String(location.value || '').trim() : '' });
    });
    body.existingProviderNumbers = numbers;
    body.prescriberNumber = val('auPrescriber');
    if (picked) {
      delete body.currentState; delete body.currentSuburb; delete body.currentPostcode; delete body.preferredLocations;
      if (locationChoiceComplete(picked)) {
        body.locationChoice = { base: picked.base.id, travel: picked.travel, places: (picked.places || []).map(function (p) { return p.id; }) };
      }
    }
    return body;
  }

  function mount(el, options) {
    var opts = options || {};
    var fetcher = opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
    var state = { view: null, busy: false, picker: null, pickerTouched: false };

    function say(text, tone) {
      var node = el.querySelector('#auSaveState');
      if (!node) return;
      node.textContent = text || '';
      node.style.color = tone === 'bad' ? 'var(--gp-red-ink, #b91c1c)' : (tone === 'good' ? 'var(--gp-green-ink, #166534)' : '');
    }

    function draw() {
      el.innerHTML = viewHtml(state.view);
      el.hidden = false;
      // WP-29: the location picker, when its script is on the page. Without
      // it the three typed fields and the old list stay exactly as they were.
      state.picker = null;
      state.pickerTouched = false;
      var host = el.querySelector('#auAccLocationPicker');
      var wrap = el.querySelector('#auAccLocationPickerWrap');
      if (host && wrap && root.GPAuLocationPicker && state.view && state.view.locationChoice) {
        state.picker = root.GPAuLocationPicker.mount(host, {
          idPrefix: 'auAccLoc',
          value: state.view.locationChoice,
          onChange: function () { state.pickerTouched = true; var e = el.querySelector('#auAccLocationError'); if (e) e.hidden = true; }
        });
        wrap.hidden = false;
        ['auCurrentState', 'auCurrentSuburb', 'auCurrentPostcode'].forEach(function (id) {
          var n = el.querySelector('#' + id);
          var field = n && n.closest ? n.closest('.field') : null;
          if (field) field.hidden = true;
        });
        var legacy = el.querySelector('[data-au-legacy-location]');
        if (legacy) legacy.hidden = true;
      }
    }

    function load() {
      if (!fetcher) return Promise.resolve(false);
      return fetcher(API, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(function (res) { return res && res.ok ? res.json() : null; })
        .then(function (data) {
          if (!isView(data)) { if (typeof opts.onNotAvailable === 'function') opts.onNotAvailable(); return false; }
          state.view = data;
          draw();
          return true;
        })
        .catch(function () { return false; });
    }

    function save() {
      if (state.busy || !state.view || !fetcher) return;
      var picked = state.picker ? state.picker.getValue() : null;
      // WP-29: a choice the doctor started changing must be finished (a base
      // and how far), or it is not saved: say so rather than drop it quietly.
      if (picked && state.pickerTouched && !locationChoiceComplete(picked)) {
        state.picker.showErrors({ base: !(picked.base && picked.base.id), travel: !picked.travel, places: picked.travel === 'places' && !(picked.places && picked.places.length) });
        say('Please finish choosing where you are based and how far you would go.', 'bad');
        return;
      }
      state.busy = true;
      say('Saving…', '');
      fetcher(API, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(readForm(el, state.view, picked))
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          state.busy = false;
          if (!res.ok || !data || data.ok !== true) { say((data && data.message) || 'We could not save that. Please try again.', 'bad'); return; }
          if (data.impersonated === true) { say('Preview only: nothing was saved.', ''); return; }
          var changed = data.registrationChanged === true;
          var requested = data.changeRequested === true;
          if (isView(data)) { state.view = data; draw(); }
          say(requested
            ? 'Saved. Your registration change has gone to our team. Your profile keeps the checked details until we have confirmed it on the register.'
            : (changed ? 'Saved. Our team will check your registration details again.' : 'Saved.'), 'good');
        });
      }).catch(function () {
        state.busy = false;
        say('We could not save that. Check your connection and try again.', 'bad');
      });
    }

    el.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-au-save]')) { save(); return; }
      if (target.closest('[data-au-add-row]')) {
        var list = el.querySelector('[data-au-existing-list]');
        if (list && list.querySelectorAll('[data-au-existing-row]').length < 8) {
          var holder = document.createElement('div');
          holder.innerHTML = existingRow(null);
          list.appendChild(holder.firstChild);
        }
      }
    });

    return { load: load, save: save, state: state };
  }

  var api = {
    mount: mount,
    // Exposed for tests: pure rendering and wording.
    _viewHtml: viewHtml,
    _readForm: readForm,
    REGISTRATION_LABELS: REGISTRATION_LABELS,
    FELLOWSHIP_LABELS: FELLOWSHIP_LABELS,
    WORK_RIGHTS_LABELS: WORK_RIGHTS_LABELS
  };

  root.GPAccountAu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
