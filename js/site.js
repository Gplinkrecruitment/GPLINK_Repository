/* ==========================================================================
   GP Link marketing site - shared behaviours
   Auto-initializes on DOMContentLoaded. Exposes window.GPSite for
   page-local scripts (job search form, enquiry forms) to hook into.
   Framework-free, no external imports - matches js/auth-guard.js idiom.
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
    // Auto-stagger: children of a [data-stagger] container inherit an
    // incremental transition delay so grids cascade without dl1-4 classes.
    document.querySelectorAll("[data-stagger]").forEach(function (group) {
      var kids = group.querySelectorAll(":scope > .reveal");
      var step = Number(group.getAttribute("data-stagger")) || 90;
      kids.forEach(function (el, i) {
        el.style.transitionDelay = Math.min(i * step, 600) + "ms";
      });
    });

    var els = document.querySelectorAll(".reveal, .img-reveal");
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

  // ---------- split-word headline rise ----------
  function initSplitWords() {
    var els = document.querySelectorAll("[data-split]");
    if (!els.length || reduceMotion) return;

    els.forEach(function (el) {
      var text = el.textContent;
      var words = text.split(/\s+/).filter(Boolean);
      if (!words.length) return;
      el.setAttribute("aria-label", text.replace(/\s+/g, " ").trim());
      var base = Number(el.getAttribute("data-split")) || 0.12;
      el.classList.add("split-words");
      el.innerHTML = words.map(function (w, i) {
        var safe = w.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        var delay = (base + i * 0.055).toFixed(3);
        return '<span class="w" aria-hidden="true"><span style="--wd:' + delay + 's">' + safe + "</span></span>";
      }).join(" ");
    });
  }

  // ---------- parallax ----------
  // [data-parallax="0.2"] drifts at 20% of scroll speed around its resting
  // spot. transform-only; optional data-parallax-scale keeps cover images
  // overscanned so drift never exposes edges.
  function initParallax() {
    if (reduceMotion) return;
    var els = Array.prototype.slice.call(document.querySelectorAll("[data-parallax]"));
    if (!els.length || typeof IntersectionObserver === "undefined") return;

    var items = els.map(function (el) {
      return {
        el: el,
        speed: parseFloat(el.getAttribute("data-parallax")) || 0.2,
        scale: parseFloat(el.getAttribute("data-parallax-scale")) || 0,
        vis: true
      };
    });

    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].el === entry.target) items[i].vis = entry.isIntersecting;
        }
      });
    }, { rootMargin: "25% 0px 25% 0px" });
    items.forEach(function (it) { vio.observe(it.el); });

    var ticking = false;
    function apply() {
      ticking = false;
      var vh = window.innerHeight || 1;
      items.forEach(function (it) {
        if (!it.vis) return;
        var host = it.el.parentElement || it.el;
        var r = host.getBoundingClientRect();
        var mid = r.top + r.height / 2 - vh / 2;
        var y = Math.round(-mid * it.speed * 100) / 100;
        it.el.style.transform = "translate3d(0," + y + "px,0)" + (it.scale ? " scale(" + it.scale + ")" : "");
      });
    }
    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(apply);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    apply();
  }

  // ---------- scroll progress bar ----------
  function initScrollProgress() {
    if (reduceMotion) return;
    var bar = document.createElement("div");
    bar.className = "scroll-progress";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);

    var ticking = false;
    function apply() {
      ticking = false;
      var doc = document.documentElement;
      var max = (doc.scrollHeight - window.innerHeight) || 1;
      var p = Math.min(Math.max((window.scrollY || 0) / max, 0), 1);
      bar.style.transform = "scaleX(" + p.toFixed(4) + ")";
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(apply); }
    }, { passive: true });
    apply();
  }

  // ---------- page-transition veil ----------
  // Internal navigations wipe a brand gradient up over the page, then
  // navigate; the next page fades in via the shared body animation.
  function initPageVeil() {
    if (reduceMotion) return;
    var veil = document.createElement("div");
    veil.className = "page-veil";
    veil.setAttribute("aria-hidden", "true");
    document.body.appendChild(veil);

    document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.hasAttribute("data-no-veil")) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;
      var url;
      try { url = new URL(a.href, window.location.href); } catch (err) { return; }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.hash) return;

      e.preventDefault();
      veil.classList.add("cover");
      setTimeout(function () { window.location.href = url.href; }, 430);
    });

    // Back/forward cache restores the old page with the veil still up.
    window.addEventListener("pageshow", function (ev) {
      if (ev.persisted) veil.classList.remove("cover");
    });
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
        var dur = 1600;
        var t0 = null;

        function step(ts) {
          // Re-read the target from the attribute on every frame so a
          // mid-animation update (e.g. live stats arriving from the API)
          // retargets smoothly instead of being stomped by a stale closure.
          var target = Number(el.getAttribute("data-count")) || 0;
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
      ["q", "state", "billing"].forEach(function (key) {
        var val = (data.get(key) || "").toString().trim();
        if (val) params.set(key, val);
      });
      // `type` (vr-gp / non-vr-gp / locum) no longer has a control on any page,
      // but the API still honours it and old links still carry it. FormData
      // cannot see a field that isn't rendered, so carry it across from the
      // current URL instead — otherwise arriving on /jobs?type=locum and then
      // pressing Search would silently widen the results.
      var carriedType = (new URLSearchParams(window.location.search).get("type") || "").trim();
      if (carriedType && !formEl.querySelector('[name="type"]')) params.set("type", carriedType);
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
      "<h4>Thanks, we've got it</h4>" +
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
            "Something went wrong sending that. Please try again.";
        }
      }).catch(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
        errorEl = findOrCreateErrorEl(formEl);
        errorEl.textContent = "Something went wrong sending that. Please try again.";
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
    initSplitWords();
    initReveal();
    initCountUp();
    initFaqAccordion();
    initParallax();
    initScrollProgress();
    initPageVeil();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
