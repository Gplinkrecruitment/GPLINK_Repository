/* GP Link — one notice dialog, shared by every GP page.
 *
 * Why this exists: the application rules (2 live applications, 3 positions a
 * month) are refused on the SERVER, and the refusal has to be explained the
 * same way wherever the doctor happened to hit it — the job page's Apply
 * button, the careers page accepting a match, or the intro page's own preview.
 * Three hand-rolled copies of that dialog would drift within a release, and a
 * toast is the wrong shape for it: a toast disappears, and this is a rule the
 * doctor needs to read and act on.
 *
 * Deliberately dependency-free and self-injecting (styles + markup on first
 * use), because the pages that need it are plain HTML with inline scripts and
 * no build step. Styling is entirely gp-tokens.css variables, with literal
 * fallbacks so it still looks right if the token sheet 404s.
 *
 * Usage:
 *   gpNotice.show({
 *     title: 'You already have 2 live applications',
 *     body: 'To apply for this position, withdraw one first.',
 *     tone: 'warn',                       // info | warn | good
 *     bullets: [{title, meta, href}],     // optional, e.g. the live applications
 *     primaryLabel: 'Got it',
 *     secondaryLabel: 'Manage my applications',
 *     onSecondary: fn
 *   });
 */
(function (root) {
  'use strict';

  var STYLE_ID = 'gp-notice-styles';
  var el = null;      // the overlay, built once
  var current = null; // the options of the notice on screen

  var CSS = [
    '.gpn-overlay{position:fixed;inset:0;z-index:9990;display:none;align-items:center;justify-content:center;',
    'padding:16px;padding-bottom:calc(16px + max(var(--gp-shell-bottom-clearance,0px),env(safe-area-inset-bottom,0px)));',
    'background:rgba(15,23,42,.44);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}',
    '.gpn-overlay.is-open{display:flex;}',
    '.gpn-card{width:min(460px,100%);max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain;',
    'background:var(--gp-surface,#fff);border:1px solid var(--gp-border,#e3e9f4);border-radius:var(--gp-r-xl,24px);',
    'box-shadow:var(--gp-shadow-lg,0 24px 55px -24px rgba(2,6,23,.42));padding:22px 20px 18px;text-align:center;',
    'font-family:var(--gp-font-body,"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);}',
    '.gpn-ico{width:52px;height:52px;border-radius:50%;margin:0 auto 12px;display:grid;place-items:center;font-size:24px;}',
    '.gpn-ico--info{background:var(--gp-blue-soft,#eff4ff);color:var(--gp-blue,#2563eb);}',
    '.gpn-ico--warn{background:var(--gp-amber-soft,#fdf3e1);color:var(--gp-amber,#d97706);}',
    '.gpn-ico--good{background:var(--gp-green-soft,#eafaf0);color:var(--gp-green,#16a34a);}',
    '.gpn-title{font-family:var(--gp-font-display,"Source Serif 4",Georgia,serif);font-size:19px;font-weight:700;',
    'color:var(--gp-ink,#0f172a);margin:0 0 7px;line-height:1.25;}',
    '.gpn-body{font-size:13.5px;line-height:1.5;color:var(--gp-muted,#64748b);margin:0;}',
    '.gpn-list{margin:14px 0 0;display:grid;gap:8px;text-align:left;}',
    '.gpn-item{display:flex;align-items:center;gap:10px;background:var(--gp-surface-sunken,#f8fafd);',
    'border:1px solid var(--gp-border,#e3e9f4);border-radius:var(--gp-r-md,14px);padding:10px 12px;',
    'text-decoration:none;color:inherit;}',
    'a.gpn-item:hover{border-color:var(--gp-blue-border,#d6e2fb);background:var(--gp-blue-soft,#eff4ff);}',
    '.gpn-item-txt{min-width:0;flex:1;}',
    '.gpn-item-title{display:block;font-size:13px;font-weight:700;color:var(--gp-ink,#0f172a);',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.gpn-item-meta{display:block;font-size:11px;color:var(--gp-muted,#64748b);margin-top:2px;}',
    '.gpn-item-arr{flex:none;color:var(--gp-blue,#2563eb);font-weight:900;font-size:14px;}',
    '.gpn-actions{margin-top:16px;display:grid;gap:8px;}',
    '.gpn-btn{display:block;width:100%;text-align:center;cursor:pointer;font-size:13.5px;font-weight:700;',
    'padding:12px;border-radius:var(--gp-r-md,14px);border:0;font-family:inherit;}',
    '.gpn-btn--primary{color:#fff;background:var(--gp-blue,#2563eb);}',
    '.gpn-btn--primary.is-warn{background:var(--gp-amber,#d97706);}',
    '.gpn-btn--primary.is-good{background:var(--gp-green,#16a34a);}',
    '.gpn-btn--secondary{color:var(--gp-blue,#2563eb);background:var(--gp-surface,#fff);',
    'border:1px solid var(--gp-blue-border,#d6e2fb);}',
    '.gpn-btn[hidden]{display:none;}',
    '.gpn-list[hidden]{display:none;}',
    'html.dark-mode .gpn-card{background:#151e2e;border-color:#26324a;}',
    'html.dark-mode .gpn-title{color:#e8eefb;}',
    'html.dark-mode .gpn-body,html.dark-mode .gpn-item-meta{color:#94a3b8;}',
    'html.dark-mode .gpn-item{background:#1b2436;border-color:#26324a;}',
    'html.dark-mode .gpn-item-title{color:#e8eefb;}',
    'html.dark-mode .gpn-btn--secondary{background:#1b2436;border-color:#26324a;color:#cfe0ff;}'
  ].join('');

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    if (el) return el;
    injectStyles();
    el = document.createElement('div');
    el.className = 'gpn-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="gpn-card">'
      + '<div class="gpn-ico" data-gpn-ico aria-hidden="true"></div>'
      + '<h2 class="gpn-title" data-gpn-title></h2>'
      + '<p class="gpn-body" data-gpn-body></p>'
      + '<div class="gpn-list" data-gpn-list hidden></div>'
      + '<div class="gpn-actions">'
      + '<button type="button" class="gpn-btn gpn-btn--primary" data-gpn-primary></button>'
      + '<button type="button" class="gpn-btn gpn-btn--secondary" data-gpn-secondary hidden></button>'
      + '</div></div>';
    document.body.appendChild(el);

    el.addEventListener('click', function (ev) {
      // Backdrop click closes — but never when the notice is a rule the doctor
      // has to acknowledge (dismissible:false), so a stray tap can't skip it.
      if (ev.target === el && (!current || current.dismissible !== false)) { hide(); return; }
      if (ev.target.closest('[data-gpn-primary]')) {
        var onPrimary = current && current.onPrimary;
        hide();
        if (typeof onPrimary === 'function') onPrimary();
        return;
      }
      if (ev.target.closest('[data-gpn-secondary]')) {
        var onSecondary = current && current.onSecondary;
        hide();
        if (typeof onSecondary === 'function') onSecondary();
        return;
      }
      // A bullet with an index routes through the caller, so pages embedded in
      // the app shell can navigate via the shell instead of pointing the iframe
      // at a URL behind the shell's back.
      var item = ev.target.closest('[data-gpn-item]');
      if (item) {
        var bullets = (current && Array.isArray(current.bullets)) ? current.bullets : [];
        var bullet = bullets[Number(item.getAttribute('data-gpn-item'))];
        if (bullet && typeof bullet.onSelect === 'function') {
          ev.preventDefault();
          hide();
          bullet.onSelect(bullet);
        }
      }
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || !el.classList.contains('is-open')) return;
      if (current && current.dismissible === false) return;
      hide();
    });

    return el;
  }

  function show(options) {
    var opts = options || {};
    build();
    current = opts;

    var tone = opts.tone === 'warn' || opts.tone === 'good' ? opts.tone : 'info';
    var icoEl = el.querySelector('[data-gpn-ico]');
    icoEl.className = 'gpn-ico gpn-ico--' + tone;
    icoEl.textContent = opts.icon || (tone === 'warn' ? '!' : (tone === 'good' ? '✓' : 'i'));

    el.querySelector('[data-gpn-title]').textContent = opts.title || '';
    var bodyEl = el.querySelector('[data-gpn-body]');
    bodyEl.textContent = opts.body || '';
    bodyEl.hidden = !opts.body;

    var listEl = el.querySelector('[data-gpn-list]');
    var bullets = Array.isArray(opts.bullets) ? opts.bullets : [];
    if (bullets.length) {
      listEl.innerHTML = bullets.map(function (b, i) {
        var actionable = !!(b.href || typeof b.onSelect === 'function');
        var inner = '<span class="gpn-item-txt">'
          + '<span class="gpn-item-title">' + esc(b.title || '') + '</span>'
          + (b.meta ? '<span class="gpn-item-meta">' + esc(b.meta) + '</span>' : '')
          + '</span>'
          + (actionable ? '<span class="gpn-item-arr">→</span>' : '');
        // href stays on the anchor even when onSelect is set: it keeps the row a
        // real link (middle-click, long-press, screen readers) while onSelect
        // takes over the ordinary click.
        return actionable
          ? '<a class="gpn-item" data-gpn-item="' + i + '" href="' + esc(b.href || '#') + '">' + inner + '</a>'
          : '<div class="gpn-item">' + inner + '</div>';
      }).join('');
      listEl.hidden = false;
    } else {
      listEl.innerHTML = '';
      listEl.hidden = true;
    }

    var primary = el.querySelector('[data-gpn-primary]');
    primary.textContent = opts.primaryLabel || 'Got it';
    primary.className = 'gpn-btn gpn-btn--primary' + (tone === 'warn' ? ' is-warn' : (tone === 'good' ? ' is-good' : ''));

    var secondary = el.querySelector('[data-gpn-secondary]');
    if (opts.secondaryLabel) {
      secondary.textContent = opts.secondaryLabel;
      secondary.hidden = false;
    } else {
      secondary.hidden = true;
    }

    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    try { primary.focus({ preventScroll: true }); } catch (e) {}
  }

  function hide() {
    if (!el) return;
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    current = null;
  }

  function isOpen() { return !!(el && el.classList.contains('is-open')); }

  root.gpNotice = { show: show, hide: hide, isOpen: isOpen };
}(typeof window !== 'undefined' ? window : this));
