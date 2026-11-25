/* My Documents for a doctor who already holds Ahpra registration and works in
 * Australia (Australian GP build, WP-07).
 *
 *   GPMyDocumentsAu.mount(rootElement)
 *
 * Everything shown comes from the server:
 *   GET  /api/gp/au-documents           the list, and the state of each item
 *   PUT  /api/gp/au-documents           upload or replace one document
 *   POST /api/gp/au-documents/expiry    set the date a document runs to
 *   GET  /api/gp/au-documents/download  open your own file
 * There is no list of documents in this file. If the server cannot be reached
 * the page says so and offers to try again; it never falls back to another
 * list.
 *
 * Reused, untouched: window.DocCrop (js/doc-crop.js) trims a photographed
 * document before upload. It never blocks an upload: if it cannot run, the
 * original file goes through, and a cancelled crop means "no file was picked".
 * The name check happens on the server when the document is reviewed.
 *
 * Every word a doctor can read in this file is checked by
 * tests/au-wp07-documents-copy.test.js, comments and identifiers included.
 * Bump the ?v= on the page (and sw.js) whenever this file changes.
 */
(function (root) {
  'use strict';

  var API = '/api/gp/au-documents';
  var MAX_UPLOAD_CHARS = 7600000;      // just under the server's limit on the encoded file
  var IMAGE_SHRINK_OVER = 2400000;     // photos larger than this are scaled down first
  var IMAGE_MAX_SIDE = 2400;

  var STATUS = {
    pending: { label: 'Not uploaded', tone: 'idle' },
    uploaded: { label: 'Received', tone: 'wait' },
    under_review: { label: 'Being checked', tone: 'wait' },
    approved: { label: 'Approved', tone: 'good' },
    rejected: { label: 'Needs another look', tone: 'bad' },
    // Not a stored status: an approved document whose date has passed.
    expired: { label: 'Expired', tone: 'bad' }
  };
  var WE_STATUS = {
    pending: { label: 'Not ready yet', tone: 'idle' },
    uploaded: { label: 'In progress', tone: 'wait' },
    under_review: { label: 'In progress', tone: 'wait' },
    approved: { label: 'Ready', tone: 'good' },
    rejected: { label: 'In progress', tone: 'wait' }
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // FB-2b (R14): a date-only value (an expiry date) is a calendar date. It is
  // read and printed in UTC so it is the same date wherever the device is:
  // `new Date('2027-09-30')` is midnight UTC, which a device west of UTC
  // printed as 29 Sep. A full timestamp ("Added ...") is the viewer's own day.
  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateOnlyUtc(value) {
    var m = DATE_ONLY.exec(String(value == null ? '' : value));
    if (!m) return NaN;
    var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(ms).getUTCDate() === Number(m[3]) ? ms : NaN;
  }
  function formatDate(iso) {
    if (!iso) return '';
    var only = dateOnlyUtc(iso);
    if (!isNaN(only)) {
      var u = new Date(only);
      return u.getUTCDate() + ' ' + MONTHS_SHORT[u.getUTCMonth()] + ' ' + u.getUTCFullYear();
    }
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getFullYear();
  }
  // The expiry as { end, today } in whole UTC days, comparing calendar dates:
  // the expiry date against today's date on this device.
  function expiryDays(item, nowMs) {
    var only = dateOnlyUtc(String(item.expiresAt || '').slice(0, 10));
    var end = !isNaN(only) && DATE_ONLY.test(String(item.expiresAt)) ? only : NaN;
    var now = new Date(nowMs);
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    if (isNaN(end)) {
      // A full timestamp: the instant itself (as before).
      var at = new Date(item.expiresAt).getTime();
      if (isNaN(at)) return null;
      return { expired: at < nowMs, days: Math.ceil((at - nowMs) / 86400000) };
    }
    return { expired: end < today, days: Math.round((end - today) / 86400000) };
  }

  // "Expires in 20 days", "Expired on 3 Mar 2026", "Valid until 30 Sep 2027".
  function expiryLine(item, nowMs) {
    if (!item.expiryTracked || !item.expiresAt) return null;
    var when = expiryDays(item, nowMs);
    if (!when) return null;
    var days = when.days;
    var label = item.expiryLabel || 'Valid until';
    if (when.expired) return { tone: 'bad', text: 'Expired on ' + formatDate(item.expiresAt) + '. Please upload the current one.' };
    if (days <= 30) return { tone: 'warn', text: label + ' ' + formatDate(item.expiresAt) + ' (' + (days === 0 ? 'today' : 'in ' + days + (days === 1 ? ' day' : ' days')) + ')' };
    return { tone: 'idle', text: label + ' ' + formatDate(item.expiresAt) };
  }

  function isExpired(item, nowMs) {
    if (!item.expiryTracked || !item.expiresAt) return false;
    var when = expiryDays(item, nowMs);
    return !!when && when.expired;
  }

  // The label on the card. An approved document whose date has passed says
  // "Expired", not "Approved": the doctor has something to do.
  function statusOf(item, nowMs) {
    if (item.provider === 'we') return WE_STATUS[item.status] || WE_STATUS.pending;
    if (item.status === 'approved' && isExpired(item, nowMs)) return STATUS.expired;
    return STATUS[item.status] || STATUS.pending;
  }

  // An item the page can draw: an object with a key and a label. Anything else
  // (a string, a half-filled object) is never drawn as a card and never
  // replaces the list the page already has.
  function isItem(item) {
    return !!item && typeof item === 'object' && typeof item.key === 'string' && item.key !== ''
      && typeof item.label === 'string' && item.label !== '';
  }
  function itemsOf(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) if (isItem(list[i])) out.push(list[i]);
    return out;
  }
  function allItems(list) {
    return Array.isArray(list) && itemsOf(list).length === list.length;
  }

  // "2 of 8 uploaded": for the doctor's own items, anything on file counts,
  // checked yet or not (the pill on each card says which). For the team's
  // items, the ones that are ready.
  function countOnFile(items) {
    var n = 0;
    for (var i = 0; i < items.length; i++) if (items[i].status && items[i].status !== 'pending') n++;
    return n;
  }
  function countReady(items) {
    var n = 0;
    for (var i = 0; i < items.length; i++) if (items[i].status === 'approved') n++;
    return n;
  }

  function helpHtml(item) {
    var help = item.help || {};
    var steps = Array.isArray(help.steps) ? help.steps : [];
    if (!steps.length) return '';
    var list = '';
    for (var i = 0; i < steps.length; i++) list += '<li>' + esc(steps[i]) + '</li>';
    return '<details class="aud-help"><summary>What this is and where to find it</summary>'
      + '<ol>' + list + '</ol>'
      + (help.reminder ? '<p class="aud-help-note">' + esc(help.reminder) + '</p>' : '')
      + '</details>';
  }

  // FR-7 (M7-01): the name a downloaded file is saved under. The name the
  // doctor uploaded it with when we have it; otherwise the document's own
  // label (the helper adds the right ending for the kind of file).
  function downloadName(item) {
    var name = String((item && (item.fileName || item.label)) || 'document');
    return name.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'document';
  }

  function cardHtml(item, nowMs) {
    var st = statusOf(item, nowMs);
    var exp = expiryLine(item, nowMs);
    var has = item.status !== 'pending';
    var html = '<article class="aud-card" data-aud-key="' + esc(item.key) + '" data-aud-status="' + esc(item.status) + '">';
    html += '<div class="aud-card-head"><div class="aud-card-title">';
    html += '<h3>' + esc(item.label) + '</h3>';
    html += item.provider === 'you'
      ? '<span class="aud-tag ' + (item.required ? 'is-required' : '') + '">'
        + (item.required ? (item.phase === 'apply' ? 'Needed to apply' : 'Needed before you start') : 'Optional') + '</span>'
      : '';
    html += '</div><span class="aud-pill tone-' + st.tone + '">' + esc(st.label) + '</span></div>';
    if (item.short) html += '<p class="aud-short">' + esc(item.short) + '</p>';
    if (has && item.fileName) {
      html += '<p class="aud-file"><span class="aud-file-name">' + esc(item.fileName) + '</span>'
        + (item.updatedAt ? '<span class="aud-file-date">Added ' + esc(formatDate(item.updatedAt)) + '</span>' : '') + '</p>';
    }
    if (item.status === 'rejected' && item.note) html += '<p class="aud-note tone-bad">' + esc(item.note) + '</p>';
    if (exp) html += '<p class="aud-note tone-' + exp.tone + '">' + esc(exp.text) + '</p>';
    html += helpHtml(item);

    var actions = '';
    if (item.canUpload) {
      actions += '<button type="button" class="aud-btn aud-btn-primary" data-aud-upload="' + esc(item.key) + '">'
        + (has ? 'Replace' : 'Upload') + '</button>';
    }
    if (item.manageUrl) {
      actions += '<a class="aud-btn aud-btn-primary" href="' + esc(item.manageUrl) + '" data-aud-route="' + esc(item.manageUrl) + '">'
        + (has ? 'Update on Careers' : 'Add on Careers') + '</a>';
    }
    if (has && item.downloadUrl) {
      // FR-7 (M7-01). "View" opens the file in a new tab, as it always did.
      // It is a button, not a link: the shared download helper
      // (js/gp-download.js) turns every LINK to a download address into a
      // background save, which made "View" silently save a file called
      // document.pdf. "Download" is the link the helper handles, and it
      // carries the name to save under.
      actions += '<button type="button" class="aud-btn aud-btn-quiet" data-aud-view="' + esc(item.downloadUrl) + '">View</button>';
      actions += '<a class="aud-btn aud-btn-quiet" href="' + esc(item.downloadUrl) + '" download="' + esc(downloadName(item)) + '" data-download-name="' + esc(downloadName(item)) + '">Download</a>';
    }
    if (item.canUpload && has && item.expiryTracked) {
      actions += '<label class="aud-date"><span>' + esc(item.expiryLabel || 'Valid until') + '</span>'
        + '<input type="date" data-aud-expiry="' + esc(item.key) + '" value="' + esc(item.expiresAt ? String(item.expiresAt).slice(0, 10) : '') + '" /></label>';
    }
    if (actions) html += '<div class="aud-actions">' + actions + '</div>';
    html += '<p class="aud-msg" data-aud-msg="' + esc(item.key) + '" role="status" hidden></p>';
    html += '</article>';
    return html;
  }

  function panelHtml(items, emptyText, nowMs) {
    if (!items.length) return '<p class="aud-empty">' + esc(emptyText) + '</p>';
    var html = '';
    for (var i = 0; i < items.length; i++) html += cardHtml(items[i], nowMs);
    return html;
  }

  function viewHtml(data, activeTab, nowMs) {
    var you = itemsOf(data.youProvide);
    var we = itemsOf(data.weProvide);
    var html = '<nav class="aud-tabs" role="tablist" aria-label="Document sections">'
      + '<button type="button" role="tab" class="aud-tab' + (activeTab === 'you' ? ' is-active' : '') + '" data-aud-tab="you" aria-selected="' + (activeTab === 'you') + '">You provide'
      + '<span class="aud-count">' + countOnFile(you) + ' of ' + you.length + ' uploaded</span></button>'
      + '<button type="button" role="tab" class="aud-tab' + (activeTab === 'we' ? ' is-active' : '') + '" data-aud-tab="we" aria-selected="' + (activeTab === 'we') + '">We prepare'
      + '<span class="aud-count">' + countReady(we) + ' of ' + we.length + ' ready</span></button>'
      + '</nav>';
    html += '<section class="aud-panel' + (activeTab === 'you' ? ' is-active' : '') + '" data-aud-panel="you" role="tabpanel">'
      // FB-2b (W3-D17): the sentence is the server's, for this doctor's
      // state (held | looking | placed | started). The fallback is only for a
      // response that carries none.
      + '<p class="aud-lead" data-aud-lead="' + esc(data.state || 'looking') + '">' + esc(data.lead || 'Upload these when you have them. Only your CV is needed to apply for roles; the rest we ask for once you have accepted a position.') + '</p>'
      + panelHtml(you, 'There is nothing for you to upload right now.', nowMs) + '</section>';
    html += '<section class="aud-panel' + (activeTab === 'we' ? ' is-active' : '') + '" data-aud-panel="we" role="tabpanel">'
      + '<p class="aud-lead">Our team looks after these. They appear here when they are ready.</p>'
      + panelHtml(we, 'Nothing here yet.', nowMs) + '</section>';
    return html;
  }

  function messageHtml(title, body, withRetry) {
    return '<div class="aud-state"><h3>' + esc(title) + '</h3><p>' + esc(body) + '</p>'
      + (withRetry ? '<button type="button" class="aud-btn aud-btn-primary" data-aud-retry>Try again</button>' : '') + '</div>';
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('read')); };
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.readAsDataURL(file);
    });
  }

  // A large phone photo is scaled down so it fits the upload limit. Anything
  // that cannot be scaled (a PDF, or a browser with no canvas) goes as it is.
  function shrinkImage(file, dataUrl) {
    return new Promise(function (resolve) {
      if (!/^image\//i.test(file.type || '') || dataUrl.length <= IMAGE_SHRINK_OVER || typeof document === 'undefined') {
        resolve({ dataUrl: dataUrl, mimeType: file.type || 'application/octet-stream' });
        return;
      }
      var img = new Image();
      img.onerror = function () { resolve({ dataUrl: dataUrl, mimeType: file.type }); };
      img.onload = function () {
        try {
          var scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          var out = canvas.toDataURL('image/jpeg', 0.86);
          if (out && out.length < dataUrl.length) resolve({ dataUrl: out, mimeType: 'image/jpeg' });
          else resolve({ dataUrl: dataUrl, mimeType: file.type });
        } catch (e) {
          resolve({ dataUrl: dataUrl, mimeType: file.type });
        }
      };
      img.src = dataUrl;
    });
  }

  // The crop step. Resolves the file to upload (cropped or the original), or
  // null when the doctor cancelled. Never rejects, never blocks.
  function prepareFile(file, label) {
    var crop = root.DocCrop;
    if (!crop || typeof crop.prepare !== 'function' || !/^image\//i.test(file.type || '')) return Promise.resolve(file);
    try {
      return Promise.resolve(crop.prepare(file, { label: label, origin: 'upload' }))
        .then(function (out) { return out === null ? null : (out || file); })
        .catch(function () { return file; });
    } catch (e) {
      return Promise.resolve(file);
    }
  }

  function mount(el, options) {
    var opts = options || {};
    var fetcher = opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
    var state = { data: null, tab: 'you', busy: {} };

    function now() { return typeof opts.now === 'function' ? opts.now() : Date.now(); }

    function render() {
      if (!state.data) return;
      // WP-12: the pre-start page draws a chosen few of these cards (the same
      // cards, the same upload) with no tabs: mount(el, { keys: [...] }).
      if (Array.isArray(opts.keys)) {
        var chosen = itemsOf(state.data.youProvide).filter(function (item) { return opts.keys.indexOf(item.key) !== -1; });
        el.innerHTML = chosen.length
          ? chosen.map(function (item) { return cardHtml(item, now()); }).join('')
          : (typeof opts.emptyHtml === 'string' ? opts.emptyHtml : '');
        return;
      }
      el.innerHTML = viewHtml(state.data, state.tab, now());
    }
    // WP-12: tell the page that mounted us that something on file changed.
    function changed() {
      if (typeof opts.onChange === 'function') { try { opts.onChange(state.data); } catch (e) { /* the upload itself is done */ } }
    }

    function say(key, text, tone) {
      var node = el.querySelector('[data-aud-msg="' + key + '"]');
      if (!node) return;
      node.textContent = text || '';
      node.className = 'aud-msg' + (tone ? ' tone-' + tone : '');
      node.hidden = !text;
    }

    function load() {
      el.innerHTML = '<div class="aud-state" aria-busy="true"><p>Loading your documents…</p></div>';
      if (!fetcher) { el.innerHTML = messageHtml('We could not load your documents', 'Please refresh the page.', true); return Promise.resolve(false); }
      return fetcher(API, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (res && res.status === 404) return { notHere: true };
          if (!res || !res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (data && data.notHere) {
            if (typeof opts.onNotAvailable === 'function') opts.onNotAvailable();
            else el.innerHTML = messageHtml('Nothing to show here', 'Your documents are on a different page. Please go back and open My Documents again.', false);
            return false;
          }
          if (!data || data.ok !== true || !allItems(data.youProvide) || !Array.isArray(data.weProvide)) {
            el.innerHTML = messageHtml('We could not load your documents', 'Check your connection and try again. Nothing has been lost.', true);
            return false;
          }
          state.data = data;
          render();
          focusFromLink();
          return true;
        })
        .catch(function () {
          el.innerHTML = messageHtml('We could not load your documents', 'Check your connection and try again. Nothing has been lost.', true);
          return false;
        });
    }

    // A link from an email or the bell (?reupload=key) opens on that card.
    function focusFromLink() {
      var key = '';
      try { key = new URLSearchParams(root.location.search).get('reupload') || ''; } catch (e) { key = ''; }
      if (!key) return;
      var card = el.querySelector('[data-aud-key="' + key.replace(/[^a-z0-9_]/gi, '') + '"]');
      if (!card) return;
      card.classList.add('is-focus');
      try { card.scrollIntoView({ block: 'center' }); } catch (e) { /* older browsers */ }
    }

    // Take the lists from an upload reply only when every entry is a real
    // item. Returns false when it is not, and the caller then asks the server
    // for the list again instead of drawing something half-formed.
    function applyResponse(data) {
      if (!data || !allItems(data.youProvide) || data.youProvide.length === 0) return false;
      state.data.youProvide = data.youProvide;
      if (allItems(data.weProvide)) state.data.weProvide = data.weProvide;
      return true;
    }

    function upload(key, file) {
      var item = null;
      var list = (state.data && state.data.youProvide) || [];
      for (var i = 0; i < list.length; i++) if (list[i].key === key) item = list[i];
      if (!item || state.busy[key]) return Promise.resolve(false);
      state.busy[key] = true;
      say(key, 'Preparing your file…', 'wait');
      return prepareFile(file, item.label).then(function (ready) {
        if (!ready) { state.busy[key] = false; say(key, '', ''); return false; }
        return readAsDataUrl(ready).then(function (dataUrl) { return shrinkImage(ready, dataUrl); }).then(function (enc) {
          if (enc.dataUrl.length > MAX_UPLOAD_CHARS) {
            state.busy[key] = false;
            say(key, 'That file is too large. Please upload a file under 5 MB.', 'bad');
            return false;
          }
          say(key, 'Uploading…', 'wait');
          return fetcher(API, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              key: key,
              fileName: ready.name || file.name || 'document',
              mimeType: enc.mimeType || ready.type || 'application/octet-stream',
              fileSize: ready.size || 0,
              fileDataUrl: enc.dataUrl
            })
          }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) {
              state.busy[key] = false;
              if (!res.ok || !data || data.ok !== true) {
                say(key, (data && data.message) || 'We could not save that file. Please try again.', 'bad');
                return false;
              }
              // WP-12: a staff preview of the doctor's app stores nothing.
              if (data.impersonated === true) { say(key, 'Preview only: nothing was uploaded.', ''); return false; }
              var thanks = 'Thanks, we have it. We will check it and let you know.';
              if (applyResponse(data)) {
                render();
                say(key, thanks, 'good');
                changed();
                return true;
              }
              // The file is saved; only the reply was unusable. Read the list afresh.
              return load().then(function (ok) { if (ok) say(key, thanks, 'good'); changed(); return true; });
            });
          });
        });
      }).catch(function () {
        state.busy[key] = false;
        say(key, 'We could not read that file. Please try again.', 'bad');
        return false;
      });
    }

    function saveExpiry(key, value) {
      if (!value) return Promise.resolve(false);
      return fetcher(API + '/expiry', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ key: key, expiresAt: value })
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data || data.ok !== true) {
            say(key, (data && data.message) || 'We could not save that date. Please try again.', 'bad');
            return false;
          }
          if (data.impersonated === true) { say(key, 'Preview only: nothing was saved.', ''); return false; }
          var list = state.data.youProvide || [];
          for (var i = 0; i < list.length; i++) if (list[i].key === key) list[i].expiresAt = data.expiresAt;
          render();
          say(key, 'Date saved.', 'good');
          return true;
        });
      }).catch(function () {
        say(key, 'We could not save that date. Please try again.', 'bad');
        return false;
      });
    }

    function pickFile(key) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = (state.data && state.data.accept) || 'image/*,.pdf';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (input.parentNode) input.parentNode.removeChild(input);
        if (file) upload(key, file);
      });
      document.body.appendChild(input);
      input.click();
    }

    el.addEventListener('click', function (event) {
      var target = event.target;
      var tab = target.closest ? target.closest('[data-aud-tab]') : null;
      if (tab) { state.tab = tab.getAttribute('data-aud-tab') === 'we' ? 'we' : 'you'; render(); return; }
      var up = target.closest ? target.closest('[data-aud-upload]') : null;
      if (up) { pickFile(up.getAttribute('data-aud-upload')); return; }
      var retry = target.closest ? target.closest('[data-aud-retry]') : null;
      if (retry) { load(); return; }
      // FR-7 (M7-01): View = a new tab (a top-level page, so the frame rules
      // that block a download inside the app shell do not apply).
      var viewBtn = target.closest ? target.closest('[data-aud-view]') : null;
      if (viewBtn) {
        // `view=1`: the server then hands the file over to be shown, not saved.
        var viewUrl = viewBtn.getAttribute('data-aud-view');
        viewUrl += (viewUrl.indexOf('?') === -1 ? '?' : '&') + 'view=1';
        var opened = null;
        try { opened = root.open(viewUrl, '_blank', 'noopener'); } catch (e) { opened = null; }
        // (With "noopener" a browser answers null even when the tab opened, so
        // null is not treated as a failure.)
        return;
      }
      var route = target.closest ? target.closest('[data-aud-route]') : null;
      if (route && root.parent && root.parent !== root) {
        // Inside the app shell a link to another page is handed to the shell.
        event.preventDefault();
        try {
          root.parent.postMessage({ type: 'gp-shell-route', href: route.getAttribute('data-aud-route'), title: 'Careers' }, root.location.origin);
        } catch (e) { root.location.href = route.getAttribute('data-aud-route'); }
      }
    });
    el.addEventListener('change', function (event) {
      var field = event.target;
      if (field && field.getAttribute && field.getAttribute('data-aud-expiry')) {
        saveExpiry(field.getAttribute('data-aud-expiry'), field.value);
      }
    });

    return { load: load, upload: upload, saveExpiry: saveExpiry, state: state };
  }

  var api = {
    mount: mount,
    // Exposed for tests: pure rendering and wording.
    _viewHtml: viewHtml,
    _cardHtml: cardHtml,
    _expiryLine: expiryLine,
    _formatDate: formatDate,
    _isItem: isItem,
    _STATUS: STATUS,
    _WE_STATUS: WE_STATUS
  };

  root.GPMyDocumentsAu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
