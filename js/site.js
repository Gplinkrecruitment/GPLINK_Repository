/* ==========================================================================
   GP Link marketing site — shared behaviours
   Auto-initializes on DOMContentLoaded. Exposes window.GPSite for
   page-local scripts (job search form, enquiry forms) to hook into.
   Framework-free, no external imports — matches js/auth-guard.js idiom.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {
    reduceMotion = false;
  }

  // ---------- header scroll state ----------
  function initHeaderScroll() {
    var header = document.getElementById("siteHeader") || document.querySelector(".site-header");
    if (!header) return;

    function update() {
      var y = window.scrollY || window.pageYOffset || 0;
      header.classList.toggle("scrolled", y > 24);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
  }

  // ---------- mobile menu ----------
  function initMobileMenu() {
    var btn = document.getElementById("siteMenuBtn") || document.querySelector(".site-menu-btn");
    var panel = document.getElementById("siteMobileMenu") || document.querySelector(".site-mobile-menu");
    if (!btn || !panel) return;

    btn.setAttribute("aria-expanded", "false");

    function closeMenu() {
      panel.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
    function openMenu() {
      panel.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    }
    function toggleMenu() {
      if (panel.classList.contains("open")) {
        closeMenu();
      } else {
        openMenu();
      }
    }

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      toggleMenu();
    });

    // Close the panel when a link inside it is used to navigate.
    panel.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (a) closeMenu();
    });
  }

  // ---------- scroll reveal ----------
  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;

    if (reduceMotion || typeof IntersectionObserver === "undefined") {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: .16, rootMargin: "0px 0px -6% 0px" });

    els.forEach(function (el) { io.observe(el); });
  }

  // ---------- count-up stats ----------
  function initCountUp() {
    var els = document.querySelectorAll("[data-count]");
    if (!els.length) return;

    function finish(el) {
      var target = Number(el.getAttribute("data-count")) || 0;
      el.textContent = target.toLocaleString();
    }

    if (reduceMotion || typeof IntersectionObserver === "undefined") {
      els.forEach(finish);
      return;
    }

    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        cio.unobserve(entry.target);
        var el = entry.target;
        var target = Number(el.getAttribute("data-count")) || 0;
        var dur = 1600;
        var t0 = null;

        function step(ts) {
          if (!t0) t0 = ts;
          var p = Math.min((ts - t0) / dur, 1);
          p = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * p).toLocaleString();
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
    }, { threshold: .6 });

    els.forEach(function (el) { cio.observe(el); });
  }

  // ---------- FAQ accordion ----------
  function initFaqAccordion() {
    document.addEventListener("click", function (e) {
      var q = e.target && e.target.closest ? e.target.closest(".faq-q") : null;
      if (!q) return;
      e.preventDefault();

      var item = q.closest(".faq-item");
      if (!item) return;
      var group = item.parentElement;
      var willOpen = !item.classList.contains("open");

      if (group) {
        var siblings = group.querySelectorAll(":scope > .faq-item");
        siblings.forEach(function (sib) {
          if (sib !== item) sib.classList.remove("open");
        });
      }

      item.classList.toggle("open", willOpen);
    });
  }

  // ---------- toast ----------
  var toastHideTimer = null;
  function toast(msg) {
    var el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = String(msg == null ? "" : msg);
    el.classList.add("show");
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 6000);
  }

  // ---------- job search form ----------
  function initJobSearch(formEl) {
    if (!formEl) return;
    formEl.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var data = new FormData(formEl);
      var params = new URLSearchParams();
      ["q", "state", "type"].forEach(function (key) {
        var val = (data.get(key) || "").toString().trim();
        if (val) params.set(key, val);
      });
      var qs = params.toString();
      window.location.href = "/jobs" + (qs ? "?" + qs : "");
    });
  }

  // ---------- enquiry form ----------
  function buildThanksPanel() {
    var wrap = document.createElement("div");
    wrap.className = "site-thanks";
    wrap.innerHTML =
      '<div class="ok">✓</div>' +
      "<h4>Thanks — we've got it</h4>" +
      "<p>Someone from the GP Link team will be in touch shortly.</p>";
    return wrap;
  }

  function findOrCreateErrorEl(formEl) {
    var el = formEl.querySelector(".site-field .error, .form-error");
    if (el) return el;
    el = document.createElement("p");
    el.className = "error";
    formEl.appendChild(el);
    return el;
  }

  function bindEnquiryForm(formEl) {
    if (!formEl) return;
    formEl.addEventListener("submit", function (ev) {
      ev.preventDefault();

      var submitBtn = formEl.querySelector('button[type="submit"], .site-submit');
      var errorEl = null;

      var honeypotInput = formEl.querySelector('input[name="website"]');
      var payload = { kind: formEl.dataset.kind || "general" };
      var data = new FormData(formEl);
      data.forEach(function (value, key) {
        if (key === "kind") return;
        payload[key] = typeof value === "string" ? value : "";
      });

      var originalLabel = submitBtn ? submitBtn.textContent : "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Sending…";
      }
      if (errorEl) errorEl.textContent = "";

      fetch("/api/public/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          return { ok: res.ok && json && json.ok === true, json: json || {} };
        });
      }).then(function (result) {
        if (result.ok) {
          formEl.innerHTML = "";
          formEl.appendChild(buildThanksPanel());
        } else {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
          }
          errorEl = findOrCreateErrorEl(formEl);
          errorEl.textContent = (result.json && result.json.error) ||
            "Something went wrong sending that — please try again.";
        }
      }).catch(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
        errorEl = findOrCreateErrorEl(formEl);
        errorEl.textContent = "Something went wrong sending that — please try again.";
      });
    });
  }

  window.GPSite = {
    initJobSearch: initJobSearch,
    bindEnquiryForm: bindEnquiryForm,
    toast: toast
  };

  function init() {
    initHeaderScroll();
    initMobileMenu();
    initReveal();
    initCountUp();
    initFaqAccordion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
