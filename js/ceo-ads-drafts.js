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
  function photoJob(d) { return d && d.layout && d.layout.photo_job ? d.layout.photo_job : null; }
  function photoPending(d) { var j = photoJob(d); return !!(j && (j.status === 'queued' || j.status === 'in_progress') && d.status !== 'archived'); }

  // While any draft is waiting on Higgsfield, ask the server every few seconds
  // whether the photo has landed; when it has, repaint the card, which loads
  // the stored photo and composes the creative by itself.
  var pollTimer = null;
  function ensurePolling() {
    if (pollTimer) return;
    if (!drafts().some(photoPending)) return;
    pollTimer = setInterval(pollPhotos, 7000);
  }
  function pollPhotos() {
    var ids = drafts().filter(photoPending).map(function (d) { return d.id; });
    if (!ids.length) { clearInterval(pollTimer); pollTimer = null; return; }
    A.api('/api/ceo/ads/photos/poll', { method: 'POST', body: { ids: ids } }).then(function (r) {
      if (!r || !r.ok) return;
      (r.updated || []).forEach(function (d) {
        var st = card(d.id);
        st.photoImg = null; st.photoKind = null; st.photoMeta = null; st.autoComposed = false;
        var j = photoJob(d);
        // A photo that lands on a draft that already had a creative replaces
        // it: re-compose and judge (maybeAutoCompose only covers first photos).
        if (j && j.status === 'done' && d.image_path && d.status !== 'live' && d.status !== 'launching') st.recomposeAfterLoad = true;
        paintCard(d);
        if (j && j.status === 'done') { A.toast('Photo ready for “' + (d.image_headline || d.angle || 'the ad') + '”. Composing the creative…'); setStatus(d.id, 'New photograph in. Composing the creative and judging it…', 'busy'); }
        if (j && j.status === 'failed') setStatus(d.id, 'The photograph failed: ' + (j.error || 'unknown error'), 'error', 'gen-photo');
        else if (j && j.status === 'failed') A.toast('Photo failed for “' + (d.angle || 'the ad') + '”: ' + (j.error || ''), 'error');
      });
      if (!drafts().some(photoPending)) { clearInterval(pollTimer); pollTimer = null; }
    });
  }

  // A draft with a photo but no creative composes and saves itself once, so a
  // generated ad is launch-ready without a click. Only for untouched drafts:
  // an edit in progress (dirty) is never overwritten.
  // Also re-composes a stored creative, once, when the photo carries a band
  // of padding wider than the old 4% trim could remove (the white strip
  // across the top of "Chasing QOF points", 2026-11-06); layout.composer = 2
  // on the saved draft marks that done.
  function maybeAutoCompose(d) {
    var st = card(d.id);
    if (st.autoComposed || st.dirty) return;
    if (!d.photo_path || (d.status !== 'draft' && d.status !== 'ready')) return;
    if (!st.photoImg) return;
    var redo = !!d.image_path;
    if (redo) {
      var composer = Number((d.layout || {}).composer) || 1;
      if (composer >= 2 || !(trimBox(st.photoImg).band > 0.04)) return;
    }
    st.autoComposed = true;
    var el = cardEl(d.id);
    if (!el) return;
    var body = Object.assign({ id: d.id }, readForm(el), exportImages(d.id));
    if (body.error || !body.image_data_url) return;
    delete body.photo_data_url; // the photo is already stored server-side
    A.api('/api/ceo/ads/draft', { method: 'POST', body: body }).then(function (r) {
      if (r && r.ok && r.draft) { paintCard(r.draft); A.toast((redo ? 'Creative re-composed without the white padding for “' : 'Creative composed for “') + (r.draft.image_headline || r.draft.angle || 'the ad') + '”.'); }
      noteAutoLaunch(r);
      if (r && r.ok && r.draft && r.draft.status !== 'live') critique(d.id);
    });
  }
  // The model's evidence for running the ad (why_strong): numbers and patterns
  // from the account, written with the brief.
  function whyStrongHtml(d) {
    var list = Array.isArray(d.why_strong) ? d.why_strong.filter(Boolean) : [];
    if (!list.length) return '';
    return '<div class="mk-why"><div class="mk-why-title">Why it should run</div><ul>' +
      list.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
  }
  // The model's judgement of the composed creative (layout.creative_review):
  // what it shows, strengths, weaknesses, fixes. Stale once the creative
  // changed (the image path it judged is kept), so the card says so.
  function creativeReviewHtml(d) {
    var cr = d.layout && d.layout.creative_review;
    if (!d.image_path) return '';
    if (!cr) {
      return '<div class="mk-why mk-judge is-empty"><span class="soc-when">The creative has not been judged yet.</span> ' +
        '<button type="button" class="soc-btn" data-act="critique"' + (state.busy['cr-' + d.id] ? ' disabled' : '') + '>' + (state.busy['cr-' + d.id] ? 'Judging…' : 'Judge the creative') + '</button></div>';
    }
    var stale = cr.image_path && d.image_path && cr.image_path !== d.image_path;
    var locked = d.status === 'live' || d.status === 'launching';
    var li = function (x) { return '<li>' + esc(x) + '</li>'; };
    // Weaknesses and fixes are tickable: the ticked ones go to the model in
    // one "Fix the ticked points" pass (owner 2026-11-08: pasting them into
    // "Ask the model" did not properly fix them).
    var ticks = tickKeys(d.id, cr);
    var tickLi = function (prefix) {
      return function (x, n) {
        if (locked) return li(x);
        var key = prefix + n;
        return '<li' + (ticks[key] ? ' class="is-ticked"' : '') + '><label class="mk-tick"><input type="checkbox" data-role="judge-tick" data-key="' + key + '"' + (ticks[key] ? ' checked' : '') + '> <span>' + esc(x) + '</span></label></li>';
      };
    };
    var n = tickedPoints(d).length;
    var tickable = !locked && tickTotal(cr) > 0;
    return '<div class="mk-why mk-judge' + (cr.verdict === 'run' ? ' is-run' : ' is-fix') + '">' +
      '<div class="mk-why-title">The creative, judged ' + pill(cr.verdict === 'run' ? 'Run it' : 'Fix first', cr.verdict === 'run' ? 'green' : 'amber') +
        (stale ? ' ' + pill('creative changed since', 'red') : '') + '</div>' +
      (cr.what_it_shows ? '<div class="mk-judge-shows">' + esc(cr.what_it_shows) + '</div>' : '') +
      ((cr.strengths || []).length ? '<ul class="good">' + cr.strengths.map(li).join('') + '</ul>' : '') +
      ((cr.weaknesses || []).length ? '<ul class="bad">' + cr.weaknesses.map(tickLi('w')).join('') + '</ul>' : '<div class="soc-when">No weaknesses found.</div>') +
      ((cr.fixes || []).length ? '<ul class="fix">' + cr.fixes.map(tickLi('f')).join('') + '</ul>' : '') +
      (tickable ? '<div class="mk-judge-act">' +
          '<button type="button" class="soc-btn now" data-act="fix-ticked"' + (n && !state.busy['it-' + d.id] ? '' : ' disabled') + '>' + fixLabel(d.id, n) + '</button>' +
          '<button type="button" class="soc-btn" data-act="tick-all">' + (n === tickTotal(cr) ? 'Untick all' : 'Tick all') + '</button>' +
          '<span class="soc-when">Tick the points to fix. The model changes only those: a new photo brief and photograph when the picture itself is wrong, the words, or the headline position and crop. The creative is then re-composed and judged again.</span>' +
        '</div>' : '') +
      '<div class="soc-when">Judged ' + esc(when(cr.at)) + (cr.model ? ' · ' + esc(cr.model) : '') + ' · ' +
        '<button type="button" class="soc-btn" data-act="critique"' + (state.busy['cr-' + d.id] ? ' disabled' : '') + '>' + (state.busy['cr-' + d.id] ? 'Judging…' : 'Judge again') + '</button></div>' +
      '</div>';
  }
  // Ticks live on the card state, keyed by the judgement they belong to, so
  // a repaint keeps them and a fresh judgement starts clean. Keys: w0, w1…
  // for weaknesses, f0, f1… for fixes.
  function tickKeys(id, cr) {
    var st = card(id);
    var at = (cr && cr.at) || '';
    if (!st.ticks || st.ticks.at !== at) st.ticks = { at: at, keys: {} };
    return st.ticks.keys;
  }
  function tickTotal(cr) { return ((cr && cr.weaknesses) || []).length + ((cr && cr.fixes) || []).length; }
  function tickedPoints(d) {
    var cr = d && d.layout && d.layout.creative_review;
    if (!cr) return [];
    var keys = tickKeys(d.id, cr);
    var out = [];
    (cr.weaknesses || []).forEach(function (x, n) { if (keys['w' + n]) out.push({ kind: 'weakness', text: x }); });
    (cr.fixes || []).forEach(function (x, n) { if (keys['f' + n]) out.push({ kind: 'fix', text: x }); });
    return out;
  }
  function fixLabel(id, n) { return state.busy['it-' + id] ? 'Fixing…' : 'Fix the ticked points' + (n ? ' (' + n + ')' : ''); }
  function refreshFixButton(id) {
    var d = byId(id);
    var el = cardEl(id);
    var cr = d && d.layout && d.layout.creative_review;
    if (!el || !cr) return;
    var n = tickedPoints(d).length;
    var btn = el.querySelector('[data-act="fix-ticked"]');
    if (btn) { btn.disabled = !n || !!state.busy[id] || !!state.busy['it-' + id]; btn.textContent = fixLabel(id, n); }
    var all = el.querySelector('[data-act="tick-all"]');
    if (all) all.textContent = n && n === tickTotal(cr) ? 'Untick all' : 'Tick all';
    var cbs = el.querySelectorAll('[data-role="judge-tick"]');
    for (var i = 0; i < cbs.length; i++) { var row = cbs[i].closest('li'); if (row) row.classList.toggle('is-ticked', cbs[i].checked); }
  }
  function onTick(id, cb) {
    var d = byId(id);
    var cr = d && d.layout && d.layout.creative_review;
    if (!cr) return;
    tickKeys(id, cr)[cb.getAttribute('data-key')] = !!cb.checked;
    refreshFixButton(id);
  }
  function tickAll(id) {
    var d = byId(id);
    var cr = d && d.layout && d.layout.creative_review;
    if (!cr) return;
    var keys = tickKeys(id, cr);
    var on = tickedPoints(d).length !== tickTotal(cr);
    (cr.weaknesses || []).forEach(function (x, n) { keys['w' + n] = on; });
    (cr.fixes || []).forEach(function (x, n) { keys['f' + n] = on; });
    var el = cardEl(id);
    var cbs = el ? el.querySelectorAll('[data-role="judge-tick"]') : [];
    for (var i = 0; i < cbs.length; i++) cbs[i].checked = on;
    refreshFixButton(id);
  }
  function critique(id) {
    if (state.busy['cr-' + id]) return;
    state.busy['cr-' + id] = true;
    setBusy(id, true, 'Judging the creative… about 20 seconds.');
    return A.api('/api/ceo/ads/draft/critique', { method: 'POST', body: { id: id } }).then(function (d) {
      state.busy['cr-' + id] = false;
      setBusy(id, false);
      if (!d) { A.toast('No answer from the server.', 'error'); setStatus(id, 'The creative could not be judged: no answer from the server.', 'error', 'critique'); return; }
      if (d.draft) paintCard(d.draft);
      if (!d.ok) { A.toast(d.message || 'The creative could not be judged.', 'error'); setStatus(id, 'The creative could not be judged. ' + (d.message || ''), 'error', 'critique'); return d; }
      var run = d.critique && d.critique.verdict === 'run';
      A.toast(run ? 'Creative judged: run it.' : 'Creative judged: fix first. See the weaknesses on the card.', run ? undefined : 'error');
      setStatus(id, run ? 'Creative judged: run it.' : 'Creative judged: fix first. The weaknesses and fixes are on the card; paste the fixes into "Ask the model" to apply them.', 'ok');
      return d;
    });
  }
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
    ensurePolling();
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

    var html = '<article class="mk-draft' + (locked ? ' is-locked' : '') + (state.flashId === d.id ? ' is-new' : '') + (fromReview(d) ? ' is-from-review' : '') + '" data-id="' + esc(d.id) + '">';
    // ── left: creative
    html += '<div class="mk-draft-visual">' +
      '<div class="mk-canvas-wrap"><canvas width="' + W + '" height="' + H + '" aria-label="Creative preview"></canvas>' +
        '<div class="mk-canvas-hint" data-role="canvas-hint"></div></div>' +
      (locked ? '' :
        '<div class="mk-photo-controls">' +
          '<label class="soc-btn mk-file-btn">Upload photo<input type="file" accept="image/*" data-role="photo-file" hidden></label>' +
          '<button type="button" class="soc-btn" data-act="photo-lib">From ad account</button>' +
          (data.higgsfield_configured
            ? '<button type="button" class="soc-btn now" data-act="gen-photo"' + (photoPending(d) ? ' disabled' : '') + ' title="Generate a photograph from the photo brief with Higgsfield (about a minute)">' + (photoPending(d) ? 'Generating photo…' : (d.photo_path ? 'New photo' : 'Generate photo')) + '</button>'
            : '') +
          (d.image_prompt ? '<button type="button" class="soc-btn" data-act="copy-brief" title="Copy the photo brief for Higgsfield / any image tool">Copy photo brief</button>' : '') +
        '</div>' +
        (data.higgsfield_configured ? '' : '<div class="soc-when">Photos are not being generated: add HIGGSFIELD_API_KEY in Vercel and every new ad gets one automatically.</div>') +
        (photoJob(d) && photoJob(d).status === 'failed' ? '<div class="soc-err">Photo generation failed: ' + esc(photoJob(d).error || 'unknown error') + '</div>' : '') +
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
        (d.improvements && d.improvements.length ? '<span class="soc-when">applies ' + esc((Array.isArray(d.improvements) ? d.improvements : []).join(', ')) + '</span>' : '') +
        '<span class="soc-when mk-draft-when">' + esc(when(d.updated_at || d.created_at)) + '</span></div>' +
      originHtml(d) +
      (d.rationale ? '<div class="mk-rationale">' + esc(d.rationale) + '</div>' : '') +
      whyStrongHtml(d) +
      creativeReviewHtml(d) +
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
        formSelect(d, data, locked) +
      '</div>' +
      (problems.length ? '<ul class="mk-problems">' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
      (warnings.length ? '<ul class="mk-warnings">' + warnings.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="mk-unsaved" data-role="unsaved" hidden>Unsaved changes</div>';

    if (!locked) {
      html += '<div class="mk-iterate">' +
        '<input type="text" name="instruction" class="mk-input" placeholder="Ask the model to change it, e.g. “make paragraph one about eConsults, keep the rest”, or paste the judge\'s fixes" maxlength="1500">' +
        '<button type="button" class="soc-btn" data-act="iterate"' + (state.busy['it-' + d.id] ? ' disabled' : '') + '>' + (state.busy['it-' + d.id] ? 'Rewriting…' : 'Ask the model') + '</button>' +
      '</div>';
    }
    // What the card is doing right now, or what just happened to it: stays
    // until the next action, unlike a toast (owner 2026-11-06: "nothing happens").
    var stv = (state.status || {})[d.id];
    html += '<div class="mk-status' + (stv ? ' is-' + esc(stv.kind) : '') + '" data-role="status"' + (stv ? '' : ' hidden') + '>' +
      (stv ? esc(stv.text) + (stv.retry ? ' <button type="button" class="soc-btn" data-act="' + esc(stv.retry) + '">Try again</button>' : '') : '') + '</div>';

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
      if (d.status === 'ready' || d.status === 'draft' || d.status === 'failed' || d.status === 'scheduled') {
        html += '<span class="mk-schedule">' +
          '<select name="adset_id" class="soc-select">' + adsets.map(function (x) {
            return '<option value="' + esc(x.id) + '"' + (String(x.id) === String(d.adset_id || data.defaults.adset_id) ? ' selected' : '') + '>' + esc(x.name) + (x.rotation === 'scheduled_off' ? ' (off by rule, in rotation)' : (x.rotation === 'live' || x.effective_status === 'ACTIVE') ? ' (live)' : x.effective_status ? ' (' + esc(x.effective_status.toLowerCase().replace(/_/g, ' ')) + ')' : '') + '</option>';
          }).join('') + '</select>' +
          '<input type="datetime-local" name="launch_at" class="soc-select" value="' + esc(defaultLaunchLocal(d)) + '">' +
          '<button type="button" class="soc-btn now" data-act="schedule"' + (state.busy[d.id] ? ' disabled' : '') + '>Schedule</button>' +
          '<button type="button" class="soc-btn now" data-act="launch-now"' + (state.busy[d.id] ? ' disabled' : '') + '>' + (state.busy[d.id] ? 'Working…' : 'Launch now') + '</button>' +
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
          (Array.isArray(h.points_done) && h.points_done.length ? '<div><strong>Fixed:</strong><ul class="mk-hist-points">' + h.points_done.map(function (p) { return '<li>' + esc(p.done || p.point) + '</li>'; }).join('') + '</ul></div>' : '') +
          (h.note ? '<div>' + esc(h.note) + '</div>' : '') +
          (h.before && h.before.headline ? '<div class="soc-when">Was: “' + esc(h.before.headline) + '”</div>' : '') + '</li>';
      }).join('') + '</ul></details>';
    }
    html += '</div></article>';
    return html;
  }

  // Which instant form the button opens: the default (the fast slot-picker
  // form) first, then every form the campaign's ads use.
  function formSelect(d, data, locked) {
    var forms = (data.lead_forms || []).slice();
    if (!forms.length) return '';
    var chosen = String((d.layout && d.layout.lead_form_id) || '');
    return '<label class="mk-field"><span>Instant form the button opens</span><select name="lead_form_id"' + (locked ? ' disabled' : '') + '>' +
      forms.map(function (f) {
        var label = (f.name || ('Form ' + f.id)) + (f.is_default ? ' · default' : '') + (f.live_ads ? ' · ' + f.live_ads + ' live ad' + (f.live_ads === 1 ? '' : 's') : '');
        var value = f.is_default ? '' : f.id;
        var sel = f.is_default ? (!chosen || chosen === f.id) : chosen === f.id;
        return '<option value="' + esc(value) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('') + '</select></label>';
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
        ensureFonts().then(function () { draw(d.id); maybeAutoCompose(byId(d.id) || d); if (st.recomposeAfterLoad) recomposeNow(d.id); });
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
    // composer 2 = trims wide padding bands (see trimBox); the server keeps it.
    out.layout = { placement: place ? place.value : 'bottom', focus: focus ? (Number(focus.value) || 50) / 100 : 0.5, composer: 2 };
    var form = el.querySelector('select[name="lead_form_id"]');
    if (form) out.layout.lead_form_id = form.value || '';
    return out;
  }

  // Word wrap that reads well: a "|" (or a newline) in the text forces a
  // break where the owner wants one; otherwise the greedy wrap decides how
  // many lines there are and the words are then re-balanced across that many
  // lines so no line ends in an orphan ("No appraisal. No / revalidation."
  // becomes "No appraisal. / No revalidation."), preferring a break after a
  // full stop, question mark or exclamation mark when that still fits.
  function greedyWrap(ctx, words, maxW) {
    var lines = [], cur = '';
    words.forEach(function (w) {
      var t = (cur + ' ' + w).trim();
      if (ctx.measureText(t).width <= maxW || !cur) cur = t;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function balancedWrap(ctx, words, maxW, n) {
    if (n < 2 || words.length <= n) return greedyWrap(ctx, words, maxW);
    var width = function (a, b) { return ctx.measureText(words.slice(a, b).join(' ')).width; };
    var endsSentence = function (i) { return /[.!?]$/.test(words[i - 1] || ''); };
    var best = null;
    // Every way of placing n-1 breaks; headlines are a handful of words.
    var rec = function (start, left, cuts) {
      if (left === 1) {
        var w = width(start, words.length);
        if (w > maxW) return;
        var all = cuts.concat([words.length]);
        var prev = 0, cost = 0, ok = true;
        all.forEach(function (c, idx) {
          var lw = width(prev, c);
          if (lw > maxW) ok = false;
          cost += idx === all.length - 1 ? 0 : Math.pow(maxW - lw, 2);
          if (idx < all.length - 1 && endsSentence(c)) cost -= Math.pow(maxW, 2) * 0.35;
          prev = c;
        });
        if (ok && (!best || cost < best.cost)) best = { cost: cost, cuts: all };
        return;
      }
      for (var c = start + 1; c <= words.length - (left - 1); c++) {
        if (width(start, c) > maxW) break;
        rec(c, left - 1, cuts.concat([c]));
      }
    };
    rec(0, n, []);
    if (!best) return greedyWrap(ctx, words, maxW);
    var out = [], p = 0;
    best.cuts.forEach(function (c) { out.push(words.slice(p, c).join(' ')); p = c; });
    return out;
  }
  function wrapText(ctx, text, maxW) {
    var segments = String(text || '').split(/\s*(?:\||\n)\s*/).filter(function (x) { return x.trim(); });
    var out = [];
    segments.forEach(function (seg) {
      var words = seg.split(/\s+/).filter(Boolean);
      var greedy = greedyWrap(ctx, words, maxW);
      out = out.concat(greedy.length >= 2 ? balancedWrap(ctx, words, maxW, greedy.length) : greedy);
    });
    return out;
  }
  // Shrink the type until the text fits the line budget. A forced break (|)
  // is a promise: each forced segment must sit on ONE line, so the size keeps
  // dropping until it does. Without forced breaks, a line made of a single
  // short word (an orphan such as "No") also costs a size step, so "No
  // appraisal. No revalidation." lands as two clean lines rather than three.
  function fitText(ctx, text, weight, start, maxW, maxLines, minSize) {
    var segments = String(text || '').split(/\s*(?:\||\n)\s*/).filter(function (x) { return x.trim(); }).length;
    var floor = minSize || 44;
    var size = start;
    for (;;) {
      ctx.font = weight + ' ' + size + 'px ' + FONT;
      var lines = wrapText(ctx, text, maxW);
      var forcedOk = segments < 2 || lines.length === segments;
      var orphan = lines.length > 1 && lines.some(function (ln) { return ln.split(/\s+/).length === 1 && ln.length <= 4; });
      if ((lines.length <= maxLines && forcedOk && !orphan) || size <= floor) return { size: size, lines: lines };
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

  // Generated photographs often arrive with a near-white frame: a thin line
  // (build.py's trim_white handled that for the October batch), or, as on
  // 2026-11-04, a landscape photograph sitting on a 3:4 white canvas with a
  // 19% band top and bottom, which went straight through to the creative as
  // a white strip across the top of "Chasing QOF points". Measure the frame
  // once per photo on a small copy and crop it off before the cover-fit.
  // `band` is the widest edge trimmed, as a fraction (0 when nothing was).
  function trimBox(img) {
    if (img._trim) return img._trim;
    var box = { l: 0, t: 0, r: img.naturalWidth, b: img.naturalHeight, band: 0 };
    try {
      var scale = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(8, Math.round(img.naturalWidth * scale)), h = Math.max(8, Math.round(img.naturalHeight * scale));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
      var px = x.getImageData(0, 0, w, h).data;
      var lum = function (i) { return (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000; };
      var rowStats = function (y) { var sum = 0, n = 0, mn = 255; for (var xx = 0; xx < w; xx += 2) { var v = lum((y * w + xx) * 4); sum += v; n++; if (v < mn) mn = v; } return { mean: sum / n, min: mn }; };
      var colStats = function (xx) { var sum = 0, n = 0, mn = 255; for (var y = 0; y < h; y += 2) { var v = lum((y * w + xx) * 4); sum += v; n++; if (v < mn) mn = v; } return { mean: sum / n, min: mn }; };
      // Mean AND minimum: padding is white in every pixel, a bright sky is not.
      // Up to 45% of an edge, and never leaving less than 30% of the photo.
      var TH = 236, MN = 200, MAX = 0.45;
      var rowWhite = function (y) { var s = rowStats(y); return s.mean > TH && s.min > MN; };
      var colWhite = function (xx) { var s = colStats(xx); return s.mean > TH && s.min > MN; };
      var t = 0; while (t < h * MAX && rowWhite(t)) t++;
      var b = h; while (b > h * (1 - MAX) && rowWhite(b - 1)) b--;
      var l = 0; while (l < w * MAX && colWhite(l)) l++;
      var r = w; while (r > w * (1 - MAX) && colWhite(r - 1)) r--;
      if ((t || l || b < h || r < w) && (r - l) >= w * 0.3 && (b - t) >= h * 0.3) {
        // Plus a two-pixel margin (in source pixels), as build.py did.
        var m = 2 / scale;
        box = { l: Math.round(l / scale + m), t: Math.round(t / scale + m), r: Math.round(r / scale - m), b: Math.round(b / scale - m), band: Math.max(t / h, (h - b) / h, l / w, (w - r) / w) };
      }
    } catch (e) { /* a tainted or unreadable image draws untrimmed */ }
    img._trim = box;
    return box;
  }

  function coverDraw(ctx, img, focus) {
    var tb = trimBox(img);
    var iw = Math.max(1, tb.r - tb.l), ih = Math.max(1, tb.b - tb.t);
    var sr = iw / ih, dr = W / H;
    var sx = tb.l, sy = tb.t, sw = iw, sh = ih;
    if (sr > dr) { sw = Math.round(ih * dr); sx = tb.l + Math.round((iw - sw) * focus); }
    else { sh = Math.round(iw / dr); sy = tb.t + Math.round((ih - sh) * focus); }
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
      var d0 = byId(id);
      if (hint) hint.textContent = photoPending(d0) ? 'Generating the photograph with Higgsfield… about a minute. The creative composes itself when it lands.' : 'Add a photo: upload one, or pick one from the ad account.';
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
    // A tick on the judge's points is not an edit to the ad.
    if (e.target.getAttribute('data-role') === 'judge-tick') return;
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
    if (e.target.getAttribute('data-role') === 'judge-tick') return onTick(id, e.target);
    if (e.target.type === 'radio') { scheduleDraw(id); markDirty(id, true); }
    if (e.target.getAttribute('name') === 'cta' || e.target.getAttribute('name') === 'lead_form_id') markDirty(id, true);
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
    if (act === 'fix-ticked') return fixTicked(id);
    if (act === 'tick-all') return tickAll(id);
    if (act === 'schedule') return schedule(id);
    if (act === 'unschedule') return post('/api/ceo/ads/draft/unschedule', { id: id }, id, 'Unscheduled');
    if (act === 'launch-now') return launchNow(id);
    if (act === 'critique') return critique(id);
    if (act === 'approve') return approve(id, true);
    if (act === 'unapprove') return approve(id, false);
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
    if (label) { A.toast(label); setStatus(id, label, 'busy'); }
    else if (!on && state.status && state.status[id] && state.status[id].kind === 'busy') setStatus(id, null);
  }
  // Persistent card status: { text, kind: busy|ok|error, retry: act }.
  function setStatus(id, text, kind, retry) {
    if (!state.status) state.status = {};
    state.status[id] = text ? { text: text, kind: kind || 'ok', retry: retry || null } : null;
    var el = cardEl(id);
    var box = el && el.querySelector('[data-role="status"]');
    if (!box) return;
    var stv = state.status[id];
    box.hidden = !stv;
    box.className = 'mk-status' + (stv ? ' is-' + stv.kind : '');
    box.innerHTML = stv ? esc(stv.text) + (stv.retry ? ' <button type="button" class="soc-btn" data-act="' + esc(stv.retry) + '">Try again</button>' : '') : '';
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
      noteAutoLaunch(d);
      return d;
    });
  }

  // A draft the review's create_ad change asked for publishes itself once
  // the owner has approved it AND its creative is saved; say what happened
  // and repaint the hub so the change's row shows it.
  function noteAutoLaunch(d) {
    var al = d && d.auto_launch;
    if (!al) return;
    A.toast(al.message || (al.ok ? 'Launched.' : 'Launch failed.'), al.ok ? undefined : 'error');
    if (window.AdsHub && typeof window.AdsHub.reload === 'function') window.AdsHub.reload();
  }

  // Drafts written by "Changes to make on Meta" (layout.auto_launch): the
  // green box that says where they came from and holds the approval gate.
  function fromReview(d) { return !!(d && d.layout && d.layout.auto_launch); }
  function originHtml(d) {
    var al = d && d.layout && d.layout.auto_launch;
    if (!al) return '';
    var approved = !!al.approved_at;
    var live = d.status === 'live' || !!d.meta_ad_id;
    var stage = d.image_path ? 'the creative is ready' : (d.photo_path ? 'the photo is in, the creative composes while this page is open' : (photoPending(d) ? 'the photo is on its way' : 'it still needs a photo'));
    var text;
    if (live) text = 'Approved and published as ad ' + esc(d.meta_ad_id || '') + '.';
    else if (approved) text = 'Approved ' + esc(when(al.approved_at)) + '. It publishes itself as soon as its creative is ready; right now ' + stage + '.';
    else text = 'Waiting for your approval. Edit anything you like and save, then approve: it publishes itself as soon as its creative is ready (right now ' + stage + ').';
    var cr = d.layout && d.layout.creative_review;
    if (!live && cr && cr.image_path === d.image_path) text += cr.verdict === 'run' ? ' The judged creative passed.' : ' The judged creative has ' + ((cr.weaknesses || []).length || 'some') + ' weakness' + ((cr.weaknesses || []).length === 1 ? '' : 'es') + ' noted below; fix them or approve anyway.';
    return '<div class="mk-origin">' + pill('From Changes to make on Meta', 'green') +
      '<span class="mk-origin-text">' + (al.change_title ? '<strong>' + esc(al.change_title) + '</strong> · ' : '') + text + '</span>' +
      (live ? '' : approved
        ? '<button type="button" class="soc-btn" data-act="unapprove">Withdraw approval</button>'
        : '<button type="button" class="btn-primary" data-act="approve"' + (state.busy[d.id] ? ' disabled' : '') + '>Approve · publish automatically</button>') +
      '</div>';
  }
  function approve(id, yes) {
    if (card(id).dirty) { A.toast('Save your edits first, then approve.', 'error'); return; }
    var d = byId(id);
    if (yes && !window.confirm('Approve this ad? It publishes itself on Meta as soon as its creative is ready' + (d && d.image_path ? ' (it is ready now, so it goes live straight away)' : '') + '.')) return;
    return post('/api/ceo/ads/draft/approve', { id: id, approved: !!yes }, id, yes ? 'Approved. It publishes itself when the creative is ready.' : 'Approval withdrawn.');
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
      // A new creative gets judged straight away (image + copy + the data).
      if (d && d.ok && body.image_data_url && d.draft && d.draft.status !== 'live') critique(id);
      return d;
    });
  }

  function iterate(id) {
    var el = cardEl(id);
    var input = el && el.querySelector('[name="instruction"]');
    var instr = input ? String(input.value || '').trim() : '';
    if (!instr) { A.toast('Say what to change first.', 'error'); return; }
    return askModel(id, { id: id, instruction: instr }, 'Asking the model… about 30 seconds. The card updates by itself when it answers.');
  }

  // The judge's ticked points, fixed in one pass. Anything typed in the
  // instruction box goes along as well, so "and keep the headline" is heard.
  function fixTicked(id) {
    var d = byId(id);
    var points = tickedPoints(d);
    if (!points.length) { A.toast('Tick at least one of the judge\'s points first.', 'error'); return; }
    var el = cardEl(id);
    var input = el && el.querySelector('[name="instruction"]');
    var instr = input ? String(input.value || '').trim() : '';
    var body = { id: id, points: points };
    if (instr) body.instruction = instr;
    return askModel(id, body, 'Fixing ' + points.length + ' ticked point' + (points.length === 1 ? '' : 's') + ' with the creative in front of the model… about 40 seconds. The card updates by itself when it answers.');
  }

  // One round trip to the model for both: a rewrite from an instruction, or
  // a fix pass over the ticked points. The card re-composes and is judged
  // again when the answer lands.
  function askModel(id, body, busyLabel) {
    var el = cardEl(id);
    var fixing = !!(body.points && body.points.length);
    if (card(id).dirty && !window.confirm('You have unsaved edits on this ad. The model works from the SAVED copy; continue anyway?')) return;
    state.busy['it-' + id] = true;
    setBusy(id, true, busyLabel);
    var btn = el && el.querySelector('[data-act="iterate"]');
    if (btn) btn.textContent = 'Rewriting…';
    var fixBtn = el && el.querySelector('[data-act="fix-ticked"]');
    if (fixBtn) fixBtn.textContent = 'Fixing…';
    A.api('/api/ceo/ads/draft/iterate', { method: 'POST', body: body }).then(function (d) {
      state.busy['it-' + id] = false;
      setBusy(id, false);
      var b2 = cardEl(id) && cardEl(id).querySelector('[data-act="iterate"]');
      if (b2) b2.textContent = 'Ask the model';
      refreshFixButton(id);
      if (!d || !d.ok) {
        var why = (d && d.message) || (d && d.status ? 'The server answered HTTP ' + d.status + ' (it may have taken too long).' : 'No answer from the server.');
        A.toast(why, 'error');
        setStatus(id, 'The model could not ' + (fixing ? 'fix the ticked points. ' : 'rewrite it. ') + why, 'error', fixing ? 'fix-ticked' : 'iterate');
        return;
      }
      card(id).dirty = false;
      // The ticked points have been dealt with; the next judgement starts clean.
      if (fixing) card(id).ticks = null;
      // The change should be visible without another click: once the stored
      // photo is back in the canvas, the creative is composed, saved and judged.
      // A new photograph on its way takes over: it re-composes when it lands.
      var canRecompose = !d.photo_queued && d.draft && d.draft.photo_path && d.draft.status !== 'live' && d.draft.status !== 'launching';
      card(id).recomposeAfterLoad = !!canRecompose;
      paintCard(d.draft);
      var done = Array.isArray(d.points_done) ? d.points_done : [];
      var note = (done.length
          ? 'Fixed ' + done.length + ' point' + (done.length === 1 ? '' : 's') + ': ' + done.map(function (p, n) { return (n + 1) + ') ' + (p.done || p.point); }).join(' ')
          : (d.change_note ? 'Changed: ' + d.change_note : 'Rewritten.')) +
        (d.layout_changed ? ' Layout changed.' : '') +
        (d.photo_queued ? ' A new photograph is on its way (about a minute); the creative re-composes and is judged when it lands, while this page is open.' : (canRecompose ? ' Re-composing the creative…' : ' Re-save to compose the new creative.')) +
        (d.photo_note ? ' ' + d.photo_note : '');
      A.toast(note);
      setStatus(id, note, d.photo_note ? 'error' : 'ok');
      if (d.photo_queued) ensurePolling();
      if (canRecompose && card(id).photoImg) recomposeNow(id);
    });
  }

  // Compose + save the creative from the current fields and the loaded photo
  // (after "Ask the model" changed the words on the image); save() then
  // asks for the judgement.
  function recomposeNow(id) {
    var st = card(id);
    st.recomposeAfterLoad = false;
    if (!st.photoImg) return;
    setStatus(id, 'Re-composing the creative…', 'busy');
    ensureFonts().then(function () { draw(id); return save(id, {}, 'Creative re-composed with the new words.'); });
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
      // The server holds a lock per draft: a second Launch now while the first
      // is still talking to Meta is refused, not run again (8 Nov 2026).
      if (d.already) { A.toast(d.message || 'A launch of this ad is already in progress.', 'error'); return; }
      if (d.ok) { A.toast('Live on Meta (ad ' + (d.meta_ad_id || '') + '). It shows in "Creatives running" after the next refresh.'); return; }
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
    var d = byId(id) || {};
    if (!d.image_prompt) { A.toast('This draft has no photo brief. Ask the model for one first.', 'error'); return; }
    if (d.photo_path && !window.confirm('Generate a new photograph for this ad with Higgsfield? It replaces the current one and uses your Higgsfield balance.')) return;
    setBusy(id, true, 'Sending the brief to Higgsfield…');
    A.api('/api/ceo/ads/draft/generate-photo', { method: 'POST', body: { id: id } }).then(function (r) {
      setBusy(id, false);
      if (!r || !r.ok) { A.toast((r && r.message) || 'Could not start the photo.', 'error'); if (r && r.draft) paintCard(r.draft); return; }
      var st = card(id); st.autoComposed = false;
      paintCard(r.draft);
      ensurePolling();
      A.toast('Photo generating… about a minute. It will appear on the card by itself.');
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
