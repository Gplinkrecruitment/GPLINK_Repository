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
    var lockedMap = {
      amc: !bypass && !s.epicDone,
      pbs: !bypass && !s.ahpraDone,
      commencement: !bypass && !s.pbsDone
    };
    return STAGES.map(function (stage, index) {
      var locked = lockedMap[stage.key] === true;
      return {
        key: stage.key,
        title: stage.title,
        page: stage.page,
        description: stage.description,
        num: index + 1,
        done: doneMap[stage.key] === true,
        locked: locked,
        lockReason: locked ? (LOCK_COPY[stage.key] || "Complete the previous step to unlock this.") : null
      };
    });
  }

  function findStage(key) {
    for (var i = 0; i < STAGES.length; i++) {
      if (STAGES[i].key === key) return STAGES[i];
    }
    return null;
  }

  window.GPJourneyStages = {
    STAGES: STAGES,
    LOCK_COPY: LOCK_COPY,
    getStageStates: getStageStates,
    findStage: findStage
  };
})();
