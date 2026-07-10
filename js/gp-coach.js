// Coach-mark overlay engine. Pure computePlacement is unit-tested; run()/DOM code is
// browser-only and never touches the DOM at load time (safe to require() under Node).
// UMD: window.gpCoach in the browser, module.exports for vitest.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gpCoach = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---------- pure geometry ----------
  function computePlacement(target, tip, viewport, opts) {
    opts = opts || {};
    var pad = opts.pad != null ? opts.pad : 8;
    var gap = opts.gap != null ? opts.gap : 14;
    var margin = opts.margin != null ? opts.margin : 12;
    var spot = { left: target.left - pad, top: target.top - pad, width: target.width + pad * 2, height: target.height + pad * 2 };
    var placeBelow = (target.top + target.height / 2) < viewport.height / 2;
    var tipTop = placeBelow ? (spot.top + spot.height + gap) : (spot.top - gap - tip.height);
    if (placeBelow && tipTop + tip.height > viewport.height - margin) { tipTop = spot.top - gap - tip.height; placeBelow = false; }
    else if (!placeBelow && tipTop < margin) { tipTop = spot.top + spot.height + gap; placeBelow = true; }
    var tipLeft = target.left + target.width / 2 - tip.width / 2;
    tipLeft = Math.max(margin, Math.min(tipLeft, viewport.width - tip.width - margin));
    var arrowLeft = Math.max(12, Math.min(target.left + target.width / 2 - tipLeft, tip.width - 12));
    return { spot: spot, tip: { left: tipLeft, top: tipTop }, placeBelow: placeBelow, arrowLeft: arrowLeft };
  }

  // ---------- browser-only below (never called at module load) ----------
  var STYLE_ID = 'gp-coach-styles';
  var active = false;
  function doc() { return typeof document !== 'undefined' ? document : null; }

  function ensureStyles() {
    var d = doc(); if (!d || d.getElementById(STYLE_ID)) return;
    var css = ''
      + '.gp-coach-overlay{position:fixed;inset:0;z-index:2147483000;}'
      + '.gp-coach-spot{position:fixed;border-radius:14px;pointer-events:none;'
      + 'box-shadow:0 0 0 9999px rgba(9,14,28,.62),0 0 0 3px rgba(255,255,255,.92);'
      + 'transition:all .32s cubic-bezier(.22,.61,.21,1);}'
      + '.gp-coach-tip{position:fixed;width:min(280px,calc(100vw - 24px));background:#fff;border-radius:16px;'
      + 'padding:15px 15px 13px;box-shadow:0 24px 55px -24px rgba(2,6,23,.5);'
      + "font-family:var(--gp-font-body,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);color:#1f2b43;"
      + 'transition:all .3s cubic-bezier(.22,.61,.21,1);}'
      + '.gp-coach-step{font-size:11px;font-weight:700;letter-spacing:.05em;color:#2563eb;text-transform:uppercase;margin-bottom:6px;}'
      + '.gp-coach-title{margin:0 0 5px;font-size:15.5px;font-weight:700;color:#0f172a;}'
      + '.gp-coach-body{margin:0 0 13px;font-size:13.5px;line-height:1.5;}'
      + '.gp-coach-acts{display:flex;align-items:center;gap:8px;}'
      + '.gp-coach-skip{margin-right:auto;background:none;border:none;font:inherit;font-size:12.5px;font-weight:600;color:#94a3b8;cursor:pointer;}'
      + '.gp-coach-back{background:#eff4ff;border:none;border-radius:10px;padding:8px 13px;font:inherit;font-size:13px;font-weight:600;color:#1d4ed8;cursor:pointer;}'
      + '.gp-coach-next{background:linear-gradient(135deg,#2e6bf0,#1d4ed8);border:none;border-radius:10px;padding:8px 15px;font:inherit;font-size:13px;font-weight:600;color:#fff;cursor:pointer;}'
      + '.gp-coach-arrow{position:absolute;width:14px;height:14px;background:#fff;transform:rotate(45deg);}'
      + '.gp-coach-arrow.below{top:-7px;}.gp-coach-arrow.above{bottom:-7px;}'
      + '@media (prefers-reduced-motion: reduce){.gp-coach-spot,.gp-coach-tip{transition:none!important;}}';
    var el = d.createElement('style'); el.id = STYLE_ID; el.textContent = css; d.head.appendChild(el);
  }

  function waitForElement(selector, timeout) {
    var d = doc();
    return new Promise(function (resolve) {
      if (!d) return resolve(null);
      var found = d.querySelector(selector);
      if (found) return resolve(found);
      var to = null;
      var obs = new MutationObserver(function () {
        var el = d.querySelector(selector);
        if (el) { obs.disconnect(); if (to) clearTimeout(to); resolve(el); }
      });
      obs.observe(d.body, { childList: true, subtree: true });
      to = setTimeout(function () { obs.disconnect(); resolve(d.querySelector(selector)); }, timeout || 4000);
    });
  }

  function resolveTarget(t) {
    var d = doc(); if (!d) return Promise.resolve(null);
    if (typeof t === 'function') { try { return Promise.resolve(t()); } catch (e) { return Promise.resolve(null); } }
    if (t && t.nodeType === 1) return Promise.resolve(t);
    if (typeof t === 'string') return waitForElement(t, 4000);
    return Promise.resolve(null);
  }

  function run(steps, options) {
    var d = doc();
    if (!d || !Array.isArray(steps) || !steps.length) return Promise.resolve('empty');
    if (active) return Promise.resolve('busy');
    active = true;
    ensureStyles();
    var opts = options || {};
    var reduced = false;
    try { reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    var overlay = d.createElement('div');
    overlay.className = 'gp-coach-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var spot = d.createElement('div'); spot.className = 'gp-coach-spot';
    var tip = d.createElement('div'); tip.className = 'gp-coach-tip';
    tip.innerHTML = '<div class="gp-coach-arrow"></div><div class="gp-coach-step" aria-live="polite"></div>'
      + '<h5 class="gp-coach-title"></h5><p class="gp-coach-body"></p><div class="gp-coach-acts"></div>';
    overlay.appendChild(spot); overlay.appendChild(tip);
    d.body.appendChild(overlay);

    var stepEl = tip.querySelector('.gp-coach-step');
    var titleEl = tip.querySelector('.gp-coach-title');
    var bodyEl = tip.querySelector('.gp-coach-body');
    var actsEl = tip.querySelector('.gp-coach-acts');
    var arrowEl = tip.querySelector('.gp-coach-arrow');
    var idx = 0, curTarget = null, lastFocus = d.activeElement, total = steps.length;

    return new Promise(function (resolve) {
      function cleanup(reason) {
        active = false;
        window.removeEventListener('resize', reposition, true);
        window.removeEventListener('scroll', reposition, true);
        d.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
        resolve(reason);
      }
      function done() { if (opts.onDone) { try { opts.onDone(); } catch (e) {} } cleanup('done'); }
      function skip() { if (opts.onSkip) { try { opts.onSkip(); } catch (e) {} } cleanup('skip'); }
      function next() { if (idx >= total - 1) done(); else { idx++; render(); } }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); skip(); }
        else if (e.key === 'Enter') { e.preventDefault(); next(); }
      }
      function reposition() {
        if (!curTarget) return;
        var r = curTarget.getBoundingClientRect();
        var pl = computePlacement(
          { left: r.left, top: r.top, width: r.width, height: r.height },
          { width: tip.offsetWidth, height: tip.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight }, {});
        spot.style.left = pl.spot.left + 'px'; spot.style.top = pl.spot.top + 'px';
        spot.style.width = pl.spot.width + 'px'; spot.style.height = pl.spot.height + 'px';
        tip.style.left = pl.tip.left + 'px'; tip.style.top = pl.tip.top + 'px';
        arrowEl.style.left = pl.arrowLeft + 'px';
        arrowEl.className = 'gp-coach-arrow ' + (pl.placeBelow ? 'below' : 'above');
      }
      function renderActions() {
        actsEl.innerHTML = '';
        var s = d.createElement('button'); s.type = 'button'; s.className = 'gp-coach-skip'; s.textContent = 'Skip';
        s.addEventListener('click', skip); actsEl.appendChild(s);
        if (idx > 0) {
          var b = d.createElement('button'); b.type = 'button'; b.className = 'gp-coach-back'; b.textContent = 'Back';
          b.addEventListener('click', function () { idx = Math.max(0, idx - 1); render(); }); actsEl.appendChild(b);
        }
        var n = d.createElement('button'); n.type = 'button'; n.className = 'gp-coach-next';
        n.textContent = idx === total - 1 ? 'Done' : 'Next';
        n.addEventListener('click', next); actsEl.appendChild(n);
      }
      function render() {
        resolveTarget(steps[idx].target).then(function (el) {
          if (!el) { if (idx >= total - 1) { done(); } else { idx++; render(); } return; }
          curTarget = el;
          try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) {}
          stepEl.textContent = typeof opts.label === 'function' ? opts.label(idx, total) : ('Step ' + (idx + 1) + ' of ' + total);
          titleEl.textContent = steps[idx].title || '';
          bodyEl.textContent = steps[idx].body || '';
          renderActions();
          (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
            reposition();
            var f = actsEl.querySelector('.gp-coach-next'); if (f) { try { f.focus(); } catch (e) {} }
          });
        });
      }
      window.addEventListener('resize', reposition, true);
      window.addEventListener('scroll', reposition, true);
      d.addEventListener('keydown', onKey, true);
      render();
    });
  }

  function isActive() { return active; }

  return { computePlacement: computePlacement, run: run, isActive: isActive, waitForElement: waitForElement };
});
