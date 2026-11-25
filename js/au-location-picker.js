/**
 * GP Link (Australian GP build, WP-29): "Where are you based?" and "How far
 * would you go for the right practice?", as one small component used by the
 * Australian onboarding screen and by Account.
 *
 *   <script src="/js/au-location-picker.js?v=20261126a"></script>
 *   var picker = window.GPAuLocationPicker.mount(hostElement, {
 *     value: { base: { id, label } | null, travel: "" | "commute" | "state" | "places" | "anywhere", places: [{ id, label }] },
 *     onChange: function (value) { ... },      // every change, with a fresh copy
 *     idPrefix: "auLoc"                         // so two pickers can share a page
 *   });
 *   picker.getValue(); picker.setValue(v); picker.showErrors({ base, travel, places }); picker.clearErrors();
 *
 * The search asks the server (GET /api/au/localities?q=), which answers from a
 * built-in list of Australian suburbs and towns. Nothing here talks to any
 * outside service. Only a place picked FROM THE LIST counts: typed text that
 * was not picked is not an answer.
 *
 * Keyboard and screen reader: each search box is a labelled combobox with a
 * listbox of options (arrow keys, Enter to choose, Escape to close), and what
 * the list is doing is announced in a polite live region.
 */
(function (root) {
  "use strict";

  var TRAVEL_OPTIONS = [
    { value: "commute", label: "Within a commute of where I am now (about 45 minutes)" },
    { value: "state", label: "Anywhere in my state" },
    { value: "places", label: "Specific places" },
    { value: "anywhere", label: "Anywhere in Australia" }
  ];
  var MAX_PLACES = 20;
  var MIN_CHARS = 2;
  // FR-9 (S9-05): wait a quarter of a second after the last keystroke, drop a
  // request a newer one has replaced, and remember what was already answered,
  // so ordinary typing asks the server a handful of times, not once a letter.
  var DEBOUNCE_MS = 250;
  var MAX_SHOWN = 120;          // every suburb of a postcode (the list scrolls)
  var CACHE_MAX = 60;
  var ENDPOINT = "/api/au/localities";
  var NOTHING_FOUND = "Nothing found. Try a nearby town or a postcode.";
  var SEARCH_LIMITED = "Too many searches: wait a moment and try again.";
  var SEARCH_FAILED = "We could not search just now. Check your connection and try again.";

  var STYLE_ID = "gp-au-locpick-style";
  var CSS = [
    ".aulp{display:flex;flex-direction:column;gap:18px}",
    ".aulp-field{position:relative}",
    ".aulp-label{display:block;font-size:15px;font-weight:600;line-height:1.4;margin:0 0 4px;color:var(--gp-ink,#0f172a)}",
    ".aulp-hint{font-size:13px;line-height:1.5;margin:0 0 8px;color:var(--gp-muted,#475569)}",
    ".aulp-input{width:100%;box-sizing:border-box;min-height:48px;padding:12px 14px;font:inherit;font-size:16px;color:var(--gp-text,#0f172a);background:var(--gp-surface,#fff);border:1.5px solid var(--gp-border-strong,#94a3b8);border-radius:12px}",
    ".aulp-input:focus{outline:none;border-color:var(--gp-blue,#1d4ed8);box-shadow:0 0 0 3px rgba(29,78,216,.18)}",
    ".aulp-chosen{display:flex;align-items:center;gap:8px;min-height:48px;box-sizing:border-box;padding:8px 8px 8px 14px;border:1.5px solid var(--gp-blue,#1d4ed8);border-radius:12px;background:var(--gp-blue-soft,#eff6ff);color:var(--gp-ink,#0f172a);font-size:16px;font-weight:600}",
    ".aulp-chosen span{flex:1;min-width:0;overflow-wrap:anywhere}",
    ".aulp-change{appearance:none;-webkit-appearance:none;border:0;background:transparent;color:var(--gp-blue,#1d4ed8);font:inherit;font-size:14px;font-weight:600;min-height:44px;padding:0 10px;cursor:pointer;border-radius:8px}",
    ".aulp-change:focus-visible,.aulp-tag button:focus-visible,.aulp-opt-btn:focus-visible{outline:2px solid var(--gp-blue,#1d4ed8);outline-offset:2px}",
    // The list floats over what is below it, so opening it never moves the page.
    ".aulp-list{position:absolute;left:0;right:0;top:100%;z-index:40;margin:4px 0 0;padding:4px;list-style:none;max-height:288px;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;background:var(--gp-surface,#fff);border:1px solid var(--gp-border-strong,#94a3b8);border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.18)}",
    ".aulp-list[hidden]{display:none}",
    ".aulp-opt{min-height:44px;display:flex;align-items:center;padding:8px 12px;border-radius:8px;font-size:16px;line-height:1.3;color:var(--gp-text,#0f172a);cursor:pointer}",
    ".aulp-opt[aria-selected=\"true\"],.aulp-opt:hover{background:var(--gp-blue-soft,#eff6ff)}",
    ".aulp-empty{padding:12px;font-size:15px;line-height:1.4;color:var(--gp-muted,#475569)}",
    ".aulp-more{padding:10px 12px;font-size:13px;line-height:1.4;color:var(--gp-muted,#475569);border-top:1px solid var(--gp-border,#e2e8f0);margin-top:4px}",
    ".aulp-radios{display:flex;flex-direction:column;gap:8px;border:0;padding:0;margin:0;min-width:0}",
    ".aulp-radio{display:flex;align-items:flex-start;gap:10px;min-height:48px;box-sizing:border-box;padding:12px 14px;border:1.5px solid var(--gp-border-strong,#94a3b8);border-radius:12px;background:var(--gp-surface,#fff);font-size:15px;line-height:1.4;color:var(--gp-text,#0f172a);cursor:pointer}",
    ".aulp-radio input{width:20px;height:20px;flex-shrink:0;margin:1px 0 0;accent-color:var(--gp-blue,#1d4ed8)}",
    ".aulp-radio.is-on{border-color:var(--gp-blue,#1d4ed8);background:var(--gp-blue-soft,#eff6ff)}",
    ".aulp-places{margin-top:10px}",
    ".aulp-places[hidden]{display:none}",
    // (a display set by a class wins over the hidden attribute: say it outright)
    ".aulp-chosen[hidden],.aulp-field[hidden],.aulp-tags[hidden]{display:none}",
    ".aulp-tags{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0;padding:0;list-style:none}",
    ".aulp-tag{display:inline-flex;align-items:center;gap:2px;max-width:100%;padding:0 0 0 12px;border-radius:999px;background:var(--gp-blue-soft,#eff6ff);border:1px solid var(--gp-blue,#1d4ed8);color:var(--gp-ink,#0f172a);font-size:14px;font-weight:600}",
    ".aulp-tag span{overflow-wrap:anywhere}",
    ".aulp-tag button{appearance:none;-webkit-appearance:none;border:0;background:transparent;color:inherit;font-size:18px;line-height:1;min-width:40px;min-height:40px;border-radius:999px;cursor:pointer}",
    ".aulp-error{display:none;margin:6px 0 0;font-size:13px;line-height:1.4;color:var(--gp-danger,#b91c1c)}",
    ".aulp-error.show{display:block}",
    ".aulp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}"
  ].join("\n");

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var st = doc.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function cleanPlace(p) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id) return null;
    return { id: p.id.slice(0, 200), label: String(p.label == null ? "" : p.label).slice(0, 200) };
  }
  function cleanValue(v) {
    var x = v && typeof v === "object" ? v : {};
    var places = [];
    var seen = {};
    (Array.isArray(x.places) ? x.places : []).forEach(function (p) {
      var c = cleanPlace(p);
      if (c && !seen[c.id] && places.length < MAX_PLACES) { seen[c.id] = true; places.push(c); }
    });
    var travel = "";
    for (var i = 0; i < TRAVEL_OPTIONS.length; i++) if (TRAVEL_OPTIONS[i].value === x.travel) travel = x.travel;
    return { base: cleanPlace(x.base), travel: travel, places: places };
  }

  /**
   * Ask the server for suggestions. Never rejects. Resolves
   *   { ok, limited, aborted, results, total }
   * `limited` is the server saying "too many searches" (HTTP 429): that is not
   * a connection problem and is not reported as one. `signal` cancels it.
   */
  function fetchSuggestions(win, query, signal) {
    var failed = { ok: false, limited: false, aborted: false, results: [], total: 0 };
    if (!win || typeof win.fetch !== "function") return Promise.resolve(failed);
    var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (signal) init.signal = signal;
    var limited = false;
    return win.fetch(ENDPOINT + "?q=" + encodeURIComponent(query), init)
      .then(function (res) {
        if (res && res.status === 429) { limited = true; return null; }
        return res && res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (limited) return { ok: false, limited: true, aborted: false, results: [], total: 0 };
        var list = data && Array.isArray(data.results) ? data.results : null;
        if (!list) return failed;
        var results = list.map(cleanPlace).filter(function (p) { return !!p; }).slice(0, MAX_SHOWN);
        var total = Number(data.total);
        return { ok: true, limited: false, aborted: false, results: results, total: isFinite(total) && total > results.length ? Math.floor(total) : results.length };
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return { ok: false, limited: false, aborted: true, results: [], total: 0 };
        return failed;
      });
  }

  /**
   * One search box (a combobox). `onPick(place)` is called with { id, label }.
   * Returns { input, list, destroy, clear, focus }.
   */
  function buildCombobox(doc, win, opts) {
    var wrap = doc.createElement("div");
    wrap.className = "aulp-field";
    var input = doc.createElement("input");
    input.type = "text";
    input.className = "aulp-input";
    input.id = opts.id;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", opts.id + "List");
    input.setAttribute("aria-labelledby", opts.labelId);
    if (opts.describedBy) input.setAttribute("aria-describedby", opts.describedBy);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "words");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("enterkeyhint", "search");
    input.placeholder = opts.placeholder || "Start typing a suburb, town or postcode";
    input.maxLength = 60;
    var list = doc.createElement("ul");
    list.className = "aulp-list";
    list.id = opts.id + "List";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", opts.labelId);
    list.hidden = true;
    var status = doc.createElement("div");
    status.className = "aulp-sr";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    wrap.appendChild(input);
    wrap.appendChild(list);
    wrap.appendChild(status);

    var results = [];
    var active = -1;
    var timer = null;
    var asked = 0;
    var inFlight = null;          // the AbortController of the request on its way
    var answered = {};            // query -> answer, for this box, this visit
    var answeredKeys = [];

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }
    function setActive(i) {
      active = i;
      var kids = list.querySelectorAll('[role="option"]');
      for (var k = 0; k < kids.length; k++) kids[k].setAttribute("aria-selected", k === i ? "true" : "false");
      if (i >= 0 && kids[i]) {
        input.setAttribute("aria-activedescendant", kids[i].id);
        if (typeof kids[i].scrollIntoView === "function") { try { kids[i].scrollIntoView({ block: "nearest" }); } catch (e) { /* older browsers */ } }
      } else input.removeAttribute("aria-activedescendant");
    }
    function pick(i) {
      var place = results[i];
      if (!place) return;
      close();
      input.value = "";
      status.textContent = place.label + " chosen.";
      opts.onPick(place);
    }
    function render(answer) {
      var found = answer.results;
      results = found;
      list.textContent = "";
      if (!found.length) {
        var empty = doc.createElement("li");
        empty.className = "aulp-empty";
        empty.setAttribute("role", "presentation");
        empty.textContent = answer.ok ? NOTHING_FOUND : (answer.limited ? SEARCH_LIMITED : SEARCH_FAILED);
        list.appendChild(empty);
        status.textContent = empty.textContent;
      } else {
        found.forEach(function (place, i) {
          var li = doc.createElement("li");
          li.className = "aulp-opt";
          li.id = opts.id + "Opt" + i;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", "false");
          li.textContent = place.label;
          // FR-9 (S9-06): a place is chosen on a TAP (a click), never at the
          // end of a scroll. A finger dragged up the list ends in "touchend"
          // but not in a click, so nothing here listens for touchend. The
          // mousedown only keeps the keyboard focus in the search box (a tap
          // sends one just before its click), so the list does not close first.
          li.addEventListener("mousedown", function (e) { e.preventDefault(); });
          li.addEventListener("click", function (e) { e.preventDefault(); pick(i); });
          list.appendChild(li);
        });
        var more = answer.total > found.length;
        if (more) {
          var note = doc.createElement("li");
          note.className = "aulp-more";
          note.setAttribute("role", "presentation");
          note.textContent = "Showing " + found.length + " of " + answer.total + ". Keep typing to narrow it down.";
          list.appendChild(note);
        }
        status.textContent = (more ? found.length + " of " + answer.total + " suggestions shown." : found.length + (found.length === 1 ? " suggestion." : " suggestions."))
          + " Use the arrow keys to move and Enter to choose.";
      }
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      setActive(-1);
      // Bring the whole list into view when part of it would be off screen
      // (it scrolls only if it has to, so nothing jumps when it already fits).
      if (typeof list.scrollIntoView === "function") { try { list.scrollIntoView({ block: "nearest" }); } catch (e) { /* older browsers */ } }
    }
    function search() {
      var q = String(input.value || "").replace(/\s+/g, " ").trim();
      if (q.length < MIN_CHARS) { close(); status.textContent = ""; return; }
      var mine = ++asked;
      // The request a newer one replaces is cancelled, not left to finish.
      if (inFlight) { try { inFlight.abort(); } catch (e) { /* already done */ } inFlight = null; }
      var key = q.toLowerCase();
      if (answered[key]) { render(answered[key]); return; }
      var ctl = null;
      if (typeof win.AbortController === "function") { try { ctl = new win.AbortController(); } catch (e) { ctl = null; } }
      inFlight = ctl;
      fetchSuggestions(win, q, ctl ? ctl.signal : null).then(function (answer) {
        if (inFlight === ctl) inFlight = null;
        if (answer.aborted || mine !== asked) return;   // a newer search is on its way
        if (answer.ok) {
          answered[key] = answer;
          answeredKeys.push(key);
          if (answeredKeys.length > CACHE_MAX) delete answered[answeredKeys.shift()];
        }
        if (doc.activeElement !== input && !opts.keepOpen) return;
        render(answer);
      });
    }
    // Pressing on the list itself (its scroll bar, the "keep typing" line)
    // must not take the focus out of the search box and close the list.
    list.addEventListener("mousedown", function (e) { e.preventDefault(); });
    input.addEventListener("input", function () {
      if (opts.onType) opts.onType();
      if (timer) win.clearTimeout(timer);
      timer = win.setTimeout(search, DEBOUNCE_MS);
    });
    input.addEventListener("keydown", function (e) {
      var key = e.key;
      if (key === "ArrowDown" || key === "ArrowUp") {
        if (list.hidden) { search(); return; }
        if (!results.length) return;
        e.preventDefault();
        var next = key === "ArrowDown" ? active + 1 : active - 1;
        if (next >= results.length) next = 0;
        if (next < 0) next = results.length - 1;
        setActive(next);
      } else if (key === "Enter") {
        if (!list.hidden && results.length) {
          e.preventDefault();
          pick(active >= 0 ? active : 0);
        }
      } else if (key === "Escape") {
        if (!list.hidden) { e.preventDefault(); close(); }
      }
    });
    input.addEventListener("blur", function () { win.setTimeout(close, 120); });

    return {
      el: wrap, input: input, list: list,
      clear: function () { input.value = ""; close(); },
      focus: function () { try { input.focus(); } catch (e) { /* not focusable yet */ } }
    };
  }

  function mount(host, options) {
    var o = options || {};
    var doc = host.ownerDocument;
    var win = doc.defaultView || root;
    var prefix = o.idPrefix || "auLoc";
    var value = cleanValue(o.value);
    ensureStyle(doc);
    host.textContent = "";
    var box = doc.createElement("div");
    box.className = "aulp";

    function changed() { if (typeof o.onChange === "function") o.onChange(cleanValue(value)); }
    function errorEl(id, text) {
      var e = doc.createElement("div");
      e.className = "aulp-error";
      e.id = id;
      e.setAttribute("role", "alert");
      e.textContent = text;
      return e;
    }

    // ── Where are you based? ──────────────────────────────────────────────
    var baseBlock = doc.createElement("div");
    var baseLabel = doc.createElement("div");
    baseLabel.className = "aulp-label";
    baseLabel.id = prefix + "BaseLabel";
    baseLabel.textContent = "Where are you based?";
    var baseHint = doc.createElement("p");
    baseHint.className = "aulp-hint";
    baseHint.id = prefix + "BaseHint";
    baseHint.textContent = "Type a suburb, town or postcode and choose it from the list.";
    var baseChosen = doc.createElement("div");
    baseChosen.className = "aulp-chosen";
    baseChosen.id = prefix + "BaseChosen";
    var baseChosenText = doc.createElement("span");
    var baseChange = doc.createElement("button");
    baseChange.type = "button";
    baseChange.className = "aulp-change";
    baseChange.id = prefix + "BaseChange";
    baseChange.textContent = "Change";
    baseChosen.appendChild(baseChosenText);
    baseChosen.appendChild(baseChange);
    var baseError = errorEl(prefix + "BaseError", "Choose where you are based from the list.");
    var baseCombo = buildCombobox(doc, win, {
      id: prefix + "BaseInput", labelId: baseLabel.id, describedBy: baseHint.id,
      onType: function () { baseError.classList.remove("show"); },
      onPick: function (place) {
        value.base = place;
        baseError.classList.remove("show");
        paintBase();
        changed();
        try { baseChange.focus(); } catch (e) { /* fine */ }
      }
    });
    function paintBase() {
      var has = !!value.base;
      baseChosen.hidden = !has;
      baseCombo.el.hidden = has;
      baseChosenText.textContent = has ? value.base.label : "";
      baseChange.setAttribute("aria-label", has ? "Change where you are based (now " + value.base.label + ")" : "Change where you are based");
    }
    baseChange.addEventListener("click", function () {
      value.base = null;
      paintBase();
      changed();
      baseCombo.focus();
    });
    baseBlock.appendChild(baseLabel);
    baseBlock.appendChild(baseHint);
    baseBlock.appendChild(baseChosen);
    baseBlock.appendChild(baseCombo.el);
    baseBlock.appendChild(baseError);

    // ── How far would you go? ─────────────────────────────────────────────
    var travelBlock = doc.createElement("div");
    var radios = doc.createElement("fieldset");
    radios.className = "aulp-radios";
    radios.id = prefix + "Travel";
    var legend = doc.createElement("legend");
    legend.className = "aulp-label";
    legend.textContent = "How far would you go for the right practice?";
    radios.appendChild(legend);
    var radioEls = [];
    TRAVEL_OPTIONS.forEach(function (opt) {
      var label = doc.createElement("label");
      label.className = "aulp-radio";
      var input = doc.createElement("input");
      input.type = "radio";
      input.name = prefix + "TravelChoice";
      input.value = opt.value;
      input.id = prefix + "Travel_" + opt.value;
      var text = doc.createElement("span");
      text.textContent = opt.label;
      label.appendChild(input);
      label.appendChild(text);
      input.addEventListener("change", function () {
        if (!input.checked) return;
        value.travel = opt.value;
        travelError.classList.remove("show");
        paintTravel();
        changed();
        if (opt.value === "places" && !value.places.length) placesCombo.focus();
      });
      radios.appendChild(label);
      radioEls.push({ input: input, label: label, value: opt.value });
    });
    var travelError = errorEl(prefix + "TravelError", "Choose how far you would go.");

    // Specific places: the same search, each choice a small removable tag.
    var placesWrap = doc.createElement("div");
    placesWrap.className = "aulp-places";
    placesWrap.id = prefix + "Places";
    var placesLabel = doc.createElement("div");
    placesLabel.className = "aulp-label";
    placesLabel.id = prefix + "PlacesLabel";
    placesLabel.textContent = "Which places?";
    var placesHint = doc.createElement("p");
    placesHint.className = "aulp-hint";
    placesHint.id = prefix + "PlacesHint";
    placesHint.textContent = "Add as many as you like: a suburb, a town, a whole city or a regional area.";
    var tags = doc.createElement("ul");
    tags.className = "aulp-tags";
    tags.id = prefix + "Tags";
    tags.setAttribute("aria-label", "Places you chose");
    var placesError = errorEl(prefix + "PlacesError", "Add at least one place.");
    var placesCombo = buildCombobox(doc, win, {
      id: prefix + "PlacesInput", labelId: placesLabel.id, describedBy: placesHint.id,
      placeholder: "Add a place",
      onType: function () { placesError.classList.remove("show"); },
      onPick: function (place) {
        var already = value.places.some(function (p) { return p.id === place.id; });
        if (!already && value.places.length < MAX_PLACES) value.places.push(place);
        placesError.classList.remove("show");
        paintTags();
        changed();
        placesCombo.focus();
      }
    });
    function paintTags() {
      tags.textContent = "";
      value.places.forEach(function (place) {
        var li = doc.createElement("li");
        li.className = "aulp-tag";
        var name = doc.createElement("span");
        name.textContent = place.label;
        var remove = doc.createElement("button");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove " + place.label);
        remove.textContent = "×";
        remove.addEventListener("click", function () {
          value.places = value.places.filter(function (p) { return p.id !== place.id; });
          paintTags();
          changed();
          placesCombo.focus();
        });
        li.appendChild(name);
        li.appendChild(remove);
        tags.appendChild(li);
      });
      tags.hidden = !value.places.length;
    }
    function paintTravel() {
      radioEls.forEach(function (r) {
        r.input.checked = r.value === value.travel;
        r.label.classList.toggle("is-on", r.value === value.travel);
      });
      placesWrap.hidden = value.travel !== "places";
    }
    placesWrap.appendChild(placesLabel);
    placesWrap.appendChild(placesHint);
    placesWrap.appendChild(placesCombo.el);
    placesWrap.appendChild(tags);
    placesWrap.appendChild(placesError);
    travelBlock.appendChild(radios);
    travelBlock.appendChild(travelError);
    travelBlock.appendChild(placesWrap);

    box.appendChild(baseBlock);
    box.appendChild(travelBlock);
    host.appendChild(box);
    paintBase();
    paintTravel();
    paintTags();

    return {
      getValue: function () { return cleanValue(value); },
      setValue: function (v) { value = cleanValue(v); paintBase(); paintTravel(); paintTags(); },
      clearErrors: function () { baseError.classList.remove("show"); travelError.classList.remove("show"); placesError.classList.remove("show"); },
      /** errors: { base?, travel?, places? } (each a message or true). Focuses the first. */
      showErrors: function (errors) {
        var e = errors || {};
        var first = null;
        var show = function (el, msg, focusEl) {
          if (!msg) { el.classList.remove("show"); return; }
          if (typeof msg === "string") el.textContent = msg;
          el.classList.add("show");
          if (!first) first = focusEl;
        };
        show(baseError, e.base, value.base ? baseChange : baseCombo.input);
        show(travelError, e.travel, radioEls[0].input);
        show(placesError, e.places, placesCombo.input);
        if (first) { try { first.focus(); } catch (x) { /* fine */ } }
      }
    };
  }

  var api = {
    mount: mount, TRAVEL_OPTIONS: TRAVEL_OPTIONS, MAX_PLACES: MAX_PLACES, cleanValue: cleanValue, NOTHING_FOUND: NOTHING_FOUND,
    SEARCH_LIMITED: SEARCH_LIMITED, SEARCH_FAILED: SEARCH_FAILED, DEBOUNCE_MS: DEBOUNCE_MS, MAX_SHOWN: MAX_SHOWN,
    _fetchSuggestions: fetchSuggestions, _buildCombobox: buildCombobox
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GPAuLocationPicker = api;
})(typeof window !== "undefined" ? window : null);
