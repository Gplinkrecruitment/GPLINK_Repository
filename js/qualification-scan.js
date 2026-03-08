(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var SCRIPT_VERSION = '20260309a';
  var MODAL_ID = 'gp-qual-scan-modal';
  var STYLE_ID = 'gp-qual-scan-style';
  var FAB_ID = 'gp-qual-scan-fab';

  var DOC_LABELS = {
    primary_medical_degree: 'Primary medical degree',
    mrcgp_certified: 'MRCGP certificate',
    cct_certified: 'CCT certificate',
    cv_signed_dated: 'Signed CV',
    certificate_good_standing: 'Certificate of good standing',
    confirmation_training: 'Confirmation of training',
    criminal_history: 'Criminal history check'
  };

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.gp-qual-scan-fab{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);width:56px;height:56px;border-radius:999px;border:1px solid rgba(191,220,255,.95);background:rgba(255,255,255,.66);box-shadow:inset 0 1px 0 rgba(255,255,255,.88),0 14px 28px -20px rgba(37,99,235,.62);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);display:grid;place-items:center;z-index:96;cursor:pointer;color:#1d4ed8;}',
      '.gp-qual-scan-fab svg{width:24px;height:24px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
      '.gp-qual-scan-fab:hover{transform:translateX(-50%) scale(1.03);}',
      '.gp-qual-scan-backdrop{position:fixed;inset:0;background:rgba(240,244,250,.34);backdrop-filter:blur(0) saturate(1.02);-webkit-backdrop-filter:blur(0) saturate(1.02);display:flex;align-items:center;justify-content:center;padding:14px;z-index:1300;opacity:0;pointer-events:none;transition:opacity .22s ease,backdrop-filter .22s ease,-webkit-backdrop-filter .22s ease;}',
      '.gp-qual-scan-backdrop.show{opacity:1;pointer-events:auto;backdrop-filter:blur(16px) saturate(1.04);-webkit-backdrop-filter:blur(16px) saturate(1.04);}',
      '.gp-qual-scan-modal{width:min(560px,100%);border-radius:18px;border:1px solid rgba(191,220,255,.95);background:rgba(255,255,255,.74);box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 22px 42px -24px rgba(2,6,23,.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:14px;display:grid;gap:10px;transform:translateY(20px) scale(.93);opacity:0;transition:transform .3s cubic-bezier(.22,.9,.18,1.02),opacity .3s ease;}',
      '.gp-qual-scan-backdrop.show .gp-qual-scan-modal{transform:translateY(0) scale(1);opacity:1;}',
      '.gp-qual-scan-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.gp-qual-scan-title{margin:0;font-size:16px;font-weight:850;color:#0f172a;}',
      '.gp-qual-scan-close{border:1px solid rgba(191,220,255,.95);background:rgba(255,255,255,.82);color:#334155;border-radius:999px;width:30px;height:30px;cursor:pointer;font-size:16px;font-weight:800;}',
      '.gp-qual-scan-copy{margin:0;font-size:12px;font-weight:620;color:#475569;line-height:1.4;}',
      '.gp-qual-scan-field{display:grid;gap:6px;}',
      '.gp-qual-scan-label{font-size:12px;font-weight:780;color:#1e3a8a;}',
      '.gp-qual-scan-input,.gp-qual-scan-text{width:100%;border:1px solid #cbd5e1;border-radius:12px;padding:10px;font:inherit;font-size:13px;color:#0f172a;background:rgba(255,255,255,.92);}',
      '.gp-qual-scan-text{min-height:86px;resize:vertical;}',
      '.gp-qual-scan-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;}',
      '.gp-qual-scan-btn{border:1px solid rgba(191,220,255,.95);border-radius:999px;background:rgba(255,255,255,.82);color:#1e3a8a;font-size:12px;font-weight:800;padding:9px 14px;cursor:pointer;}',
      '.gp-qual-scan-btn.primary{background:linear-gradient(180deg,#3b82f6 0%,#1d4ed8 100%);color:#fff;border-color:#60a5fa;}',
      '.gp-qual-scan-btn:disabled{opacity:.6;cursor:wait;}',
      '.gp-qual-scan-result{border:1px solid #dbeafe;border-radius:12px;background:rgba(239,246,255,.72);padding:10px;display:none;gap:4px;}',
      '.gp-qual-scan-result.show{display:grid;}',
      '.gp-qual-scan-result strong{font-size:12px;color:#1e3a8a;}',
      '.gp-qual-scan-result span{font-size:12px;color:#334155;}',
      '@media (min-width:768px){.gp-qual-scan-fab{bottom:18px;left:auto;right:20px;transform:none;}.gp-qual-scan-fab:hover{transform:scale(1.03);}}'
    ].join('');
    document.head.appendChild(style);
  }

  function getDocumentsState() {
    try {
      var raw = localStorage.getItem('gp_documents_prep');
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && parsed.docs && typeof parsed.docs === 'object') return parsed;
    } catch (err) {}
    return { country: 'uk', docs: {} };
  }

  function saveDocumentsState(state) {
    try {
      localStorage.setItem('gp_documents_prep', JSON.stringify(state));
    } catch (err) {}
    if (window.gpLinkStateSync && typeof window.gpLinkStateSync.push === 'function') {
      window.gpLinkStateSync.push();
    }
    try {
      window.dispatchEvent(new Event('storage'));
    } catch (err) {}
  }

  function readTextSnippet(file) {
    return new Promise(function (resolve) {
      if (!file) return resolve('');
      var type = String(file.type || '').toLowerCase();
      var name = String(file.name || '').toLowerCase();
      var textLike = type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.md') || name.endsWith('.json');
      if (!textLike) return resolve('');
      var reader = new FileReader();
      reader.onload = function () {
        var text = typeof reader.result === 'string' ? reader.result : '';
        resolve(text.slice(0, 8000));
      };
      reader.onerror = function () { resolve(''); };
      reader.readAsText(file);
    });
  }

  function ensureModal() {
    var existing = document.getElementById(MODAL_ID);
    if (existing) return existing;

    var backdrop = document.createElement('div');
    backdrop.id = MODAL_ID;
    backdrop.className = 'gp-qual-scan-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = [
      '<div class="gp-qual-scan-modal" role="dialog" aria-modal="true" aria-labelledby="gpQualScanTitle">',
      '  <div class="gp-qual-scan-head">',
      '    <h4 class="gp-qual-scan-title" id="gpQualScanTitle">Scan Qualification</h4>',
      '    <button class="gp-qual-scan-close" type="button" data-scan-close aria-label="Close">&times;</button>',
      '  </div>',
      '  <p class="gp-qual-scan-copy">Upload a qualification document. AI will detect the qualification type and file it into the right GP Link document folder.</p>',
      '  <label class="gp-qual-scan-field">',
      '    <span class="gp-qual-scan-label">Document file</span>',
      '    <input class="gp-qual-scan-input" id="gpQualScanFile" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx" />',
      '  </label>',
      '  <label class="gp-qual-scan-field">',
      '    <span class="gp-qual-scan-label">Visible text (optional, improves AI accuracy)</span>',
      '    <textarea class="gp-qual-scan-text" id="gpQualScanText" placeholder="Paste text from the certificate if available"></textarea>',
      '  </label>',
      '  <div class="gp-qual-scan-result" id="gpQualScanResult"></div>',
      '  <div class="gp-qual-scan-actions">',
      '    <button class="gp-qual-scan-btn" type="button" data-scan-close>Cancel</button>',
      '    <button class="gp-qual-scan-btn primary" type="button" id="gpQualScanSubmit">Scan & File</button>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function openModal() {
    var modal = ensureModal();
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('show');
  }

  function closeModal() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function handleSubmit() {
    var fileEl = document.getElementById('gpQualScanFile');
    var textEl = document.getElementById('gpQualScanText');
    var resultEl = document.getElementById('gpQualScanResult');
    var submitEl = document.getElementById('gpQualScanSubmit');
    if (!fileEl || !submitEl || !resultEl) return;

    var file = fileEl.files && fileEl.files[0];
    if (!file) {
      resultEl.className = 'gp-qual-scan-result show';
      resultEl.innerHTML = '<strong>File required</strong><span>Please choose a document to scan.</span>';
      return;
    }

    submitEl.disabled = true;
    submitEl.textContent = 'Scanning...';

    try {
      var extracted = await readTextSnippet(file);
      var payload = {
        fileName: file.name || 'document',
        mimeType: file.type || '',
        sizeBytes: Number(file.size || 0),
        textSnippet: ((textEl && textEl.value) ? textEl.value : '') + '\n' + extracted
      };

      var response = await fetch('/api/ai/scan-qualification', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data || !data.ok || !data.classification || !data.classification.key) {
        throw new Error(data && data.message ? data.message : 'Scan failed. Please try again.');
      }

      var docsState = getDocumentsState();
      if (!docsState.docs || typeof docsState.docs !== 'object') docsState.docs = {};
      docsState.docs[data.classification.key] = {
        uploaded: true,
        fileName: file.name,
        status: 'under_review',
        source: 'ai_scan',
        updatedAt: new Date().toISOString(),
        confidence: typeof data.classification.confidence === 'number' ? data.classification.confidence : null
      };
      saveDocumentsState(docsState);

      var label = DOC_LABELS[data.classification.key] || data.classification.label || data.classification.key;
      var conf = typeof data.classification.confidence === 'number' ? Math.round(data.classification.confidence * 100) : null;
      resultEl.className = 'gp-qual-scan-result show';
      resultEl.innerHTML = '<strong>Filed successfully</strong><span>Mapped to: ' + label + (conf !== null ? ' (' + conf + '% confidence)' : '') + '</span>';

      window.setTimeout(function () {
        closeModal();
      }, 900);
    } catch (err) {
      resultEl.className = 'gp-qual-scan-result show';
      resultEl.innerHTML = '<strong>Scan failed</strong><span>' + (err && err.message ? err.message : 'Please try again.') + '</span>';
    } finally {
      submitEl.disabled = false;
      submitEl.textContent = 'Scan & File';
    }
  }

  function buildFab() {
    var existing = document.getElementById(FAB_ID);
    if (existing) return existing;
    var btn = document.createElement('button');
    btn.id = FAB_ID;
    btn.type = 'button';
    btn.className = 'gp-qual-scan-fab';
    btn.setAttribute('aria-label', 'Scan qualification');
    btn.setAttribute('title', 'Scan qualification');
    btn.setAttribute('data-alert-trigger', 'scan');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5a1 1 0 0 1 1-1h2"></path><path d="M20 7V5a1 1 0 0 0-1-1h-2"></path><path d="M4 17v2a1 1 0 0 0 1 1h2"></path><path d="M20 17v2a1 1 0 0 1-1 1h-2"></path><path d="M8 12h8"></path><path d="M12 8v8"></path></svg>';
    document.body.appendChild(btn);
    return btn;
  }

  function install() {
    ensureStyles();
    var fab = buildFab();
    fab.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openModal();
    });

    document.addEventListener('click', function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-scan-close]')) {
        event.preventDefault();
        closeModal();
        return;
      }
      if (target.id === 'gpQualScanSubmit') {
        event.preventDefault();
        handleSubmit();
        return;
      }
      var modal = document.getElementById(MODAL_ID);
      if (!modal || !modal.classList.contains('show')) return;
      if (target === modal) closeModal();
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeModal();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
