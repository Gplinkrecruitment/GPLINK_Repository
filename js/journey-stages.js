(function () {
  "use strict";

  if (typeof window === "undefined") return;

  // ── Canonical 7-stage GP journey (single source of truth) ──
  // Order, keys, display names and lock copy for the full registration journey:
  //   Secure Placement → MyIntealth → AMC → AHPRA → Visa → PBS & Medicare → Commencement
  // Consumed by pages/index.html (journey list, stepper, nav dropdown, mobile
  // sheet) and js/app-shell.js (registration dropdown + mobile sheet) so the
  // two surfaces can never drift apart again.
  //
  // NOTE: this file only defines DISPLAY metadata + display-state derivation.
  // Real access control stays server-side (isStageAccessAllowed in server.js);
  // visa/ahpra/career remain force-allowed there regardless of what this shows.
  var STAGES = [
    {
      key: "career",
      title: "Secure Placement",
      page: "career",
      description: "View your secured practice placement and its details."
    },
    {
      key: "myinthealth",
      title: "MyIntealth Account",
      page: "myinthealth",
      description: "Create your MyIntealth account and complete EPIC verification."
    },
    {
      key: "amc",
      title: "AMC Portfolio",
      page: "amc",
      description: "Create your AMC candidate portfolio and upload credentials."
    },
    {
      key: "ahpra",
      title: "AHPRA Registration",
      page: "ahpra",
      description: "Prepare and submit your specialist registration application."
    },
    {
      key: "visa",
      title: "Visa Application",
      page: "visa",
      description: "Your employer-sponsored pathway to permanent residency."
    },
    {
      key: "pbs",
      title: "PBS & Medicare",
      page: "pbs",
      description: "Apply for your Medicare provider number and PBS prescriber number."
    },
    {
      key: "commencement",
      title: "Commencement",
      page: "commencement",
      description: "Pre-arrival checklist, indemnity and your first day at the practice."
    }
  ];

  var LOCK_COPY = {
    amc: "Unlocked after MyIntealth is complete",
    pbs: "Unlocked after AHPRA is complete",
    commencement: "Unlocks once PBS & Medicare is complete"
  };

  // ── Position-first lock (owner rule, 2026-09-01) ──
  // Until a position is secured, every registration step is locked and points
  // the doctor at the careers page. Server twin: POSITION_GATED_STAGES +
  // positionGateFor in server.js (the page gate 302s these to /pages/career).
  var POSITION_GATED = { myinthealth: true, amc: true, ahpra: true, visa: true, pbs: true };
  var POSITION_LOCK_COPY = "Unlocks after you secure your position";

  // ── Vaulted stages (temporarily removed from the GP journey) ──
  // Stages listed here keep their definition above (so they can be restored by
  // simply deleting the key below) but are excluded from everything the GP sees:
  // the journey list, the registration dropdown and the mobile sheet all consume
  // VISIBLE_STAGES / getStageStates below. Server-side this is mirrored by
  // VAULTED_STAGES in server.js (page access + can-proceed) — keep the two in sync.
  var VAULTED = { commencement: true };
  var VISIBLE_STAGES = STAGES.filter(function (stage) { return !VAULTED[stage.key]; });

  // Derives the per-stage display state (done / locked / lockReason) from a
  // progress snapshot: { careerSecured, epicDone, amcDone, ahpraDone, visaDone,
  // pbsDone }. `bypass` mirrors BYPASS_LOCK_EMAILS handling on both surfaces.
  // Commencement is never "done" client-side — it is the final stage and has
  // no completion signal; it unlocks (server-gated) after PBS & Medicare.
  function getStageStates(snap, bypass) {
    var s = snap && typeof snap === "object" ? snap : {};
    var doneMap = {
      career: !!s.careerSecured,
      myinthealth: !!s.epicDone,
      amc: !!s.amcDone,
      ahpra: !!s.ahpraDone,
      visa: !!s.visaDone,
      pbs: !!s.pbsDone,
      commencement: false
    };
    // Position-first: an unsecured position locks every registration step
    // (myinthealth/amc/ahpra/visa/pbs). The old prerequisite locks still apply
    // once the position gate is open.
    var positionOpen = !!s.careerSecured;
    var lockedMap = {
      myinthealth: !bypass && !positionOpen,
      amc: !bypass && (!positionOpen || !s.epicDone),
      ahpra: !bypass && !positionOpen,
      visa: !bypass && !positionOpen,
      pbs: !bypass && (!positionOpen || !s.ahpraDone),
      commencement: !bypass && !s.pbsDone
    };
    return VISIBLE_STAGES.map(function (stage, index) {
      var done = doneMap[stage.key] === true;
      // A completed step is never shown locked — it stays revisitable
      // (read-only review mode on the step pages, same as the server gate).
      var locked = !done && lockedMap[stage.key] === true;
      var positionLocked = locked && !positionOpen && POSITION_GATED[stage.key] === true && !bypass;
      return {
        key: stage.key,
        title: stage.title,
        page: stage.page,
        description: stage.description,
        num: index + 1,
        done: done,
        locked: locked,
        // positionLocked rows render an ACTIVE call to action that routes to the
        // careers page (owner rule: registration CTAs redirect there until a
        // position is secured) instead of the plain inert locked row.
        positionLocked: positionLocked,
        lockReason: locked
          ? (positionLocked ? POSITION_LOCK_COPY : (LOCK_COPY[stage.key] || "Complete the previous step to unlock this."))
          : null
      };
    });
  }

  function findStage(key) {
    for (var i = 0; i < VISIBLE_STAGES.length; i++) {
      if (VISIBLE_STAGES[i].key === key) return VISIBLE_STAGES[i];
    }
    return null;
  }

  // Pure "has this GP secured a placement?" check over a parsed gp_career_state
  // blob (localStorage key "gp_career_state", synced via state-sync). Single
  // source of truth shared by pages/index.html (journey snapshot) and
  // js/gp-walkthrough-shell.js (post-tour "start here" pointer branch).
  function hasCareerSecured(careerState) {
    if (!careerState || typeof careerState !== "object") return false;
    if (careerState.career_secured === true || careerState.secured === true) return true;
    var applications = Array.isArray(careerState.applications) ? careerState.applications : [];
    for (var i = 0; i < applications.length; i++) {
      var app = applications[i];
      if (!app || typeof app !== "object") continue;
      if (app.isPlacementSecured === true) return true;
      var status = String(app.rawStatus || app.status || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (status === "secured" || status === "placement_secured" || status === "practice_secured") return true;
    }
    return false;
  }

  // Pure MyIntealth/EPIC completion check over a parsed gp_epic_progress blob —
  // the same base signal pages/index.html derives epicDone from. Fail-closed:
  // anything malformed reads as "not done". (The dashboard can additionally
  // force epicDone via the admin stage override; consumers that need that
  // nuance should also check the RENDERED journey row state.)
  function isEpicDone(epicProgress) {
    return !!(epicProgress && typeof epicProgress === "object"
      && epicProgress.completed && epicProgress.completed.verification_issued === true);
  }

  window.GPJourneyStages = {
    STAGES: VISIBLE_STAGES,
    ALL_STAGES: STAGES,
    VAULTED: VAULTED,
    LOCK_COPY: LOCK_COPY,
    getStageStates: getStageStates,
    findStage: findStage,
    hasCareerSecured: hasCareerSecured,
    isEpicDone: isEpicDone
  };
})();
