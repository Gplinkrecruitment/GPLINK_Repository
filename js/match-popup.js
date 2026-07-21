/*
 * AI Matching (Task 4 of the 2026-07-06 implementation plan), GP-facing
 * one-time full-page match popup.
 *
 * Loaded once from pages/app-shell.html (the top-level shell page, not the
 * iframed content pages), after DOMContentLoaded, fetches
 * GET /api/career/matches; if there is an unseen live match, renders a
 * full-viewport takeover per docs/mockups/matching/matching-email-popup-v3.html
 * (dark hero gradient, animated falling confetti, badge, serif headline, job
 * card, why-ticks, video card, 98% stat, 5-day reserve strip, shiny animated
 * Accept, "I'll look at this later"). Only the NEWEST unseen match is ever
 * shown, never stacks. Marks the match seen on render. Accept posts
 * /api/career/match/respond then navigates the shell to /pages/career.
 *
 * Never shown to a gated account (mid-onboarding / under_review /
 * pep_waitlist / archived), enforced server-side in GET /api/career/matches
 * (which returns an empty matches list for those accounts), so this file
 * doesn't need to re-derive gating itself.
 */
(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeUrl(value) {
    var v = String(value || "").trim();
    return /^https?:\/\//i.test(v) ? v : "";
  }

  var prefersReducedMotion = false;
  try {
    prefersReducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) {}

  // ── Confetti, adapted from pages/offer-review.html's launchConfetti()      ──
  // (a one-shot ~2.8s burst) into a gently continuous loop: pieces recycle back
  // to the top once they fall past the bottom of the confetti host, rather than
  // the animation ending. Skipped entirely under prefers-reduced-motion.
  function launchLoopingConfetti(container) {
    if (prefersReducedMotion || !container) return null;
    var palette = ["#5b8cff", "#6ee7a0", "#ffd166", "#ff8fa3", "#a855f7"];
    var canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
    container.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    function resize() {
      canvas.width = container.clientWidth || 375;
      canvas.height = container.clientHeight || 600;
    }
    resize();
    window.addEventListener("resize", resize);

    function makePiece() {
      return {
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height,
        w: 5 + Math.random() * 5,
        h: 4 + Math.random() * 7,
        color: palette[Math.floor(Math.random() * palette.length)],
        vy: 0.5 + Math.random() * 1,
        vx: (Math.random() - 0.5) * 0.5,
        rotation: Math.random() * 360,
        vr: (Math.random() - 0.5) * 3.5
      };
    }
    var pieces = [];
    for (var i = 0; i < 40; i++) pieces.push(makePiece());

    var active = true;
    var rafId = null;
    function frame() {
      if (!active) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < pieces.length; i++) {
        var p = pieces[i];
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.vr;
        if (p.y > canvas.height + 20) {
          Object.assign(p, makePiece());
          p.y = -20;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
    return {
      stop: function () {
        active = false;
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener("resize", resize);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  }

  function fetchMatches() {
    return fetch("/api/career/matches", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function pickNewestUnseen(data) {
    if (!data || data.ok !== true || data.locked === true) return null;
    var matches = Array.isArray(data.matches) ? data.matches.filter(function (m) { return m && !m.seenAt; }) : [];
    if (!matches.length) return null;
    matches.sort(function (a, b) { return new Date(b.matchedAt || 0) - new Date(a.matchedAt || 0); });
    return matches[0];
  }

  function markSeen(applicationId) {
    fetch("/api/career/match/seen", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId: applicationId })
    }).catch(function () {});
  }

  function respond(applicationId, action) {
    return fetch("/api/career/match/respond", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId: applicationId, action: action })
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        return { status: r.status, body: body };
      });
    });
  }

  function navigateToCareer() {
    try {
      if (typeof window.gpShellNavigate === "function") {
        window.gpShellNavigate("/pages/career", { replace: false });
        return;
      }
    } catch (e) {}
    window.location.href = "/pages/career";
  }

  function buildOverlayHtml(match, gp) {
    var lastName = (gp && gp.lastName) || "";
    var greet = lastName ? ("Dr " + escapeHtml(lastName)) : "Doctor";
    var website = safeUrl(match.website);
    var websiteLabel = website ? website.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "";
    var introVideoUrl = safeUrl(match.introVideoUrl);
    var headerImageUrl = safeUrl(match.headerImageUrl);
    var locationLine = [match.locationCity, match.locationState].filter(Boolean).join(", ");
    var metaLine = [locationLine, match.dpa ? "DPA approved" : ""].filter(Boolean).join(" · ");
    var reasons = Array.isArray(match.reasons) ? match.reasons : [];

    var photoHtml = headerImageUrl
      ? '<div class="gpmp-photo"><img src="' + escapeHtml(headerImageUrl) + '" alt=""><div class="gpmp-cap">📍 ' + escapeHtml(locationLine || match.practiceName || "") + '</div></div>'
      : "";
    var websiteHtml = website
      ? '<a class="gpmp-weblink" href="' + escapeHtml(website) + '" target="_blank" rel="noopener">🌐 ' + escapeHtml(websiteLabel) + '</a>'
      : "";
    var reasonsHtml = reasons.length ? (
      '<div class="gpmp-why"><div class="gpmp-why-t">Why this matches you</div><ul>' +
      reasons.map(function (r) { return '<li><span class="gpmp-tick">✓</span>' + escapeHtml(r) + '</li>'; }).join("") +
      '</ul></div>'
    ) : "";
    var videoHtml = introVideoUrl ? (
      '<a class="gpmp-video" href="' + escapeHtml(introVideoUrl) + '" target="_blank" rel="noopener">' +
      '<div class="gpmp-video-thumb"><div class="gpmp-play"><span></span></div>' +
      '<div class="gpmp-video-label"><b>Meet the practice</b><br>A welcome video from the team</div></div>' +
      '</a>'
    ) : "";

    // Reserve strip derived from the row's REAL expiry (review minor): whole
    // days remaining while there's ≥2 of them, then the concrete end date.
    // Falls back to the design's default 5-day wording only when expiresAt is
    // missing/unparseable.
    var reserveInnerHtml = 'for <span class="gpmp-cd-u">5 days</span>';
    var reserveMsLeft = match.expiresAt ? new Date(match.expiresAt).getTime() - Date.now() : NaN;
    if (isFinite(reserveMsLeft) && reserveMsLeft > 0) {
      var reserveDaysLeft = Math.ceil(reserveMsLeft / 86400000);
      if (reserveDaysLeft >= 2) {
        reserveInnerHtml = 'for <span class="gpmp-cd-u">' + reserveDaysLeft + ' more days</span>';
      } else {
        var reserveUntilLabel = "";
        try {
          reserveUntilLabel = new Date(match.expiresAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
        } catch (e) {}
        reserveInnerHtml = reserveUntilLabel
          ? '<span class="gpmp-cd-u">until ' + escapeHtml(reserveUntilLabel) + '</span>'
          : 'for <span class="gpmp-cd-u">1 more day</span>';
      }
    }

    return (
      '<div class="gpmp-confetti-host"></div>' +
      '<div class="gpmp-badge">✦ Matched by your team</div>' +
      '<h1 class="gpmp-h gpmp-serif">You’ve been<br>matched, ' + greet + '</h1>' +
      '<p class="gpmp-sub">Matched to <b>' + escapeHtml(match.practiceName || "this practice") + '</b> based on your preferences, your experience, and what the practice is looking for.</p>' +
      '<div class="gpmp-job">' + photoHtml +
        '<div class="gpmp-job-inner">' +
          '<div class="gpmp-pn">' + escapeHtml(match.practiceName || "") + '</div>' +
          '<div class="gpmp-jt">' + escapeHtml(match.jobTitle || "") + '</div>' +
          (metaLine ? '<div class="gpmp-jm">' + escapeHtml(metaLine) + '</div>' : "") +
          websiteHtml +
        '</div>' +
      '</div>' +
      reasonsHtml + videoHtml +
      '<div class="gpmp-stat"><div class="gpmp-pct">98%</div><div class="gpmp-lbl"><b>of team-matched GPs are accepted by the practice.</b></div></div>' +
      '<div class="gpmp-cd">⏳ This match is reserved for you ' + reserveInnerHtml + '</div>' +
      '<button type="button" class="gpmp-accept shiny" data-gpmp-accept>Accept this match</button>' +
      '<a href="#" class="gpmp-later" data-gpmp-later>I’ll look at this later</a>'
    );
  }

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var style = document.createElement("style");
    style.id = "gp-match-popup-style";
    style.textContent = MATCH_POPUP_CSS;
    document.head.appendChild(style);
  }

  var MATCH_POPUP_CSS = [
    ".gpmp-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow-y:auto;",
    "background:var(--gp-grad-hero, linear-gradient(160deg,#0b1322 0%,#14203a 55%,#0e1a30 100%));font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;}",
    ".gpmp-card{position:relative;max-width:400px;width:100%;margin:auto;color:#fff;padding:12px 6px 30px;}",
    ".gpmp-confetti-host{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0;}",
    ".gpmp-badge{position:relative;display:table;margin:0 auto 14px;background:rgba(37,99,235,.22);border:1px solid rgba(96,148,255,.45);color:#bcd3ff;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:6px 14px;border-radius:999px;}",
    ".gpmp-h{position:relative;font-family:'Source Serif 4',Georgia,serif;font-size:28px;font-weight:700;text-align:center;line-height:1.16;margin:0 0 6px;}",
    ".gpmp-sub{position:relative;text-align:center;font-size:13px;color:rgba(226,233,246,.85);line-height:1.5;margin:0 auto 14px;max-width:300px;}",
    ".gpmp-job{position:relative;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:18px;overflow:hidden;margin-bottom:11px;}",
    ".gpmp-photo{position:relative;height:120px;overflow:hidden;}",
    ".gpmp-photo img{width:100%;height:100%;object-fit:cover;display:block;}",
    ".gpmp-cap{position:absolute;left:0;right:0;bottom:0;padding:20px 13px 8px;background:linear-gradient(transparent, rgba(11,19,34,.85));color:#fff;font-size:11.5px;font-weight:600;}",
    ".gpmp-job-inner{padding:13px 15px 14px;}",
    ".gpmp-pn{font-family:'Source Serif 4',Georgia,serif;font-size:16.5px;font-weight:700;}",
    ".gpmp-jt{font-weight:600;font-size:13px;color:rgba(226,233,246,.92);margin:1px 0;}",
    ".gpmp-jm{font-size:12px;color:rgba(226,233,246,.72);margin-bottom:7px;}",
    ".gpmp-weblink{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:#8fb3ff;text-decoration:none;}",
    ".gpmp-why{position:relative;background:rgba(37,99,235,.10);border:1px solid rgba(96,148,255,.28);border-radius:16px;padding:13px 15px 8px;margin-bottom:11px;}",
    ".gpmp-why-t{font-size:11px;font-weight:700;color:#bcd3ff;text-transform:uppercase;letter-spacing:.08em;margin-bottom:9px;}",
    ".gpmp-why ul{list-style:none;margin:0;padding:0;}",
    ".gpmp-why li{display:flex;gap:10px;align-items:flex-start;font-size:12.8px;color:#e6edfb;line-height:1.45;margin-bottom:8px;}",
    ".gpmp-tick{flex:none;width:19px;height:19px;border-radius:50%;background:linear-gradient(180deg,#4f8bff,#2563eb);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;}",
    ".gpmp-video{position:relative;display:block;border-radius:14px;overflow:hidden;margin-bottom:11px;border:1px solid rgba(255,255,255,.14);text-decoration:none;}",
    ".gpmp-video-thumb{background:linear-gradient(160deg,#122142 0%,#1a2c4e 100%);height:78px;display:flex;align-items:center;justify-content:center;gap:12px;}",
    ".gpmp-play{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.94);display:flex;align-items:center;justify-content:center;flex:none;}",
    ".gpmp-play span{width:0;height:0;border-left:11px solid #1d4ed8;border-top:6.5px solid transparent;border-bottom:6.5px solid transparent;margin-left:3px;display:block;}",
    ".gpmp-video-label{font-size:12px;color:#dce7ff;line-height:1.4;max-width:180px;}",
    ".gpmp-video-label b{color:#fff;}",
    ".gpmp-stat{position:relative;display:flex;align-items:center;gap:12px;background:rgba(22,163,74,.14);border:1px solid rgba(74,222,128,.35);border-radius:14px;padding:10px 14px;margin-bottom:12px;}",
    ".gpmp-pct{font-family:'Source Serif 4',Georgia,serif;font-size:26px;font-weight:700;color:#6ee7a0;line-height:1;}",
    ".gpmp-lbl{font-size:11.5px;color:#c9f2d9;line-height:1.4;}",
    ".gpmp-cd{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(217,119,6,.18);border:1px solid rgba(251,191,36,.4);color:#fcd34d;border-radius:11px;padding:9px 12px;font-size:12.5px;font-weight:700;margin-bottom:14px;}",
    ".gpmp-cd-u{font-family:'Source Serif 4',Georgia,serif;font-size:16px;color:#fff;}",
    ".gpmp-accept{position:relative;overflow:hidden;display:block;width:100%;text-align:center;color:#fff;font-weight:700;text-decoration:none;font-size:15px;padding:15px;border-radius:14px;border:0;cursor:pointer;",
    "background:linear-gradient(180deg,#4f8bff 0%,#2563eb 45%,#1d4ed8 100%);box-shadow:0 12px 28px -8px rgba(37,99,235,.75), inset 0 1.5px 0 rgba(255,255,255,.5), inset 0 -2px 6px rgba(13,38,110,.45);}",
    ".gpmp-accept:disabled{opacity:.75;cursor:default;}",
    ".gpmp-accept::after{content:'';position:absolute;top:-10%;bottom:-10%;left:-70%;width:44%;background:linear-gradient(115deg, transparent 0%, rgba(255,255,255,.55) 50%, transparent 100%);transform:skewX(-22deg);animation:gpmpshine 3s ease-in-out infinite;}",
    "@media (prefers-reduced-motion: reduce){.gpmp-accept::after{animation:none;}}",
    "@keyframes gpmpshine{0%{left:-70%}55%{left:135%}100%{left:135%}}",
    ".gpmp-later{position:relative;display:block;text-align:center;color:rgba(226,233,246,.65);font-size:13px;text-decoration:none;padding:11px 0 0;}",
    "html.gpmp-open{overflow:hidden;}"
  ].join("\n");

  var confettiHandle = null;
  function closeOverlay(overlay) {
    if (confettiHandle) { confettiHandle.stop(); confettiHandle = null; }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try { document.documentElement.classList.remove("gpmp-open"); } catch (e) {}
  }

  function showOverlay(match, gp) {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.id = "gpMatchPopup";
    overlay.className = "gpmp-overlay";
    overlay.innerHTML = '<div class="gpmp-card">' + buildOverlayHtml(match, gp) + "</div>";
    document.body.appendChild(overlay);
    try { document.documentElement.classList.add("gpmp-open"); } catch (e) {}

    var confettiHost = overlay.querySelector(".gpmp-confetti-host");
    confettiHandle = confettiHost ? launchLoopingConfetti(confettiHost) : null;

    var laterEl = overlay.querySelector("[data-gpmp-later]");
    if (laterEl) {
      laterEl.addEventListener("click", function (e) {
        e.preventDefault();
        closeOverlay(overlay);
      });
    }

    var acceptEl = overlay.querySelector("[data-gpmp-accept]");
    if (acceptEl) {
      acceptEl.addEventListener("click", function () {
        acceptEl.disabled = true;
        acceptEl.textContent = "Accepting…";
        respond(match.applicationId, "accept").then(function (result) {
          if (result && result.status === 200 && result.body && result.body.ok) {
            acceptEl.textContent = "Accepted ✓";
            setTimeout(function () {
              closeOverlay(overlay);
              navigateToCareer();
            }, 900);
            return;
          }
          if (result && result.status === 410) {
            closeOverlay(overlay);
            navigateToCareer();
            return;
          }
          acceptEl.disabled = false;
          acceptEl.textContent = "Accept this match";
        }).catch(function () {
          acceptEl.disabled = false;
          acceptEl.textContent = "Accept this match";
        });
      });
    }
  }

  function init() {
    // Never stack a second popup over an already-open one.
    if (document.getElementById("gpMatchPopup")) return;
    fetchMatches().then(function (data) {
      var match = pickNewestUnseen(data);
      if (!match) return; // no unseen match, locked account, or fetch failure, do nothing silently
      markSeen(match.applicationId);
      showOverlay(match, data.gp || {});
    });
  }

  // This file is loaded with `defer`, placed AFTER app-shell.js's own <script>
  // tag in pages/app-shell.html, both scripts register their DOMContentLoaded
  // listener during the (pre-DOMContentLoaded) deferred-script execution phase,
  // in document order, so app-shell.js's listener (which sets
  // window.gpShellNavigate inside its own init()) always runs first.
  document.addEventListener("DOMContentLoaded", init, { once: true });
})();
