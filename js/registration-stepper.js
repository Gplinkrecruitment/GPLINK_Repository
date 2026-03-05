(function () {
  const STYLE_ID = "gp-registration-stepper-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .registration-stepper {
        --rs-accent: #2563eb;
        --rs-accent-soft: #dbeafe;
        --rs-success: #16a34a;
        --rs-success-soft: #dcfce7;
        --rs-warning: #d97706;
        --rs-warning-soft: #fef3c7;
        --rs-muted: #94a3b8;
        --rs-muted-soft: #e2e8f0;
        --rs-text: #0f172a;
        --rs-subtext: #64748b;
        display: flex;
        align-items: flex-start;
        gap: 0;
        width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 2px 2px 6px;
        scroll-behavior: smooth;
        -webkit-overflow-scrolling: touch;
      }

      .registration-stepper::-webkit-scrollbar {
        height: 6px;
      }

      .registration-stepper::-webkit-scrollbar-thumb {
        background: rgba(148, 163, 184, 0.35);
        border-radius: 999px;
      }

      .registration-stepper-step {
        position: relative;
        flex: 0 0 176px;
        min-width: 176px;
        max-width: 210px;
        border: 0;
        background: transparent;
        color: var(--rs-text);
        padding: 0;
        margin: 0;
        text-align: left;
        cursor: pointer;
        outline: none;
      }

      .registration-stepper-step[disabled] {
        cursor: not-allowed;
      }

      .registration-stepper-step-inner {
        position: relative;
        display: grid;
        gap: 8px;
        border-radius: 14px;
        padding: 8px 8px 10px;
        transition: transform .25s ease, box-shadow .25s ease, background-color .25s ease;
      }

      .registration-stepper-step:hover:not([disabled]) .registration-stepper-step-inner,
      .registration-stepper-step:focus-visible:not([disabled]) .registration-stepper-step-inner {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px -18px rgba(15, 23, 42, 0.6);
        background: rgba(248, 250, 252, 0.8);
      }

      .registration-stepper-step.is-current .registration-stepper-step-inner {
        background: rgba(239, 246, 255, 0.75);
      }

      .registration-stepper-step-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .registration-stepper-circle {
        position: relative;
        width: 26px;
        height: 26px;
        border-radius: 999px;
        border: 1px solid #bfdbfe;
        background: #eff6ff;
        color: #1d4ed8;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        transition: all .25s ease;
      }

      .registration-stepper-step:hover:not([disabled]) .registration-stepper-circle {
        transform: scale(1.06);
      }

      .registration-stepper-title {
        font-size: 12px;
        font-weight: 760;
        line-height: 1.2;
        letter-spacing: -0.01em;
        color: var(--rs-text);
      }

      .registration-stepper-desc {
        font-size: 11px;
        line-height: 1.3;
        color: var(--rs-subtext);
      }

      .registration-stepper-step.is-completed .registration-stepper-circle {
        background: var(--rs-success);
        border-color: var(--rs-success);
        color: #ffffff;
      }

      .registration-stepper-step.is-current .registration-stepper-circle {
        width: 30px;
        height: 30px;
        background: #ffffff;
        border-color: #60a5fa;
        color: #2563eb;
        box-shadow: 0 0 0 5px rgba(147, 197, 253, 0.38), 0 10px 20px -16px rgba(37, 99, 235, 0.95);
      }

      .registration-stepper-step.is-locked .registration-stepper-circle {
        background: #f8fafc;
        border-color: #e2e8f0;
        color: #94a3b8;
      }

      .registration-stepper-step.is-waiting .registration-stepper-circle {
        background: #f8fafc;
        border-color: #cbd5e1;
        color: #475569;
      }

      .registration-stepper-step.is-action_required .registration-stepper-circle {
        background: var(--rs-warning-soft);
        border-color: #f59e0b;
        color: #b45309;
      }

      .registration-stepper-step.is-locked .registration-stepper-title,
      .registration-stepper-step.is-locked .registration-stepper-desc {
        color: #94a3b8;
      }

      .registration-stepper-step:focus-visible .registration-stepper-step-inner {
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.45);
      }

      .registration-stepper-line {
        position: relative;
        align-self: flex-start;
        margin-top: 20px;
        height: 2px;
        width: 36px;
        flex: 0 0 36px;
        border-radius: 999px;
        background: var(--rs-muted-soft);
        overflow: hidden;
      }

      .registration-stepper-line-fill {
        position: absolute;
        inset: 0;
        transform-origin: left;
        transform: scaleX(0);
        background: linear-gradient(90deg, #60a5fa, #2563eb);
        transition: transform .25s ease;
      }

      .registration-stepper-line.is-filled .registration-stepper-line-fill {
        transform: scaleX(1);
      }

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
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: currentColor;
      }

      .registration-stepper-spinner {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        border: 2px solid rgba(100, 116, 139, 0.35);
        border-top-color: currentColor;
        animation: registrationStepperSpin .9s linear infinite;
      }

      .registration-stepper-tooltip {
        position: absolute;
        left: 8px;
        top: calc(100% + 4px);
        z-index: 5;
        min-width: 170px;
        max-width: 220px;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 10px;
        padding: 8px 9px;
        font-size: 11px;
        line-height: 1.35;
        opacity: 0;
        transform: translateY(2px);
        pointer-events: none;
        transition: opacity .18s ease, transform .18s ease;
        box-shadow: 0 16px 32px -26px rgba(2, 6, 23, 0.95);
      }

      .registration-stepper-tooltip strong {
        display: block;
        margin-bottom: 2px;
        color: #ffffff;
        font-size: 11px;
      }

      .registration-stepper-step:hover .registration-stepper-tooltip,
      .registration-stepper-step:focus-visible .registration-stepper-tooltip {
        opacity: 1;
        transform: translateY(0);
      }

      .registration-stepper-ripple {
        position: absolute;
        inset: 0;
        border-radius: 14px;
        background: rgba(59, 130, 246, 0.18);
        transform: scale(.7);
        opacity: 0;
        pointer-events: none;
      }

      .registration-stepper-step.is-rippling .registration-stepper-ripple {
        animation: registrationStepperRipple .28s ease;
      }

      @keyframes registrationStepperRipple {
        0% { transform: scale(.7); opacity: .7; }
        100% { transform: scale(1.02); opacity: 0; }
      }

      @keyframes registrationStepperSpin {
        to { transform: rotate(360deg); }
      }

      @media (max-width: 760px) {
        .registration-stepper-step {
          flex-basis: 160px;
          min-width: 160px;
        }

        .registration-stepper-title {
          font-size: 11px;
        }

        .registration-stepper-desc {
          font-size: 10px;
        }

        .registration-stepper-line {
          width: 24px;
          flex-basis: 24px;
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

  function createLine(isFilled) {
    const line = document.createElement("span");
    line.className = "registration-stepper-line";
    const fill = document.createElement("span");
    fill.className = "registration-stepper-line-fill";
    line.appendChild(fill);
    if (isFilled) {
      requestAnimationFrame(() => {
        line.classList.add("is-filled");
      });
    }
    return line;
  }

  function isClickable(step, status) {
    if (typeof step.interactive === "boolean") return step.interactive;
    return status === "completed" || status === "current";
  }

  function render(config) {
    const container = config && config.container;
    const steps = config && Array.isArray(config.steps) ? config.steps : [];
    if (!(container instanceof HTMLElement)) return;

    ensureStyles();
    container.innerHTML = "";
    container.className = "registration-stepper";
    container.setAttribute("role", "tablist");
    container.setAttribute("aria-label", config.ariaLabel || "Registration step navigation");

    const buttonRefs = [];

    steps.forEach((step, index) => {
      const status = String(step.status || "locked");
      const isCurrentStep = !!step.current;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `registration-stepper-step is-${status}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", isCurrentStep ? "true" : "false");
      button.setAttribute("aria-current", isCurrentStep ? "step" : "false");
      button.setAttribute("aria-label", `${step.title || "Step"}. ${status.replace("_", " ")}. ${step.description || ""}`.trim());
      button.dataset.stepId = String(step.id || "");
      button.tabIndex = isCurrentStep ? 0 : -1;
      if (!isClickable(step, status)) button.disabled = true;

      const inner = document.createElement("span");
      inner.className = "registration-stepper-step-inner";

      const row = document.createElement("span");
      row.className = "registration-stepper-step-row";

      const circle = document.createElement("span");
      circle.className = "registration-stepper-circle";
      circle.appendChild(createIcon(status, index));

      const title = document.createElement("span");
      title.className = "registration-stepper-title";
      title.textContent = step.title || `Step ${index + 1}`;

      row.appendChild(circle);
      row.appendChild(title);
      inner.appendChild(row);

      if (step.description) {
        const desc = document.createElement("span");
        desc.className = "registration-stepper-desc";
        desc.textContent = step.description;
        inner.appendChild(desc);
      }

      if (step.title || step.description) {
        const tooltip = document.createElement("span");
        tooltip.className = "registration-stepper-tooltip";
        tooltip.innerHTML = `<strong>${step.title || "Step"}</strong>${step.description || ""}`;
        inner.appendChild(tooltip);
      }

      const ripple = document.createElement("span");
      ripple.className = "registration-stepper-ripple";
      inner.appendChild(ripple);

      button.appendChild(inner);

      button.addEventListener("click", () => {
        if (!isClickable(step, status)) return;
        button.classList.remove("is-rippling");
        void button.offsetWidth;
        button.classList.add("is-rippling");
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
        if ((key === "Enter" || key === " ") && isClickable(step, status)) {
          event.preventDefault();
          button.click();
        }
      });

      container.appendChild(button);
      buttonRefs.push(button);

      if (index < steps.length - 1) {
        const line = createLine(status === "completed");
        container.appendChild(line);
      }
    });

    const autoTarget = container.querySelector('.registration-stepper-step[aria-current=\"step\"]')
      || container.querySelector('.registration-stepper-step');

    if (autoTarget && typeof autoTarget.scrollIntoView === "function") {
      autoTarget.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }

  window.GPRegistrationStepper = { render: render };
})();
