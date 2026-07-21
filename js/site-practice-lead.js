/* GP Link — practice lead flow (marketing site).
 *
 * A four-step guided flow that drops a practice into the SAME pipeline a
 * Facebook lead enters: prospect created, intake link emailed immediately.
 *
 * Deliberately dependency-free and ES5-flavoured to match js/site.js.
 */
(function () {
  "use strict";

  var root = document.getElementById("practiceFlow");
  if (!root) return;

  var STEP_COUNT = 4;
  var startedAt = Date.now();

  var state = {
    step: 1,
    gps_needed: "",
    employment_type: "",
    urgency: "",
    practice_name: "",
    suburb: "",
    state: "",
    postcode: "",
    contact_name: "",
    contact_role: "",
    contact_email: "",
    contact_phone: "",
    website: "",
    dpa: null,
    latitude: null,
    longitude: null
  };

  var dpaLookupFor = "";      // the suburb+state we last looked up
  var dpaInFlight = false;

  var stepEls = {};
  for (var i = 1; i <= STEP_COUNT; i++) {
    stepEls[i] = root.querySelector('[data-pf-step="' + i + '"]');
  }
  var railEl = root.querySelector("[data-pf-rail]");
  var errEl = root.querySelector("[data-pf-error]");
  var dpaPanel = root.querySelector("[data-pf-dpa]");

  var prefersReducedMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- helpers

  function val(name) {
    var el = root.querySelector('[name="' + name + '"]');
    return el ? String(el.value || "").trim() : "";
  }

  function setError(message) {
    if (!errEl) return;
    errEl.textContent = message || "";
    errEl.classList.toggle("is-on", !!message);
  }

  function plausibleEmail(value) {
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(value || "").trim());
  }

  function plausiblePhone(value) {
    return String(value || "").replace(/\D/g, "").length >= 8;
  }

  function updateRail() {
    if (!railEl) return;
    var segs = railEl.querySelectorAll("[data-pf-seg]");
    for (var i = 0; i < segs.length; i++) {
      var n = Number(segs[i].getAttribute("data-pf-seg"));
      segs[i].classList.toggle("is-done", n < state.step);
      segs[i].classList.toggle("is-now", n === state.step);
    }
    var label = root.querySelector("[data-pf-stepnum]");
    if (label) label.textContent = String(Math.min(state.step, STEP_COUNT - 1));
  }

  function showStep(n, direction) {
    var previous = stepEls[state.step];
    var next = stepEls[n];
    if (!next) return;

    state.step = n;

    for (var key in stepEls) {
      if (stepEls[key]) stepEls[key].hidden = true;
    }
    next.hidden = false;

    if (!prefersReducedMotion && previous !== next) {
      next.classList.remove("pf-in-left", "pf-in-right");
      // Force a reflow so the animation restarts even when re-entering the
      // same step (e.g. Back then Next).
      void next.offsetWidth;
      next.classList.add(direction === "back" ? "pf-in-left" : "pf-in-right");
    }

    updateRail();
    setError("");

    // Move focus to the step heading so screen readers and keyboard users
    // land in the right place, without yanking the viewport on mobile.
    var heading = next.querySelector("[data-pf-heading]");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); }
    }

    var card = root.querySelector(".pf-card");
    if (card && card.getBoundingClientRect().top < 0) {
      card.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
    }
  }

  // ------------------------------------------------------------ choice chips

  root.addEventListener("click", function (ev) {
    var chip = ev.target.closest ? ev.target.closest("[data-pf-choice]") : null;
    if (!chip || !root.contains(chip)) return;

    var field = chip.getAttribute("data-pf-field");
    var value = chip.getAttribute("data-pf-choice");
    if (!field) return;

    state[field] = value;

    var group = chip.closest("[data-pf-group]");
    if (group) {
      var siblings = group.querySelectorAll("[data-pf-choice]");
      for (var i = 0; i < siblings.length; i++) {
        var on = siblings[i] === chip;
        siblings[i].classList.toggle("is-on", on);
        siblings[i].setAttribute("aria-checked", on ? "true" : "false");
      }
    }
    setError("");
  });

  // Chips are buttons in a radiogroup — support arrow keys like real radios.
  root.addEventListener("keydown", function (ev) {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    var chip = ev.target.closest ? ev.target.closest("[data-pf-choice]") : null;
    if (!chip) return;
    var group = chip.closest("[data-pf-group]");
    if (!group) return;
    var chips = Array.prototype.slice.call(group.querySelectorAll("[data-pf-choice]"));
    var idx = chips.indexOf(chip);
    var nextIdx = ev.key === "ArrowRight" ? idx + 1 : idx - 1;
    if (nextIdx < 0) nextIdx = chips.length - 1;
    if (nextIdx >= chips.length) nextIdx = 0;
    ev.preventDefault();
    chips[nextIdx].focus();
    chips[nextIdx].click();
  });

  // ------------------------------------------------------------- DPA look-up

  function renderDpa(status, payload) {
    if (!dpaPanel) return;
    dpaPanel.hidden = false;
    dpaPanel.classList.remove("is-checking", "is-yes", "is-neutral");

    if (status === "checking") {
      dpaPanel.classList.add("is-checking");
      dpaPanel.innerHTML =
        '<span class="pf-dpa-dot" aria-hidden="true"></span>' +
        '<div><b>Checking your area…</b><p>Looking up the official Distribution Priority Area map.</p></div>';
      return;
    }

    if (status === "yes") {
      dpaPanel.classList.add("is-yes");
      dpaPanel.innerHTML =
        '<span class="pf-dpa-tick" aria-hidden="true">✓</span>' +
        '<div><b>Good news — you\'re in a Distribution Priority Area.</b>' +
        '<p>That means your practice can recruit overseas-trained GPs' +
        (payload && payload.mmm ? ' (' + payload.mmm + ')' : '') + '. We\'ll confirm the detail with you.</p></div>';
      return;
    }

    // Everything else stays encouraging on purpose. A practice outside a DPA
    // still has options, and a failed lookup is not a rejection.
    dpaPanel.classList.add("is-neutral");
    dpaPanel.innerHTML =
      '<span class="pf-dpa-tick" aria-hidden="true">→</span>' +
      '<div><b>Got it — we\'ll confirm your options.</b>' +
      '<p>Placement rules vary by area, so one of our team will talk you through what applies to your practice.</p></div>';
  }

  function checkDpa() {
    var suburb = state.suburb;
    var stateCode = state.state;
    if (!suburb) return Promise.resolve();

    var key = (suburb + "|" + stateCode).toLowerCase();
    if (key === dpaLookupFor || dpaInFlight) return Promise.resolve();

    dpaLookupFor = key;
    dpaInFlight = true;
    renderDpa("checking");

    // The geocoder we sit behind rate-limits rapid repeat lookups, so the
    // request can occasionally stall. Never leave someone watching a spinner:
    // give up at 8s and fall through to the encouraging neutral message.
    var timedOut = false;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      timedOut = true;
      if (controller) { try { controller.abort(); } catch (e) {} }
    }, 8000);

    return fetch("/api/public/practice-dpa?suburb=" + encodeURIComponent(suburb) +
      "&state=" + encodeURIComponent(stateCode), controller ? { signal: controller.signal } : undefined)
      .then(function (r) { clearTimeout(timer); return r.json(); })
      .then(function (json) {
        if (json && json.ok && json.dpa === true) {
          state.dpa = true;
          state.latitude = typeof json.latitude === "number" ? json.latitude : null;
          state.longitude = typeof json.longitude === "number" ? json.longitude : null;
          renderDpa("yes", json);
        } else if (json && json.ok && json.dpa === false) {
          state.dpa = false;
          state.latitude = typeof json.latitude === "number" ? json.latitude : null;
          state.longitude = typeof json.longitude === "number" ? json.longitude : null;
          renderDpa("neutral", json);
        } else {
          // Unknown stays unknown — never recorded as "not a DPA".
          state.dpa = null;
          renderDpa("neutral", json);
        }
      })
      .catch(function () {
        clearTimeout(timer);
        state.dpa = null;
        renderDpa("neutral");
        // A timed-out lookup should be retried if they edit the suburb, so
        // don't leave the cache key pointing at a result we never got.
        if (timedOut) dpaLookupFor = "";
      })
      .then(function () { dpaInFlight = false; });
  }

  // ------------------------------------------------------------- validation

  function captureStep(n) {
    if (n === 2) {
      state.practice_name = val("practice_name");
      state.suburb = val("suburb");
      state.state = val("state");
      state.postcode = val("postcode");
    }
    if (n === 3) {
      state.contact_name = val("contact_name");
      state.contact_email = val("contact_email");
      state.contact_phone = val("contact_phone");
      state.website = val("website");
    }
  }

  function validateStep(n) {
    if (n === 1) {
      if (!state.gps_needed) return "Let us know how many GPs you're after.";
      if (!state.employment_type) return "Choose full-time, part-time or either.";
      if (!state.urgency) return "Tell us roughly when you need someone.";
      return "";
    }
    if (n === 2) {
      if (!state.practice_name) return "Please enter your practice name.";
      if (!state.suburb) return "Please enter the suburb your practice is in.";
      return "";
    }
    if (n === 3) {
      if (!state.contact_name) return "Please tell us your name.";
      if (!plausibleEmail(state.contact_email)) return "Please enter a valid email address — it's where your link goes.";
      // Mirrors the server rule (digit count only) so a real number in any
      // format passes and the visitor gets a helpful message, not a 400.
      if (!state.contact_phone) return "Please add a phone number so we can call you back.";
      if (!plausiblePhone(state.contact_phone)) return "That phone number looks too short — please check it.";
      return "";
    }
    return "";
  }

  // ---------------------------------------------------------------- submit

  function submit() {
    var btn = root.querySelector("[data-pf-submit]");
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    setError("");

    var payload = {
      gps_needed: state.gps_needed,
      employment_type: state.employment_type,
      urgency: state.urgency,
      practice_name: state.practice_name,
      suburb: state.suburb,
      state: state.state,
      postcode: state.postcode,
      contact_name: state.contact_name,
      contact_role: state.contact_role,
      contact_email: state.contact_email,
      contact_phone: state.contact_phone,
      website: state.website,
      dpa: state.dpa,
      latitude: state.latitude,
      longitude: state.longitude,
      elapsed_ms: Date.now() - startedAt,
      company_url: val("company_url")
    };

    var tsField = root.querySelector('[name="cf-turnstile-response"]');
    if (tsField && tsField.value) payload.turnstile_token = tsField.value;

    fetch("/api/public/practice-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { ok: res.ok && json && json.ok === true, json: json || {} };
      });
    }).then(function (result) {
      if (result.ok) {
        var emailEcho = root.querySelector("[data-pf-email-echo]");
        if (emailEcho) emailEcho.textContent = state.contact_email;
        showStep(4, "next");
        return;
      }
      if (btn) { btn.disabled = false; btn.textContent = "Send my details"; }
      setError((result.json && result.json.error) ||
        "Something went wrong sending that. Please try again.");
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = "Send my details"; }
      setError("We couldn't reach the server. Please check your connection and try again.");
    });
  }

  // -------------------------------------------------------------- navigation

  root.addEventListener("click", function (ev) {
    var next = ev.target.closest ? ev.target.closest("[data-pf-next]") : null;
    if (next) {
      ev.preventDefault();
      captureStep(state.step);
      var problem = validateStep(state.step);
      if (problem) { setError(problem); return; }
      if (state.step === 2) checkDpa();
      if (state.step === 3) { submit(); return; }
      showStep(state.step + 1, "next");
      return;
    }

    var back = ev.target.closest ? ev.target.closest("[data-pf-back]") : null;
    if (back) {
      ev.preventDefault();
      captureStep(state.step);
      showStep(Math.max(1, state.step - 1), "back");
    }
  });

  // Enter advances rather than submitting the page's form element.
  root.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    var tag = (ev.target.tagName || "").toLowerCase();
    if (tag === "textarea") return;
    if (ev.target.hasAttribute && ev.target.hasAttribute("data-pf-choice")) return;
    if (state.step > 3) return;
    ev.preventDefault();
    var btn = stepEls[state.step] && stepEls[state.step].querySelector("[data-pf-next]");
    if (btn) btn.click();
  });

  // Warm the eligibility answer while they're still typing their details, so
  // the reveal feels instant when they reach it.
  var suburbInput = root.querySelector('[name="suburb"]');
  if (suburbInput) {
    suburbInput.addEventListener("blur", function () {
      captureStep(2);
      if (state.suburb) checkDpa();
    });
  }

  updateRail();
})();
