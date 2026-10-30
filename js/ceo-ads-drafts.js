/* ============================================================================
 * ceo-ads-drafts.js — "New ads" on the CEO Social tab: the drafts board.
 *
 * Every draft is edited ON the page: the copy fields are inputs, "Ask the
 * model to change it" rewrites from one instruction (the previous version is
 * kept in history), the creative is composed in a <canvas> from a photo plus
 * the image headline and sub-line in Figtree (the same layout as the Sept/Oct
 * batches built with build.py), and the result is scheduled into the live ad
 * set and created on Meta by the launcher cron, or by "Launch now".
 *
 * Owns #soc-drafts-root, which the hub keeps across its own repaints, so an
 * unsaved edit survives a numbers refresh. Each card is repainted on its own
 * after a save, never the whole board.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.ATS || {};
  var esc = A.esc || function (s) { return String(s == null ? '' : s); };

  // Canvas geometry and colours mirror build.py (1080x1350, 72px margins).
  var W = 1080, H = 1350, M = 72;
  var INK = '#0a2a5e', BLUE = '#116dff', CYAN = '#4ec7f5', WHITE = '#ffffff', ON_DARK = '#d6e8ff';
  var SCRIM = '6,18,38';
  var FONT = 'Figtree, "DM Sans", system-ui, sans-serif';

  var state = { data: null, filter: 'working', cards: {}, photos: null, photosFor: null, busy: {}, fontsReady: false, flashId: null };
  var WORKING = ['draft', 'ready'];
  var QUEUED = ['scheduled', 'launching', 'failed'];

  function root() { return document.getElementById('soc-drafts-root'); }
  function drafts() { return (state.data && state.data.drafts) || []; }
  function byId(id) { return drafts().find(function (d) { return String(d.id) === String(id); }) || null; }
  function cardEl(id) { var r = root(); return r ? r.querySelector('.mk-draft[data-id="' + id + '"]') : null; }
  function card(id) { if (!state.cards[id]) state.cards[id] = {}; return state.cards[id]; }
  function money(v) { return window.AdsHub ? window.AdsHub.money(v) : String(v); }
  function when(v) { return window.AdsHub ? window.AdsHub.when(v) : String(v); }
  function pill(t, m) { return '<span class="ats-pill ' + esc(m || 'muted') + '">' + esc(t) + '</span>'; }

  function inFilter(d) {
    if (state.filter === 'working') return WORKING.indexOf(d.status) !== -1;
    if (state.filter === 'queued') return QUEUED.indexOf(d.status) !== -1;
    if (state.filter === 'live') return d.status === 'live';
    return d.status === 'archived';
  }
  function counts() {
    var c = { working: 0, queued: 0, live: 0, archived: 0 };
    drafts().forEach(function (d) {
      if (WORKING.indexOf(d.status) !== -1) c.working++;
      else if (QUEUED.indexOf(d.status) !== -1) c.queued++;
      else if (d.status === 'live') c.live++;
      else c.archived++;
    });
    return c;
  }

  // ── board ────────────────────────────────────────────────────────────────
  function render(data) {
    state.data = data;
    var r = root();
    if (!r) return;
    if (!r.getAttribute('data-wired')) {
      r.setAttribute('data-wired', '1');
      r.addEventListener('click', onClick);
      r.addEventListener('input', onInput);
      r.addEventListener('change', onChange);
    }
    paint();
  }

  function paint() {
    var r = root();
    if (!r) return;
    var c = counts();
    var list = drafts().filter(inFilter);
    var html = '<section class="mk-card mk-drafts"><div class="mk-card-head"><h3>New ads <span class="ats-count-chip">' + drafts().length + '</span></h3>' +
      '<div class="mk-filters">' +
        filterBtn('working', 'Working on', c.working) + filterBtn('queued', 'Scheduled', c.queued) + filterBtn('live', 'Live', c.live) + filterBtn('archived', 'Archived', c.archived) +
        '<button type="button" class="soc-btn" data-act="new-blank">+ Blank draft</button>' +
      '</div></div>';
    if (!list.length) {
      html += '<div class="ats-empty">' + (state.filter === 'working'
        ? 'Nothing being worked on. Generate ads from the improvements above, or start a blank draft.'
        : 'Nothing here.') + '</div>';
    } else {
      html += '<div class="mk-draft-list">' + list.map(cardHtml).join('') + '</div>';
    }
    html += '</section>';
    r.innerHTML = html;
    list.forEach(function (d) { initCard(d); });
  }

  function filterBtn(key, label, n) {
    return '<button type="button" class="soc-btn' + (state.filter === key ? ' is-on' : '') + '" data-act="filter" data-filter="' + key + '">' + esc(label) + ' <span class="ats-count-chip">' + n + '</span></button>';
  }

  function statusPill(d) {
    var map = { draft: ['Draft', 'muted'], ready: ['Ready', 'blue'], scheduled: ['Scheduled', 'amber'], launching: ['Launching…', 'amber'], live: ['Live on Meta', 'green'], failed: ['Launch failed', 'red'], archived: ['Archived', 'muted'] };
    var m = map[d.status] || [d.status, 'muted'];
    return pill(m[0], m[1]);
  }

  function field(label, name, value, opts) {
    var o = opts || {};
    var ro = o.readonly ? ' readonly' : '';
    var count = o.max ? '<span class="mk-count" data-count-for="' + name + '">' + String(value || '').length + '/' + o.max + '</span>' : '';
    if (o.textarea) {
      return '<label class="mk-field"><span>' + esc(label) + count + '</span><textarea name="' + name + '" rows="' + (o.rows || 6) + '"' + ro + '>' + esc(value || '') + '</textarea></label>';
    }
    return '<label class="mk-field"><span>' + esc(label) + count + '</span><input type="text" name="' + name + '" value="' + esc(value || '') + '"' + ro + (o.max ? ' maxlength="' + (o.max * 3) + '"' : '') + '></label>';
  }

  function cardHtml(d) {
    var data = state.data || {};
    var locked = d.status === 'live' || d.status === 'launching';
    var layout = d.layout || {};
    var adsets = ((data.snapshot && data.snapshot.adsets) || []).slice();
    if (!adsets.some(function (x) { return x.id === String(d.adset_id || data.defaults.adset_id); })) {
      adsets.unshift({ id: String(d.adset_id || data.defaults.adset_id), name: 'Ad set ' + String(d.adset_id || data.defaults.adset_id), effective_status: '' });
    }
    var ctas = data.cta_options || [{ value: 'BOOK_TRAVEL', label: 'Book now' }];
    var imgV = String(d.updated_at || '').replace(/[^0-9]/g, '').slice(0, 14);
    var problems = d.problems || [];
    var warnings = d.warnings || [];
    var hist = Array.isArray(d.history) ? d.history : [];

    var html = '<article class="mk-draft' + (locked ? ' is-locked' : '') + (state.flashId === d.id ? ' is-new' : '') + '" data-id="' + esc(d.id) + '">';
    // ── left: creative
    html += '<div class="mk-draft-visual">' +
      '<div class="mk-canvas-wrap"><canvas width="' + W + '" height="' + H + '" aria-label="Creative preview"></canvas>' +
        '<div class="mk-canvas-hint" data-role="canvas-hint"></div></div>' +
      (locked ? '' :
        '<div class="mk-photo-controls">' +
          '<label class="soc-btn mk-file-btn">Upload photo<input type="file" accept="image/*" data-role="photo-file" hidden></label>' +
          '<button type="button" class="soc-btn" data-act="photo-lib">From ad account</button>' +
          (data.higgsfield_configured
            ? '<button type="button" class="soc-btn now" data-act="gen-photo" title="Generate a photograph from the photo brief with Higgsfield (about a minute)">' + (state.busy['gp-' + d.id] ? 'Generating…' : 'Generate photo') + '</button>'
            : '') +
          (d.image_prompt ? '<button type="button" class="soc-btn" data-act="copy-brief" title="Copy the photo brief for Higgsfield / any image tool">Copy photo brief</button>' : '') +
        '</div>' +
        (data.higgsfield_configured ? '' : '<div class="soc-when">Add HIGGSFIELD_API_KEY in Vercel to generate photos from the brief here.</div>') +
        '<div class="mk-photo-lib" data-role="photo-lib" hidden></div>' +
        '<div class="mk-layout-controls">' +
          '<label><input type="radio" name="placement-' + esc(d.id) + '" value="bottom"' + (layout.placement !== 'top' ? ' checked' : '') + '> Headline at the foot (dark photo)</label>' +
          '<label><input type="radio" name="placement-' + esc(d.id) + '" value="top"' + (layout.placement === 'top' ? ' checked' : '') + '> Headline at the top (light wall)</label>' +
          '<label class="mk-focus">Crop focus <input type="range" name="focus" min="0" max="100" value="' + Math.round((Number(layout.focus) || 0.5) * 100) + '"></label>' +
        '</div>') +
      (d.image_prompt ? '<details class="mk-brief"><summary>Photo brief</summary><div>' + esc(d.image_prompt) + '</div></details>' : '') +
      (d.image_path ? '<div class="soc-when">Saved creative: <a href="/api/ceo/ads/image?id=' + esc(d.id) + '&kind=creative&v=' + imgV + '" download="' + esc((d.angle || 'creative') + '.jpg') + '">download 1080×1350</a></div>' : '<div class="soc-when">No creative saved yet.</div>') +
    '</div>';

    // ── right: copy + actions
    html += '<div class="mk-draft-body">' +
      '<div class="mk-draft-top">' + statusPill(d) + (d.angle ? pill(d.angle, 'muted') : '') +
        (d.improvements && d.improvements.length ? '<span class="soc-when">applies ' + esc(d.improvements.join(', ')) + '</span>' : '') +
        '<span class="soc-when mk-draft-when">' + esc(when(d.updated_at || d.created_at)) + '</span></div>' +
      (d.rationale ? '<div class="mk-rationale">' + esc(d.rationale) + '</div>' : '') +
      '<div class="mk-fields">' +
        field('Image headline', 'image_headline', d.image_headline, { readonly: locked, max: 45 }) +
        field('Image sub-line', 'image_sub', d.image_sub, { readonly: locked, max: 90 }) +
        field('Headline (Ads Manager)', 'headline', d.headline, { readonly: locked, max: 40 }) +
        field('Primary text', 'primary_text', d.primary_text, { readonly: locked, textarea: true, rows: 9 }) +
        field('Description', 'description', d.description, { readonly: locked, max: 30 }) +
        '<div class="mk-field-row">' +
          '<label class="mk-field"><span>Ad name (slug)</span><input type="text" name="angle" value="' + esc(d.angle || '') + '"' + (locked ? ' readonly' : '') + '></label>' +
          '<label class="mk-field"><span>Button</span><select name="cta"' + (locked ? ' disabled' : '') + '>' + ctas.map(function (o) {
            return '<option value="' + esc(o.value) + '"' + (o.value === d.cta ? ' selected' : '') + '>' + esc(o.label) + '</option>';
          }).join('') + '</select></label>' +
        '</div>' +
      '</div>' +
      (problems.length ? '<ul class="mk-problems">' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
      (warnings.length ? '<ul class="mk-warnings">' + warnings.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="mk-unsaved" data-role="unsaved" hidden>Unsaved changes</div>';

    if (!locked) {
      html += '<div class="mk-iterate">' +
        '<input type="text" name="instruction" class="mk-input" placeholder="Ask the model to change it, e.g. “make paragraph one about eConsults, keep the rest”" maxlength="600">' +
        '<button type="button" class="soc-btn" data-act="iterate"' + (state.busy['it-' + d.id] ? ' disabled' : '') + '>' + (state.busy['it-' + d.id] ? 'Rewriting…' : 'Ask the model') + '</button>' +
      '</div>';
    }

    // launch state
    if (d.status === 'scheduled' || d.status === 'launching') {
      html += '<div class="soc-note"><strong>Scheduled</strong> for ' + esc(when(d.launch_at)) + ' into ' + esc(adsetName(adsets, d.adset_id)) +
        (d.launch_error ? '<br>Last attempt: ' + esc(d.launch_error) + ' (' + (d.launch_attempts || 0) + ' of 3 tries)' : '') +
        (data.launch_disabled ? '<br>Launching is switched off (ADS_LAUNCH_DISABLED), so it will wait.' : '') + '</div>';
    } else if (d.status === 'failed') {
      html += '<div class="soc-warn"><strong>Could not create the ad on Meta.</strong> ' + esc(d.launch_error || '') +
        '<div class="mk-kit"><button type="button" class="soc-btn" data-act="kit">Show manual kit (add it in Ads Manager)</button><textarea data-role="kit" rows="10" readonly hidden></textarea></div></div>';
    } else if (d.status === 'live') {
      html += '<div class="soc-note mk-live-note"><strong>Live on Meta</strong> since ' + esc(when(d.launched_at)) + ' · ad id ' + esc(d.meta_ad_id || '') +
        ' · <a href="https://adsmanager.facebook.com/adsmanager/manage/ads?act=' + esc(data.defaults.account_id) + '&selected_ad_ids=' + esc(d.meta_ad_id || '') + '" target="_blank" rel="noopener">open in Ads Manager ↗</a>' +
        '<br>Creatives cannot be edited once live. Use <em>Duplicate</em> to make a changed version.</div>';
    }

    // actions
    html += '<div class="mk-draft-actions">';
    if (!locked) {
      html += '<button type="button" class="soc-btn ok" data-act="save">Save</button>';
      if (d.status === 'draft') html += '<button type="button" class="soc-btn" data-act="ready" title="Mark the copy and creative as good to go">Mark ready</button>';
      if (d.status === 'ready' || d.status === 'draft' || d.status === 'failed') {
        html += '<span class="mk-schedule">' +
          '<select name="adset_id" class="soc-select">' + adsets.map(function (x) {
            return '<option value="' + esc(x.id) + '"' + (String(x.id) === String(d.adset_id || data.defaults.adset_id) ? ' selected' : '') + '>' + esc(x.name) + (x.effective_status === 'ACTIVE' ? ' (live)' : x.effective_status ? ' (' + esc(x.effective_status.toLowerCase().replace(/_/g, ' ')) + ')' : '') + '</option>';
          }).join('') + '</select>' +
          '<input type="datetime-local" name="launch_at" class="soc-select" value="' + esc(defaultLaunchLocal(d)) + '">' +
          '<button type="button" class="soc-btn now" data-act="schedule">Schedule</button>' +
          '<button type="button" class="soc-btn now" data-act="launch-now">Launch now</button>' +
        '</span>';
      }
      if (d.status === 'scheduled') html += '<button type="button" class="soc-btn" data-act="unschedule">Unschedule</button>';
      if (d.status !== 'archived') html += '<button type="button" class="soc-btn no" data-act="archive">Archive</button>';
      else html += '<button type="button" class="soc-btn" data-act="unarchive">Restore</button>';
    } else {
      html += '<button type="button" class="soc-btn" data-act="duplicate">Duplicate into a new draft</button>';
    }
    html += '</div>';

    if (hist.length) {
      html += '<details class="mk-history"><summary>History (' + hist.length + ')</summary><ul>' + hist.slice().reverse().map(function (h) {
        return '<li><span class="soc-when">' + esc(when(h.at)) + (h.by ? ' · ' + esc(h.by) : '') + '</span>' +
          (h.instruction ? '<div><strong>Asked:</strong> ' + esc(h.instruction) + '</div>' : '') +
          (h.change_note ? '<div><strong>Changed:</strong> ' + esc(h.change_note) + '</div>' : '') +
          (h.note ? '<div>' + esc(h.note) + '</div>' : '') +
          (h.before && h.before.headline ? '<div class="soc-when">Was: “' + esc(h.before.headline) + '”</div>' : '') + '</li>';
      }).join('') + '</ul></details>';
    }
    html += '</div></article>';
    return html;
  }

  function adsetName(adsets, id) {
    var hit = adsets.find(function (x) { return String(x.id) === String(id); });
    return hit ? hit.name : ('ad set ' + id);
  }

  // Tomorrow 17:00 local for the owner = UK morning when they are in Bali
  // (UTC+8) — but local time is whatever the browser says, so default to
  // tomorrow 08:00 local and let the owner change it.
  function defaultLaunchLocal(d) {
    var t = d.launch_at ? new Date(d.launch_at) : null;
    if (!t || isNaN(t.getTime())) { t = new Date(); t.setDate(t.getDate() + 1); t.setHours(8, 0, 0, 0); }
    var p = function (n) { return String(n).padStart(2, '0'); };
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + 'T' + p(t.getHours()) + ':' + p(t.getMinutes());
  }

  function paintCard(d, flash) {
    // Keep the board's copy of the draft in step so a later repaint is right.
    var list = drafts();
    var i = list.findIndex(function (x) { return String(x.id) === String(d.id); });
    if (i === -1) list.unshift(d); else list[i] = d;
    var el = cardEl(d.id);
    if (!el || !inFilter(d)) { state.flashId = flash ? d.id : null; paint(); state.flashId = null; return; }
    var tmp = document.createElement('div');
    tmp.innerHTML = cardHtml(d);
    var next = tmp.firstChild;
    el.parentNode.replaceChild(next, el);
    initCard(d);
  }

  // ── canvas composer ──────────────────────────────────────────────────────
  function ensureFonts() {
    if (state.fontsReady) return Promise.resolve();
    if (!(document.fonts && document.fonts.load)) { state.fontsReady = true; return Promise.resolve(); }
    return Promise.all([
      document.fonts.load('800 92px Figtree'), document.fonts.load('600 34px Figtree'), document.fonts.load('700 24px Figtree')
    ]).then(function () { state.fontsReady = true; }, function () { state.fontsReady = true; });
  }

  function initCard(d) {
    var el = cardEl(d.id);
    if (!el) return;
    var st = card(d.id);
    st.dirty = false;
    // Photo source priority: a photo chosen this session, else the stored one.
    if (!st.photoImg && d.photo_path) {
      loadImage('/api/ceo/ads/image?id=' + encodeURIComponent(d.id) + '&kind=photo&v=' + String(d.updated_at || '').replace(/[^0-9]/g, '').slice(0, 14)).then(function (img) {
        st.photoImg = img; st.photoKind = 'stored'; draw(d.id);
      }, function () { draw(d.id); });
    } else if (!st.photoImg && d.layout && d.layout.photo_url) {
      loadImage('/api/ceo/ads/photo-proxy?url=' + encodeURIComponent(d.layout.photo_url)).then(function (img) {
        st.photoImg = img; st.photoKind = 'library'; draw(d.id);
      }, function () { draw(d.id); });
    }
    ensureFonts().then(function () { draw(d.id); });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not load the photo.')); };
      img.src = src;
    });
  }

  function readForm(el) {
    var out = {};
    ['image_headline', 'image_sub', 'headline', 'primary_text', 'description', 'angle', 'cta'].forEach(function (n) {
      var f = el.querySelector('[name="' + n + '"]');
      if (f) out[n] = f.value;
    });
    var place = el.querySelector('input[type="radio"][name^="placement-"]:checked');
    var focus = el.querySelector('input[name="focus"]');
    out.layout = { placement: place ? place.value : 'bottom', focus: focus ? (Number(focus.value) || 50) / 100 : 0.5 };
    return out;
  }

  function wrapText(ctx, text, maxW) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [], cur = '';
    words.forEach(function (w) {
      var t = (cur + ' ' + w).trim();
      if (ctx.measureText(t).width <= maxW || !cur) cur = t;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function fitText(ctx, text, weight, start, maxW, maxLines, minSize) {
    var size = start;
    for (;;) {
      ctx.font = weight + ' ' + size + 'px ' + FONT;
      var lines = wrapText(ctx, text, maxW);
      if (lines.length <= maxLines || size <= (minSize || 44)) return { size: size, lines: lines };
      size -= 2;
    }
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); ctx.fill();
  }

  function coverDraw(ctx, img, focus) {
    var sr = img.naturalWidth / img.naturalHeight, dr = W / H;
    var sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if (sr > dr) { sw = Math.round(img.naturalHeight * dr); sx = Math.round((img.naturalWidth - sw) * focus); }
    else { sh = Math.round(img.naturalWidth / dr); sy = Math.round((img.naturalHeight - sh) * focus); }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  }

  function draw(id) {
    var el = cardEl(id);
    if (!el) return;
    var cv = el.querySelector('canvas');
    var hint = el.querySelector('[data-role="canvas-hint"]');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var st = card(id);
    var form = readForm(el);
    var headline = form.image_headline || '';
    var sub = form.image_sub || '';
    var placement = form.layout.placement;
    var col = W - 2 * M;

    ctx.clearRect(0, 0, W, H);
    if (st.photoImg) {
      coverDraw(ctx, st.photoImg, form.layout.focus);
      if (hint) hint.textContent = '';
    } else {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#1a3f8a'); g.addColorStop(1, '#0a2a5e');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (hint) hint.textContent = 'Add a photo: upload one, or pick one from the ad account.';
    }

    if (placement === 'top') {
      var maxw = Math.round(col * 0.62);
      var hf = fitText(ctx, headline, '800', 92, maxw, 3, 44);
      var y = 84;
      ctx.fillStyle = BLUE; roundRect(ctx, M, y - 34, 84, 7, 4);
      ctx.fillStyle = INK; ctx.textBaseline = 'top';
      ctx.font = '800 ' + hf.size + 'px ' + FONT;
      hf.lines.forEach(function (ln) { ctx.fillText(ln, M, y); y += Math.round(hf.size * 1.04); });
      y += 22;
      ctx.font = '600 33px ' + FONT; ctx.fillStyle = BLUE;
      wrapText(ctx, sub, maxw).forEach(function (ln) { ctx.fillText(ln, M, y); y += Math.round(33 * 1.3); });
    } else {
      var sc = Math.round(H * 0.60);
      var grad = ctx.createLinearGradient(0, H - sc, 0, H);
      grad.addColorStop(0, 'rgba(' + SCRIM + ',0)'); grad.addColorStop(1, 'rgba(' + SCRIM + ',0.94)');
      ctx.fillStyle = grad; ctx.fillRect(0, H - sc, W, sc);
      var hf2 = fitText(ctx, headline, '800', 92, col, 3, 44);
      ctx.font = '600 34px ' + FONT;
      var subLines = wrapText(ctx, sub, col - 20);
      var bh = hf2.lines.length * Math.round(hf2.size * 1.04) + 24 + subLines.length * Math.round(34 * 1.3);
      var y2 = H - 118 - bh;
      ctx.fillStyle = CYAN; roundRect(ctx, M, y2 - 34, 84, 7, 4);
      ctx.textBaseline = 'top';
      ctx.font = '800 ' + hf2.size + 'px ' + FONT;
      hf2.lines.forEach(function (ln) {
        ctx.fillStyle = 'rgba(0,0,0,0.43)'; ctx.fillText(ln, M + 2, y2 + 3);
        ctx.fillStyle = WHITE; ctx.fillText(ln, M, y2);
        y2 += Math.round(hf2.size * 1.04);
      });
      y2 += 24;
      ctx.font = '600 34px ' + FONT; ctx.fillStyle = ON_DARK;
      subLines.forEach(function (ln) { ctx.fillText(ln, M, y2); y2 += Math.round(34 * 1.3); });
    }
  }

  function scheduleDraw(id) {
    var st = card(id);
    if (st.drawTimer) clearTimeout(st.drawTimer);
    st.drawTimer = setTimeout(function () { draw(id); }, 120);
  }

  // The composed creative as a JPEG data URL, and the photo as one too when it
  // was chosen this session (so the server can keep it for a later re-compose).
  function exportImages(id) {
    var el = cardEl(id);
    var st = card(id);
    var out = {};
    if (!el || !st.photoImg) return out;
    var cv = el.querySelector('canvas');
    draw(id);
    try {
      out.image_data_url = cv.toDataURL('image/jpeg', 0.92);
      out.image_width = W; out.image_height = H;
    } catch (e) { out.error = 'The browser blocked the export (' + e.message + ').'; return out; }
    if (st.photoKind === 'upload' || st.photoKind === 'library') {
      try {
        var pc = document.createElement('canvas');
        var scale = Math.min(1, 2000 / Math.max(st.photoImg.naturalWidth, st.photoImg.naturalHeight));
        pc.width = Math.round(st.photoImg.naturalWidth * scale); pc.height = Math.round(st.photoImg.naturalHeight * scale);
        pc.getContext('2d').drawImage(st.photoImg, 0, 0, pc.width, pc.height);
        out.photo_data_url = pc.toDataURL('image/jpeg', 0.92);
      } catch (e2) { /* the composed creative is what matters */ }
    }
    return out;
  }

  // ── events ───────────────────────────────────────────────────────────────
  function onInput(e) {
    var el = e.target.closest ? e.target.closest('.mk-draft') : null;
    if (!el) return;
    var id = el.getAttribute('data-id');
    var name = e.target.getAttribute('name') || '';
    if (name === 'image_headline' || name === 'image_sub' || name === 'focus') scheduleDraw(id);
    var counter = el.querySelector('[data-count-for="' + name + '"]');
    if (counter) counter.textContent = String(e.target.value || '').length + '/' + counter.textContent.split('/')[1];
    if (name !== 'instruction' && name !== 'launch_at' && name !== 'adset_id') markDirty(id, true);
  }
  function onChange(e) {
    var el = e.target.closest ? e.target.closest('.mk-draft') : null;
    if (!el) return;
    var id = el.getAttribute('data-id');
    if (e.target.getAttribute('data-role') === 'photo-file') return pickFile(id, e.target.files && e.target.files[0]);
    if (e.target.type === 'radio') { scheduleDraw(id); markDirty(id, true); }
    if (e.target.getAttribute('name') === 'cta') markDirty(id, true);
  }
  function markDirty(id, on) {
    card(id).dirty = !!on;
    var el = cardEl(id);
    var tag = el && el.querySelector('[data-role="unsaved"]');
    if (tag) tag.hidden = !on;
  }

  function onClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'filter') { state.filter = btn.getAttribute('data-filter'); paint(); return; }
    if (act === 'new-blank') return newBlank();
    var el = btn.closest('.mk-draft');
    if (!el) return;
    var id = el.getAttribute('data-id');
    if (state.busy[id]) return;
    if (act === 'save') return save(id, {});
    if (act === 'ready') return save(id, { status: 'ready' });
    if (act === 'archive') return save(id, { status: 'archived' }, 'Archived');
    if (act === 'unarchive') return save(id, { status: 'draft' }, 'Restored');
    if (act === 'iterate') return iterate(id);
    if (act === 'schedule') return schedule(id);
    if (act === 'unschedule') return post('/api/ceo/ads/draft/unschedule', { id: id }, id, 'Unscheduled');
    if (act === 'launch-now') return launchNow(id);
    if (act === 'photo-lib') return photoLib(id);
    if (act === 'photo-pick') return pickLibrary(id, btn.getAttribute('data-url'), btn.getAttribute('data-hash'), btn.getAttribute('data-name'));
    if (act === 'copy-brief') return copyBrief(id);
    if (act === 'gen-photo') return generatePhoto(id);
    if (act === 'kit') return showKit(id);
    if (act === 'duplicate') return duplicate(id);
  }

  function setBusy(id, on, label) {
    state.busy[id] = !!on;
    var el = cardEl(id);
    if (!el) return;
    var btns = el.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !!on;
    if (label) A.toast(label);
  }

  function post(path, body, id, okMsg) {
    setBusy(id, true);
    return A.api(path, { method: 'POST', body: body }).then(function (d) {
      setBusy(id, false);
      if (!d || !d.ok) {
        A.toast((d && d.message) || 'That did not work.', 'error');
        if (d && d.draft) paintCard(d.draft);
        return d;
      }
      if (d.draft) paintCard(d.draft);
      if (okMsg) A.toast(okMsg);
      return d;
    });
  }

  function save(id, extra, okMsg) {
    var el = cardEl(id);
    if (!el) return;
    var body = Object.assign({ id: id }, readForm(el), extra || {});
    var st = card(id);
    if (st.photoImg && extra && extra.status === 'archived') { /* no need to re-export */ }
    else if (st.photoImg) Object.assign(body, exportImages(id));
    if (body.error) { A.toast(body.error, 'error'); return; }
    return post('/api/ceo/ads/draft', body, id, okMsg || (body.image_data_url ? 'Saved, creative composed.' : 'Saved.')).then(function (d) {
      if (d && d.ok) { markDirty(id, false); if (body.photo_data_url) { st.photoKind = 'stored'; } }
    });
  }

  function iterate(id) {
    var el = cardEl(id);
    var input = el && el.querySelector('[name="instruction"]');
    var instr = input ? String(input.value || '').trim() : '';
    if (!instr) { A.toast('Say what to change first.', 'error'); return; }
    if (card(id).dirty && !window.confirm('You have unsaved edits on this ad. The model works from the SAVED copy; continue anyway?')) return;
    state.busy['it-' + id] = true;
    setBusy(id, true, 'Asking the model… about 30 seconds.');
    A.api('/api/ceo/ads/draft/iterate', { method: 'POST', body: { id: id, instruction: instr } }).then(function (d) {
      state.busy['it-' + id] = false;
      setBusy(id, false);
      if (!d || !d.ok) { A.toast((d && d.message) || 'The model could not rewrite it.', 'error'); return; }
      card(id).dirty = false;
      paintCard(d.draft);
      A.toast(d.change_note ? 'Changed: ' + d.change_note : 'Rewritten. Re-save to compose the new creative.');
    });
  }

  function schedule(id) {
    var el = cardEl(id);
    if (!el) return;
    if (card(id).dirty) { A.toast('Save first, then schedule.', 'error'); return; }
    var at = el.querySelector('[name="launch_at"]');
    var adset = el.querySelector('[name="adset_id"]');
    var t = at && at.value ? new Date(at.value) : null;
    if (!t || isNaN(t.getTime())) { A.toast('Pick a launch time.', 'error'); return; }
    return post('/api/ceo/ads/draft/schedule', { id: id, launch_at: t.toISOString(), adset_id: adset ? adset.value : undefined }, id,
      'Scheduled for ' + when(t.toISOString()) + '. The launcher checks every 15 minutes.');
  }

  function launchNow(id) {
    if (card(id).dirty) { A.toast('Save first, then launch.', 'error'); return; }
    var el = cardEl(id);
    var adset = el && el.querySelector('[name="adset_id"]');
    if (!window.confirm('Create this ad on Meta now, ACTIVE, in the chosen ad set? It starts spending as soon as Meta approves it.')) return;
    var pre = adset && adset.value ? A.api('/api/ceo/ads/draft', { method: 'POST', body: { id: id, adset_id: adset.value } }) : Promise.resolve({ ok: true });
    setBusy(id, true, 'Creating the ad on Meta…');
    return pre.then(function () {
      return A.api('/api/ceo/ads/draft/launch-now', { method: 'POST', body: { id: id } });
    }).then(function (d) {
      setBusy(id, false);
      if (!d) { A.toast('No answer from the server.', 'error'); return; }
      if (d.draft) paintCard(d.draft);
      if (d.ok) { A.toast('Live on Meta (ad ' + (d.meta_ad_id || '') + '). It shows in "Creatives running now" after the next refresh.'); return; }
      A.toast(d.held ? d.message : 'Meta refused it: ' + (d.message || 'unknown error'), 'error');
      if (!d.held && d.manual_kit) {
        var el2 = cardEl(id);
        var kit = el2 && el2.querySelector('[data-role="kit"]');
        if (kit) { kit.value = d.manual_kit; kit.hidden = false; }
      }
    });
  }

  function showKit(id) {
    var el = cardEl(id);
    var kit = el && el.querySelector('[data-role="kit"]');
    if (!kit) return;
    if (!kit.value) {
      var d = byId(id) || {};
      var data = state.data || {};
      kit.value = ['Ad set: ' + adsetName((data.snapshot && data.snapshot.adsets) || [], d.adset_id || data.defaults.adset_id), 'Ad name: ' + (d.angle || ''), '',
        'Primary text:', d.primary_text || '', '', 'Headline: ' + (d.headline || ''), 'Description: ' + (d.description || ''),
        'Call to action: Book now', 'Destination: instant form ' + data.defaults.lead_form_id, 'URL parameters: utm_source=facebook&utm_medium=paid&utm_campaign={{ad.name}}', '',
        'Image: use the "download 1080×1350" link on this card.'].join('\n');
    }
    kit.hidden = !kit.hidden;
    if (!kit.hidden) { kit.focus(); kit.select(); }
  }

  // Higgsfield writes the photo straight into the draft's storage; the card is
  // repainted from the server's copy so the composer loads it like any stored photo.
  function generatePhoto(id) {
    var el = cardEl(id);
    var briefBox = el && el.querySelector('.mk-brief div');
    var d = byId(id) || {};
    if (!d.image_prompt && !(briefBox && briefBox.textContent)) { A.toast('This draft has no photo brief. Ask the model for one first.', 'error'); return; }
    if (!window.confirm('Generate a photograph from this ad\'s brief with Higgsfield? It uses your Higgsfield credits and takes about a minute.')) return;
    state.busy['gp-' + id] = true;
    setBusy(id, true, 'Generating the photo… about a minute.');
    A.api('/api/ceo/ads/draft/generate-photo', { method: 'POST', body: { id: id } }).then(function (r) {
      state.busy['gp-' + id] = false;
      setBusy(id, false);
      if (!r || !r.ok) { A.toast((r && r.message) || 'Could not generate the photo.', 'error'); return; }
      var st = card(id);
      st.photoImg = null; st.photoKind = null; st.photoMeta = null;
      paintCard(r.draft);
      A.toast('Photo generated. Adjust the crop if needed, then Save to compose the creative.');
    });
  }

  function copyBrief(id) {
    var d = byId(id);
    if (!d || !d.image_prompt) return;
    var text = d.image_prompt + '\n\nFormat: 1080x1350 (4:5). No text, no logos, no faces to camera. Documentary photograph.';
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { A.toast('Photo brief copied.'); }, function () { A.toast(text); });
    else A.toast(text);
  }

  function newBlank() {
    A.api('/api/ceo/ads/drafts/create', { method: 'POST', body: { angle: 'new-ad', description: 'UK-trained GPs. Free 30-minute call.' } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not create a draft.', 'error'); return; }
      state.filter = 'working';
      paintCard(d.draft, true);
      A.toast('Blank draft added at the top.');
    });
  }

  function duplicate(id) {
    var d = byId(id);
    if (!d) return;
    A.api('/api/ceo/ads/drafts/create', { method: 'POST', body: {
      angle: (d.angle || 'ad') + '-v2', headline: d.headline, primary_text: d.primary_text, description: d.description,
      image_headline: d.image_headline, image_sub: d.image_sub, image_prompt: d.image_prompt
    } }).then(function (r) {
      if (!r || !r.ok) { A.toast((r && r.message) || 'Could not duplicate.', 'error'); return; }
      state.filter = 'working';
      paintCard(r.draft, true);
      A.toast('Copied into a new draft. Add a photo and compose the creative.');
    });
  }

  // ── photos ───────────────────────────────────────────────────────────────
  function pickFile(id, file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { A.toast('That is not an image file.', 'error'); return; }
    if (file.size > 12 * 1024 * 1024) { A.toast('That photo is over 12 MB; export a smaller JPEG first.', 'error'); return; }
    var url = URL.createObjectURL(file);
    loadImage(url).then(function (img) {
      var st = card(id);
      st.photoImg = img; st.photoKind = 'upload';
      draw(id); markDirty(id, true);
      A.toast('Photo loaded. Adjust the crop, then Save to compose the creative.');
    }, function () { A.toast('Could not read that image.', 'error'); });
  }

  function photoLib(id) {
    var el = cardEl(id);
    var box = el && el.querySelector('[data-role="photo-lib"]');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="soc-when">Loading the ad account\'s photos…</div>';
    var ready = state.photos ? Promise.resolve(state.photos) : A.api('/api/ceo/ads/photos').then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.message) || 'Could not list the photos.');
      state.photos = d.photos || [];
      return state.photos;
    });
    ready.then(function (photos) {
      if (!photos.length) { box.innerHTML = '<div class="soc-when">No photos in the ad account.</div>'; return; }
      box.innerHTML = '<div class="mk-photo-grid">' + photos.slice(0, 60).map(function (p) {
        return '<button type="button" class="mk-photo-thumb" data-act="photo-pick" data-url="' + esc(p.url) + '" data-hash="' + esc(p.hash) + '" data-name="' + esc(p.name || '') + '" title="' + esc(p.name || '') + ' ' + esc(p.width + '×' + p.height) + '">' +
          '<img src="/api/ceo/ads/photo-proxy?url=' + encodeURIComponent(p.url) + '" loading="lazy" alt=""></button>';
      }).join('') + '</div>';
    }, function (err) { box.innerHTML = '<div class="soc-err">' + esc(err.message) + '</div>'; });
  }

  function pickLibrary(id, url, hash, name) {
    var el = cardEl(id);
    var box = el && el.querySelector('[data-role="photo-lib"]');
    loadImage('/api/ceo/ads/photo-proxy?url=' + encodeURIComponent(url)).then(function (img) {
      var st = card(id);
      st.photoImg = img; st.photoKind = 'library'; st.photoMeta = { url: url, hash: hash, name: name };
      if (box) box.hidden = true;
      draw(id); markDirty(id, true);
      A.toast('Photo picked. Save to compose the creative.');
    }, function () { A.toast('Could not load that photo.', 'error'); });
  }

  // Library picks also record where the photo came from, on save.
  var _readForm = readForm;
  readForm = function (el) {
    var out = _readForm(el);
    var st = state.cards[el.getAttribute('data-id')] || {};
    if (st.photoMeta) { out.layout.photo_url = st.photoMeta.url; out.layout.photo_hash = st.photoMeta.hash; out.layout.photo_name = st.photoMeta.name; }
    return out;
  };

  window.AdsDrafts = { render: render, paint: paint };
})();
