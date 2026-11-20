/* Australian GP build (WP-05): the onboarding branch for a doctor who is
 * already registered with Ahpra and working in Australia.
 *
 * This file holds the answer lists and the checks, with no page code in it, so
 * it can be loaded by the wizard (window.GPOnboardingAu) and by the tests
 * (require). The lists mirror lib/au-onboarding.js on the server, which is the
 * authority and checks every answer again; tests/au-wp05-onboarding-lib.test.js
 * keeps the two in step. Change BOTH together.
 *
 * Every word in this file can reach a doctor on the Australian branch, so the
 * wording rules for that doctor apply to the whole file (comments included):
 * tests/au-wp05-onboarding-copy.test.js scans it.
 *
 * Load it with a cache-buster, and bump the version whenever this file changes:
 *   <script src="/js/onboarding-au.js?v=20261120a"></script>
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.GPOnboardingAu = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // The screens of the branch, in order. The identity check (the wizard's own
  // last step, unchanged) follows "review".
  var STEPS = ["where", "when", "registration", "details", "review"];

  var REGISTRATION_TYPES = [
    { value: "specialist", label: "Specialist (general practice)" },
    { value: "general_and_specialist", label: "General and specialist (general practice)" },
    { value: "general", label: "General" },
    { value: "provisional", label: "Provisional" },
    { value: "limited", label: "Limited" },
    { value: "non_practising", label: "Non-practising" },
    { value: "unsure", label: "Something else, or not sure" }
  ];

  var FELLOWSHIPS = [
    { value: "fracgp", label: "FRACGP" },
    { value: "facrrm", label: "FACRRM" },
    { value: "both", label: "Both FRACGP and FACRRM" },
    { value: "registrar", label: "I am a GP registrar (in training)" },
    { value: "other", label: "Another fellowship" },
    { value: "none", label: "No fellowship" }
  ];

  var MORATORIUM = [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
    { value: "unsure", label: "Not sure" }
  ];

  var WORK_RIGHTS = [
    { value: "citizen", label: "Australian citizen" },
    { value: "pr", label: "Permanent resident" },
    { value: "temporary", label: "Temporary resident" }
  ];

  var CITY_LOCATIONS = [
    "Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Canberra", "Hobart", "Darwin",
    "Gold Coast", "Newcastle", "Wollongong", "Sunshine Coast", "Geelong"
  ];
  var REGIONAL_LOCATIONS = [
    "Regional NSW", "Regional VIC", "Regional QLD", "Regional WA", "Regional SA", "Regional TAS", "Regional NT"
  ];
  var ANYWHERE_LOCATION = "Anywhere in Australia";
  var ALL_LOCATIONS = CITY_LOCATIONS.concat(REGIONAL_LOCATIONS, [ANYWHERE_LOCATION]);
  var MAX_LOCATIONS = 12;

  var STATES = [
    { value: "NSW", label: "New South Wales" },
    { value: "VIC", label: "Victoria" },
    { value: "QLD", label: "Queensland" },
    { value: "WA", label: "Western Australia" },
    { value: "SA", label: "South Australia" },
    { value: "TAS", label: "Tasmania" },
    { value: "ACT", label: "Australian Capital Territory" },
    { value: "NT", label: "Northern Territory" }
  ];

  var NOTICE_WEEKS_MAX = 52;
  var NOTICE_OPTIONS = [
    { value: 0, label: "No notice needed" },
    { value: 1, label: "1 week" },
    { value: 2, label: "2 weeks" },
    { value: 4, label: "4 weeks" },
    { value: 6, label: "6 weeks" },
    { value: 8, label: "8 weeks" },
    { value: 12, label: "12 weeks" },
    { value: 26, label: "6 months" }
  ];

  var SESSIONS_MIN = 1;
  var SESSIONS_MAX = 10;

  var AHPRA_NUMBER_PATTERN = /^MED\d{10}$/;

  function defaultAnswers() {
    return {
      step: 0,
      locations: [],
      sessions: "",
      availableFrom: "",
      noticeWeeks: "",
      state: "",
      suburb: "",
      postcode: "",
      currentPractice: "",
      ahpraNumber: "",
      registrationType: "",
      fellowship: "",
      fellowshipDetail: "",
      detailsConfirmed: false,
      hasConditions: null,
      conditionsDetail: "",
      moratorium19ab: "",
      workRights: "",
      permitSubclass: "",
      permitExpiry: ""
    };
  }

  function has(list, value) {
    for (var i = 0; i < list.length; i++) { if (list[i].value === value) return true; }
    return false;
  }

  function labelFor(list, value) {
    for (var i = 0; i < list.length; i++) { if (list[i].value === value) return list[i].label; }
    return "";
  }

  // Letters are KEPT (the number starts with MED): only spaces and hyphens are
  // removed, and the letters are upper-cased.
  function normaliseAhpraNumber(value) {
    return String(value == null ? "" : value).replace(/[\s-]+/g, "").toUpperCase();
  }

  function validateAhpraNumber(value) {
    var n = normaliseAhpraNumber(value);
    if (!n) return { ok: false, message: "Please enter your Ahpra registration number." };
    if (!AHPRA_NUMBER_PATTERN.test(n)) {
      return { ok: false, message: "That does not look like an Ahpra registration number. It is MED followed by 10 digits." };
    }
    return { ok: true, number: n };
  }

  function isIsoDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? "" : value).trim());
    if (!m) return false;
    var y = Number(m[1]); var mo = Number(m[2]); var d = Number(m[3]);
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  function isWholeNumber(value, min, max) {
    if (value === "" || value === null || value === undefined) return false;
    var n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max;
  }

  /**
   * Check one screen. Returns { ok, errors } where errors is field -> message.
   * The same rules run again on the server before anything is saved.
   * `nowYear` is injectable for tests.
   */
  function validateStep(stepKey, answers, nowYear) {
    var a = answers && typeof answers === "object" ? answers : {};
    var errors = {};
    var year = Number.isInteger(nowYear) ? nowYear : new Date().getFullYear();

    if (stepKey === "where") {
      var locs = Array.isArray(a.locations) ? a.locations.filter(function (l) { return ALL_LOCATIONS.indexOf(l) !== -1; }) : [];
      if (!locs.length) errors.locations = "Choose at least one place you would like to work.";
      if (a.sessions !== "" && a.sessions !== null && a.sessions !== undefined && !isWholeNumber(a.sessions, SESSIONS_MIN, SESSIONS_MAX)) {
        errors.sessions = "Choose how many sessions a week you would like.";
      }
    }

    if (stepKey === "when") {
      // No minimum: today, or a date already past, is a real answer.
      if (!isIsoDate(a.availableFrom)) errors.availableFrom = "Choose the date you could start.";
      else {
        var y = Number(String(a.availableFrom).slice(0, 4));
        if (y < year - 1 || y > year + 5) errors.availableFrom = "Choose a date within the next five years.";
      }
      if (!isWholeNumber(a.noticeWeeks, 0, NOTICE_WEEKS_MAX)) errors.noticeWeeks = "Choose your notice period.";
      if (!has(STATES, a.state)) errors.state = "Choose the state or territory you live in.";
      if (a.postcode && !/^\d{4}$/.test(String(a.postcode).trim())) errors.postcode = "A postcode is four digits.";
    }

    if (stepKey === "registration") {
      var reg = validateAhpraNumber(a.ahpraNumber);
      if (!reg.ok) errors.ahpraNumber = reg.message;
      if (!has(REGISTRATION_TYPES, a.registrationType)) errors.registrationType = "Choose your registration type.";
      if (!has(FELLOWSHIPS, a.fellowship)) errors.fellowship = "Choose your fellowship.";
      if (a.detailsConfirmed !== true) errors.detailsConfirmed = "Please tick the box to confirm your details are correct.";
    }

    if (stepKey === "details") {
      if (typeof a.hasConditions !== "boolean") errors.hasConditions = "Choose yes or no.";
      if (!has(MORATORIUM, a.moratorium19ab)) errors.moratorium19ab = "Choose yes, no or not sure.";
      if (!has(WORK_RIGHTS, a.workRights)) errors.workRights = "Choose your right to work in Australia.";
      if (a.workRights === "temporary" && a.permitExpiry && !isIsoDate(a.permitExpiry)) errors.permitExpiry = "Enter a valid date.";
    }

    return { ok: Object.keys(errors).length === 0, errors: errors };
  }

  /** The first screen with something missing, or -1 when every screen passes. */
  function firstIncompleteStep(answers, nowYear) {
    for (var i = 0; i < STEPS.length; i++) {
      if (STEPS[i] === "review") continue;
      if (!validateStep(STEPS[i], answers, nowYear).ok) return i;
    }
    return -1;
  }

  function formatDate(iso) {
    if (!isIsoDate(iso)) return "";
    var parts = String(iso).split("-");
    var months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return Number(parts[2]) + " " + months[Number(parts[1]) - 1] + " " + parts[0];
  }

  /** The rows of the review screen: [{ label, value }]. Plain text, not HTML. */
  function reviewRows(answers) {
    var a = answers && typeof answers === "object" ? answers : {};
    var rows = [];
    var locs = Array.isArray(a.locations) ? a.locations.filter(function (l) { return ALL_LOCATIONS.indexOf(l) !== -1; }) : [];
    rows.push({ label: "Where you would like to work", value: locs.length ? locs.join(", ") : "Not set" });
    rows.push({ label: "Sessions a week", value: isWholeNumber(a.sessions, SESSIONS_MIN, SESSIONS_MAX) ? String(Number(a.sessions)) : "Not sure yet" });
    rows.push({ label: "Could start from", value: formatDate(a.availableFrom) || "Not set" });
    var noticeLabel = "";
    if (isWholeNumber(a.noticeWeeks, 0, NOTICE_WEEKS_MAX)) {
      noticeLabel = labelFor(NOTICE_OPTIONS, Number(a.noticeWeeks)) || (Number(a.noticeWeeks) + " weeks");
    }
    rows.push({ label: "Notice period", value: noticeLabel || "Not set" });
    var home = [];
    if (a.suburb) home.push(String(a.suburb));
    if (a.state) home.push(String(a.state));
    if (a.postcode) home.push(String(a.postcode));
    rows.push({ label: "Where you live now", value: home.length ? home.join(" ") : "Not set" });
    if (a.currentPractice) rows.push({ label: "Current practice", value: String(a.currentPractice) + " (we never contact them)" });
    var regNumber = normaliseAhpraNumber(a.ahpraNumber);
    rows.push({ label: "Ahpra registration number", value: regNumber || "Not provided" });
    rows.push({ label: "Registration type", value: labelFor(REGISTRATION_TYPES, a.registrationType) || "Not set" });
    var fellowship = labelFor(FELLOWSHIPS, a.fellowship) || "Not set";
    if (a.fellowship === "other" && a.fellowshipDetail) fellowship = String(a.fellowshipDetail);
    rows.push({ label: "Fellowship", value: fellowship });
    rows.push({
      label: "Conditions, undertakings or notations",
      value: a.hasConditions === true ? "Yes" : (a.hasConditions === false ? "No" : "Not set")
    });
    rows.push({ label: "19AB moratorium applies", value: labelFor(MORATORIUM, a.moratorium19ab) || "Not set" });
    rows.push({ label: "Right to work", value: labelFor(WORK_RIGHTS, a.workRights) || "Not set" });
    return rows;
  }

  return {
    STEPS: STEPS,
    REGISTRATION_TYPES: REGISTRATION_TYPES,
    FELLOWSHIPS: FELLOWSHIPS,
    MORATORIUM: MORATORIUM,
    WORK_RIGHTS: WORK_RIGHTS,
    CITY_LOCATIONS: CITY_LOCATIONS,
    REGIONAL_LOCATIONS: REGIONAL_LOCATIONS,
    ANYWHERE_LOCATION: ANYWHERE_LOCATION,
    ALL_LOCATIONS: ALL_LOCATIONS,
    MAX_LOCATIONS: MAX_LOCATIONS,
    STATES: STATES,
    NOTICE_OPTIONS: NOTICE_OPTIONS,
    NOTICE_WEEKS_MAX: NOTICE_WEEKS_MAX,
    SESSIONS_MIN: SESSIONS_MIN,
    SESSIONS_MAX: SESSIONS_MAX,
    AHPRA_NUMBER_PATTERN: AHPRA_NUMBER_PATTERN,
    defaultAnswers: defaultAnswers,
    labelFor: labelFor,
    normaliseAhpraNumber: normaliseAhpraNumber,
    validateAhpraNumber: validateAhpraNumber,
    validateStep: validateStep,
    firstIncompleteStep: firstIncompleteStep,
    formatDate: formatDate,
    reviewRows: reviewRows
  };
});
