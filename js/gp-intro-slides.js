// Guided slideshows for doctors (owner brief 2026-09-03: "a popup slide show
// explaining the steps and what the app offers").
//
// Two decks, both built here from plain data so the owner can reword any slide
// without touching the engine:
//   buildWelcomeSlides(ctx)      — "How GP Link works", once, right after onboarding
//   buildRegistrationSlides(ctx) — "Your position is secured", once, when the
//                                   placement lands and the registration tabs appear
//
// run(slides, opts) draws a full-screen card deck (dots, Back/Next, final CTA).
// First runs are MANDATORY (no close button, Escape ignored) — the same rule the
// owner set for the first-run tab tour on 2026-09-01. Replays and staff
// "View as GP" sessions pass mandatory:false and get a close button.
//
// UMD: pure builders are unit-tested under vitest; run()/DOM code is
// browser-only and never touches the DOM at load time.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gpIntroSlides = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---------- pure content ----------
  function cleanName(ctx) {
    var c = ctx && typeof ctx === 'object' ? ctx : {};
    var last = String(c.lastName || '').trim();
    var first = String(c.firstName || '').trim();
    if (last) return 'Dr ' + last;
    if (first) return 'Dr ' + first;
    return 'Doctor';
  }
  function stageTitles(ctx) {
    var c = ctx && typeof ctx === 'object' ? ctx : {};
    var stages = Array.isArray(c.stages) ? c.stages : [];
    var out = [];
    for (var i = 0; i < stages.length; i++) {
      var s = stages[i];
      if (!s || s.key === 'career') continue; // "Secure Placement" is the step they just did
      out.push({ title: s.title || '', sub: s.description || '' });
    }
    if (!out.length) {
      out = [
        { title: 'MyIntealth Account', sub: 'Create your MyIntealth account and complete EPIC verification.' },
        { title: 'AMC Portfolio', sub: 'Create your AMC candidate portfolio and upload credentials.' },
        { title: 'AHPRA Registration', sub: 'Prepare and submit your specialist registration application.' },
        { title: 'Visa Application', sub: 'Your employer-sponsored pathway to permanent residency.' },
        { title: 'PBS & Medicare', sub: 'Apply for your Medicare provider number and PBS prescriber number.' }
      ];
    }
    return out;
  }
  function joinTitles(list) {
    var names = [];
    for (var i = 0; i < list.length; i++) names.push(list[i].title);
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  function buildWelcomeSlides(ctx) {
    var name = cleanName(ctx);
    var stages = stageTitles(ctx);
    return [
      {
        icon: 'wave', kicker: 'Welcome to GP Link', title: 'Welcome, ' + name,
        body: "We'll take you from here to your first day in an Australian practice, one step at a time. Here's how it works."
      },
      {
        icon: 'search', kicker: 'Step 1 of 4', title: 'Find your practice',
        body: 'Browse the practices matched to you. Apply directly to one you like, or send an enquiry if you have a question first.',
        note: 'You can have two applications in play at once, and three in a calendar month. Withdrawing from a position is final.'
      },
      {
        icon: 'calendar', kicker: 'Step 2 of 4', title: 'Meet the practice',
        body: "When a practice wants to meet you, you'll pick an interview time that suits you. We arrange the video call and send you the link. Your Registration Support Officer joins you, so you're never in the room alone."
      },
      {
        icon: 'contract', kicker: 'Step 3 of 4', title: 'Offer and contract',
        body: 'If the practice makes you an offer, you review it here and sign the contract in the app. That secures your position.'
      },
      {
        icon: 'unlock', kicker: 'Step 4 of 4', title: 'Your registration unlocks',
        body: 'Once your position is secured, your personalised registration pathway appears: ' + joinTitles(stages) + '. Our team guides you through each one, in order.'
      },
      {
        icon: 'compass', kicker: 'One thing at a time', title: 'You never have to guess what’s next',
        body: 'We only show what you need right now. Your next step is always at the top of the page, and we message you when something needs you.',
        cta: 'Find my practice'
      }
    ];
  }

  function buildRegistrationSlides(ctx) {
    var c = ctx && typeof ctx === 'object' ? ctx : {};
    var name = cleanName(c);
    var practice = String(c.practiceName || '').trim();
    var stages = stageTitles(c);
    return [
      {
        icon: 'trophy', kicker: 'Position secured', title: 'Congratulations, ' + name,
        body: (practice ? 'Your position at ' + practice + ' is secured.' : 'Your position is secured.')
          + ' Now we get you registered to practise in Australia.'
      },
      {
        icon: 'list', kicker: 'Your registration steps', title: stages.length + ' steps, in order',
        body: 'Each one unlocks when the previous step is done. Our team checks every document before it goes anywhere.',
        bullets: stages
      },
      {
        icon: 'tabs', kicker: 'New tabs', title: 'Your app just grew',
        body: 'Home shows your journey and your next step. Scan uploads a document straight from your camera. Support is where your Registration Support Officer replies.'
      },
      {
        icon: 'flag', kicker: "Let's begin", title: 'Start with ' + (stages[0] ? stages[0].title.replace(/ Account$/, '') : 'MyIntealth'),
        body: "It's the first step, and we'll point you straight to it. Everything else unlocks in order as you go.",
        cta: 'Start my registration'
      }
    ];
  }

  // ---------- browser-only below ----------
  var STYLE_ID = 'gp-intro-slides-styles';
  var active = false;
  var activeCancel = null;
  function doc() { return typeof document !== 'undefined' ? document : null; }

  var ICONS = {
    wave: '<path d="M7 11.5V6a1.5 1.5 0 0 1 3 0v5"/><path d="M10 10V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M13 10.5V6.5a1.5 1.5 0 0 1 3 0v6"/><path d="M16 12.5V9a1.5 1.5 0 0 1 3 0v6a7 7 0 0 1-7 7h-1a7 7 0 0 1-6.3-3.9L2.6 14a1.6 1.6 0 0 1 2.8-1.5L7 15"/>',
    search: '<circle cx="10.5" cy="10.5" r="7"/><path d="M21 21l-4.2-4.2"/><path d="M10.5 7.5v6M7.5 10.5h6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="m9 15 2 2 4-4"/>',
    contract: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 17c1.5-2 2.5-2 3.5 0s2 2 3.5 0"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/><circle cx="12" cy="16" r="1.2"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 6h2a2 2 0 0 1 0 4h-2M7 6H5a2 2 0 0 0 0 4h2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 .5.5L6 5M4 12l.5.5L6 11M4 18l.5.5L6 17"/>',
    tabs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 16h18M8 20v-4M12 20v-4M16 20v-4"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'
  };
  function iconSvg(name) {
    var p = ICONS[name] || ICONS.compass;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function ensureStyles() {
    var d = doc(); if (!d || d.getElementById(STYLE_ID)) return;
    var css = ''
      + '.gp-intro{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:flex-end;justify-content:center;'
      + 'background:rgba(6,11,24,.66);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);'
      + "font-family:var(--gp-font-body,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);color:var(--gp-text,#1f2b43);"
      + 'opacity:0;transition:opacity .28s ease;}'
      + '.gp-intro.is-in{opacity:1;}'
      + '.gp-intro-card{position:relative;width:100%;max-width:100%;max-height:min(92dvh,92vh);display:flex;flex-direction:column;'
      + 'background:var(--gp-surface,#fff);border-radius:26px 26px 0 0;box-shadow:0 -24px 60px -30px rgba(2,6,23,.6);'
      + 'transform:translateY(24px);transition:transform .32s cubic-bezier(.22,.61,.21,1);overflow:hidden;}'
      + '.gp-intro.is-in .gp-intro-card{transform:translateY(0);}'
      + '@media(min-width:640px){.gp-intro{align-items:center;padding:24px;}'
      + '.gp-intro-card{max-width:470px;border-radius:24px;box-shadow:0 34px 80px -34px rgba(2,6,23,.65);transform:translateY(12px) scale(.98);}}'
      + '.gp-intro-top{height:6px;background:var(--gp-grad-brand,linear-gradient(135deg,#2e6bf0,#1d4ed8));}'
      + '.gp-intro-close{position:absolute;top:12px;right:12px;width:34px;height:34px;border:0;border-radius:50%;'
      + 'background:var(--gp-surface-sunken,#f1f5f9);color:var(--gp-muted,#64748b);font-size:19px;font-weight:700;cursor:pointer;z-index:2;}'
      + '.gp-intro-body{padding:26px 24px 8px;overflow:auto;-webkit-overflow-scrolling:touch;}'
      + '.gp-intro-icon{width:56px;height:56px;border-radius:18px;display:grid;place-items:center;color:#fff;'
      + 'background:var(--gp-grad-brand,linear-gradient(135deg,#2e6bf0,#1d4ed8));box-shadow:0 14px 28px -16px rgba(29,78,216,.7);margin-bottom:16px;}'
      + '.gp-intro-icon svg{width:28px;height:28px;}'
      + '.gp-intro-kicker{font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gp-blue,#2563eb);margin:0 0 6px;}'
      + '.gp-intro-title{margin:0 0 10px;font-family:var(--gp-font-display,"Source Serif 4",Georgia,serif);font-size:25px;line-height:1.18;letter-spacing:-.012em;font-weight:700;color:var(--gp-ink,#0f172a);}'
      + '.gp-intro-text{margin:0;font-size:15.5px;line-height:1.58;color:var(--gp-text,#334155);}'
      + '.gp-intro-note{margin:12px 0 0;padding:11px 13px;border-radius:12px;background:var(--gp-blue-soft,#eff4ff);color:var(--gp-blue-deep,#1d4ed8);font-size:13.5px;line-height:1.5;font-weight:500;}'
      + '.gp-intro-list{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:8px;}'
      + '.gp-intro-list li{display:flex;gap:11px;align-items:flex-start;padding:10px 12px;border:1px solid var(--gp-border,#e2e8f0);border-radius:12px;background:var(--gp-surface,#fff);}'
      + '.gp-intro-num{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff;'
      + 'background:var(--gp-grad-brand,linear-gradient(135deg,#2e6bf0,#1d4ed8));}'
      + '.gp-intro-li-t{font-size:14px;font-weight:700;color:var(--gp-ink,#0f172a);}'
      + '.gp-intro-li-s{font-size:12.5px;line-height:1.45;color:var(--gp-muted,#64748b);margin-top:2px;}'
      + '.gp-intro-foot{padding:14px 24px calc(20px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:10px;border-top:1px solid var(--gp-border,#eef2f7);}'
      + '.gp-intro-dots{display:flex;gap:6px;margin-right:auto;}'
      + '.gp-intro-dot{width:7px;height:7px;border-radius:50%;background:var(--gp-border-strong,#cbd5e1);transition:all .25s ease;}'
      + '.gp-intro-dot.on{width:20px;border-radius:4px;background:var(--gp-blue,#2563eb);}'
      + '.gp-intro-back{background:var(--gp-blue-soft,#eff4ff);border:0;border-radius:12px;padding:11px 15px;font:inherit;font-size:14px;font-weight:600;color:var(--gp-blue-deep,#1d4ed8);cursor:pointer;}'
      + '.gp-intro-next{background:var(--gp-grad-brand,linear-gradient(135deg,#2e6bf0,#1d4ed8));border:0;border-radius:12px;padding:11px 20px;font:inherit;font-size:14.5px;font-weight:700;color:#fff;cursor:pointer;'
      + 'box-shadow:0 10px 22px -12px rgba(29,78,216,.75);}'
      + '.gp-intro-next.is-cta{padding:12px 24px;font-size:15px;}'
      + '.gp-intro-back:focus-visible,.gp-intro-next:focus-visible,.gp-intro-close:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(37,99,235,.35);}'
      + '.gp-intro-pane{animation:gpIntroIn .3s ease both;}'
      + '@keyframes gpIntroIn{from{opacity:0;transform:translateX(12px);}to{opacity:1;transform:none;}}'
      + '@media(prefers-reduced-motion:reduce){.gp-intro,.gp-intro-card,.gp-intro-pane,.gp-intro-dot{transition:none!important;animation:none!important;}}';
    var el = d.createElement('style'); el.id = STYLE_ID; el.textContent = css; d.head.appendChild(el);
  }

  function run(slides, options) {
    var d = doc();
    if (!d || !Array.isArray(slides) || !slides.length) return Promise.resolve('empty');
    if (active) return Promise.resolve('busy');
    active = true;
    ensureStyles();
    var opts = options || {};
    var mandatory = opts.mandatory === true;
    var idx = 0, settled = false, lastFocus = d.activeElement;

    var overlay = d.createElement('div');
    overlay.className = 'gp-intro';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'gp-intro-title');
    overlay.innerHTML = '<div class="gp-intro-card"><div class="gp-intro-top"></div>'
      + (mandatory ? '' : '<button type="button" class="gp-intro-close" aria-label="Close">&times;</button>')
      + '<div class="gp-intro-body"><div class="gp-intro-pane"></div></div>'
      + '<div class="gp-intro-foot"><div class="gp-intro-dots" aria-hidden="true"></div></div></div>';
    d.body.appendChild(overlay);
    var pane = overlay.querySelector('.gp-intro-pane');
    var body = overlay.querySelector('.gp-intro-body');
    var foot = overlay.querySelector('.gp-intro-foot');
    var dots = overlay.querySelector('.gp-intro-dots');
    var closeBtn = overlay.querySelector('.gp-intro-close');

    return new Promise(function (resolve) {
      function cleanup(reason) {
        if (settled) return;
        settled = true;
        active = false;
        activeCancel = null;
        d.removeEventListener('keydown', onKey, true);
        overlay.classList.remove('is-in');
        var remove = function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
        setTimeout(remove, 300);
        try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
        resolve(reason);
      }
      function done() { if (opts.onDone) { try { opts.onDone(); } catch (e) {} } cleanup('done'); }
      function skip() {
        if (mandatory) return;
        if (opts.onSkip) { try { opts.onSkip(); } catch (e) {} }
        cleanup('skip');
      }
      function next() { if (idx >= slides.length - 1) done(); else { idx++; render(); } }
      function back() { if (idx > 0) { idx--; render(); } }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); skip(); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
        else if (e.key === 'Tab') {
          var f = overlay.querySelectorAll('button');
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      function render() {
        var s = slides[idx] || {};
        var html = '<div class="gp-intro-icon">' + iconSvg(s.icon) + '</div>'
          + (s.kicker ? '<p class="gp-intro-kicker">' + esc(s.kicker) + '</p>' : '')
          + '<h2 class="gp-intro-title" id="gp-intro-title">' + esc(s.title) + '</h2>'
          + (s.body ? '<p class="gp-intro-text">' + esc(s.body) + '</p>' : '');
        if (Array.isArray(s.bullets) && s.bullets.length) {
          html += '<ol class="gp-intro-list">';
          for (var i = 0; i < s.bullets.length; i++) {
            html += '<li><span class="gp-intro-num">' + (i + 1) + '</span><span><div class="gp-intro-li-t">' + esc(s.bullets[i].title) + '</div>'
              + (s.bullets[i].sub ? '<div class="gp-intro-li-s">' + esc(s.bullets[i].sub) + '</div>' : '') + '</span></li>';
          }
          html += '</ol>';
        }
        if (s.note) html += '<p class="gp-intro-note">' + esc(s.note) + '</p>';
        // Re-mount the pane so the enter animation replays per slide.
        var fresh = d.createElement('div'); fresh.className = 'gp-intro-pane'; fresh.innerHTML = html;
        pane.parentNode.replaceChild(fresh, pane); pane = fresh;
        body.scrollTop = 0;
        // dots
        dots.innerHTML = '';
        for (var k = 0; k < slides.length; k++) {
          var dot = d.createElement('span'); dot.className = 'gp-intro-dot' + (k === idx ? ' on' : ''); dots.appendChild(dot);
        }
        // actions
        Array.prototype.slice.call(foot.querySelectorAll('button')).forEach(function (b) { foot.removeChild(b); });
        if (idx > 0) {
          var bb = d.createElement('button'); bb.type = 'button'; bb.className = 'gp-intro-back'; bb.textContent = 'Back';
          bb.addEventListener('click', back); foot.appendChild(bb);
        }
        var nb = d.createElement('button'); nb.type = 'button';
        var isLast = idx === slides.length - 1;
        nb.className = 'gp-intro-next' + (isLast ? ' is-cta' : '');
        nb.textContent = isLast ? (s.cta || opts.doneLabel || 'Done') : 'Next';
        nb.addEventListener('click', next); foot.appendChild(nb);
        overlay.setAttribute('aria-label', 'Slide ' + (idx + 1) + ' of ' + slides.length);
        try { nb.focus({ preventScroll: true }); } catch (e) { try { nb.focus(); } catch (e2) {} }
      }
      if (closeBtn) closeBtn.addEventListener('click', skip);
      activeCancel = function () { cleanup('cancel'); };
      d.addEventListener('keydown', onKey, true);
      render();
      (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () { overlay.classList.add('is-in'); });
    });
  }

  function isActive() { return active; }
  function cancel() { if (activeCancel) activeCancel(); }

  return {
    buildWelcomeSlides: buildWelcomeSlides,
    buildRegistrationSlides: buildRegistrationSlides,
    cleanName: cleanName,
    run: run,
    isActive: isActive,
    cancel: cancel
  };
});
