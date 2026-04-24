(function () {
  const STYLE_ID = "gp-registration-stepper-style";
  const CONTAINER_STATE = new WeakMap();
  const MOBILE_BREAKPOINT = 860;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .registration-stepper {
        --rs-accent: #1a56db;
        --rs-accent-soft: rgba(26, 86, 219, 0.12);
        --rs-success: #0d7c5f;
        --rs-line: #e4e7ee;
        --rs-muted: #7c849b;
        --rs-text: #0c1222;
        --rs-subtext: #7c849b;
        font-family: "DM Sans", -apple-system, sans-serif;
        position: relative;
        width: 100%;
      }

      .registration-stepper-viewport-wrap {
        position: relative;
        border-radius: 16px;
      }

      .registration-stepper-viewport-wrap::before,
      .registration-stepper-viewport-wrap::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        width: 28px;
        pointer-events: none;
        opacity: 0;
        transition: opacity .2s ease;
        z-index: 4;
      }

      .registration-stepper-viewport-wrap::before {
        left: 0;
        background: linear-gradient(90deg, rgba(242,244,248,.98), rgba(242,244,248,0));
      }

      .registration-stepper-viewport-wrap::after {
        right: 0;
        background: linear-gradient(270deg, rgba(242,244,248,.98), rgba(242,244,248,0));
      }

      .registration-stepper-viewport-wrap.has-left-fade::before { opacity: 1; }
      .registration-stepper-viewport-wrap.has-right-fade::after { opacity: 1; }

      .registration-stepper-viewport {
        overflow-x: clip;
        overflow-y: visible;
        border-radius: 14px;
      }

      .registration-stepper-track {
        position: relative;
        display: flex;
        align-items: stretch;
        gap: clamp(6px, 0.8vw, 10px);
        width: 100%;
        padding: 4px clamp(2px, 0.8vw, 6px) 16px;
        min-height: 80px;
      }

      /* Progress line — --rs-line-top is computed from actual circle positions */
      .registration-stepper-line {
        position: absolute;
        left: var(--rs-line-start, 0px);
        width: var(--rs-line-width, 0px);
        top: var(--rs-line-top, 26px);
        transform: translateY(-50%);
        height: 2px;
        border-radius: 999px;
        background: var(--rs-line);
        pointer-events: none;
        z-index: 0;
        overflow: hidden;
      }

      .registration-stepper-line-fill {
        width: var(--rs-fill-width, 0px);
        height: 100%;
        border-radius: inherit;
        background: var(--rs-success);
        transition: width 0.55s cubic-bezier(0.4, 0, 0.2, 1);
      }

      /* Step button */
      .registration-stepper-step {
        position: relative;
        z-index: 1;
        border: 0;
        background: transparent;
        color: var(--rs-text);
        border-radius: 14px;
        padding: 0;
        margin: 0;
        flex: 1 1 0;
        min-width: 168px;
        text-align: left;
        scroll-snap-align: center;
        cursor: default;
        outline: none;
      }

      .registration-stepper-step.is-clickable { cursor: pointer; }
      .registration-stepper-step:not(.is-clickable) { cursor: not-allowed; }

      .registration-stepper-step:active .registration-stepper-step-inner {
        transform: scale(0.98) !important;
      }

      /* Step card */
      .registration-stepper-step-inner {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        border-radius: 14px;
        padding: 10px 12px;
        height: 100%;
        transition: transform .22s ease, background-color .2s ease, border-color .2s ease, box-shadow .2s ease;
        border: 1px solid rgba(226, 232, 240, 0.85);
        background: rgba(255, 255, 255, 0.55);
      }

      @media (hover: hover) and (pointer: fine) {
        .registration-stepper-step.is-clickable:hover .registration-stepper-step-inner {
          background: rgba(255, 255, 255, 0.9);
          border-color: rgba(148, 163, 184, 0.45);
          box-shadow: 0 8px 22px -14px rgba(15, 23, 42, 0.35);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          transform: translateY(-2px);
        }
      }

      .registration-stepper-step.is-current-step .registration-stepper-step-inner {
        border-color: rgba(26, 86, 219, 0.28);
        background: rgba(242, 244, 248, 0.88);
        box-shadow: 0 0 0 2px rgba(26, 86, 219, 0.08), 0 4px 16px -8px rgba(26, 86, 219, 0.2);
      }

      .registration-stepper-step:focus-visible {
        box-shadow: 0 0 0 2px rgba(26, 86, 219, 0.3);
        border-radius: 14px;
      }

      /* Circle */
      .registration-stepper-circle {
        position: relative;
        flex: 0 0 auto;
        width: clamp(28px, 2.5vw, 32px);
        height: clamp(28px, 2.5vw, 32px);
        border-radius: 999px;
        border: 1px solid rgba(26, 86, 219, 0.3);
        background: var(--rs-accent-soft);
        color: var(--rs-accent);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform .22s ease, box-shadow .22s ease, border-color .22s ease, background-color .22s ease;
        margin-top: 1px;
      }

      .registration-stepper-step.is-completed .registration-stepper-circle {
        background: var(--rs-success);
        border-color: var(--rs-success);
        color: #fff;
      }

      .registration-stepper-step.is-current-step .registration-stepper-circle {
        background: var(--rs-accent);
        border-color: var(--rs-accent);
        color: #fff;
        transform: scale(1.08);
        box-shadow: 0 0 0 5px rgba(26, 86, 219, 0.16), 0 8px 16px -10px rgba(26, 86, 219, 0.65);
      }

      .registration-stepper-step.is-locked .registration-stepper-circle {
        background: rgba(255,255,255,0.08);
        border-color: #e4e7ee;
        color: var(--rs-muted);
      }

      .registration-stepper-step.is-waiting .registration-stepper-circle {
        background: #fff;
        border-color: #e4e7ee;
        color: var(--rs-muted);
      }

      .registration-stepper-step.is-action_required .registration-stepper-circle {
        background: #fff7ed;
        border-color: #e5a630;
        color: #8a6316;
      }

      /* Step body */
      .registration-stepper-step-body {
        min-width: 0;
        flex: 1;
      }

      .registration-stepper-title-row {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: wrap;
        line-height: 1;
      }

      .registration-stepper-title {
        margin: 0;
        font-size: clamp(11px, 1.05vw, 12px);
        font-weight: 720;
        line-height: 1.25;
        color: var(--rs-text);
      }

      .registration-stepper-step.is-current-step .registration-stepper-title {
        font-weight: 790;
      }

      .registration-stepper-step.is-locked .registration-stepper-title {
        color: var(--rs-muted);
      }

      .registration-stepper-current-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 7px;
        font-size: 10px;
        font-weight: 700;
        background: var(--rs-accent-soft);
        color: var(--rs-accent);
        border: 1px solid rgba(26, 86, 219, 0.2);
        white-space: nowrap;
        line-height: 1.4;
        flex-shrink: 0;
      }

      .registration-stepper-desc {
        margin: 3px 0 0;
        font-size: clamp(10px, 0.9vw, 11px);
        line-height: 1.3;
        color: var(--rs-subtext);
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .registration-stepper-step.is-locked .registration-stepper-desc {
        color: var(--rs-muted);
      }

      /* Icons */
      .registration-stepper-icon {
        width: 14px;
        height: 14px;
        display: block;
      }

      .registration-stepper-icon.stroke {
        fill: none;
        stroke: currentColor;
        stroke-width: 2.2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .registration-stepper-icon.dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: currentColor;
      }

      .registration-stepper-spinner {
        width: 13px;
        height: 13px;
        border-radius: 999px;
        border: 2px solid rgba(100, 116, 139, 0.3);
        border-top-color: currentColor;
        animation: registrationStepperSpin .9s linear infinite;
      }

      /* Tooltip (desktop hover only) */
      .registration-stepper-tooltip {
        position: absolute;
        left: 50%;
        top: calc(100% + 8px);
        transform: translate(-50%, 4px);
        z-index: 10;
        min-width: 180px;
        max-width: 270px;
        background: #0c1222;
        color: #e4e7ee;
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 11px;
        line-height: 1.4;
        opacity: 0;
        pointer-events: none;
        transition: opacity .18s ease, transform .18s ease;
        box-shadow: 0 14px 28px -20px rgba(12, 18, 34, 0.9);
        white-space: normal;
      }

      .registration-stepper-tooltip strong {
        display: block;
        margin-bottom: 3px;
        color: #fff;
        font-size: 11px;
      }

      @media (hover: hover) and (pointer: fine) {
        .registration-stepper-step:hover .registration-stepper-tooltip,
        .registration-stepper-step:focus-visible .registration-stepper-tooltip {
          opacity: 1;
          transform: translate(-50%, 0);
        }
      }

      /* Ripple */
      .registration-stepper-ripple {
        position: absolute;
        inset: 0;
        border-radius: 14px;
        background: rgba(26, 86, 219, 0.14);
        transform: scale(.75);
        opacity: 0;
        pointer-events: none;
      }

      .registration-stepper-step.is-rippling .registration-stepper-ripple {
        animation: registrationStepperRipple .28s ease;
      }

      @keyframes registrationStepperRipple {
        0% { transform: scale(.75); opacity: .65; }
        100% { transform: scale(1.02); opacity: 0; }
      }

      @keyframes registrationStepperSpin {
        to { transform: rotate(360deg); }
      }

      /* Mobile */
      @media (max-width: 860px) {
        .registration-stepper-viewport {
          overflow-x: auto;
          scrollbar-width: none;
          scroll-snap-type: x mandatory;
        }

        .registration-stepper-viewport::-webkit-scrollbar {
          display: none;
        }

        .registration-stepper-track {
          width: max-content;
          min-width: 100%;
          padding-inline: 10px;
        }

        .registration-stepper-step {
          flex: 0 0 min(76vw, 250px);
          max-width: min(76vw, 250px);
        }

        .registration-stepper.is-fit .registration-stepper-viewport {
          overflow-x: hidden;
          scroll-snap-type: none;
        }

        .registration-stepper.is-fit .registration-stepper-track {
          width: 100%;
        }

        .registration-stepper.is-fit .registration-stepper-step {
          flex: 1 1 0;
          max-width: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createIcon(status, index) {
    const wrap = document.createElement("span");
    wrap.className = "registration-stepper-icon-wrap";

    if (status === "completed") {
      wrap.innerHTML = '<svg class="registration-stepper-icon stroke" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 4.5L6.5 11 3 7.5"></path></svg>';
      return wrap;
    }

    if (status === "locked") {
      wrap.innerHTML = '<svg class="registration-stepper-icon stroke" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6" rx="1.4"></rect><path d="M5.5 7V5.8a2.5 2.5 0 1 1 5 0V7"></path></svg>';
      return wrap;
    }

    if (status === "waiting") {
      const spinner = document.createElement("span");
      spinner.className = "registration-stepper-spinner";
      spinner.setAttribute("aria-hidden", "true");
      wrap.appendChild(spinner);
      return wrap;
    }

    if (status === "action_required") {
      wrap.innerHTML = '<svg class="registration-stepper-icon stroke" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.8l5 9H3z"></path><path d="M8 6v3.1"></path><path d="M8 11.9h.01"></path></svg>';
      return wrap;
    }

    if (status === "current") {
      const dot = document.createElement("span");
      dot.className = "registration-stepper-icon dot";
      dot.setAttribute("aria-hidden", "true");
      wrap.appendChild(dot);
      return wrap;
    }

    const num = document.createElement("span");
    num.textContent = String(index + 1);
    num.style.fontSize = "11px";
    num.style.fontWeight = "800";
    num.setAttribute("aria-hidden", "true");
    wrap.appendChild(num);
    return wrap;
  }

  function isClickable(step, status) {
    if (typeof step.interactive === "boolean") return step.interactive;
    return status === "completed" || status === "current";
  }

  function showFallbackToast(message) {
    if (window.GPToast && typeof window.GPToast.show === "function") {
      window.GPToast.show(message);
      return;
    }
    const existing = document.getElementById("gp-stepper-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = "gp-stepper-toast";
    toast.textContent = message;
    toast.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);padding:10px 14px;border-radius:10px;background:rgba(12,18,34,.94);color:#fff;font-size:12px;font-weight:700;z-index:10000;box-shadow:0 14px 30px -20px rgba(12,18,34,.9);font-family:'DM Sans',-apple-system,sans-serif;";
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity .22s ease";
      setTimeout(() => toast.remove(), 240);
    }, 1800);
  }

  function syncProgressLine(track) {
    const steps = Array.from(track.querySelectorAll(".registration-stepper-step"));
    if (!steps.length) return;

    const circles = steps
      .map((step) => step.querySelector(".registration-stepper-circle"))
      .filter(Boolean);
    if (!circles.length) return;

    const trackBox = track.getBoundingClientRect();
    const centers = circles.map((circle) => {
      const box = circle.getBoundingClientRect();
      return (box.left + box.width / 2) - trackBox.left;
    });

    const first = centers[0];
    const last = centers[centers.length - 1];
    let targetIndex = steps.findIndex((step) => step.classList.contains("is-current-step"));
    if (targetIndex === -1) {
      targetIndex = Math.max(0, steps.reduce((acc, step, idx) => (step.classList.contains("is-completed") ? idx : acc), 0));
    }

    // Fill stops at the LEFT edge of the current step's circle (does not enter it)
    const targetCircle = circles[Math.min(targetIndex, circles.length - 1)];
    const targetCircleBox = targetCircle.getBoundingClientRect();
    const targetLeft = targetCircleBox.left - trackBox.left;

    // Compute vertical center of first circle for accurate line placement
    const firstCircleBox = circles[0].getBoundingClientRect();
    const circleTop = (firstCircleBox.top + firstCircleBox.height / 2) - trackBox.top;

    track.style.setProperty("--rs-line-start", `${first}px`);
    track.style.setProperty("--rs-line-width", `${Math.max(0, last - first)}px`);
    track.style.setProperty("--rs-fill-width", `${Math.max(0, targetLeft - first)}px`);
    track.style.setProperty("--rs-line-top", `${circleTop}px`);
  }

  function syncViewportHints(root, viewport, wrap) {
    const canScroll = viewport.scrollWidth > viewport.clientWidth + 1;
    const atStart = viewport.scrollLeft <= 2;
    const atEnd = viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 2;
    wrap.classList.toggle("has-left-fade", canScroll && !atStart);
    wrap.classList.toggle("has-right-fade", canScroll && !atEnd);
    root.classList.toggle("is-fit", !canScroll);
  }

  function centerCurrentStep(viewport, currentStep, smooth) {
    if (!currentStep) return;
    if (!window.matchMedia || !window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches) return;
    if (viewport.scrollWidth <= viewport.clientWidth + 1) return;
    const viewportBox = viewport.getBoundingClientRect();
    const stepBox = currentStep.getBoundingClientRect();
    const target = viewport.scrollLeft + (stepBox.left + stepBox.width / 2) - (viewportBox.left + viewportBox.width / 2);
    viewport.scrollTo({ left: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
  }

  function bindLayoutSync(root, viewport, wrap, track, currentStep) {
    const oldState = CONTAINER_STATE.get(root);
    if (oldState && typeof oldState.cleanup === "function") {
      oldState.cleanup();
    }

    let rafId = 0;
    const sync = (smoothScroll) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncProgressLine(track);
        syncViewportHints(root, viewport, wrap);
        centerCurrentStep(viewport, currentStep, smoothScroll);
      });
    };

    const onResize = () => sync(false);
    const onScroll = () => syncViewportHints(root, viewport, wrap);

    window.addEventListener("resize", onResize);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => sync(false)).catch(() => {});
    }

    sync(false);
    requestAnimationFrame(() => sync(true));

    CONTAINER_STATE.set(root, {
      cleanup: function () {
        cancelAnimationFrame(rafId);
        window.removeEventListener("resize", onResize);
        viewport.removeEventListener("scroll", onScroll);
      }
    });
  }

  function render(config) {
    const root = config && config.container;
    const steps = config && Array.isArray(config.steps) ? config.steps : [];
    if (!(root instanceof HTMLElement)) return;

    ensureStyles();
    root.innerHTML = "";
    root.className = "registration-stepper";
    root.setAttribute("role", "tablist");
    root.setAttribute("aria-label", config.ariaLabel || "Registration step navigation");

    const wrap = document.createElement("div");
    wrap.className = "registration-stepper-viewport-wrap";
    const viewport = document.createElement("div");
    viewport.className = "registration-stepper-viewport";
    const track = document.createElement("div");
    track.className = "registration-stepper-track";

    const line = document.createElement("span");
    line.className = "registration-stepper-line";
    const lineFill = document.createElement("span");
    lineFill.className = "registration-stepper-line-fill";
    line.appendChild(lineFill);
    track.appendChild(line);

    const buttonRefs = [];

    steps.forEach((step, index) => {
      const status = String(step.status || "locked");
      const isCurrentStep = !!step.current;
      const clickable = isClickable(step, status);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `registration-stepper-step is-${status} ${isCurrentStep ? "is-current-step" : ""} ${clickable ? "is-clickable" : ""}`.trim();
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", isCurrentStep ? "true" : "false");
      button.setAttribute("aria-current", isCurrentStep ? "step" : "false");
      button.setAttribute("aria-label", `${step.title || "Step"}. ${status.replace("_", " ")}. ${step.description || ""}`.trim());
      if (!clickable) button.setAttribute("aria-disabled", "true");
      button.dataset.stepId = String(step.id || "");
      button.tabIndex = isCurrentStep ? 0 : -1;

      const inner = document.createElement("span");
      inner.className = "registration-stepper-step-inner";

      // Circle icon (left side of card)
      const circle = document.createElement("span");
      circle.className = "registration-stepper-circle";
      circle.appendChild(createIcon(status, index));

      // Text body (right side of card)
      const body = document.createElement("span");
      body.className = "registration-stepper-step-body";

      const titleRow = document.createElement("span");
      titleRow.className = "registration-stepper-title-row";

      const title = document.createElement("p");
      title.className = "registration-stepper-title";
      title.textContent = step.title || `Step ${index + 1}`;
      titleRow.appendChild(title);

      if (isCurrentStep) {
        const badge = document.createElement("span");
        badge.className = "registration-stepper-current-badge";
        badge.textContent = "Current";
        titleRow.appendChild(badge);
      }

      body.appendChild(titleRow);

      if (step.description) {
        const desc = document.createElement("p");
        desc.className = "registration-stepper-desc";
        desc.textContent = step.description;
        body.appendChild(desc);
      }

      inner.appendChild(circle);
      inner.appendChild(body);

      // Tooltip (shown on desktop hover via CSS)
      if (step.title || step.description) {
        const tooltip = document.createElement("span");
        tooltip.className = "registration-stepper-tooltip";
        const escHtml = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        tooltip.innerHTML = `<strong>${escHtml(step.title || "Step")}</strong>${escHtml(step.description || "")}`;
        inner.appendChild(tooltip);
      }

      // Ripple overlay
      const ripple = document.createElement("span");
      ripple.className = "registration-stepper-ripple";
      inner.appendChild(ripple);
      button.appendChild(inner);

      button.addEventListener("click", () => {
        button.classList.remove("is-rippling");
        void button.offsetWidth;
        button.classList.add("is-rippling");
        if (!clickable) {
          if (typeof config.onLockedStep === "function") {
            config.onLockedStep(step);
          } else {
            showFallbackToast("Complete the previous step to unlock this.");
          }
          return;
        }
        if (typeof config.onStepSelect === "function") {
          config.onStepSelect(step);
        }
      });

      button.addEventListener("keydown", (event) => {
        const key = event.key;
        const currentIndex = buttonRefs.indexOf(button);
        if (key === "ArrowRight") {
          event.preventDefault();
          const target = buttonRefs[currentIndex + 1] || buttonRefs[0];
          if (target) target.focus();
          return;
        }
        if (key === "ArrowLeft") {
          event.preventDefault();
          const target = buttonRefs[currentIndex - 1] || buttonRefs[buttonRefs.length - 1];
          if (target) target.focus();
          return;
        }
        if (key === "Home") {
          event.preventDefault();
          if (buttonRefs[0]) buttonRefs[0].focus();
          return;
        }
        if (key === "End") {
          event.preventDefault();
          const target = buttonRefs[buttonRefs.length - 1];
          if (target) target.focus();
          return;
        }
        if (key === "Enter" || key === " ") {
          event.preventDefault();
          button.click();
        }
      });

      track.appendChild(button);
      buttonRefs.push(button);
    });

    viewport.appendChild(track);
    wrap.appendChild(viewport);
    root.appendChild(wrap);

    const currentButton = track.querySelector('.registration-stepper-step[aria-current="step"]')
      || track.querySelector(".registration-stepper-step");

    bindLayoutSync(root, viewport, wrap, track, currentButton);
  }

  window.GPRegistrationStepper = { render: render };
})();
